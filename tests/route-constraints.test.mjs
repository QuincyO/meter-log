import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRoutePlacement, scheduleRouteConstraints, workdayOffset, onSiteMinutes, dayDurationMin } from '../js/route-constraints.js';
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

// A travel lookup shaped like the real one (js/route.js travelLookup): it knows
// only the ids that were in the matrix, and returns null for anything else — which
// is exactly what the `__free_k` slot placeholders are.
const realTravel = (ids, fromStart, between) => {
  const known = new Set(ids);
  return {
    fromStart: id => known.has(id) ? fromStart : null,
    between: (f, t) => (known.has(f) && known.has(t)) ? between : null,
  };
};

test('appointment slots are chosen against the real day, not a placeholder one', () => {
  // The bug: placeAppointments padded the day with `__free_k` ids the travel
  // lookup has no row for, so the search priced every free leg at the nominal
  // `pace − onSite` fallback (10 min here) and the drive OUT at zero. On those
  // optimistic numbers a late slot looked fine; the real simulation then arrived
  // at 11:00 and the whole route died. Real drives are 30 out and 30 between, so
  // the only on-time arrangement is the appointment FIRST — and it must be found.
  const items = [item('a'), item('b'), item('c'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'10:00'
  })];
  // 30 out then 90 between: only the FIRST slot arrives before 10:00, and it costs
  // 70 minutes of sitting in the driveway. That is the trade the crew wants taken.
  const travel = realTravel(['a','b','c','appt'], 30, 90);
  const r = scheduleRouteConstraints(items, ['a','b','c','appt'], opts({ target:4, travel }));
  assert.equal(r.scheduleById.appt.slot, 1);
  assert.equal(r.scheduleById.appt.eta, '09:40');    // the 20-min early window
  assert.equal(r.scheduleById.appt.waitMin, 70);     // sit and wait rather than be late
  assert.equal(r.scheduleById.appt.lateMin, 0);
});

test('an on-time day still takes the latest non-late slot, not the earliest', () => {
  // The other half of the same rule: waiting is what you accept to avoid being
  // late, not something to seek out. With 30-minute legs throughout, slot 2 is the
  // last one that still arrives before 10:00 (slot 3 lands at 10:10), so it wins on
  // 20 minutes of waiting instead of slot 1's 70 — the day stays productive.
  const items = [item('a'), item('b'), item('c'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'10:00'
  })];
  const travel = realTravel(['a','b','c','appt'], 30, 30);
  const r = scheduleRouteConstraints(items, ['a','b','c','appt'], opts({ target:4, travel }));
  assert.equal(r.scheduleById.appt.slot, 2);
  assert.equal(r.scheduleById.appt.eta, '09:40');
  assert.equal(r.scheduleById.appt.waitMin, 20);
  assert.equal(r.scheduleById.appt.lateMin, 0);
});

test('an appointment that cannot be met on time is scheduled first and flagged late', () => {
  // Never-late is the rule, but it is not always physically available: a 08:15
  // appointment 90 minutes from the muster point cannot be reached before 09:30
  // from an 08:00 departure. Killing the entire route over it (the old behaviour)
  // costs every other order; scheduling it as early as possible and reporting the
  // lateness lets the crew see the real number and make the call.
  const items = [item('a'), item('b'), item('appt', {
    appointmentDate:'2026-07-24', appointmentTime:'08:15'
  })];
  const travel = realTravel(['a','b','appt'], 90, 20);
  const r = scheduleRouteConstraints(items, ['a','b','appt'], opts({ target:3, travel }));
  assert.equal(r.scheduleById.appt.slot, 1);
  assert.equal(r.scheduleById.appt.eta, '09:30');    // 08:00 + the 90-min drive out
  assert.equal(r.scheduleById.appt.lateMin, 75);     // 09:30 − 08:15, reported not thrown
  assert.equal(r.scheduleById.a.date, '2026-07-24'); // the rest of the day still routes
});

test('an on-time day reports no lateness on any stop', () => {
  const items = [item('a'), item('b')];
  const travel = realTravel(['a','b'], 10, 10);
  const r = scheduleRouteConstraints(items, ['a','b'], opts({ target:2, travel }));
  assert.equal(r.scheduleById.a.lateMin, 0);
  assert.equal(r.scheduleById.b.lateMin, 0);
});

test('day duration reads back the schedule it was written from', () => {
  // The day divider's number must equal what the ETA badges under it say: from
  // the departure clock to the last stop's departure. Drive out 15, then 10 and
  // 25 between, 25 on site each ⇒ 08:15, 08:50, 09:40, + 25 on site = 10:05.
  const items = [item('a'), item('b'), item('c')];
  const travel = {
    fromStart: id => (({ a:15 })[id] ?? null),
    between: (f, t) => (({ 'a|b':10, 'b|c':25 })[f + '|' + t] ?? null),
  };
  const dwell = dwellLookup({ paceMin:30, onSiteMin:25 });
  const r = scheduleRouteConstraints(items, ['a','b','c'], opts({ target:3, travel, dwell }));
  const scheduled = items.map(x => ({
    scheduledEta: r.scheduleById[x.id].eta,
    scheduledOnSiteMin: r.scheduleById[x.id].onSiteMin,
  }));
  assert.equal(r.scheduleById.c.eta, '09:40');
  assert.equal(dayDurationMin(scheduled, '08:00', 25), 125);   // 08:00 → 10:05
});

test('day duration falls back to the dwell base and survives a shuffled day', () => {
  const day = [
    { scheduledEta:'09:30' },                              // no saved on-site
    { scheduledEta:'08:15', scheduledOnSiteMin:20 },
  ];
  assert.equal(dayDurationMin(day, '08:00', 25), 115);     // 09:30 + 25 − 08:00
  assert.equal(dayDurationMin(day, '08:00', 0), 90);       // nothing to fall back on
});

test('day duration is null when the day has no ETAs to read', () => {
  assert.equal(dayDurationMin([{ workOrderId:'A' }, null], '08:00', 25), null);
  assert.equal(dayDurationMin([], '08:00', 25), null);
  assert.equal(dayDurationMin([{ scheduledEta:'08:30' }], 'not a time', 25), null);
});

test('locking after a manual reorder uses the current slot, not an old ETA slot', () => {
  const items = [
    item('a', { day:1, scheduledSlot:1 }),
    item('c', { day:1, scheduledSlot:3 }),
    item('b', { day:1, scheduledSlot:2 })
  ];
  assert.deepEqual(currentRoutePlacement(items, 'b', 24), { day:1, slot:3 });
});
