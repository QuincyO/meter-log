import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The 'Target finish time' dial is gone. It did two jobs — projected the day's
// landing and, invisibly, SHRANK the day below the meters/day target — and the
// second made the target inert above whatever ceiling the clock implied. The
// projection lives on, anchored on the fixed config.js ROUTE_DAY_END.
test('the service worker ships the tuning module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/worklist-tuning\.js'/);
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the capture nav offers a route-tuning entry', () => {
  assert.match(html, /<button id="navTuning">[^<]*Route tuning<\/button>/);
});

test('the tuning screen has its dial, a readout and a save', () => {
  assert.match(html, /id="tuningScreen"/);
  assert.match(html, /id="tuneCommutePull"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  // No finish-time input: the meters/day target is the only day-sizing control now.
  assert.doesNotMatch(html, /id="tuneFinishBy"/);
  assert.match(html, /id="tuneReadout"/);
  assert.match(html, /id="tuneSave"/);
  // the org-wide leave time is shown as read-only context, not an input
  assert.match(html, /08:15/);
});

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const captureJs = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

test('worklist routes #tuning and exports an opener', () => {
  assert.match(worklistJs, /import\s*\{[^}]*\binitWorklistTuning\b[^}]*\}\s*from\s*'\.\/worklist-tuning\.js'/);
  assert.match(worklistJs, /location\.hash === '#tuning'/);
  assert.match(worklistJs, /export function openTuning\(/);
});

test('the capture nav opens the tuning screen', () => {
  assert.match(captureJs, /openTuning/);
  assert.match(captureJs, /\$\('navTuning'\)\.onclick/);
});
