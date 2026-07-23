import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeTrack, decodeTrack, haversineM, segmentSummary, finalizeSegment,
  createSegment, addFix, markPause, markResume, isWorthUploading,
  MIN_MOVE_M, MIN_GAP_S,
} from '../js/drive-track.js';

const T0 = 1_700_000_000_000; // fixed epoch ms so tests are deterministic

// A short leg of realistic Muskoka-ish coordinates, one fix ~every 4 s.
const leg = [
  { lat: 45.03210, lng: -79.30110, t: T0 + 0,     spd: 0 },
  { lat: 45.03260, lng: -79.30020, t: T0 + 4000,  spd: 12.4 },
  { lat: 45.03340, lng: -79.29880, t: T0 + 8000,  spd: 15.1 },
  { lat: 45.03420, lng: -79.29710, t: T0 + 12000, spd: 16.8 },
];

test('encodeTrack/decodeTrack round-trips within tolerance', () => {
  const back = decodeTrack(encodeTrack(leg), leg[0].t);
  assert.equal(back.length, leg.length);
  back.forEach((p, i) => {
    assert.ok(Math.abs(p.lat - leg[i].lat) <= 1e-5, `lat ${i}`);
    assert.ok(Math.abs(p.lng - leg[i].lng) <= 1e-5, `lng ${i}`);
    assert.ok(Math.abs(p.t - leg[i].t) <= 1000, `t ${i}`);
    assert.ok(Math.abs(p.spd - leg[i].spd) <= 0.05, `spd ${i}`);
  });
});

test('encodeTrack handles a large absolute timestamp without 32-bit overflow', () => {
  // Relative-time encoding is the guard: epoch ms << 1 would overflow int32.
  const back = decodeTrack(encodeTrack(leg), leg[0].t);
  assert.equal(back[3].t, leg[3].t);
});

test('empty track encodes to an empty string and decodes to nothing', () => {
  assert.equal(encodeTrack([]), '');
  assert.deepEqual(decodeTrack('', T0), []);
});

test('haversineM matches a known short distance', () => {
  // ~111 m for 0.001° of latitude.
  const d = haversineM({ lat: 45, lng: -79 }, { lat: 45.001, lng: -79 });
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});

test('addFix derives speed from the move when the device gives none', () => {
  const seg = createSegment({ id: 's1' });
  addFix(seg, { lat: 45.0, lng: -79.0, t: T0 });
  const kept = addFix(seg, { lat: 45.001, lng: -79.0, t: T0 + 10000 }); // ~111 m in 10 s ⇒ ~11.1 m/s
  assert.equal(kept, true);
  assert.ok(Math.abs(seg.points[1].spd - 11.1) < 0.3, `derived spd ${seg.points[1].spd}`);
});

test('addFix filters a near-duplicate fix (little move AND little time)', () => {
  const seg = createSegment({ id: 's1' });
  addFix(seg, { lat: 45.0, lng: -79.0, t: T0, spd: 0 });
  const kept = addFix(seg, { lat: 45.00005, lng: -79.0, t: T0 + 1000, spd: 0 }); // ~5.5 m, 1 s
  assert.equal(kept, false);
  assert.equal(seg.points.length, 1);
  // A large-enough time gap keeps it even without moving.
  assert.equal(addFix(seg, { lat: 45.00005, lng: -79.0, t: T0 + 5000, spd: 0 }), true);
});

test('markPause/markResume record a gap anchor and a flagged resume point', () => {
  const seg = createSegment({ id: 's1' });
  addFix(seg, { lat: 45.0, lng: -79.0, t: T0, spd: 10 });
  addFix(seg, { lat: 45.002, lng: -79.0, t: T0 + 8000, spd: 12 });
  markPause(seg); // driver hands off to Google Maps here
  markResume(seg, { lat: 45.02, lng: -79.03, t: T0 + 600000, spd: 8 }); // back 10 min later, far away
  assert.equal(seg.gaps.length, 1);
  assert.deepEqual(seg.gaps[0], {
    pauseLat: 45.002, pauseLng: -79.0, pauseT: T0 + 8000,
    resumeLat: 45.02, resumeLng: -79.03, resumeT: T0 + 600000,
  });
  assert.equal(seg.points[seg.points.length - 1].gap, true);
});

test('segmentSummary excludes the pause→resume jump from driven distance', () => {
  const seg = createSegment({ id: 's1' });
  addFix(seg, { lat: 45.0, lng: -79.0, t: T0, spd: 10 });
  addFix(seg, { lat: 45.002, lng: -79.0, t: T0 + 8000, spd: 12 }); // ~222 m driven
  const withGap = createSegment({ id: 's2' });
  addFix(withGap, { lat: 45.0, lng: -79.0, t: T0, spd: 10 });
  addFix(withGap, { lat: 45.002, lng: -79.0, t: T0 + 8000, spd: 12 });
  markPause(withGap);
  markResume(withGap, { lat: 45.5, lng: -79.5, t: T0 + 600000, spd: 8 }); // huge jump, must not count
  assert.equal(segmentSummary(seg.points).distanceM, segmentSummary(withGap.points).distanceM);
});

test('segmentSummary reports max speed and point count', () => {
  const s = segmentSummary(leg);
  assert.equal(s.pointCount, 4);
  assert.equal(s.maxSpeed, 16.8);
  assert.ok(s.distanceM > 0);
  assert.ok(s.avgSpeed > 0);
});

test('finalizeSegment assembles the Sheet row', () => {
  const seg = createSegment({ id: 'seg-1', installer: 'Sam', date: '2026-07-23', workType: 'land' });
  leg.forEach(f => addFix(seg, f));
  const row = finalizeSegment(seg);
  assert.equal(row.id, 'seg-1');
  assert.equal(row.installer, 'Sam');
  assert.equal(row.date, '2026-07-23');
  assert.equal(row.workType, 'land');
  assert.equal(row.startTime, leg[0].t);
  assert.equal(row.endTime, leg[3].t);
  assert.equal(row.pointCount, 4);
  assert.deepEqual(row.gaps, []);
  // The encoded polyline round-trips back to the recorded points.
  assert.equal(decodeTrack(row.encoded, row.startTime).length, 4);
});

test('isWorthUploading needs at least two points', () => {
  const seg = createSegment({ id: 's1' });
  assert.equal(isWorthUploading(seg), false);
  addFix(seg, { lat: 45.0, lng: -79.0, t: T0, spd: 0 });
  assert.equal(isWorthUploading(seg), false);
  addFix(seg, { lat: 45.002, lng: -79.0, t: T0 + 8000, spd: 5 });
  assert.equal(isWorthUploading(seg), true);
});

test('MIN_MOVE_M / MIN_GAP_S are the documented dials', () => {
  assert.equal(MIN_MOVE_M, 15);
  assert.equal(MIN_GAP_S, 3);
});
