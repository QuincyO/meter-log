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

test('both presses ask for the second route, and it still costs nothing to say so', () => {
  // A pack-routed tap IS a road run, so it has a road route worth comparing —
  // asking on both presses is what gives the road/straight toggle something to
  // switch to. It can never cause a matrix call: route.js only consults the flag
  // inside `if(onRoad)`, so a tap with no pack still does exactly one solve.
  assert.match(js, /compareVariants:\s*true/);
  assert.match(route, /if\(onRoad\)\{\s*\n\s*variants\.road = primary;/);
  assert.match(route, /if\(opts\.compareVariants\) variants\.straight = solveVariant\(haversineMatrix/);
});

test('the press picks the ladder: tap measures on-device, hold skips the pack', () => {
  // The hold is the deliberate second opinion — the pack has no turn
  // restrictions — so it must opt OUT of the local graph, not merely allow the
  // network below it. Without noLocalGraph the gesture changes nothing inside
  // a downloaded district's coverage, which is what it used to do.
  assert.match(js, /straightLine:\s*!useNetwork,\s*noLocalGraph:\s*useNetwork/);
  assert.match(js, /bindOptimizeGesture\(\$\('wlOptimize'\),\s*\n\s*\(\) => optimizeRouteHandler\(false\),[^\n]*\n\s*\(\) => optimizeRouteHandler\(true\)\)/);
  assert.match(route, /if\(!opts\.osrmUrl && !opts\.noLocalGraph\)\{/);
});

test('a hold with no signal is refused rather than silently measuring nothing', () => {
  // It skips the pack by definition, so offline it has no source at all. The
  // refusal has to point at the tap that would have worked.
  assert.match(js, /if\(!navigator\.onLine && \(useNetwork \|\| !\(havePack && alreadyPinned >= 2\)\)\)\{/);
  assert.match(js, /tap Optimize to use the offline map/);
});

// The GPS fix is priced crow-flies — only which meter is NEAREST matters — while
// every between-stop distance keeps whatever matrix the run actually pulled.

test('a live GPS start rewrites only its own row/column, straight-line', () => {
  assert.match(route, /if\(startC && !usingTeamStart && !usedLocalGraph\)\{\s*straightLineNode\(D, coords, 0\);/);
});

test('the on-device road graph is exempt: it already measured the fix for free', () => {
  // The crow-flies rewrite exists to keep a live GPS fix out of a matrix somebody
  // PAYS for. A downloaded district costs nothing and routed the fix along with
  // every other stop, so applying the rewrite there would replace a real road
  // distance with an estimate — a pure downgrade. Guard the exemption so it
  // can't be "simplified" back out.
  assert.match(route, /!usedLocalGraph\)\{\s*straightLineNode/);
  assert.match(route, /const onRoad = usedLocalGraph \|\| \(!opts\.straightLine && !usedFallback\)/);
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
