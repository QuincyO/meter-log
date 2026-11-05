import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupPendingRoutes,
  defaultRouteGroup,
  reorderRouteGroup,
  buildRouteMapModel,
  routeCardState,
  needsOrderWrite,
  routeLegs,
  legKey,
  START_ID,
  groupRoutePins,
  pinFace,
  reorderWithinPin,
  liveStartFix,
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

// ── pack-measured leg paths (the fix for roads vanishing after a reorder) ─────
// The saved polylines are keyed to the sequence they were fetched for, so the
// today anchor — which re-leads the pending list after every logged stop — used
// to strand a phone with a perfectly good district on straight lines all day.
// `routeLegs` asks for the legs on screen and `computed` answers for those.

test('routeLegs asks for exactly the legs between consecutive routed stops', () => {
  const a = { id:'a', lat:45.40, lng:-75.65 };
  const b = { id:'b', lat:45.39, lng:-75.60 };
  const c = { id:'c', lat:45.38, lng:-75.55 };
  const { legs, startPoint } = routeLegs([a, b, c], null);
  assert.deepEqual(legs.map(l => l.key), [legKey('a', 'b'), legKey('b', 'c')]);
  assert.equal(startPoint, null);          // no saved drive-out ⇒ no crew start known
});

test('routeLegs skips parked stops and adds the drive-out from the saved start', () => {
  const homeField = VARIANT_FIELDS.road.homeLegGeometry;
  const a = { id:'a', lat:45.40, lng:-75.65,
    [homeField]: encodePolyline([[45.42, -75.70], [45.40, -75.65]]) };
  const parked = { id:'p', lat:45.30, lng:-75.90, geoFail:true };
  const b = { id:'b', lat:45.39, lng:-75.60 };
  const { legs, startPoint } = routeLegs([a, parked, b], homeField);
  assert.deepEqual(legs.map(l => l.key),
    [legKey('a', 'b'), legKey(START_ID, 'a')]);
  assert.deepEqual(startPoint.map(n => Math.round(n * 100) / 100), [45.42, -75.70]);
});

test('a pack-measured leg is drawn even when the saved geometry is gated off', () => {
  // geomField null = exactly what renderMap passes once variantMatchesLive fails.
  const a = { id:'a', lat:45.40, lng:-75.65 };
  const b = { id:'b', lat:45.39, lng:-75.60 };
  const road = [[45.40, -75.65], [45.395, -75.63], [45.39, -75.60]];
  const computed = new Map([[legKey('a', 'b'), road]]);
  const model = buildRouteMapModel([a, b], null, null, computed);
  assert.deepEqual(model.path, [[45.40, -75.65], ...road]);
});

test('a pack-measured leg beats a saved polyline from an older sequence', () => {
  const geomField = VARIANT_FIELDS.road.geometry;
  const a = { id:'a', lat:45.40, lng:-75.65 };
  const b = { id:'b', lat:45.39, lng:-75.60,
    [geomField]: encodePolyline([[45.0, -79.0], [45.1, -79.1]]) };   // stale
  const road = [[45.40, -75.65], [45.39, -75.60]];
  const model = buildRouteMapModel([a, b], geomField, null,
    new Map([[legKey('a', 'b'), road]]));
  assert.deepEqual(model.path.slice(1), road);
});

test('a leg the pack cannot carry still falls back to saved, then straight', () => {
  const geomField = VARIANT_FIELDS.road.geometry;
  const saved = [[45.40, -75.65], [45.399, -75.62], [45.39, -75.60]];
  const a = { id:'a', lat:45.40, lng:-75.65 };
  const b = { id:'b', lat:45.39, lng:-75.60, [geomField]: encodePolyline(saved) };
  const c = { id:'c', lat:45.38, lng:-75.55 };
  // Pack answered for b→c only; a→b keeps the saved path, nothing is straightened.
  const model = buildRouteMapModel([a, b, c], geomField, null,
    new Map([[legKey('b', 'c'), [[45.39, -75.60], [45.38, -75.55]]]]));
  const round = p => p.map(n => Math.round(n * 1000) / 1000);
  assert.deepEqual(model.path.slice(1, 4).map(round), saved.map(round));
  // …and with no computed path and no saved geometry it is a plain segment.
  const bare = buildRouteMapModel([a, c], null, null, null);
  assert.deepEqual(bare.path, [[45.40, -75.65], [45.40, -75.65], [45.38, -75.55]]);
});

test('a measured drive-out replaces the saved one; the start pin is unmoved', () => {
  const homeField = VARIANT_FIELDS.road.homeLegGeometry;
  const a = { id:'a', lat:45.40, lng:-75.65,
    [homeField]: encodePolyline([[45.42, -75.70], [45.40, -75.65]]) };
  const road = [[45.42, -75.70], [45.41, -75.68], [45.40, -75.65]];
  const model = buildRouteMapModel([a], null, homeField,
    new Map([[legKey(START_ID, 'a'), road]]));
  assert.equal(model.driveOut.length, 3);
  assert.deepEqual(model.start.map(n => Math.round(n * 100) / 100), [45.42, -75.70]);
});

// ── pins that share a location ───────────────────────────────────────────────
const stop = (id, lat, lng, address, extra = {}) => ({ id, lat, lng, address, wlStatus:'pending', ...extra });
const pinsOf = items => groupRoutePins(buildRouteMapModel(items).markers);
const pinIds = pins => pins.map(p => p.stops.map(s => s.item.id));

test('stops on the exact same coordinates share one pin', () => {
  const pins = pinsOf([
    stop('a', 42.8370, -80.3040, '236 West St, Simcoe', { unit:'upr' }),
    stop('b', 42.8370, -80.3040, '236 West St, Simcoe', { unit:'lwr' }),
  ]);
  assert.deepEqual(pinIds(pins), [['a', 'b']]);
  assert.deepEqual(pins[0].point, [42.8370, -80.3040]);
});

test('units of one street address merge even when their pins landed slightly apart', () => {
  const pins = pinsOf([
    stop('a', 42.83700, -80.30400, '272 West St, Simcoe'),
    stop('b', 42.83704, -80.30404, '272 West St, Simcoe'),
  ]);
  assert.deepEqual(pinIds(pins), [['a', 'b']]);
});

test('the same address more than 50 m apart stays two pins', () => {
  // siteKey drops the town, so "12 Main St" in two towns has one key.
  const pins = pinsOf([
    stop('a', 42.8370, -80.3040, '12 Main St, Simcoe'),
    stop('b', 42.9000, -80.4000, '12 Main St, Delhi'),
  ]);
  assert.deepEqual(pinIds(pins), [['a'], ['b']]);
});

test('a street with no civic number never merges by address', () => {
  // siteKey falls back to the road alone, which would join a whole street.
  const pins = pinsOf([
    stop('a', 42.83700, -80.30400, 'West St, Simcoe'),
    stop('b', 42.83704, -80.30404, 'West St, Simcoe'),
  ]);
  assert.deepEqual(pinIds(pins), [['a'], ['b']]);
});

test('next-door houses stay separate pins however close they are', () => {
  const pins = pinsOf([
    stop('a', 42.83700, -80.30400, '236 West St, Simcoe'),
    stop('b', 42.83702, -80.30402, '238 West St, Simcoe'),
  ]);
  assert.deepEqual(pinIds(pins), [['a'], ['b']]);
});

test('a parked stop keeps its own pin even on a shared spot', () => {
  const pins = pinsOf([
    stop('a', 42.8370, -80.3040, '236 West St, Simcoe'),
    stop('b', 42.8370, -80.3040, '236 West St, Simcoe', { geoFail:true }),
  ]);
  assert.deepEqual(pinIds(pins), [['a'], ['b']]);
});

test('a return visit shares a pin and keeps both route positions', () => {
  const pins = pinsOf([
    stop('a', 42.8370, -80.3040, '236 West St, Simcoe'),
    stop('b', 42.8400, -80.3100, '9 Queen St, Simcoe'),
    stop('c', 42.8370, -80.3040, '236 West St, Simcoe'),
  ]);
  assert.deepEqual(pinIds(pins), [['a', 'c'], ['b']]);
  assert.deepEqual(pins[0].stops.map(s => s.position), [1, 3]);
});

test('merging pins leaves the route line running through every stop', () => {
  const model = buildRouteMapModel([
    stop('a', 42.83700, -80.30400, '272 West St, Simcoe'),
    stop('b', 42.83704, -80.30404, '272 West St, Simcoe'),
  ]);
  groupRoutePins(model.markers);
  assert.equal(model.markers.length, 2);
  assert.deepEqual(model.line, [[42.83700, -80.30400], [42.83704, -80.30404]]);
});

const face = positions => pinFace(positions.map(position => ({ position, parked:false })));

test('a single stop keeps the plain 30px pin', () => {
  const f = face([7]);
  assert.equal(f.size, 30);
  assert.equal(f.className, 'wl-route-pin');
  assert.equal(f.html, '<span>7</span>');
});

test('a parked pin still reads as a warning', () => {
  const f = pinFace([{ position:4, parked:true }]);
  assert.equal(f.className, 'wl-route-pin parked');
  assert.equal(f.html, '<span>!</span>');
});

test('two to four stops split the pin, one section per route position', () => {
  assert.equal(face([12, 13]).size, 38);
  assert.equal(face([12, 13]).className, 'wl-route-pin split n2');
  assert.equal(face([12, 13]).html, '<span>12</span><span>13</span>');
  assert.equal(face([3, 4, 9]).className, 'wl-route-pin split n3');
  assert.equal(face([3, 4, 8, 9]).className, 'wl-route-pin split n4');
});

test('three and four sections get a bigger pin, or two-digit numbers clip on the circle', () => {
  assert.equal(face([9, 10, 11]).size, 44);
  assert.equal(face([9, 10, 11, 12]).size, 44);
});

test('five or more stops show a count instead of sections', () => {
  const f = face([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(f.className, 'wl-route-pin split count');
  assert.equal(f.html, '<span>×8</span>');
});

// ── reordering inside one pin ────────────────────────────────────────────────
const dayOf = (...ids) => ids.map((id, i) => ({ id, wlStatus:'pending', day:1, order:i * 10 }));

test('moving a stop swaps it with its neighbour at the pin', () => {
  assert.deepEqual(reorderWithinPin(dayOf('a', 'b', 'c', 'd'), ['b', 'c'], 'c', -1), ['a', 'c', 'b', 'd']);
});

test('a pin with a gap swaps its two slots and leaves the stops between alone', () => {
  assert.deepEqual(reorderWithinPin(dayOf('a', 'b', 'c', 'd'), ['a', 'd'], 'a', 1), ['d', 'b', 'c', 'a']);
});

test('there is nowhere to move past either end of the pin', () => {
  assert.equal(reorderWithinPin(dayOf('a', 'b', 'c'), ['a', 'b'], 'a', -1), null);
  assert.equal(reorderWithinPin(dayOf('a', 'b', 'c'), ['a', 'b'], 'b', 1), null);
});

test('a move skips over a locked stop at the pin', () => {
  const items = dayOf('a', 'b', 'c');
  Object.assign(items[1], { lockedDate:'2026-11-05', lockedSlot:2 });
  assert.deepEqual(reorderWithinPin(items, ['a', 'b', 'c'], 'a', 1), ['c', 'b', 'a']);
});

test('a locked stop does not move', () => {
  const items = dayOf('a', 'b');
  Object.assign(items[0], { lockedDate:'2026-11-05', lockedSlot:1 });
  assert.equal(reorderWithinPin(items, ['a', 'b'], 'a', 1), null);
});

test('a pin move goes through the normal reorder without disturbing a lock', () => {
  const items = dayOf('a', 'b', 'c');
  Object.assign(items[1], { lockedDate:'2026-11-05', lockedSlot:2 });
  const ids = reorderWithinPin(items, ['a', 'b', 'c'], 'c', -1);
  assert.deepEqual(reorderRouteGroup(items, 'day:1', ids).map(x => x.id), ['c', 'b', 'a']);
});

// ── the route's real start ───────────────────────────────────────────────────
const meetField = VARIANT_FIELDS.road.homeLegGeometry;
const firstWithMeet = () => ({ id:'a', lat:42.84, lng:-80.30,
  [meetField]: encodePolyline([[43.50, -80.90], [42.84, -80.30]]) });

test('a GPS start replaces the morning meet as the drive-out start', () => {
  const model = buildRouteMapModel([firstWithMeet()], null, meetField, null, [42.80, -80.20]);
  assert.deepEqual(model.start, [42.80, -80.20]);
  assert.deepEqual(model.driveOut, [[42.80, -80.20], [42.84, -80.30]]);
});

test('a GPS start still takes the road path when one was measured', () => {
  const measured = [[42.80, -80.20], [42.82, -80.25], [42.84, -80.30]];
  const computed = new Map([[legKey(START_ID, 'a'), measured]]);
  const model = buildRouteMapModel([firstWithMeet()], null, meetField, computed, [42.80, -80.20]);
  assert.deepEqual(model.driveOut, measured);
});

test('routeLegs measures the drive-out from the GPS start, not the morning meet', () => {
  const { legs, startPoint } = routeLegs([firstWithMeet()], meetField, [42.80, -80.20]);
  assert.deepEqual(startPoint, [42.80, -80.20]);
  assert.deepEqual(legs[0].from, { lat:42.80, lng:-80.20 });
});

test('with no GPS start the morning meet is still the start', () => {
  const model = buildRouteMapModel([firstWithMeet()], null, meetField);
  assert.deepEqual(model.start.map(n => Math.round(n * 100) / 100), [43.50, -80.90]);
});

const savedFix = { lat:42.80, lng:-80.20, date:'2026-11-05', left:13 };

test('a saved start fix is live on its own plan day', () => {
  assert.deepEqual(liveStartFix(savedFix, '2026-11-05', 13), [42.80, -80.20]);
});

test('a start fix from another day is ignored', () => {
  assert.equal(liveStartFix(savedFix, '2026-11-06', 13), null);
});

test('logging a stop retires the start fix', () => {
  assert.equal(liveStartFix(savedFix, '2026-11-05', 12), null);
});

test('no saved fix, or a malformed one, means no override', () => {
  assert.equal(liveStartFix(null, '2026-11-05', 13), null);
  assert.equal(liveStartFix({ date:'2026-11-05', left:13 }, '2026-11-05', 13), null);
});
