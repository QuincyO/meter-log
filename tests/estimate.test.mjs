import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDayReal, workHorizon, clockLabel, finishLabel } from '../js/compute/estimate.js';

// ── workHorizon: regular-hours tiers ────────────────────────────────────────
test('workHorizon is 3:45 before 4 PM', () => {
  assert.deepEqual(workHorizon(10 * 60, false), { min: 15 * 60 + 45, label: '3:45' });
  assert.deepEqual(workHorizon(15 * 60 + 55, false), { min: 15 * 60 + 45, label: '3:45' });
});

test('workHorizon escalates to 4:45 OT once past 4 PM with the day still open', () => {
  assert.deepEqual(workHorizon(16 * 60 + 10, false), { min: 16 * 60 + 45, label: '4:45 OT' });
});

test('workHorizon does not escalate to OT once the day is closed out', () => {
  assert.deepEqual(workHorizon(16 * 60 + 10, true), { min: 15 * 60 + 45, label: '3:45' });
});

// ── projectDayReal: real-data two-pace projection ───────────────────────────
const doneStops = [
  { id: 'a', status: 'INSTALLED', workOrderId: '1', timestamp: '2026-07-24 08:00:00' },
  { id: 'b', status: 'INSTALLED', workOrderId: '2', timestamp: '2026-07-24 08:20:00' },
  { id: 'c', status: 'INSTALLED', workOrderId: '3', timestamp: '2026-07-24 08:40:00' },
  { id: 'd', status: 'INSTALLED', workOrderId: '4', timestamp: '2026-07-24 09:00:00' },
];

test('projects both paces against their own horizons', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 10, remainingTravelMin: 40, onsitePerStop: 20,
    finishByMin: 14 * 60, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.ready, true);
  assert.equal(r.done, 4);
  assert.equal(r.pendingCount, 10);
  // Target 2:00: (180 - 40)/20 = 7 more → 11 projected, 3 short of the 14-stop route.
  assert.equal(r.paces.target.label, '2:00');
  assert.equal(r.paces.target.projected, 11);
  assert.equal(r.paces.target.routeShort, 3);
  assert.equal(r.paces.target.onPace, false);
  // Work 3:45: (285 - 40)/20 = 12 more, capped at the 10 pending → lands the whole route.
  assert.equal(r.paces.work.label, '3:45');
  assert.equal(r.paces.work.projected, 14);
  assert.equal(r.paces.work.routeShort, 0);
  assert.equal(r.paces.work.onPace, true);
});

// ── the ROUTE is what "on pace" means ───────────────────────────────────────
// The meters/day target's job is upstream — dayCapacity(target, installedToday)
// decides how many orders are on Day 1. Once it has, the driver's question is
// "will I finish the route in front of me?". See js/compute/estimate.js paceFor
// for why the "the route re-sizes underneath you" objection doesn't hold.
test('on pace is measured against the stops left on the route, not the target', () => {
  // The reading the installer objected to: 4 installed, 3 orders left in the world,
  // all 3 will land. The route is satisfied — that is on pace. A 24-meter target
  // being 17 away is real, but it is not a pace the driver can do anything about,
  // so it is the footnote and not the verdict.
  const r = projectDayReal({
    stops: doneStops, pendingCount: 3, remainingTravelMin: 0, onsitePerStop: 20,
    finishByMin: 14 * 60, target: 24, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.target, 24);
  assert.equal(r.paces.work.projected, 7);      // 4 done + all 3 pending
  assert.equal(r.paces.work.routeShort, 0);     // the route lands in full…
  assert.equal(r.paces.work.onPace, true);      // …which is the answer that matters
  assert.equal(r.paces.work.targetShort, 17);   // still reported, as the footnote
  // The meters/day number is returned ONCE, at the top level — `paces.target` is
  // the finish-by horizon, so a `paces.target.target` would be two meanings of the
  // word one dot apart.
  assert.equal(r.paces.work.target, undefined);
});

test('the target footnote clamps at zero on a day that beats it', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 6, remainingTravelMin: 0, onsitePerStop: 10,
    finishByMin: 14 * 60, target: 5, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.paces.work.projected, 10);     // 4 done + 6 more
  assert.equal(r.paces.work.targetShort, 0);    // clamped, not -5
  assert.equal(r.paces.work.onPace, true);
});

test('a met target does not excuse stops that will not be reached', () => {
  // Target met (4 + 2 = 6 ≥ 6) but two of the route's four remaining stops won't be
  // reached by 1:00. Behind — the target cannot vote the route off the gauge.
  const r = projectDayReal({
    stops: doneStops, pendingCount: 4, remainingTravelMin: 0, onsitePerStop: 60,
    finishByMin: 13 * 60, target: 6, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.paces.target.projected, 6);
  assert.equal(r.paces.target.targetShort, 0);
  assert.equal(r.paces.target.routeShort, 2);
  assert.equal(r.paces.target.onPace, false);
});

test('with no target set there is simply no footnote', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 3, remainingTravelMin: 0, onsitePerStop: 20,
    finishByMin: 14 * 60, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.target, null);
  assert.equal(r.paces.work.targetShort, null);
  assert.equal(r.paces.work.onPace, true);      // the route, target or no target
});

test('never projects more than the stops left in the route', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 3, remainingTravelMin: 0, onsitePerStop: 1,
    finishByMin: 14 * 60, nowMin: 10 * 60, dayClosed: false,
  });
  assert.equal(r.paces.target.projected, 7);   // 4 done + 3 pending, not 4 + hundreds
  assert.equal(r.paces.work.projected, 7);
});

test('past 4 PM with the day open, the work pace uses the 4:45 OT horizon', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 10, remainingTravelMin: 0, onsitePerStop: 30,
    finishByMin: 14 * 60, nowMin: 16 * 60 + 15, dayClosed: false,
  });
  assert.equal(r.paces.work.label, '4:45 OT');
  // (16:45 - 16:15)=30 min / 30 = 1 more.
  assert.equal(r.paces.work.projected, 5);
});

test('omits the target pace when there is no finish-by set', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 5, remainingTravelMin: 0, onsitePerStop: 20,
    finishByMin: null, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.paces.target, null);
  assert.ok(r.paces.work);
});

test('not ready without a usable on-site pace', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 5, remainingTravelMin: 0, onsitePerStop: 0,
    finishByMin: 14 * 60, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.ready, false);
  assert.equal(r.done, 4);
  assert.equal(r.routeFinishMin, null);      // nothing to project the clock from
  assert.equal(r.routeFinishLabel, null);
});

// ── the route-finish clock (the Drive screen's "Route done ~4:20") ──────────
// The same three terms paceFor inverts, read forward. It has no horizon of its
// own, which is exactly why it lives at the top level and not inside a pace.
test('projects what time the route itself is finished', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 4, remainingTravelMin: 30, onsitePerStop: 25,
    finishByMin: 14 * 60, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.routeFinishMin, 11 * 60 + 30 + 4 * 25);   // 790
  assert.equal(r.routeFinishLabel, '1:10 pm');
});

test('the finish clock lands past the horizon rather than being clamped to it', () => {
  // 5 stops × 40 min + 45 min of driving from 2 PM is 6:05 PM — well past both the
  // 3:45 horizon and the 4:45 OT ceiling. Landing at 6:05 is the thing worth
  // knowing, so it is reported as-is (drive.js paints it amber).
  const r = projectDayReal({
    stops: doneStops, pendingCount: 5, remainingTravelMin: 45, onsitePerStop: 40,
    finishByMin: 14 * 60, nowMin: 14 * 60, dayClosed: false,
  });
  assert.equal(r.routeFinishMin, 18 * 60 + 5);
  assert.equal(r.routeFinishLabel, '6:05 pm');
  assert.ok(r.routeFinishMin > r.paces.work.horizonMin);
});

test('no route left ⇒ no finish clock', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 0, remainingTravelMin: 0, onsitePerStop: 25,
    finishByMin: 14 * 60, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.ready, true);
  assert.equal(r.routeFinishMin, null);
  assert.equal(r.routeFinishLabel, null);
});

// ── the finish clock must not read as a time that has already passed ────────
// clockLabel is a BARE 12-hour readout and is only safe for the fixed horizons.
// The finish clock is derived and unbounded, so it gets finishLabel.
test('clockLabel stays bare — the horizons depend on it', () => {
  assert.equal(clockLabel(15 * 60 + 45), '3:45');
  assert.equal(clockLabel(16 * 60 + 45), '4:45');
});

test('finishLabel carries am/pm so an evening clock cannot read as morning', () => {
  assert.equal(finishLabel(11 * 60 + 29), '11:29 am');
  assert.equal(finishLabel(23 * 60 + 29), '11:29 pm');   // the reported case
  assert.equal(finishLabel(12 * 60), '12:00 pm');
  assert.equal(finishLabel(0), '12:00 am');
  assert.equal(finishLabel(18 * 60 + 5), '6:05 pm');
  assert.equal(finishLabel(null), null);
});

test('finishLabel marks the day once the clock runs past midnight', () => {
  // Inside today, tonight included, it is the plain meridiem clock. Past 24 h a
  // meridiem alone is the same ambiguity in a new hat, so the day is named.
  assert.equal(finishLabel(25 * 60 + 10), '1:10 am +1d');
  assert.equal(finishLabel(35 * 60 + 29), '11:29 am +1d');
  assert.equal(finishLabel(50 * 60), '2:00 am +2d');
});

// The exact screenshot from the field report: 11:36 AM, 6 installs done, 18 stops
// still on the route, ~137 min of remaining driving and ~32 min/stop on site. Every
// number on the card is reproduced; the finish clock was a real 23:29 that printed
// as "11:29" and read as seven hours in the past.
test('the reported card reads as 11:29 PM, not 11:29', () => {
  const stops = Array.from({ length: 6 }, () => ({ status: 'INSTALLED' }));
  const r = projectDayReal({
    stops, pendingCount: 18, remainingTravelMin: 137, onsitePerStop: 32,
    finishByMin: null, target: 24, nowMin: 11 * 60 + 36, dayClosed: false,
  });
  assert.equal(r.done, 6);
  assert.equal(r.pendingCount, 18);
  assert.equal(r.paces.work.projected, 9);          // "~9 installs by 3:45"
  assert.equal(r.paces.work.routeShort, 15);        // "15 STOPS SHORT"
  assert.equal(r.paces.work.targetShort, 15);       // "15 under your 24"
  assert.equal(r.routeFinishMin, 23 * 60 + 29);     // 1409 — tonight, not this morning
  assert.equal(r.routeFinishLabel, '11:29 pm');
  assert.ok(r.routeFinishMin > r.paces.work.horizonMin);   // still painted amber
});
