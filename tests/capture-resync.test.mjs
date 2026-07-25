// Coming back to the foreground must sync BOTH directions.
//
// The bug this guards: visibilitychange/focus were wired to flush() alone, which
// drains the outbound queue and pulls nothing. A phone left open all day on good
// signal re-read the server zero times, so an installer running two phones saw the
// order they had just completed on one of them stay missing on the other until they
// re-opened the list by hand. See js/pages/capture.js resync().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

test('foreground events call resync(), not bare flush()', () => {
  const visibility = src.match(/visibilitychange'[\s\S]{0,200}?\}\);/);
  assert.ok(visibility, 'the visibilitychange listener should still exist');
  assert.match(visibility[0], /resync\(\)/,
    'visibilitychange must resync (both directions), not just flush the queue');

  assert.match(src, /addEventListener\('focus',\s*resync\)/,
    'the focus listener must resync too');
});

test('resync re-pulls the open day', () => {
  const fn = src.match(/function resync\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'resync() should exist');
  assert.match(fn[0], /flush\(\)/,      'resync still drains the outbound queue');
  assert.match(fn[0], /loadDay\(mode\)/, 'resync must pull the server copy of the open day');
});

test('resync is guarded so it costs nothing when no day sheet is open', () => {
  const fn = src.match(/function resync\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if\(!mode\) return;/,
    'a foreground with no day sheet open must not make a spine call');
  assert.match(fn, /RESYNC_MIN_MS/,
    'repeated foreground events must be throttled — iOS fires visibilitychange and focus together');
});

test('openDayMode reads sheet visibility rather than tracking state separately', () => {
  const fn = src.match(/function openDayMode\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'openDayMode() should exist');
  // closeSheets() adds .hide to every .sheet, so absence of .hide IS "open".
  // Deriving it avoids a second source of truth that can drift out of sync.
  assert.match(fn[0], /classList\.contains\('hide'\)/);
  assert.match(fn[0], /eodSheet/);
  assert.match(fn[0], /todaySheet/);
});

test('loadDay stamps the throttle so a button press and a foreground do not double-pull', () => {
  const fn = src.match(/async function loadDay\(mode\)\{[\s\S]{0,400}/);
  assert.ok(fn);
  assert.match(fn[0], /lastPull = Date\.now\(\)/,
    'every loadDay caller should feed the throttle, not just resync()');
});
