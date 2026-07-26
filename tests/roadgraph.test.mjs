// Tests for js/roadgraph.js — the on-device road router that replaces a
// self-hosted OSRM on the phone. Everything here runs against a hand-built
// graph encoded through the REAL writer (tools/build-roadpack.mjs), so a format
// change that breaks one side breaks these tests rather than the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePack, ONEWAY_FWD, ONEWAY_REV } from '../tools/build-roadpack.mjs';
import {
  decodePack, snap, matrix, path, segmentPoints, packCovers,
  SNAP_RADIUS_M, PACK_VERSION,
} from '../js/roadgraph.js';

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
