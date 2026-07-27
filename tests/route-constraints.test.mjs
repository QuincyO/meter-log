import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoutePlacement, scheduleRouteConstraints, workdayOffset, onSiteMinutes } from '../js/route-constraints.js';
import { dwellLookup } from '../js/route-dwell.js';

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

test('day1Count sizes Day 1 to the frozen today set; days 2+ fill by target', () => {
  const items = ['a','b','c','d','e'].map(id => item(id));
  const result = scheduleRouteConstraints(items, ['a','b','c','d','e'],
    opts({ target:4, day1Count:2 }));
  // Day 1 holds exactly the 2 committed orders; the remaining 3 spill to Day 2
  // (not a full 4), so tomorrow's work is never pulled up into today.
  assert.deepEqual([result.dayOf.a, result.dayOf.b], [1, 1]);
  assert.deepEqual([result.dayOf.c, result.dayOf.d, result.dayOf.e], [2, 2, 2]);
});

test('without day1Count, Day 1 still fills to the full target (unchanged)', () => {
  const items = ['a','b','c','d','e'].map(id => item(id));
  const result = scheduleRouteConstraints(items, ['a','b','c','d','e'], opts({ target:4 }));
  assert.deepEqual([result.dayOf.a, result.dayOf.d], [1, 1]);   // first 4 on Day 1
  assert.equal(result.dayOf.e, 2);                              // the 5th rolls to Day 2
});

test('day1Count 0 empties Day 1 instead of refilling it to a whole target', () => {
  // The day's meters/day target is already met (dayCapacity 0). Zero is a real
  // value here, not "unset" — treating it as falsy would hand today a fresh full
  // target, which is the exact opposite of what a met target means.
  const items = ['a','b','c'].map(id => item(id));
  const result = scheduleRouteConstraints(items, ['a','b','c'],
    opts({ target:4, day1Count:0 }));
  assert.deepEqual([result.dayOf.a, result.dayOf.b, result.dayOf.c], [2, 2, 2]);
});

test('day1Count 0 still starts the rolled-over day on a morning clock', () => {
  const items = ['a','b'].map(id => item(id));
  const result = scheduleRouteConstraints(items, ['a','b'],
    opts({ target:4, day1Count:0, firstStopTime:'08:00' }));
  assert.equal(result.scheduleById.a.eta, '08:00');
});

test('day1Count restarts the ETA clock on Day 2 morning', () => {
  const items = ['a','b','c'].map(id => item(id));
  const result = scheduleRouteConstraints(items, ['a','b','c'],
    opts({ target:4, day1Count:2, firstStopTime:'08:00' }));
  // c is the first stop of Day 2, so its ETA is the morning start, not an
  // afternoon slot carried over from a target-sized Day 1.
  assert.equal(result.scheduleById.c.eta, '08:00');
});

test('opts.dwell charges each stop its own on-site time', () => {
  const items = [
    item('a', { address:'1 First St' }),
    item('b', { address:'2 Second St' }),
    item('c', { address:'3 Third St' })
  ];
  const travel = { fromStart:() => 0, between:() => 10 };
  const dwell = dwellLookup({ paceMin:30, onSiteMin:25,
    siteFactors:{ '2 second street':2 } });
  const r = scheduleRouteConstraints(items, ['a','b','c'],
    opts({ target:3, travel, dwell }));
  assert.equal(r.scheduleById.a.eta, '08:00');   // 480 + 0
  assert.equal(r.scheduleById.b.eta, '08:35');   // (480 + 25) + 10
  assert.equal(r.scheduleById.c.eta, '09:35');   // (515 + 50 slow site) + 10
  assert.equal(r.scheduleById.b.onSiteMin, 50);  // the factored dwell is reported
});

test('a repeat-meter cluster pulls in every stop that follows it', () => {
  // The change that motivated all this: orders sharing an address used to be
  // charged a full dwell each. Note the cut lands on the SECOND meter's own
  // on-site time, so arrival AT it is unchanged (the crew is still finishing the
  // first) — what moves is everything after. Identical drive times both runs;
  // only the addresses differ.
  const travel = { fromStart:() => 0, between:() => 0 };
  const dwell = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:4 });
  const route = ['a','b','c'];
  const clustered = scheduleRouteConstraints([
    item('a', { address:'7 Lake St' }),
    item('b', { address:'7 Lake St' }),
    item('c', { address:'9 Lake St' })
  ], route, opts({ target:3, travel, dwell }));
  const distinct = scheduleRouteConstraints([
    item('a', { address:'1 Lake St' }),
    item('b', { address:'5 Lake St' }),
    item('c', { address:'9 Lake St' })
  ], route, opts({ target:3, travel, dwell }));

  assert.equal(clustered.scheduleById.b.eta, '08:20');   // unchanged: 480 + 20
  assert.equal(clustered.scheduleById.b.onSiteMin, 4);   // but priced as a repeat
  assert.equal(clustered.scheduleById.c.eta, '08:24');   // (500 + 4)
  assert.equal(distinct.scheduleById.c.eta, '08:40');    // (500 + 20)
});

test('a day boundary resets the repeat-meter check', () => {
  // Day 2's first stop must never be read as a repeat of Day 1's last stop, even
  // at the identical address — the crew went home in between.
  const travel = { fromStart:() => 0, between:() => 0 };
  const dwell = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:4 });
  const r = scheduleRouteConstraints(
    [item('a', { address:'7 Lake St' }), item('b', { address:'7 Lake St' })],
    ['a','b'], opts({ target:1, travel, dwell }));
  assert.equal(r.dayOf.b, 2);
  assert.equal(r.scheduleById.b.onSiteMin, 20);   // full dwell, not the 4-min cut
});

test('omitting opts.dwell schedules exactly as it did before dwell existed', () => {
  // The documented footgun: a caller that forgets `dwell` silently gets the flat
  // pace-derived number. That fallback has to stay byte-identical.
  const items = [item('a'), item('b'), item('c')];
  const travel = {
    fromStart: id => (({ a:15 })[id] ?? null),
    between: (f, t) => (({ 'a|b':10, 'b|c':25 })[f + '|' + t] ?? null),
  };
  const r = scheduleRouteConstraints(items, ['a','b','c'], opts({ target:3, travel }));
  assert.equal(r.scheduleById.a.eta, '08:15');
  assert.equal(r.scheduleById.b.eta, '08:45');
  assert.equal(r.scheduleById.c.eta, '09:30');
  assert.equal(r.scheduleById.a.onSiteMin, onSiteMinutes(30));
});

test('free-slot placeholders consume the base dwell while placing appointments', () => {
  // placeAppointments pads the day with `__free_k` ids that have no item behind
  // them. Measured dwell (25) differs from the pace fallback (30 − 10 = 20), so
  // the accrued wait is what proves the placeholders were priced at the measured
  // base: three ahead of the appointment at 25 each ⇒ arrive 08:55, wait 35 to
  // the 09:50 window. Priced at 0 the wait would be 110; at the old flat 20, 50.
  const items = [item('a'), item('b'), item('c'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'10:10'
  })];
  const travel = { fromStart:() => 0, between:() => 0 };
  const dwell = dwellLookup({ paceMin:30, onSiteMin:25 });
  const r = scheduleRouteConstraints(items, ['a','b','c','appt'],
    opts({ target:4, travel, dwell }));
  assert.equal(r.scheduleById.appt.slot, 4);       // latest non-late slot
  assert.equal(r.scheduleById.appt.eta, '09:50');  // still the 20-min early window
  assert.equal(r.scheduleById.appt.waitMin, 35);
});

test('locking after a manual reorder uses the current slot, not an old ETA slot', () => {
  const items = [
    item('a', { day:1, scheduledSlot:1 }),
    item('c', { day:1, scheduledSlot:3 }),
    item('b', { day:1, scheduledSlot:2 })
  ];
  assert.deepEqual(currentRoutePlacement(items, 'b', 24), { day:1, slot:3 });
});
