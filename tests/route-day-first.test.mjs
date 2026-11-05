// Day 1 is picked FIRST: the `target` stops that finish soonest from where the crew
// starts (drive + on-site), then days 2+ are planned from what is left, each leaving
// the morning meet. Before this the solver built one long path through every stop,
// cut it every `target` into days and re-ordered inside each — so a day's quality was
// an accident of where the cuts fell (field report 2026-11-05: Day 1 wandered side
// streets while Day 2 was one tidy street), and the morning meet never shaped the
// order at all (it was "ETA-only"). Commute pull also had no 0: the master path
// headed to Home at full strength whatever the dial said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveVariant, travelLookup, homeLegMetersFor, legMetersFor, optimizeRoute } from '../js/route.js';
import { scheduleRouteConstraints } from '../js/route-constraints.js';

// Planar points in metres. The meet is the origin; cluster A is a short street 1 km
// east running north from the x-axis; street B is 6 km east; Home is due south of
// A's near end. The old furthest-from-Home rule put B on Day 1. The crew starts at
// the meet, so A finishes soonest and must be Day 1.
const HOME = [1000, -1000], MEET = [0, 0];
const P = {};
for(let i = 1; i <= 6; i++) P['a' + i] = [1000, (i - 1) * 100];   // a1=[1000,0] … a6=[1000,500]
for(let i = 1; i <= 6; i++) P['b' + i] = [6000, (i - 1) * 100];
const IDS = Object.keys(P);
const A = IDS.filter(id => id[0] === 'a'), B = IDS.filter(id => id[0] === 'b');
const LOCATED = IDS.map(id => ({ id }));
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// optimizeRoute's layout: [start?, …located, home?, meet?] with a start; [home?, …located] without.
// `meet` is appended only when the start is a GPS fix AND a team start exists.
function build(points, { start = null, home = HOME, meet = null, ids = IDS } = {}){
  const nodes = [...(start ? [start] : []), ...(home && !start ? [home] : []),
    ...ids.map(id => points[id]), ...(home && start ? [home] : []), ...(meet ? [meet] : [])];
  return nodes.map(p => Float64Array.from(nodes.map(q => dist(p, q))));
}
const fromMeet = extra => ({ startC:{ lat:1, lng:1 }, homeC:{ lat:0, lng:0 }, startIsCommute:true, target:6, commutePull:0, ...extra });
const day = (r, n) => r.orderedIds.filter(id => r.dayOf[id] === n);
const sorted = a => a.slice().sort();

test('from the morning meet, Day 1 is the cluster nearest the meet, not the stops furthest from Home', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet());
  assert.deepEqual(sorted(day(r, 1)), A);
  assert.deepEqual(sorted(day(r, 2)), B);
  assert.equal(r.orderedIds[0], 'a1');   // leaves the meet for the nearest stop
});

test('commute pull 0 ignores Home: the route is identical with and without a Home pin', () => {
  const withHome = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ commutePull:0 }));
  const noHome = solveVariant(build(P, { start:MEET, home:null }), LOCATED, fromMeet({ commutePull:0, homeC:null }));
  assert.deepEqual(withHome.orderedIds, noHome.orderedIds);
  assert.deepEqual(withHome.dayOf, noHome.dayOf);
});

test('commute pull 100 ends Day 1 toward Home; pull 0 ends at the far end of the cluster', () => {
  // From the meet the cheapest sweep of A is a1 → a6 (ends at the far end). Home is
  // south of a1, so with the drive home counted it is cheaper to cross to a6 first
  // and work back, ending at a1. Pull 0 ignores Home and keeps the plain sweep.
  const pull0 = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ commutePull:0 }));
  const pull100 = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ commutePull:100 }));
  assert.equal(day(pull0, 1).at(-1), 'a6');
  assert.equal(day(pull100, 1).at(-1), 'a1');
  assert.deepEqual(sorted(day(pull100, 1)), A);   // same members, only the end moves
});

test('commute pull 100 prefers a member toward Home when the cluster does not fill the day', () => {
  // Five cluster stops plus two spares 300 m off either end of the street: e1 lies
  // between the street and Home, e2 beyond the far end. Pull 0 fills the 6th slot
  // with the plain nearest (e2); pull 100 takes the one on the way home (e1).
  const Q = { e1:[1000, -300], a1:P.a1, a2:P.a2, a3:P.a3, a4:P.a4, a5:P.a5, e2:[1000, 700], b1:P.b1, b2:P.b2 };
  const ids = Object.keys(Q), located = ids.map(id => ({ id }));
  const pull0 = solveVariant(build(Q, { start:MEET, ids }), located, fromMeet({ commutePull:0 }));
  const pull100 = solveVariant(build(Q, { start:MEET, ids }), located, fromMeet({ commutePull:100 }));
  assert.ok(day(pull0, 1).includes('e2') && !day(pull0, 1).includes('e1'), `pull 0 got ${day(pull0, 1)}`);
  assert.ok(day(pull100, 1).includes('e1') && !day(pull100, 1).includes('e2'), `pull 100 got ${day(pull100, 1)}`);
});

test('days 2+ start from the morning meet, not the GPS fix the crew optimized from', () => {
  // Standing in street B: Day 1 is B (nearest the fix). Tomorrow leaves the meet, so
  // Day 2 is A and it starts at a1, the stop nearest the meet — not at a6, which is
  // what carrying the GPS fix forward (the old every-day-pinned-to-the-fix rule) gives.
  const GPS = [6200, 0];
  const M = build(P, { start:GPS, meet:MEET });
  const r = solveVariant(M, LOCATED, fromMeet({ startIsCommute:false, meetNode: M.length - 1 }));
  assert.deepEqual(sorted(day(r, 1)), B);
  assert.deepEqual(sorted(day(r, 2)), A);
  assert.equal(day(r, 2)[0], 'a1');
});

test('a GPS run with no meet in the matrix plans later days from the list order', () => {
  // No team start on file: tomorrow has no known starting point, so it grows from the
  // first remaining order in the list (the same rule the no-Home "first" mode has
  // always used), ordered to end toward Home by the dial.
  const GPS = [6200, 0];
  const ids = [...B, ...A.slice().reverse()];   // list order: street B, then a6 … a1
  const r = solveVariant(build(P, { start:GPS, ids }), ids.map(id => ({ id })),
    fromMeet({ startIsCommute:false, commutePull:100 }));
  assert.deepEqual(sorted(day(r, 1)), B);
  assert.equal(day(r, 2).at(-1), 'a1');   // ends toward Home
});

test('a slot-1 lock still starts Day 1, and Day 1 grows from it', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ leadId:'a3' }));
  assert.equal(r.orderedIds[0], 'a3');
  assert.deepEqual(sorted(day(r, 1)), A);
});

test('no target: one day that leaves the meet for the nearest stop', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ target:0 }));
  assert.equal(r.orderedIds[0], 'a1');
  assert.deepEqual(sorted(r.orderedIds), sorted(IDS));
  assert.deepEqual(r.dayOf, {});
});

test('every order is routed exactly once, whatever the target', () => {
  for(const target of [0, 1, 3, 5, 6, 7, 40]){
    const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ target }));
    assert.deepEqual(sorted(r.orderedIds), sorted(IDS), `target ${target}`);
    if(target > 0) assert.equal(Object.keys(r.dayOf).length, IDS.length, `target ${target}`);
  }
});

test('with no Home the split is still Day-1-first and reports dayFallback', () => {
  const r = solveVariant(build(P, { start:MEET, home:null }), LOCATED, fromMeet({ homeC:null }));
  assert.deepEqual(sorted(day(r, 1)), A);
  assert.equal(r.dayFallback, true);
});

// ── the plumbing that lets days 2+ really leave the meet ─────────────────────
// nodes: 0 = GPS fix, 1..2 = orders a/b, 3 = home, 4 = the team meet.
const GPS_MEASURE = {
  D: [[0, 10, 500, 900, 300], [10, 0, 490, 890, 290], [500, 490, 0, 400, 200], [900, 890, 400, 0, 600], [300, 290, 200, 600, 0]]
    .map(r => Float64Array.from(r)),
  T: [[0, 1, 50, 90, 30], [1, 0, 49, 89, 29], [50, 49, 0, 40, 20], [90, 89, 40, 0, 60], [30, 29, 20, 60, 0]]
    .map(r => Float64Array.from(r)),
  indexById: { a:1, b:2 }, startIndex:0, homeIndex:3, meetIndex:4, startIsCommute:false,
};

test('travelLookup.fromStart(id, day) leaves the meet from day 2 on, and the start on day 1', () => {
  const t = travelLookup(GPS_MEASURE);
  assert.equal(t.fromStart('b'), 50);        // no day given — the run's start, as before
  assert.equal(t.fromStart('b', 1), 50);
  assert.equal(t.fromStart('b', 2), 20);     // tomorrow's drive-out is from the meet
  const noMeet = travelLookup({ ...GPS_MEASURE, meetIndex:null });
  assert.equal(noMeet.fromStart('b', 2), 50);   // nothing to leave from but the start
});

test('a GPS run records the drive-out from the meet for days 2+, and none for Day 1', () => {
  // Day 1's first leg from the fix is a real driven leg (charged in legMetersFor);
  // tomorrow's first stop is a drive-out from the meet, kept out of the total.
  const home = homeLegMetersFor(GPS_MEASURE, ['a', 'b'], { a:1, b:2 });
  assert.deepEqual(home, { b:200 });
  const legs = legMetersFor(GPS_MEASURE, ['a', 'b'], { a:1, b:2 });
  assert.equal(legs.a, 10);   // fix → a, charged
  assert.equal(legs.b, 0);    // day 2 drive-out, excluded
});

// The real entry point: a GPS "start from here" run that also has a team start on
// file carries the meet as one extra matrix node, so days 2+ can be planned and
// timed from it. The order-id → node map and the home node are unchanged by it.
const LAT0 = 42.837, LNG0 = -80.304, M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
const ll = ([x, y]) => ({ lat: LAT0 + y / M_PER_DEG_LAT, lng: LNG0 + x / M_PER_DEG_LNG });

async function withGps(fix, fn){
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{
    geolocation:{ getCurrentPosition: ok => ok({ coords:{ latitude:fix.lat, longitude:fix.lng } }) } } });
  try { return await fn(); }
  finally { if(had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
}

test('optimizeRoute: a GPS run with a team start carries the meet as the last matrix node', async () => {
  const items = IDS.map(id => ({ id, workOrderId:id, address:id + ' St, Simcoe', ...ll(P[id]) }));
  const r = await withGps(ll([6200, 0]), () => optimizeRoute(items, null, ll(HOME),
    { straightLine:true, startFromCurrent:true, start:ll(MEET), target:6, commutePull:0 }));
  assert.equal(r.mode, 'here-home');
  const n = IDS.length;
  assert.equal(r.measure.startIndex, 0);
  assert.equal(r.measure.homeIndex, n + 1);
  assert.equal(r.measure.meetIndex, n + 2);
  assert.equal(r.measure.D.length, n + 3);
  assert.deepEqual(Object.values(r.measure.indexById).sort((a, b) => a - b), IDS.map((_, k) => k + 1));
  assert.deepEqual(sorted(r.orderedIds.filter(id => r.dayOf[id] === 2)), A);
  assert.equal(r.orderedIds.filter(id => r.dayOf[id] === 2)[0], 'a1');   // tomorrow leaves the meet
});

test('optimizeRoute: with no GPS fix the team start is the start node and no meet is appended', async () => {
  const items = IDS.map(id => ({ id, workOrderId:id, address:id + ' St, Simcoe', ...ll(P[id]) }));
  const r = await optimizeRoute(items, null, ll(HOME), { straightLine:true, start:ll(MEET), target:6, commutePull:0 });
  assert.equal(r.mode, 'start-home');
  assert.equal(r.measure.meetIndex, null);
  assert.equal(r.measure.D.length, IDS.length + 2);
  assert.deepEqual(sorted(r.orderedIds.filter(id => r.dayOf[id] === 1)), A);   // Day 1 = nearest the meet
});

test('the scheduler asks fromStart for each day by number, so day 2 can leave the meet', () => {
  const calls = [];
  const travel = {
    fromStart: (id, dayNo) => { calls.push([id, dayNo]); return 5; },
    between: () => 5,
  };
  const items = ['w', 'x', 'y', 'z'].map(id => ({ id }));
  scheduleRouteConstraints(items, ['w', 'x', 'y', 'z'],
    { routeStartDate:'2026-11-05', firstStopTime:'08:15', paceMin:30, target:2, travel });
  assert.deepEqual(calls, [['w', 1], ['y', 2]]);
});
