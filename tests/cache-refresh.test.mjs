import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const worker  = text('sw.js');
const capture = text('js/pages/capture.js');
const indexHtml = text('index.html');
const agents  = text('AGENTS.md');
const architecture = text('ARCHITECTURE.md');
const guide   = text('USER-GUIDE.md');

test('the worker exposes the force-update message contract', () => {
  assert.match(worker, /addEventListener\('message'/);
  assert.match(worker, /REFRESH_SHELL/);
  assert.match(worker, /VERSION/);
  // waitUntil, or the browser can kill the worker part-way through the download.
  assert.match(worker, /waitUntil\(refreshShell\(/);
  assert.match(worker, /postMessage\(\{ type: 'progress'/);
  assert.match(worker, /type: 'done'/);
});

test('the refresh bypasses the browser HTTP cache and never deletes first', () => {
  // Without cache:'reload' the re-fetch is answered by the browser's own HTTP
  // cache and re-stores the SAME stale bytes — the whole bug this button fixes.
  assert.match(worker, /new Request\(url, \{ cache: 'reload' \}\)/);
  // A failed file must keep its existing cached copy, so a refresh on a weak
  // signal can never strand the phone without an offline shell.
  assert.match(worker, /if \(res && res\.ok\) \{ await cache\.put\(/);
  assert.doesNotMatch(worker, /cache\.delete\(|caches\.delete\(CACHE\)/);
});

test('the worker still owns the one SHELL list the refresh walks', () => {
  assert.match(worker, /const CACHE = 'meterlog-v27';/);
  // Refreshing SHELL itself (not a page-side copy) is what stops the file list
  // from drifting the first time someone adds a module.
  assert.match(worker, /SHELL\[next\+\+\]/);
  for (const entry of ['./js/pages/capture.js', './js/pages/map.js', './js/pages/planner.js',
                       './js/config.js', './css/capture.css', './index.html']) {
    assert.ok(worker.includes(`'${entry}'`), `SHELL is missing ${entry}`);
  }
});

test('the Settings sheet carries the button and its version line', () => {
  assert.match(indexHtml, /id="refreshApp"/);
  assert.match(indexHtml, /id="appVersionHint"/);
  assert.match(capture, /\$\('refreshApp'\)\.onclick = refreshAppShell;/);
  assert.match(capture, /MessageChannel/);
  assert.match(capture, /type:'REFRESH_SHELL'|type: 'REFRESH_SHELL'/);
  // Guards: an uninstalled app has no worker to ask, and the download needs signal.
  assert.match(capture, /navigator\.serviceWorker\.controller/);
  assert.match(capture, /navigator\.onLine/);
  // The version hint has to repaint when Settings opens, or it shows nothing.
  assert.match(capture, /paintVersionHint\(\);/);
});

test('the force update never clears the installer\'s saved details', () => {
  // The point of the in-place mechanism: replace downloaded code, keep the
  // name / H number / sub / home / work mode in localStorage and everything
  // waiting to send in IndexedDB. A later "let's make it more thorough" edit
  // must fail here rather than silently re-prompt every installer.
  for (const [file, src] of [['sw.js', worker], ['js/pages/capture.js', capture]]) {
    assert.doesNotMatch(src, /localStorage\.clear|localStorage\.removeItem/,
      `${file} must not clear localStorage`);
    assert.doesNotMatch(src, /indexedDB\.deleteDatabase/,
      `${file} must not delete the IndexedDB database`);
    assert.doesNotMatch(src, /\.unregister\(/,
      `${file} must not unregister the service worker`);
  }
});

test('the force update is documented for the next agent and for the crew', () => {
  for (const [name, doc] of [['AGENTS.md', agents], ['ARCHITECTURE.md', architecture]]) {
    assert.match(doc, /REFRESH_SHELL/, `${name} should document the message contract`);
    assert.match(doc, /cache: ?'reload'/, `${name} should explain the HTTP-cache bypass`);
  }
  assert.match(guide, /Force update from GitHub/);
});
