// ── One hold-up must not wreck the rest of the day ──────────────────────────
// The field report: 3 installs early, then a long hold-up, then the 4th meter at
// 10:30. The gauge projected almost nothing for the remaining five hours, because
// the day's on-site cadence was the MEAN of the WO→WO gaps and the hold-up was one
// of them. The arithmetic that fixes it lives in js/compute/cadence.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { median, nettedGapMin, observedOnSiteMin } from '../js/compute/cadence.js';
import { computeGapsLocal } from '../js/compute/gaps.js';
import { projectDayReal } from '../js/compute/estimate.js';
import { onSiteMinutes } from '../js/route-dwell.js';

test('median of an empty list is null, not zero or NaN', () => {
  assert.equal(median([]), null);
  assert.equal(median(null), null);
});

test('median picks the middle, and averages the middle pair when even', () => {
  assert.equal(median([25, 190, 25]), 25);
  assert.equal(median([20, 30, 40, 50]), 35);
  assert.equal(median([7]), 7);
});

test('a gap is netted by its allocations, floored at zero', () => {
  assert.equal(nettedGapMin({ idleMin: 190, allocations: [{ minutes: 150 }] }), 40);
  assert.equal(nettedGapMin({ idleMin: 40, allocations: [] }), 40);
  assert.equal(nettedGapMin({ idleMin: 40 }), 40);
  // Over-allocated is a data-entry artifact, never negative time.
  assert.equal(nettedGapMin({ idleMin: 30, allocations: [{ minutes: 45 }] }), 0);
  assert.equal(nettedGapMin({}), 0);
});

test('observedOnSiteMin is null before there is a gap to measure', () => {
  assert.equal(observedOnSiteMin([]), null);
});

// ── the reported morning ────────────────────────────────────────────────────
// Three installs 25 minutes apart, a ~190-minute hold-up, then the 4th at 10:30.
const heldUpMorning = [
  { id: 'a', status: 'INSTALLED', timestamp: '2026-07-30T06:45:00', workOrderId: '1' },
  { id: 'b', status: 'INSTALLED', timestamp: '2026-07-30T07:10:00', workOrderId: '2' },
  { id: 'c', status: 'INSTALLED', timestamp: '2026-07-30T07:35:00', workOrderId: '3' },
  { id: 'd', status: 'INSTALLED', timestamp: '2026-07-30T10:30:00', workOrderId: '4' },
];

test('one hold-up costs a single gap, not the whole day', () => {
  const gaps = computeGapsLocal(heldUpMorning, [], null, false);
  assert.deepEqual(gaps.map(g => g.idleMin), [25, 25, 175]);
  // The mean is what shipped: 75 min/stop off a crew that is really doing 25.
  const mean = gaps.reduce((a, g) => a + g.idleMin, 0) / gaps.length;
  assert.equal(mean, 75);
  assert.equal(observedOnSiteMin(gaps), 25);
});

test('a hold-up the crew DID log is netted out as well', () => {
  // A gap-tagged Downtime row over the 07:35→10:30 gap, as the end-of-day review
  // writes them. capture.js passes these to the same gap model; the pace path used
  // to pass [] and charge the wait as time spent installing.
  const downtime = [{ category: 'WAITING', minutes: 150, note: 'gap 07:35–10:30' }];
  const gaps = computeGapsLocal(heldUpMorning, downtime, null, false);
  assert.deepEqual(gaps.map(nettedGapMin), [25, 25, 25]);
  assert.equal(observedOnSiteMin(gaps), 25);
});

test('the projection survives the morning that was reported', () => {
  const gaps = computeGapsLocal(heldUpMorning, [], null, false);
  const at = (onsitePerStop) => projectDayReal({
    stops: heldUpMorning, pendingCount: 20, remainingTravelMin: 60, onsitePerStop,
    finishByMin: null, target: 24, nowMin: 10 * 60 + 35, dayClosed: false,
  }).paces.work.projected;

  // `projected` counts the 4 already done, so the afternoon is the remainder.
  const mean = gaps.reduce((a, g) => a + g.idleMin, 0) / gaps.length;
  // What the crew saw: 4 done and 3 more in the five hours left — the report.
  assert.equal(at(onSiteMinutes(mean)), 7);
  // What the same day projects once one hold-up stops standing in for every stop.
  assert.equal(at(onSiteMinutes(observedOnSiteMin(gaps))), 20);
});
