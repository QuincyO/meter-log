import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkday, nextWorkday, planDayLabel, resolvePlanDay, weekdayOnOrAfter,
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

test('planDayLabel reads in calendar days, so tomorrow means tomorrow', () => {
  assert.equal(planDayLabel(MON, MON), 'today');
  assert.equal(planDayLabel(TUE, MON), 'Tue · tomorrow');
  assert.equal(planDayLabel(THU, MON), 'Thu · in 3 days');
  // Friday → Monday is a roll of one workday but three calendar days.
  assert.equal(planDayLabel(MON, FRI), 'Mon · in 3 days');
  assert.equal(planDayLabel('', MON), '');
});
