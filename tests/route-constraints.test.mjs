import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoutePlacement, scheduleRouteConstraints, workdayOffset, onSiteMinutes } from '../js/route-constraints.js';

const item = (id, extra={}) => ({ id, workOrderId:id.toUpperCase(), ...extra });
const opts = (extra={}) => ({
  routeStartDate:'2026-07-24', firstStopTime:'08:00', paceMin:30, target:4,
  ...extra
});

test('workdayOffset skips weekends', () => {
  assert.equal(workdayOffset('2026-07-24', '2026-07-27'), 1);
  assert.equal(workdayOffset('2026-07-24', '2026-07-28'), 2);
});

test('locks preserve an exact date and one-based slot', () => {
  const items = [item('a'), item('b', { lockedDate:'2026-07-24', lockedSlot:2 }), item('c')];
  const result = scheduleRouteConstraints(items, ['a','b','c'], opts());
  assert.deepEqual(result.orderedIds, ['a','b','c']);
  assert.equal(result.scheduleById.b.slot, 2);
  assert.equal(result.scheduleById.b.date, '2026-07-24');
});

test('appointment uses the latest non-late slot and adds early waiting', () => {
  const items = [item('a'), item('b'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'10:10'
  }), item('c')];
  const result = scheduleRouteConstraints(items, ['a','b','c','appt'], opts());
  assert.equal(result.scheduleById.appt.slot, 4);
  assert.equal(result.scheduleById.appt.eta, '09:50');
  assert.equal(result.scheduleById.appt.waitMin, 20);
});

test('appointment waiting shifts later ETAs', () => {
  const items = [item('a'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'10:00',
    lockedDate:'2026-07-24', lockedSlot:2
  }), item('c')];
  const result = scheduleRouteConstraints(items, ['a','appt','c'], opts({ target:3 }));
  assert.equal(result.scheduleById.appt.eta, '09:40');
  assert.equal(result.scheduleById.appt.waitMin, 70);
  assert.equal(result.scheduleById.c.eta, '10:10');
});

test('first-stop ETA is the departure clock plus the drive out from the start', () => {
  const items = [item('a'), item('b')];
  const travel = { fromStart:() => 17, between:() => 12 };
  const r = scheduleRouteConstraints(items, ['a','b'], opts({ firstStopTime:'08:15', travel }));
  assert.equal(r.scheduleById.a.eta, '08:32'); // 08:15 + 17 min drive out
});

test('conflicting locks fail without changing the supplied route', () => {
  const route = ['a','b'];
  const items = [
    item('a', { lockedDate:'2026-07-24', lockedSlot:1 }),
    item('b', { lockedDate:'2026-07-24', lockedSlot:1 })
  ];
  assert.throws(() => scheduleRouteConstraints(items, route, opts()), /WO A.*WO B|WO B.*WO A/);
  assert.deepEqual(route, ['a','b']);
});

test('weekend appointments are rejected', () => {
  const items = [item('a', { appointmentDate:'2026-07-25', appointmentTime:'09:00' })];
  assert.throws(() => scheduleRouteConstraints(items, ['a'], opts()), /weekend.*WO A/i);
});

test('unconstrained routes retain geographic order', () => {
  const items = [item('a'), item('b'), item('c')];
  const result = scheduleRouteConstraints(items, ['c','a','b'], opts());
  assert.deepEqual(result.orderedIds, ['c','a','b']);
});

test('a later appointment day receives enough route slots for all appointments', () => {
  const items = [
    ...Array.from({ length:7 }, (_, i) => item(`free${i}`)),
    item('appt1', { appointmentDate:'2026-07-27', appointmentTime:'09:00' }),
    item('appt2', { appointmentDate:'2026-07-27', appointmentTime:'10:00' }),
    item('appt3', { appointmentDate:'2026-07-27', appointmentTime:'11:00' })
  ];
  const route = items.map(x => x.id);
  const result = scheduleRouteConstraints(items, route, opts({ target:8 }));
  for (const id of ['appt1','appt2','appt3']) {
    assert.equal(result.scheduleById[id].date, '2026-07-27');
  }
  assert.equal(result.orderedIds.filter(id => result.scheduleById[id].date === '2026-07-27').length, 3);
});

test('locking before optimization converts a global index to a within-day slot', () => {
  const items = Array.from({ length:26 }, (_, i) => item(`item${i}`));
  assert.deepEqual(currentRoutePlacement(items, 'item25', 24), { day:2, slot:2 });
});

test('onSiteMinutes subtracts the nominal baseline drive, floored at the minimum', () => {
  assert.equal(onSiteMinutes(30), 20);   // 30 pace − 10 nominal drive
  assert.equal(onSiteMinutes(12), 8);    // floored at MIN_ONSITE_MIN
});

test('with real travel, ETAs accumulate drive time plus on-site time', () => {
  const items = [item('a'), item('b'), item('c')];
  const travel = {
    fromStart: id => (({ a:15 })[id] ?? null),
    between: (f, t) => (({ 'a|b':10, 'b|c':25 })[f + '|' + t] ?? null),
  };
  const result = scheduleRouteConstraints(items, ['a', 'b', 'c'], opts({ target:3, travel }));
  // onSite = onSiteMinutes(30) = 20; depart the muster point at 08:00 (480).
  assert.equal(result.scheduleById.a.eta, '08:15');   // 480 + 15
  assert.equal(result.scheduleById.b.eta, '08:45');   // (495 + 20) + 10 = 525
  assert.equal(result.scheduleById.c.eta, '09:30');   // (525 + 20) + 25 = 570
});

test('an unknown between-leg falls back to a nominal drive instead of stalling', () => {
  const items = [item('a'), item('b')];
  // between() returns null → moveFallback = pace − onSite = 30 − 20 = 10.
  const travel = { fromStart: () => 0, between: () => null };
  const result = scheduleRouteConstraints(items, ['a', 'b'], opts({ target:2, travel }));
  assert.equal(result.scheduleById.a.eta, '08:00');   // 480 + 0
  assert.equal(result.scheduleById.b.eta, '08:30');   // (480 + 20) + 10 = 510
});

test('locking after a manual reorder uses the current slot, not an old ETA slot', () => {
  const items = [
    item('a', { day:1, scheduledSlot:1 }),
    item('c', { day:1, scheduledSlot:3 }),
    item('b', { day:1, scheduledSlot:2 })
  ];
  assert.deepEqual(currentRoutePlacement(items, 'b', 24), { day:1, slot:3 });
});
