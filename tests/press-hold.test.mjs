import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPressHold } from '../js/press-hold.js';

// The 🧭 Optimize button's tap-vs-hold gesture. It has been rewritten twice — a
// 5-tap secret, then a hold that blocked page scrolling — so the recognizer is
// pure and tested here rather than asserted as source text.

// A fake clock: the recognizer's only timer is the hold, so `fire()` is "the
// finger stayed down long enough".
function press(opts = {}){
  const calls = [];
  let pending = null;
  const gesture = createPressHold({
    holdMs: 2000,
    onTap: () => calls.push('tap'),
    onHold: () => calls.push('hold'),
    setTimeout: fn => { pending = fn; return 1; },
    clearTimeout: () => { pending = null; },
    ...opts,
  });
  return {
    gesture,
    calls,
    armed: () => pending !== null,
    fire(){
      assert.ok(pending, 'the hold timer was not armed');
      const fn = pending; pending = null; fn();
    },
  };
}
const at = (x, y, pointerId = 1) => ({ pointerId, clientX: x, clientY: y, isPrimary: true, button: 0 });

test('a still press released early is a tap', () => {
  const p = press();
  assert.equal(p.gesture.down(at(50, 100)), true);
  p.gesture.move(at(52, 103));            // a finger is never perfectly still
  p.gesture.up(at(52, 103));
  assert.deepEqual(p.calls, ['tap']);
});

test('a still press held past holdMs is a hold, and its release is not also a tap', () => {
  const p = press();
  p.gesture.down(at(50, 100));
  p.fire();
  assert.deepEqual(p.calls, ['hold']);
  p.gesture.up(at(50, 100));
  assert.deepEqual(p.calls, ['hold'], 'the release after a hold must not optimize again');
});

test('a press that travels is a scroll: it fires nothing at all', () => {
  // The reported bug: brushing the full-width button while scrolling the
  // worklist started a route optimization.
  const p = press();
  p.gesture.down(at(50, 100));
  assert.equal(p.gesture.move(at(50, 130)), true, 'the aborting move reports itself');
  assert.equal(p.armed(), false, 'the hold timer is disarmed by the abort');
  p.gesture.up(at(50, 160));
  assert.deepEqual(p.calls, []);
});

test('the abort survives the finger coming back to where it started', () => {
  const p = press();
  p.gesture.down(at(50, 100));
  p.gesture.move(at(50, 140));
  assert.equal(p.gesture.move(at(50, 100)), false, 'already aborted; not re-aborted');
  p.gesture.up(at(50, 100));
  assert.deepEqual(p.calls, []);
});

test('travel after the hold has fired does not undo it', () => {
  const p = press();
  p.gesture.down(at(50, 100));
  p.fire();
  p.gesture.move(at(50, 200));
  p.gesture.up(at(50, 200));
  assert.deepEqual(p.calls, ['hold']);
});

test('pointercancel — the browser took the touch to pan — fires nothing', () => {
  const p = press();
  p.gesture.down(at(50, 100));
  p.gesture.cancel(at(50, 100));
  assert.equal(p.armed(), false);
  assert.deepEqual(p.calls, []);
  // ...and the click it did not consume still activates the button.
  assert.equal(p.gesture.click(), false);
  assert.deepEqual(p.calls, ['tap']);
});

test('the synthetic click after a tap or a hold is consumed', () => {
  const tap = press();
  tap.gesture.down(at(50, 100));
  tap.gesture.up(at(50, 100));
  assert.equal(tap.gesture.click(), true, 'caller preventDefault()s it');
  assert.deepEqual(tap.calls, ['tap'], 'exactly one command per gesture');

  const hold = press();
  hold.gesture.down(at(50, 100));
  hold.fire();
  assert.equal(hold.gesture.click(), true);
  assert.deepEqual(hold.calls, ['hold']);
});

test('the click after an aborted press is consumed too', () => {
  // A mouse drag off the button still ends in a click, and that is not a tap.
  const p = press();
  p.gesture.down(at(50, 100));
  p.gesture.move(at(50, 200));
  p.gesture.up(at(50, 200));
  assert.equal(p.gesture.click(), true);
  assert.deepEqual(p.calls, []);
});

test('a bare click with no pointer sequence is a tap (keyboard, assistive tech)', () => {
  const p = press();
  assert.equal(p.gesture.click(), false);
  assert.deepEqual(p.calls, ['tap']);
});

test('a second finger and a non-left button are ignored', () => {
  const p = press();
  assert.equal(p.gesture.down({ ...at(50, 100), isPrimary: false }), false);
  assert.equal(p.gesture.down({ ...at(50, 100), button: 2 }), false);
  assert.equal(p.armed(), false);

  // A second finger landing mid-press neither ends nor hijacks the first.
  p.gesture.down(at(50, 100, 1));
  p.gesture.up(at(50, 100, 2));
  assert.deepEqual(p.calls, []);
  p.gesture.up(at(50, 100, 1));
  assert.deepEqual(p.calls, ['tap']);
});

test('active reports whether a press is being tracked', () => {
  const p = press();
  assert.equal(p.gesture.active, false);
  p.gesture.down(at(50, 100));
  assert.equal(p.gesture.active, true);
  p.gesture.up(at(50, 100));
  assert.equal(p.gesture.active, false);
});

// ── The regression that actually shipped ─────────────────────────────────────

const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

test('nothing listens for touchstart on the worklist screen', () => {
  // A touchstart preventDefault() cancels panning along with the selection,
  // which made the full-width Optimize button a strip of the list you could not
  // scroll through. (The comment above bindOptimizeGesture says why, so this
  // matches the listener, not the word.)
  assert.doesNotMatch(worklist, /addEventListener\(\s*'touchstart'/);
  assert.doesNotMatch(worklist, /ontouchstart/);
});

test('the selection guard lives in CSS, where it costs no scrolling', () => {
  const rule = css.match(/#wlOptimize\{[^}]*\}/);
  assert.ok(rule, 'the #wlOptimize rule is gone');
  assert.match(rule[0], /user-select:none/);
  assert.match(rule[0], /-webkit-touch-callout:none/);
  assert.doesNotMatch(rule[0], /touch-action:\s*none/, 'touch-action:none would block panning');
});

test('Optimize still wires straight-line to the tap and the road matrix to the hold', () => {
  assert.match(worklist, /createPressHold\(\{\s*holdMs,\s*onTap:\s*onStraightLine,\s*onHold:\s*onRoadMatrix\s*\}\)/);
  assert.match(worklist, /bindOptimizeGesture\(\$\('wlOptimize'\),\s*\n\s*\(\) => optimizeRouteHandler\(true\),[^\n]*\n\s*\(\) => optimizeRouteHandler\(false\)\)/);
});

test('the service worker ships the new module', () => {
  // CACHE is bumped alongside it; the version pins live in cache-refresh and
  // installer-metrics-cache-docs, so this only checks the SHELL entry.
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/press-hold\.js'/);
});

test('move/up/cancel are on window, so a finger leaving the button still aborts', () => {
  // wireDrag learned the same lesson: pointer capture can be lost, and only
  // window is guaranteed to see the rest of the gesture.
  for(const ev of ['pointermove', 'pointerup', 'pointercancel']){
    assert.match(worklist, new RegExp(`window\\.addEventListener\\('${ev}'`));
  }
});
