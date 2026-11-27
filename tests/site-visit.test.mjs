// The house timer on the Drive screen (js/site-visit.js): Parked starts a visit,
// Leaving ends it, and each pair becomes one SiteVisits row. Pure, so every edge
// case the owner named is pinned here rather than found in a driveway.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderOf, sameOrder, pickOrder, startVisit, noteNavigate, endVisit, closeStale,
  elapsedMin, runningText, savedText, isFresh, MIN_VISIT_SEC,
} from '../js/site-visit.js';

const A = { workOrderId: '1024739', address: '107 Thames Ave, Komoka', lat: 42.95, lng: -81.43 };
const B = { workOrderId: '1026328', address: '111 Thames Ave, Komoka', lat: 42.951, lng: -81.431 };
const C = { workOrderId: '1030001', address: '4 Oxbow Dr, Komoka', lat: 42.96, lng: -81.44 };
const addrOf = x => x.address;
const snap = x => orderOf(x, addrOf(x));

const T0 = 1_800_000_000_000;                       // any epoch ms
const at = (min, clock) => ({ ms: T0 + min * 60000, stamp: `2026-11-27 ${clock}`, date: '2026-11-27' });
const open = () => startVisit({ id: 'v1', order: snap(A), now: at(0, '12:40:00') });

test('an order snapshot keeps the WO#, address and pin, and keys on the WO#', () => {
  const o = snap(A);
  assert.deepEqual(o, { key: '1024739', workOrderId: '1024739',
    address: '107 Thames Ave, Komoka', lat: 42.95, lng: -81.43 });
  assert.equal(orderOf({ address: '9 Elm St' }, '9 Elm St').key, '9 Elm St', 'no WO# keys on the address');
  assert.equal(orderOf(null, ''), null);
  assert.ok(sameOrder(snap(A), snap({ ...A, address: 'retyped' })));
  assert.ok(!sameOrder(snap(A), snap(B)));
  assert.ok(!sameOrder(snap(A), null));
});

test('a Parked then Leaving pair is one row with the raw minutes', () => {
  const { row, discarded } = endVisit(open(), { endedBy: 'leave', now: at(23, '13:03:00') });
  assert.equal(discarded, false);
  assert.deepEqual(row, {
    id: 'v1', date: '2026-11-27',
    startTime: '2026-11-27 12:40:00', endTime: '2026-11-27 13:03:00', minutes: 23,
    startWO: '1024739', startAddress: '107 Thames Ave, Komoka',
    endWO: '1024739', endAddress: '107 Thames Ave, Komoka',
    endedBy: 'leave', driveMin: '', driveSource: '', onSiteMin: 23, navTime: '',
  });
});

test('a long visit is kept as it is (boxes, downtime before pulling out)', () => {
  const { row } = endVisit(open(), { endedBy: 'leave', now: at(95.5, '14:15:30') });
  assert.equal(row.minutes, 95.5);
  assert.equal(row.onSiteMin, 95.5);
});

test('a visit under the mis-tap limit is thrown away, whoever ended it', () => {
  const sec = s => ({ ms: T0 + s * 1000, stamp: '2026-11-27 12:40:20', date: '2026-11-27' });
  assert.equal(MIN_VISIT_SEC, 30);
  assert.equal(endVisit(open(), { endedBy: 'leave', now: sec(29) }).discarded, true);
  assert.equal(endVisit(open(), { endedBy: 'leave', now: sec(29) }).row, null);
  assert.equal(endVisit(open(), { endedBy: 'nextStart', endOrder: snap(B), now: sec(10) }).discarded, true);
  assert.equal(endVisit(open(), { endedBy: 'leave', now: sec(30) }).discarded, false);
});

test('a second Parked press inside the mis-tap limit is a double tap, not the next house', () => {
  const v = open();
  assert.equal(isFresh(v, T0 + 5000), true);
  assert.equal(isFresh(v, T0 + 29999), true);
  assert.equal(isFresh(v, T0 + 30000), false);
  assert.equal(isFresh(null, T0), false);
});

test('the saved line rounds a whole visit to the minute; the row keeps the tenth', () => {
  const { row } = endVisit(open(), { endedBy: 'leave', now: { ...at(23, '13:03:05'), ms: T0 + 23 * 60000 + 5000 } });
  assert.equal(row.minutes, 23.1);
  assert.equal(savedText(row), 'Saved 23 min · 1024739');
});

test('forgot Leaving: Parked at another house ends the old visit with both orders and the drive taken off', () => {
  const { row } = endVisit(open(), {
    endedBy: 'nextStart', endOrder: snap(B), now: at(47, '13:27:00'),
    leg: { min: 6.04, source: 'road' },
  });
  assert.equal(row.endedBy, 'nextStart');
  assert.equal(row.startWO, '1024739');
  assert.equal(row.endWO, '1026328');
  assert.equal(row.endAddress, '111 Thames Ave, Komoka');
  assert.equal(row.minutes, 47, 'the raw gap is always kept');
  assert.equal(row.driveMin, 6);
  assert.equal(row.driveSource, 'road');
  assert.equal(row.onSiteMin, 41);
});

test('the drive is only taken off when the order changed, and never below zero', () => {
  const same = endVisit(open(), { endedBy: 'leave', now: at(20, '13:00:00'), leg: { min: 5, source: 'road' } });
  assert.equal(same.row.driveMin, '', 'same order: the truck never moved');
  assert.equal(same.row.onSiteMin, 20);
  const far = endVisit(open(), { endedBy: 'nextStart', endOrder: snap(C), now: at(4, '12:44:00'),
    leg: { min: 9, source: 'straight' } });
  assert.equal(far.row.driveMin, 9);
  assert.equal(far.row.driveSource, 'straight');
  assert.equal(far.row.onSiteMin, 0);
  const noPin = endVisit(open(), { endedBy: 'nextStart', endOrder: snap(B), now: at(47, '13:27:00'), leg: null });
  assert.equal(noPin.row.driveMin, '');
  assert.equal(noPin.row.driveSource, '');
  assert.equal(noPin.row.onSiteMin, 47, 'no estimate: nothing is taken off');
});

test('Navigate to another order while the timer runs is remembered: first press time, latest order', () => {
  let v = open();
  v = noteNavigate(v, snap(A), '2026-11-27 12:50:00');
  assert.equal(v.navTime, '', 'Navigate on the order being timed is not leaving it');
  assert.equal(v.navOrder, null);
  v = noteNavigate(v, snap(B), '2026-11-27 13:01:00');
  v = noteNavigate(v, snap(C), '2026-11-27 13:20:00');
  assert.equal(v.navTime, '2026-11-27 13:01:00', 'the FIRST press is when the truck left');
  assert.ok(sameOrder(v.navOrder, snap(C)), 'the LATEST order is where it is now');
  // Leaving pressed late, at the house navigated to: both orders on the row.
  const { row } = endVisit(v, { endedBy: 'leave', now: at(50, '13:30:00'), leg: { min: 7, source: 'road' } });
  assert.equal(row.startWO, '1024739');
  assert.equal(row.endWO, '1030001');
  assert.equal(row.navTime, '2026-11-27 13:01:00');
  assert.equal(row.driveMin, 7);
  assert.equal(row.onSiteMin, 43);
  assert.equal(noteNavigate(null, snap(B), 'x'), null, 'no timer running: nothing to note');
});

test('navigating back to the order being timed clears the moved-on order but keeps the time', () => {
  let v = noteNavigate(open(), snap(B), '2026-11-27 13:01:00');
  v = noteNavigate(v, snap(A), '2026-11-27 13:05:00');
  assert.equal(v.navOrder, null);
  const { row } = endVisit(v, { endedBy: 'leave', now: at(40, '13:20:00') });
  assert.equal(row.endWO, '1024739');
  assert.equal(row.driveMin, '');
});

test('a timer left running from a previous day is saved with no end, and today\'s is left alone', () => {
  assert.equal(closeStale(open(), '2026-11-27'), null);
  assert.equal(closeStale(null, '2026-11-27'), null);
  const row = closeStale(open(), '2026-11-28');
  assert.equal(row.endedBy, 'notEnded');
  assert.equal(row.endTime, '');
  assert.equal(row.minutes, '');
  assert.equal(row.onSiteMin, '');
  assert.equal(row.date, '2026-11-27', 'filed on the day it started');
  assert.equal(row.startWO, '1024739');
});

test('which order a Parked press means: the Driving-to card, unless that is the house just timed', () => {
  const dest = snap(A), card = snap(B);
  assert.ok(sameOrder(pickOrder(dest, card, null), dest), 'Navigate moved the big card on, so the dest is the house');
  assert.ok(sameOrder(pickOrder(null, card, null), card), 'no Driving-to card: the big card');
  // 107 was just timed and is still the Driving-to card; the next press is the
  // house two doors down, which nobody presses Navigate for.
  assert.ok(sameOrder(pickOrder(dest, card, snap(A)), card));
  // Nothing else on screen: it is the same house again.
  assert.ok(sameOrder(pickOrder(dest, snap(A), snap(A)), dest));
  assert.ok(sameOrder(pickOrder(dest, null, snap(A)), dest));
  assert.equal(pickOrder(null, null, snap(A)), null);
});

test('the lines the driver reads name the order, and both orders when they differ', () => {
  const v = open();
  assert.equal(elapsedMin(v, T0 + 13.4 * 60000), 13);
  assert.equal(runningText(v, T0 + 13 * 60000),
    'Timing 1024739 · 107 Thames Ave, Komoka · since 12:40 · 13 min');
  const moved = noteNavigate(v, snap(B), '2026-11-27 13:01:00');
  assert.match(runningText(moved, T0 + 30 * 60000), /started 1024739 → now 1026328/);

  const same = endVisit(v, { endedBy: 'leave', now: at(23, '13:03:00') }).row;
  assert.equal(savedText(same), 'Saved 23 min · 1024739');
  const diff = endVisit(v, { endedBy: 'nextStart', endOrder: snap(B), now: at(47, '13:27:00'),
    leg: { min: 6, source: 'road' } }).row;
  assert.equal(savedText(diff), 'Saved: started 1024739 → ended 1026328 · 47 min − 6 min drive = 41 min');
  const noLeg = endVisit(v, { endedBy: 'nextStart', endOrder: snap(B), now: at(47, '13:27:00') }).row;
  assert.equal(savedText(noLeg), 'Saved: started 1024739 → ended 1026328 · 47 min');
  assert.equal(savedText(closeStale(v, '2026-11-28')), 'Saved 1024739 from 2026-11-27 with no end time');
});

test('an order with no WO# is named by its address', () => {
  const o = orderOf({ address: '9 Elm St' }, '9 Elm St');
  const v = startVisit({ id: 'v2', order: o, now: at(0, '09:05:00') });
  assert.equal(runningText(v, T0 + 60000), 'Timing 9 Elm St · since 09:05 · 1 min');
  const row = endVisit(v, { endedBy: 'leave', now: at(12, '09:17:00') }).row;
  assert.equal(row.startWO, '');
  assert.equal(row.startAddress, '9 Elm St');
  assert.equal(savedText(row), 'Saved 12 min · 9 Elm St');
  // Nothing on screen at all: still a timer, just with no order on it.
  const blank = startVisit({ id: 'v3', order: null, now: at(0, '09:05:00') });
  assert.equal(endVisit(blank, { endedBy: 'leave', now: at(5, '09:10:00') }).row.startWO, '');
});
