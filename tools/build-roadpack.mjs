#!/usr/bin/env node
// ── Build a district pack: roads to route on + addresses to geocode with ─────
// Produces the compact binary js/roadgraph.js reads. Plain Node, no
// dependencies — this repo has no package manager (AGENTS.md).
//
// The format constants and the street-name normalization are IMPORTED from
// js/roadgraph.js rather than restated here. Both sides must agree exactly or
// the phone silently fails to match addresses it actually has, so there is one
// definition and the tool bends to it.
//
// INPUT is GeoJSON-seq (one Feature per line), which osmium produces from the
// same Ontario .pbf already downloaded for OSRM. One feature per line is what
// lets this stream a multi-hundred-MB district without holding it in memory.
// Two inputs: the road ways, and (optionally) the address objects.
// See DEPLOY.md for the docker commands.
//
// USAGE
//   node tools/build-roadpack.mjs \
//     --in   D:/osrm/district-roads.geojsonseq \
//     --addr D:/osrm/district-addr.geojsonseq \
//     --id kawartha --name "Kawartha Lakes" \
//     --bbox -79.4,44.2,-78.0,45.0            # minLng,minLat,maxLng,maxLat
//
// Writes maps/<id>.pack and updates maps/index.json.
import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACK_MAGIC, PACK_VERSION, HEADER_BYTES, COORD_SCALE,
  ONEWAY_FWD, ONEWAY_REV, normalizeStreet, houseNumber,
} from '../js/roadgraph.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export { PACK_MAGIC, PACK_VERSION, ONEWAY_FWD, ONEWAY_REV };

// ── OSM car profile (a deliberate simplification of OSRM's) ──────────────────
// Free-flow km/h per highway class. These only need to be right RELATIVE to
// each other for the ordering to come out right; absolute accuracy matters for
// ETAs, which is why maxspeed overrides them whenever it is tagged.
const SPEEDS = {
  motorway: 100, motorway_link: 60,
  trunk: 85,     trunk_link: 50,
  primary: 65,   primary_link: 45,
  secondary: 55, secondary_link: 40,
  tertiary: 45,  tertiary_link: 30,
  unclassified: 35, residential: 30, living_street: 10,
  service: 20, road: 30, track: 15,
};
const drivable = hw => Object.prototype.hasOwnProperty.call(SPEEDS, hw);

function parseMaxspeed(raw){
  if(!raw) return 0;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/);
  if(!m) return 0;                       // "walk", "none", "RU:urban" → class default
  const n = Number(m[1]);
  if(!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(m[2] === 'mph' ? n * 1.609344 : n);
}

// A oneway a router ignores sends the crew the wrong way up a street, so this
// covers the tag's real vocabulary rather than just "yes".
function onewayFlags(props){
  const raw = String(props.oneway ?? '').trim().toLowerCase();
  if(raw === 'yes' || raw === '1' || raw === 'true') return ONEWAY_FWD;
  if(raw === '-1' || raw === 'reverse') return ONEWAY_REV;
  if(raw === 'no' || raw === 'false' || raw === '0') return 0;
  const j = String(props.junction ?? '').toLowerCase();
  if(j === 'roundabout' || j === 'circular') return ONEWAY_FWD;
  return 0;
}

function blocked(props){
  const access = String(props.access ?? '').toLowerCase();
  if(access === 'private' || access === 'no'){
    // A driveway tagged private still gets you to the meter on it; a gated
    // through-road does not. Motor-vehicle access re-opens the way explicitly.
    const mv = String(props['motor_vehicle'] ?? props['motorcar'] ?? '').toLowerCase();
    if(mv !== 'yes' && mv !== 'permissive' && mv !== 'destination') return true;
  }
  const hw = String(props.highway ?? '').toLowerCase();
  if(hw === 'construction' || hw === 'proposed') return true;
  return false;
}

const R_EARTH = 6371008.8, D2R = Math.PI / 180;
function metresBetween(aLat, aLng, bLat, bLng){
  const midLat = (aLat + bLat) / 2 * D2R;
  const x = (bLng - aLng) * D2R * Math.cos(midLat);
  const y = (bLat - aLat) * D2R;
  return Math.sqrt(x * x + y * y) * R_EARTH;
}

// ── encoder (also imported by tests/roadgraph.test.mjs) ──────────────────────
// `graph` is the plain-object form:
//   { bbox:{minLat,minLng,maxLat,maxLng},
//     nodes:[[lat,lng], …],
//     segments:[{ from, to, lengthM, speedKph, flags, shape:[[lat,lng], …] }, …],
//     streets:[normalizedName, …],          // optional address index
//     places:[localityName, …],
//     addresses:[{ street, place, num, lat, lng }, …] }
// Keeping the encoder here (rather than duplicating a fixture writer in the
// test) is what guarantees the tests exercise the real format.
function align4(n){ return (n + 3) & ~3; }

function encodeStrings(list){
  const enc = new TextEncoder();
  const parts = (list || []).map(s => enc.encode(String(s ?? '')));
  const offsets = new Uint32Array(parts.length + 1);
  let total = 0;
  for(let i = 0; i < parts.length; i++){ offsets[i] = total; total += parts[i].length; }
  offsets[parts.length] = total;
  const blob = new Uint8Array(total);
  let at = 0;
  for(const p of parts){ blob.set(p, at); at += p.length; }
  return { blob, offsets };
}

export function encodePack(graph){
  const nodes = graph.nodes, segs = graph.segments;
  const streets = graph.streets || [];
  const places  = graph.places  || [];
  // Addresses MUST arrive sorted by (street, house number): the street id of a
  // point is implied by streetOff, and placeOnStreet() binary-searches numbers.
  const addrs = (graph.addresses || []).slice()
    .sort((a, b) => (a.street - b.street) || (a.num - b.num));

  const nodeCount = nodes.length, segCount = segs.length;
  const shapeCount = segs.reduce((n, s) => n + (s.shape ? s.shape.length : 0), 0);
  const streetCount = streets.length, placeCount = places.length, addrCount = addrs.length;
  const str = encodeStrings(streets);
  const plc = encodeStrings(places);

  const counts = { nodeCount, segCount, shapeCount, streetCount, placeCount, addrCount,
    strBytes: str.blob.length, placeBytes: plc.blob.length };

  const plan = [
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
    ['streetText', Uint32Array, streetCount + 1],
    ['strBlob',    Uint8Array,  counts.strBytes],
    ['placeText',  Uint32Array, placeCount + 1],
    ['placeBlob',  Uint8Array,  counts.placeBytes],
    ['streetOff',  Uint32Array, streetCount + 1],
    ['addrPlace',  Uint32Array, addrCount],
    ['addrNum',    Uint32Array, addrCount],
    ['addrLat',    Int32Array,  addrCount],
    ['addrLng',    Int32Array,  addrCount],
  ];
  let total = HEADER_BYTES;
  const offsets = {};
  for(const [name, Ctor, len] of plan){
    offsets[name] = total;
    total = align4(total + Ctor.BYTES_PER_ELEMENT * len);
  }

  const buf  = new ArrayBuffer(total);
  const view = new DataView(buf);
  for(let i = 0; i < 4; i++) view.setUint8(i, PACK_MAGIC.charCodeAt(i));
  view.setUint16(4, PACK_VERSION, true);
  view.setUint16(6, 0, true);
  view.setInt32(8,  Math.round(graph.bbox.minLat * COORD_SCALE), true);
  view.setInt32(12, Math.round(graph.bbox.minLng * COORD_SCALE), true);
  view.setInt32(16, Math.round(graph.bbox.maxLat * COORD_SCALE), true);
  view.setInt32(20, Math.round(graph.bbox.maxLng * COORD_SCALE), true);
  view.setUint32(24, nodeCount,   true);
  view.setUint32(28, segCount,    true);
  view.setUint32(32, shapeCount,  true);
  view.setUint32(36, streetCount, true);
  view.setUint32(40, placeCount,  true);
  view.setUint32(44, addrCount,   true);
  view.setUint32(48, counts.strBytes,   true);
  view.setUint32(52, counts.placeBytes, true);

  const arr = {};
  for(const [name, Ctor, len] of plan) arr[name] = new Ctor(buf, offsets[name], len);

  for(let i = 0; i < nodeCount; i++){
    arr.nodeLat[i] = Math.round(nodes[i][0] * COORD_SCALE);
    arr.nodeLng[i] = Math.round(nodes[i][1] * COORD_SCALE);
  }
  let shapeAt = 0;
  for(let s = 0; s < segCount; s++){
    const seg = segs[s];
    arr.segFrom[s]  = seg.from;
    arr.segTo[s]    = seg.to;
    arr.segLen[s]   = Math.max(1, Math.round(seg.lengthM));
    arr.segSpeed[s] = Math.max(1, Math.min(255, Math.round(seg.speedKph)));
    arr.segFlags[s] = seg.flags | 0;
    arr.shapeOff[s] = shapeAt;
    for(const [lat, lng] of (seg.shape || [])){
      arr.shapeLat[shapeAt] = Math.round(lat * COORD_SCALE);
      arr.shapeLng[shapeAt] = Math.round(lng * COORD_SCALE);
      shapeAt++;
    }
  }
  arr.shapeOff[segCount] = shapeAt;

  arr.streetText.set(str.offsets);
  if(counts.strBytes) arr.strBlob.set(str.blob);
  arr.placeText.set(plc.offsets);
  if(counts.placeBytes) arr.placeBlob.set(plc.blob);

  // streetOff is the start of each street's run in the sorted address array.
  // Built by counting, so a street with no points gets an empty (equal) range
  // rather than being skipped.
  const perStreet = new Uint32Array(streetCount);
  for(const a of addrs) perStreet[a.street]++;
  for(let i = 0, run = 0; i <= streetCount; i++){
    arr.streetOff[i] = run;
    if(i < streetCount) run += perStreet[i];
  }
  for(let i = 0; i < addrCount; i++){
    arr.addrPlace[i] = addrs[i].place;
    arr.addrNum[i]   = addrs[i].num;
    arr.addrLat[i]   = Math.round(addrs[i].lat * COORD_SCALE);
    arr.addrLng[i]   = Math.round(addrs[i].lng * COORD_SCALE);
  }
  return Buffer.from(buf);
}

// ── streaming input ──────────────────────────────────────────────────────────

async function eachFeature(file, fn){
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let bad = 0;
  for await (const line of rl){
    const s = line.trim();
    if(!s || s === ',' || s === '[' || s === ']') continue;
    const clean = s.charCodeAt(0) === 0x1e ? s.slice(1) : s;   // geojsonseq RS prefix
    let f;
    try { f = JSON.parse(clean.replace(/,$/, '')); } catch { bad++; continue; }
    if(f && f.geometry) fn(f);
  }
  return bad;
}

function usableWay(f){
  if(f.geometry.type !== 'LineString') return null;
  const props = f.properties || {};
  const hw = String(props.highway ?? '').toLowerCase();
  if(!drivable(hw) || blocked(props)) return null;
  const coords = f.geometry.coordinates;
  if(!Array.isArray(coords) || coords.length < 2) return null;
  return { props, hw, coords };
}

// Coordinates are keyed as a single integer offset from the bbox corner, which
// keeps the junction-counting Map numeric. A string key ("lat,lng") is the
// obvious alternative and blows past several hundred MB on a real district.
function makeKeyer(bbox){
  const SHIFT = 8388608;   // 2^23 — enough for ~8.4 degrees of longitude at 1e6
  return (lat, lng) => {
    const la = Math.round((lat - bbox.minLat) * COORD_SCALE);
    const ln = Math.round((lng - bbox.minLng) * COORD_SCALE);
    return la * SHIFT + ln;
  };
}

// A representative point for an address feature: the node itself, or the
// centroid of a building outline.
function addrPoint(geom){
  if(geom.type === 'Point') return { lat: geom.coordinates[1], lng: geom.coordinates[0] };
  const ring = geom.type === 'Polygon' ? geom.coordinates[0]
    : geom.type === 'MultiPolygon' ? geom.coordinates[0][0]
    : geom.type === 'LineString' ? geom.coordinates : null;
  if(!Array.isArray(ring) || !ring.length) return null;
  let lat = 0, lng = 0;
  for(const c of ring){ lng += c[0]; lat += c[1]; }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

// ── the build ────────────────────────────────────────────────────────────────

export async function buildPack({ roadsFile, addrFile = '', id, name, bbox, mapsDir, log = () => {} }){
  const key = makeKeyer(bbox);

  // Pass 1 — how many ways touch each coordinate (junctions).
  log('Finding junctions…');
  const uses = new Map();
  let ways = 0;
  await eachFeature(roadsFile, f => {
    const w = usableWay(f);
    if(!w) return;
    ways++;
    for(let i = 0; i < w.coords.length; i++){
      const k = key(w.coords[i][1], w.coords[i][0]);
      const bump = (i === 0 || i === w.coords.length - 1) ? 2 : 1;   // way ends are always nodes
      uses.set(k, (uses.get(k) || 0) + bump);
    }
  });
  log(`${ways.toLocaleString()} drivable ways, ${uses.size.toLocaleString()} distinct coordinates`);

  // Pass 2 — split ways at junctions, collapse the rest into segments.
  log('Building segments…');
  const nodeId = new Map();
  const nodes = [];
  const segments = [];
  const nodeFor = (lat, lng, k) => {
    let nid = nodeId.get(k);
    if(nid === undefined){ nid = nodes.length; nodeId.set(k, nid); nodes.push([lat, lng]); }
    return nid;
  };
  await eachFeature(roadsFile, f => {
    const w = usableWay(f);
    if(!w) return;
    const speedKph = parseMaxspeed(w.props.maxspeed) || SPEEDS[w.hw];
    const flags = onewayFlags(w.props);
    let shape = [], lengthM = 0, fromNode = null;
    for(let i = 0; i < w.coords.length; i++){
      const lng = w.coords[i][0], lat = w.coords[i][1];
      const k = key(lat, lng);
      if(i === 0){ fromNode = nodeFor(lat, lng, k); continue; }
      const prev = w.coords[i - 1];
      lengthM += metresBetween(prev[1], prev[0], lat, lng);
      if((uses.get(k) || 0) > 1 || i === w.coords.length - 1){
        const to = nodeFor(lat, lng, k);
        // A way that loops back on itself produces a zero-length stub; drop it
        // rather than seeding the graph with a self-edge.
        if(to !== fromNode && lengthM > 0)
          segments.push({ from: fromNode, to, lengthM, speedKph, flags, shape });
        fromNode = to; shape = []; lengthM = 0;
      } else {
        shape.push([lat, lng]);
      }
    }
  });
  log(`${nodes.length.toLocaleString()} nodes, ${segments.length.toLocaleString()} segments`);
  if(!segments.length) throw new Error('No drivable segments found — wrong input file?');

  // Pass 3 — the address index (optional).
  const streets = [], places = [], addresses = [];
  if(addrFile){
    log('Indexing addresses…');
    const streetId = new Map(), placeId = new Map();
    const idFor = (map, list, value) => {
      let v = map.get(value);
      if(v === undefined){ v = list.length; map.set(value, v); list.push(value); }
      return v;
    };
    // Dedupe: OSM often carries the same civic address on both the building
    // outline and a node inside it.
    const seen = new Set();
    let skipped = 0;
    await eachFeature(addrFile, f => {
      const p = f.properties || {};
      const num = houseNumber(p['addr:housenumber']);
      const streetRaw = p['addr:street'];
      if(!num || !streetRaw){ skipped++; return; }
      const norm = normalizeStreet(streetRaw);
      if(!norm){ skipped++; return; }
      const pt = addrPoint(f.geometry);
      if(!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lng)){ skipped++; return; }
      // Locality is what lets the phone raise "⚠ pick a town" instead of
      // silently choosing between two same-named streets.
      const town = String(p['addr:city'] || p['addr:town'] || p['addr:village']
        || p['addr:hamlet'] || p['addr:place'] || '').trim();
      const dedupe = `${norm}|${num}|${town.toLowerCase()}`;
      if(seen.has(dedupe)) return;
      seen.add(dedupe);
      addresses.push({
        street: idFor(streetId, streets, norm),
        place:  idFor(placeId, places, town),
        num, lat: pt.lat, lng: pt.lng,
      });
    });
    log(`${addresses.length.toLocaleString()} addresses on ${streets.length.toLocaleString()} streets`
      + `, ${places.length.toLocaleString()} localities (${skipped.toLocaleString()} incomplete, skipped)`);
  } else {
    log('No address file given — this district will have no offline geocoding.');
  }

  const buf = encodePack({ bbox, nodes, segments, streets, places, addresses });
  if(!existsSync(mapsDir)) mkdirSync(mapsDir, { recursive: true });
  const packPath = join(mapsDir, `${id}.pack`);
  writeFileSync(packPath, buf);

  const idxPath = join(mapsDir, 'index.json');
  const index = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { districts: [] };
  if(!Array.isArray(index.districts)) index.districts = [];
  const entry = {
    id, name, file: `maps/${id}.pack`,
    bbox: { minLat: bbox.minLat, minLng: bbox.minLng, maxLat: bbox.maxLat, maxLng: bbox.maxLng },
    bytes: buf.length, nodes: nodes.length, segments: segments.length,
    addresses: addresses.length,
    builtAt: new Date().toISOString().slice(0, 10),
  };
  const at = index.districts.findIndex(d => d.id === id);
  if(at >= 0) index.districts[at] = entry; else index.districts.push(entry);
  index.districts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n');

  return { entry, packPath, indexPath: idxPath };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv){
  const out = {};
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
  }
  return out;
}

export function parseBbox(text){
  const [minLng, minLat, maxLng, maxLat] = String(text).split(',').map(Number);
  if(![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null;
  return { minLat, minLng, maxLat, maxLng };
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  const missing = ['in', 'id', 'name', 'bbox'].filter(k => !args[k]);
  if(missing.length){
    console.error(`Missing --${missing.join(', --')}\n`);
    console.error('node tools/build-roadpack.mjs --in roads.geojsonseq [--addr addr.geojsonseq] \\');
    console.error('  --id kawartha --name "Kawartha Lakes" --bbox minLng,minLat,maxLng,maxLat');
    process.exit(1);
  }
  const bbox = parseBbox(args.bbox);
  if(!bbox){ console.error('--bbox must be minLng,minLat,maxLng,maxLat'); process.exit(1); }
  const roadsFile = resolve(args.in);
  if(!existsSync(roadsFile)){ console.error('No such input: ' + roadsFile); process.exit(1); }
  const addrFile = args.addr ? resolve(args.addr) : '';
  if(addrFile && !existsSync(addrFile)){ console.error('No such address file: ' + addrFile); process.exit(1); }

  const { entry, packPath } = await buildPack({
    roadsFile, addrFile, id: args.id, name: args.name, bbox,
    mapsDir: join(REPO, 'maps'), log: m => console.log('  ' + m),
  });

  const mb = (entry.bytes / 1048576).toFixed(1);
  console.log(`\nWrote ${packPath} (${mb} MB) and updated maps/index.json`);
  if(entry.bytes > 30 * 1048576)
    console.warn('⚠ Over 30 MB — consider a tighter --bbox; this is a phone download.');
}

// Only run the CLI when invoked directly: tests and the planner's build server
// import encodePack/buildPack from here.
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if(invoked) main().catch(e => { console.error(e.message || e); process.exit(1); });
