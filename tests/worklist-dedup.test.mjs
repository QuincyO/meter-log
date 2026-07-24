import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeWo, duplicateGroups, pickWinner, dedupePlan,
} from '../js/worklist-dedup.js';

// A worklist order with sensible defaults; override per case.
const order = (id, extra = {}) => Object.assign({
  id, workOrderId: 'WO1', address: '', wlStatus: 'pending',
  lat: undefined, lng: undefined,
}, extra);

test('normalizeWo trims and upper-cases; blank stays blank', () => {
  assert.equal(normalizeWo('  wo123  '), 'WO123');
  assert.equal(normalizeWo('Wo123'), 'WO123');
  assert.equal(normalizeWo(''), '');
  assert.equal(normalizeWo('   '), '');
  assert.equal(normalizeWo(null), '');
  assert.equal(normalizeWo(undefined), '');
  assert.equal(normalizeWo(12345), '12345');
});

test('duplicateGroups groups case-insensitively and needs 2+', () => {
  const items = [
    order('a', { workOrderId: 'WO1' }),
    order('b', { workOrderId: 'wo1' }),   // same WO#, different case
    order('c', { workOrderId: 'WO2' }),   // unique — not a group
  ];
  const groups = duplicateGroups(items);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(x => x.id), ['a', 'b']);
});

test('blank WO#s never group — address-only orders stay separate', () => {
  const items = [
    order('a', { workOrderId: '', address: '1 Bay St' }),
    order('b', { workOrderId: '   ', address: '2 Lake Rd' }),
    order('c', { workOrderId: null, address: 'Bala Island' }),
  ];
  assert.deepEqual(duplicateGroups(items), []);
  assert.equal(dedupePlan(items).dupCount, 0);
});

test('pickWinner: a done copy outranks GPS and address', () => {
  const group = [
    order('a', { lat: 45, lng: -79 }),                 // GPS, pending
    order('b', { wlStatus: 'done', address: '' }),     // done, no GPS/address
    order('c', { address: '5 Main St' }),              // address, pending
  ];
  assert.equal(pickWinner(group).id, 'b');
});

test('pickWinner: GPS wins when none are done', () => {
  const group = [
    order('a', { address: '5 Main St' }),   // address only
    order('b', { lat: 45, lng: -79 }),      // GPS
    order('c'),                             // nothing
  ];
  assert.equal(pickWinner(group).id, 'b');
});

test('pickWinner: address wins over a bare copy when no GPS/done', () => {
  const group = [
    order('a'),                             // nothing
    order('b', { address: '5 Main St' }),   // address
  ];
  assert.equal(pickWinner(group).id, 'b');
});

test('pickWinner: falls back to the first in list order on a tie', () => {
  const group = [
    order('a', { lat: 45, lng: -79 }),
    order('b', { lat: 46, lng: -80 }),   // also GPS — tie, earliest wins
  ];
  assert.equal(pickWinner(group).id, 'a');
});

test('a blank ("") coord is not a pin — the address copy wins', () => {
  const group = [
    order('a', { lat: '', lng: '' }),       // blank strings, not a pin
    order('b', { address: '5 Main St' }),
  ];
  assert.equal(pickWinner(group).id, 'b');
});

test('dedupePlan keeps one per group and removes the rest', () => {
  const items = [
    order('a', { workOrderId: 'WO1', lat: 45, lng: -79 }),  // winner (GPS)
    order('b', { workOrderId: 'WO1', address: '5 Main St' }),
    order('c', { workOrderId: 'WO2' }),                      // unique
    order('d', { workOrderId: 'WO3', wlStatus: 'done' }),    // winner (done)
    order('e', { workOrderId: 'wo3', lat: 45, lng: -79 }),   // loses to done
  ];
  const plan = dedupePlan(items);
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.dupCount, 2);
  assert.deepEqual(plan.removeIds.sort(), ['b', 'e']);
  assert.ok(plan.keepIds.has('a') && plan.keepIds.has('d'));
  assert.ok(!plan.keepIds.has('c'));   // a non-duplicate is not in keepIds
});
