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
    clearContent: () => { for(let i = 0; i < nr; i++) if(grid[row - 1 + i]) grid[row - 1 + i].fill('', col - 1, col - 1 + nc); },
    setNumberFormat(){}, setFontWeight(){},
  });
  return {
    grid,
    getLastRow: () => grid.length,
    getLastColumn: () => width(),
    getMaxRows: () => grid.length + 100,
    appendRow: r => { grid.push(r.slice()); },
    deleteRows: (start, n) => { grid.splice(start - 1, n); },
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
    return { queueWorklistOrders, claimWorklistInbox, worklistFor, WORKLIST_HEADERS,
      removeWorklistOrders, saveWorklist, sweepWorklistRemovedCore, WORKLIST_REMOVED_HEADERS };
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

test('queue skips numbers already on the list (pending OR done), already waiting, or repeated in the batch', () => {
  const s = withWorklist([
    { id: 'a', hNumber: 'H100', workOrderId: '902732', wlStatus: 'pending', order: 0 },
    { id: 'd', hNumber: 'H100', workOrderId: '905486', wlStatus: 'done', order: 10 },
    { id: 'x', hNumber: 'H200', workOrderId: '907209', wlStatus: 'done', order: 0 },
  ]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['900821'] });
  const q = s.queueWorklistOrders({ hNumber: 'H100',
    orders: ['902732', '900821', '905486', '907209', '907209', ' '] });
  // An order logged today is still on the handheld's list when it is photographed
  // again (a UTI stays there), so re-queueing a done number put a second, pending
  // copy of a finished order on the phone — field report 2026-11-13, 984647.
  assert.deepEqual(q.queued, ['907209'], 'a finished order is not queued again; another installer\'s done row is not ours');
  assert.deepEqual(q.skipped, ['902732', '900821', '905486', '907209']);
});

test('a number finished between queue and claim is claimed without a second row', () => {
  const s = withWorklist([]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['902732', '900821'] });
  // Typed in by hand, logged, and pushed up as done before any Download.
  const H = s.WORKLIST_HEADERS;
  s.sheets.Worklist.grid.push(worklistRow(H, { id: 'x', hNumber: 'H100', workOrderId: '902732',
    wlStatus: 'done', order: 0 }));
  assert.equal(s.claimWorklistInbox('H100'), 1);
  assert.deepEqual(s.worklistFor('H100').map(r => `${r.workOrderId} ${r.wlStatus}`),
    ['902732 done', '900821 pending']);
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

// ── orders that left the handheld: compare → remove → (undo) ────────────────
const LIST = [
  { id: 'a', hNumber: 'H100', workOrderId: '900001', wlStatus: 'pending', order: 0,
    address: '12 Main St', unit: '2', lat: 45.1, lng: -79.2,
    appointmentDate: '2026-11-14', appointmentTime: '10:00' },
  { id: 'b', hNumber: 'H100', workOrderId: '900002', wlStatus: 'pending', order: 10 },
  { id: 'd', hNumber: 'H100', workOrderId: '900004', wlStatus: 'done', order: 20 },
  { id: 'e', hNumber: 'H100', workOrderId: '', wlStatus: 'pending', order: 30, address: '9 No Number Rd' },
  { id: 'c', hNumber: 'H200', workOrderId: '900003', wlStatus: 'pending', order: 0 },
];
const removedRows = s => {
  const sh = s.sheets.WorklistRemoved;
  if(!sh) return [];
  const H = sh.grid[0];
  return sh.grid.slice(1).map(r => Object.fromEntries(H.map((h, i) => [h, r[i] ?? ''])));
};

test('compare lists the pending orders that were not in the batch — and only those', () => {
  const s = withWorklist(LIST);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['900009'] });   // waiting, not downloaded yet
  const inboxId = s.sheets.WorklistInbox.grid[1][0];
  const q = s.queueWorklistOrders({ hNumber: 'H100', orders: ['900002', '905555'], compare: true });
  assert.deepEqual(q.queued, ['905555']);
  assert.deepEqual(q.missing, [
    { id: 'a', workOrderId: '900001', address: '12 Main St',
      appointmentDate: '2026-11-14', appointmentTime: '10:00' },
    { id: 'inbox-' + inboxId, workOrderId: '900009', address: '',
      appointmentDate: '', appointmentTime: '', waiting: true },
  ], 'not the done order, not the blank-WO# order, not another installer\'s');
  assert.equal(q.pendingCount, 3, 'what the list held before this send: a, b and the waiting one');
});

test('without compare the response is what it always was', () => {
  const s = withWorklist(LIST);
  const q = s.queueWorklistOrders({ hNumber: 'H100', orders: ['900002'] });
  assert.deepEqual(q, { ok: true, queued: [], skipped: ['900002'], installer: 'Ann Example' });
});

test('remove archives the details, deletes the row, and touches nobody else', () => {
  const s = withWorklist(LIST);
  const r = s.removeWorklistOrders({ hNumber: 'H100', ids: ['a', 'd', 'c', 'nope'], source: 'telegram' });
  assert.deepEqual(r, { ok: true, removed: ['900001'], skipped: ['900004'], installer: 'Ann Example' });
  assert.deepEqual(s.worklistFor('H100').map(x => x.id), ['b', 'd', 'e'], 'a done order is left alone');
  assert.deepEqual(s.worklistFor('H200').map(x => x.id), ['c'], 'another installer\'s row is not ours to remove');
  const [arch] = removedRows(s);
  assert.equal(removedRows(s).length, 1);
  assert.equal(arch.hNumber, 'H100');
  assert.equal(arch.worklistId, 'a');
  assert.equal(arch.workOrderId, '900001');
  assert.equal(arch.restoredAt, '');
  assert.deepEqual(JSON.parse(arch.row), { unit: '2', address: '12 Main St', lat: 45.1, lng: -79.2,
    appointmentDate: '2026-11-14', appointmentTime: '10:00' });
});

test('a repeat remove is a no-op, and a bad H number is refused', () => {
  const s = withWorklist(LIST);
  s.removeWorklistOrders({ hNumber: 'H100', ids: ['a'] });
  const again = s.removeWorklistOrders({ hNumber: 'H100', ids: ['a'] });
  assert.deepEqual([again.ok, again.removed, again.skipped], [true, [], []]);
  assert.equal(removedRows(s).length, 1);
  assert.equal(s.removeWorklistOrders({ hNumber: 'H999', ids: ['a'] }).ok, false);
  assert.equal(s.removeWorklistOrders({ ids: ['a'] }).ok, false);
});

test('a phone that has not downloaded cannot push a removed order back', () => {
  const s = withWorklist(LIST);
  s.removeWorklistOrders({ hNumber: 'H100', ids: ['a'] });
  // The stale phone still holds 'a' and whole-list replaces after its next log.
  const up = s.saveWorklist({ hNumber: 'H100', orders: [
    { id: 'a', workOrderId: '900001', address: '12 Main St', order: 0 },
    { id: 'b', workOrderId: '900002', order: 10 },
    { id: 'typed-again', workOrderId: '900001', order: 20 },
  ] });
  assert.equal(up.ok, true);
  assert.deepEqual(s.worklistFor('H100').map(x => x.id), ['b', 'typed-again'],
    'the tombstone is the ROW id — the same WO# typed in again is a new order and stays');
  assert.deepEqual(s.worklistFor('H200').map(x => x.id), ['c']);
});

test('an order that comes back comes back with its details (this is /undo)', () => {
  const s = withWorklist(LIST);
  s.removeWorklistOrders({ hNumber: 'H100', ids: ['a'] });
  const q = s.queueWorklistOrders({ hNumber: 'H100', orders: ['900001', '907777'], source: 'telegram-undo' });
  assert.deepEqual(q.queued, ['900001', '907777']);
  assert.equal(s.claimWorklistInbox('H100'), 2);
  const mine = s.worklistFor('H100');
  const back = mine.find(x => String(x.workOrderId) === '900001');
  assert.match(String(back.id), /^inbox-/, 'a fresh id, so the old tombstone never catches it');
  assert.equal(back.address, '12 Main St');
  assert.equal(back.unit, '2');
  assert.equal(back.lat, 45.1);
  assert.equal(back.lng, -79.2);
  assert.equal(back.appointmentDate, '2026-11-14');
  assert.equal(back.appointmentTime, '10:00');
  assert.equal(back.wlStatus, 'pending');
  const fresh = mine.find(x => String(x.workOrderId) === '907777');
  assert.equal(fresh.address, '', 'an order with no archive is the bare row it always was');
  assert.equal(removedRows(s)[0].restoredAt, '2026-10-08 10:43:00');

  // Restored once: removing it again writes a NEW archive row; the spent one stays spent.
  s.removeWorklistOrders({ hNumber: 'H100', ids: [back.id] });
  assert.equal(removedRows(s).length, 2);
  assert.equal(removedRows(s)[1].restoredAt, '');
  assert.equal(JSON.parse(removedRows(s)[1].row).address, '12 Main St');
});

test('removing an order still waiting in the inbox cancels it', () => {
  const s = withWorklist([]);
  s.queueWorklistOrders({ hNumber: 'H100', orders: ['902732', '900821'] });
  const { missing } = s.queueWorklistOrders({ hNumber: 'H100', orders: ['900821'], compare: true });
  assert.deepEqual(missing.map(m => m.workOrderId), ['902732']);
  const r = s.removeWorklistOrders({ hNumber: 'H100', ids: [missing[0].id] });
  assert.deepEqual(r.removed, ['902732']);
  assert.equal(s.claimWorklistInbox('H100'), 1);
  assert.deepEqual(s.worklistFor('H100').map(x => String(x.workOrderId)), ['900821']);
  assert.match(String(s.sheets.WorklistInbox.grid[1][5]), /^cancelled /);
});

test('old archive rows are swept; an unreadable date is kept', () => {
  const s = withWorklist(LIST);
  s.removeWorklistOrders({ hNumber: 'H100', ids: ['a'] });
  const g = s.sheets.WorklistRemoved.grid, at = s.WORKLIST_REMOVED_HEADERS.indexOf('removedAt');
  g[1][at] = '2020-01-01 8:00:00';
  g.push(g[1].slice()); g[2][at] = '2999-01-01 08:00:00';
  g.push(g[1].slice()); g[3][at] = 'not a date';
  assert.equal(s.sweepWorklistRemovedCore(), 1);
  assert.deepEqual(s.sheets.WorklistRemoved.grid.slice(1).map(r => r[at]), ['2999-01-01 08:00:00', 'not a date']);
});

test('remove is a doPost action, the tab is in setupSheets, and the sweep rides the nightly job', () => {
  assert.match(CODE, /case 'removeWorklistOrders':\s*return json\(removeWorklistOrders\(body\)\)/);
  assert.match(CODE, /function setupSheets\(\)[\s\S]*?ensureWorklistRemovedTab\(ss\)/);
  assert.match(CODE, /function clearDoneWorklistJob\(\)[\s\S]*?sweepWorklistRemovedCore\(\)[\s\S]*?\n}/);
});
