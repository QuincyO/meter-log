// The land daily log's lines under the totals row: delay minutes on no work order.
//
// They used to be one "Not tied to a WO#" line. The morning's downtime and the end of
// the day's are entered on their own cards, so each prints on its own line, and "Not
// tied" is left for downtime that was added with no work order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { untiedLines, renderLandDailyLog } from '../js/dailylog.js';
import { buildLocalSummary } from '../js/compute/summary.js';

const row = (category, minutes, note = '', workOrderId = '') => ({ category, minutes, note, workOrderId });
const BEFORE = 'gap 00:00–00:00', AFTER = 'gap 23:59–23:59';

// A stand-in for jsPDF that keeps every string drawn, with its page and height.
function drawn(summary, pageH = 612){
  const out = []; let page = 1;
  class FakePdf {
    constructor(){ this.internal = { pageSize: { getWidth:() => 792, getHeight:() => pageH } }; }
    text(t, x, y){ out.push({ t, y, page }); }
    addPage(){ page++; }
    getTextWidth(t){ return String(t).length * 4; }
    splitTextToSize(t){ return [t]; }
    output(){ return 'blob'; }
    setLineWidth(){} setDrawColor(){} setFillColor(){} setFont(){} setFontSize(){} rect(){}
  }
  globalThis.window = { jspdf: { jsPDF: FakePdf } };
  try { renderLandDailyLog(summary); } finally { delete globalThis.window; }
  return out;
}

test('before, after and unattached downtime each get their own line', () => {
  assert.deepEqual(untiedLines([
    row('TRUCK_ISSUES', 25, AFTER), row('ASSIST', 15), row('DISPATCH', 35, BEFORE), row('WAREHOUSE', 10, BEFORE),
  ]), [
    'Before first work order: Warehouse 10 · Dispatch 35 min',
    'After last work order: Truck Issues 25 min',
    'Not tied to a WO#: Assist 15 min',
  ]);
});

test('a line with nothing on it is not printed', () => {
  assert.deepEqual(untiedLines([row('DISPATCH', 35, BEFORE)]), ['Before first work order: Dispatch 35 min']);
  assert.deepEqual(untiedLines([row('DISPATCH', 35, AFTER)]), ['After last work order: Dispatch 35 min']);
  assert.deepEqual(untiedLines([row('DISPATCH', 35, 'waited at the yard')]), ['Not tied to a WO#: Dispatch 35 min']);
  assert.deepEqual(untiedLines([]), []);
  assert.deepEqual(untiedLines(undefined), []);
});

test('only the two fixed keys count, whatever dash they were written with', () => {
  assert.deepEqual(untiedLines([row('OTHER', 5, 'gap 00:00-00:00'), row('OTHER', 6, 'gap 23:59-23:59')]),
    ['Before first work order: Other 5 min', 'After last work order: Other 6 min']);
  // An ordinary gap with no WO#, even one touching a key, is still not tied.
  assert.deepEqual(untiedLines([row('OTHER', 5, 'gap 09:00–09:40'), row('OTHER', 6, 'gap 00:00–09:00')]),
    ['Not tied to a WO#: Other 11 min']);
});

test('a row on a work order, a break and a zero are on no line', () => {
  assert.deepEqual(untiedLines([row('DISPATCH', 35, '', '100'), row('LUNCH', 30, BEFORE), row('DISPATCH', 0, AFTER)]), []);
});

test('the land PDF draws the lines under the totals, and the column totals still count them', () => {
  const texts = drawn({ workType:'land', date:'2026-11-25', installer:'Pat Example',
    stops: [{ id:'a', status:'INSTALLED', workOrderId:'100', timestamp:'2026-11-25 09:00:00' }],
    downtime: [row('DISPATCH', 35, BEFORE), row('DISPATCH', 5, AFTER), row('DISPATCH', 2)] });
  const at = s => texts.findIndex(x => x.t === s);
  const order = [at('Totals · 1 Install · 0 UTI'), at('42'), at('Before first work order: Dispatch 35 min'),
    at('After last work order: Dispatch 5 min'), at('Not tied to a WO#: Dispatch 2 min')];
  assert.ok(order.every(i => i > -1), JSON.stringify(order));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
});

test('lines that do not fit go to the next page instead of off the bottom', () => {
  const stops = Array.from({ length: 29 }, (_, i) => ({ id:'s' + i, status:'INSTALLED', workOrderId:String(100 + i), timestamp:'2026-11-25 09:00:00' }));
  // Page heights around the totals row: one of them leaves room for some of the lines.
  for(let pageH = 560; pageH <= 640; pageH += 5){
    const lines = drawn({ workType:'land', stops, downtime: [row('DISPATCH', 35, BEFORE), row('DISPATCH', 5, AFTER), row('DISPATCH', 2)] }, pageH)
      .filter(x => /^(Before|After|Not tied)/.test(x.t));
    assert.equal(lines.length, 3);
    for(const l of lines) assert.ok(l.y <= pageH - 21.6, `"${l.t}" at ${l.y} on a page ${pageH} high`);
  }
});

test('the PDF built on the phone with no signal splits them the same way', () => {
  const s = buildLocalSummary({ workType:'land', stops:[], downtime:[], pendingTravel: [
    { fromTime:'00:00', toTime:'00:00', workOrderId:'', category:'DISPATCH', minutes:35 },
    { fromTime:'23:59', toTime:'23:59', workOrderId:'', category:'ASSIST', minutes:15 },
  ] });
  assert.deepEqual(untiedLines(s.downtime), ['Before first work order: Dispatch 35 min', 'After last work order: Assist 15 min']);
});
