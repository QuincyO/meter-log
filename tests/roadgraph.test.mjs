// Tests for js/roadgraph.js — the on-device road router that replaces a
// self-hosted OSRM on the phone. Everything here runs against a hand-built
// graph encoded through the REAL writer (tools/build-roadpack.mjs), so a format
// change that breaks one side breaks these tests rather than the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePack, ONEWAY_FWD, ONEWAY_REV } from '../tools/build-roadpack.mjs';
import {
  decodePack, snap, matrix, path, segmentPoints, packCovers,
  geocodeAddress, hasAddresses, normalizeStreet, splitAddress, houseNumber,
  SNAP_RADIUS_M, PACK_VERSION,
} from '../js/roadgraph.js';
import { readFileSync } from 'node:fs';

// A 2×3 lattice at latitude 44, plus an isolated pair far to the north-east.
//
//   3 ── 4 ── 5      lat 44.010
//   │    │    │
//   0 ── 1 ── 2      lat 44.000
//  -78.0 -77.99 -77.98
//
// At this latitude one lng step is ~800 m and one lat step ~1112 m.
const LNG = [-78.000, -77.990, -77.980];
const LAT = [44.000, 44.010];
const STEP_LNG_M = 799.9;
const STEP_LAT_M = 1111.9;

const NODES = [
  [LAT[0], LNG[0]], [LAT[0], LNG[1]], [LAT[0], LNG[2]],
  [LAT[1], LNG[0]], [LAT[1], LNG[1]], [LAT[1], LNG[2]],
  [44.050, -77.900], [44.050, -77.890],           // the marooned pair
];

const seg = (from, to, lengthM, opts = {}) => ({
  from, to, lengthM,
  speedKph: opts.speedKph ?? 50,
  flags: opts.flags ?? 0,
  shape: opts.shape ?? [],
});

function buildGraph({ s0Flags = 0, s0Speed = 50 } = {}){
  const segments = [
    seg(0, 1, STEP_LNG_M, { flags: s0Flags, speedKph: s0Speed }),   // s0, the one under test
    seg(1, 2, STEP_LNG_M),
    seg(3, 4, STEP_LNG_M),
    seg(4, 5, STEP_LNG_M),
    seg(0, 3, STEP_LAT_M),
    seg(1, 4, STEP_LAT_M),
    seg(2, 5, STEP_LAT_M),
    seg(6, 7, STEP_LNG_M),                                          // unreachable island
  ];
  return decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.06, maxLng: -77.88 },
    nodes: NODES, segments,
  })));
}

// Node's Buffer is a view into a larger pool; roadgraph takes typed-array views
// over the buffer it is handed, so it must get an exact-size ArrayBuffer.
function toArrayBuffer(buf){
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('decodePack round-trips the header and section counts', () => {
  const g = buildGraph();
  assert.equal(g.version, PACK_VERSION);
  assert.equal(g.nodeCount, NODES.length);
  assert.equal(g.segCount, 8);
  assert.ok(near(g.bbox.minLat, 43.99, 1e-6));
  assert.ok(near(g.bbox.maxLng, -77.88, 1e-6));
});

test('decodePack rejects a bad magic, a bad version and a truncated buffer', () => {
  const good = encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.06, maxLng: -77.88 },
    nodes: NODES, segments: [seg(0, 1, STEP_LNG_M)],
  });

  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;                                  // 'X'
  assert.throws(() => decodePack(toArrayBuffer(badMagic)), /bad magic/);

  const badVersion = Buffer.from(good);
  badVersion.writeUInt16LE(99, 4);
  assert.throws(() => decodePack(toArrayBuffer(badVersion)), /unsupported version/);

  const truncated = Buffer.from(good.subarray(0, good.length - 8));
  assert.throws(() => decodePack(toArrayBuffer(truncated)), /truncated/);

  assert.throws(() => decodePack(new ArrayBuffer(8)), /truncated header/);
});

test('segmentPoints splices the endpoints back around the stored shape', () => {
  const g = decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.02, maxLng: -77.97 },
    nodes: [NODES[0], NODES[1]],
    segments: [seg(0, 1, STEP_LNG_M, { shape: [[44.0005, -77.9950]] })],
  })));
  const pts = segmentPoints(g, 0);
  assert.equal(pts.length, 3);
  assert.ok(near(pts[0][0], 44.000, 1e-6));
  assert.ok(near(pts[1][0], 44.0005, 1e-6));   // the shape point survived
  assert.ok(near(pts[2][1], -77.990, 1e-6));
});

test('snap finds the road under a nearby point and reports the split', () => {
  const g = buildGraph();
  // ~11 m north of the midpoint of segment 0-1.
  const sn = snap(g, { lat: 44.0001, lng: -77.9950 });
  assert.ok(sn, 'expected a snap');
  assert.equal(sn.seg, 0);
  assert.ok(sn.distM < 20, `snapped ${sn.distM} m away`);
  // The two half-lengths must add back up to the segment's stored length, or
  // every matrix entry through this stop carries a small systematic bias.
  assert.ok(near(sn.toFromM + sn.toToM, STEP_LNG_M, 1.5));
  assert.ok(near(sn.toFromM, STEP_LNG_M / 2, 40));
});

test('snap returns null past the radius instead of grabbing a distant road', () => {
  const g = buildGraph();
  assert.equal(snap(g, { lat: 44.030, lng: -77.950 }), null);
  // And it honours a tighter caller-supplied radius.
  assert.equal(snap(g, { lat: 44.0001, lng: -77.9950 }, 1), null);
  assert.ok(SNAP_RADIUS_M > 100);
});

test('matrix is symmetric on an all-two-way graph and matches the lattice', () => {
  const g = buildGraph();
  const a = { lat: 44.0000, lng: -78.0000 };   // node 0
  const b = { lat: 44.0000, lng: -77.9800 };   // node 2
  const c = { lat: 44.0100, lng: -78.0000 };   // node 3
  const { D, T, snapped } = matrix(g, [a, b, c]);

  assert.deepEqual(snapped, [true, true, true]);
  assert.equal(D[0][0], 0);
  assert.equal(T[1][1], 0);
  assert.ok(near(D[0][1], 2 * STEP_LNG_M, 5), `a→b was ${D[0][1]}`);
  assert.ok(near(D[1][0], 2 * STEP_LNG_M, 5));
  assert.ok(near(D[0][2], STEP_LAT_M, 5));
  // Durations are MINUTES, from the stored km/h.
  assert.ok(near(T[0][1], (2 * STEP_LNG_M / 1000) / 50 * 60, 0.05), `T was ${T[0][1]}`);
});

test('a oneway forces the long way round and breaks the symmetry', () => {
  const twoWay = buildGraph();
  const oneWay = buildGraph({ s0Flags: ONEWAY_FWD });   // 0 → 1 only
  const a = { lat: 44.0000, lng: -78.0000 };            // node 0
  const b = { lat: 44.0000, lng: -77.9900 };            // node 1

  const free = matrix(twoWay, [a, b]).D;
  assert.ok(near(free[0][1], STEP_LNG_M, 5));
  assert.ok(near(free[1][0], STEP_LNG_M, 5), 'two-way must be symmetric');

  const { D } = matrix(oneWay, [a, b]);
  assert.ok(near(D[0][1], STEP_LNG_M, 5), `with the oneway a→b was ${D[0][1]}`);
  // Back is 1→4→3→0: up, across, down.
  const around = STEP_LAT_M + STEP_LNG_M + STEP_LAT_M;
  assert.ok(near(D[1][0], around, 10), `b→a was ${D[1][0]}, expected ~${around}`);
  assert.ok(D[1][0] > D[0][1] * 3, 'the detour should dominate');
});

test('ONEWAY_REV is honoured in the opposite direction', () => {
  const g = buildGraph({ s0Flags: ONEWAY_REV });        // 1 → 0 only
  const a = { lat: 44.0000, lng: -78.0000 };
  const b = { lat: 44.0000, lng: -77.9900 };
  const { D } = matrix(g, [a, b]);
  const around = STEP_LAT_M + STEP_LNG_M + STEP_LAT_M;
  assert.ok(near(D[0][1], around, 10), `a→b was ${D[0][1]}`);
  assert.ok(near(D[1][0], STEP_LNG_M, 5), `b→a was ${D[1][0]}`);
});

test('speed changes duration without touching distance', () => {
  const slow = matrix(buildGraph({ s0Speed: 25 }), [
    { lat: 44.0000, lng: -78.0000 }, { lat: 44.0000, lng: -77.9900 },
  ]);
  const fast = matrix(buildGraph({ s0Speed: 100 }), [
    { lat: 44.0000, lng: -78.0000 }, { lat: 44.0000, lng: -77.9900 },
  ]);
  assert.ok(near(slow.D[0][1], fast.D[0][1], 5), 'distance must not move');
  assert.ok(slow.T[0][1] > fast.T[0][1] * 3, `${slow.T[0][1]} vs ${fast.T[0][1]}`);
});

test('an unreachable stop is Infinity, and an off-network stop is flagged', () => {
  const g = buildGraph();
  const onGrid  = { lat: 44.0000, lng: -78.0000 };
  const marooned = { lat: 44.0500, lng: -77.9000 };   // the isolated pair
  const nowhere  = { lat: 44.0300, lng: -77.9500 };   // no road within 250 m

  const { D, T, snapped } = matrix(g, [onGrid, marooned, nowhere]);
  assert.deepEqual(snapped, [true, true, false]);
  assert.equal(D[0][1], Infinity, 'no road connects the island');
  assert.equal(D[1][0], Infinity);
  assert.equal(T[0][1], Infinity);
  // An off-network stop gets a fully Infinity row and column — the caller's cue
  // to price it crow-flies instead.
  assert.equal(D[0][2], Infinity);
  assert.equal(D[2][0], Infinity);
});

test('path follows the road rather than cutting across', () => {
  const g = buildGraph();
  const a = { lat: 44.0000, lng: -78.0000 };   // node 0
  const b = { lat: 44.0100, lng: -77.9800 };   // node 5
  const pts = path(g, a, b);
  assert.ok(pts.length >= 3, `expected a multi-point path, got ${pts.length}`);
  assert.ok(near(pts[0][0], a.lat, 1e-4) && near(pts[0][1], a.lng, 1e-4));
  assert.ok(near(pts.at(-1)[0], b.lat, 1e-4) && near(pts.at(-1)[1], b.lng, 1e-4));
  // An L-shaped lattice route must pass through a corner node, so at least one
  // interior point sits off the straight line between the ends.
  const offLine = pts.slice(1, -1).some(([lat, lng]) => {
    const t = (lng - a.lng) / (b.lng - a.lng);
    return Math.abs(lat - (a.lat + t * (b.lat - a.lat))) > 1e-4;
  });
  assert.ok(offLine, 'path should bend around the lattice, not run diagonally');
});

test('path keeps the shape points of the roads it uses', () => {
  const g = decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.02, maxLng: -77.97 },
    nodes: [NODES[0], NODES[1]],
    // A road that bulges 100 m north between its endpoints.
    segments: [seg(0, 1, STEP_LNG_M + 40, { shape: [[44.0009, -77.9950]] })],
  })));
  const pts = path(g, { lat: 44.0000, lng: -78.0000 }, { lat: 44.0000, lng: -77.9900 });
  assert.ok(pts.some(([lat]) => lat > 44.0005), 'the bulge should be in the drawn path');
});

test('path trims the end segments at the snapped points', () => {
  const g = buildGraph();
  // Both ends part-way along the bottom row, pointing inwards.
  const a = { lat: 44.0000, lng: -77.9975 };
  const b = { lat: 44.0000, lng: -77.9925 };
  const pts = path(g, a, b);
  const lngs = pts.map(p => p[1]);
  assert.ok(Math.min(...lngs) >= -77.9976, `path ran past the start: ${Math.min(...lngs)}`);
  assert.ok(Math.max(...lngs) <= -77.9924, `path ran past the end: ${Math.max(...lngs)}`);
});

test('path returns nothing when an end is off-network or unreachable', () => {
  const g = buildGraph();
  assert.deepEqual(path(g, { lat: 44.0, lng: -78.0 }, { lat: 44.030, lng: -77.950 }), []);
  assert.deepEqual(path(g, { lat: 44.0, lng: -78.0 }, { lat: 44.050, lng: -77.900 }), []);
});

test('packCovers gates on the pack bbox', () => {
  const g = buildGraph();
  assert.equal(packCovers(g, { lat: 44.0, lng: -78.0 }), true);
  assert.equal(packCovers(g, { lat: 45.5, lng: -78.0 }), false);
  assert.equal(packCovers(g, null), false);
  assert.equal(packCovers(null, { lat: 44, lng: -78 }), false);
});

// ── address index (pack v2) ──────────────────────────────────────────────────
// Offline geocoding was the last part of Optimize that still needed signal.
// These cover the two halves that can silently disagree: how a street name is
// normalized on each side, and how a house number is placed along a street.

test('normalizeStreet folds abbreviations without mangling leading words', () => {
  // The pairs that must collide.
  assert.equal(normalizeStreet('Main St'), normalizeStreet('Main Street'));
  assert.equal(normalizeStreet('123 Lakeshore Rd.'), normalizeStreet('123 Lakeshore Road'));
  assert.equal(normalizeStreet('Bay Ave W'), normalizeStreet('Bay Avenue West'));
  assert.equal(normalizeStreet('  county   RD  12 '), normalizeStreet('County Rd 12'));

  // …and the trap: expansion is positional, so a leading "St" (Saint) is left
  // alone. A blind word swap turns "St Andrews Rd" into "street andrews road"
  // and the address never matches what the builder stored.
  assert.equal(normalizeStreet('St Andrews Rd'), 'st andrews road');
  assert.equal(normalizeStreet('St. Andrews Road'), 'st andrews road');
  assert.notEqual(normalizeStreet('St Andrews Rd'), 'street andrews road');

  assert.equal(normalizeStreet(''), '');
  assert.equal(normalizeStreet(null), '');
});

test('splitAddress matches splitAddr in js/worklist-address-fill.js', () => {
  // The two are deliberate duplicates (roadgraph.js takes no dependencies), so
  // the regex must not drift. Compare against the real source.
  const src = readFileSync(new URL('../js/worklist-address-fill.js', import.meta.url), 'utf8');
  const m = src.match(/export function splitAddr\(address\)\{[\s\S]*?match\((\/.*?\/)\)/);
  assert.ok(m, 'could not find splitAddr in worklist-address-fill.js');
  const mine = readFileSync(new URL('../js/roadgraph.js', import.meta.url), 'utf8')
    .match(/export function splitAddress\(address\)\{[\s\S]*?match\((\/.*?\/)\)/);
  assert.equal(mine[1], m[1], 'splitAddress and splitAddr must use the same regex');

  assert.deepEqual(splitAddress('123 Main St'), { num:'123', street:'Main St' });
  assert.deepEqual(splitAddress('Main St'), { num:'', street:'Main St' });
  assert.equal(houseNumber('123A'), 123);
  assert.equal(houseNumber('123-125'), 123);
  assert.equal(houseNumber(''), 0);
});

// One street ("Main Street") in two localities, plus a sparse rural road.
function addressGraph(){
  const streets = ['main street', 'concession road 4'];
  const places  = ['Riverton', 'Hillside'];
  const addresses = [
    { street:0, place:0, num:10,  lat:44.0010, lng:-78.0000 },
    { street:0, place:0, num:20,  lat:44.0010, lng:-77.9990 },
    { street:0, place:0, num:30,  lat:44.0010, lng:-77.9980 },
    // Same street name, different town, ~9 km north — far enough to be a
    // genuine ambiguity rather than a same-town rival.
    { street:0, place:1, num:10,  lat:44.0900, lng:-78.0000 },
    { street:0, place:1, num:30,  lat:44.0900, lng:-77.9980 },
    // A rural road with a big gap between civic numbers.
    { street:1, place:0, num:400, lat:44.0500, lng:-78.0000 },
    { street:1, place:0, num:500, lat:44.0500, lng:-77.9000 },
  ];
  return decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.9, minLng: -78.1, maxLat: 44.2, maxLng: -77.8 },
    nodes: NODES, segments: [seg(0, 1, STEP_LNG_M)],
    streets, places, addresses,
  })));
}

test('a roads-only pack is valid and simply has no geocoding', () => {
  const g = buildGraph();
  assert.equal(hasAddresses(g), false);
  assert.deepEqual(geocodeAddress(g, '123 Main St'), []);
});

test('an exact house number resolves to its own point', () => {
  const g = addressGraph();
  assert.equal(hasAddresses(g), true);
  const hits = geocodeAddress(g, '20 Main St');
  const riverton = hits.find(h => h.place === 'Riverton');
  assert.ok(riverton, 'expected a Riverton hit');
  assert.ok(near(riverton.lat, 44.0010, 1e-5));
  assert.ok(near(riverton.lng, -77.9990, 1e-5));
  assert.equal(riverton.exact, true);
});

test('a missing house number interpolates between its neighbours', () => {
  const g = addressGraph();
  // 450 sits halfway between 400 and 500 — the point should land mid-road, not
  // at either end. This is what makes sparse rural concessions usable.
  const hits = geocodeAddress(g, '450 Concession Rd 4');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].exact, false);
  assert.ok(near(hits[0].lng, -77.9500, 1e-3), `interpolated to ${hits[0].lng}`);
});

test('a number past both ends clamps to the nearest known point', () => {
  const g = addressGraph();
  const low  = geocodeAddress(g, '2 Concession Rd 4')[0];
  const high = geocodeAddress(g, '900 Concession Rd 4')[0];
  assert.ok(near(low.lng, -78.0000, 1e-4));
  assert.ok(near(high.lng, -77.9000, 1e-4));
  assert.equal(low.exact, false);
});

test('the same street in two towns returns both, so the caller can flag it', () => {
  const g = addressGraph();
  const hits = geocodeAddress(g, '10 Main St');
  assert.equal(hits.length, 2, 'both localities must come back');
  const towns = hits.map(h => h.place).sort();
  assert.deepEqual(towns, ['Hillside', 'Riverton']);
  // Distinct places far apart is exactly what route.js's pickBest turns into
  // the "⚠ pick a town" ambiguity rather than guessing.
  assert.ok(Math.abs(hits[0].lat - hits[1].lat) > 0.05);
});

// One road that crosses a municipal line, modelled on the field report of
// 2026-11-18 (Falconbridge Dr): civic numbers run on unbroken, 100-300 tagged
// Southtown and 301-400 tagged Northtown, and the road itself carries on 400 m
// past the last address point. Points sit ~22 m north of the centreline.
function boundaryGraph(){
  const pt = (place, num, lng) => ({ street:0, place, num, lat:44.0002, lng });
  return decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.06, maxLng: -77.88 },
    nodes: NODES,
    segments: [
      { ...seg(0, 1, STEP_LNG_M), nameId: 1 },
      { ...seg(1, 2, STEP_LNG_M), nameId: 1 },
      { ...seg(1, 4, STEP_LAT_M), nameId: 2 },
    ],
    roadNames: ['', 'Line Road', 'Cross Street'],
    streets: ['line road'], places: ['Southtown', 'Northtown'],
    addresses: [
      pt(0, 100, -78.0000), pt(0, 200, -77.9950), pt(0, 300, -77.9900),
      pt(1, 301, -77.9899), pt(1, 400, -77.9850),
    ],
  })));
}

test('a town whose numbers stop short of the typed one is not a candidate', () => {
  const g = boundaryGraph();
  // 350 lies between Northtown's 301 and 400. Southtown's numbers end at 300,
  // and it used to come back anyway, clamped to its last point — which both
  // raised a "pick a town" prompt that had one right answer and put every
  // higher number on that single point when Southtown was picked.
  const hits = geocodeAddress(g, '350 Line Rd');
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].place, 'Northtown');
  assert.ok(near(hits[0].lng, -77.9875, 2e-4), `interpolated to ${hits[0].lng}`);
});

test('an estimated pin sits on the named road, not beside it', () => {
  const g = boundaryGraph();
  const hit = geocodeAddress(g, '350 Line Rd')[0];
  assert.ok(near(hit.lat, 44.0000, 2e-5), `lat ${hit.lat} should be the centreline`);
  // A real address point is the house itself and stays where it is.
  const exact = geocodeAddress(g, '200 Line Rd')[0];
  assert.equal(exact.exact, true);
  assert.ok(near(exact.lat, 44.0002, 1e-6));
});

test('a town on the end of the address is read, and cannot pull the pin off the number', () => {
  const g = boundaryGraph();
  // "…, Southtown" is the exact text a town pick writes back onto the order, so
  // the geocoder has to be able to read its own label. Southtown and Northtown
  // are one road here: the town narrows WHICH road, the number places the pin.
  const a = geocodeAddress(g, '320 Line Rd, Southtown');
  const b = geocodeAddress(g, '380 Line Rd, Southtown');
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.ok(a[0].lng > -77.9899 && a[0].lng < b[0].lng && b[0].lng < -77.9850,
    `320 → ${a[0].lng}, 380 → ${b[0].lng}`);
  // Typed without the comma, and a town the map has never heard of.
  assert.equal(geocodeAddress(g, '350 Line Rd Southtown').length, 1);
  assert.ok(near(geocodeAddress(g, '350 Line Rd, Elsewhere')[0].lng, -77.9875, 2e-4));
});

test('numbers past the last known one run on along the road, each to its own pin', () => {
  const g = boundaryGraph();
  // 301→400 covers ~392 m, so ~4 m a number: 450 is ~200 m past 400 and 470
  // ~280 m. Both used to land on the 400 point.
  const a = geocodeAddress(g, '450 Line Rd')[0];
  const b = geocodeAddress(g, '470 Line Rd')[0];
  assert.ok(near(a.lng, -77.9825, 3e-4), `450 → ${a.lng}`);
  assert.ok(near(b.lng, -77.9815, 3e-4), `470 → ${b.lng}`);
  assert.ok(near(a.lat, 44.0000, 2e-5) && near(b.lat, 44.0000, 2e-5), 'on the centreline');
  // Past the end of the road itself there is nothing to stand on: fall back to
  // the last known point rather than a pin in a field.
  const far = geocodeAddress(g, '900 Line Rd')[0];
  assert.ok(near(far.lng, -77.9850, 1e-6), `900 → ${far.lng}`);
});

test('a typed town chooses between two separate streets of the same name', () => {
  const g = addressGraph();
  // No number 50 on either Main Street: still a genuine tie, still both.
  assert.equal(geocodeAddress(g, '50 Main St').length, 2);
  const hits = geocodeAddress(g, '50 Main St, Hillside');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].place, 'Hillside');
  assert.ok(near(hits[0].lat, 44.0900, 1e-5));
});

test('an estimate stretched between two far-apart points is not a candidate', () => {
  // Two separate "Mill Road"s that share one town tag, 20 km apart: 10-30 on
  // one, 70-90 on the other. Number 50 is "between" 30 and 70 only on paper —
  // halfway is a field 10 km from either road.
  const pt = (place, num, lat) => ({ street:0, place, num, lat, lng:-78.0000 });
  const g = decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.9, minLng: -78.1, maxLat: 44.3, maxLng: -77.8 },
    // The road names are what expose it: Mill Road exists by the first pair
    // and nowhere near the halfway point.
    nodes: NODES, segments: [{ ...seg(0, 3, STEP_LAT_M), nameId: 1 }],
    roadNames: ['', 'Mill Road'],
    streets: ['mill road'], places: ['Bigcounty', 'Smalltown'],
    addresses: [
      pt(0, 10, 44.0000), pt(0, 30, 44.0010), pt(0, 70, 44.1800), pt(0, 90, 44.1810),
      pt(1, 40, 44.2500), pt(1, 60, 44.2510),
    ],
  })));
  // Smalltown really does bracket 50, so it is the only candidate left.
  const hits = geocodeAddress(g, '50 Mill Rd');
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.equal(hits[0].place, 'Smalltown');
  // With nothing better on offer the far-apart pair still answers, at the
  // nearer of its two points rather than between them.
  const lone = geocodeAddress(g, '45 Mill Rd, Bigcounty');
  assert.equal(lone.length, 1);
  assert.ok(near(lone[0].lat, 44.0010, 1e-5), `45 → ${lone[0].lat}`);
});

// Field report 2026-11-23: six orders typed "… York St, Delaware, ON N0L 1E0"
// were pinned on York St in London. York St's own points in Delaware carry the
// municipality ("Middlesex Centre"), so no York St was tagged Delaware and the
// typed town was dropped. The map did know Delaware, from the streets around it.
function villageGraph(){
  const pt = (street, place, num, lat, lng) => ({ street, place, num, lat, lng });
  return decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.9, minLng: -78.1, maxLat: 44.4, maxLng: -77.8 },
    nodes: NODES, segments: [seg(0, 1, STEP_LNG_M)],
    streets: ['york street', 'mill lane'],
    places: ['Bigcity', 'Rural Township', 'Hamlet', 'Farcorner'],
    addresses: [
      // York St in the city, ~16 km north of the village.
      pt(0, 0, 2, 44.1500, -78.0000), pt(0, 0, 20, 44.1500, -77.9990), pt(0, 0, 40, 44.1500, -77.9980),
      // York St in the village, tagged with the municipality the village is in.
      pt(0, 1, 4, 44.0010, -78.0000), pt(0, 1, 20, 44.0010, -77.9990), pt(0, 1, 46, 44.0010, -77.9980),
      // The next street over is where the map learned the village's name.
      pt(1, 2, 1, 44.0020, -78.0000), pt(1, 2, 3, 44.0020, -77.9995),
      // A town the map knows, a long way from every York St.
      pt(1, 3, 1, 44.3000, -78.0000), pt(1, 3, 3, 44.3000, -77.9995),
    ],
  })));
}

test('a typed town the street is not tagged with still picks the road beside that town', () => {
  const g = villageGraph();
  assert.equal(geocodeAddress(g, '10 York St').length, 2, 'no town typed: a real tie');
  for(const typed of ['10 York St, Hamlet, ON N0L 1E0', '10 York St, Hamlet', '10 York St Hamlet']){
    const hits = geocodeAddress(g, typed);
    assert.equal(hits.length, 1, `${typed} → ${JSON.stringify(hits)}`);
    assert.equal(hits[0].place, 'Rural Township');
    assert.ok(near(hits[0].lat, 44.0010, 1e-5), `${typed} → lat ${hits[0].lat}`);
  }
  // A tag on the street itself is still the first thing asked.
  const city = geocodeAddress(g, '10 York St, Bigcity');
  assert.equal(city.length, 1);
  assert.equal(city[0].place, 'Bigcity');
});

test('a typed town nowhere near the street is ignored, as an unknown one is', () => {
  const g = villageGraph();
  assert.equal(geocodeAddress(g, '10 York St, Farcorner').length, 2);
  assert.equal(geocodeAddress(g, '10 York St, Nowhereville').length, 2);
});

test('an unknown street misses cleanly so the network providers still run', () => {
  const g = addressGraph();
  assert.deepEqual(geocodeAddress(g, '5 Nowhere Lane'), []);
  assert.deepEqual(geocodeAddress(g, ''), []);
});

test('abbreviated input matches the normalized name the builder stored', () => {
  const g = addressGraph();
  // Stored as "main street"; the installer types any of these.
  for(const typed of ['20 Main St', '20 main st.', '20 MAIN STREET']){
    const hit = geocodeAddress(g, typed).find(h => h.place === 'Riverton');
    assert.ok(hit && hit.exact, `"${typed}" should have matched`);
  }
});

test('street/place dictionaries and address points survive the round trip', () => {
  const g = addressGraph();
  assert.equal(g.streetCount, 2);
  assert.equal(g.placeCount, 2);
  assert.equal(g.addrCount, 7);
  assert.deepEqual([...g.streetNames], ['main street', 'concession road 4']);
  // streetOff must span the whole address array, or a street's run is truncated.
  assert.equal(g.streetOff[0], 0);
  assert.equal(g.streetOff[g.streetCount], g.addrCount);
});
