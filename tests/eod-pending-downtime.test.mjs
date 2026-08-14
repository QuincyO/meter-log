// The end-of-day review's un-synced deductions must PRINT, not just net out of travel.
//
// buildLocalSummary threaded `pendingTravel` into computeGapsLocal (so the Travel
// column was right) but left it out of the `downtime` array it returns — and every
// delay figure on both PDF templates is built from that array: the land per-WO DELAYS
// grid, the boat "Delay Time" box, the "Delays:" footer. So a Finish tapped before the
// background summary prefetch had finished fell back to this builder and printed a
// blank delay grid for work the installer had just typed, while the same minutes
// reached the Sheet a moment later via saveTravel. Reported from the field as
// "if I hit finish too quickly none of my downtime is on the PDF".
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalSummary } from '../js/compute/summary.js';
import { collectNotes } from '../js/dailylog.js';

const STOPS = [
  { id:'a', workOrderId:'WO1', status:'INSTALLED', timestamp:'2026-08-13 09:00:00' },
  { id:'b', workOrderId:'WO2', status:'INSTALLED', timestamp:'2026-08-13 10:00:00' },
];
const base = extra => Object.assign({
  installer:'Sam Field', date:'2026-08-13', stops:STOPS, downtime:[], day:{}, workType:'land',
}, extra);

test('a pending gap deduction is printed as a downtime row', () => {
  const s = buildLocalSummary(base({ pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'TOOLS_MATERIAL', minutes:20 },
  ]}));
  assert.equal(s.downtime.length, 1);
  const row = s.downtime[0];
  assert.equal(row.category, 'TOOLS_MATERIAL');
  assert.equal(row.minutes, 20);
  assert.equal(row.workOrderId, 'WO2', 'the arriving WO is what puts it on the land PDF row');
  assert.equal(row.note, 'gap 09:00–10:00', 'same gap tag saveTravel writes, en dash included');
  assert.equal(row.workType, 'land');
  assert.equal(s.downtimeTotalMin, 20, 'a delay category counts in the Delay Time box');
  // …and it still nets out of that gap's travel: 60 min gap − 20 = 40.
  assert.equal(s.perStopTravel.b, 40);
});

test('breaks and misc travel print but stay out of the delay total', () => {
  const s = buildLocalSummary(base({ pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'LUNCH', minutes:30 },
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'MISC_TRAVEL', minutes:5 },
  ]}));
  assert.equal(s.downtime.length, 2);
  assert.equal(s.downtimeTotalMin, 0, 'breaks / misc travel are not delays');
  assert.equal(s.perStopTravel.b, 25, 'both still subtract from the gap');
});

test('an already-saved gap row plus the same pending edit counts once', () => {
  // saveTravel REPLACES the day's gap-tagged rows, so the pending list is the whole
  // truth. Keeping the saved copy too would double every re-edited deduction.
  const saved = { id:'srv1', category:'TOOLS_MATERIAL', minutes:20, workOrderId:'WO2',
                  note:'gap 09:00–10:00' };
  const s = buildLocalSummary(base({ downtime:[saved], pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'TOOLS_MATERIAL', minutes:25 },
  ]}));
  assert.equal(s.downtime.length, 1);
  assert.equal(s.downtime[0].minutes, 25, 'the live edit wins');
  assert.equal(s.downtimeTotalMin, 25);
});

test('a manual downtime row survives the merge', () => {
  // Only GAP-tagged rows are replaced — an Add-downtime row has no gap note and is
  // never touched by saveTravel either.
  const manual = { id:'m1', category:'WAREHOUSE', minutes:15, workOrderId:'WO1', note:'parts' };
  const s = buildLocalSummary(base({ downtime:[manual], pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'ASSIST', minutes:10 },
  ]}));
  assert.equal(s.downtime.length, 2);
  assert.ok(s.downtime.some(d => d.id === 'm1'));
  assert.equal(s.downtimeTotalMin, 25);
});

test('a zero-minute placeholder row is not printed', () => {
  // "+ Subtract downtime / break" adds a row at 0 before anything is typed; saveTravel
  // filters those out, so the PDF must not show one either.
  const s = buildLocalSummary(base({ pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'BREAK', minutes:0 },
  ]}));
  assert.equal(s.downtime.length, 0);
});

test('with nothing pending the saved rows are left exactly as they were', () => {
  const saved = [{ id:'srv1', category:'ASSIST', minutes:10, workOrderId:'WO2',
                   note:'gap 09:00–10:00' }];
  const s = buildLocalSummary(base({ downtime:saved }));
  assert.deepEqual(s.downtime, saved);
  assert.equal(s.downtimeTotalMin, 10);
  assert.equal(s.perStopTravel.b, 50, 'the saved rows still net out of the gap');
});

test('the synthesized gap tag never reaches the PDF Notes block', () => {
  // collectNotes drops machine gap tags — the note column is overloaded, and these
  // rows are exactly the overload.
  const s = buildLocalSummary(base({ pendingTravel:[
    { fromTime:'09:00', toTime:'10:00', workOrderId:'WO2', category:'ASSIST', minutes:10 },
  ]}));
  assert.deepEqual(collectNotes(s), []);
});

test('the land lead gap attributes downtime to the first work order', () => {
  // A first stop is no WO→WO gap's arrival, so land mode gives it a zero-length lead
  // gap (from == to) purely to hang downtime on. It has no travel to net against, but
  // it must still print on that WO's row.
  const s = buildLocalSummary(base({ pendingTravel:[
    { fromTime:'09:00', toTime:'09:00', workOrderId:'WO1', category:'NEXT_GEN', minutes:12 },
  ]}));
  assert.equal(s.downtime.length, 1);
  assert.equal(s.downtime[0].workOrderId, 'WO1');
  assert.equal(s.downtimeTotalMin, 12);
});
