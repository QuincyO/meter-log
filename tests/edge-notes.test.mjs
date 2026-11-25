// The note on End of day's "Before first order" and "After last order" cards.
//
// Two columns on the day's `Days` row, written by a queued `saveDayNotes`. The spine
// half is the real Code.gs source over a fake sheet; the phone half is DOM and node
// cannot run it, so its wiring is pinned by source, as in edge-downtime.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectNotes } from '../js/dailylog.js';
import { buildLocalSummary } from '../js/compute/summary.js';

const rd = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const captureJs = rd('../js/pages/capture.js');
const editJs = rd('../js/pages/edit.js');
const codeGs = rd('../Code.gs');
const between = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + 1);
  assert.ok(i > -1 && j > i, `${a} … ${b}`);
  return src.slice(i, j);
};

// ── the spine ───────────────────────────────────────────────────────────────

// One sheet as a 2-D array, with the few Sheet calls the Days writers make.
function fakeSheet(grid){
  const width = () => Math.max(0, ...grid.map(r => r.length));
  const sh = {
    grid, formats: [],
    getLastRow: () => grid.length, getLastColumn: width, getMaxRows: () => 1000,
    getDataRange: () => ({ getValues: () => grid.map(r => Array.from({ length: width() }, (_, c) => r[c] ?? '')) }),
    appendRow: r => grid.push(r.slice()), setFrozenRows(){},
    getRange: (r, c, h = 1, w = 1) => ({
      getValues: () => Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, k) => grid[r - 1 + i]?.[c - 1 + k] ?? '')),
      setValues: v => v.forEach((row, i) => row.forEach((x, k) => { (grid[r - 1 + i] ||= [])[c - 1 + k] = x; })),
      setValue: x => { (grid[r - 1] ||= [])[c - 1] = x; },
      setFontWeight(){}, setNumberFormat: f => sh.formats.push([c, w, f]),
    }),
  };
  return sh;
}
function spine(sheets){
  const none = () => { throw new Error('Apps Script API reached'); };
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = fakeSheet([])) };
  return new Function('SpreadsheetApp', 'Utilities', 'Session', 'PropertiesService', 'UrlFetchApp',
    'LockService', 'ContentService', 'ScriptApp', 'CacheService', `
    ${codeGs}
    return { saveDayNotes, saveDay, dayMeta, DAYS_HEADERS, ADMIN_POST };`)(
    { getActiveSpreadsheet: () => ss }, { formatDate: none }, {}, {}, {}, {}, {}, {},
    { getScriptCache: () => ({ get: () => null, put(){}, remove(){}, removeAll(){} }) });
}
const OLD = ['date', 'installer', 'departure', 'returned', 'dispatchMin', 'boatDispatchMin'];
const employees = () => fakeSheet([['hNumber', 'firstName', 'lastName'], ['H1', 'Pat', 'Example']]);
const note = extra => ({ installer: 'pat example', installerId: 'H1', date: '2026-11-25', ...extra });

test('the first note adds its columns to a sheet that has none, and leaves the rest of the row', () => {
  const Days = fakeSheet([OLD.slice(), ['2026-11-25', 'Pat Example', '07:40', '16:10', 5, 9], ['2026-11-25', 'Sam Other', '08:00', '', '', '']]);
  const s = spine({ Days, Employees: employees() });
  assert.deepEqual(s.saveDayNotes(note({ beforeNote: ' waited for meters ' })), { ok: true });
  assert.deepEqual(Days.grid[0], s.DAYS_HEADERS);
  assert.deepEqual(Days.grid[1].slice(0, 7), ['2026-11-25', 'Pat Example', '07:40', '16:10', 5, 9, 'waited for meters']);
  assert.equal(Days.grid[2][6] ?? '', '', 'another installer is untouched');
  assert.deepEqual(Days.formats, [[7, 2, '@']], 'text, so a note like 8:30 is not turned into a time');
});

test('one note never blanks the other, and an emptied note is saved as empty', () => {
  const Days = fakeSheet([[...OLD, 'beforeNote', 'afterNote'], ['2026-11-25', 'Pat Example', '07:40', '16:10', '', '', 'am', 'pm']]);
  const s = spine({ Days, Employees: employees() });
  s.saveDayNotes(note({ afterNote: '' }));
  assert.deepEqual(Days.grid[1].slice(6), ['am', '']);
  const m = s.dayMeta('Pat Example', '2026-11-25');
  assert.deepEqual(m, { departure: '07:40', returned: '16:10', beforeNote: 'am', afterNote: '' });
});

test('a note saved before the day is closed has no times, and the close keeps the note', () => {
  const Days = fakeSheet([[...OLD, 'beforeNote', 'afterNote']]);
  const s = spine({ Days, Employees: employees() });
  s.saveDayNotes(note({ beforeNote: 'am' }));
  assert.deepEqual(s.dayMeta('Pat Example', '2026-11-25'), { departure: '', returned: '', beforeNote: 'am', afterNote: '' });
  s.saveDay({ date: '2026-11-25', installer: 'Pat Example', departure: '07:30', returned: '16:00' });
  assert.equal(Days.grid.length, 2, 'one row for the day');
  assert.deepEqual(s.dayMeta('Pat Example', '2026-11-25'), { departure: '07:30', returned: '16:00', beforeNote: 'am', afterNote: '' });
});

test('a day with no row and a sheet with no tab read as blank', () => {
  const blank = { departure: '', returned: '', beforeNote: '', afterNote: '' };
  assert.deepEqual(spine({ Days: fakeSheet([OLD.slice()]) }).dayMeta('Pat Example', '2026-11-25'), blank);
  assert.deepEqual(spine({}).dayMeta('Pat Example', '2026-11-25'), blank);
});

test('a sheet whose columns cannot be found says so instead of dropping the note', () => {
  const Days = fakeSheet([[...OLD, 'something', 'else']]);
  assert.equal(spine({ Days, Employees: employees() }).saveDayNotes(note({ beforeNote: 'am' })).ok, false);
});

test('the phone may call it, and the day summary carries both notes', () => {
  assert.ok(!spine({}).ADMIN_POST.saveDayNotes);
  assert.match(codeGs, /case 'saveDayNotes':\s+return json\(saveDayNotes\(body\)\);/);
  const sum = between(codeGs, 'function buildDaySummary(', '/** Computes today');
  assert.match(sum, /beforeNote: persisted\.beforeNote, afterNote: persisted\.afterNote/);
});

// ── the PDF ─────────────────────────────────────────────────────────────────

test('both notes print in the Notes block, right after the end-of-day note', () => {
  const s = { notes: 'Good day.', beforeNote: 'Waited for meters.', afterNote: ' Dropped off old meters. ',
    downtime: [{ category: 'OTHER', minutes: 5, note: 'Ferry.' }], stops: [{ workOrderId: '1', notes: 'Dog.' }] };
  assert.deepEqual(collectNotes(s).slice(0, 3), [
    { label: 'End of day', text: 'Good day.' },
    { label: 'Before first work order', text: 'Waited for meters.' },
    { label: 'After last work order', text: 'Dropped off old meters.' },
  ]);
  // A note needs no minutes, and a blank one prints nothing.
  assert.deepEqual(collectNotes({ beforeNote: 'x', afterNote: ' ' }), [{ label: 'Before first work order', text: 'x' }]);
});

test('the PDF built with no signal carries them', () => {
  const s = buildLocalSummary({ workType: 'land', day: { beforeNote: 'am', afterNote: 'pm' } });
  assert.deepEqual([s.beforeNote, s.afterNote], ['am', 'pm']);
  const none = buildLocalSummary({ workType: 'land' });
  assert.deepEqual([none.beforeNote, none.afterNote], ['', '']);
});

// ── the phone ───────────────────────────────────────────────────────────────

test('pendingDayNotes reads the unsent notes for today, newest last', async () => {
  const src = between(captureJs, 'const DAY_NOTE_KEYS', '// ── end: the two no-order notes');
  const run = queue => new Function('idb', 'cfg', 'localDate', src + '\nreturn pendingDayNotes();')(
    { all: async () => queue }, () => ({ name: 'Pat Example' }), () => '2026-11-25');
  const q = extra => ({ action: 'saveDayNotes', installer: 'Pat Example', date: '2026-11-25', ...extra });
  assert.deepEqual(await run([q({ beforeNote: 'a' }), q({ afterNote: 'z' }), q({ beforeNote: 'b' }),
    q({ beforeNote: 'yesterday', date: '2026-11-24' }), q({ beforeNote: 'x', installer: 'Sam Other' }), { action: 'addStop' }]),
    { beforeNote: 'b', afterNote: 'z' });
  assert.deepEqual(await run([q({ beforeNote: '' })]), { beforeNote: '' }, 'a cleared note is still news');
  assert.deepEqual(await run(null), {});
});

test('the card saves its own note, through the queue, for the day it was typed on', () => {
  const card = between(captureJs, 'function makeEdgeCard(', '// ── end: downtime on no order');
  assert.match(card, /action:'saveDayNotes', installer:c\.name, installerId:c\.hNumber,\s+date:localDate\(\), \[key\]:v \}/,
    'only the edited note is sent, so a stale card cannot blank the other');
  assert.match(card, /ta\.addEventListener\('change', save\);/, 'blur must save before the next tap lands');
  assert.match(card, /touchEod\(\)/, 'typing counts as working in the review: a late response must not rebuild the card');
  assert.match(card, /eodDayNoteEdits\[key\] = v; schedulePersistEod\(\);/);
});

test('every PDF on the phone prints the note as typed', () => {
  const finish = between(captureJs, "$('finishDay').onclick", '// weather (Open-Meteo');
  assert.match(finish, /Object\.assign\(summary, await pendingDayNotes\(\), eodDayNoteEdits\);\s+await downloadDailyLog\(summary\);/,
    'the prefetched server summary may predate the note');
  const gen = between(captureJs, "$('genLog').onclick", '// ── today');
  assert.match(gen, /Object\.assign\(summary, await pendingDayNotes\(\)\);\s+await downloadDailyLog\(summary\);/);
  assert.match(between(captureJs, 'async function buildSummaryFromCache(', '// ── cached day loader'), /pendingDayNotes\(\)/);
  assert.match(between(captureJs, 'async function persistEodReview(', 'let _eodPersistTimer'), /eodDayNoteEdits/,
    'kept on the cached day, for the PDF and the card once the queue has drained');
});

test('an unsent note wins over the day as loaded, and each open starts with no edits', () => {
  const load = between(captureJs, 'async function loadDay(', 'function renderDayData(');
  assert.equal(load.split('await pendingDayNotes()').length - 1, 2, 'the cached paint and the server one');
  assert.match(between(captureJs, "$('endDay').onclick", "openSheet('eodSheet')"), /eodDayNoteEdits = \{\};/);
});

test('the office editor edits both, and saves them before it generates or closes', () => {
  const card = between(editJs, 'function edgeCard(', '// ── travel review');
  assert.match(card, /saveDayNotes\(\)/);
  assert.match(between(editJs, 'async function persistEdits(', '// Generate = PDF only'), /await saveDayNotes\(\);/);
  const load = between(editJs, 'async function loadDay(', "$('loadBtn').onclick");
  assert.ok(load.indexOf('noteEdits = {};') > -1 && load.indexOf('noteEdits = {};') < load.indexOf('try{'),
    'a day never inherits the last one\'s unsaved notes, even when its load fails');
});
