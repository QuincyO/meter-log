import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedDailyStops } from '../js/worklist-tuning.js';

// 08:15 depart, 14:00 finish, 60-min break, 24 min/stop pace.
test('expected stops at the 14:00 default', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:840, pace:24 }), 11);
});

test('an earlier finish fits fewer stops', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:780, pace:24 }), 8);
});

test('null when the finish time is unusable or pace is missing', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:null, pace:24 }), null);
  assert.equal(expectedDailyStops({ departMin:495, finishMin:840, pace:0 }), null);
  assert.equal(expectedDailyStops({ departMin:495, finishMin:520, pace:24 }), null); // break eats the day
});

test('the service worker ships the tuning module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/worklist-tuning\.js'/);
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the capture nav offers a route-tuning entry', () => {
  assert.match(html, /<button id="navTuning">[^<]*Route tuning<\/button>/);
});

test('the tuning screen has both dials, a readout and a save', () => {
  assert.match(html, /id="tuningScreen"/);
  assert.match(html, /id="tuneCommutePull"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  assert.match(html, /id="tuneFinishBy"[^>]*type="time"/);
  assert.match(html, /id="tuneReadout"/);
  assert.match(html, /id="tuneSave"/);
  // the org-wide leave time is shown as read-only context, not an input
  assert.match(html, /08:15/);
});
