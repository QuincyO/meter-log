import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDay } from '../js/compute/estimate.js';

// Three installs 30 min apart → a 30 min/stop cadence.
const stops = [
  { id:'a', status:'INSTALLED', workOrderId:'1', timestamp:'2026-07-24 08:00:00' },
  { id:'b', status:'INSTALLED', workOrderId:'2', timestamp:'2026-07-24 08:30:00' },
  { id:'c', status:'INSTALLED', workOrderId:'3', timestamp:'2026-07-24 09:00:00' },
];

test('before end of day, projects to the 3:30 horizon', () => {
  const est = projectDay(stops, 12 * 60);           // noon
  assert.equal(est.ready, true);
  assert.equal(est.label, '3:30');
  assert.equal(est.avgCadence, 30);
  // 3.5h left / 30 min = 7 more, on top of the 3 done.
  assert.equal(est.projected, 10);
});

test('past 3:30, switches to the 4:30 OT ceiling', () => {
  const est = projectDay(stops, 15 * 60 + 45);      // 3:45 PM, into OT
  assert.equal(est.label, '4:30 OT');
  // 45 min left to 4:30 / 30 min = 2 more.
  assert.equal(est.projected, 5);
});

test('needs at least one gap before it is ready', () => {
  const est = projectDay(stops.slice(0, 1), 12 * 60);
  assert.equal(est.ready, false);
  assert.equal(est.done, 1);
});
