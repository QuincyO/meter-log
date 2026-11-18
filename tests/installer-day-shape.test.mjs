// installerDayShape lives in Code.gs, which node cannot import, so evaluate the real
// source with the Apps Script surface stubbed and rows() swapped for fixtures — the
// same approach as dwell-measure.test.mjs.
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
    return { installerDayShape };
  `)(
    { getActiveSpreadsheet: () => ({ getSheetByName: n => (tables[n] ? {} : null) }) },
    { formatDate: NO_APPS_SCRIPT }, {}, {}, {}, {}, {}, {}, {},
    { Stops: [], ...tables });
}

const pad = n => String(n).padStart(2, '0');
const clockOf = mins => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
const TEN_GAPS = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];

// One day of Stops rows: the first log at firstClock, the rest spaced by `gaps`.
function dayRows(date, firstClock, { gaps = TEN_GAPS, workType = 'land' } = {}){
  const [h, m] = firstClock.split(':').map(Number);
  let mins = h * 60 + m;
  const out = [{ timestamp: `${date} ${clockOf(mins)}` }];
  gaps.forEach(g => { mins += g; out.push({ timestamp: `${date} ${clockOf(mins)}` }); });
  return out.map((r, i) => ({ id: `${date}-${i}`, installer: 'Pat Example',
    status: 'INSTALLED', workType, ...r }));
}
const landDay = (date, firstClock, opts) => dayRows(date, firstClock, opts);

// `count` consecutive weekdays ending on `end`.
function weekdays(count, end){
  const out = [];
  const d = new Date(end + 'T12:00:00Z');
  while(out.length < count){
    if(d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const landDays = (count, firstClock, { end = '2026-09-29', ...opts } = {}) =>
  weekdays(count, end).flatMap(d => dayRows(d, firstClock, opts));
const boatDays = (count, firstClock, opts) =>
  landDays(count, firstClock, { ...opts, workType: '' });

const shape = (stops, mode = 'land') =>
  spine({ Stops: stops }).installerDayShape('Pat Example', mode, 30);

test('the usual first log is the median of land days, in minutes after midnight', () => {
  const s = spine({ Stops: [...landDays(11, '09:40'), ...landDay('2026-09-30', '13:15')] });
  assert.equal(s.installerDayShape('Pat Example', 'land', 30).usualFirstLogMin, 580);
});

test('boat days do not move the land figure', () => {
  const s = spine({ Stops: [...landDays(12, '09:40'), ...boatDays(20, '07:10')] });
  assert.equal(s.installerDayShape('Pat Example', 'land', 30).usualFirstLogMin, 580);
});

test('fewer than 10 qualifying days is no evidence', () => {
  const r = shape(landDays(9, '09:40'));
  assert.deepEqual([r.usualFirstLogMin, r.delayPerStopMin, r.days], ['', '', 9]);
});

test('a day of four logs does not count', () => {
  const short = landDays(5, '06:00', { end: '2026-10-30', gaps: [10, 10, 10] });
  const r = shape([...landDays(10, '09:40'), ...short]);
  assert.equal(r.usualFirstLogMin, 580);
  assert.equal(r.days, 10);
});

test('only the most recent 30 days are read', () => {
  const older = landDays(30, '08:00', { end: '2026-08-14' });
  const r = shape([...older, ...landDays(30, '09:40')]);
  assert.equal(r.usualFirstLogMin, 580);
  assert.equal(r.days, 30);
});

test('the delay per stop is what is left after stop-to-stop work and the 60 break minutes', () => {
  // Each day: 11 logs, ten gaps (nine of 10 min, one of 100). Span 190, median gap 10,
  // overhead 190 - 10x10 = 90, less 60 = 30, over 11 logs = 2.7.
  const r = shape(landDays(12, '09:40', { gaps: [10, 10, 10, 10, 100, 10, 10, 10, 10, 10] }));
  assert.equal(r.delayPerStopMin, 2.7);
});

test('a day with less overhead than the breaks has no delay, never a negative one', () => {
  assert.equal(shape(landDays(12, '09:40')).delayPerStopMin, 0);
});
