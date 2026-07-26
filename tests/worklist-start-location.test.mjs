import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');
const route = readFileSync(new URL('../js/route.js', import.meta.url), 'utf8');

// Optimize asks where the crew is standing, every run. The old persistent
// "Start from here" pill is gone: arming a mode ahead of time was the wrong shape
// for a decision that changes with every mid-day re-optimize.

test('the start-location chooser offers muster, here-now and cancel', () => {
  assert.match(html, /id="wlStartAsk"/);
  assert.match(html, /id="wlStartMuster"[^>]*>Yes/);
  assert.match(html, /id="wlStartHereNow"[^>]*>No/);
  assert.match(html, /id="wlStartCancel"/);
});

test('it is a popup sheet over the page, not an inline list', () => {
  // Optimize blocks on the answer, so the question belongs over the page the way
  // the confirm() it replaced did. `.sheet` is the app's existing modal idiom.
  assert.match(html, /<div class="sheet hide" id="wlStartAsk">/);
  assert.match(html, /id="wlStartAsk">\s*<div class="card">/);
});

test('a backdrop tap cancels instead of hanging Optimize', () => {
  // capture.js hides ANY .sheet on a backdrop click; without this the promise
  // would stay pending behind a hidden sheet and Optimize would never continue.
  assert.match(js, /const onBackdrop = e => \{ if\(e\.target === box\) done\(null\); \};/);
  assert.match(js, /box\.addEventListener\('click', onBackdrop\)/);
  assert.match(js, /box\.removeEventListener\('click', onBackdrop\)/);
});

test('the old always-on Start from here pill is gone', () => {
  assert.doesNotMatch(html, /id="wlStartHere"/);
  assert.doesNotMatch(js, /startHereArmed|setStartHere/);
  assert.doesNotMatch(css, /\.wl-start-here/);
});

test('Optimize waits for the answer and cancelling aborts the run', () => {
  assert.match(js, /const startChoice = await askStartLocation\(/);
  assert.match(js, /if\(!startChoice\) return;/);
  assert.match(js, /const startFromCurrent = startChoice === 'here';/);
});

test('the answer still reaches optimizeRoute as startFromCurrent', () => {
  assert.match(js, /optimizeRoute\([^;]+\{[^}]*\bstraightLine\b[^}]*\bstartFromCurrent\b[^}]*\}\)/s);
});

test('the second route is only ever asked for on the road-matrix press', () => {
  // A plain tap must cost exactly what it always did: one solve, no matrix.
  assert.match(js, /compareVariants:\s*!straightLine/);
  assert.doesNotMatch(js, /compareVariants:\s*true/);
});

// The GPS fix is priced crow-flies — only which meter is NEAREST matters — while
// every between-stop distance keeps whatever matrix the run actually pulled.

test('a live GPS start rewrites only its own row/column, straight-line', () => {
  assert.match(route, /if\(startC && !usingTeamStart\)\{\s*straightLineNode\(D, coords, 0\);/);
});

test('a team muster start keeps real road distance for its drive-out', () => {
  // The drive-out IS shown, priced and drawn, so it must not be crow-flied. The
  // only rewrite of the distance matrix is the one guarded by !usingTeamStart —
  // a second, unguarded call would silently flatten every crew-start drive-out.
  assert.equal((route.match(/straightLineNode\(D,/g) || []).length, 1);
});

test('straightLineNode scales durations rather than writing metres into T', () => {
  assert.match(route, /straightLineNode\(T, coords, 0, CROW_MIN_PER_METRE\)/);
  assert.match(route, /const CROW_MIN_PER_METRE =/);
});
