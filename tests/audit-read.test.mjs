// auditRead lives in Code.gs, which node cannot import, so evaluate the real source
// with the Apps Script surface stubbed and rows() swapped for fixtures — the same
// approach as installer-day-shape.test.mjs. The harness's Utilities.formatDate
// throws, so every date and clock here is a plain string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NO_APPS_SCRIPT = () => { throw new Error('Apps Script API reached'); };

function spine(tables){
  const src = readFileSync(join(ROOT, 'Code.gs'), 'utf8')
    .replace(/^function rows\(/m, 'function __sheetRows(');
  return new Function('SpreadsheetApp', 'Utilities', 'Session', 'PropertiesService',
    'UrlFetchApp', 'LockService', 'ContentService', 'ScriptApp', 'CacheService', '__T', `
    function rows(n){ return __T[n] || []; }
    ${src}
    return { auditRead, getNeedsAdmin, myDriveTracksRead: typeof myDriveTracksRead === 'function' ? myDriveTracksRead : null };
  `)(
    { getActiveSpreadsheet: () => ({ getSheetByName: n => (tables[n] ? {} : null) }) },
    { formatDate: NO_APPS_SCRIPT }, {}, {}, {}, {}, {}, {}, {},
    { Stops: [], ...tables });
}

test('auditRead returns one installer\'s printable logs, delays and bookends', () => {
  const { auditRead } = spine({
    Stops: [
      { id:'a', timestamp:'2026-09-01 9:05:00', installer:'Pat Example', status:'INSTALLED', workOrderId:'900001', address:'1 Main St', lat:44.1, lng:-79.1, workType:'land' },
      { id:'b', timestamp:'2026-09-01 09:20:00', installer:'Pat Example ', status:'DONE', lat:44.1, lng:-79.1 },
      { id:'c', timestamp:'2026-09-01 09:30:00', installer:'Pat Example', status:'UTI', workOrderId:'900002', lat:'', lng:'' },
      { id:'d', timestamp:'2026-09-01 09:40:00', installer:'Sam Other', status:'INSTALLED', lat:44.2, lng:-79.2 },
    ],
    Downtime: [
      { id:'x', timestamp:'2026-09-01 16:00:00', installer:'Pat Example', category:'WAREHOUSE', minutes:20, workOrderId:'', note:'gap 09:05–09:30', workType:'' },
      { id:'y', timestamp:'2026-09-01 16:00:00', installer:'Sam Other', category:'DISPATCH', minutes:30, note:'' },
    ],
    Days: [
      { date:'2026-09-01', installer:'Pat Example', departure:'07:30', returned:'16:00' },
      { date:'2026-09-01', installer:'Sam Other', departure:'07:30', returned:'17:00' },
    ],
  });
  const r = auditRead('Pat Example');
  assert.equal(r.ok, true);
  assert.equal(r.installer, 'Pat Example');
  assert.deepEqual(r.stops.map(s => s.id), ['a', 'c']);            // DONE and other installers dropped
  assert.deepEqual([r.stops[1].lat, r.stops[1].lng], [null, null]);
  assert.deepEqual(Object.keys(r.stops[0]).sort(), ['address','id','lat','lng','status','timestamp','workOrderId']);
  assert.deepEqual(r.downtime.map(d => d.id), ['x']);              // blank workType kept
  assert.deepEqual(Object.keys(r.downtime[0]).sort(), ['category','id','minutes','note','timestamp','workOrderId']);
  assert.deepEqual(r.days, [{ date:'2026-09-01', departure:'07:30', returned:'16:00' }]);
});

test('auditRead keeps the four printable statuses whatever their case', () => {
  const stop = (id, status) => ({ id, timestamp:'2026-09-01 09:00:00', installer:'Pat Example', status });
  const { auditRead } = spine({ Stops: [
    stop('a', 'installed'), stop('b', 'UTI'), stop('c', 'Visited'), stop('d', 'UNACCOUNTED'),
    stop('e', 'DONE'), stop('f', 'ARRIVED'), stop('g', ''),
  ] });
  assert.deepEqual(auditRead('Pat Example').stops.map(s => s.id), ['a', 'b', 'c', 'd']);
});

test('auditRead refuses a blank installer', () => {
  const { auditRead } = spine({});
  assert.deepEqual(auditRead('  '), { ok:false, error:'installer required' });
  assert.deepEqual(auditRead(undefined), { ok:false, error:'installer required' });
});

test('auditRead tolerates a sheet with no Days tab', () => {
  const { auditRead } = spine({ Stops: [] });
  assert.deepEqual(auditRead('Pat Example').days, []);
});

// ── an installer's own drive log (myDriveTracks) ─────────────────────────────
// Owner's decision, 2026-11-19: an installer may see their own drive log on My
// audit. The read is token-only, asks for the name AND the H number that belongs to
// it, and hands over one day at a time. It is not a lock (the roster read gives out
// H numbers); it is a check that the asker knows which installer they are.

const leg = (id, date, installer) => ({ id, date, installer, workType: 'land', startTime: 1, endTime: 2, pointCount: 3,
  distanceM: 31400, driveMin: 52, avgSpeed: 10, maxSpeed: 23.4, gaps: '[]', encoded: 'abc' });
const DRIVE = {
  Employees: [{ hNumber: 'H123', firstName: 'Pat', lastName: 'Example', active: true }, { hNumber: 'H456', firstName: 'Sam', lastName: 'Other', active: true }],
  DriveTracks: [leg('l1', '2026-09-01', 'Pat Example'), leg('l2', '2026-09-02', 'Pat Example'), leg('l3', '2026-09-01', 'Sam Other')],
};

test('myDriveTracks hands an installer their own legs for one day', () => {
  const { myDriveTracksRead } = spine(DRIVE);
  const res = myDriveTracksRead('Pat Example', 'H123', '2026-09-01', '2026-09-01');
  assert.equal(res.ok, true);
  assert.deepEqual(res.driveTracks.map(l => l.id), ['l1']);
  assert.equal(res.driveTracks[0].maxSpeed, 23.4);
  assert.deepEqual(myDriveTracksRead(' pat example ', ' H123 ', '2026-09-02', '2026-09-02').driveTracks.map(l => l.id), ['l2'], 'case and spaces in the name are forgiven');
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H123', '2026-09-03', '2026-09-03').driveTracks, []);
});

test('myDriveTracks refuses a name and H number that do not belong together, and anything but one day', () => {
  const { myDriveTracksRead } = spine(DRIVE);
  const no = { ok: false, error: 'name and H number do not match' };
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H456', '2026-09-01', '2026-09-01'), no, 'another installer\'s number');
  assert.deepEqual(myDriveTracksRead('Sam Other', 'H123', '2026-09-01', '2026-09-01'), no);
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H999', '2026-09-01', '2026-09-01'), no, 'no such number');
  assert.deepEqual(myDriveTracksRead('Pat Example', '', '2026-09-01', '2026-09-01'), no);
  assert.deepEqual(myDriveTracksRead('', 'H123', '2026-09-01', '2026-09-01'), no);
  assert.deepEqual(myDriveTracksRead(undefined, undefined, '2026-09-01', '2026-09-01'), no);
  const oneDay = { ok: false, error: 'one day at a time' };
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H123', '', ''), oneDay);
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H123', '2026-09-01', '2026-09-02'), oneDay);
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H123', '2026-09-01', undefined), oneDay);
  assert.deepEqual(myDriveTracksRead('Pat Example', 'H123', 'yesterday', 'yesterday'), oneDay);
});

test('the office read of every drive log stays behind the password, and the installer\'s own does not', () => {
  const { getNeedsAdmin } = spine(DRIVE);
  assert.equal(getNeedsAdmin({ action: 'driveTracks' }), true);
  assert.equal(getNeedsAdmin({ action: 'driveTracks', installer: 'Pat Example' }), true);
  assert.equal(getNeedsAdmin({ action: 'myDriveTracks' }), false);
});
