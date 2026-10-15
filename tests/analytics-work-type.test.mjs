import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAND_START, BOAT_DAYS_AFTER_LAND_START, workTypeOn, matchesWorkType,
  metricsForMode, lifetimeRows, dwellRows } from '../js/compute/installer-lifetime.js';

// The analytics Land / Boat / All switch classifies a row by its date + installer,
// never by its workType tag (see the comment on LAND_START for why).
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mapJs   = read('js/pages/map.js');
const mapHtml = read('map.html');

test('the cutover is the first land day in the sheet', () => {
  assert.equal(LAND_START, '2026-07-20');
  assert.equal(workTypeOn('2026-06-22', 'Quincy Orta'), 'boat');
  assert.equal(workTypeOn('2026-07-15', 'Phillip Monteiro'), 'boat');   // last boat day
  assert.equal(workTypeOn('2026-07-20', 'Phillip Monteiro'), 'land');   // first land day
  assert.equal(workTypeOn('2026-10-09', 'Quincy Orta'), 'land');
});

test('the island days after the cutover are boat for that installer only', () => {
  // Quincy's 2026-08-06 was all islands while Phillip worked land the same day —
  // and Quincy's Tracker row for it says land, which is why the tag isn't used.
  assert.deepEqual(BOAT_DAYS_AFTER_LAND_START['2026-08-06'], ['Quincy Orta']);
  assert.equal(workTypeOn('2026-08-06', 'Quincy Orta'), 'boat');
  assert.equal(workTypeOn('2026-08-06', ' Quincy Orta '), 'boat');   // sheet names can carry spaces
  assert.equal(workTypeOn('2026-08-06', 'Phillip Monteiro'), 'land');
  assert.equal(workTypeOn('2026-08-04', 'Quincy Orta'), 'boat');
  assert.equal(workTypeOn('2026-08-05', 'Quincy Orta'), 'land');
});

test('matchesWorkType: all passes everything, land/boat split on the rule', () => {
  for (const [d, who] of [['2026-07-01', 'A'], ['2026-09-01', 'A'], ['2026-08-06', 'Quincy Orta']])
    assert.equal(matchesWorkType(d, who, 'all'), true);
  assert.equal(matchesWorkType('2026-07-01', 'A', 'boat'), true);
  assert.equal(matchesWorkType('2026-07-01', 'A', 'land'), false);
  assert.equal(matchesWorkType('2026-09-01', 'A', 'land'), true);
  assert.equal(matchesWorkType('2026-09-01', 'A', 'boat'), false);
  assert.equal(matchesWorkType('2026-08-06', 'Quincy Orta', 'land'), false);
  // an unknown mode is 'all', never an empty page
  assert.equal(matchesWorkType('2026-09-01', 'A', undefined), true);
});

// A wide InstallerMetrics row, as ?action=installerMetrics returns it with no workType.
const wide = {
  hNumber:'H1', name:'Quincy Orta', firstDay:'2026-06-22', lastDay:'2026-10-09', updated:'x',
  daysWorked:60, hoursWorked:480, totalLogs:700, installs:640, utis:30, avgLogMin:30, avgPerDay:11,
  avgPerHour:1.4, recent30AvgLogMin:28, downtimeMin:900,
  onSiteMin:15, extraMeterMin:4, travelMinPerKm:1.5, onSiteSource:'fit',
  landDaysWorked:45, landHoursWorked:360, landTotalLogs:600, landInstalls:560, landUtis:20,
  landAvgLogMin:22, landAvgPerDay:12, landAvgPerHour:1.6, landRecent30AvgLogMin:21, landDowntimeMin:500,
  landOnSiteMin:11, landExtraMeterMin:3, landTravelMinPerKm:1.2, landOnSiteSource:'gps',
  boatDaysWorked:15, boatHoursWorked:120, boatTotalLogs:100, boatInstalls:80, boatUtis:10,
  boatAvgLogMin:53, boatAvgPerDay:5, boatAvgPerHour:0.7, boatRecent30AvgLogMin:'', boatDowntimeMin:400,
  boatOnSiteMin:'', boatExtraMeterMin:'', boatTravelMinPerKm:'', boatOnSiteSource:'pace',
};

test('metricsForMode projects one column group onto the canonical names', () => {
  const [land] = metricsForMode([wide], 'land');
  assert.equal(land.name, 'Quincy Orta');
  assert.equal(land.workType, 'land');
  assert.equal(land.avgLogMin, 22);
  assert.equal(land.recent30AvgLogMin, 21);
  assert.equal(land.daysWorked, 45);
  assert.equal(land.onSiteMin, 11);
  assert.equal(land.onSiteSource, 'gps');
  const [boat] = metricsForMode([wide], 'boat');
  assert.equal(boat.avgLogMin, 53);
  assert.equal(boat.installs, 80);
  // 'all' is the wide row itself — its unprefixed columns are the combined figures
  assert.equal(metricsForMode([wide], 'all')[0], wide);
  assert.deepEqual(metricsForMode(null, 'land'), []);
});

test('the lifetime table reads the chosen mode', () => {
  const [land] = lifetimeRows(metricsForMode([wide], 'land'));
  assert.equal(land.avgLogMin, 22);
  assert.equal(land.recent30, 21);
  assert.equal(land.trend, 'steady');
  // an installer with no days in that mode drops off the table
  const landOnly = { name:'Land Only', daysWorked:5, landDaysWorked:5, boatDaysWorked:0 };
  assert.deepEqual(lifetimeRows(metricsForMode([landOnly], 'boat')), []);
  assert.equal(lifetimeRows(metricsForMode([landOnly], 'land')).length, 1);
  // a mode with no measured dwell leaves no dwell row
  assert.deepEqual(dwellRows(metricsForMode([wide], 'boat')), []);
  assert.equal(dwellRows(metricsForMode([wide], 'land'))[0].onSiteMin, 11);
});

test('map.html carries the three-way switch', () => {
  assert.match(mapHtml, /id="workSeg"/);
  for (const wt of ['land', 'boat', 'all'])
    assert.match(mapHtml, new RegExp(`data-wt="${wt}"`), `missing the ${wt} button`);
});

test('map.js keeps the switch on its own key, defaulting to land', () => {
  assert.match(mapJs, /WORK_VIEW_KEY = 'analyticsWorkType'/);
  assert.match(mapJs, /: 'land';/);
  // never the capture app's mode, and never the teams view
  for (const key of ["'workMode'", "'captureWorkMode'", "'teamsViewMode'"])
    assert.ok(!mapJs.includes(key), `map.js reaches for ${key}`);
  assert.ok(!/^import .*work-mode\.js/m.test(mapJs), 'map.js should not import the capture work mode');
});

test('map.js survives older cached files on either side', () => {
  // The new helpers are reached through the namespace (no new named import that
  // an older cached module could fail to link), and #workSeg is bound behind a
  // null check (an older cached map.html has none).
  assert.match(mapJs, /import \* as life from '\.\.\/compute\/installer-lifetime\.js'/);
  assert.ok(!/import \{[^}]*(matchesWorkType|metricsForMode)[^}]*\}/.test(mapJs),
    'new helpers must not be named imports');
  assert.match(mapJs, /typeof life\.matchesWorkType === 'function'/);
  assert.match(mapJs, /const workSeg = \$\('workSeg'\);\s*\n\s*if\(!workSeg \|\|/);
  // with no control to see, the view falls back to plain totals
  assert.match(mapJs, /workView = 'all';/);
});

test('the map pins ignore the switch — analytics only', () => {
  const forMap = mapJs.slice(mapJs.indexOf('function forMap()'), mapJs.indexOf('function pinsInScope()'));
  assert.ok(forMap.length > 0);
  assert.ok(!forMap.includes('wtMatch'), 'forMap must not filter by work type');
  for (const fn of ['function pinsInScope()', 'function trkInScope()', 'function gapsInScope()']) {
    const at = mapJs.indexOf(fn);
    assert.ok(mapJs.slice(at, at + 260).includes('wtMatch('), `${fn} should apply the work type`);
  }
});
