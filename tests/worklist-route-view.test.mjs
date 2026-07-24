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
import { decodePolyline, encodePolyline } from '../js/route.js';
import { VARIANT_FIELDS } from '../js/route-variants.js';

const item = (id, order, day = '', wlStatus = 'pending') => ({
  id, order, day, wlStatus, address: `Stop ${id}`,
});

test('a first stop with drive-out geometry yields a separate faint segment + start', () => {
  const homeField = VARIANT_FIELDS.road.homeLegGeometry;   // 'homeLegGeometryRoad'
  const first = { id:'a', lat:45.40, lng:-75.65,
    [homeField]: encodePolyline([[45.42, -75.70], [45.40, -75.65]]) };
  const second = { id:'b', lat:45.39, lng:-75.60 };
  const model = buildRouteMapModel([first, second], null, homeField);
  assert.equal(model.driveOut.length, 2);
  assert.deepEqual(model.start.map(n => Math.round(n * 100) / 100), [45.42, -75.70]);
  // path still begins at the first stop, not the crew start.
  assert.deepEqual(model.path[0].map(n => Math.round(n * 100) / 100), [45.40, -75.65]);
});

test('no drive-out geometry means no start and an empty driveOut', () => {
  const model = buildRouteMapModel([{ id:'a', lat:45.4, lng:-75.6 }], null, 'homeLegGeometryRoad');
  assert.equal(model.start, null);
  assert.deepEqual(model.driveOut, []);
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

test('path follows saved road geometry per leg and falls back to a straight leg', () => {
  // The classic polyline5 example: three points along a curve. On-device decode
  // only — no network. The phone has no home anchor, so the first stop just
  // starts the line; the a→b leg follows its saved geometry; b→c has none and
  // draws straight (an edited/quick-change leg).
  const geom = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const decoded = decodePolyline(geom);
  const model = buildRouteMapModel([
    { ...item('a', 0, 1), lat:38.5, lng:-120.2 },
    { ...item('b', 10, 1), lat:40.7, lng:-120.95, legGeometryRoad:geom },
    { ...item('c', 20, 1), lat:43.252, lng:-126.453 },
  ], 'legGeometryRoad');

  assert.deepEqual(model.path, [
    [38.5, -120.2],                          // first routed stop starts the line
    ...decoded,                              // a → b follows the saved road path
    [40.7, -120.95], [43.252, -126.453],     // b → c straight (no saved geometry)
  ]);
});

test('drops saved geometry when the caller withholds the field (stale after a drag)', () => {
  // After a manual reorder the live order no longer matches the order the geometry
  // was fetched against, so renderMap passes no geomField — the leg must draw
  // straight pin-to-pin, never the previous route's roads (the "line to home" bug).
  const geom = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const model = buildRouteMapModel([
    { ...item('a', 0, 1), lat:38.5, lng:-120.2 },
    { ...item('b', 10, 1), lat:40.7, lng:-120.95, legGeometryRoad:geom },
  ], null);
  assert.deepEqual(model.path, [
    [38.5, -120.2],                        // first routed stop starts the line
    [38.5, -120.2], [40.7, -120.95],       // a → b straight (saved geometry ignored)
  ]);
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
