import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isWorkday, nextWorkday, planDayLabel, resolvePlanDay, soonestAppointment,
  staleLockIds, weekdayOnOrAfter,
} from '../js/route-planday.js';

// 2026-07-24 Fri · 07-25 Sat · 07-26 Sun · 07-27 Mon · 07-28 Tue · 07-30 Thu
const FRI = '2026-07-24', SAT = '2026-07-25', SUN = '2026-07-26';
const MON = '2026-07-27', TUE = '2026-07-28', THU = '2026-07-30';

// A plan is built against the installer's finish-by clock (default 14:00).
const FINISH = 14 * 60;
const at = h => h * 60;

const day = (over) => resolvePlanDay({
  today: MON, nowMin: at(9), finishByMin: FINISH,
  dayClosed: false, dayStarted: false, ...over,
});

test('weekdayOnOrAfter is a weekend CLAMP, not a "tomorrow"', () => {
  // The whole bug: on a weekday this returns the same day back.
  assert.equal(weekdayOnOrAfter(MON), MON);
  assert.equal(weekdayOnOrAfter(FRI), FRI);
  assert.equal(weekdayOnOrAfter(SAT), MON);
  assert.equal(weekdayOnOrAfter(SUN), MON);
  assert.equal(weekdayOnOrAfter('nonsense'), '');
});

test('nextWorkday advances a day, then skips the weekend', () => {
  assert.equal(nextWorkday(MON), TUE);
  assert.equal(nextWorkday(FRI), MON);
  assert.equal(nextWorkday(SAT), MON);
  assert.equal(nextWorkday(SUN), MON);
  assert.equal(nextWorkday(''), '');
});

test('isWorkday rejects weekends and malformed dates', () => {
  assert.equal(isWorkday(MON), true);
  assert.equal(isWorkday(SAT), false);
  assert.equal(isWorkday('2026-02-30'), false);   // not a real date
  assert.equal(isWorkday('26-07-27'), false);
  assert.equal(isWorkday(''), false);
});

test('a normal weekday morning plans for today, exactly as before', () => {
  assert.deepEqual(day(), { date: MON, source: 'today' });
});

test('past finish-by with nothing logged rolls to the next workday', () => {
  // The reported case: 5pm on a day the installer never worked.
  assert.deepEqual(day({ nowMin: at(17) }), { date: TUE, source: 'rolled' });
});

test('a day already under way never rolls, however late it is', () => {
  // The crew is still driving today's route — jumping to tomorrow mid-shift
  // would take their remaining stops off the screen.
  assert.deepEqual(day({ nowMin: at(17), dayStarted: true }), { date: MON, source: 'today' });
});

test('a closed-out day rolls even if it was worked', () => {
  assert.deepEqual(
    day({ nowMin: at(11), dayStarted: true, dayClosed: true }),
    { date: TUE, source: 'rolled' });
});

test('Friday evening rolls to Monday, not Saturday', () => {
  assert.deepEqual(
    resolvePlanDay({ today: FRI, nowMin: at(17), finishByMin: FINISH }),
    { date: MON, source: 'rolled' });
});

test('a weekend resolves to Monday without needing the roll', () => {
  assert.deepEqual(
    resolvePlanDay({ today: SAT, nowMin: at(9), finishByMin: FINISH }),
    { date: MON, source: 'today' });
});

test('an explicit override wins over both the roll and today', () => {
  assert.deepEqual(day({ override: THU }), { date: THU, source: 'override' });
  assert.deepEqual(day({ nowMin: at(17), override: THU }), { date: THU, source: 'override' });
});

test('an override for today itself is honoured', () => {
  // Deliberately planning today at 5pm — the installer overrode the roll.
  assert.deepEqual(day({ nowMin: at(17), override: MON }), { date: MON, source: 'override' });
});

test('a stale override is dropped, not carried forward', () => {
  // Set on Friday for Friday; by Monday it must not still be planning Friday.
  assert.deepEqual(day({ override: FRI }), { date: MON, source: 'today' });
});

test('a weekend override is rejected — scheduleRouteConstraints refuses one', () => {
  assert.deepEqual(day({ override: SAT }), { date: MON, source: 'today' });
  assert.deepEqual(day({ override: 'garbage' }), { date: MON, source: 'today' });
});

test('a missing clock never rolls — an unknown finish-by is not a spent day', () => {
  assert.deepEqual(
    resolvePlanDay({ today: MON, nowMin: null, finishByMin: null }),
    { date: MON, source: 'today' });
});

// ── the plan day must stay buildable ────────────────────────────────────────
// Regression: rolling the start date forward made scheduleRouteConstraints throw
// "<WO> is dated before the route starts" on any order still pinned to an earlier
// day. That throw aborts the WHOLE route — in optimizeRouteHandler it lands before
// the writes for order/day AND for legGeometry, so the day sizes froze and the map
// fell back to straight lines. One stale pin must never cost the entire route.

test('soonestAppointment finds the earliest still-live appointment', () => {
  const items = [
    { id:'a', wlStatus:'pending', appointmentDate:THU, appointmentTime:'09:00' },
    { id:'b', wlStatus:'pending', appointmentDate:TUE, appointmentTime:'10:00' },
    { id:'c', wlStatus:'pending' },
  ];
  assert.equal(soonestAppointment(items, MON), TUE);
});

test('soonestAppointment ignores done, set-aside and past appointments', () => {
  assert.equal(soonestAppointment([
    { id:'a', wlStatus:'done',    appointmentDate:TUE, appointmentTime:'10:00' },
    { id:'b', wlStatus:'pending', ignored:true, appointmentDate:TUE, appointmentTime:'10:00' },
    { id:'c', wlStatus:'pending', appointmentDate:FRI, appointmentTime:'10:00' },  // missed
  ], MON), '');
  assert.equal(soonestAppointment([], MON), '');
});

test('the roll never jumps over a live appointment', () => {
  // Evening of a day nobody worked, but there is an appointment TODAY still on the
  // list: rolling to tomorrow would make the route unbuildable, so stay put.
  assert.deepEqual(
    day({ nowMin: at(17), soonestAppointment: MON }),
    { date: MON, source: 'appointment' });
  // An appointment tomorrow is happily satisfied by the rolled day.
  assert.deepEqual(day({ nowMin: at(17), soonestAppointment: TUE }), { date: TUE, source: 'rolled' });
  // One further out doesn't hold the route back.
  assert.deepEqual(day({ nowMin: at(17), soonestAppointment: THU }), { date: TUE, source: 'rolled' });
});

test('an explicit override still wins over the appointment clamp', () => {
  // The installer picked the day deliberately; a conflict is surfaced as the
  // "dated before the route starts" warning rather than silently overruled.
  assert.deepEqual(
    day({ nowMin: at(17), override: THU, soonestAppointment: TUE }),
    { date: THU, source: 'override' });
});

test('staleLockIds finds pending locks pinned before the day being planned', () => {
  const items = [
    { id:'a', wlStatus:'pending', lockedDate:MON, lockedSlot:1 },   // stale once planning TUE
    { id:'b', wlStatus:'pending', lockedDate:TUE, lockedSlot:2 },   // still good
    { id:'c', wlStatus:'pending', lockedDate:THU, lockedSlot:1 },   // future, fine
    { id:'d', wlStatus:'pending' },                                  // no lock
    { id:'e', wlStatus:'done',    lockedDate:MON, lockedSlot:1 },   // done, not routed
  ];
  assert.deepEqual(staleLockIds(items, TUE), ['a']);
  assert.deepEqual(staleLockIds(items, MON), []);
  assert.deepEqual(staleLockIds([], TUE), []);
});

// Seen in a real export: one Day 1 holding 20 orders with TWO scheduled dates —
// 5 on 2026-07-27 and 15 on 2026-07-28 — because applyTodayAnchor skipped the
// write for any stop whose order/day had not changed. Position alone was a safe
// key while the plan day was always today; once it rolls, a stop that sits still
// keeps a date that has passed, and the day divider (which reads the first pending
// order's scheduledDate) shows yesterday over tomorrow's route.
test('a stop that has not moved is still rewritten when its date changes', () => {
  const src = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
  const skip = /if\(item\.order === order && item\.day === day[\s\S]{0,220}?\) continue;/.exec(src);
  assert.ok(skip, 'the keep-exact-ETA skip is still in applyTodayAnchor');
  assert.match(skip[0], /scheduledDate[\s\S]*?s\.date/,
    'the skip must compare the scheduled DATE too, not just order and day');
});

test('planDayLabel reads in calendar days, so tomorrow means tomorrow', () => {
  assert.equal(planDayLabel(MON, MON), 'today');
  assert.equal(planDayLabel(TUE, MON), 'Tue · tomorrow');
  assert.equal(planDayLabel(THU, MON), 'Thu · in 3 days');
  // Friday → Monday is a roll of one workday but three calendar days.
  assert.equal(planDayLabel(MON, FRI), 'Mon · in 3 days');
  assert.equal(planDayLabel('', MON), '');
});
