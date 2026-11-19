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
    return { auditRead };
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
