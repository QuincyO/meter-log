import test from 'node:test';
import assert from 'node:assert/strict';
import { lifetimeRows, paceTrend, modePace, dwellRows }
  from '../js/compute/installer-lifetime.js';

// A realistic wide InstallerMetrics row, matching the sheet's column names.
const quincy = {
  hNumber:'H629528', name:'Quincy Orta', daysWorked:30, hoursWorked:244,
  totalLogs:329, installs:291, utis:16, downtimeMin:1662,
  avgLogMin:32, avgPerDay:10, avgPerHour:1.3, recent30AvgLogMin:31,
  boatAvgLogMin:53, landAvgLogMin:20,
  onSiteMin:19, extraMeterMin:10, travelMinPerKm:1.4, onSiteSource:'fit',
};

test('lifetimeRows drops zero-day and blank-day rows', () => {
  const rows = lifetimeRows([
    quincy,
    { name:'Owen McCagherty', daysWorked:0, hoursWorked:0, totalLogs:0 },
    { name:'No Days Yet', daysWorked:'', totalLogs:'' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Quincy Orta');
});

test('lifetimeRows turns blank sheet cells into null, never NaN', () => {
  const [r] = lifetimeRows([{ name:'A', daysWorked:5, totalLogs:40,
    avgLogMin:'', recent30AvgLogMin:'', hoursWorked:'', installs:20, utis:'' }]);
  assert.equal(r.avgLogMin, null);
  assert.equal(r.recent30, null);
  assert.equal(r.hours, null);
  assert.equal(r.utis, null);
  for (const v of Object.values(r)) assert.ok(!Number.isNaN(v), 'no NaN may escape');
});

test('lifetimeRows coerces string numbers from the sheet', () => {
  const [r] = lifetimeRows([{ name:'A', daysWorked:'5', totalLogs:'40', avgLogMin:'32' }]);
  assert.equal(r.days, 5);
  assert.equal(r.avgLogMin, 32);
});

test('lifetimeRows computes the derived rates', () => {
  const [r] = lifetimeRows([quincy]);
  assert.equal(r.utiRate, Math.round(16 / 329 * 100));          // %
  assert.equal(r.downtimePerDay, Math.round(1662 / 30));        // min/day
  assert.equal(r.hoursPerDay, Math.round(244 / 30 * 10) / 10);  // 1 decimal
});

test('lifetimeRows leaves a rate null when its inputs are missing', () => {
  const [r] = lifetimeRows([{ name:'A', daysWorked:3, totalLogs:'', downtimeMin:'' }]);
  assert.equal(r.utiRate, null);
  assert.equal(r.downtimePerDay, null);
});

test('lifetimeRows sorts by name', () => {
  const rows = lifetimeRows([
    { name:'Zed', daysWorked:1 }, { name:'Abe', daysWorked:1 }]);
  assert.deepEqual(rows.map(r => r.name), ['Abe', 'Zed']);
});

test('paceTrend: within the steady band is steady', () => {
  assert.equal(paceTrend(31, 32), 'steady');   // the live Quincy case
  assert.equal(paceTrend(32, 32), 'steady');
});

test('paceTrend: clearly under is faster, clearly over is slower', () => {
  assert.equal(paceTrend(20, 32), 'faster');
  assert.equal(paceTrend(45, 32), 'slower');
});

test('paceTrend: the band is at least 2 minutes even on a small lifetime pace', () => {
  // 10% of 10 is 1 min — the 2-min floor keeps ±2 reading as steady.
  assert.equal(paceTrend(12, 10), 'steady');
  assert.equal(paceTrend(13, 10), 'slower');
});

test('paceTrend: null when either side is missing', () => {
  assert.equal(paceTrend(null, 32), null);
  assert.equal(paceTrend('', 32), null);
  assert.equal(paceTrend(31, null), null);
});

test('modePace keeps only installers with a mode pace, null-padding the missing mode', () => {
  const mp = modePace([
    quincy,
    { name:'Land Only', daysWorked:1, landAvgLogMin:16, boatAvgLogMin:'' },
    { name:'Neither', daysWorked:1, landAvgLogMin:'', boatAvgLogMin:'' },
    { name:'Zero Days', daysWorked:0, landAvgLogMin:16, boatAvgLogMin:48 },
  ]);
  assert.deepEqual(mp.labels, ['Land Only', 'Quincy Orta']);
  assert.deepEqual(mp.land, [16, 20]);
  assert.deepEqual(mp.boat, [null, 53]);
});

test('dwellRows keeps rows with any dwell evidence and rounds travel to 1 decimal', () => {
  const rows = dwellRows([
    quincy,
    { name:'Rounds', daysWorked:1, travelMinPerKm:'9.16', onSiteSource:'gps' },
    { name:'No Dwell', daysWorked:1, onSiteMin:'', extraMeterMin:'', travelMinPerKm:'', onSiteSource:'pace' },
  ]);
  assert.deepEqual(rows.map(r => r.name), ['Quincy Orta', 'Rounds']);
  assert.equal(rows[0].onSiteMin, 19);
  assert.equal(rows[0].source, 'fit');
  assert.equal(rows[1].travelMinPerKm, 9.2);
});
