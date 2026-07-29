// The standing rule, made enforceable: a stop is NEVER rejected for being a
// duplicate. addStop used to `return { ok:false, duplicate:true }` before
// sh.appendRow(row), and the phone rendered "Entry discarded." — real field work
// destroyed at the moment the crew is least able to notice. These are content
// assertions rather than behaviour tests because the thing to prevent is a
// future edit re-introducing an early return, which no unit test would catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const CODE = read('Code.gs');
const CAPTURE = read('js/pages/capture.js');

function addStopBody(){
  const hit = CODE.match(/^function addStop\(b\) \{[\s\S]*?^\}$/m);
  assert.ok(hit, 'Code.gs no longer declares function addStop(b)');
  return hit[0];
}

test('addStop appends the row before it can return anything but a retry ack', () => {
  const body = addStopBody();
  const append = body.indexOf('sh.appendRow(row);');
  assert.ok(append !== -1, 'addStop no longer appends the row');
  // Everything before the append is the idempotency guard (`if (b.id &&
  // idExists(...))`), which acks a write that already succeeded. Any OTHER
  // early return there is a stop being thrown away.
  const before = body.slice(0, append);
  assert.doesNotMatch(before, /return \{ ok: false/,
    'addStop rejects a write before appending — a duplicate must warn, never discard');
  assert.doesNotMatch(before, /duplicate: true/,
    'addStop returns a duplicate verdict before appending — the row must be written first');
});

test('the spine never answers addStop with a duplicate rejection', () => {
  // saveDriveTrack legitimately returns {ok:true, id, duplicate:true} for an
  // idempotent re-send of a leg it already has; that is an ack, not a refusal.
  const refusals = CODE.match(/ok: false[^\n]*duplicate|duplicate: true[^\n]*ok: false/g) || [];
  assert.deepEqual(refusals, []);
});

test('the phone no longer tells the installer an entry was discarded', () => {
  assert.ok(!CAPTURE.includes('Entry discarded'),
    'capture.js still renders "Entry discarded" — nothing is discarded any more');
  // Both warning paths must say the stop survived.
  assert.match(CAPTURE, /Both stops are saved/);
});

test('classifyFlush still drains a duplicate/flagged ack', () => {
  // If a duplicate ever stopped counting as delivered, the item would sit at the
  // head of the FIFO and wedge every write behind it. Belongs here because the
  // never-discard rule is what makes those responses common.
  const policy = read('js/queue-policy.js');
  assert.match(policy, /respBody\.ok \|\| respBody\.duplicate \|\| respBody\.flagged/);
});

test('the pre-submit chooser blocks the tap without losing the entry', () => {
  const html = read('index.html');
  for (const id of ['jConflict', 'jcTitle', 'jcRows', 'jcFix', 'jcAnyway']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
  // "Log it anyway" must actually re-enter the log path, or the chooser IS a
  // discard with extra steps.
  assert.match(CAPTURE, /\$\('jcAnyway'\)\.onclick = \(\) => \{ ackJConflict\(sig\); hideJConflict\(\); \$\('logStop'\)\.click\(\); \};/);
  // "Go back and fix it" only closes the card — it must not clear the form.
  assert.match(CAPTURE, /\$\('jcFix'\)\.onclick\s*= \(\) => hideJConflict\(\);/);
  // Greying by pointer-events would swallow the tap AND the explanation — the
  // landmine AGENTS.md records for #wlOptimize.gated.
  const css = read('css/capture.css');
  const block = css.slice(css.indexOf('.j-conflict{'), css.indexOf('.j-conflict{') + 400);
  assert.ok(!block.includes('pointer-events'), '.j-conflict must never disable pointer events');
});

test('the rule and its reason are written down where the next agent will look', () => {
  const arch = read('ARCHITECTURE.md');
  assert.match(arch, /## Duplicate J numbers/);
  assert.match(arch, /never|Never/);
  assert.ok(arch.includes('jdup.js'), 'ARCHITECTURE.md does not mention js/jdup.js');
});
