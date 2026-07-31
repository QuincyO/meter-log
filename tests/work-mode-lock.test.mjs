import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCKED_MODE, workMode } from '../js/work-mode.js';
import { store } from '../js/store.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const indexHtml = read('index.html');
const helpHtml  = read('help.html');
const teamsHtml = read('teams.html');
const teamsJs   = read('js/pages/teams.js');
const captureJs = read('js/pages/capture.js');
const recorder  = read('js/drive-recorder.js');
const captureCss = read('css/capture.css');
const worker    = read('sw.js');

// Boat work wound down in July 2026 and the Boat/Land switch came off the
// capture page. These tests pin the lock — every one of them is a way the app
// could quietly start writing boat rows again.

test('the lock is a forced value, not a changed default', () => {
  assert.equal(LOCKED_MODE, 'land');
  // Every phone in the field carries workMode='boat' (boat WAS the default), so
  // a lock that merely defaulted would have left all of them on boat forever
  // with the switch gone. The stored value has to be ignored outright.
  store.set('workMode', 'boat');
  assert.equal(workMode(), 'land');
  store.set('workMode', 'land');
  assert.equal(workMode(), 'land');
});

test('the capture page has no switch left to tap', () => {
  for (const id of ['modeBoat', 'modeLand', 'mode-seg'])
    assert.ok(!indexHtml.includes(id), `index.html still carries ${id}`);
  // The wiring must go with the markup — $('modeBoat').onclick on a missing
  // element throws and takes the whole capture module down at load.
  assert.ok(!captureJs.includes('modeBoat') && !captureJs.includes('modeLand'),
    'capture.js still wires the removed switch');
  assert.ok(!captureCss.includes('.mode-seg{'), 'css/capture.css still styles the removed switch');
});

test('the pre-paint accent snippet is land on both capture-app pages', () => {
  // These run before first paint; reading the stale localStorage key would flash
  // the boat blue on every open.
  for (const [name, html] of [['index.html', indexHtml], ['help.html', helpHtml]]) {
    assert.match(html, /dataset\.mode='land'/, `${name} does not pin the accent to land`);
    assert.ok(!/getItem\('workMode'\)/.test(html), `${name} still reads the workMode key`);
  }
});

test('capture.js takes the mode from the one module that owns it', () => {
  assert.match(captureJs, /import \{ workMode \} from '\.\.\/work-mode\.js'/);
  assert.ok(!/function workMode\(/.test(captureJs), 'capture.js has re-forked its own workMode()');
  // The ~20 workType:workMode() payload sites are the whole point of the lock.
  assert.match(captureJs, /workType:workMode\(\)/);
});

test('the drive recorder reads workMode(), not the raw key', () => {
  // It cannot import capture.js (capture.js imports IT), which is why the lock
  // lives in its own module. Left reading the key, every drive leg would still
  // ship blank — which the spine reads as boat.
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

test('the teams admin page keeps its switch, on its own key', () => {
  // Deliberately NOT locked: the office still has to reach historical boat
  // teams. This test is the guard against someone "finishing the job" here.
  assert.match(teamsHtml, /id="modeBoat"/);
  assert.match(teamsHtml, /id="modeLand"/);
  assert.match(teamsJs, /store\.set\('teamsViewMode', m\)/);
  // A separate key is what stops an admin flipping to Boat from leaking a mode
  // into a crew's phone through the shared localStorage entry.
  assert.ok(!teamsJs.includes(`'workMode'`), 'teams.js still writes the capture app’s workMode key');
  assert.ok(!teamsHtml.includes(`getItem('workMode')`), 'teams.html still reads the workMode key');
  assert.ok(!/^import .*work-mode\.js/m.test(teamsJs), 'teams.js should not import the locked work mode');
});

test('the teams page opens on land, where the live work is', () => {
  assert.match(teamsJs, /store\.get\('teamsViewMode'\)==='boat' \? 'boat' : 'land'/);
  // The markup defaults have to agree with the JS default or the page flashes
  // the other mode's headings before the module runs.
  assert.match(teamsHtml, /id="teamsHead">Land Crews</);
  assert.match(teamsHtml, /id="newTeam"[^>]*>\+ New crew</);
});
