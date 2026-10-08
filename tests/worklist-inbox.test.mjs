// The photo bot's drop box (Code.gs queueWorklistOrders + claimWorklistInbox).
// Code.gs can't be imported, so — like dwell-measure.test.mjs — the real source is
// evaluated with the Apps Script surface stubbed, here over a small in-memory
// spreadsheet so the actual row writes are exercised, not just the source text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE = readFileSync(join(ROOT, 'Code.gs'), 'utf8');

// ── a minimal in-memory Sheet: just the calls these paths make ──────────────
function fakeSheet(grid){
  const width = () => Math.max(0, ...grid.map(r => r.length));
  const range = (row, col, nr = 1, nc = 1) => ({
    getValues: () => grid.slice(row - 1, row - 1 + nr)
      .map(r => Array.from({ length: nc }, (_, i) => r[col - 1 + i] ?? '')),
    setValues: vals => vals.forEach((v, i) => {
      const r = grid[row - 1 + i] || (grid[row - 1 + i] = []);
      v.forEach((cell, j) => { r[col - 1 + j] = cell; });
    }),
    setValue: v => { (grid[row - 1] || (grid[row - 1] = []))[col - 1] = v; },
    setNumberFormat(){}, setFontWeight(){},
  });
  return {
    grid,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxRows: () => grid.length + 100,
    appendRow: r => { grid.push(r.slice()); },
    setFrozenRows(){},
    getDataRange: () => range(1, 1, grid.length, width()),
    getRange: (a, b, c, d) => typeof a === 'string' ? range(2, 1) : range(a, b, c, d),
  };
}

function spine(tabs){
  const sheets = {};
  for(const [name, grid] of Object.entries(tabs)) sheets[name] = fakeSheet(grid);
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = fakeSheet([])),
  };
  const locks = { taken: 0 };
  const api = new Function('SpreadsheetApp', 'Utilities', 'Session', 'PropertiesService',
    'UrlFetchApp', 'LockService', 'ContentService', 'ScriptApp', 'CacheService', `
    ${CODE}
    return { queueWorklistOrders, claimWorklistInbox, worklistFor, WORKLIST_HEADERS };
  `)(
    { getActiveSpreadsheet: () => ss },
    { formatDate: () => '2026-10-08 10:43:00' }, {}, {}, {},
    { getScriptLock: () => ({ tryLock: () => { locks.taken++; return true; }, releaseLock(){} }) },
    {}, {}, { getScriptCache: () => null });
  return { ...api, sheets, locks };
}

const EMPLOYEES = [['hNumber','firstName','lastName'], ['H100','Ann','Example'], ['H200','Bob','Other']];

function worklistRow(headers, rec){ return headers.map(h => rec[h] ?? ''); }

function withWorklist(rows){
  const s = spine({ Employees: EMPLOYEES.map(r => r.slice()), Worklist: [] });
  const H = s.WORKLIST_HEADERS;
  s.sheets.Worklist.grid.push(H.slice(), ...rows.map(r => worklistRow(H, r)));
  return s;
}

test('queue → claim → the orders are on the installer\'s worklist, pending, after their last order', () => {
  const s = withWorklist([
    { id: 'a', hNumber: 'H100', workOrderId: '900001', wlStatus: 'pending', order: 0 },
    { id: 'b', hNumber: 'H100', workOrderId: '900002', wlStatus: 'pending', order: 10 },
    { id: 'c', hNumber: 'H200', workOrderId: '900003', wlStatus: 'pending', order: 990 },
  ]);
  const q = s.queueWorklistOrders({ hNumber: 'H100', orders: ['902732', '900821'], source: 'telegram' });
  assert.deepEqual(q, { ok: true, queued: ['902732', '900821'], skipped: [], installer: 'Ann Example' });

  assert.equal(s.claimWorklistInbox('H100'), 2);
  const mine = s.worklistFor('H100');
  assert.deepEqual(mine.map(r => String(r.workOrderId)), ['900001', '900002', '902732', '900821']);
  const added = mine.slice(2);
  assert.deepEqual(added.map(r => r.order), [20, 30], 'after H100\'s own max order, not H200\'s');
  for(const r of added){
    assert.equal(r.wlStatus, 'pending');
    assert.equal(r.installer, 'Ann Example');
    assert.equal(r.address, '');
    assert.match(String(r.id), /^inbox-/);
  }
  // Every inbox row is now stamped claimed.
  assert.ok(s.sheets.WorklistInbox.grid.slice(1).every(r => r[5] === '2026-10-08 10:43:00'));
});

test('a second read claims nothing and takes no lock', () => {
  const s = withWorklist([]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['902732'] });
  assert.equal(s.claimWorklistInbox('H100'), 1);
  const locksAfterFirst = s.locks.taken;
  assert.equal(s.claimWorklistInbox('H100'), 0);
  assert.equal(s.locks.taken, locksAfterFirst, 'the Drive screen polls this read — no lock when idle');
  assert.equal(s.worklistFor('H100').length, 1);
});

test('another installer\'s inbox rows are left waiting', () => {
  const s = withWorklist([]);
  s.queueWorklistOrders({ hNumber: 'H200', orders: ['902732'] });
  assert.equal(s.claimWorklistInbox('H100'), 0);
  assert.equal(s.worklistFor('H100').length, 0);
  assert.equal(s.claimWorklistInbox('H200'), 1);
});

test('queue skips numbers already pending, already waiting, or repeated in the batch', () => {
  const s = withWorklist([
    { id: 'a', hNumber: 'H100', workOrderId: '902732', wlStatus: 'pending', order: 0 },
    { id: 'd', hNumber: 'H100', workOrderId: '905486', wlStatus: 'done', order: 10 },
  ]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['900821'] });
  const q = s.queueWorklistOrders({ hNumber: 'H100',
    orders: ['902732', '900821', '905486', '907209', '907209', ' '] });
  assert.deepEqual(q.queued, ['905486', '907209'], 'a done order may be re-queued (revisit)');
  assert.deepEqual(q.skipped, ['902732', '900821', '907209']);
});

test('a number that became pending between queue and claim is claimed without a second row', () => {
  const s = withWorklist([]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['902732', '900821'] });
  // The installer typed one in by hand and the phone pushed its list.
  const H = s.WORKLIST_HEADERS;
  s.sheets.Worklist.grid.push(worklistRow(H, { id: 'x', hNumber: 'H100', workOrderId: '902732',
    wlStatus: 'pending', order: 0 }));
  assert.equal(s.claimWorklistInbox('H100'), 1);
  assert.deepEqual(s.worklistFor('H100').map(r => String(r.workOrderId)), ['902732', '900821']);
});

test('queue refuses an unknown or missing H number', () => {
  const s = withWorklist([]);
  assert.equal(s.queueWorklistOrders({ hNumber: 'H999', orders: ['902732'] }).ok, false);
  assert.equal(s.queueWorklistOrders({ orders: ['902732'] }).ok, false);
});

test('the claim is wired into the worklist read and the action into doPost', () => {
  const read = CODE.match(/if \(p\.action === 'worklist'\) \{[\s\S]*?\n  \}/)[0];
  assert.match(read, /try \{ claimWorklistInbox\(p\.hNumber\); \} catch[\s\S]*worklistFor\(p\.hNumber\)/,
    'claim BEFORE the read, in the same request — and fenced, so a failed claim never fails the read');
  assert.match(CODE, /case 'queueWorklistOrders':\s*return json\(queueWorklistOrders\(body\)\)/);
  assert.match(CODE, /function setupSheets\(\)[\s\S]*?ensureWorklistInboxTab\(ss\)/);
});
