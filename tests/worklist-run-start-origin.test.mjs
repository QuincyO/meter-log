// ── A "start from here" Optimize is re-timed from where it started ──────────
// Field report 2026-11-09: Optimize put both timed appointments (10:30, 13:00) in
// their proper slots, then opening the route map (or Drive) moved both to the top
// of the list, badged hours late. Those screens' passive re-anchor
// (applyTodayAnchor → estimateTravel) priced Day 1's drive out from the MUSTER
// POINT — no fresh GPS fix, nothing logged yet — while the Optimize had started
// "from here". The crew's meet is in Norwich and the day is in Corunna (~150 km),
// so the first leg was hours long, no arrangement of the day was on time, and
// placeAppointments' least-late ranking put every appointment first.
//
// The fix is one rung in the origin ladder: the spot the last Optimize started
// from (the phone-only wlRouteStartFix the route map already draws), valid under
// the same rule as the map's start pin (liveStartFix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scheduleRouteConstraints } from '../js/route-constraints.js';
import { estimateTravelFromCoords } from '../js/route.js';
import { liveStartFix } from '../js/worklist-route-view.js';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

// 20 stops strung down the St. Clair river, two of them timed.
function day(){
  const items = [];
  for(let i = 0; i < 20; i++)
    items.push({ id:'o' + i, workOrderId:String(980000 + i), lat:42.89 - i * 0.006, lng:-82.43 + i * 0.002 });
  Object.assign(items[5], { appointmentDate:'2026-11-09', appointmentTime:'10:30' });
  Object.assign(items[9], { appointmentDate:'2026-11-09', appointmentTime:'13:00' });
  return items;
}
const PLAN = { routeStartDate:'2026-11-09', firstStopTime:'08:15', paceMin:20, target:20,
  day1Count:20, day1FirstStopTime:'08:50' };
const HERE = { lat:42.90, lng:-82.42 };        // where Optimize was pressed
const MEET = { lat:42.988, lng:-80.600 };      // the crew's muster point, Norwich

function reanchor(start){
  const items = day();
  const travel = estimateTravelFromCoords(items, start, null);
  const s = scheduleRouteConstraints(items, items.map(x => x.id), { ...PLAN, travel });
  return { slot: id => s.orderedIds.indexOf(id) + 1, at: id => s.scheduleById[id] };
}

test('the report, reproduced: a far muster point drags the appointments to the top', () => {
  // Pins the mechanism, so the next reader can see why the origin matters this much.
  const r = reanchor(MEET);
  assert.equal(r.slot('o5'), 1);
  assert.equal(r.slot('o9'), 2);
  assert.ok(r.at('o5').lateMin > 60);
});

test('from the spot the run started at, the appointments keep their place', () => {
  const r = reanchor(HERE);
  assert.ok(r.slot('o5') > 2, `10:30 appointment at slot ${r.slot('o5')}`);
  assert.ok(r.slot('o9') > r.slot('o5'));
  assert.equal(Number(r.at('o5').lateMin) || 0, 0);
  assert.equal(Number(r.at('o9').lateMin) || 0, 0);
});

test('the saved start applies on its plan day until a stop is logged', () => {
  const saved = { ...HERE, date:'2026-11-09', left:20 };
  assert.deepEqual(liveStartFix(saved, '2026-11-09', 20), [HERE.lat, HERE.lng]);
  assert.deepEqual(liveStartFix(saved, '2026-11-09', 22), [HERE.lat, HERE.lng]);   // orders added
  assert.equal(liveStartFix(saved, '2026-11-09', 19), null);                        // one logged
  assert.equal(liveStartFix(saved, '2026-11-10', 20), null);                        // another day
  assert.equal(liveStartFix(null, '2026-11-09', 20), null);                         // a meet run
});

test('estimateTravel reads the saved start, by the map\'s rule, before the muster point', () => {
  const est = worklistJs.slice(worklistJs.indexOf('async function estimateTravel(items, all)'),
                               worklistJs.indexOf('async function crewStartPin()'));
  // After the live fix (fresher), before the last driveway (a re-optimize is pressed
  // after the last log), and inside the plan-day guard like both of its neighbours.
  assert.match(est, /\(livePin\(\) \|\| runStartPin\(all\) \|\| lastDonePin\(all\)\)/);
  assert.ok(est.indexOf('planDay() === localDate()') < est.indexOf('runStartPin(all)'));
  assert.ok(est.indexOf('runStartPin(all)') < est.indexOf("cachedCoord('crewStartLat'"));
  // Same validity rule as the start pin, with the same count Optimize saved `left` as.
  assert.match(worklistJs,
    /routeViewMod\.liveStartFix\(savedStartFix\(\), planDay\(\), pendingOf\(all \|\| \[\]\)\.length\)/);
  assert.match(worklistJs, /left:pending\.length/);
  // A namespace import, guarded, so an older cached route view costs the rung and
  // not the page.
  assert.match(worklistJs, /import \* as routeViewMod from '\.\/worklist-route-view\.js';/);
  assert.match(worklistJs, /if\(typeof routeViewMod\.liveStartFix !== 'function'\) return null;/);
  // One reader of the key, shared with the route map.
  assert.equal((worklistJs.match(/store\.get\('wlRouteStartFix'\)/g) || []).length, 1);
  assert.match(worklistJs, /^\s*savedStartFix,$/m);
});
