import test from 'node:test';
import assert from 'node:assert/strict';
import { legMetersFor, homeLegMetersFor, travelLookup, optimizeRoute, routeOrderFromMatrix, solveAnchoredPath, solveVariant, decodePolyline, osrmLegGeometry } from '../js/route.js';

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

// ── weighted home bias (commutePull) ────────────────────────────────────────
// A one-day chunk of four stops on a line (s1..s4) with home far beyond s4.
// Node 0 = home; nodes 1..4 = the stops. Ending "near home" means ending at s4.
const HOME_CHUNK = matrix([
  [0, 8, 7, 6, 5],
  [8, 0, 1, 2, 3],
  [7, 1, 0, 1, 2],
  [6, 2, 1, 0, 1],
  [5, 3, 2, 1, 0]
]);
const HOME_LOCATED = [{ id:'s1' }, { id:'s2' }, { id:'s3' }, { id:'s4' }];
const homeShape = extra => ({ startC:null, homeC:{ lat:0, lng:0 }, target:4, ...extra });

test('full commute pull ends the day at the stop nearest home', () => {
  const r = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.equal(r.orderedIds[r.orderedIds.length - 1], 's4');
});

test('zero commute pull drops the homeward endpoint constraint', () => {
  const pull0 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:0 }));
  const pull100 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.notDeepEqual(pull0.orderedIds, pull100.orderedIds);
});

test('an absent commute pull reproduces the full-home-pin behavior', () => {
  const def = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape());
  const pull100 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.deepEqual(def.orderedIds, pull100.orderedIds);
});

// ── per-stop distance ───────────────────────────────────────────────────────

// node 0 = home, nodes 1..3 = the orders.
const HOME_MEASURE = {
  D: matrix([
    [0, 10, 20, 30],
    [10, 0, 4, 9],
    [20, 4, 0, 5],
    [30, 9, 5, 0]
  ]),
  indexById: { a:1, b:2, c:3 }, homeIndex: 0, startIndex: null
};

test('a day first stop is NOT charged to the day total', () => {
  // Each day's first stop is a drive-out, kept out of the driving total, so it
  // costs 0 here regardless of the anchor.
  const legs = legMetersFor(HOME_MEASURE, ['a', 'b', 'c'], { a:1, b:1, c:2 });
  assert.equal(legs.a, 0);    // day 1 first stop excluded
  assert.equal(legs.b, 4);    // a → b, same day — still charged
  assert.equal(legs.c, 0);    // day 2 first stop excluded
});

test('home is the end-of-day bias only — never recorded as a drive-out', () => {
  // Home biases where the route ENDS; it is not a starting location, so no per-day
  // "distance out" is recorded from it. Only a crew start anchors the drive-out.
  const home = homeLegMetersFor(HOME_MEASURE, ['a', 'b', 'c'], { a:1, b:1, c:2 });
  assert.deepEqual(home, {});
});

test('homeLegMetersFor is empty with no anchor', () => {
  const measure = {
    D: matrix([[0, 7], [7, 0]]),
    indexById: { a:0, b:1 }, homeIndex: null, startIndex: null
  };
  assert.deepEqual(homeLegMetersFor(measure, ['a', 'b'], {}), {});
});

// node 0 = the team muster point, nodes 1..2 = orders, node 3 = the installer's
// home. startIsCommute: the crew leaves the muster point EVERY morning, so each
// day's first-stop drive-out comes from node 0, stays out of the between-total, and
// is saved per day (mirrors home semantics but for the shared start).
const TEAM_MEASURE = {
  D: matrix([
    [0, 10, 20, 99],   // team start
    [10, 0, 4, 7],     // a
    [20, 4, 0, 5],     // b
    [99, 7, 5, 0]      // home
  ]),
  indexById: { a:1, b:2 }, startIndex:0, homeIndex:3, startIsCommute:true
};

test('the team muster drive-out is excluded from the day total, every day', () => {
  const legs = legMetersFor(TEAM_MEASURE, ['a', 'b'], { a:1, b:2 });
  assert.equal(legs.a, 0);   // team → a excluded (day 1 drive-out)
  assert.equal(legs.b, 0);   // team → b excluded (day 2 drive-out)
});

test('the team muster drive-out is saved per day from the start anchor', () => {
  const home = homeLegMetersFor(TEAM_MEASURE, ['a', 'b'], { a:1, b:2 });
  assert.deepEqual(home, { a:10, b:20 });   // team→a, team→b
});

test('within a day, between-stop legs are still charged with a team start', () => {
  const legs = legMetersFor(TEAM_MEASURE, ['a', 'b'], { a:1, b:1 });
  assert.equal(legs.a, 0);   // day 1 drive-out from the muster point
  assert.equal(legs.b, 4);   // a → b, same day
});

const T_MEASURE = {
  T: matrix([
    [0, 15, 30, 99],
    [15, 0, 10, 7],
    [30, 10, 0, 5],
    [99, 7, 5, 0]
  ]),
  indexById: { a:1, b:2 }, startIndex:0, homeIndex:3
};

test('travelLookup reads drive times from the start anchor and between stops', () => {
  const t = travelLookup(T_MEASURE);
  assert.equal(t.fromStart('a'), 15);
  assert.equal(t.between('a', 'b'), 10);
  assert.equal(t.between('b', 'a'), 10);
});

test('travelLookup is null without a duration matrix', () => {
  assert.equal(travelLookup({ D: matrix([[0, 1], [1, 0]]), indexById:{ a:0, b:1 } }), null);
});

test('a phone start-from-here first leg is charged, and no drive-out is saved', () => {
  // node 0 = home (end anchor), node 3 = the phone fix (start). The very first stop
  // is driven from the fix — a real leg in the total. Home is the end-of-day bias
  // only, so later days' first stops are still excluded from the total but NOT
  // recorded as a drive-out (only a crew start would record one).
  const measure = {
    D: matrix([
      [0, 10, 20, 5],     // home
      [10, 0, 4, 8],      // a
      [20, 4, 0, 6],      // b
      [5, 8, 6, 0]        // start fix
    ]),
    indexById: { a:1, b:2 }, homeIndex: 0, startIndex: 3
  };
  const legs = legMetersFor(measure, ['a', 'b'], { a:1, b:2 });
  assert.equal(legs.a, 8);    // fix → a, charged (start-from-here is a real leg)
  assert.equal(legs.b, 0);    // day 2 first stop excluded from the total
  const home = homeLegMetersFor(measure, ['a', 'b'], { a:1, b:2 });
  assert.deepEqual(home, {});   // home is end-bias only — no drive-out recorded from it
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

test('an OSRM run captures durations, marks the team start a commute, and time-sizes the day', async () => {
  // 6 nodes: [teamStart, a, b, c, d, home]. Distances grow with index gap;
  // durations are those metres at ~2 min/km (osrmMatrix divides seconds by 60).
  const dist6 = Array.from({ length:6 }, (_, i) => Array.from({ length:6 }, (_, j) => i === j ? 0 : 1000 * Math.abs(i - j)));
  const dur6 = dist6.map(row => row.map(v => v / 1000 * 120));   // seconds
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:true, json: async () => ({ code:'Ok', distances:dist6, durations:dur6 }) });
  try {
    const r = await optimizeRoute(STOPS(), null, { lat:45.0, lng:-79.35 }, {
      osrmUrl:'http://localhost:5000', osrmReady:true, compareVariants:true,
      start:{ lat:45.0, lng:-78.95 },
      target:3, dayFinishBy:14 * 60, departMin:8 * 60, breakMin:60, paceMin:30,
    });
    assert.ok(r.measure.T, 'durations are captured into measure.T');
    assert.equal(r.measure.startIsCommute, true, 'the team start is a commute anchor');
    const t = travelLookup(r.measure);
    assert.ok(t && typeof t.fromStart === 'function', 'travelLookup is available on a duration run');
    assert.ok(r.dayTarget >= 1 && r.dayTarget <= 3, 'the day is sized within the target');
  } finally { globalThis.fetch = before; }
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
