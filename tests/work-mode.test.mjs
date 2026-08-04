import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODE_KEY, workMode, setWorkMode } from '../js/work-mode.js';
import { store } from '../js/store.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const helpHtml  = read('help.html');
const teamsHtml = read('teams.html');
const teamsJs   = read('js/pages/teams.js');
const captureJs = read('js/pages/capture.js');
const recorder  = read('js/drive-recorder.js');
const modeJs    = read('js/work-mode.js');
const captureCss = read('css/capture.css');
const worker    = read('sw.js');

// Boat work came back on 2026-08-04 and the switch came back with it — but into
// the Settings sheet, not the top bar it was removed from on 2026-07-31. These
// tests pin the two things that decide whether a crew logs the right day: land
// is what you get when nobody has chosen, and the switch is somewhere a thumb
// cannot reach by accident.

test('land is the default, and the legacy key is never consulted', () => {
  // THE landmine. Boat was the ORIGINAL default under the old `workMode` key, so
  // every phone in the field still holds a literal workMode='boat'. Reading that
  // key again — even with a land default — would put the whole fleet back on boat
  // on the next load, because a default never fires on a key that is already set.
  // The key was renamed rather than migrated. Never read 'workMode' again.
  store.set('workMode', 'boat');
  assert.equal(workMode(), 'land', 'the abandoned workMode key is being read again');
  // The module may still *delete* the legacy key (it sweeps it once on load) —
  // what it must never do is read one back.
  assert.ok(!/(store\.get|getItem)\('workMode'\)/.test(modeJs),
    'js/work-mode.js reads the legacy key');
  assert.equal(MODE_KEY, 'captureWorkMode');

  store.set(MODE_KEY, '');
  assert.equal(workMode(), 'land', 'an unset mode must be land');
});

test('the mode round-trips through the new key and sticks', () => {
  setWorkMode('boat');
  assert.equal(store.get(MODE_KEY), 'boat');
  assert.equal(workMode(), 'boat');
  setWorkMode('land');
  assert.equal(workMode(), 'land');
  // Anything that is not exactly 'boat' is land — garbage in storage (a half
  // written value, a key someone hand-edited) must never strand a crew on boat.
  setWorkMode('nonsense');
  assert.equal(workMode(), 'land');
  store.set(MODE_KEY, 'BOAT');
  assert.equal(workMode(), 'land');
  store.set(MODE_KEY, '');
});

test('the lock is gone, with no dead constant left to re-arm it', () => {
  for (const [name, src] of [['js/work-mode.js', modeJs], ['js/pages/capture.js', captureJs]])
    assert.ok(!src.includes('LOCKED_MODE'), `${name} still carries LOCKED_MODE`);
});

test('the switch is in the Settings sheet, not the top bar', () => {
  // Positional, not a bare "index.html contains modeBoat" — that would pass if
  // someone put it straight back on the bar, which is the thing 2026-07-31 was
  // about. It has to sit inside #settingsSheet, which runs to #downtimeSheet.
  const settings = indexHtml.indexOf('id="settingsSheet"');
  const downtime = indexHtml.indexOf('id="downtimeSheet"');
  assert.ok(settings > 0 && downtime > settings, 'the settings sheet moved — re-anchor this test');
  for (const id of ['modeBoat', 'modeLand']) {
    const at = indexHtml.indexOf(`id="${id}"`);
    assert.ok(at > settings && at < downtime, `#${id} is not inside the Settings sheet`);
  }
  const bar = indexHtml.slice(indexHtml.indexOf('<div class="bar">'), settings);
  assert.ok(!bar.includes('mode-seg'), 'the work-mode switch is back on the top bar');
});

test('the markup and its wiring ship together', () => {
  // $('modeBoat').onclick on a missing element throws at module evaluation and
  // takes the WHOLE capture page down — not just the switch.
  for (const id of ['modeBoat', 'modeLand']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html is missing #${id}`);
    assert.ok(captureJs.includes(`$('${id}').onclick`), `capture.js does not wire #${id}`);
  }
  assert.match(captureCss, /\.mode-seg\{/, 'css/capture.css does not style the switch');
});

test('setMode repaints everything that follows the mode', () => {
  // Half a setMode is a page whose accent says boat and whose labels say land.
  const body = captureJs.slice(captureJs.indexOf('function setMode('),
                               captureJs.indexOf("$('modeBoat').onclick"));
  for (const bit of ['setWorkMode(', 'dataset.mode', 'paintModeSeg()', 'applyModeUI()'])
    assert.ok(body.includes(bit), `setMode does not run ${bit}`);
  // Reading must not write: the pre-2026-08 boot call was setMode(workMode()),
  // which stamped the key on every load — that is exactly how the old default
  // ended up baked into every phone as a literal value.
  // Anchored to a real statement — the comment above the boot call names the old
  // line on purpose, and a bare .includes() would match that prose.
  assert.ok(!/^\s*setMode\(workMode\(\)\)/m.test(captureJs), 'the boot path writes the key again');
});

test('the pre-paint accent snippet reads the new key on both capture-app pages', () => {
  // These run before first paint. Reading the abandoned key here would flash the
  // boat blue on every open on every phone in the field.
  for (const [name, html] of [['index.html', indexHtml], ['help.html', helpHtml]]) {
    assert.match(html, /getItem\('captureWorkMode'\)/, `${name} does not read captureWorkMode`);
    assert.match(html, /'land'/, `${name} has no land fallback`);
    assert.ok(!/getItem\('workMode'\)/.test(html), `${name} still reads the legacy workMode key`);
  }
});

test('capture.js takes the mode from the one module that owns it', () => {
  assert.match(captureJs, /import \{ workMode, setWorkMode \} from '\.\.\/work-mode\.js'/);
  assert.ok(!/function workMode\(/.test(captureJs), 'capture.js has re-forked its own workMode()');
  // The ~14 workType:workMode() payload sites are the whole point of the mode.
  assert.match(captureJs, /workType:workMode\(\)/);
});

test('the end-of-day summary cache is keyed on the mode', () => {
  // Without this, opening End of day, flipping the mode in Settings and tapping
  // Finish reuses the summary built under the OTHER mode — the crew gets a land
  // PDF for a boat day, silently. Unreachable while the app was locked.
  const key = captureJs.slice(captureJs.indexOf('function eodStateKey()'));
  assert.match(key.slice(0, 500), /workMode\(\)/, 'eodStateKey() ignores the work mode');
});

test('the drive recorder reads workMode(), not the raw key', () => {
  // It cannot import capture.js (capture.js imports IT), which is why the mode
  // lives in its own module.
  assert.ok(!/store\.get\('workMode'\)/.test(recorder),
    'drive-recorder.js still reads the stored workMode key');
  assert.match(recorder, /import \{ workMode \} from '\.\/work-mode\.js'/);
  assert.match(recorder, /workType: workMode\(\) === 'land'/);
});

test('work-mode.js is in the offline shell', () => {
  // A hard import of both capture.js and drive-recorder.js: absent from SHELL
  // is not a degraded feature, it is a capture page that will not open offline.
  assert.ok(worker.includes(`'./js/work-mode.js'`), 'SHELL is missing ./js/work-mode.js');
});

test('route planning stays pinned to land whatever the capture screen says', () => {
  // Deliberate and older than the lock: routing is a land workflow. This is the
  // guard against someone "finishing the job" by swapping in workMode() now that
  // the switch is back.
  for (const p of ['js/worklist.js', 'js/worklist-tuning.js', 'js/pages/planner.js']) {
    const src = read(p);
    assert.match(src, /installerMetrics'[\s\S]{0,120}workType:\s*'land'/,
      `${p} no longer pins its installerMetrics read to land`);
    assert.ok(!/work-mode\.js/.test(src), `${p} should not import the capture work mode`);
  }
});

test('the teams admin page keeps its own switch, on its own key', () => {
  // Both pages have a switch again, so this matters MORE, not less: the separate
  // key is the only thing stopping an admin flipping the office view to Boat from
  // repainting a crew's phone and retagging their day.
  assert.match(teamsHtml, /id="modeBoat"/);
  assert.match(teamsHtml, /id="modeLand"/);
  assert.match(teamsJs, /store\.set\('teamsViewMode', m\)/);
  for (const key of ["'workMode'", "'captureWorkMode'"]) {
    assert.ok(!teamsJs.includes(key), `teams.js reaches for the capture app's ${key}`);
    assert.ok(!teamsHtml.includes(`getItem(${key})`), `teams.html reads the capture app's ${key}`);
  }
  assert.ok(!/^import .*work-mode\.js/m.test(teamsJs), 'teams.js should not import the capture work mode');
});

test('the teams page opens on land, where the live work is', () => {
  assert.match(teamsJs, /store\.get\('teamsViewMode'\)==='boat' \? 'boat' : 'land'/);
  // The markup defaults have to agree with the JS default or the page flashes
  // the other mode's headings before the module runs.
  assert.match(teamsHtml, /id="teamsHead">Land Crews</);
  assert.match(teamsHtml, /id="newTeam"[^>]*>\+ New crew</);
});
