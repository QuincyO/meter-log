import test from 'node:test';
import assert from 'node:assert/strict';
import { legMetersFor, optimizeRoute, routeOrderFromMatrix, solveAnchoredPath, decodePolyline, osrmLegGeometry } from '../js/route.js';

function matrix(rows){
  return rows.map(row => Float64Array.from(row));
}

test('anchored route keeps the requested start and end nodes fixed', () => {
  const D = matrix([
    [0, 1, 2, 0.5],
    [1, 0, 1, 10],
    [2, 1, 0, 1],
    [0.5, 10, 1, 0]
  ]);

  assert.deepEqual(solveAnchoredPath(D, { pinEnd:true }), [0, 1, 2, 3]);
});

test('start-only route keeps the requested start and leaves the end open', () => {
  const D = matrix([
    [0, 5, 1, 4],
    [5, 0, 2, 1],
    [1, 2, 0, 3],
    [4, 1, 3, 0]
  ]);

  const route = solveAnchoredPath(D);
  assert.equal(route[0], 0);
  assert.deepEqual(route.slice().sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('here-to-home route strips both anchors from the work-order sequence', () => {
  const D = matrix([
    [0, 1, 2, 0.5],
    [1, 0, 1, 10],
    [2, 1, 0, 1],
    [0.5, 10, 1, 0]
  ]);

  assert.deepEqual(routeOrderFromMatrix(D, 2, { hasStart:true, hasHome:true }), [0, 1]);
});

test('legacy home mode still orders meters from the far side toward home', () => {
  const D = matrix([
    [0, 1, 5],
    [1, 0, 4],
    [5, 4, 0]
  ]);

  assert.deepEqual(routeOrderFromMatrix(D, 2, { hasHome:true }), [1, 0]);
});

// ── per-stop distance ───────────────────────────────────────────────────────

test('each day first stop is charged the drive out from home', () => {
  // node 0 = home, nodes 1..3 = the orders.
  const measure = {
    D: matrix([
      [0, 10, 20, 30],
      [10, 0, 4, 9],
      [20, 4, 0, 5],
      [30, 9, 5, 0]
    ]),
    indexById: { a:1, b:2, c:3 }, homeIndex: 0, startIndex: null
  };
  const legs = legMetersFor(measure, ['a', 'b', 'c'], { a:1, b:1, c:2 });
  assert.equal(legs.a, 10);   // home → a, first stop of day 1
  assert.equal(legs.b, 4);    // a → b, same day
  assert.equal(legs.c, 30);   // home → c, day 2 starts from home again
});

test('with no home anchor the first stop costs nothing and the rest chain', () => {
  const measure = {
    D: matrix([[0, 7], [7, 0]]),
    indexById: { a:0, b:1 }, homeIndex: null, startIndex: null
  };
  assert.deepEqual(legMetersFor(measure, ['a', 'b'], {}), { a:0, b:7 });
});

test('a parked order with no matrix node is skipped, not charged zero', () => {
  const measure = {
    D: matrix([[0, 7], [7, 0]]),
    indexById: { a:0, b:1 }, homeIndex: null, startIndex: null
  };
  const legs = legMetersFor(measure, ['a', 'parked', 'b'], {});
  assert.equal('parked' in legs, false);
  assert.equal(legs.b, 7);
});

// ── road vs straight-line variants ──────────────────────────────────────────
// Four stops in a line west of each other, so the crow-flies order is
// a,b,c,d — but the road matrix below makes a→b a 100 km detour, so the road
// order is a,c,b,d. Exactly the disagreement the two saved routes exist to show.
const STOPS = () => [
  { id:'a', address:'A', lat:45.0, lng:-79.0 },
  { id:'b', address:'B', lat:45.0, lng:-79.1 },
  { id:'c', address:'C', lat:45.0, lng:-79.2 },
  { id:'d', address:'D', lat:45.0, lng:-79.3 },
];
const ROAD = [
  [0, 100000, 1000, 50000],
  [100000, 0, 1000, 1000],
  [1000, 1000, 0, 50000],
  [50000, 1000, 50000, 0],
];

function withOsrm(distances, run){
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok:true, json: async () => ({ code:'Ok', distances }) };
  };
  return run(() => calls).finally(() => { globalThis.fetch = before; });
}

test('a road-matrix run saves both routes, priced on the same road matrix', async () => {
  await withOsrm(ROAD, async calls => {
    const r = await optimizeRoute(STOPS(), null, null,
      { osrmUrl:'http://localhost:5000', osrmReady:true, compareVariants:true });

    assert.deepEqual(r.variants.road.orderedIds, ['a', 'c', 'b', 'd']);
    assert.deepEqual(r.variants.straight.orderedIds, ['a', 'b', 'c', 'd']);
    assert.equal(r.orderedIds.join(), r.variants.road.orderedIds.join());  // primary
    assert.equal(r.straightDistanceSource, 'road');
    assert.equal(calls(), 1, 'the second route must not cost a second matrix call');

    // Both sequences priced with the SAME road matrix — the comparison the
    // office actually needs, rather than road km against crow-flies km.
    const road = legMetersFor(r.measure, r.variants.road.orderedIds, r.variants.road.dayOf);
    const straight = legMetersFor(r.measure, r.variants.straight.orderedIds, r.variants.straight.dayOf);
    const total = legs => Object.values(legs).reduce((a, b) => a + b, 0);
    assert.equal(total(road), 3000);        // a→c→b→d, all 1 km hops
    assert.equal(total(straight), 151000);  // a→b is 100 km and c→d another 50
  });
});

test('a straight-line run does one solve and saves no road route', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network call expected'); };
  try {
    const r = await optimizeRoute(STOPS(), null, null, { straightLine:true, compareVariants:true });
    assert.equal(r.variants.road, null);
    assert.deepEqual(r.variants.straight.orderedIds, ['a', 'b', 'c', 'd']);
    assert.equal(r.straightDistanceSource, 'straight-line');
    assert.equal(r.usedFallback, false);
  } finally { globalThis.fetch = before; }
});

test('a road run whose matrix fails leaves no road route to compare', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:false, status:503, json: async () => null });
  try {
    const r = await optimizeRoute(STOPS(), null, null,
      { osrmUrl:'http://localhost:5000', osrmReady:true, compareVariants:true });
    assert.equal(r.usedFallback, true);
    assert.equal(r.variants.road, null);
    assert.ok(r.variants.straight);
    assert.equal(r.straightDistanceSource, 'straight-line');
  } finally { globalThis.fetch = before; }
});

// ── OSRM directions geometry (per-leg road path) ─────────────────────────────

test('decodePolyline recovers the canonical Google polyline points', () => {
  // The example from Google's polyline algorithm docs.
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  const round = ([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
  assert.deepEqual(pts.map(round), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('decodePolyline returns an empty array for a blank string', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.deepEqual(decodePolyline(null), []);
});

test('osrmLegGeometry returns the encoded route geometry on success', async () => {
  const before = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = async url => {
    calledUrl = url;
    return { ok:true, json: async () => ({ code:'Ok', routes:[{ geometry:'abc123' }] }) };
  };
  try {
    const g = await osrmLegGeometry({ lat:45.0, lng:-79.0 }, { lat:45.1, lng:-79.2 }, 'http://localhost:5000');
    assert.equal(g, 'abc123');
    // lng,lat order (OSRM's GeoJSON convention), against the /route service.
    assert.match(calledUrl, /\/route\/v1\/driving\/-79,45;-79\.2,45\.1\?/);
  } finally { globalThis.fetch = before; }
});

test('osrmLegGeometry returns empty string when OSRM has no route', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:true, json: async () => ({ code:'NoRoute', routes:[] }) });
  try {
    const g = await osrmLegGeometry({ lat:45, lng:-79 }, { lat:46, lng:-80 }, 'http://localhost:5000');
    assert.equal(g, '');
  } finally { globalThis.fetch = before; }
});

test('osrmLegGeometry returns empty string when an endpoint has no coords', async () => {
  const before = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok:true, json: async () => ({}) }; };
  try {
    const g = await osrmLegGeometry({ lat:'', lng:'' }, { lat:46, lng:-80 }, 'http://localhost:5000');
    assert.equal(g, '');
    assert.equal(called, false, 'a missing coord must short-circuit before the fetch');
  } finally { globalThis.fetch = before; }
});
