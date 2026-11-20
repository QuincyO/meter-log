// Downtime on no order: the "Before first order" and "After last order" cards in
// End of day (land days).
//
// The first order's own slot used to be the only place to enter the morning's
// delay, which printed it on that order's row of the daily log. The two cards are
// gaps like any other, keyed on a fixed clock and arriving at no stop.
//
// The card is DOM and node cannot run it, so the wiring is pinned by source, as in
// tests/today-downtime.test.mjs. withEdgeGaps is pure, so it is lifted out of
// capture.js and called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const captureJs = rd('../js/pages/capture.js');
const editJs = rd('../js/pages/edit.js');
const codeGs = rd('../Code.gs');

// The pure half of the block, evaluated on its own: it must not lean on anything
// else in capture.js, or an older sibling module could take it down.
const block = captureJs.slice(captureJs.indexOf('const EDGE_BEFORE'), captureJs.indexOf('// The End-of-day card for one of those two slots'));
assert.ok(block.includes('function withEdgeGaps('), 'the no-order block moved or was renamed');
const { withEdgeGaps, edgeOf } = new Function(block + '\nreturn { withEdgeGaps, edgeOf };')();

const real = { start:'09:00', end:'09:40', idleMin:40, toWO:'200', toId:'b', allocations:[] };
const lead = { start:'09:00', end:'09:00', idleMin:0, toWO:'100', toId:'a', lead:true, allocations:[] };
const row = (category, minutes, note, workOrderId = '') => ({ id:'x', category, minutes, note, workOrderId });
const alloc = (t, category, minutes) => ({ fromTime:t, toTime:t, workOrderId:'', category, minutes });
const shape = gaps => gaps.map(g => [g.start, g.end, edgeOf(g)]);

test('a land day gets one slot above the first order and one below the last', () => {
  const out = withEdgeGaps([lead, real], [], undefined, true);
  assert.deepEqual(shape(out), [['00:00', '00:00', 'before'], ['09:00', '09:00', ''], ['09:00', '09:40', ''], ['23:59', '23:59', 'after']]);
  // They arrive at no stop: blank ids, so the row is saved with no WO#.
  for(const g of [out[0], out[3]]) assert.deepEqual([g.toId, g.toWO, g.idleMin, g.allocations], ['', '', 0, []]);
  // The first order keeps its own slot, and it is not one of the two.
  assert.equal(edgeOf(lead), '');
});

test('a boat day gets neither, and a day with no logs still gets both', () => {
  assert.deepEqual(shape(withEdgeGaps([real], [], undefined, false)), [['09:00', '09:40', '']]);
  assert.deepEqual(shape(withEdgeGaps([], [], undefined, true)), [['00:00', '00:00', 'before'], ['23:59', '23:59', 'after']]);
  assert.deepEqual(shape(withEdgeGaps(null, null, null, true)), [['00:00', '00:00', 'before'], ['23:59', '23:59', 'after']]);
});

test('saved rows fill the slots by their fixed key, whatever dash the note was written with', () => {
  const rows = [
    row('DISPATCH', 35, 'gap 00:00–00:00'), row('WAREHOUSE', 10, 'gap 00:00-00:00'),
    row('TRUCK_ISSUES', 25, 'gap 23:59–23:59'),
    row('OTHER', 5, 'gap 09:00–09:00', '100'),       // the first order's own slot
    row('LUNCH', 30, ''),                             // Add downtime, from the main form
  ];
  const out = withEdgeGaps([lead, real], rows, undefined, true);
  assert.deepEqual(out[0].allocations, [{ category:'DISPATCH', minutes:35 }, { category:'WAREHOUSE', minutes:10 }]);
  assert.deepEqual(out[3].allocations, [{ category:'TRUCK_ISSUES', minutes:25 }]);
});

test('a stash the Sheet has not confirmed wins over the saved rows, emptied or not', () => {
  const rows = [row('DISPATCH', 35, 'gap 00:00–00:00')];
  const typed = withEdgeGaps([real], rows, [alloc('00:00', 'DISPATCH', 50), alloc('23:59', 'ASSIST', 15)], true);
  assert.deepEqual(typed[0].allocations, [{ category:'DISPATCH', minutes:50 }]);
  assert.deepEqual(typed[2].allocations, [{ category:'ASSIST', minutes:15 }]);
  // Deleting the last entry leaves an EMPTY stash, and that must mean empty.
  assert.deepEqual(withEdgeGaps([real], rows, [], true)[0].allocations, []);
});

test('slots the spine already sent are left alone, never doubled', () => {
  const fromSpine = [
    { start:'00:00', end:'00:00', idleMin:0, toWO:'', toId:'', allocations:[{ id:'r1', category:'DISPATCH', minutes:35 }] },
    real,
    { start:'23:59', end:'23:59', idleMin:0, toWO:'', toId:'', allocations:[] },
  ];
  const out = withEdgeGaps(fromSpine, [row('DISPATCH', 99, 'gap 00:00–00:00')], undefined, true);
  assert.equal(out.length, 3);
  assert.equal(out[0], fromSpine[0], 'the spine\'s own gap, with its own allocations');
});

test('the caller\'s list is not changed', () => {
  const list = [real];
  withEdgeGaps(list, [], undefined, true);
  assert.equal(list.length, 1);
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('both ways the phone builds its gap list go through withEdgeGaps', () => {
  const local = captureJs.slice(captureJs.indexOf('function localGapsFor('), captureJs.indexOf('function overlayStash('));
  assert.match(local, /return withEdgeGaps\(computeGapsLocal\(/, 'the cached, offline list');
  assert.match(captureJs, /gaps = withEdgeGaps\(overlayStash\(idata\.gaps, pendingTravel\), downtime, pendingTravel, workMode\(\)==='land'\);/,
    'the spine\'s list: a spine that has not deployed sends neither slot, and a slot missing from eodGaps is deleted by the next save');
});

test('End of day draws the two cards around the orders, and Today\'s orders does not', () => {
  const eod = captureJs.slice(captureJs.indexOf('function renderEod('), captureJs.indexOf('let eodData ='));
  const before = eod.indexOf("makeEdgeCard(before, 'Before first order')");
  const orders = eod.indexOf('ordered.forEach(s => list.appendChild(makeStopCard(');
  const after = eod.indexOf("makeEdgeCard(after, 'After last order')");
  assert.ok(before > -1 && orders > before && after > orders, 'before, the orders, after: in that order');
  assert.equal(captureJs.split('makeEdgeCard(').length - 1, 3, 'the definition and End of day\'s two calls, nowhere else');
});

test('the card edits the shared gap list, so its entries ride every save', () => {
  const card = captureJs.slice(captureJs.indexOf('function makeEdgeCard('), captureJs.indexOf('// ── end: downtime on no order'));
  assert.match(card, /allocEditor\(g, onNet\)/, 'the same editor, bound to the gap in eodGaps');
  assert.match(card, /touchEod\(\)/, 'opening it counts as working in the review: a late response must not rebuild it');
  // collectGapAllocations walks every gap and writes g.toWO, which is blank here.
  assert.match(captureJs, /out\.push\(\{ fromTime:g\.start, toTime:g\.end, workOrderId:g\.toWO\|\|''/);
  // setGapData must keep a gap that arrives at no stop.
  const set = captureJs.slice(captureJs.indexOf('function setGapData('), captureJs.indexOf('function gapNet('));
  assert.doesNotMatch(set, /\.filter\(/, 'a filter here would drop the two slots and the next save would delete their rows');
});

test('the spine sends the same two slots on a land day', () => {
  const idle = codeGs.slice(codeGs.indexOf("if (p.action === 'idle')"), codeGs.indexOf('// ── Actions'));
  assert.match(idle, /mapped\.unshift\(noOrder\('00:00'\)\);/);
  assert.match(idle, /mapped\.push\(noOrder\('23:59'\)\);/);
  assert.match(idle, /allocations: allocFor\(t, t\)/, 'pre-filled from the saved rows, like every other gap');
  const land = idle.slice(idle.indexOf('if (isLand) {'));
  assert.ok(land.includes("noOrder('00:00')"), 'land days only');
});

test('the office editor draws them too, and saves the whole gap list back', () => {
  assert.match(editJs, /edgeCard\(before, 'Before first order'\)/);
  assert.match(editJs, /edgeCard\(after, 'After last order'\)/);
  assert.match(editJs, /allocations: collectGapAllocations\(gapData\)/);
});
