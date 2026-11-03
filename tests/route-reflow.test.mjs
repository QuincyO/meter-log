// After a timed appointment or a locked stop, the route CARRIES ON FROM IT
// (route-constraints.js reflow + route.js anchorFiller). Field report 2026-11-03:
// a 17-stop day on the West St cluster had a timed appointment across town at slot
// 6; slots 7..17 went straight back to the cluster, while orders a block from the
// appointment sat on later days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorFiller, optimizeRoute } from '../js/route.js';
import { scheduleRouteConstraints } from '../js/route-constraints.js';

// Planar metres. C = the cluster the crew is working (route order: c1..c15, as
// the solver left it). N = six orders a block from A, the appointment across town.
const P = {};
for(let i = 1; i <= 15; i++) P['c' + i] = [(i % 5) * 40, Math.floor((i - 1) / 5) * 40];
P.A = [1500, -300];
[[1550, -250], [1600, -320], [1480, -380], [1650, -260], [1540, -420], [1700, -350]]
  .forEach((p, i) => { P['n' + (i + 1)] = p; });
P.B = [1750, -300];   // a second anchor out by the N group
const CLUSTER = Object.keys(P).filter(id => id[0] === 'c');
const NEAR = Object.keys(P).filter(id => id[0] === 'n');
const START = '2026-11-03';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function measureOf(ids){
  const D = ids.map(a => ids.map(b => dist(P[a], P[b])));
  const indexById = {}; ids.forEach((id, i) => { indexById[id] = i; });
  return { D, indexById, startIndex:null, homeIndex:null };
}
function travelOf(m){
  return { between:(a, b) => m.D[m.indexById[a]][m.indexById[b]] / 500, fromStart:() => 5 };
}
const items = (extra={}) => Object.keys(P).filter(id => id !== 'B' || extra.B)
  .map(id => ({ id, workOrderId:id, ...(extra[id] || {}) }));
// The solver's sequence: the cluster, then the far group, A wherever it fell.
const ROUTE = [...CLUSTER, 'A', ...NEAR];
const lockA = { A:{ lockedDate:START, lockedSlot:6 } };
const base = { routeStartDate:START, firstStopTime:'08:15', paceMin:30, target:17 };

function run(list, route, opts){
  const m = measureOf(route);
  return scheduleRouteConstraints(list, route,
    { ...base, travel:travelOf(m), ...opts, ...(opts && opts.reflow === true ? { reflow:anchorFiller(m) } : {}) });
}
const day1 = s => s.orderedIds.filter(id => s.dayOf[id] === 1);
const assertPermutation = (s, route) => assert.deepEqual(s.orderedIds.slice().sort(), route.slice().sort());

test('fixture reproduces the report: without reflow the route drives back after the lock', () => {
  const s = run(items(lockA), ROUTE, {});
  const d = day1(s);
  assert.equal(d[5], 'A');
  assert.ok(CLUSTER.includes(d[6]), `slot 7 should go back to the cluster, got ${d[6]}`);
});

test('with reflow the stops after a locked stop are the ones nearest it', () => {
  const s = run(items(lockA), ROUTE, { reflow:true });
  const d = day1(s);
  assert.equal(d.length, 17);
  assert.equal(d[5], 'A');
  assert.deepEqual(d.slice(0, 5), CLUSTER.slice(0, 5), 'the stretch before the anchor keeps route order');
  assert.deepEqual(d.slice(6, 12).sort(), NEAR.slice().sort(), 'slots 7..12 are the six orders by A');
  assert.equal(d[6], 'n1', 'the first stop after A is the one nearest A');
  assertPermutation(s, ROUTE);
});

test('a timed appointment is carried on from the same way', () => {
  const s = run(items({ A:{ appointmentDate:START, appointmentTime:'10:30' } }), ROUTE, { reflow:true });
  const d = day1(s);
  const at = d.indexOf('A');
  assert.ok(at > 0 && at < d.length - 6, `appointment slot ${at + 1}`);
  assert.deepEqual(d.slice(at + 1, at + 7).sort(), NEAR.slice().sort());
  assert.equal(s.scheduleById.A.lateMin, 0);
  assertPermutation(s, ROUTE);
});

test('orders near the anchor are pulled in from later days', () => {
  // The far group sits at the END of the route — Day 2 by the target alone.
  const route = [...CLUSTER, 'c16', 'c17', 'c18', 'A', ...NEAR];
  P.c16 = [0, 120]; P.c17 = [40, 120]; P.c18 = [80, 120];
  try {
    const list = [...items(lockA), ...['c16', 'c17', 'c18'].map(id => ({ id }))];
    const plain = run(list, route, {});
    assert.ok(NEAR.every(id => plain.dayOf[id] === 2), 'without reflow the group is tomorrow');
    const s = run(list, route, { reflow:true });
    assert.ok(NEAR.every(id => s.dayOf[id] === 1), 'with reflow the group is today');
    assert.equal(day1(s).length, 17, 'the day is still sized by the target');
    assertPermutation(s, route);
  } finally { delete P.c16; delete P.c17; delete P.c18; }
});

test('between two anchors the stretch is the stops on the way', () => {
  const list = items({ ...lockA, B:{ lockedDate:START, lockedSlot:10 } });
  const route = [...CLUSTER, 'A', 'B', ...NEAR];
  const s = run(list, route, { reflow:true });
  const d = day1(s);
  assert.equal(d[5], 'A'); assert.equal(d[9], 'B');
  assert.ok(d.slice(6, 9).every(id => NEAR.includes(id)), `slots 7..9: ${d.slice(6, 9)}`);
  assertPermutation(s, route);
});

test('a locked work list (day1Count) keeps Day 1 members — reflow only reorders them', () => {
  const route = [...CLUSTER, 'A', ...NEAR];
  const plain = run(items(lockA), route, { day1Count:12 });
  const s = run(items(lockA), route, { day1Count:12, reflow:true });
  assert.deepEqual(day1(s).slice().sort(), day1(plain).slice().sort());
  assertPermutation(s, route);
});

test('the slot-1 lead keeps the solver\'s order after it', () => {
  const list = items({ c1:{ lockedDate:START, lockedSlot:1 } });
  const route = [...CLUSTER, 'A', ...NEAR];
  const plain = run(list, route, {});
  const s = run(list, route, { reflow:true });
  assert.deepEqual(s.orderedIds, plain.orderedIds);
});

test('no anchors: reflow changes nothing', () => {
  const route = [...CLUSTER, 'A', ...NEAR];
  assert.deepEqual(run(items(), route, { reflow:true }).orderedIds, run(items(), route, {}).orderedIds);
});

test('a reflow that answers badly can never drop or duplicate an order', () => {
  const route = [...CLUSTER, 'A', ...NEAR];
  const bogus = () => ['A', 'n1', 'n1', 'nope', 'c1'];
  const s = scheduleRouteConstraints(items(lockA), route, { ...base, reflow:bogus });
  assertPermutation(s, route);
  assert.equal(day1(s)[5], 'A');
});

test('anchorFiller: null without a measure; ends toward home under full commute pull', () => {
  assert.equal(anchorFiller(null), null);
  const ids = ['a', 'x1', 'x2', 'x3', 'home'];
  const pts = { a:[0, 0], x1:[100, 0], x2:[200, 0], x3:[-100, 0], home:[-1000, 0] };
  const D = ids.map(p => ids.map(q => dist(pts[p], pts[q])));
  const indexById = { a:0, x1:1, x2:2, x3:3 };
  const fill = anchorFiller({ D, indexById, homeIndex:4 }, { commutePull:100 });
  const out = fill('a', null, 3, ['x1', 'x2', 'x3']);
  assert.equal(out.length, 3);
  assert.equal(out[out.length - 1], 'x3', 'the home-ward stop is last');
});

test('pipeline: optimizeRoute measure → anchorFiller → scheduler carries on from the lock', async () => {
  const LAT0 = 42.837, LNG0 = -80.304, MLAT = 111320, MLNG = MLAT * Math.cos(LAT0 * Math.PI / 180);
  const ll = ([x, y]) => ({ lat: LAT0 + y / MLAT, lng: LNG0 + x / MLNG });
  const ids = [...CLUSTER, 'A', ...NEAR];
  const list = ids.map(id => ({ id, workOrderId:id, address:id, ...ll(P[id]), ...(lockA[id] || {}) }));
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await optimizeRoute(list, null, null, { straightLine:true, target:17 });
    const s = scheduleRouteConstraints(list, r.orderedIds,
      { ...base, reflow:anchorFiller(r.measure, { commutePull:0 }) });
    const d = day1(s);
    const at = d.indexOf('A');
    assert.equal(at, 5);
    assert.ok(NEAR.includes(d[6]), `slot 7 should be by A, got ${d[6]}`);
    assertPermutation(s, ids);
  } finally { globalThis.fetch = before; }
});
