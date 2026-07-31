import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDayReal, workHorizon, clockLabel, finishLabel } from '../js/compute/estimate.js';
import { observedOnSiteMin } from '../js/compute/cadence.js';
import { MIN_ONSITE_MIN } from '../js/route-dwell.js';

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
// The meters/day target's job is upstream — it decides how many orders go on Day 1
// when the day is PLANNED, and then lets go (js/route-today.js). Once it has, the
// driver's question is "will I finish the route in front of me?". See
// js/compute/estimate.js paceFor for why the "the route re-sizes underneath you"
// objection no longer holds — and why its original rebuttal was wrong too.
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
  assert.equal(r.paces.work.targetOver, 0);     // …and nothing to be over by
  // The meters/day number is returned ONCE, at the top level — `paces.target` is
  // the finish-by horizon, so a `paces.target.target` would be two meanings of the
  // word one dot apart.
  assert.equal(r.paces.work.target, undefined);
});

// ── the footnote reads BOTH ways ────────────────────────────────────────────
// The target no longer trims the day, so a crew that installs extra keeps its whole
// list and lands past the target. *"If I install extra this should just show that I'm
// ahead of pace and my estimates for today will increase."* Before `targetOver` the
// footnote simply vanished at the moment it had the best news to give.
test('a day projected past the meters/day target reports how far OVER it lands', () => {
  const r = projectDayReal({
    stops: doneStops, pendingCount: 3, remainingTravelMin: 0, onsitePerStop: 20,
    finishByMin: 14 * 60, target: 5, nowMin: 11 * 60, dayClosed: false,
  });
  assert.equal(r.paces.work.projected, 7);      // 4 done + all 3 pending
  assert.equal(r.paces.work.targetOver, 2);     // 7 against a target of 5
  assert.equal(r.paces.work.targetShort, 0);    // and nothing short
});

test('short and over are mutually exclusive, and both vanish without a target', () => {
  const at = target => projectDayReal({
    stops: doneStops, pendingCount: 3, remainingTravelMin: 0, onsitePerStop: 20,
    finishByMin: 14 * 60, target, nowMin: 11 * 60, dayClosed: false,
  }).paces.work;
  // Projected 7 either side of the line, and exactly on it.
  assert.deepEqual([at(9).targetShort, at(9).targetOver], [2, 0]);
  assert.deepEqual([at(7).targetShort, at(7).targetOver], [0, 0]);
  assert.deepEqual([at(4).targetShort, at(4).targetOver], [0, 3]);
  // No target ⇒ no footnote at all, in either direction.
  assert.equal(at(0).targetShort, null);
  assert.equal(at(0).targetOver, null);
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

// ── the 2026-07-31 route: both inputs wrong, pointing opposite ways ──────────
// The day this model was rebuilt around, taken off the MeterLog sheet. At 12:31 with
// 13 done the card read "~13 installs by 3:45 · 8 STOPS SHORT · Route done ~5:36 pm":
// it projected ZERO of the eight stops in front of the crew over the next three and a
// quarter hours, while the stop card directly beneath it read "Arrive 12:36 · in 5
// min". The route's own scheduledEta chain, solved that same lunchtime, landed the
// last of those eight at 14:45.
//
// It stayed plausible for so long because its two inputs were wrong in OPPOSITE
// directions, and the smaller error flattered the larger one:
//   * remaining travel was 110.8 km ÷ a day-average "speed" of 28 km/h = 241 min.
//     The 28 was the crew ON FOOT at a property — 0.2 km covered in ~21.6 minutes
//     that avgMovingSpeed counted as driving.
//   * on-site was the 16-minute median gap less a flat 10-minute drive, floored back
//     up to 8 — over morning legs really driven in two or three minutes. Two
//     mistakes cancelling to a number that looked ordinary; the truth was near 14.
//
// Both halves are priced by one model now, so the fixture prices them that way too:
// the drive is netted out of each gap it actually belongs to, and the same per-metre
// rate walks the route ahead.

// legMetersRoad — the drive INTO each stop from the one before it in road order.
const DONE_LEGS    = [2242, 6973, 4450, 2033, 827, 866, 1035, 1731, 2283, 1369, 530];
// The day's wall-clock WO→WO gaps, whole minutes as computeGapsLocal reads them.
const GAPS_MIN     = [16, 18, 22, 23, 18, 15, 16, 9, 13, 10, 12];
// The eight still pending at 12:04 — 110 829 m, out past Kearney to McClintock and
// Hwy 60. The 58 703 m leg is a real haul, which is the point: no single speed can
// be right for it AND for the 530 m hop at the other end of the same list.
const PENDING_LEGS = [2360, 4484, 9283, 6676, 58703, 4620, 1412, 23291];
// The off-plan walk-up at 12:25 (WO 681945): 28 minutes of wall clock, and no
// worklist row for the lookup to price, so its leg takes the nominal.
const WALKUP_GAP   = [{ idleMin: 28, driveMin: 10 }];

// Minutes per metre of road at a given speed — the shape js/route.js prices a road
// distance matrix with. 70 km/h is what the day's own completed legs regress to and
// what its scheduledEta chain implies; 50 is the nominal the saved-metres tier falls
// back to when no district pack covers the run.
const perMetre = kmh => 1 / 1000 / kmh * 60;

function cardAt(kmh, gapCount, legs, nowMin, done, extraGaps = []){
  const r = perMetre(kmh);
  const gaps = GAPS_MIN.slice(0, gapCount)
    .map((idleMin, i) => ({ idleMin, driveMin: DONE_LEGS[i] * r }))
    .concat(extraGaps);
  const est = projectDayReal({
    stops: Array.from({ length: done }, () => ({ status: 'INSTALLED' })),
    pendingCount: legs.length,
    remainingTravelMin: legs.reduce((a, m) => a + m * r, 0),
    onsitePerStop: Math.max(MIN_ONSITE_MIN, observedOnSiteMin(gaps)),
    finishByMin: null, target: 20, nowMin, dayClosed: false,
  });
  return est;
}

const AT_1204 = () => cardAt(70, 11, PENDING_LEGS, 12 * 60 + 4, 12);
const AT_1231 = () => cardAt(70, 11, PENDING_LEGS, 12 * 60 + 31, 13, WALKUP_GAP);

test('the shipped inputs reproduce the shipped card, exactly', () => {
  // The diagnosis, not the fix — and the reason to trust every other number in this
  // block. The two bad inputs were recovered by back-solving four photographs of the
  // card; feeding them to the UNCHANGED model returns all four lines of the 12:31
  // screenshot to the digit, which is what confirms the back-solve was right and the
  // model itself was never the problem.
  const r = projectDayReal({
    stops: Array.from({ length: 13 }, () => ({ status: 'INSTALLED' })),
    pendingCount: 8,
    remainingTravelMin: 241,     // 110.8 km ÷ 28 km/h — the crew on foot
    onsitePerStop: 8,            // 16.25 median − a flat 10, floored back up
    finishByMin: null, target: 20, nowMin: 12 * 60 + 31, dayClosed: false,
  });
  assert.equal(r.paces.work.projected, 13);      // "~13 installs by 3:45"
  assert.equal(r.paces.work.routeShort, 8);      // "8 STOPS SHORT"
  assert.equal(r.paces.work.targetShort, 7);     // "7 under your 20"
  assert.equal(r.routeFinishLabel, '5:36 pm');   // "Route done ~5:36 pm"
});

test('the 12:31 card reads ~19 by 3:45, not ~13', () => {
  const r = AT_1231();
  assert.equal(r.done, 13);
  assert.equal(r.pendingCount, 8);
  // The shipped card. If any of these three come back, so has the bug.
  assert.notEqual(r.paces.work.projected, 13);
  assert.notEqual(r.paces.work.routeShort, 8);
  assert.notEqual(r.routeFinishLabel, '5:36 pm');
  assert.equal(r.paces.work.projected, 19);         // "~19 installs by 3:45"
  assert.equal(r.paces.work.routeShort, 2);         // "2 STOPS SHORT"
  assert.equal(r.routeFinishLabel, '3:59 pm');      // vs a scheduledEta chain ending 14:45
  // Right at the wire is the honest reading of this day, and it is an ACTIONABLE
  // one — two stops is a decision. "You will complete none of them" is not.
  assert.ok(r.paces.work.projected > r.done, 'the crew must be credited with the road ahead');
});

test('on-site is recovered from the gaps, not guessed at and floored', () => {
  // 16-minute median gap over legs driven in ~2 min ⇒ ~14 on site. The shipped path
  // took a flat 10 off and floored the remainder back up to MIN_ONSITE_MIN.
  const r = perMetre(70);
  const gaps = GAPS_MIN.map((idleMin, i) => ({ idleMin, driveMin: DONE_LEGS[i] * r }));
  const onsite = observedOnSiteMin(gaps);
  assert.ok(onsite > 14 && onsite < 14.5, `expected ~14.1 on-site, got ${onsite}`);
  assert.ok(onsite > MIN_ONSITE_MIN, 'the floor must not be what decides this number');
});

test('an unchanged route cannot get more expensive as the day goes on', () => {
  // The controlled experiment the crew ran by accident. The 13th stop was an off-plan
  // walk-up, so between 12:04 and 12:31 `done` rose while the route ahead did not
  // change by one metre. The shipped card put remaining travel up from 196 to 241
  // minutes across that pair — a route that grew because the driver had been standing
  // still. Remaining travel is a property of the ROAD LEFT, and of nothing else.
  const a = AT_1204(), b = AT_1231();
  assert.equal(a.pendingCount, b.pendingCount);
  // 27 minutes of wall clock passed. The finish clock must move by 27 minutes and a
  // rounding — the crew's own time, spent. The shipped card moved it by SEVENTY-TWO
  // (4:24 pm → 5:36 pm), because it had also re-priced an unchanged 110.8 km from
  // 34 km/h down to 28 while the driver stood at a property. That extra 45 minutes
  // is the whole defect, and it is what this pins.
  const elapsed = (12 * 60 + 31) - (12 * 60 + 4);
  const slip = b.routeFinishMin - a.routeFinishMin;
  assert.ok(Math.abs(slip - elapsed) <= 1,
    `finish clock slipped ${slip} min over ${elapsed} min of day`);
  // And the projection costs exactly the one stop those 27 minutes bought off-plan.
  assert.equal(a.paces.work.projected, 20);
  assert.equal(b.paces.work.projected, 19);
  assert.ok(b.paces.work.projected >= b.done, 'never fewer than what is already logged');
});

test('replaying the whole morning, the gauge never gives up on the route', () => {
  // The four readings the crew photographed. Shipped, these were 16 · 16 · 15 · 13 —
  // falling as the work got done, and ending on "you will complete none of the eight".
  const states = [
    cardAt(70, 9,  [1369, 530, ...PENDING_LEGS], 11 * 60 + 41, 10),
    cardAt(70, 10, [530, ...PENDING_LEGS],       11 * 60 + 49, 11),
    AT_1204(),
    AT_1231(),
  ];
  assert.deepEqual(states.map(s => s.paces.work.projected), [20, 20, 20, 19]);
  // Every reading leaves the crew credited with real progress through the route.
  for(const s of states)
    assert.ok(s.paces.work.projected - s.done >= 6,
      `willDo collapsed to ${s.paces.work.projected - s.done}`);
  // And every finish clock lands inside the working day, not at teatime.
  for(const s of states) assert.ok(s.routeFinishMin < 16 * 60, s.routeFinishLabel);
});

test('the nominal tier is worse, and still nowhere near the shipped answer', () => {
  // No district pack ⇒ saved road metres at the 50 km/h nominal instead of real road
  // durations. That IS a worse answer — 17 rather than 19, and 4:33 rather than 3:59 —
  // and it is the honest cost of not having measured the roads. It is not the failure
  // this replaced: the crew still gets credited with four of the eight stops ahead.
  const r = cardAt(50, 11, PENDING_LEGS, 12 * 60 + 31, 13, WALKUP_GAP);
  assert.equal(r.paces.work.projected, 17);
  assert.equal(r.routeFinishLabel, '4:33 pm');
  assert.ok(r.paces.work.projected > 13);
  assert.ok(r.routeFinishMin < 17 * 60 + 36);
});
