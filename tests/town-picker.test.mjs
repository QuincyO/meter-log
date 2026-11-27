// The "Which town?" map picker (js/town-picker.js) and how the worklist reaches
// it. Owner's request, 2026-11-27: a tie between two towns is never settled for
// the installer — they pick, on a map, with the pin nearest them highlighted, and
// a one-tap "Use nearest town for all" when there are many.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nearestIndex, townOptions } from '../js/town-picker.js';

const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');

const A = { label: '10 Main St, Neartown', lat: 43.08, lng: -81.0 };
const B = { label: '10 Main St, Fartown', lat: 43.40, lng: -81.0 };
const ME = { lat: 43.0, lng: -81.0 };

test('the town pickBest marked nearest is the one highlighted, wherever it sits', () => {
  // Marked by pickBest from the Optimize gate centre, so the chips, the map and
  // "nearest for all" agree even when the live fix says otherwise.
  const cands = [{ ...B, km: 44.5 }, { ...A, km: 8.9, near: true }];
  assert.equal(nearestIndex(cands, { lat: 43.41, lng: -81.0 }), 1);
  const rows = townOptions(cands, null);
  assert.deepEqual(rows.map(r => [r.key, r.nearest, r.km]), [['A', false, 44.5], ['B', true, 8.9]]);
});

test('a list saved before the mark falls back to the phone, and to nothing without one', () => {
  assert.equal(nearestIndex([B, A], ME), 1);
  assert.equal(nearestIndex([B, A], null), -1);
  const rows = townOptions([B, A], ME);
  assert.equal(rows[1].nearest, true);
  assert.ok(Math.abs(rows[1].km - 8.9) < 0.2, String(rows[1].km));
  assert.deepEqual(townOptions([B, A], null).map(r => r.km), [null, null]);
});

test('the picker is loaded lazily and stays out of the service-worker shell', async () => {
  const [worklist, sw] = await Promise.all([read('js/worklist.js'), read('sw.js')]);
  // Any sw.js change re-downloads the shell on every phone (AGENTS.md), and a
  // static import of a file the phone cannot fetch would kill the capture module.
  assert.doesNotMatch(sw, /town-picker/);
  assert.match(worklist, /import\('\.\/town-picker\.js'\)/);
  assert.doesNotMatch(worklist, /^import[^;]*town-picker/m);
});

test('every pick-a-town chip row offers the map and marks the nearest', async () => {
  const [worklist, fill] = await Promise.all([read('js/worklist.js'), read('js/worklist-address-fill.js')]);
  assert.match(worklist, /function townChipsHtml/);
  assert.match(worklist, /tp-mapchip[\s\S]*★ nearest/);
  // Card and Edit form both go through the one helper.
  assert.equal((worklist.match(/(?<!function )townChipsHtml\(cands\)/g) || []).length, 2);
  // The address screen gets the map only when worklist.js hands it the function,
  // so a new fill module against an old worklist.js shows no dead chip.
  assert.match(fill, /typeof opts\.showTownMap === 'function'/);
  assert.match(worklist, /showTownMap,/);
});

test('"Use nearest town for all" takes only the marked town and shares the pick write', async () => {
  const worklist = await read('js/worklist.js');
  const fn = worklist.slice(worklist.indexOf('async function pickNearestAll'), worklist.indexOf('function townsBanner'));
  assert.match(fn, /find\(x => x && x\.near\)/);
  assert.match(fn, /townPatch\(c, c\.label\)/);
  assert.doesNotMatch(fn, /syncWorklist|apiPost/, 'an edit on this screen never uploads by itself');
  const pick = worklist.slice(worklist.indexOf('async function pickTown'), worklist.indexOf('async function pinOnline'));
  assert.match(pick, /townPatch\(c, address\)/);
});
