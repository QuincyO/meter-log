import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupPendingRoutes,
  defaultRouteGroup,
  reorderRouteGroup,
  buildRouteMapModel,
  routeCardState,
  needsOrderWrite,
} from '../js/worklist-route-view.js';

const item = (id, order, day = '', wlStatus = 'pending') => ({
  id, order, day, wlStatus, address: `Stop ${id}`,
});

test('groups pending records by numbered day and leaves unassigned records in Other', () => {
  const groups = groupPendingRoutes([
    item('d2-a', 0, 2),
    item('other', 10),
    item('done', 20, 1, 'done'),
    item('d1-a', 30, 1),
    item('d2-b', 40, 2),
  ]);

  assert.deepEqual(groups.map(g => [g.key, g.label, g.items.map(x => x.id)]), [
    ['day:1', 'Day 1', ['d1-a']],
    ['day:2', 'Day 2', ['d2-a', 'd2-b']],
    ['other', 'Other', ['other']],
  ]);
  assert.equal(defaultRouteGroup(groups), 'day:1');
});

test('labels a wholly unassigned pending list as Route', () => {
  const groups = groupPendingRoutes([item('a', 0), item('b', 10), item('done', 20, '', 'done')]);

  assert.deepEqual(groups.map(g => [g.key, g.label]), [['other', 'Route']]);
  assert.equal(defaultRouteGroup(groups), 'other');
});

test('reorders only the selected group while preserving every other global slot', () => {
  const original = [
    item('d1-a', 0, 1),
    item('d2-a', 10, 2),
    item('d1-b', 20, 1),
    item('other', 30),
    item('done', 40, 1, 'done'),
  ];

  const reordered = reorderRouteGroup(original, 'day:1', ['d1-b', 'd1-a']);

  assert.deepEqual(reordered.map(x => x.id), ['d1-b', 'd2-a', 'd1-a', 'other', 'done']);
  assert.deepEqual(reordered.map(x => x.order), [0, 10, 20, 30, 40]);
  assert.deepEqual(reordered.map(x => [x.id, x.day, x.wlStatus]), [
    ['d1-b', 1, 'pending'],
    ['d2-a', 2, 'pending'],
    ['d1-a', 1, 'pending'],
    ['other', '', 'pending'],
    ['done', 1, 'done'],
  ]);
});

test('rejects incomplete or foreign reorder ids instead of losing records', () => {
  const original = [item('a', 0, 1), item('b', 10, 1), item('c', 20, 2)];

  assert.throws(() => reorderRouteGroup(original, 'day:1', ['a']), /same route group/);
  assert.throws(() => reorderRouteGroup(original, 'day:1', ['a', 'c']), /same route group/);
});

test('keeps a locked order in its within-day slot while free orders move around it', () => {
  const original = [
    item('a', 0, 1),
    { ...item('locked', 10, 1), lockedDate:'2026-07-24', lockedSlot:2 },
    item('c', 20, 1),
  ];

  const reordered = reorderRouteGroup(original, 'day:1', ['locked', 'c', 'a']);

  assert.deepEqual(reordered.map(x => x.id), ['c', 'locked', 'a']);
  assert.equal(reordered[1].lockedSlot, 2);
});

test('keeps full route positions on pins and excludes parked pins from the line', () => {
  const model = buildRouteMapModel([
    { ...item('located', 0, 1), lat:45.1, lng:-79.1 },
    item('missing', 10, 1),
    { ...item('parked', 20, 1), lat:45.3, lng:-79.3, geoFail:true },
    { ...item('last', 30, 1), lat:45.4, lng:-79.4 },
  ]);

  assert.deepEqual(model.markers.map(x => [x.item.id, x.position, x.parked]), [
    ['located', 1, false],
    ['parked', 3, true],
    ['last', 4, false],
  ]);
  assert.deepEqual(model.line, [[45.1, -79.1], [45.4, -79.4]]);
  assert.equal(model.missing, 1);
  assert.equal(model.parked, 1);
});

test('labels missing coordinates as no pin before applying the broader parked state', () => {
  assert.equal(routeCardState(item('missing', 0, 1)), 'no pin');
  assert.equal(routeCardState({ ...item('parked', 0, 1), lat:45, lng:-79, geoFail:true }), 'parked');
  assert.equal(routeCardState({ ...item('ready', 0, 1), lat:45, lng:-79 }), '');
});

test('normalizes legacy blank and string orders instead of treating them as numeric', () => {
  assert.equal(needsOrderWrite({ order:null }, { order:0 }), true);
  assert.equal(needsOrderWrite({ order:'' }, { order:0 }), true);
  assert.equal(needsOrderWrite({ order:'0' }, { order:0 }), true);
  assert.equal(needsOrderWrite({ order:0 }, { order:0 }), false);
  assert.equal(needsOrderWrite({ order:10 }, { order:0 }), true);
});
