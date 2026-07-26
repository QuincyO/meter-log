// ── On-device road routing over a downloaded map pack ────────────────────────
// This module is what makes the PHONE able to measure roads. It does locally
// what a self-hosted OSRM does over HTTP: snap coordinates onto a drivable road
// graph, run shortest paths, and hand back a distance + duration matrix in the
// SAME { D, T } shape osrmMatrix() returns (js/route.js) — metres and minutes,
// Infinity for unreachable — so it drops into optimizeRoute's matrix ladder
// without anything downstream changing.
//
// Pure and DOM-free on purpose (like drive-track.js / route-constraints.js):
// no fetch, no IndexedDB, no globals. js/roadpack.js owns the download and
// storage side; this file only ever sees an ArrayBuffer and coordinates, which
// is what lets tests/roadgraph.test.mjs build a graph by hand.
//
// WHY A CUSTOM FORMAT rather than shipping OSM: an .osm.pbf for one district is
// hundreds of MB and needs a protobuf reader. tools/build-roadpack.mjs distils
// it to the few things routing actually needs — node positions, drivable
// segments with a speed and a oneway bit, and the shape points for drawing —
// which lands a ~150 km district at a few MB.
//
// THE PACK STORES ONLY RAW ARRAYS. The adjacency (CSR) and the snapping grid
// are rebuilt at decode time: both are O(segments) and take a few milliseconds
// even for a couple hundred thousand segments, and leaving them out of the file
// keeps the format small and the writer simple. Don't "optimize" them into the
// pack without measuring — the decode is not the slow part.

// ── pack format ──────────────────────────────────────────────────────────────
// Little-endian throughout. Header is a fixed 64 bytes; every section after it
// starts 4-byte aligned, in the order listed in SECTIONS below. Coordinates are
// Int32 at 1e6 fixed point (≈11 cm), which is far finer than any GPS fix and
// halves the size of a Float64.
export const PACK_MAGIC   = 'MLRP';
// v2 added the address index (street/place dictionaries + house-number points).
// There is no v1 reader: no pack was ever published, so requiring a rebuild is
// simpler and more honest than carrying a compatibility branch forever. Bump
// this in BOTH this file and tools/build-roadpack.mjs — tests/roadgraph.test.mjs
// builds its fixtures through the real writer, so a one-sided change fails there.
export const PACK_VERSION = 2;
export const HEADER_BYTES = 64;
export const COORD_SCALE  = 1e6;

// segFlags bits. Neither set = two-way. These are the ONLY directional
// information in the pack; a graph that ignored them would happily route the
// wrong way up a one-way street and return a symmetric matrix where the real
// one is not.
export const ONEWAY_FWD = 1;   // traversable from → to only
export const ONEWAY_REV = 2;   // traversable to → from only

const R_EARTH = 6371008.8;
const D2R     = Math.PI / 180;

// Snapping. A stop farther than this from any drivable road is treated as
// off-network (the caller prices it crow-flies instead of pretending).
export const SNAP_RADIUS_M = 250;
// Target cell size for the snapping grid. ~1 km keeps the candidate list per
// lookup short without making the grid itself large.
const GRID_CELL_M = 1000;
const GRID_MAX    = 512;
// Dijkstra gives up past this. A day's driving is never 4 hours between two
// stops; without a cap, one unreachable island would scan the whole graph once
// per source.
export const MAX_LEG_SECONDS = 4 * 3600;

// ── address normalization ────────────────────────────────────────────────────
// Both sides of the geocoder go through these: the builder normalizes OSM's
// `addr:street` before storing it, and a lookup normalizes what the installer
// typed. They MUST agree, which is why they live here rather than in the tool.

// Suffixes and directions, expanded to their long form so "Main St" and
// "Main Street" collide.
//
// Expansion is POSITIONAL, and the rule is subtler than "last word wins":
//   - A suffix is expanded anywhere EXCEPT the first word. Anchoring it to the
//     final token looks right until you meet rural Ontario, where "Concession
//     Rd 4" and "County Rd 12" put the suffix in the middle and would never
//     have matched the "concession road 4" the builder stored.
//   - Skipping the first word is what keeps "St Andrews Rd" (Saint) from
//     becoming "street andrews road".
//   - Directions expand at ANY position, including the first, so "N Main St"
//     and "North Main Street" collide.
const SUFFIXES = {
  st:'street', str:'street', rd:'road', ave:'avenue', av:'avenue', dr:'drive',
  blvd:'boulevard', blv:'boulevard', cres:'crescent', cr:'crescent', ln:'lane',
  hwy:'highway', ct:'court', crt:'court', pl:'place', ter:'terrace', terr:'terrace',
  trl:'trail', pkwy:'parkway', pky:'parkway', cir:'circle', sq:'square',
  gdns:'gardens', hts:'heights', pt:'point',
};
const DIRECTIONS = {
  n:'north', s:'south', e:'east', w:'west',
  ne:'northeast', nw:'northwest', se:'southeast', sw:'southwest',
  north:'north', south:'south', east:'east', west:'west',
  northeast:'northeast', northwest:'northwest', southeast:'southeast', southwest:'southwest',
};

// "123 Main St" → { num:'123', street:'Main St' }. Deliberately the same regex
// as splitAddr() in js/worklist-address-fill.js — duplicated rather than
// imported to keep this module free of any dependency; the test asserts the two
// stay in step.
export function splitAddress(address){
  const m = String(address || '').trim().match(/^(\d[\w-]*)\s+(.+)$/);
  return m ? { num: m[1], street: m[2] } : { num: '', street: String(address || '').trim() };
}

export function normalizeStreet(street){
  const words = String(street || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  if(!words.length) return '';
  return words.map((w, i) => {
    if(DIRECTIONS[w]) return DIRECTIONS[w];
    if(i > 0 && SUFFIXES[w]) return SUFFIXES[w];
    return w;
  }).join(' ');
}

// House numbers are matched numerically: "123A" and "123" are the same civic
// address for our purposes, and "123-125" takes the low end.
export function houseNumber(raw){
  const m = String(raw || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

// ── small helpers ────────────────────────────────────────────────────────────

// Equirectangular metres. Exact enough at district scale (sub-metre over tens
// of km) and much cheaper than haversine, which matters because snapping calls
// it once per candidate sub-segment.
function metresBetween(aLat, aLng, bLat, bLng){
  const midLat = (aLat + bLat) / 2 * D2R;
  const x = (bLng - aLng) * D2R * Math.cos(midLat);
  const y = (bLat - aLat) * D2R;
  return Math.sqrt(x * x + y * y) * R_EARTH;
}

function align4(n){ return (n + 3) & ~3; }

// ── binary min-heap over parallel typed arrays ───────────────────────────────
// Grows by doubling. Kept local rather than pulled from anywhere because the
// repo has no package manager and this is 40 lines.
function makeHeap(capacity){
  let keys = new Float64Array(capacity);
  let vals = new Uint32Array(capacity);
  let size = 0;
  return {
    get size(){ return size; },
    clear(){ size = 0; },
    push(key, val){
      if(size === keys.length){
        const nk = new Float64Array(size * 2); nk.set(keys); keys = nk;
        const nv = new Uint32Array(size * 2);  nv.set(vals); vals = nv;
      }
      let i = size++;
      keys[i] = key; vals[i] = val;
      while(i > 0){
        const p = (i - 1) >> 1;
        if(keys[p] <= keys[i]) break;
        const k = keys[p], v = vals[p];
        keys[p] = keys[i]; vals[p] = vals[i];
        keys[i] = k; vals[i] = v;
        i = p;
      }
    },
    // Returns the value; the caller reads .topKey BEFORE popping if it needs it.
    pop(){
      const top = vals[0];
      size--;
      if(size > 0){
        keys[0] = keys[size]; vals[0] = vals[size];
        let i = 0;
        for(;;){
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if(l < size && keys[l] < keys[m]) m = l;
          if(r < size && keys[r] < keys[m]) m = r;
          if(m === i) break;
          const k = keys[m], v = vals[m];
          keys[m] = keys[i]; vals[m] = vals[i];
          keys[i] = k; vals[i] = v;
          i = m;
        }
      }
      return top;
    },
    peekKey(){ return keys[0]; },
  };
}

// ── decode ───────────────────────────────────────────────────────────────────

function readHeader(view, bytes){
  if(bytes < HEADER_BYTES) throw new Error('road pack: truncated header');
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if(magic !== PACK_MAGIC) throw new Error('road pack: bad magic ' + JSON.stringify(magic));
  const version = view.getUint16(4, true);
  if(version !== PACK_VERSION) throw new Error(`road pack: unsupported version ${version}`);
  return {
    version,
    bbox: {
      minLat: view.getInt32(8,  true) / COORD_SCALE,
      minLng: view.getInt32(12, true) / COORD_SCALE,
      maxLat: view.getInt32(16, true) / COORD_SCALE,
      maxLng: view.getInt32(20, true) / COORD_SCALE,
    },
    nodeCount:  view.getUint32(24, true),
    segCount:   view.getUint32(28, true),
    shapeCount: view.getUint32(32, true),
    // v2 address index. All five may be 0 — a roads-only district is valid and
    // simply has no offline geocoding.
    streetCount: view.getUint32(36, true),
    placeCount:  view.getUint32(40, true),
    addrCount:   view.getUint32(44, true),
    strBytes:    view.getUint32(48, true),
    placeBytes:  view.getUint32(52, true),
  };
}

// Section layout, in file order. Keep this table and tools/build-roadpack.mjs's
// writer in lockstep — it is the single description of the format on this side.
function sectionPlan({ nodeCount, segCount, shapeCount, streetCount, placeCount, addrCount, strBytes, placeBytes }){
  return [
    ['nodeLat',  Int32Array,  nodeCount],
    ['nodeLng',  Int32Array,  nodeCount],
    ['segFrom',  Uint32Array, segCount],
    ['segTo',    Uint32Array, segCount],
    ['segLen',   Uint32Array, segCount],
    ['segSpeed', Uint8Array,  segCount],
    ['segFlags', Uint8Array,  segCount],
    ['shapeOff', Uint32Array, segCount + 1],
    ['shapeLat', Int32Array,  shapeCount],
    ['shapeLng', Int32Array,  shapeCount],
    // ── v2 address index ──
    // Street and place names are UTF-8 blobs with offset tables, the usual
    // trick for a string array in a flat buffer.
    ['streetText', Uint32Array, streetCount + 1],
    ['strBlob',    Uint8Array,  strBytes],
    ['placeText',  Uint32Array, placeCount + 1],
    ['placeBlob',  Uint8Array,  placeBytes],
    // Address points are sorted by (street, house number), so the street id of
    // any point is implied by streetOff and never needs storing.
    ['streetOff',  Uint32Array, streetCount + 1],
    ['addrPlace',  Uint32Array, addrCount],
    ['addrNum',    Uint32Array, addrCount],
    ['addrLat',    Int32Array,  addrCount],
    ['addrLng',    Int32Array,  addrCount],
  ];
}

export function packByteLength(counts){
  let off = HEADER_BYTES;
  for(const [, Ctor, len] of sectionPlan(counts)) off = align4(off + Ctor.BYTES_PER_ELEMENT * len);
  return off;
}

// Rebuild the directed adjacency as CSR (offsets + parallel target/segment
// arrays). Two passes: count degrees, then fill. A two-way segment contributes
// one arc in each direction; a oneway contributes exactly one.
function buildAdjacency(g){
  const { nodeCount, segCount, segFrom, segTo, segFlags } = g;
  const deg = new Uint32Array(nodeCount + 1);
  let arcs = 0;
  for(let s = 0; s < segCount; s++){
    const f = segFlags[s];
    if(!(f & ONEWAY_REV)){ deg[segFrom[s]]++; arcs++; }
    if(!(f & ONEWAY_FWD)){ deg[segTo[s]]++;   arcs++; }
  }
  const adjOff = new Uint32Array(nodeCount + 1);
  for(let i = 0, run = 0; i <= nodeCount; i++){ adjOff[i] = run; run += deg[i] || 0; }
  const adjTo  = new Uint32Array(arcs);
  const adjSeg = new Uint32Array(arcs);
  const cursor = adjOff.slice(0, nodeCount);
  for(let s = 0; s < segCount; s++){
    const f = segFlags[s], a = segFrom[s], b = segTo[s];
    if(!(f & ONEWAY_REV)){ const i = cursor[a]++; adjTo[i] = b; adjSeg[i] = s; }
    if(!(f & ONEWAY_FWD)){ const i = cursor[b]++; adjTo[i] = a; adjSeg[i] = s; }
  }
  g.adjOff = adjOff; g.adjTo = adjTo; g.adjSeg = adjSeg;
}

// Bucket segments into a uniform lat/lng grid so snapping tests a handful of
// candidates instead of every road in the district. Segments are rasterized by
// SAMPLING along their shape rather than by bbox: a collapsed rural chain can
// be kilometres long and diagonal, and its bbox would touch hundreds of cells
// it never actually passes through.
function buildGrid(g){
  const { bbox, segCount } = g;
  const spanLatM = metresBetween(bbox.minLat, bbox.minLng, bbox.maxLat, bbox.minLng);
  const spanLngM = metresBetween(bbox.minLat, bbox.minLng, bbox.minLat, bbox.maxLng);
  const rows = Math.max(1, Math.min(GRID_MAX, Math.ceil(spanLatM / GRID_CELL_M)));
  const cols = Math.max(1, Math.min(GRID_MAX, Math.ceil(spanLngM / GRID_CELL_M)));
  const latSpan = (bbox.maxLat - bbox.minLat) || 1e-9;
  const lngSpan = (bbox.maxLng - bbox.minLng) || 1e-9;
  const cellOfLatLng = (lat, lng) => {
    let r = Math.floor((lat - bbox.minLat) / latSpan * rows);
    let c = Math.floor((lng - bbox.minLng) / lngSpan * cols);
    if(r < 0) r = 0; else if(r >= rows) r = rows - 1;
    if(c < 0) c = 0; else if(c >= cols) c = cols - 1;
    return r * cols + c;
  };
  // Step along a segment at roughly half a cell so no crossed cell is skipped.
  const stepM = GRID_CELL_M / 2;
  const visit = (seg, fn) => {
    const pts = segmentPoints(g, seg);
    const seen = new Set();
    for(let i = 0; i < pts.length; i++){
      const [aLat, aLng] = pts[i];
      const cell = cellOfLatLng(aLat, aLng);
      if(!seen.has(cell)){ seen.add(cell); fn(cell); }
      if(i + 1 >= pts.length) break;
      const [bLat, bLng] = pts[i + 1];
      const d = metresBetween(aLat, aLng, bLat, bLng);
      const steps = Math.floor(d / stepM);
      for(let k = 1; k <= steps; k++){
        const t = k / (steps + 1);
        const c2 = cellOfLatLng(aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t);
        if(!seen.has(c2)){ seen.add(c2); fn(c2); }
      }
    }
  };
  const cellCount = rows * cols;
  const counts = new Uint32Array(cellCount + 1);
  for(let s = 0; s < segCount; s++) visit(s, cell => { counts[cell]++; });
  const cellOff = new Uint32Array(cellCount + 1);
  for(let i = 0, run = 0; i <= cellCount; i++){ cellOff[i] = run; run += counts[i] || 0; }
  const cellSeg = new Uint32Array(cellOff[cellCount]);
  const cursor  = cellOff.slice(0, cellCount);
  for(let s = 0; s < segCount; s++) visit(s, cell => { cellSeg[cursor[cell]++] = s; });
  g.grid = { rows, cols, cellOff, cellSeg, cellOfLatLng };
}

// Decode an ArrayBuffer into a ready-to-route graph. Throws on a bad magic,
// an unknown version, or a buffer too short for its own declared counts —
// callers (js/roadpack.js) treat a throw as "this pack is unusable, delete it"
// rather than trying to route on half a district.
export function decodePack(buffer){
  const bytes = buffer.byteLength;
  const view  = new DataView(buffer);
  const head  = readHeader(view, bytes);
  const g = { ...head };
  let off = HEADER_BYTES;
  for(const [name, Ctor, len] of sectionPlan(head)){
    const need = Ctor.BYTES_PER_ELEMENT * len;
    if(off + need > bytes) throw new Error(`road pack: truncated at ${name}`);
    // Sections are 4-byte aligned by construction, so a typed-array view over
    // the original buffer is safe and costs no copy.
    g[name] = new Ctor(buffer, off, len);
    off = align4(off + need);
  }
  if(g.shapeOff[head.segCount] !== head.shapeCount)
    throw new Error('road pack: shape index does not match shape count');
  buildAdjacency(g);
  buildGrid(g);
  buildStreetIndex(g);
  // Scratch reused across every Dijkstra on this graph. The generation stamp
  // means a new source costs no clearing pass over 200k nodes.
  g._scratch = {
    dist: new Float64Array(head.nodeCount),
    metres: new Float64Array(head.nodeCount),
    prevSeg: new Int32Array(head.nodeCount),
    prevNode: new Int32Array(head.nodeCount),
    seen: new Uint32Array(head.nodeCount),
    gen: 0,
    heap: makeHeap(Math.max(16, Math.min(head.nodeCount, 1 << 14))),
  };
  return g;
}

// ── offline geocoding ────────────────────────────────────────────────────────
// The pack's second job. Forward geocoding is the ONE part of Optimize that
// still needed signal after on-device routing landed; an address index built
// from the same OSM extract closes it. A miss here is not an error — geocodeOne
// simply falls through to Nominatim/Google/ORS exactly as before.

function decodeStrings(blob, offsets, count){
  const dec = new TextDecoder();
  const out = new Array(count);
  for(let i = 0; i < count; i++) out[i] = dec.decode(blob.subarray(offsets[i], offsets[i + 1]));
  return out;
}

// Street names are stored ALREADY NORMALIZED, so the lookup is an exact map hit
// rather than a scan — a district can hold tens of thousands of streets and a
// route geocodes a whole worklist one address at a time.
function buildStreetIndex(g){
  g.streetNames = g.streetCount ? decodeStrings(g.strBlob, g.streetText, g.streetCount) : [];
  g.placeNames  = g.placeCount  ? decodeStrings(g.placeBlob, g.placeText, g.placeCount)  : [];
  g.streetIndex = new Map();
  for(let i = 0; i < g.streetNames.length; i++) g.streetIndex.set(g.streetNames[i], i);
}

export function hasAddresses(g){ return !!(g && g.addrCount > 0); }

// Place a house number among one street's points, which are sorted by number.
// Exact match wins; otherwise INTERPOLATE between the neighbours that bracket
// it, which is what makes rural roads usable — OSM rarely has every civic
// number, but "between 410 and 460" puts the pin on the right stretch of road
// rather than at the wrong end of a 12 km concession.
function placeOnStreet(g, lo, hi, want){
  if(hi <= lo) return null;
  if(!want){
    const mid = (lo + hi - 1) >> 1;                 // no number typed → the street itself
    return { lat: g.addrLat[mid] / COORD_SCALE, lng: g.addrLng[mid] / COORD_SCALE, exact:false };
  }
  let a = lo, b = hi - 1;
  while(a <= b){
    const m = (a + b) >> 1;
    if(g.addrNum[m] === want)
      return { lat: g.addrLat[m] / COORD_SCALE, lng: g.addrLng[m] / COORD_SCALE, exact:true };
    if(g.addrNum[m] < want) a = m + 1; else b = m - 1;
  }
  // a is now the first index above `want`; b the last below it.
  const below = b >= lo ? b : -1, above = a < hi ? a : -1;
  if(below < 0 && above < 0) return null;
  if(below < 0) return { lat: g.addrLat[above] / COORD_SCALE, lng: g.addrLng[above] / COORD_SCALE, exact:false };
  if(above < 0) return { lat: g.addrLat[below] / COORD_SCALE, lng: g.addrLng[below] / COORD_SCALE, exact:false };
  const span = g.addrNum[above] - g.addrNum[below];
  const t = span > 0 ? (want - g.addrNum[below]) / span : 0.5;
  return {
    lat: (g.addrLat[below] + (g.addrLat[above] - g.addrLat[below]) * t) / COORD_SCALE,
    lng: (g.addrLng[below] + (g.addrLng[above] - g.addrLng[below]) * t) / COORD_SCALE,
    exact: false,
  };
}

// "123 Main St" → hits in pickBest()'s shape: [{lat, lng, label, place}].
//
// One hit PER LOCALITY, deliberately. The same street name recurs across a
// district, and returning them all is what lets route.js's existing pickBest
// raise the "⚠ pick a town" ambiguity instead of silently choosing — the same
// protection GEO_RADIUS_KM gives the online providers.
export function geocodeAddress(g, address){
  if(!hasAddresses(g)) return [];
  const { num, street } = splitAddress(address);
  const key = normalizeStreet(street);
  if(!key) return [];
  const sid = g.streetIndex.get(key);
  if(sid === undefined) return [];
  const lo = g.streetOff[sid], hi = g.streetOff[sid + 1];
  if(hi <= lo) return [];

  const want = houseNumber(num);
  // Group this street's points by locality, preserving the sorted-by-number
  // order inside each group so placeOnStreet can still binary-search.
  const groups = new Map();
  for(let i = lo; i < hi; i++){
    const p = g.addrPlace[i];
    if(!groups.has(p)) groups.set(p, []);
    groups.get(p).push(i);
  }
  const hits = [];
  for(const [placeId, idx] of groups){
    // Re-project the group into a contiguous view placeOnStreet can bisect.
    const view = {
      addrNum: idx.map(i => g.addrNum[i]),
      addrLat: idx.map(i => g.addrLat[i]),
      addrLng: idx.map(i => g.addrLng[i]),
    };
    const hit = placeOnStreet(view, 0, idx.length, want);
    if(!hit) continue;
    const town = g.placeNames[placeId] || '';
    hits.push({
      lat: hit.lat, lng: hit.lng,
      label: [address, town].filter(Boolean).join(', '),
      place: town || `street:${sid}`,
      exact: hit.exact,
    });
  }
  // An exact civic match outranks an interpolated guess.
  hits.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  return hits;
}

// ── geometry ─────────────────────────────────────────────────────────────────

// The full driven shape of a segment as [[lat,lng], …], endpoints included.
// Shape points are the intermediate vertices only — the endpoints live in the
// node table, which is why they are spliced back on here.
export function segmentPoints(g, seg){
  const out = [[g.nodeLat[g.segFrom[seg]] / COORD_SCALE, g.nodeLng[g.segFrom[seg]] / COORD_SCALE]];
  for(let i = g.shapeOff[seg]; i < g.shapeOff[seg + 1]; i++)
    out.push([g.shapeLat[i] / COORD_SCALE, g.shapeLng[i] / COORD_SCALE]);
  out.push([g.nodeLat[g.segTo[seg]] / COORD_SCALE, g.nodeLng[g.segTo[seg]] / COORD_SCALE]);
  return out;
}

export function packCovers(g, coord, marginDeg = 0){
  if(!g || !coord) return false;
  const { minLat, minLng, maxLat, maxLng } = g.bbox;
  return coord.lat >= minLat - marginDeg && coord.lat <= maxLat + marginDeg
      && coord.lng >= minLng - marginDeg && coord.lng <= maxLng + marginDeg;
}

// Project a point onto one sub-segment, in a local planar frame scaled by
// cos(lat) so degrees of longitude and latitude are comparable.
function projectOnto(pLat, pLng, aLat, aLng, bLat, bLng, cosLat){
  const ax = aLng * cosLat, ay = aLat;
  const bx = bLng * cosLat, by = bLat;
  const px = pLng * cosLat, py = pLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if(t < 0) t = 0; else if(t > 1) t = 1;
  return { t, lat: aLat + (bLat - aLat) * t, lng: aLng + (bLng - aLng) * t };
}

// Nearest point on the drivable network. Returns
//   { seg, lat, lng, distM, toFromM, toToM }
// where toFromM/toToM are the metres from the snapped point to each end of the
// segment — that split is what lets routing start and end PART WAY along a
// road without mutating the graph (see dijkstra() below). Null when nothing is
// within SNAP_RADIUS_M, which the caller must treat as off-network.
export function snap(g, coord, radiusM = SNAP_RADIUS_M){
  if(!g || !coord || !Number.isFinite(coord.lat) || !Number.isFinite(coord.lng)) return null;
  const { grid } = g;
  const cosLat = Math.cos(coord.lat * D2R);
  let best = null;
  // Widen the ring until something is found or the ring exceeds the radius —
  // a stop just outside the built-up area still snaps to the road that serves it.
  const maxRing = Math.max(1, Math.ceil(radiusM / GRID_CELL_M) + 1);
  const home = grid.cellOfLatLng(coord.lat, coord.lng);
  const homeRow = Math.floor(home / grid.cols), homeCol = home % grid.cols;
  const tried = new Set();
  for(let ring = 0; ring <= maxRing; ring++){
    for(let r = homeRow - ring; r <= homeRow + ring; r++){
      if(r < 0 || r >= grid.rows) continue;
      for(let c = homeCol - ring; c <= homeCol + ring; c++){
        if(c < 0 || c >= grid.cols) continue;
        // Only the newly-added perimeter of the ring.
        if(ring > 0 && Math.abs(r - homeRow) !== ring && Math.abs(c - homeCol) !== ring) continue;
        const cell = r * grid.cols + c;
        for(let i = grid.cellOff[cell]; i < grid.cellOff[cell + 1]; i++){
          const seg = grid.cellSeg[i];
          if(tried.has(seg)) continue;
          tried.add(seg);
          const pts = segmentPoints(g, seg);
          let run = 0;
          for(let k = 0; k + 1 < pts.length; k++){
            const [aLat, aLng] = pts[k], [bLat, bLng] = pts[k + 1];
            const subLen = metresBetween(aLat, aLng, bLat, bLng);
            const p = projectOnto(coord.lat, coord.lng, aLat, aLng, bLat, bLng, cosLat);
            const d = metresBetween(coord.lat, coord.lng, p.lat, p.lng);
            if(!best || d < best.distM)
              best = { seg, lat: p.lat, lng: p.lng, distM: d, along: run + subLen * p.t };
            run += subLen;
          }
        }
      }
    }
    // Found something comfortably inside the ring already scanned — stop early.
    if(best && best.distM <= ring * GRID_CELL_M) break;
  }
  if(!best || best.distM > radiusM) return null;
  // Scale the along-distance onto the pack's authoritative segment length: the
  // shape walk and segLen can disagree by a metre or two, and toFromM+toToM
  // must add up to segLen or the matrix picks up a small systematic bias.
  const total = g.segLen[best.seg];
  let shapeLen = 0;
  const pts = segmentPoints(g, best.seg);
  for(let k = 0; k + 1 < pts.length; k++)
    shapeLen += metresBetween(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
  const along = shapeLen > 0 ? (best.along / shapeLen) * total : 0;
  return {
    seg: best.seg, lat: best.lat, lng: best.lng, distM: best.distM,
    toFromM: along, toToM: Math.max(0, total - along),
  };
}

// Seconds to drive `metres` of segment `seg`. Speeds are stored in km/h; a
// zero/garbage speed falls back to 30 km/h rather than dividing by zero.
function secondsFor(g, seg, m){
  const kph = g.segSpeed[seg] || 30;
  return m / (kph / 3.6);
}

// The half-segment entry/exit costs for a snapped point, respecting oneway.
// Infinity means that end is not reachable from (or cannot reach) the snap.
function snapEnds(g, sn){
  const flags = g.segFlags[sn.seg];
  const fromNode = g.segFrom[sn.seg], toNode = g.segTo[sn.seg];
  // Leaving the snapped point: to `from` we drive backwards along the segment,
  // to `to` we drive forwards.
  return {
    fromNode, toNode,
    outToFrom: (flags & ONEWAY_FWD) ? Infinity : secondsFor(g, sn.seg, sn.toFromM),
    outToTo:   (flags & ONEWAY_REV) ? Infinity : secondsFor(g, sn.seg, sn.toToM),
    inFromFrom:(flags & ONEWAY_REV) ? Infinity : secondsFor(g, sn.seg, sn.toFromM),
    inFromTo:  (flags & ONEWAY_FWD) ? Infinity : secondsFor(g, sn.seg, sn.toToM),
    mFrom: sn.toFromM, mTo: sn.toToM,
  };
}

// One-to-many Dijkstra from a snapped source, costed in SECONDS while carrying
// metres along for free. Stops once every requested target node is settled (or
// the frontier passes MAX_LEG_SECONDS), so a 25-stop matrix does not scan the
// whole district 25 times.
//
// The snapped source is a VIRTUAL node: rather than splitting the segment (which
// would mean rebuilding the CSR per query) the search is simply seeded at both
// endpoints with the partial cost of driving out to them. Targets are evaluated
// the same way in reverse. This is exact except in one case — source and target
// on the same segment with no detour — which matrixFrom() handles directly.
function dijkstra(g, sn, wantNodes, needTrack){
  const s = g._scratch;
  const gen = ++s.gen;
  const { dist, metres, seen, heap, prevSeg, prevNode } = s;
  heap.clear();
  const ends = snapEnds(g, sn);
  const seed = (node, sec, m) => {
    if(!Number.isFinite(sec)) return;
    if(seen[node] === gen && dist[node] <= sec) return;
    seen[node] = gen; dist[node] = sec; metres[node] = m;
    if(needTrack){ prevSeg[node] = -1; prevNode[node] = -1; }
    heap.push(sec, node);
  };
  seed(ends.fromNode, ends.outToFrom, ends.mFrom);
  seed(ends.toNode,   ends.outToTo,   ends.mTo);

  // Early exit: a node popped off the heap is settled, so once every wanted
  // node has been popped there is nothing left to improve. Without this a
  // 25-stop matrix scans the whole district 25 times.
  const wanted = wantNodes;
  let outstanding = wanted ? wanted.size : -1;
  while(heap.size){
    const cost = heap.peekKey();
    const node = heap.pop();
    if(seen[node] !== gen || cost > dist[node]) continue;   // stale heap entry
    if(cost > MAX_LEG_SECONDS) break;
    if(outstanding > 0 && wanted.has(node) && --outstanding === 0) break;
    for(let i = g.adjOff[node]; i < g.adjOff[node + 1]; i++){
      const nxt = g.adjTo[i], seg = g.adjSeg[i];
      const m = g.segLen[seg];
      const nc = cost + secondsFor(g, seg, m);
      if(nc > MAX_LEG_SECONDS) continue;
      if(seen[nxt] === gen && dist[nxt] <= nc) continue;
      seen[nxt] = gen; dist[nxt] = nc; metres[nxt] = metres[node] + m;
      if(needTrack){ prevSeg[nxt] = seg; prevNode[nxt] = node; }
      heap.push(nc, nxt);
    }
  }
  return {
    gen,
    cost: node => (seen[node] === gen ? dist[node] : Infinity),
    dist: node => (seen[node] === gen ? metres[node] : Infinity),
  };
}

// Cumulative metres along a segment's drawn shape, plus the shape's own total.
// The pack's segLen is authoritative for routing, but the drawn shape can
// differ from it by a metre or two, so anything that converts BETWEEN the two
// (snap offsets ↔ shape positions) has to go through this scaling.
function shapeCum(g, seg){
  const pts = segmentPoints(g, seg);
  const cum = [0];
  for(let k = 0; k + 1 < pts.length; k++)
    cum.push(cum[k] + metresBetween(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]));
  return { pts, cum, shapeLen: cum[cum.length - 1] };
}

function shapePosition(g, seg, sn){
  const { cum, shapeLen } = shapeCum(g, seg);
  const total = g.segLen[seg] || shapeLen || 1;
  return { at: shapeLen > 0 ? (sn.toFromM / total) * shapeLen : 0, cum, shapeLen };
}

// The drawn shape from a snapped position out to one end of its segment, in
// driving order. Trimming here is why a drawn leg stops AT the meter instead of
// overshooting to the end of the block.
function partialSegment(g, seg, sn, towardTo){
  const { pts } = shapeCum(g, seg);
  const { at, cum } = shapePosition(g, seg, sn);
  const out = [[sn.lat, sn.lng]];
  if(towardTo){
    for(let k = 0; k < pts.length; k++) if(cum[k] > at) out.push(pts[k]);
  } else {
    for(let k = pts.length - 1; k >= 0; k--) if(cum[k] < at) out.push(pts[k]);
  }
  return out;
}

// The drawn shape between two snaps that share a segment.
function betweenOnSegment(g, seg, a, b){
  const { pts } = shapeCum(g, seg);
  const aPos = shapePosition(g, seg, a).at;
  const bPos = shapePosition(g, seg, b).at;
  const { cum } = shapePosition(g, seg, a);
  const lo = Math.min(aPos, bPos), hi = Math.max(aPos, bPos);
  const mid = pts.filter((_, k) => cum[k] > lo && cum[k] < hi);
  const forward = bPos >= aPos;
  return [[a.lat, a.lng], ...(forward ? mid : mid.reverse()), [b.lat, b.lng]];
}

// Metres/seconds between two snaps that landed on the SAME segment, driving
// directly along it. Infinity when the oneway forbids that direction — the
// caller then falls back to the routed answer, which will go around the block.
function sameSegmentDirect(g, a, b){
  if(a.seg !== b.seg) return { m: Infinity, sec: Infinity };
  const flags = g.segFlags[a.seg];
  const forward = b.toFromM >= a.toFromM;
  if(forward && (flags & ONEWAY_REV)) return { m: Infinity, sec: Infinity };
  if(!forward && (flags & ONEWAY_FWD)) return { m: Infinity, sec: Infinity };
  const m = Math.abs(b.toFromM - a.toFromM);
  return { m, sec: secondsFor(g, a.seg, m) };
}

// ── public routing API ───────────────────────────────────────────────────────

// Distance + duration matrix over `coords` ([{lat,lng}, …]).
//
// Returns { D, T, snapped } where D is metres, T is MINUTES, both N×N with
// zeroed diagonals and Infinity where no drivable path exists — exactly what
// osrmMatrix() returns, so js/route.js can treat this as one more provider.
// `snapped` is a per-coordinate boolean: false means that stop was off-network
// (nothing within SNAP_RADIUS_M) and its whole row/column is Infinity, which is
// the caller's cue to price it crow-flies via straightLineNode().
export function matrix(g, coords){
  const n = coords.length;
  const snaps = coords.map(c => snap(g, c));
  const D = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const T = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for(let i = 0; i < n; i++){ D[i][i] = 0; T[i][i] = 0; }

  // Every node that any target's snap could be entered from.
  for(let i = 0; i < n; i++){
    const from = snaps[i];
    if(!from) continue;
    const want = new Set();
    for(let j = 0; j < n; j++){
      if(i === j || !snaps[j]) continue;
      want.add(g.segFrom[snaps[j].seg]);
      want.add(g.segTo[snaps[j].seg]);
    }
    if(!want.size) continue;
    const res = dijkstra(g, from, want, false);
    for(let j = 0; j < n; j++){
      if(i === j) continue;
      const to = snaps[j];
      if(!to) continue;
      const ends = snapEnds(g, to);
      // Arrive at either end of the target segment, then drive the remaining
      // part-segment inwards to the snapped point.
      let bestSec = Infinity, bestM = Infinity;
      const viaFrom = res.cost(ends.fromNode) + ends.inFromFrom;
      if(viaFrom < bestSec){ bestSec = viaFrom; bestM = res.dist(ends.fromNode) + ends.mFrom; }
      const viaTo = res.cost(ends.toNode) + ends.inFromTo;
      if(viaTo < bestSec){ bestSec = viaTo; bestM = res.dist(ends.toNode) + ends.mTo; }
      const direct = sameSegmentDirect(g, from, to);
      if(direct.sec < bestSec){ bestSec = direct.sec; bestM = direct.m; }
      D[i][j] = Number.isFinite(bestM) ? bestM : Infinity;
      T[i][j] = Number.isFinite(bestSec) ? bestSec / 60 : Infinity;
    }
  }
  return { D, T, snapped: snaps.map(Boolean) };
}

// The driven path between two coordinates as [[lat,lng], …], ready for
// encodePolyline() in js/route.js. Empty array when either end is off-network
// or nothing connects them — callers draw a straight line in that case, which
// is the behaviour a missing legGeometry already produces today.
export function path(g, fromCoord, toCoord){
  const a = snap(g, fromCoord), b = snap(g, toCoord);
  if(!a || !b) return [];
  const ends = snapEnds(g, b);
  const want = new Set([ends.fromNode, ends.toNode]);
  const res = dijkstra(g, a, want, true);
  const viaFrom = res.cost(ends.fromNode) + ends.inFromFrom;
  const viaTo   = res.cost(ends.toNode)   + ends.inFromTo;
  const direct  = sameSegmentDirect(g, a, b);
  if(!Number.isFinite(Math.min(viaFrom, viaTo, direct.sec))) return [];

  // A straight run along one segment never touches the node graph.
  if(direct.sec <= viaFrom && direct.sec <= viaTo)
    return dedupe(betweenOnSegment(g, a.seg, a, b));

  const endNode = viaFrom <= viaTo ? ends.fromNode : ends.toNode;
  // Walk the predecessor chain back to the source, collecting whole segments.
  const chain = [];
  const s = g._scratch;
  let cur = endNode;
  let guard = 0;
  while(cur >= 0 && s.prevSeg[cur] >= 0 && guard++ < g.segCount + 4){
    chain.push({ seg: s.prevSeg[cur], to: cur });
    cur = s.prevNode[cur];
  }
  chain.reverse();

  // The part-segment out of the source, trimmed at the snap: `cur` is whichever
  // end of the source segment the path actually left by, so driving order is
  // "toward to" only when that end IS the segment's to-node.
  const out = partialSegment(g, a.seg, a, cur === g.segTo[a.seg]);
  for(const { seg, to } of chain){
    const pts = segmentPoints(g, seg);
    const ordered = to === g.segTo[seg] ? pts : pts.slice().reverse();
    for(const p of ordered) out.push(p);
  }
  // The part-segment into the target, walked from the arrival node inwards and
  // then reversed so the whole polyline stays in driving order.
  const tail = partialSegment(g, b.seg, b, endNode === g.segTo[b.seg]);
  for(let i = tail.length - 1; i >= 0; i--) out.push(tail[i]);
  return dedupe(out);
}

// Consecutive identical points make for a fatter polyline and nothing else;
// the joins above always repeat a node.
function dedupe(points){
  const out = [];
  for(const p of points){
    const last = out[out.length - 1];
    if(last && Math.abs(last[0] - p[0]) < 1e-7 && Math.abs(last[1] - p[1]) < 1e-7) continue;
    out.push(p);
  }
  return out;
}
