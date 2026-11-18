// The two clipboard copies a logged UTI makes: the WO# first, then the note the
// installer sends their supervisor. The note is what gets pasted; the WO# sits
// one entry back in the keyboard's clipboard history for the meter-install app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { utiNoteText } from '../js/utiReasons.js';

const captureJs = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

// The Log stop handler, from its binding to the next section header.
const handlerStart = captureJs.indexOf("$('logStop').onclick = () => {");
const handler = captureJs.slice(handlerStart, captureJs.indexOf('\n// ── ', handlerStart));

test('the note is the work order, then the reason and the comment', () => {
  assert.equal(
    utiNoteText({ workOrderId:'1022668', utiReason:'No Access', notes:'gate locked, dog loose' }),
    'Work order: 1022668\nNo Access - gate locked, dog loose');
});

test('no comment means no dangling dash', () => {
  for(const notes of ['', '   ', null, undefined]){
    assert.equal(utiNoteText({ workOrderId:'1022668', utiReason:'No Power', notes }),
      'Work order: 1022668\nNo Power');
  }
});

test('an "Other" reason carries its typed text', () => {
  assert.equal(
    utiNoteText({ workOrderId:'902732', utiReason:'Other: bees in the meter base', notes:'customer will call' }),
    'Work order: 902732\nOther: bees in the meter base - customer will call');
});

test('padding is trimmed and a missing stop does not throw', () => {
  assert.equal(utiNoteText({ workOrderId:' 902732 ', utiReason:' Key Required ', notes:' back door ' }),
    'Work order: 902732\nKey Required - back door');
  assert.equal(utiNoteText(), 'Work order: \n');
});

// ── Why it is "Work order:" and not "Workorder:" ────────────────────────────
// A paste that begins with one word and a colon is a valid URI scheme. iOS
// publishes a URL flavour of it and Messages pastes that percent-encoded — the
// day-tally bug of 2026-08-14 (tests/day-tally-block.test.mjs). A space before
// the colon leaves no scheme to find.
test('the note does NOT parse as a URL', () => {
  for(const stop of [
    { workOrderId:'1022668', utiReason:'No Access', notes:'gate locked' },
    { workOrderId:'1022668', utiReason:'Other: dog', notes:'' },
    { workOrderId:'1022668', utiReason:'Emergency Electrical Repair', notes:'mast pulled off' },
  ]) assert.throws(() => new URL(utiNoteText(stop)),
    'the UTI note parses as a URL — an iPhone will percent-encode the paste');
});

test('the one-word spelling stays rejected', () => {
  // Recorded as an executable note: this is the format that was asked for first.
  assert.doesNotThrow(() => new URL('Workorder: 1022668\nNo Access - gate locked'),
    '"Workorder:" no longer parses as a URL — re-check the two-word reasoning');
});

// ── The copy in the Log stop handler ────────────────────────────────────────
test('the handler was found', () => {
  assert.ok(handlerStart > -1 && handler.length > 500, 'could not slice the logStop handler');
});

test('the WO# is copied first and the note second', () => {
  const woAt = handler.indexOf('navigator.clipboard.writeText(base.workOrderId)');
  const noteAt = handler.indexOf('navigator.clipboard.writeText(utiNote)');
  assert.ok(woAt > -1, 'the WO# copy is gone');
  assert.ok(noteAt > -1, 'the UTI note copy is gone');
  assert.ok(woAt < noteAt,
    'the note is copied before the WO# — the WO# would be what gets pasted to the supervisor');
});

test('the two copies are separated by the gap, not fired back to back', () => {
  // Two writes a few milliseconds apart can reach the keyboard as one clipboard
  // change, and the WO# would never enter its history.
  assert.match(captureJs, /const UTI_NOTE_COPY_GAP_MS = \d+;/);
  const woAt = handler.indexOf('navigator.clipboard.writeText(base.workOrderId)');
  const noteAt = handler.indexOf('navigator.clipboard.writeText(utiNote)');
  assert.match(handler.slice(woAt, noteAt), /setTimeout\(\w+, UTI_NOTE_COPY_GAP_MS\)/);
});

test('both copies come after the stop is queued, and nothing is awaited first', () => {
  // The stop is the record; the copy is a convenience and must never sit in front
  // of it. And an `await` before the first write would cost it the user gesture.
  const queuedAt = handler.indexOf('enqueue(base)');
  const woAt = handler.indexOf('navigator.clipboard.writeText(base.workOrderId)');
  assert.ok(queuedAt > -1 && queuedAt < woAt, 'the copy runs before enqueue(base)');
  assert.ok(!/\bawait\b/.test(handler.slice(0, woAt)),
    'the handler awaits before the WO# copy — the clipboard write loses its gesture');
  assert.doesNotMatch(captureJs, /\$\('logStop'\)\.onclick = async/);
});

test('a UTI copies whether or not plan mode is on; other stops still need it', () => {
  const noteGate = handler.match(/const utiNote = \(([^)]*\))/);
  assert.ok(noteGate, 'could not find the utiNote gate');
  assert.match(noteGate[1], /outStatus==='UTI'/);
  assert.doesNotMatch(noteGate[1], /planActive/, 'the UTI note must not depend on plan mode');
  assert.match(handler, /else if\(canCopy && planActive\(\)\)/,
    'the plan-mode WO# copy for installs is gone');
});

test('the helper is reached through a namespace import, never a new named one', () => {
  // A phone can run the new capture.js against an older utiReasons.js for as long
  // as nobody presses Force update. A missing NAMED export is a link error that
  // takes Log stop down with it; a missing namespace member is just undefined.
  assert.match(captureJs, /import \* as utiLib from '\.\.\/utiReasons\.js';/);
  assert.match(handler, /typeof utiLib\.utiNoteText === 'function'/);
  const named = captureJs.match(/import \{([^}]*)\} from '\.\.\/utiReasons\.js';/);
  assert.ok(named, 'the named utiReasons import is gone');
  assert.doesNotMatch(named[1], /utiNoteText/);
});

test('a refused copy never throws into the handler', () => {
  const woAt = handler.indexOf('navigator.clipboard.writeText(base.workOrderId)');
  const chain = handler.slice(woAt, handler.indexOf('else if(canCopy', woAt));
  assert.equal((chain.match(/\.catch\(\(\) => \{\}\)/g) || []).length, 2,
    'both the WO# write and the note write need their own catch');
});
