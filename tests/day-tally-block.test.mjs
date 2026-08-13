// The clipboard tally copied whenever a daily-log PDF is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tallyBlock } from '../js/compute/tally.js';
import { UTI_REASONS, EER_UTI_REASON } from '../js/utiReasons.js';

const captureJs = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

const stop = (status, utiReason) => ({ id:String(Math.random()), status, utiReason });

test('the five lines come out in order, with Dispatched left empty', () => {
  // Dispatched is a number this app never sees — the installer types it in on paste,
  // and a fabricated 0 would read as a real count.
  const out = tallyBlock([stop('INSTALLED'), stop('INSTALLED')], 0);
  assert.equal(out, 'Dispatched:\nInstalled: 2\nUTI: 0\nTR: 0\nEER: 0');
  assert.ok(!/Dispatched: /.test(out), 'no trailing space after Dispatched:');
});

test('zeros print as 0 rather than vanishing', () => {
  assert.equal(tallyBlock([], 0), 'Dispatched:\nInstalled: 0\nUTI: 0\nTR: 0\nEER: 0');
});

test('an electrical-repair UTI counts on BOTH the UTI and EER lines', () => {
  // Deliberately overlapping: subtracting it would make the UTI line disagree with
  // the UTI total printed on the PDF beside it.
  const out = tallyBlock([
    stop('INSTALLED'),
    stop('UTI', EER_UTI_REASON),
    stop('UTI', 'No Access'),
  ], 0);
  assert.match(out, /^UTI: 2$/m);
  assert.match(out, /^EER: 1$/m);
});

test('only a UTI with that exact reason is an EER', () => {
  const out = tallyBlock([
    stop('INSTALLED', EER_UTI_REASON),            // an install carrying a stale reason
    stop('UTI', 'Other: emergency electrical'),   // free text is not the pick
    stop('UTI', ''),
    stop('VISITED', EER_UTI_REASON),
  ], 0);
  assert.match(out, /^EER: 0$/m);
  assert.match(out, /^UTI: 2$/m);
  assert.match(out, /^Installed: 1$/m, 'VISITED / UNACCOUNTED never count as installs');
});

test('a padded stored reason still counts', () => {
  assert.match(tallyBlock([stop('UTI', '  ' + EER_UTI_REASON + ' ')], 0), /^EER: 1$/m);
});

test('TR is whatever the appointment count passed in says', () => {
  assert.match(tallyBlock([], 3), /^TR: 3$/m);
  assert.match(tallyBlock([], undefined), /^TR: 0$/m, 'a missing count is 0, never NaN');
  assert.match(tallyBlock([], 'x'), /^TR: 0$/m);
});

test('EER_UTI_REASON is still one of the pickable UTI reasons', () => {
  // If the picklist string is renamed and this constant isn't, the EER line silently
  // reads 0 forever with nothing on screen saying so. Fail the build instead.
  assert.ok(UTI_REASONS.includes(EER_UTI_REASON),
    `${EER_UTI_REASON} is no longer in UTI_REASONS — the EER tally would always be 0`);
});

test('the copy fires before either PDF handler awaits anything', () => {
  // navigator.clipboard.writeText only counts as user-initiated inside the tap, and
  // both handlers sit behind several awaits (up to a 5s race on Finish) plus jsPDF's
  // lazy load. Same rule as the plan-mode WO# copy — see AGENTS.md.
  for(const handler of ['finishDay', 'genLog']){
    const body = captureJs.slice(captureJs.indexOf(`$('${handler}').onclick`));
    const copyAt = body.indexOf('copyDayTally()');
    const awaitAt = body.indexOf('await ');
    assert.ok(copyAt > -1, `${handler} does not copy the tally`);
    assert.ok(copyAt < awaitAt, `${handler} copies the tally after an await — iOS will refuse it`);
  }
});

test('the tally numbers are pre-read, not fetched at tap time', () => {
  // Same reason: an await for the counts would leave the gesture. refreshTallyCache
  // runs on load, after each log, and when the End-of-day sheet opens.
  assert.match(captureJs, /function copyDayTally\(\)\s*\{[^}]*tallyCache/s);
  assert.ok(!/function copyDayTally\(\)\s*\{[\s\S]{0,400}await /.test(captureJs),
    'copyDayTally awaits — it must be synchronous');
  assert.equal((captureJs.match(/refreshTallyCache\(\)/g) || []).length >= 4, true,
    'refreshTallyCache should be defined and called on load, after a log, and on EOD open');
});
