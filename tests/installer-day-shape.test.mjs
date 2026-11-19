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
// pin costs the on-site time. What the span holds beyond that and the installer's
// measured pause time (pauseMinPerDay, below) is delay. (It used to be measured
// against the day's median gap, which is mostly quick next-door stops: 1.5 minutes a
// stop for the owner, 37 minutes on a 25-stop day his history does not contain.)
//
// The fixtures are built so the fit has an exact answer: every pinned far gap is
// 10 + 2 × km minutes, along one meridian so the haversine distance is the step,
// and every 30 m gap is 5 minutes. So onSiteMin 10, travelMinPerKm 2, extraMeterMin
// 5. The unexplained time sits on an unpinned log, which the fit never sees. It is
// kept under the pause threshold here (the unpinned gap is measured against the
// median of all gaps, 12, and stays less than 10 over it), so the measured pause is
// 0 and every unexplained minute is delay; the pause tests further down cover the
// other side.

const R = 6371000;
const north = (lat, metres) => lat + (metres / R) * 180 / Math.PI;
const FAR1 = { m: 1000, min: 12 }, FAR2 = { m: 2000, min: 14 }, NEAR = { m: 30, min: 5 };
// An unpinned log `extra` minutes beyond its 10 on site, then a pinned one 10 later.
const bare = extra => [{ m: null, min: 10 + extra }, { m: 0, min: 10 }];

// One day of land Stops from a list of hops, each { m: metres north (null = no pin), min }.
function hopDay(date, hops, workType = 'land'){
  let mins = 9 * 60, lat = 45;
  const row = (i, pinned) => ({ id: `${date}-${i}`, installer: 'Pat Example', status: 'INSTALLED',
    workType, timestamp: `${date} ${clockOf(mins)}`, address: `${i + 1} First St`,
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

test('a day whose span is exactly model work and no pause has no delay', () => {
  // Span 104 + 20 + 10 + 10 = 144 = the model work, and no gap is 10 or more over
  // its usual time, so the pause is 0 and nothing is left over.
  const r = shape(hopDays(12, mixed(0)));
  assert.deepEqual([r.delayPerStopMin, r.pauseMinPerDay], [0, 0]);
});

test('nine unexplained minutes over 15 logs, under the pause threshold, is 0.6 a stop', () => {
  // The unpinned gap is 19, 7 over the median of all gaps (12), so no pause.
  // Span 144 + 9 = 153; 153 − 144 − 0 = 9; 9 / 15 = 0.6.
  const r = shape(hopDays(12, mixed(9)));
  assert.deepEqual([r.delayPerStopMin, r.pauseMinPerDay], [0.6, 0]);
});

test('next-door stops are priced at the extra-meter time, not as a fresh site', () => {
  // 15 logs, eight of them next door. Work: far 12 + 14 + 12 + 14 = 52, next door
  // 8 × 5 = 40, the unpinned pair 10 + 10 = 20: 112. Span 52 + 40 + 14 + 10 = 116.
  // The median of all gaps is 5 (eight of the fourteen), so the unpinned 14 is 9 over
  // and the 10 after it 5 over: no pause. 116 − 112 − 0 = 4, over 15 = 0.27 → 0.3.
  // Priced as fresh sites (10.06 each) the work would be 152.5 and the delay 0.
  const hops = [FAR1, NEAR, NEAR, NEAR, FAR2, NEAR, NEAR, NEAR, ...bare(4), FAR1, NEAR, NEAR, FAR2];
  assert.equal(shape(hopDays(12, hops)).delayPerStopMin, 0.3);
});

test('no on-site fit for the installer and mode is no delay figure', () => {
  // landDays carries no pins, so there is nothing to fit. The first log still stands.
  const r = shape(landDays(12, '09:40', { gaps: [10, 10, 10, 10, 100, 10, 10, 10, 10, 10] }));
  assert.deepEqual([r.delayPerStopMin, r.usualFirstLogMin], ['', 580]);
});

test('the metrics row reuses the dwell model it was just given', () => {
  const s = spine({ Stops: hopDays(12, mixed(9)) });
  const row = {};
  s.applyOnSiteMetrics(row, 'Pat Example');
  s.applyDayShapeMetrics(row, 'Pat Example');
  assert.equal(row.landDelayPerStopMin, 0.6);
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
  assert.equal(bareRow.landDelayPerStopMin, 0.6);
});

// ── the pause time ──────────────────────────────────────────────────────────
// pauseMinPerDay is the time between meters that is neither ordinary work nor a
// logged delay, breaks included: per gap, what is 10 or more minutes over the usual
// time for its kind (the median gap at that distance), less any delay logged against
// that gap, summed per day; the median of those daily sums. It replaces the fixed
// 60-minute break allowance on the phone's day cards and flat-out line.
//
// Two kinds of hop on one meridian: next door (30 m, the same-site bin under 60 m)
// and a fresh stop 1.5 km on (the 1-2 km bin). Far from every bin edge on purpose.
const NEXT = min => ({ m: 30, min });
const AWAY = min => ({ m: 1500, min });

// Ten 10-minute hops to a stop 1.5 km on, the fifth one `slow` minutes instead:
// 11 logs from 09:00, so the slow gap runs 09:40 → 09:40 + slow.
const oneSlow = slow => [10, 10, 10, 10, slow, 10, 10, 10, 10, 10].map(AWAY);
const SLOW_GAP = slow => `gap 09:40–${clockOf(9 * 60 + 40 + slow).slice(0, 5)}`;
// A gap-tagged Downtime row the way saveTravel writes it: anchored at noon on the
// day, the gap's clock window in the note, and a BLANK workType (saveTravel never
// receives one, and blank reads as boat).
const logged = (dates, category, minutes, note) => dates.map((d, i) => ({ id: `dt-${d}-${i}`,
  timestamp: `${d} 12:00:00`, installer: 'Pat Example', category, minutes, note, workType: '' }));
const pause = tables => spine(tables).installerDayShape('Pat Example', 'land', 30).pauseMinPerDay;
const DAYS12 = weekdays(12, '2026-09-29');

test('every gap exactly at its kind\'s usual time is no pause', () => {
  // Next-door gaps all 5, the 1.5 km gaps all 20: nothing over, so 0.
  const hops = [NEXT(5), NEXT(5), AWAY(20), NEXT(5), AWAY(20), NEXT(5), AWAY(20)];
  assert.equal(pause({ Stops: hopDays(12, hops) }), 0);
});

test('one 45-minute gap among 10-minute gaps of the same kind is a 35-minute pause', () => {
  // The kind's usual time is 10 (108 of its 120 gaps), so 45 is 35 over: 35 a day.
  assert.equal(pause({ Stops: hopDays(12, oneSlow(45)) }), 35);
});

test('a delay logged against that gap is taken off it', () => {
  // 35 over, less the 20 minutes of DISPATCH logged against 09:40–10:25: 15.
  const Downtime = logged(DAYS12, 'DISPATCH', 20, SLOW_GAP(45));
  assert.equal(SLOW_GAP(45), 'gap 09:40–10:25');
  assert.equal(pause({ Stops: hopDays(12, oneSlow(45)), Downtime }), 15);
});

test('a logged lunch or break is NOT taken off: it is break time, and this is the break allowance', () => {
  // The same 35 over; a LUNCH, BREAK or MISC_TRAVEL row against the gap leaves it 35.
  for(const cat of ['LUNCH', 'BREAK', 'MISC_TRAVEL', 'TRAVEL_TIME']){
    const Downtime = logged(DAYS12, cat, 20, SLOW_GAP(45));
    assert.equal(pause({ Stops: hopDays(12, oneSlow(45)), Downtime }), 35, cat);
  }
});

test('a logged delay never takes a gap below zero', () => {
  // 35 over, 50 logged: 0, not −15.
  const Downtime = logged(DAYS12, 'DISPATCH', 50, SLOW_GAP(45));
  assert.equal(pause({ Stops: hopDays(12, oneSlow(45)), Downtime }), 0);
});

test('a 17-minute gap among 10-minute gaps is ordinary variation, not a pause', () => {
  // 7 over, under the 10-minute threshold: 0.
  assert.equal(pause({ Stops: hopDays(12, oneSlow(17)) }), 0);
});

test('each gap is measured against its own kind', () => {
  // Per day: six next-door gaps of 5, four 1.5 km gaps of 20, one next-door gap of 20.
  // Next door usually takes 5 and a 1.5 km stop 20, so the 20s to a 1.5 km stop are
  // no pause and the 20 next door is 15 over: 15 a day. Measured against the median
  // of all gaps (5), every 1.5 km gap would wrongly be a 15-minute pause as well.
  const hops = [NEXT(5), NEXT(5), NEXT(5), AWAY(20), NEXT(5), AWAY(20), NEXT(5), NEXT(20),
    AWAY(20), NEXT(5), AWAY(20)];
  assert.equal(pause({ Stops: hopDays(12, hops) }), 15);
});

test('the daily figure is the median of the days, rounded', () => {
  // Six days with a 45 (35 over) and six with a 60 (50 over): median 42.5 → 43.
  const stops = [...weekdays(6, '2026-09-21').flatMap(d => hopDay(d, oneSlow(45))),
                 ...weekdays(6, '2026-09-29').flatMap(d => hopDay(d, oneSlow(60)))];
  assert.equal(pause({ Stops: stops }), 43);
});

test('fewer than 10 qualifying days is no pause figure', () => {
  assert.equal(pause({ Stops: hopDays(9, oneSlow(45)) }), '');
});

test('boat days do not move the land pause', () => {
  // Twenty boat days with a two-hour gap each, on the same dates and later ones.
  const boat = weekdays(20, '2026-10-23').flatMap(d => hopDay(d, oneSlow(120), ''));
  assert.equal(pause({ Stops: [...hopDays(12, oneSlow(45)), ...boat] }), 35);
});

test('the delay per stop is measured against the measured pause, not 60', () => {
  // Ten logs, nine hops of 1.5 km against a model of 10 on site + 2 a km: 13 each,
  // 117 of work. Eight hops take 16 and one 56, so the span is 8 × 16 + 56 = 184 and
  // the pause 56 − 16 = 40. Delay (184 − 117 − 40) / 10 = 2.7 a stop. Measured
  // against the old fixed 60 it would be (184 − 117 − 60) / 10 = 0.7.
  const hops = [16, 16, 16, 16, 56, 16, 16, 16, 16].map(AWAY);
  const r = spine({ Stops: hopDays(12, hops) }).installerDayShape('Pat Example', 'land', 30,
    { onSiteMin: 10, extraMeterMin: 5, travelMinPerKm: 2 });
  assert.deepEqual([r.pauseMinPerDay, r.delayPerStopMin], [40, 2.7]);
});

test('the metrics row stores the pause in all three mode groups', () => {
  const s = spine({ Stops: hopDays(12, oneSlow(45)) });
  const row = {};
  s.applyOnSiteMetrics(row, 'Pat Example');
  s.applyDayShapeMetrics(row, 'Pat Example');
  assert.deepEqual([row.pauseMinPerDay, row.landPauseMinPerDay, row.boatPauseMinPerDay], [35, 35, '']);
});
