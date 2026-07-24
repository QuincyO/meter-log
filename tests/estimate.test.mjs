import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDayReal, workHorizon } from '../js/compute/estimate.js';

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
  assert.equal(r.paces.target.delta, 3);
  assert.equal(r.paces.target.onPace, false);
  // Work 3:45: (285 - 40)/20 = 12 more, capped at the 10 pending → lands the whole route.
  assert.equal(r.paces.work.label, '3:45');
  assert.equal(r.paces.work.projected, 14);
  assert.equal(r.paces.work.delta, 0);
  assert.equal(r.paces.work.onPace, true);
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
});
