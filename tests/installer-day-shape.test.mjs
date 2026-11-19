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
    return { installerDayShape, installerOnSiteFit, applyOnSiteMetrics, applyDayShapeMetrics };
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

// ── the delay per stop ──────────────────────────────────────────────────────
// Measured against the model the ETAs use: every log after the first costs the
// extra-meter time when it is within DWELL_SAME_SITE_M of the one before, else the
// on-site time plus the drive at the measured rate; a log or a previous log with no
// pin costs the on-site time. What the span holds beyond that and the 60 break
// minutes is delay. (It used to be measured against the day's median gap, which is
// mostly quick next-door stops: 1.5 minutes a stop for the owner, 37 minutes on a
// 25-stop day his history does not contain.)
//
// The fixtures are built so the fit has an exact answer: every pinned far gap is
// 10 + 2 × km minutes, along one meridian so the haversine distance is the step,
// and every 30 m gap is 5 minutes. So onSiteMin 10, travelMinPerKm 2, extraMeterMin
// 5. The unexplained time sits on an unpinned log, which the fit never sees.

const R = 6371000;
const north = (lat, metres) => lat + (metres / R) * 180 / Math.PI;
const FAR1 = { m: 1000, min: 12 }, FAR2 = { m: 2000, min: 14 }, NEAR = { m: 30, min: 5 };
// An unpinned log `extra` minutes beyond its 10 on site, then a pinned one 10 later.
const bare = extra => [{ m: null, min: 10 + extra }, { m: 0, min: 10 }];

// One day of land Stops from a list of hops, each { m: metres north (null = no pin), min }.
function hopDay(date, hops){
  let mins = 9 * 60, lat = 45;
  const row = (i, pinned) => ({ id: `${date}-${i}`, installer: 'Pat Example', status: 'INSTALLED',
    workType: 'land', timestamp: `${date} ${clockOf(mins)}`, address: `${i + 1} First St`,
    lat: pinned ? String(lat) : '', lng: pinned ? '-79' : '' });
  const out = [row(0, true)];
  hops.forEach((h, i) => {
    mins += h.min;
    if(h.m != null) lat = north(lat, h.m);
    out.push(row(i + 1, h.m != null));
  });
  return out;
}
const hopDays = (count, hops) => weekdays(count, '2026-09-29').flatMap(d => hopDay(d, hops));

// 15 logs. Work: eight far hops (4 × 12 + 4 × 14 = 104), four next-door hops
// (4 × 5 = 20), the unpinned log and the one after it (10 + 10 = 20): 144.
const mixed = extra => [FAR1, FAR2, NEAR, FAR1, FAR2, NEAR, ...bare(extra), FAR1, FAR2, NEAR, FAR1, FAR2, NEAR];

test('the fixtures give the fit its exact answer', () => {
  const fit = spine({ Stops: hopDays(12, mixed(60)) }).installerOnSiteFit('Pat Example', 'land', 30);
  assert.deepEqual([fit.onSiteMin, fit.travelMinPerKm, fit.extraMeterMin], [10, 2, 5]);
});

test('a day whose span is exactly model work plus the 60 break minutes has no delay', () => {
  // Span 104 + 20 + 70 + 10 = 204 = 144 + 60, so nothing is left over.
  assert.equal(shape(hopDays(12, mixed(60))).delayPerStopMin, 0);
});

test('45 unexplained minutes over 15 logs is 3.0 a stop', () => {
  // Span 204 + 45 = 249; 249 − 144 − 60 = 45; 45 / 15 = 3.0.
  assert.equal(shape(hopDays(12, mixed(105))).delayPerStopMin, 3);
});

test('next-door stops are priced at the extra-meter time, not as a fresh site', () => {
  // 15 logs, eight of them next door. Work: far 12 + 14 + 12 + 14 = 52, next door
  // 8 × 5 = 40, the unpinned pair 10 + 10 = 20: 112. Span 52 + 40 + 100 + 10 = 202.
  // 202 − 112 − 60 = 30, over 15 = 2.0. Priced as fresh sites (10.06 each) the
  // work would be 152.5 and the delay 0.
  const hops = [FAR1, NEAR, NEAR, NEAR, FAR2, NEAR, NEAR, NEAR, ...bare(90), FAR1, NEAR, NEAR, FAR2];
  assert.equal(shape(hopDays(12, hops)).delayPerStopMin, 2);
});

test('no on-site fit for the installer and mode is no delay figure', () => {
  // landDays carries no pins, so there is nothing to fit. The first log still stands.
  const r = shape(landDays(12, '09:40', { gaps: [10, 10, 10, 10, 100, 10, 10, 10, 10, 10] }));
  assert.deepEqual([r.delayPerStopMin, r.usualFirstLogMin], ['', 580]);
});

test('the metrics row reuses the dwell model it was just given', () => {
  const s = spine({ Stops: hopDays(12, mixed(105)) });
  const row = {};
  s.applyOnSiteMetrics(row, 'Pat Example');
  s.applyDayShapeMetrics(row, 'Pat Example');
  assert.equal(row.landDelayPerStopMin, 3);
  // Boat has no logs at all here, so no fit and no figure.
  assert.equal(row.boatDelayPerStopMin, '');
  // The row's own model is the one used: a row that says "no fit" gets no figure,
  // although these Stops would fit one if they were measured again.
  const noFit = { landOnSiteSource: 'pace', landOnSiteMin: '', landExtraMeterMin: '', landTravelMinPerKm: '' };
  s.applyDayShapeMetrics(noFit, 'Pat Example');
  assert.equal(noFit.landDelayPerStopMin, '');
  // A row that has not been through applyOnSiteMetrics measures the model itself.
  const bareRow = {};
  s.applyDayShapeMetrics(bareRow, 'Pat Example');
  assert.equal(bareRow.landDelayPerStopMin, 3);
});
