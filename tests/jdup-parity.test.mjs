// Code.gs cannot import an ES module, so its normalizeJ / stopDate /
// inWindowFrom / jConflicts are a hand copy of js/jdup.js. A silent drift is
// close to invisible in the field: the phone would block a log the spine is
// happy with, or wave through a duplicate the spine then warns about hours
// later. Neither reads as a bug — only as a feature that behaves at random.
// So evaluate the real Apps Script source here and hold the two to the same
// output. Same technique as tests/route-dwell-parity.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { jConflicts as jConflictsJs } from '../js/jdup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'Code.gs'), 'utf8');

function extract(name){
  // Declarations in Code.gs are top-level and brace-balanced; take from the
  // declaration to the first line that closes it at column 0.
  const re = new RegExp(`^function ${name}\\([\\s\\S]*?^\\}$`, 'm');
  const hit = SRC.match(re);
  assert.ok(hit, `Code.gs no longer declares function ${name} — update this test with it`);
  return hit[0];
}

const jConflictsGs = new Function(
  extract('normalizeJ') + '\n' +
  extract('stopDate') + '\n' +
  extract('inWindowFrom') + '\n' +
  extract('jConflicts') + '\n' +
  'return jConflicts;'
)();

const S = (id, o) => Object.assign({
  id, timestamp: '2026-07-29 10:00:00', installer: 'Alex',
  workOrderId: '1000', newJNumber: '', oldJNumber: '', status: 'INSTALLED'
}, o);

// One table, both implementations. Each row is [candidate, stops, opts].
const CASES = [
  // plain New J# hit across orders, and the case/whitespace forms of it
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }), [S('a', { newJNumber: 'J991' })], {}],
  [S('c', { workOrderId: '2000', newJNumber: ' j991 ' }), [S('a', { newJNumber: 'J991' })], {}],
  // Old J# across orders fires; on the same order it does not (the revisit)
  [S('c', { workOrderId: '2000', oldJNumber: 'J410' }), [S('a', { oldJNumber: 'J410' })], {}],
  [S('c', { workOrderId: '1000', oldJNumber: 'J410' }), [S('a', { oldJNumber: 'J410' })], {}],
  // a blank work order can't be "the same order" — the carve-out must not apply
  [S('c', { workOrderId: '', oldJNumber: 'J410' }), [S('a', { workOrderId: '', oldJNumber: 'J410' })], {}],
  // no cross-field matching, both directions
  [S('c', { workOrderId: '2000', oldJNumber: 'J991' }), [S('a', { newJNumber: 'J991' })], {}],
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }), [S('a', { oldJNumber: 'J991' })], {}],
  // blanks never match
  [S('c', { workOrderId: '2000' }), [S('a', { status: 'UTI' })], {}],
  [S('c', { workOrderId: '2000', newJNumber: '  ' }), [S('a', { newJNumber: '' })], {}],
  // self-exclusion by id
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }), [S('c', { newJNumber: 'J991' })], {}],
  // both fields at once
  [S('c', { workOrderId: '2000', newJNumber: 'J991', oldJNumber: 'J410' }),
   [S('a', { newJNumber: 'J991', oldJNumber: 'J410' })], {}],
  // installer scope + date window (inclusive lower bound, undateable row is out)
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }),
   [S('a', { newJNumber: 'J991', installer: 'Sam' })], { installer: 'Alex' }],
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }),
   [S('a', { newJNumber: 'J991', timestamp: '2026-07-22 08:00:00' })], { from: '2026-07-23' }],
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }),
   [S('a', { newJNumber: 'J991', timestamp: '2026-07-22 08:00:00' })], { from: '2026-07-22' }],
  [S('c', { workOrderId: '2000', newJNumber: 'J991' }),
   [S('a', { newJNumber: 'J991', timestamp: 'Fri Jun 19 2026' })], { from: '2026-01-01' }],
  // several rows, so ordering is compared too
  [S('c', { workOrderId: '3000', newJNumber: 'J991', oldJNumber: 'J410' }),
   [S('a', { workOrderId: '1000', newJNumber: 'J991' }),
    S('b', { workOrderId: '2000', oldJNumber: 'J410' }),
    S('d', { workOrderId: '2500', newJNumber: 'J777' })], {}],
  // degenerate inputs
  [null, [S('a', { newJNumber: 'J991' })], {}],
  [S('c', { newJNumber: 'J991' }), [], {}]
];

// Compare on the shape that actually travels: which stop matched, on which
// field, with what key — not object identity, which can't survive new Function.
const shape = hits => hits.map(h => [h.stop.id, h.field, h.value]);

test('Code.gs jConflicts matches js/jdup.js on every case', () => {
  for (const [cand, stops, opts] of CASES) {
    assert.deepEqual(shape(jConflictsGs(cand, stops, opts)),
                     shape(jConflictsJs(cand, stops, opts)),
                     `diverged on ${JSON.stringify(cand)} / ${JSON.stringify(opts)}`);
  }
});

test('the parity cases actually exercise the behaviour', () => {
  // Parity is worthless if both sides just return [] everywhere. Insist the
  // table covers hits on both fields, and at least one deliberate non-hit.
  const all = CASES.flatMap(([c, s, o]) => jConflictsJs(c, s, o));
  assert.ok(all.some(h => h.field === 'newJNumber'), 'no New J# hit in the table');
  assert.ok(all.some(h => h.field === 'oldJNumber'), 'no Old J# hit in the table');
  assert.ok(CASES.some(([c, s, o]) => jConflictsJs(c, s, o).length === 0), 'no non-hit in the table');
});

test('the spine windows and scopes the scan before it matches', () => {
  // jConflictsFor is the sheet-side half the parity test cannot evaluate (it
  // reads rows()), so pin the two properties that make the agreed scope real:
  // this installer only, and J_DUP_DAYS back from the STOP's own date.
  const forFn = SRC.match(/^function jConflictsFor\([\s\S]*?^\}$/m);
  assert.ok(forFn, 'Code.gs no longer declares jConflictsFor');
  assert.match(forFn[0], /J_DUP_DAYS/);
  assert.match(forFn[0], /installer: b\.installer/);
  assert.match(SRC, /const J_DUP_DAYS = 7;/);
});
