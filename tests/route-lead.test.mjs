// A stop locked to Day 1 slot 1 is where the route STARTS (js/route.js solveVariant's
// lead pin, js/route-constraints.js routeLeadId). Field report 2026-11-02:
// the installer locked 114 Brook St to slot 1 with a dozen Brook St houses beside
// it, and Optimize filled slots 2..10 from across town — because the lock was only
// applied after the solve, and the solve runs furthest-from-home first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveVariant, optimizeRoute, haversine } from '../js/route.js';
import { routeLeadId, scheduleRouteConstraints } from '../js/route-constraints.js';

// Planar points in metres. The lead sits at one end of a street of 11 houses
// 100 m apart; 12 more orders are spread across town; home is just past the far
// end of the street — so the street is "nearest home" and the old rule puts it last.
const P = { L:[0, 0] };
for(let i = 1; i <= 11; i++) P['s' + i] = [0, i * 100];
const TOWN = [[1800, 300], [2100, 900], [2600, 1500], [3000, 400], [1500, 2200], [2400, 2600],
  [3300, 2000], [1200, 3100], [2900, 3300], [3600, 1100], [2000, -600], [3100, -300]];
TOWN.forEach((p, i) => { P['t' + (i + 1)] = p; });
const HOME = [0, 1500];

const IDS = Object.keys(P);
const LOCATED = IDS.map(id => ({ id }));
const STREET = IDS.filter(id => id[0] === 's');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// "road" = a deterministic ±15% wobble, standing in for a real matrix that
// differs from crow-flies pair by pair.
const wobble = (i, j) => 1 + 0.15 * Math.sin(i * 7.1 + j * 3.3);

// optimizeRoute's layout: [home, ...located] with no start; [start, ...located, home?] with one.
function build(points, { start=null, home=HOME, road=false, ids=IDS }={}){
  const nodes = [...(start ? [start] : []), ...(home && !start ? [home] : []),
    ...ids.map(id => points[id]), ...(home && start ? [home] : [])];
  return nodes.map((a, i) => Float64Array.from(nodes.map((b, j) =>
    i === j ? 0 : dist(a, b) * (road ? wobble(Math.min(i, j), Math.max(i, j)) : 1))));
}
const shape = extra => ({ startC:null, homeC:{ lat:0, lng:0 }, target:10, commutePull:0, ...extra });
const day = (r, n) => r.orderedIds.filter(id => r.dayOf[id] === n);

// The old solve ran furthest-from-home first and this fixture reproduced the report
// (Day 1 across town, the street on Day 3). Days are picked today-first now
// (route-day-first.test.mjs), and with no start and no lead Day 1 grows from the
// list's FIRST order — so a town stop at the head of the list keeps Day 1 in town.
test('without a lead or a start, Day 1 grows from the list\'s first order', () => {
  const ids = ['t1', ...IDS.filter(id => id !== 't1')];
  const r = solveVariant(build(P, { ids }), ids.map(id => ({ id })), shape());
  const d1 = day(r, 1);
  assert.ok(d1.includes('t1'));
  assert.ok(d1.filter(id => STREET.includes(id)).length <= 2,
    `expected Day 1 to stay in town around t1, got ${d1.join(',')}`);
});

test('a lead grows Day 1 outward along the street, nearest first (straight-line)', () => {
  const r = solveVariant(build(P), LOCATED, shape({ leadId:'L' }));
  assert.deepEqual(day(r, 1), ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  assert.equal(r.orderedIds[0], 'L');
});

test('the road matrix gets the same Day 1 — lead first, the street, no cross-town stop', () => {
  const r = solveVariant(build(P, { road:true }), LOCATED, shape({ leadId:'L' }));
  const d1 = day(r, 1);
  assert.equal(d1[0], 'L');
  assert.deepEqual(d1.slice().sort(), ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].sort());
});

test('full commute pull keeps the lead first and the same Day 1 members', () => {
  const r = solveVariant(build(P), LOCATED, shape({ leadId:'L', commutePull:100 }));
  const d1 = day(r, 1);
  assert.equal(d1[0], 'L');
  assert.ok(d1.every(id => id === 'L' || STREET.includes(id)));
});

test('days 2+ are exactly the existing solve over the stops Day 1 left', () => {
  const r = solveVariant(build(P), LOCATED, shape({ leadId:'L' }));
  const d1 = new Set(day(r, 1));
  const restIds = IDS.filter(id => !d1.has(id));
  const restPts = {}; restIds.forEach(id => { restPts[id] = P[id]; });
  const nodes = [HOME, ...restIds.map(id => P[id])];
  const Mr = nodes.map(a => Float64Array.from(nodes.map(b => dist(a, b))));
  const alone = solveVariant(Mr, restIds.map(id => ({ id })), shape());
  assert.deepEqual(r.orderedIds.slice(d1.size), alone.orderedIds);
  alone.orderedIds.forEach(id => assert.equal(r.dayOf[id], alone.dayOf[id] + 1));
});

test('every order is routed exactly once', () => {
  for(const target of [10, 0, 3, 40]){
    const r = solveVariant(build(P), LOCATED, shape({ leadId:'L', target }));
    assert.deepEqual(r.orderedIds.slice().sort(), IDS.slice().sort(), `target ${target}`);
    assert.equal(r.orderedIds[0], 'L', `target ${target}`);
  }
});

test('a GPS "start from here" fix does not override the lead', () => {
  const gps = [3000, 2500];   // standing across town
  const r = solveVariant(build(P, { start:gps }), LOCATED,
    shape({ leadId:'L', startC:{ lat:1, lng:1 }, startIsCommute:false }));
  assert.deepEqual(day(r, 1), ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
});

test('with a team muster start (ETA-only) the lead still leads', () => {
  const r = solveVariant(build(P, { start:[2500, 2500] }), LOCATED,
    shape({ leadId:'L', startC:{ lat:1, lng:1 }, startIsCommute:true }));
  assert.equal(r.orderedIds[0], 'L');
  assert.ok(day(r, 1).every(id => id === 'L' || STREET.includes(id)));
});

test('no home pin: lead first, days cut by count', () => {
  const r = solveVariant(build(P, { home:null }), LOCATED, shape({ homeC:null, leadId:'L' }));
  assert.equal(r.orderedIds[0], 'L');
  assert.deepEqual(day(r, 1).slice().sort(), ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].sort());
  assert.equal(r.dayFallback, true);
});

test('an unknown leadId changes nothing', () => {
  const M = build(P);
  assert.deepEqual(solveVariant(M, LOCATED, shape({ leadId:'nope' })), solveVariant(M, LOCATED, shape()));
});

test('routeLeadId: only a slot-1 lock on the route start date leads', () => {
  const start = '2026-11-02';
  assert.equal(routeLeadId([{ id:'a' }, { id:'b', lockedDate:start, lockedSlot:1 }], start), 'b');
  assert.equal(routeLeadId([{ id:'b', lockedDate:start, lockedSlot:'1' }], start), 'b');
  assert.equal(routeLeadId([{ id:'b', lockedDate:start, lockedSlot:2 }], start), null);
  assert.equal(routeLeadId([{ id:'b', lockedDate:'2026-11-03', lockedSlot:1 }], start), null);
  assert.equal(routeLeadId([{ id:'b' }], start), null);
  assert.equal(routeLeadId([{ id:'b', lockedDate:start, lockedSlot:1 }], ''), null);
});

test('end to end: the scheduler keeps the grown Day 1 in order behind the lock', () => {
  const start = '2026-11-02';
  const items = LOCATED.map(x => x.id === 'L' ? { ...x, lockedDate:start, lockedSlot:1 } : { ...x });
  const leadId = routeLeadId(items, start);
  const r = solveVariant(build(P), LOCATED, shape({ leadId }));
  const s = scheduleRouteConstraints(items, r.orderedIds,
    { routeStartDate:start, firstStopTime:'08:15', paceMin:30, target:10 });
  assert.deepEqual(s.orderedIds.slice(0, 10), ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  assert.equal(s.scheduleById.L.slot, 1);
  assert.ok(s.orderedIds.slice(0, 10).every(id => s.dayOf[id] === 1));
});

// ── the real pipeline: optimizeRoute → scheduleRouteConstraints ─────────────
// The same fixture as lat/lng pins around Simcoe, so geocoding is skipped (every
// order is pinned) and the run goes through the page-level path.
const LAT0 = 42.837, LNG0 = -80.304, M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
const ll = ([x, y]) => ({ lat: LAT0 + y / M_PER_DEG_LAT, lng: LNG0 + x / M_PER_DEG_LNG });
const START = '2026-11-02';
const pinnedItems = () => IDS.map(id => ({ id, workOrderId:id, address:id + ' St, Simcoe', ...ll(P[id]),
  ...(id === 'L' ? { lockedDate:START, lockedSlot:1 } : {}) }));

async function pipeline(opts){
  const items = pinnedItems();
  const r = await optimizeRoute(items, null, ll(HOME),
    { target:10, commutePull:0, compareVariants:true, leadId: routeLeadId(items, START), ...opts });
  const out = {};
  for(const v of ['road', 'straight']){
    if(!r.variants[v]) continue;
    const s = scheduleRouteConstraints(items, r.variants[v].orderedIds,
      { routeStartDate:START, firstStopTime:'08:15', paceMin:30, target:10 });
    out[v] = s.orderedIds.filter(id => s.dayOf[id] === 1);
  }
  return out;
}

test('pipeline, straight-line tap: Day 1 starts at the lock and walks the street', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const out = await pipeline({ straightLine:true });
    assert.deepEqual(out.straight, ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  } finally { globalThis.fetch = before; }
});

test('pipeline, road matrix: both saved variants start at the lock and keep to the street', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async url => {
    const pts = decodeURIComponent(String(url)).split('/table/v1/driving/')[1].split('?')[0]
      .split(';').map(p => { const [lng, lat] = p.split(',').map(Number); return { lat, lng }; });
    const distances = pts.map((a, i) => pts.map((b, j) =>
      i === j ? 0 : haversine(a, b) * wobble(Math.min(i, j), Math.max(i, j))));
    const durations = distances.map(row => row.map(m => m / 10));
    return { ok:true, json: async () => ({ code:'Ok', distances, durations }) };
  };
  try {
    const out = await pipeline({ osrmUrl:'http://localhost:5000' });
    const day1 = ['L', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].sort();
    for(const v of ['road', 'straight']){
      assert.ok(out[v], v + ' variant present');
      assert.equal(out[v][0], 'L', v);
      assert.deepEqual(out[v].slice().sort(), day1, v);
    }
  } finally { globalThis.fetch = before; }
});
