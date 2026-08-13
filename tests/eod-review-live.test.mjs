// The end-of-day review is LIVE installer state, and three things used to treat it
// as disposable. Source assertions in the house style (tests/daily-log-bookends.test.mjs):
// the behaviours below live in DOM handlers that node can't execute, but each one is a
// single identifiable line whose absence is the bug coming back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const captureJs = rd('../js/pages/capture.js');
const queueJs   = rd('../js/queue.js');
const baseCss   = rd('../css/base.css');

test('a sheet is dismissed only by a tap that STARTED on the backdrop', () => {
  // .sheet is a full-viewport bottom-anchored backdrop with the card floating on it,
  // so anything that changes the card's height re-aims a tap already in flight at the
  // backdrop. With a click-target test alone that read as "dismiss", and closeSheets()
  // hides EVERY sheet — which is how the End-of-day sheet shut itself mid-review the
  // moment a slow day/idle response rebuilt the list under the installer's finger.
  assert.match(baseCss, /\.sheet\{[^}]*align-items:flex-end/, 'the backdrop is still bottom-anchored');
  // lastIndexOf: closeSheets() matches the same selector one line earlier.
  const listener = captureJs.slice(captureJs.lastIndexOf("document.querySelectorAll('.sheet').forEach"));
  assert.match(listener.slice(0, 600), /addEventListener\('pointerdown'/,
    'the backdrop dismiss no longer requires a pointerdown on the backdrop');
  assert.match(listener.slice(0, 600), /e\.target === s && started/);
});

test('a late server render never rebuilds a review being worked in', () => {
  // setGapData replaces eodGaps wholesale and renderEod rebuilds every card collapsed.
  // Worse than losing the typing: saveTravel REPLACES the day's gap-tagged rows, so
  // the emptied review could be posted over deductions already on the Sheet.
  assert.match(captureJs, /let eodTouched = false;/);
  assert.match(captureJs, /function touchEod\(\)\{ eodTouched = true; \}/);
  assert.match(captureJs, /mode==='eod' && eodTouched/,
    'loadDay no longer guards the End-of-day re-render');
  // Every way into the review arms it.
  assert.match(captureJs, /function syncNet\(g\)\{ touchEod\(\);/);
  assert.match(captureJs, /function syncDraw\(g\)\{ touchEod\(\);/);
  assert.match(captureJs, /toggle\.onclick = \(\) => \{ touchEod\(\);/, 'the travel editor toggle');
  assert.match(captureJs, /if\(opts && opts\.travel\) touchEod\(\);/, 'the stop card Edit toggle');
  // …and each open starts clean, or the freeze would outlive the day.
  assert.match(captureJs, /eodGaps=\[\]; eodTouched=false;/);
});

test('a gap deduction category change is a real edit', () => {
  // It set a.category and nothing else, so it never reached the dayCache stash and
  // never re-triggered the summary prefetch.
  assert.match(captureJs, /a\.category = e\.target\.value; syncNet\(g\);/);
});

test('flush() hands back the in-flight run so `await flush()` is a barrier', () => {
  // The guard used to be `if(flushing) return;`, which resolves instantly. Since
  // enqueue fires an un-awaited flush(), it was armed for the whole drain — so every
  // "drain the queue, then read the Sheet" call site was reading a Sheet that could
  // still be missing the rows the phone had just queued.
  assert.match(queueJs, /if\(flushing\) return flushing;/);
  assert.match(queueJs, /flushing = drain\(c\)\.finally\(\(\) => \{ flushing = null; \}\)/);
  assert.ok(!/let flushing = false/.test(queueJs), 'flushing is a boolean again');
  // And it must not reject: the awaiting handlers have no try/catch.
  assert.match(queueJs, /async function drain\(c\)\{[\s\S]*catch\s*\{[^}]*\}\s*\n\s*finally \{ paint\(\); \}/);
});

test('the End-of-day sheet opens before the queue is drained', () => {
  // Now that the flush really waits, doing it first would leave the button dead for
  // the length of the drain with nothing on screen.
  const handler = captureJs.slice(captureJs.indexOf("$('endDay').onclick"));
  const open = handler.indexOf("openSheet('eodSheet')");
  const flush = handler.indexOf('await flush()');
  assert.ok(open > -1 && flush > -1);
  assert.ok(open < flush, 'End of day still drains the queue before showing the sheet');
});
