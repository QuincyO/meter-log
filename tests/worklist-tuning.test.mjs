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

test('the device-local block carries the Navigate destination toggle', () => {
  const local = html.match(/<div class="tune-local">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.ok(local, 'the .tune-local block is gone');
  // Below Save, with the other never-uploaded preference — it changes nothing the
  // office or the router reads, so it has no business among the syncing dials.
  assert.match(local, /id="tuneNavByAddress"[^>]*type="checkbox"/);
  // Unchecked = the pin = the behaviour before the toggle existed.
  assert.doesNotMatch(local, /id="tuneNavByAddress"[^>]*checked/);
  // The hint is the point of the feature: why you'd switch, not just that you can.
  const hint = local.split('id="tuneNavByAddress"')[1] || '';
  assert.match(hint, /class="muted tune-hint"/);
  assert.match(hint, /map pin/);
  assert.match(hint, /address/);
});

const tuningJs = readFileSync(new URL('../js/worklist-tuning.js', import.meta.url), 'utf8');

test('the Navigate toggle saves on tap, outside the Save/Upload path', () => {
  assert.match(tuningJs, /export function navByPin\(/);
  assert.match(tuningJs, /export function setNavByPin\(/);
  assert.match(tuningJs, /\$\('tuneNavByAddress'\)\.onchange\s*=/);
  assert.match(tuningJs, /\$\('tuneNavByAddress'\)\.checked = !navByPin\(\)/);
  // save() toasts "Upload your list to sync these to the office" — a lie about a
  // key that never leaves the phone. Like driveShowMetrics, this one is instant.
  const saveBody = tuningJs.match(/function save\(\)\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(saveBody, /wlNavBy|setNavByPin/,
    'the Navigate preference must not be written by save()');
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
