import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bulkAddPlan } from '../js/worklist-dedup.js';

// A worklist order with sensible defaults; override per case.
const order = (id, extra = {}) => Object.assign({
  id, workOrderId: 'WO1', address: '', wlStatus: 'pending',
}, extra);

// ── bulkAddPlan: the pure parse + dedupe behind the bulk-paste sheet ─────────

test('one number per line; lines are trimmed; blanks are ignored, not skipped', () => {
  // Blank lines are noise, not duplicates — they must not inflate the toast's
  // "skipped N" count.
  const { add, skipped } = bulkAddPlan('  WO1 \n\nWO2\n   \nWO3\n', []);
  assert.deepEqual(add, ['WO1', 'WO2', 'WO3']);
  assert.equal(skipped, 0);
});

test('a CRLF paste (Excel / Notes copy) sheds the \\r with the trim', () => {
  const { add, skipped } = bulkAddPlan('WO1\r\nWO2\r\n', []);
  assert.deepEqual(add, ['WO1', 'WO2']);
  assert.equal(skipped, 0);
});

test('a repeat within the paste: first occurrence wins, later ones are skipped', () => {
  // Case- and whitespace-insensitive, same normalizeWo the winner rule uses.
  const { add, skipped } = bulkAddPlan('WO1\n wo1 \nWO1\nWO2', []);
  assert.deepEqual(add, ['WO1', 'WO2']);
  assert.equal(skipped, 2);
});

test('a number already on the list as pending is skipped', () => {
  const items = [order('a', { workOrderId: 'wo1' })];
  const { add, skipped } = bulkAddPlan('WO1\nWO2', items);
  assert.deepEqual(add, ['WO2']);
  assert.equal(skipped, 1);
});

test('a number matching only a DONE item is added — the revisit is legitimate', () => {
  // Mirrors wlSave's guard, which ignores done items on purpose.
  const items = [order('a', { workOrderId: 'WO1', wlStatus: 'done' })];
  const { add, skipped } = bulkAddPlan('WO1', items);
  assert.deepEqual(add, ['WO1']);
  assert.equal(skipped, 0);
});

test('an existing item with a blank WO# never collides with anything', () => {
  const items = [order('a', { workOrderId: '' }), order('b', { workOrderId: null })];
  const { add, skipped } = bulkAddPlan('WO1', items);
  assert.deepEqual(add, ['WO1']);
  assert.equal(skipped, 0);
});

test('add[] keeps the trimmed original text, not the normalized uppercase', () => {
  // The card should show the number the way the office wrote it.
  const { add } = bulkAddPlan('  wo123a  ', []);
  assert.deepEqual(add, ['wo123a']);
});

test('empty / whitespace-only / missing text adds nothing and skips nothing', () => {
  assert.deepEqual(bulkAddPlan('', []), { add: [], skipped: 0 });
  assert.deepEqual(bulkAddPlan('  \n \r\n ', []), { add: [], skipped: 0 });
  assert.deepEqual(bulkAddPlan(null, []), { add: [], skipped: 0 });
  assert.deepEqual(bulkAddPlan(undefined, null), { add: [], skipped: 0 });
});

// ── The shapes that keep the gesture and the sheet honest ────────────────────

const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

test('＋ Add order is wired through the tap-vs-hold binder, not a bare onclick', () => {
  // A bare onclick would silently drop the hold; the binder carries the pointer
  // capture / synthetic-click / contextmenu handling the Optimize hold learned.
  assert.match(worklist, /bindOptimizeGesture\(\$\('wlAddBtn'\)/);
  assert.doesNotMatch(worklist, /\$\('wlAddBtn'\)\.onclick/);
});

test('bulk-added orders funnel through the add-to-today chooser queue', () => {
  // addToQueue + offerAddTo is THE ONLY WAY WORK JOINS A DAY ALREADY UNDER WAY
  // (see the comment above addToQueue in worklist.js). A bulk add that writes
  // straight to the store would smuggle work past the day lock.
  assert.match(worklist, /function wlBulkAdd\b[\s\S]{0,1200}addToQueue\.push/);
});

test('the bulk-paste sheet exists with its textarea and both buttons', () => {
  assert.match(html, /id="wlBulkAdd"/);
  assert.match(html, /<textarea[^>]*id="wlBulkText"/);
  assert.match(html, /id="wlBulkSave"/);
  assert.match(html, /id="wlBulkCancel"/);
});

test('the hold target carries the same CSS selection guard as #wlOptimize', () => {
  // Same lesson as tests/press-hold.test.mjs: the guard lives in CSS, where it
  // costs no scrolling. A standalone rule — never merged into #wlOptimize's,
  // whose exact `#wlOptimize{` shape is pinned by that suite.
  const rule = css.match(/#wlAddBtn\{[^}]*\}/);
  assert.ok(rule, 'the #wlAddBtn rule is missing');
  assert.match(rule[0], /user-select:none/);
  assert.match(rule[0], /-webkit-touch-callout:none/);
  assert.doesNotMatch(rule[0], /touch-action:\s*none/, 'touch-action:none would block panning');
});
