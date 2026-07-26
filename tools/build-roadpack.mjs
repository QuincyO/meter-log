#!/usr/bin/env node
// ── Build a district road pack for offline routing on the phone ──────────────
// Turns an OSM road extract into the compact binary js/roadgraph.js routes on.
// Plain Node, no dependencies — this repo has no package manager (AGENTS.md).
//
// INPUT is GeoJSON-seq (one Feature per line) of road ways, which osmium
// produces from the same Ontario .pbf already downloaded for OSRM. One line per
// feature is what lets this stream a multi-hundred-MB district without ever
// holding it in memory. See DEPLOY.md for the three docker commands.
//
// USAGE
//   node tools/build-roadpack.mjs \
//     --in D:/osrm/district-roads.geojsonseq \
//     --id kawartha --name "Kawartha Lakes" \
//     --bbox -79.4,44.2,-78.0,45.0            # minLng,minLat,maxLng,maxLat
//
// Writes maps/<id>.pack and updates maps/index.json.
//
// WHY TWO STREAMING PASSES: junctions are found by coordinate, so we must know
// how many ways touch each coordinate before we can decide where to split. Pass
// one counts, pass two emits. Holding the file in memory instead would be
// simpler and would also fall over on a real district.
import { createReadStream, createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ── format constants (must match js/roadgraph.js) ────────────────────────────
export const PACK_MAGIC   = 'MLRP';
export const PACK_VERSION = 1;
export const HEADER_BYTES = 64;
export const COORD_SCALE  = 1e6;
export const ONEWAY_FWD = 1;
export const ONEWAY_REV = 2;

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
// Anything not in SPEEDS is not drivable and never enters the graph.
const drivable = hw => Object.prototype.hasOwnProperty.call(SPEEDS, hw);

function parseMaxspeed(raw){
  if(!raw) return 0;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/);
  if(!m) return 0;                       // "walk", "none", "RU:urban" → use the class default
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
  // Roundabouts are implicitly one-way when untagged.
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
//     segments:[{ from, to, lengthM, speedKph, flags, shape:[[lat,lng], …] }, …] }
// Keeping the encoder here (rather than duplicating a fixture writer in the
// test) is what guarantees the tests exercise the real format.
function align4(n){ return (n + 3) & ~3; }

export function encodePack(graph){
  const nodes = graph.nodes, segs = graph.segments;
  const nodeCount = nodes.length, segCount = segs.length;
  const shapeCount = segs.reduce((n, s) => n + (s.shape ? s.shape.length : 0), 0);

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
  view.setUint32(24, nodeCount,  true);
  view.setUint32(28, segCount,   true);
  view.setUint32(32, shapeCount, true);

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
  return Buffer.from(buf);
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

async function eachFeature(file, fn){
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let bad = 0;
  for await (const line of rl){
    const s = line.trim();
    if(!s || s === ',' || s === '[' || s === ']') continue;
    // geojsonseq may prefix records with RS (0x1e).
    const clean = s.charCodeAt(0) === 0x1e ? s.slice(1) : s;
    let f;
    try { f = JSON.parse(clean.replace(/,$/, '')); } catch { bad++; continue; }
    if(f && f.geometry && f.geometry.type === 'LineString') fn(f);
  }
  if(bad) console.warn(`  (${bad} unparseable lines skipped)`);
}

function usableWay(f){
  const props = f.properties || {};
  const hw = String(props.highway ?? '').toLowerCase();
  if(!drivable(hw) || blocked(props)) return null;
  const coords = f.geometry.coordinates;
  if(!Array.isArray(coords) || coords.length < 2) return null;
  return { props, hw, coords };
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  const need = ['in', 'id', 'name', 'bbox'];
  const missing = need.filter(k => !args[k]);
  if(missing.length){
    console.error(`Missing --${missing.join(', --')}\n`);
    console.error('node tools/build-roadpack.mjs --in roads.geojsonseq --id kawartha \\');
    console.error('  --name "Kawartha Lakes" --bbox minLng,minLat,maxLng,maxLat');
    process.exit(1);
  }
  const [minLng, minLat, maxLng, maxLat] = String(args.bbox).split(',').map(Number);
  if(![minLng, minLat, maxLng, maxLat].every(Number.isFinite)){
    console.error('--bbox must be minLng,minLat,maxLng,maxLat'); process.exit(1);
  }
  const bbox = { minLat, minLng, maxLat, maxLng };
  const key = makeKeyer(bbox);
  const inFile = resolve(args.in);
  if(!existsSync(inFile)){ console.error('No such input: ' + inFile); process.exit(1); }

  // ── pass 1: how many ways touch each coordinate ────────────────────────────
  console.log('Pass 1/2 — finding junctions…');
  const uses = new Map();
  let ways = 0;
  await eachFeature(inFile, f => {
    const w = usableWay(f);
    if(!w) return;
    ways++;
    for(let i = 0; i < w.coords.length; i++){
      const k = key(w.coords[i][1], w.coords[i][0]);
      // Way ends are always nodes; interior coords only if shared.
      const bump = (i === 0 || i === w.coords.length - 1) ? 2 : 1;
      uses.set(k, (uses.get(k) || 0) + bump);
    }
  });
  console.log(`  ${ways.toLocaleString()} drivable ways, ${uses.size.toLocaleString()} distinct coordinates`);

  // ── pass 2: split ways at junctions, collapse the rest into segments ───────
  console.log('Pass 2/2 — building segments…');
  const nodeId = new Map();
  const nodes = [];
  const segments = [];
  const nodeFor = (lat, lng, k) => {
    let id = nodeId.get(k);
    if(id === undefined){ id = nodes.length; nodeId.set(k, id); nodes.push([lat, lng]); }
    return id;
  };
  await eachFeature(inFile, f => {
    const w = usableWay(f);
    if(!w) return;
    const speedKph = parseMaxspeed(w.props.maxspeed) || SPEEDS[w.hw];
    const flags = onewayFlags(w.props);
    let startIdx = 0;
    let shape = [];
    let lengthM = 0;
    let fromNode = null;
    for(let i = 0; i < w.coords.length; i++){
      const lng = w.coords[i][0], lat = w.coords[i][1];
      const k = key(lat, lng);
      const isNode = (uses.get(k) || 0) > 1;
      if(i === 0){ fromNode = nodeFor(lat, lng, k); startIdx = 0; continue; }
      const prev = w.coords[i - 1];
      lengthM += metresBetween(prev[1], prev[0], lat, lng);
      if(isNode || i === w.coords.length - 1){
        const to = nodeFor(lat, lng, k);
        // A way that loops back on itself produces a zero-length stub; drop it
        // rather than seeding the graph with a self-edge.
        if(to !== fromNode && lengthM > 0)
          segments.push({ from: fromNode, to, lengthM, speedKph, flags, shape });
        fromNode = to; shape = []; lengthM = 0; startIdx = i;
      } else {
        shape.push([lat, lng]);
      }
    }
    void startIdx;
  });
  console.log(`  ${nodes.length.toLocaleString()} nodes, ${segments.length.toLocaleString()} segments`);
  if(!segments.length){ console.error('No drivable segments found — wrong input file?'); process.exit(1); }

  const buf = encodePack({ bbox, nodes, segments });
  const mapsDir = join(REPO, 'maps');
  if(!existsSync(mapsDir)) mkdirSync(mapsDir, { recursive: true });
  const packPath = join(mapsDir, `${args.id}.pack`);
  writeFileSync(packPath, buf);

  const idxPath = join(mapsDir, 'index.json');
  const index = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : { districts: [] };
  const entry = {
    id: args.id, name: args.name, file: `maps/${args.id}.pack`,
    bbox: { minLat, minLng, maxLat, maxLng },
    bytes: buf.length, nodes: nodes.length, segments: segments.length,
    builtAt: new Date().toISOString().slice(0, 10),
  };
  const at = index.districts.findIndex(d => d.id === args.id);
  if(at >= 0) index.districts[at] = entry; else index.districts.push(entry);
  index.districts.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n');

  const mb = (buf.length / 1048576).toFixed(1);
  console.log(`\nWrote ${packPath} (${mb} MB) and updated maps/index.json`);
  if(buf.length > 30 * 1048576)
    console.warn('⚠ Over 30 MB — consider a tighter --bbox; this is a phone download.');
}

// Only run the CLI when invoked directly: tests import encodePack from here.
const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if(invoked) main().catch(e => { console.error(e); process.exit(1); });
