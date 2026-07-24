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
