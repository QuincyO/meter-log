// ── A LOCKED Optimize plans what is LEFT of the day ─────────────────────────
// The meters/day target is a day's worth of INSTALLS, set in the morning. A re-plan
// mid-day (a break, "No, from where I am") used to hand back a fresh full target: after
// 6 installs a locked Optimize to 24 planned 24 more instead of the 18 left.
//
//   🔓 unlocked — Optimize plans a full target on Day 1, exactly as before. Installs
//                 are not consulted.
//   🔒 locked   — Optimize plans Day 1 = target − installs logged on the plan day
//                 (list orders and walk-ups alike; UTIs do NOT count), choosing Day 1
//                 fresh from ALL pending orders under the Day-1-first rules, from where
//                 the crew starts. Days 2+ fill at the full target. The new Day 1
//                 replaces the frozen set. Installs ≥ target ⇒ Day 1 empty.
//
// NOTHING PASSIVE CHANGES: a logged stop, the Drive screen's 3-minute autoSync, a
// Download and the per-log applyTodayAnchor never re-size. The subtraction exists only
// inside an explicit Optimize press while locked — the one deliberate carve-out from
// "nothing may re-size a locked day from meters installed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installCount, remainingDay1, strictDay1Ids } from '../js/route-today.js';
import { solveVariant, optimizeRoute } from '../js/route.js';
import { scheduleRouteConstraints } from '../js/route-constraints.js';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const plannerJs = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');

// ── the count ───────────────────────────────────────────────────────────────
test('installCount is today’s printable stops that are not UTIs — walk-ups included', () => {
  const stops = [
    { status:'INSTALLED', workOrderId:'1' },
    { status:'INSTALLED', workOrderId:'2' },
    { status:'INSTALLED' },                      // a walk-up: no work order on the list
    { status:'UTI', workOrderId:'3' },           // a UTI spends no meter
    { status:'UTI', workOrderId:'4' },
    { status:'DONE', workOrderId:'5' },          // the coordinates-only marker never counts
    { status:'VISITED', workOrderId:'6' },       // printable, not a UTI
  ];
  assert.equal(installCount(stops), 4);
  assert.equal(installCount([]), 0);
  assert.equal(installCount(null), 0);
});

test('remainingDay1 is the target less the installs, floored at zero', () => {
  assert.equal(remainingDay1(24, 6), 18);
  assert.equal(remainingDay1(20, 6), 14);     // unlock → type 20 → lock → Optimize
  assert.equal(remainingDay1(24, 0), 24);
  assert.equal(remainingDay1(24, 24), 0);     // target met ⇒ an empty Day 1, a REAL 0
  assert.equal(remainingDay1(24, 30), 0);     // past it ⇒ still 0, never negative
  assert.notEqual(remainingDay1(24, 24), null);
});

test('remainingDay1 with no usable target is null — "unset", not a day of nothing', () => {
  assert.equal(remainingDay1(null, 3), null);
  assert.equal(remainingDay1(0, 3), null);
  assert.equal(remainingDay1('', 3), null);
});

test('strictDay1Ids is the orders tagged day 1 exactly — an empty Day 1 freezes EMPTY', () => {
  // taggedDay1Ids takes the LOWEST tagged day, which is right for the 🔒 press (the day
  // on screen) and wrong for the anchor written after a locked Optimize: with Day 1
  // empty the lowest day is 2, and freezing it would turn tomorrow into today.
  assert.deepEqual(strictDay1Ids([{ id:'a', day:2 }, { id:'b', day:1 }, { id:'c', day:'' }, { id:'d', day:1 }]), ['b', 'd']);
  assert.deepEqual(strictDay1Ids([{ id:'a', day:2 }, { id:'b', day:3 }]), []);
  assert.deepEqual(strictDay1Ids([]), []);
  assert.deepEqual(strictDay1Ids(null), []);
});

// ── the solver ──────────────────────────────────────────────────────────────
// Same fixture as route-day-first.test.mjs: the meet at the origin, street A 1 km
// east (six stops 100 m apart, a1 nearest the meet), street B 6 km east.
const HOME = [1000, -1000], MEET = [0, 0];
const P = {};
for(let i = 1; i <= 6; i++) P['a' + i] = [1000, (i - 1) * 100];
for(let i = 1; i <= 6; i++) P['b' + i] = [6000, (i - 1) * 100];
const IDS = Object.keys(P);
const A = IDS.filter(id => id[0] === 'a'), B = IDS.filter(id => id[0] === 'b');
const LOCATED = IDS.map(id => ({ id }));
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
function build(points, { start = null, home = HOME, ids = IDS } = {}){
  const nodes = [...(start ? [start] : []), ...(home && !start ? [home] : []),
    ...ids.map(id => points[id]), ...(home && start ? [home] : [])];
  return nodes.map(p => Float64Array.from(nodes.map(q => dist(p, q))));
}
const fromMeet = extra => ({ startC:{ lat:1, lng:1 }, homeC:{ lat:0, lng:0 }, startIsCommute:true, target:6, commutePull:0, ...extra });
const day = (r, n) => r.orderedIds.filter(id => r.dayOf[id] === n);
const sorted = a => a.slice().sort();

test('solveVariant: day1Count sizes Day 1; days 2+ still fill at the target', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:3 }));
  assert.deepEqual(sorted(day(r, 1)), ['a1', 'a2', 'a3']);     // the 3 that finish soonest
  assert.equal(day(r, 2).length, 6);                           // a full target
  assert.deepEqual(sorted(day(r, 2)).slice(0, 3), ['a4', 'a5', 'a6']);   // the rest of A…
  assert.equal(day(r, 2).filter(id => B.includes(id)).length, 3);         // …then three of B
  assert.equal(day(r, 3).length, 3);
  assert.ok(day(r, 3).every(id => B.includes(id)));
  assert.deepEqual(sorted(r.orderedIds), sorted(IDS));         // every order exactly once
});

test('solveVariant: day1Count 0 is a real value — Day 1 empty, everything from Day 2', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:0 }));
  assert.deepEqual(day(r, 1), []);
  assert.deepEqual(sorted(day(r, 2)), A);                      // tomorrow, from the meet
  assert.deepEqual(sorted(day(r, 3)), B);
  assert.deepEqual(sorted(r.orderedIds), sorted(IDS));
  assert.equal(Object.keys(r.dayOf).length, IDS.length);
});

test('solveVariant: day1Count null/absent is the full target — unchanged', () => {
  const base = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet());
  const nul = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:null }));
  const und = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:undefined }));
  assert.deepEqual(nul, base);
  assert.deepEqual(und, base);
  assert.equal(day(base, 1).length, 6);
});

test('solveVariant: a slot-1 lock still starts Day 1 inside the reduced count', () => {
  const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:2, leadId:'a3' }));
  assert.equal(r.orderedIds[0], 'a3');
  assert.equal(day(r, 1).length, 2);
  assert.ok(day(r, 1).includes('a3'));
  // Even a spent day (0 left) keeps the lead on Day 1: the scheduler holds a slot for
  // the lock regardless, so the solver must agree or the day is modelled twice.
  const spent = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count:0, leadId:'a3' }));
  assert.deepEqual(day(spent, 1), ['a3']);
});

test('solveVariant: a run with no start and no lead honours day1Count 0 too', () => {
  // pickDay's "grow from the first remaining order" fallback must not take one stop
  // for a day that holds none.
  const r = solveVariant(build(P, { home:null }), LOCATED,
    { startC:null, homeC:null, startIsCommute:false, target:6, commutePull:0, day1Count:0 });
  assert.deepEqual(day(r, 1), []);
  assert.deepEqual(sorted(r.orderedIds), sorted(IDS));
});

test('the solver and the scheduler agree on Day 1’s size — never model the day twice', () => {
  const items = IDS.map(id => ({ id }));
  for(const day1Count of [0, 2, 3, 6]){
    const r = solveVariant(build(P, { start:MEET }), LOCATED, fromMeet({ day1Count }));
    const s = scheduleRouteConstraints(items, r.orderedIds,
      { routeStartDate:'2026-11-05', firstStopTime:'08:15', paceMin:30, target:6, day1Count });
    assert.deepEqual(s.dayOf, r.dayOf, `day1Count ${day1Count}`);
    assert.deepEqual(s.orderedIds, r.orderedIds, `day1Count ${day1Count}`);
  }
});

// ── the entry point ─────────────────────────────────────────────────────────
const LAT0 = 42.837, LNG0 = -80.304, M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
const ll = ([x, y]) => ({ lat: LAT0 + y / M_PER_DEG_LAT, lng: LNG0 + x / M_PER_DEG_LNG });

test('optimizeRoute carries opts.day1Count into the solve, and 0 is honoured', async () => {
  const items = () => IDS.map(id => ({ id, workOrderId:id, address:id + ' St, Simcoe', ...ll(P[id]) }));
  const r = await optimizeRoute(items(), null, ll(HOME),
    { straightLine:true, start:ll(MEET), target:6, commutePull:0, day1Count:3 });
  assert.equal(r.orderedIds.filter(id => r.dayOf[id] === 1).length, 3);
  assert.equal(r.orderedIds.filter(id => r.dayOf[id] === 2).length, 6);
  assert.deepEqual(r.variants.straight.dayOf, r.dayOf);   // every variant this run produced
  const z = await optimizeRoute(items(), null, ll(HOME),
    { straightLine:true, start:ll(MEET), target:6, commutePull:0, day1Count:0 });
  assert.equal(z.orderedIds.filter(id => z.dayOf[id] === 1).length, 0);
  assert.equal(z.orderedIds.filter(id => z.dayOf[id] === 2).length, 6);
  const full = await optimizeRoute(items(), null, ll(HOME),
    { straightLine:true, start:ll(MEET), target:6, commutePull:0 });
  assert.equal(full.orderedIds.filter(id => full.dayOf[id] === 1).length, 6);
});

// ── the wiring: ONLY an Optimize press while locked subtracts ───────────────
const fnBody = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `missing ${head}`);
  const rest = src.slice(at + head.length);
  const next = rest.search(/\n(?:export )?(?:async )?function \w+\(/);
  return rest.slice(0, next < 0 ? rest.length : next);
};

test('phone: the locked Optimize reads today’s installs from a freshly cached dayCache', () => {
  const size = fnBody(worklistJs, 'async function lockedDay1Size(');
  assert.match(size, /cacheRecentDays\(1\)/);                 // refresh BEFORE counting
  assert.match(size, /installCount\(/);
  assert.match(size, /remainingDay1\(/);
  assert.ok(size.indexOf('cacheRecentDays(1)') < size.indexOf('installCount('), 'refresh first, then count');
  // Keyed on the PLAN day, like tallyOn: an evening plan for tomorrow has no installs
  // yet and must get the full target.
  assert.match(size, /\|\$\{planDay\(\)\}`/);
});

test('phone: the subtraction exists in exactly one place, and only Optimize calls it', () => {
  assert.equal((worklistJs.match(/remainingDay1\(/g) || []).length, 1);
  const calls = worklistJs.match(/lockedDay1Size\(/g) || [];
  assert.equal(calls.length, 2, 'the definition and one call');
  const opt = fnBody(worklistJs, 'async function optimizeRouteHandler(');
  assert.match(opt, /const day1Count = dayLocked\(\) \? await lockedDay1Size\(target\) : null;/);
  // Both models take the same number: the solver (optimizeRoute) and the scheduler.
  const call = opt.slice(opt.indexOf('await optimizeRoute(pending'), opt.indexOf('const { parkedIds'));
  assert.match(call, /\bday1Count\b/);
  assert.match(opt, /\.\.\.\(day1Count != null \? \{ day1Count \} : \{\}\)/);
  // Day 1 is chosen FRESH from every pending order — the old frozen set no longer leads.
  assert.doesNotMatch(opt, /orderAnchorFirst\(/);
  assert.doesNotMatch(opt, /anchorDay1Ids\(/);
});

test('phone: a locked Optimize replaces the frozen set with the Day 1 it just planned', () => {
  const opt = fnBody(worklistJs, 'async function optimizeRouteHandler(');
  const write = opt.indexOf("saveAnchor({ date: planDay(), ids: strictDay1Ids(");
  assert.ok(write >= 0, 'the anchor is rewritten from the strict day-1 tags');
  assert.match(opt.slice(write, write + 200), /target \}\)/);
  // After the order/day writes and before the re-anchor that reads the set back.
  assert.ok(write > opt.indexOf("store.set('wlRouteVariant'"), 'after the writes');
  assert.ok(write < opt.indexOf('await applyTodayAnchor({ travel })'), 'before the re-anchor');
  assert.match(opt.slice(write - 200, write), /if\(day1Count != null\)/);
});

test('phone: the passive paths never see the install count', () => {
  for(const head of ['async function applyTodayAnchor(', 'function currentDay1Count(',
                     'export async function autoSync(', 'async function wlDownload(',
                     'export async function markWorklistDone(', 'async function setDayLocked(',
                     'async function toggleDayLock(', 'async function persistOrderIds(',
                     'async function switchVariant(']){
    const body = fnBody(worklistJs, head);
    assert.doesNotMatch(body, /installCount\(|remainingDay1\(|lockedDay1Size\(/, head);
  }
  // The three answers of the re-anchor are untouched.
  assert.match(worklistJs, /const fits = \(!locked && opts && opts\.rechunk\) \? null : currentDay1Count\(pending\);/);
  // The press still freezes what is on screen, at the box's number.
  assert.match(fnBody(worklistJs, 'async function setDayLocked('),
    /saveAnchor\(\{ date: day, ids: freshAnchorIds\(pending, target\), target \}\)/);
});

test('planner: the locked Optimize reads that installer’s installs from the sheet’s day read', () => {
  const size = fnBody(plannerJs, 'async function plLockedDay1Size(');
  assert.match(size, /apiGet\('day', \{ installer\b[^}]*\bdate\b/);
  assert.match(size, /installCount\(/);
  assert.match(size, /remainingDay1\(/);
  assert.equal((plannerJs.match(/remainingDay1\(/g) || []).length, 1);
  const opt = fnBody(plannerJs, 'async function optimize(');
  assert.match(opt, /const day1Count = plDayLocked\(\) \? await plLockedDay1Size\(target\) : null;/);
  const call = opt.slice(opt.indexOf('await optimizeRoute(pending'), opt.indexOf('const { parkedIds'));
  assert.match(call, /\bday1Count\b/);
  assert.match(opt, /day1Count,?\s*reflow/);
  assert.doesNotMatch(opt, /orderAnchorFirst\(/);
  assert.doesNotMatch(opt, /plLockedDay1Ids\(/);
  // A sheet read that fails must fail the run, not quietly plan a full day.
  assert.match(size, /throw new Error\(/);
  // The passive variant switch still holds the day as tagged.
  assert.match(plannerJs, /day1Count: plDay1Count\(\)/);
});
