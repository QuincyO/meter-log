// The duplicate-J# rules (js/jdup.js). Every assertion here is a field mistake
// the crew can actually make, or a legitimate day this must NOT interrupt —
// a warning that cries wolf gets dismissed, and then the real one does too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJ, stopDate, inWindowFrom, jConflicts, J_LABEL, J_FIELDS } from '../js/jdup.js';

const stop = (o) => Object.assign({
  id: 's' + Math.random().toString(36).slice(2),
  timestamp: '2026-07-29 10:00:00', installer: 'Alex',
  workOrderId: '1000', newJNumber: '', oldJNumber: '', status: 'INSTALLED'
}, o);

test('normalizeJ trims, upper-cases and survives junk', () => {
  assert.equal(normalizeJ('  j991 '), 'J991');
  assert.equal(normalizeJ('J991'), 'J991');
  assert.equal(normalizeJ(''), '');
  assert.equal(normalizeJ('   '), '');
  assert.equal(normalizeJ(null), '');
  assert.equal(normalizeJ(undefined), '');
  assert.equal(normalizeJ(991), '991');
});

test('a matching New J# on a different work order is a conflict', () => {
  const prior = stop({ workOrderId: '1000', newJNumber: 'J991' });
  const hits = jConflicts(stop({ workOrderId: '2000', newJNumber: ' j991 ' }), [prior]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, 'newJNumber');
  assert.equal(hits[0].value, 'J991');
  assert.equal(hits[0].stop, prior);
  assert.equal(J_LABEL[hits[0].field], 'New J#');
});

test('a matching Old J# on a different work order is a conflict', () => {
  const prior = stop({ workOrderId: '1000', oldJNumber: 'J410', status: 'UTI' });
  const hits = jConflicts(stop({ workOrderId: '2000', oldJNumber: 'j410' }), [prior]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, 'oldJNumber');
  assert.equal(J_LABEL[hits[0].field], 'Old J#');
});

test('NO cross-field matching, both directions', () => {
  // A meter installed at one house and legitimately pulled from another later
  // carries the same serial in newJNumber there and oldJNumber here, by design.
  const installed = stop({ workOrderId: '1000', newJNumber: 'J991' });
  assert.equal(jConflicts(stop({ workOrderId: '2000', oldJNumber: 'J991' }), [installed]).length, 0);
  const removed = stop({ workOrderId: '1000', oldJNumber: 'J991', status: 'UTI' });
  assert.equal(jConflicts(stop({ workOrderId: '2000', newJNumber: 'J991' }), [removed]).length, 0);
});

test('an Old J# repeated on the SAME work order is not a conflict', () => {
  // The revisit: a UTI records the old meter's serial, the crew comes back and
  // installs. Same site, same meter, two correct rows. Flagging it would block
  // the log on an ordinary day.
  const uti = stop({ workOrderId: '1000', oldJNumber: 'J410', status: 'UTI',
                     timestamp: '2026-07-27 09:00:00' });
  const revisit = stop({ workOrderId: '1000', oldJNumber: 'J410', newJNumber: 'J991' });
  assert.deepEqual(jConflicts(revisit, [uti]), []);
  // …but the same old J# on a DIFFERENT order still fires — that's the mistype.
  assert.equal(jConflicts(stop({ workOrderId: '2000', oldJNumber: 'J410' }), [uti]).length, 1);
});

test('a blank J# never matches — the guard that would otherwise flag the week', () => {
  // Most rows carry a blank oldJNumber, and every UTI carries a blank newJNumber.
  const blanks = [
    stop({ workOrderId: '1000', status: 'UTI', oldJNumber: '' }),
    stop({ workOrderId: '1001', status: 'UNACCOUNTED' }),
    stop({ workOrderId: '1002', newJNumber: '   ' })
  ];
  assert.deepEqual(jConflicts(stop({ workOrderId: '9999' }), blanks), []);
  assert.deepEqual(jConflicts(stop({ workOrderId: '9999', newJNumber: '  ' }), blanks), []);
});

test('a stop never matches itself by id', () => {
  const self = stop({ id: 'abc', workOrderId: '1000', newJNumber: 'J991' });
  assert.deepEqual(jConflicts(self, [self]), []);
  // …but two genuinely different rows with the same number do match.
  assert.equal(jConflicts(self, [stop({ id: 'xyz', workOrderId: '2000', newJNumber: 'J991' })]).length, 1);
});

test('a still-pending (_tempId) row counts', () => {
  // A duplicate against a stop logged 20 minutes ago with no signal is exactly
  // the case worth catching. _tempId is a sync marker, not a validity marker.
  const pending = stop({ workOrderId: '1000', newJNumber: 'J991', _tempId: true });
  assert.equal(jConflicts(stop({ workOrderId: '2000', newJNumber: 'J991' }), [pending]).length, 1);
});

test('both fields conflicting on one stop reports both', () => {
  const prior = stop({ workOrderId: '1000', newJNumber: 'J991', oldJNumber: 'J410' });
  const hits = jConflicts(stop({ workOrderId: '2000', newJNumber: 'J991', oldJNumber: 'J410' }), [prior]);
  assert.deepEqual(hits.map(h => h.field), J_FIELDS);
});

test('opts.installer scopes to one installer, opts.from windows the dates', () => {
  const other = stop({ workOrderId: '1000', newJNumber: 'J991', installer: 'Sam' });
  const cand = stop({ workOrderId: '2000', newJNumber: 'J991' });
  assert.equal(jConflicts(cand, [other], { installer: 'Alex' }).length, 0);
  assert.equal(jConflicts(cand, [other], { installer: ' sam ' }).length, 1);

  const old = stop({ workOrderId: '1000', newJNumber: 'J991', timestamp: '2026-07-22 08:00:00' });
  assert.equal(jConflicts(cand, [old], { from: '2026-07-23' }).length, 0);
  assert.equal(jConflicts(cand, [old], { from: '2026-07-22' }).length, 1);   // inclusive
});

test('stopDate / inWindowFrom read a stamp and refuse anything else', () => {
  assert.equal(stopDate('2026-07-29 14:02:11'), '2026-07-29');
  assert.equal(stopDate('2026-07-29'), '2026-07-29');
  assert.equal(stopDate('Fri Jun 19 2026'), '');
  assert.equal(stopDate(null), '');
  assert.equal(inWindowFrom('2026-07-29 08:00:00', ''), true);      // no window
  // An undateable row is OUTSIDE: it could never be shown as "logged on …", and
  // a match with no date beside it is worse than a miss.
  assert.equal(inWindowFrom('Fri Jun 19 2026', '2026-01-01'), false);
});

test('the rule mutates nothing — a duplicate never costs a stop', () => {
  // "I never want to delete a stop because of a duplicate", as an assertion.
  const stops = [stop({ workOrderId: '1000', newJNumber: 'J991' }),
                 stop({ workOrderId: '1001', oldJNumber: 'J410' })];
  const before = JSON.parse(JSON.stringify(stops));
  const cand = stop({ workOrderId: '2000', newJNumber: 'J991', oldJNumber: 'J410' });
  const candBefore = JSON.parse(JSON.stringify(cand));
  assert.equal(jConflicts(cand, stops).length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(stops)), before);
  assert.deepEqual(JSON.parse(JSON.stringify(cand)), candBefore);
});

test('empty / missing inputs are answered, not thrown on', () => {
  assert.deepEqual(jConflicts(null, [stop({})]), []);
  assert.deepEqual(jConflicts(stop({ newJNumber: 'J1' }), null), []);
  assert.deepEqual(jConflicts(stop({ newJNumber: 'J1' }), [null, undefined]), []);
});
