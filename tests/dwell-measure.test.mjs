// The measurement half of the dwell model lives in Code.gs, which node cannot
// import — so evaluate the real source with the Apps Script surface stubbed and the
// sheet reader swapped for fixtures. This is the only coverage the spine-side fit
// has, and it is where the arithmetic that decides every ETA actually lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fixtures are plain local stamps ("2026-06-22 08:00:00"), which dateOf/secOfDay
// parse by regex — so a formatDate that throws proves we never left that path.
const NO_APPS_SCRIPT = () => { throw new Error('Apps Script API reached'); };

function spine(tables){
  const src = readFileSync(join(ROOT, 'Code.gs'), 'utf8')
    .replace(/^function rows\(/m, 'function __sheetRows(');
  return new Function('SpreadsheetApp', 'Utilities', 'Session', 'PropertiesService',
    'UrlFetchApp', 'LockService', 'ContentService', 'ScriptApp', 'CacheService', '__T', `
    function rows(n){ return __T[n] || []; }
    ${src}
    return { installerOnSiteFit, crewSiteDwell, dwellSamples, siteKeyOf,
             installerOnSiteFromTracks };
  `)(
    { getActiveSpreadsheet: () => ({ getSheetByName: n => (tables[n] ? {} : null) }) },
    { formatDate: NO_APPS_SCRIPT }, {}, {}, {}, {}, {}, {}, {},
    { Stops: [], Downtime: [], DriveTracks: [], ...tables });
}

const R = 6371000;
// A point `metres` due north of (lat, lng) — lets a fixture state distances exactly.
const north = (lat, metres) => lat + (metres / R) * 180 / Math.PI;
const clock = mins => {
  const t = Math.round(mins * 60);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
};

// A day of stops whose gaps are EXACTLY onSite + rate × km, so the fit has a known
// right answer to recover.
// `delays` optionally adds unexplained minutes to the leg at that index, and
// reports the gap windows so a matching Downtime allocation can be built.
function day({ date, installer = 'Ann Example', legsKm, onSite, rate, startLat = 45,
               delays = {} }){
  const out = [], gaps = [];
  let mins = 8 * 60, lat = startLat, n = 0;
  out.push({ id: `${date}-0`, timestamp: `${date} ${clock(mins)}`, installer,
             workOrderId: `w${date}-0`, address: `${++n} First St`, lat: String(lat), lng: '-79',
             status: 'INSTALLED', workType: 'land' });
  legsKm.forEach((km, i) => {
    const from = mins;
    mins += onSite + rate * km + (delays[i] || 0);
    lat = north(lat, km * 1000);
    const wo = `w${date}-${i + 1}`;
    out.push({ id: `${date}-${i + 1}`, timestamp: `${date} ${clock(mins)}`, installer,
               workOrderId: wo, address: `${++n} First St`,
               lat: String(lat), lng: '-79', status: 'INSTALLED', workType: 'land' });
    if(delays[i]) gaps.push({ wo, minutes: delays[i], installer,
      note: `gap ${clock(from).slice(0, 5)}–${clock(mins).slice(0, 5)}` });
  });
  return Object.assign(out, { gaps });
}

const LEGS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];

test('the fit recovers the on-site intercept and the travel slope', () => {
  const stops = [
    ...day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 }),
    ...day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4 }),
  ];
  const fit = spine({ Stops: stops }).installerOnSiteFit('Ann Example', 'land', 0);
  assert.equal(fit.onSiteMin, 20);
  assert.ok(Math.abs(fit.travelMinPerKm - 4) < 0.2, `slope was ${fit.travelMinPerKm}`);
  assert.ok(fit.samples >= 20, `only ${fit.samples} samples`);
});

test('too few samples reports nothing rather than guessing', () => {
  // Blank is what the phone reads as "keep using the pace fallback" — the safe
  // default, and what every installer shows until enough history exists.
  const fit = spine({ Stops: day({ date: '2026-06-22', legsKm: [1, 2, 3], onSite: 20, rate: 4 }) })
    .installerOnSiteFit('Ann Example', 'land', 0);
  assert.equal(fit.onSiteMin, '');
  assert.equal(fit.travelMinPerKm, '');
  assert.equal(fit.extraMeterMin, '');
});

test('gap-tagged downtime is subtracted, so waiting is not counted as installing', () => {
  // Five gaps carry 45 minutes of DISPATCH each — deliberately more than the 10%
  // the residual trim can absorb, so this measures the DEDUCTION rather than the
  // outlier trim. (With a single inflated gap the two mechanisms overlap and the
  // trim alone would rescue the fit, which proves nothing about the deduction.)
  const delays = { 1: 45, 3: 45, 5: 45, 7: 45, 9: 45 };
  const d1 = day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 });
  const d2 = day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4, delays });
  const stops = [...d1, ...d2];

  const withNoRows = spine({ Stops: stops }).installerOnSiteFit('Ann Example', 'land', 0);
  const withRows = spine({ Stops: stops, Downtime: d2.gaps.map((g, i) => ({
    id: `d${i}`, timestamp: '2026-06-23 12:00:00', installer: g.installer,
    category: 'DISPATCH', minutes: String(g.minutes), workOrderId: g.wo,
    note: g.note, workType: 'land'
  })) }).installerOnSiteFit('Ann Example', 'land', 0);

  assert.equal(withRows.onSiteMin, 20, 'the allocated wait should be removed entirely');
  assert.ok(withNoRows.onSiteMin > withRows.onSiteMin + 3,
    `unallocated waiting must inflate the fit (was ${withNoRows.onSiteMin})`);
});

test('the legacy TRAVEL_TIME category is not subtracted', () => {
  // isGapDeduction's rule: TRAVEL_TIME meant "the whole gap was still travel", so
  // netting it out would double-count and is what keeps closed days computing the
  // same way they always have.
  const stops = [
    ...day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 }),
    ...day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4 }),
  ];
  const fit = spine({ Stops: stops, Downtime: [{
    id: 'd1', timestamp: '2026-06-23 12:00:00', installer: 'Ann Example',
    category: 'TRAVEL_TIME', minutes: '10', workOrderId: 'w2026-06-23-1',
    note: 'gap 08:00–08:22', workType: 'land'
  }] }).installerOnSiteFit('Ann Example', 'land', 0);
  assert.equal(fit.onSiteMin, 20);
});

test('a deduction matches a gap that starts on a truncated clock minute', () => {
  // A gap note is written from HH:mm-formatted times, which TRUNCATE. Keying the
  // lookup with a rounded minute silently misses every gap starting at :43 seconds
  // or later — the deduction is then never applied and nothing reports an error.
  const stops = [
    { id: 'a', timestamp: '2026-06-22 08:59:43', installer: 'Ann Example', workOrderId: 'wa',
      address: '1 First St', lat: '45', lng: '-79', status: 'INSTALLED', workType: 'land' },
    { id: 'b', timestamp: '2026-06-22 10:00:00', installer: 'Ann Example', workOrderId: 'wb',
      address: '2 First St', lat: String(north(45, 1000)), lng: '-79',
      status: 'INSTALLED', workType: 'land' },
  ];
  const api = spine({ Stops: stops, Downtime: [{
    id: 'd1', timestamp: '2026-06-22 12:00:00', installer: 'Ann Example',
    category: 'LUNCH', minutes: '30', workOrderId: 'wb',
    note: 'gap 08:59–10:00', workType: 'land'
  }] });
  const [sample] = api.dwellSamples('Ann Example', 'land', 0);
  // Raw gap is 60.28 min; with the 30-minute lunch removed it must be ~30.28.
  assert.ok(Math.abs(sample.gapMin - 30.28) < 0.05, `gapMin was ${sample.gapMin}`);
});

test('repeat meters at one address become extraMeterMin, not full dwells', () => {
  const stops = [...day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 }),
                 ...day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4 })];
  // Five same-pin follow-up meters, 6 minutes apart, on a third day.
  const extra = [{ id: 'x0', timestamp: '2026-06-24 08:00:00', installer: 'Ann Example',
    workOrderId: 'wx0', address: '4 Dock Rd', lat: '45.5', lng: '-79',
    status: 'INSTALLED', workType: 'land' }];
  for(let i = 1; i <= 5; i++) extra.push({
    id: `x${i}`, timestamp: `2026-06-24 ${clock(8 * 60 + 6 * i)}`, installer: 'Ann Example',
    workOrderId: `wx${i}`, address: '4 Dock Rd', lat: '45.5', lng: '-79',
    status: 'INSTALLED', workType: 'land' });
  const fit = spine({ Stops: [...stops, ...extra] }).installerOnSiteFit('Ann Example', 'land', 0);
  assert.equal(fit.extraMeterMin, 6);
  assert.ok(fit.extraMeterMin < fit.onSiteMin, 'a repeat meter must be cheaper than a fresh site');
});

test('extraMeterMin never exceeds the on-site time it is a discount on', () => {
  const stops = [...day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 }),
                 ...day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4 })];
  const extra = [{ id: 'x0', timestamp: '2026-06-24 08:00:00', installer: 'Ann Example',
    workOrderId: 'wx0', address: '4 Dock Rd', lat: '45.5', lng: '-79',
    status: 'INSTALLED', workType: 'land' }];
  for(let i = 1; i <= 5; i++) extra.push({          // 90 min apart — a bad fit
    id: `x${i}`, timestamp: `2026-06-24 ${clock(8 * 60 + 90 * i)}`, installer: 'Ann Example',
    workOrderId: `wx${i}`, address: '4 Dock Rd', lat: '45.5', lng: '-79',
    status: 'INSTALLED', workType: 'land' });
  const fit = spine({ Stops: [...stops, ...extra] }).installerOnSiteFit('Ann Example', 'land', 0);
  assert.ok(fit.extraMeterMin <= fit.onSiteMin,
    `extra ${fit.extraMeterMin} must not exceed on-site ${fit.onSiteMin}`);
});

test('an unlogged delay is trimmed by residual without dragging the intercept', () => {
  const stops = [...day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 }),
                 ...day({ date: '2026-06-23', legsKm: LEGS, onSite: 20, rate: 4 })];
  // Push one mid-route stop two hours late with nothing allocated against it.
  const spoiled = stops.map(s => s.id === '2026-06-23-6'
    ? { ...s, timestamp: '2026-06-23 12:30:00' } : s);
  const fit = spine({ Stops: spoiled }).installerOnSiteFit('Ann Example', 'land', 0);
  assert.ok(Math.abs(fit.onSiteMin - 20) <= 3,
    `one unlogged delay moved the intercept to ${fit.onSiteMin}`);
});

test('work modes are measured separately', () => {
  const land = day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 4 });
  const boat = day({ date: '2026-06-23', legsKm: LEGS, onSite: 40, rate: 4 })
    .map(s => ({ ...s, workType: 'boat' }));
  const api = spine({ Stops: [...land, ...land.map((s, i) => ({ ...s, id: 'l' + i,
    timestamp: s.timestamp.replace('06-22', '06-24') })), ...boat,
    ...boat.map((s, i) => ({ ...s, id: 'b' + i, timestamp: s.timestamp.replace('06-23', '06-25') }))] });
  assert.equal(api.installerOnSiteFit('Ann Example', 'land', 0).onSiteMin, 20);
  assert.equal(api.installerOnSiteFit('Ann Example', 'boat', 0).onSiteMin, 40);
});

test('site factors are withheld entirely when there is no usable travel rate', () => {
  // Without a rate, "work" is just the raw gap, so a remote site scores slow purely
  // for being remote. That is the live case on boat routes, not a hypothetical.
  const stops = day({ date: '2026-06-22', legsKm: LEGS, onSite: 20, rate: 0 });
  const out = spine({ Stops: stops }).crewSiteDwell(0);
  assert.deepEqual(out.sites, []);
  assert.equal(out.note, 'no travel rate');
});

// Two recorded days of the same shape: ten 10-minute legs starting every 35
// minutes, so the parked hole between consecutive legs is always 25 minutes.
// Nine holes a day ⇒ 18, comfortably past the 15-sample bar. `logAt` places one
// printable log per hole at the given minutes after the hole opens (or skips it).
function trackDays(logAt){
  const legs = [], stops = [];
  ['2026-06-22', '2026-06-23'].forEach(date => {
    for(let i = 0; i < 10; i++){
      const start = 480 + i * 35;
      legs.push({ id: `${date}-${i}`, date, installer: 'Ann Example', workType: 'land',
        startTime: `${date} ${clock(start)}`, endTime: `${date} ${clock(start + 10)}` });
      if(i < 9 && logAt != null) stops.push({
        id: `s-${date}-${i}`, timestamp: `${date} ${clock(start + 10 + logAt)}`,
        installer: 'Ann Example', workOrderId: `w-${date}-${i}`, address: `${i} First St`,
        lat: '45', lng: '-79', status: 'INSTALLED', workType: 'land' });
    }
  });
  return { legs, stops };
}

test('GPS drive-track gaps are read as literal time parked at a stop', () => {
  // dwell = next leg's start − this leg's end, counted because a log landed in it.
  const { legs, stops } = trackDays(12);   // logged mid-hole
  const api = spine({ Stops: stops, DriveTracks: legs });
  assert.equal(api.installerOnSiteFromTracks('Ann Example', 'land', 0), 25);
});

test('a parked hole with no log inside it is lunch, not a dwell sample', () => {
  // Same legs, but every log sits mid-LEG (5 minutes into a 10-minute drive) —
  // 3 minutes past the previous hole's pull-away grace and 5 minutes short of the
  // next hole opening, so not one of the 18 parked holes is validated and nothing
  // is reported. This is what keeps a lunch, a coffee stop or a supply run out of
  // the on-site median.
  const { legs } = trackDays(null);
  const stops = [];
  ['2026-06-22', '2026-06-23'].forEach(date => {
    for(let i = 0; i < 10; i++) stops.push({
      id: `s-${date}-${i}`, timestamp: `${date} ${clock(480 + i * 35 + 5)}`,
      installer: 'Ann Example', workOrderId: `w-${date}-${i}`, address: `${i} First St`,
      lat: '45', lng: '-79', status: 'INSTALLED', workType: 'land' });
  });
  const api = spine({ Stops: stops, DriveTracks: legs });
  assert.equal(api.installerOnSiteFromTracks('Ann Example', 'land', 0), '');
});

test('a log a beat after pulling away still validates its hole', () => {
  // The ordinary miss: drive off first, tap Log at the stop sign. The hole is 25
  // minutes (ends at +25 after it opens); a log at +26 is 1 minute into the next
  // leg — inside the 2-minute grace, so the sample survives.
  const { legs, stops } = trackDays(26);
  const api = spine({ Stops: stops, DriveTracks: legs });
  assert.equal(api.installerOnSiteFromTracks('Ann Example', 'land', 0), 25);
});

test('GPS is ignored below the evidence bar', () => {
  const legs = [], stops = [];
  for(let i = 0; i < 5; i++){
    const start = 480 + i * 35;
    legs.push({ id: `g${i}`, date: '2026-06-22', installer: 'Ann Example', workType: 'land',
      startTime: `2026-06-22 ${clock(start)}`, endTime: `2026-06-22 ${clock(start + 10)}` });
    stops.push({ id: `s${i}`, timestamp: `2026-06-22 ${clock(start + 22)}`,
      installer: 'Ann Example', workOrderId: `w${i}`, address: `${i} First St`,
      lat: '45', lng: '-79', status: 'INSTALLED', workType: 'land' });
  }
  assert.equal(spine({ Stops: stops, DriveTracks: legs })
    .installerOnSiteFromTracks('Ann Example', 'land', 0), '');
});
