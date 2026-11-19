// The audit's numbers (js/compute/audit.js), over made-up days where every answer
// can be worked out by hand. Nothing here is a real installer's data: the name is
// Pat Example and the days are built by the two helpers below. A real person's
// figures must never be committed (GitHub Pages publishes the whole tree).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT, pct, mean, kindOf, prepareAudit, periodStats, dayDetail, driveStats }
  from '../js/compute/audit.js';

const WHO = 'Pat Example';
const KM_PER_DEG = 6371 * Math.PI / 180;
const pad = n => String(n).padStart(2, '0');

// One INSTALLED stop per 'HH:MM[:SS]' clock. Each pin sits `km` north of the one
// before; pass an array to give each gap its own distance.
function stopsOn(date, clocks, { km = 0.01 } = {}){
  let lat = 44;
  return clocks.map((c, i) => {
    if(i) lat += (Array.isArray(km) ? km[i - 1] : km) / KM_PER_DEG;
    return { id: `${date}-${i}`, timestamp: `${date} ${c.length === 5 ? c + ':00' : c}`,
      status: 'INSTALLED', workOrderId: String(900000 + i), address: `${i + 1} Main St`,
      lat, lng: -79 };
  });
}
// `n` weekdays from 2026-09-01 on.
function weekdays(n, start = '2026-09-01'){
  const out = [], d = new Date(start + 'T12:00:00Z');
  while(out.length < n){
    if(d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
// Clocks `step` minutes apart from `first` ('HH:MM').
function every(first, count, step = 6){
  const [h, m] = first.split(':').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const t = h * 60 + m + i * step;
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  });
}
// n weekdays of nine logs six minutes apart, next door to each other: the usual
// time next door, and the usual time over every gap, are both 6 minutes.
const history = n => weekdays(n).flatMap(d => stopsOn(d, every('09:00', 9)));
const gapRow = (date, category, minutes, note, extra = {}) =>
  ({ id: `${date}-${category}-${note}`, timestamp: `${date} 12:00:00`, category, minutes,
    workOrderId: '', note, ...extra });
const prep = (stops, downtime = [], days = [], mode = 'land') =>
  prepareAudit({ stops, downtime, days }, { installer: WHO, mode });
const dayOf = (p, date) => p.days.find(d => d.date === date);
const D = '2026-11-02';   // a Monday after the history

// ── prepareAudit ─────────────────────────────────────────────────────────────

test('a 9-minute overrun is work and a 10-minute overrun is a pause', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:15', '10:31'])]);
  const day = dayOf(p, D);
  assert.equal(p.usual[0], 6);
  assert.deepEqual(day.gaps.map(g => [g.isPause, g.over]), [[false, 9], [true, 10]]);
  assert.equal(day.pauseUnMin, 10);
  assert.equal(day.pauseAllMin, 10);
  assert.equal(day.pauses, 1);
  assert.equal(day.workMin, 15 + 6);
  assert.equal(day.spanMin, day.workMin + day.pauseAllMin);
});

test('a logged delay comes off its gap, keyed on floored minutes, whatever its workType', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00:45', '10:40:30'])],
    [gapRow(D, 'WAREHOUSE', 20, 'gap 10:00–10:40', { workType: '' })]);
  const day = dayOf(p, D), gap = day.gaps[0];
  assert.equal(gap.over, 39.75 - 6);
  assert.equal(gap.loggedMin, 20);
  assert.equal(gap.unloggedMin, gap.over - 20);
  assert.equal(day.pauseLoggedMin, 20);
  assert.equal(day.pauseUnMin + day.pauseLoggedMin, day.pauseAllMin);
  assert.equal(day.log.between, 20);
});

test('break, lunch and travel rows are never taken off', () => {
  for(const cat of ['BREAK', 'LUNCH', 'MISC_TRAVEL', 'TRAVEL_TIME']){
    const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:40'])],
      [gapRow(D, cat, 30, 'gap 10:00–10:40')]);
    const day = dayOf(p, D);
    assert.equal(day.gaps[0].loggedMin, 0, cat);
    assert.equal(day.log.total, 0, cat);
    assert.equal(day.log.breaks + day.log.travel, 30, cat);
    assert.deepEqual(day.delays, [], cat);
  }
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:40'])],
    [gapRow(D, 'BREAK', 30, 'gap 10:00–10:40')]);
  assert.equal(dayOf(p, D).log.breaks, 30);
});

test('a delay bigger than the pause leaves zero, not a negative', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:40'])],
    [gapRow(D, 'WAREHOUSE', 60, 'gap 10:00–10:40')]);
  const day = dayOf(p, D);
  assert.equal(day.gaps[0].unloggedMin, 0);
  assert.equal(day.pauseUnMin, 0);
  assert.equal(day.pauseLoggedMin, 34);
  assert.equal(day.longestMin, 0);
  assert.equal(day.longestAtMin, null);
});

test('a gap note that matches no gap counts by where it falls and deducts nothing', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:40'])],
    [gapRow(D, 'WAREHOUSE', 25, 'gap 10:05–10:30')]);
  const day = dayOf(p, D);
  assert.equal(day.log.between, 25);
  assert.equal(day.pauseAllMin, 34);
  assert.equal(day.pauseUnMin, day.pauseAllMin);
});

test('a 45-minute unlogged pause is flagged and a 44-minute one is not', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:51', '11:41'])]);
  const day = dayOf(p, D);
  assert.deepEqual(day.gaps.map(g => [g.unloggedMin, g.flagged]), [[45, true], [44, false]]);
  assert.equal(day.flags, 1);
  assert.equal(day.longestMin, 45);
  assert.equal(day.longestAtMin, 600);
});

test('a pause logged down under 45 minutes is not flagged', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '11:00'])],
    [gapRow(D, 'TRUCK_ISSUES', 20, 'gap 10:00–11:00')]);
  const gap = dayOf(p, D).gaps[0];
  assert.deepEqual([gap.over, gap.unloggedMin, gap.flagged], [54, 34, false]);
});

const PLACED = [
  gapRow(D, 'DISPATCH', 30, 'gap 07:30–08:00'),
  gapRow(D, 'WAREHOUSE', 70, 'gap 08:00–10:00'),
  gapRow(D, 'TOOLS_MATERIAL', 15, 'gap 10:06–11:00'),
  gapRow(D, 'OTHER', 10, 'gap 11:00–11:30'),
  gapRow(D, 'CELL_SIGNAL', 5, ''),
];
test('delays are placed before, between, after and untimed', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:06', '11:00'])], PLACED);
  const day = dayOf(p, D);
  assert.deepEqual(day.delays.map(d => d.where), ['before', 'before', 'between', 'after', 'untimed']);
  assert.deepEqual(day.delays.map(d => [d.fromMin, d.toMin]),
    [[450, 480], [480, 600], [606, 660], [660, 690], [null, null]]);
  assert.deepEqual(
    [day.log.before, day.log.between, day.log.after, day.log.untimed, day.log.total],
    [100, 15, 10, 5, 130]);
  assert.equal(day.delays[1].label, 'Warehouse');
});

test('dispatch before the first meter is the drive to the first order', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:06', '11:00'])],
    [...PLACED, gapRow(D, 'DISPATCH', 12, 'gap 10:00–10:06')]);
  const day = dayOf(p, D);
  assert.equal(day.log.dispatchBefore, 30);
  assert.equal(day.log.otherBefore, 70);
  const dispatch = day.delays.filter(d => d.category === 'DISPATCH');
  assert.deepEqual(dispatch.map(d => d.driveToFirst), [true, false]);   // between meters it is an ordinary delay
  assert.equal(day.delays.find(d => d.category === 'WAREHOUSE').driveToFirst, false);
  // first meter 10:00, shift start 07:30, 100 minutes logged before it
  assert.equal(day.beforeUnloggedMin, 150 - 100);
});

test('a delay of zero minutes, or on a day with no logs, is left out', () => {
  const p = prep([...history(10), ...stopsOn(D, ['10:00', '10:06'])], [
    gapRow(D, 'WAREHOUSE', 0, 'gap 08:00–09:00'),
    gapRow(D, 'WAREHOUSE', '', 'gap 08:00–09:00'),
    gapRow('2026-11-03', 'WAREHOUSE', 40, 'gap 08:00–09:00'),
  ]);
  assert.deepEqual(dayOf(p, D).delays, []);
  assert.equal(p.days.some(d => d.date === '2026-11-03'), false);
});

test('a missing pin measures the gap against every gap', () => {
  const stops = stopsOn(D, ['10:00', '10:20', '10:40', '11:00']);
  stops[1].lat = ''; stops[2].lat = 0; stops[3].lat = null;
  const p = prep([...history(10), ...stops]);
  const day = dayOf(p, D);
  assert.deepEqual(day.gaps.map(g => [g.km, g.kind]), [[null, -1], [null, -1], [null, -1]]);
  assert.ok(day.gaps.every(g => g.usual === p.usualAny));
  assert.deepEqual(day.logs.map(l => l.pin), [true, false, false, false]);
  assert.equal(p.unpinned, 3);
});

test('a kind with fewer than five gaps uses the all-gap median', () => {
  const four = stopsOn(D, every('10:00', 5, 30), { km: 0.7 });
  const p4 = prep([...history(10), ...four]);
  assert.equal(p4.kindCounts[2], 4);
  assert.equal(p4.usual[2], 6);
  assert.equal(p4.usualAny, 6);
  assert.ok(dayOf(p4, D).gaps.every(g => g.isPause && g.over === 24));
  const p5 = prep([...history(10), ...stopsOn(D, every('10:00', 6, 30), { km: 0.7 })]);
  assert.equal(p5.kindCounts[2], AUDIT.MIN_KIND_GAPS);
  assert.equal(p5.usual[2], 30);
  assert.ok(dayOf(p5, D).gaps.every(g => !g.isPause));
});

test('each distance kind is binned on its bound', () => {
  assert.deepEqual([0, 0.059, 0.06, 0.499, 0.5, 1, 2, 5, 9.99, 10, 400].map(kindOf),
    [0, 0, 1, 1, 2, 3, 4, 5, 5, 6, 6]);
  assert.equal(kindOf(null), -1);
  const p = prep(stopsOn(D, every('10:00', 8, 10), { km: [0.03, 0.2, 0.7, 1.5, 3, 7, 12] }));
  assert.deepEqual(dayOf(p, D).gaps.map(g => g.kind), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(Math.abs(dayOf(p, D).gaps[4].km - 3) < 1e-6);
  assert.deepEqual(p.kindCounts, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(AUDIT.KIND_LABELS.length, AUDIT.KIND_KM.length);
});

test('a one-digit hour parses', () => {
  const stops = stopsOn('2026-09-01', ['09:05', '09:20']);
  stops[0].timestamp = '2026-09-01 9:05:00';
  stops[1].timestamp = '2026-09-01 9:20:30';
  const day = prep(stops).days[0];
  assert.equal(day.firstMin, 545);
  assert.equal(day.lastMin, 560.5);
  assert.deepEqual(day.logs.map(l => l.clock), ['09:05', '09:20']);
});

test('logs are put in time order whatever order they arrive in', () => {
  const stops = stopsOn(D, ['10:00', '10:10', '10:20']).reverse();
  assert.deepEqual(prep(stops).days[0].logs.map(l => l.clock), ['10:00', '10:10', '10:20']);
});

test('land and boat follow the date, not the tag', () => {
  const stops = [
    ...stopsOn('2026-07-01', ['10:00', '10:10', '10:20']),
    ...stopsOn('2026-09-01', ['10:00', '10:10']).map(s => ({ ...s, workType: 'boat' })),
  ];
  const land = prep(stops, [], [], 'land'), boat = prep(stops, [], [], 'boat'), all = prep(stops, [], [], 'all');
  assert.deepEqual(land.days.map(d => d.date), ['2026-09-01']);
  assert.deepEqual([land.orders, land.skippedOtherMode], [2, 3]);
  assert.deepEqual(boat.days.map(d => d.date), ['2026-07-01']);
  assert.deepEqual([boat.orders, boat.skippedOtherMode], [3, 2]);
  assert.deepEqual(all.days.map(d => d.date), ['2026-07-01', '2026-09-01']);
  assert.deepEqual([all.orders, all.skippedOtherMode], [5, 0]);
});

test('the day ends at close-out, at 16:00 without one, and at the last meter when that is later', () => {
  const [a, b, c, e] = weekdays(4);
  const p = prep([
    ...stopsOn(a, ['10:00', '10:10']), ...stopsOn(b, ['10:00', '10:10']),
    ...stopsOn(c, ['10:00', '10:10']), ...stopsOn(e, ['16:00', '16:10', '16:20']),
  ], [], [
    { date: a, departure: '07:30', returned: '17:00' },
    { date: c, departure: '', returned: '—' },
    { date: e, departure: '07:30', returned: '16:00' },
  ]);
  const [d1, d2, d3, d4] = p.days;
  assert.deepEqual([d1.endMin, d1.endSource, d1.closed, d1.pastEnd], [1020, 'closeout', true, false]);
  assert.equal(d1.closeoutMin, 1020 - 610);
  assert.deepEqual([d2.endMin, d2.endSource, d2.closed], [960, 'default', false]);      // no Days row
  assert.deepEqual([d3.endMin, d3.endSource, d3.closed], [960, 'default', false]);      // returned '—'
  assert.deepEqual([d4.endMin, d4.endSource, d4.pastEnd, d4.closeoutMin], [980, 'lastMeter', true, 0]);
  assert.equal(d4.closed, true);
});

test('the day starts at 07:30, or at the first log when that is earlier', () => {
  const [a, b] = weekdays(2);
  const p = prep([...stopsOn(a, ['09:00', '09:10']), ...stopsOn(b, ['07:00', '07:10'])]);
  assert.deepEqual(p.days.map(d => [d.startMin, d.beforeUnloggedMin]), [[450, 90], [420, 0]]);
});

test('a day under 8 orders is kept but does not qualify', () => {
  const [a, b] = weekdays(2);
  const p = prep([...stopsOn(a, every('09:00', 7)), ...stopsOn(b, every('09:00', 8))]);
  assert.deepEqual(p.days.map(d => [d.n, d.qualifies]), [[7, false], [8, true]]);
});

test('orders are counted by status', () => {
  const stops = stopsOn(D, every('09:00', 5));
  stops[1].status = 'UTI'; stops[2].status = 'visited'; stops[3].status = 'UNACCOUNTED';
  const p = prep(stops);
  assert.deepEqual(p.status, { installed: 2, uti: 1, other: 2 });
  assert.equal(p.orders, 5);
  assert.equal(p.gapsCount, 4);
});

test('no logs, or none in the mode, is an empty model', () => {
  const empty = prep([]);
  assert.deepEqual(empty.days, []);
  assert.equal(empty.usualAny, null);
  assert.equal(empty.orders, 0);
  assert.deepEqual(empty.usual, [null, null, null, null, null, null, null]);
  assert.deepEqual(prepareAudit(null, { installer: WHO, mode: 'land' }).days, []);
  const boatOnly = prep(stopsOn('2026-07-01', ['10:00', '10:10']), [], [], 'land');
  assert.deepEqual([boatOnly.days.length, boatOnly.orders, boatOnly.skippedOtherMode], [0, 0, 2]);
});

test('pct takes the value at floor(n × p)', () => {
  assert.equal(pct([1, 2, 3, 4], .5), 3);
  assert.equal(pct([4, 1, 3, 2], .5), 3);
  assert.equal(pct([1, 2, 3, 4], .25), 2);
  assert.equal(pct([5], .9), 5);
  assert.equal(pct([], .5), null);
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), null);
});

// ── periodStats ──────────────────────────────────────────────────────────────

const ALL = { from: '', to: '' };
// Nine logs: eight six minutes apart from 09:00, then one `gap` minutes after 09:42.
const dayWithGap = (date, gap) => {
  const t = 582 + gap, s = Math.round((t % 1) * 60);
  return stopsOn(date, [...every('09:00', 8), `${pad(Math.floor(t / 60))}:${pad(Math.floor(t % 60))}:${pad(s)}`]);
};
function noNaN(v, path = 'stats'){
  if(typeof v === 'number') assert.ok(!Number.isNaN(v), `${path} is NaN`);
  else if(v && typeof v === 'object') for(const k of Object.keys(v)) noNaN(v[k], `${path}.${k}`);
}

test('the average-day bar adds up to the average day', () => {
  const dates = weekdays(12);
  const stops = dates.flatMap((d, i) => i % 3 ? stopsOn(d, every('09:00', 9)) : dayWithGap(d, 78));
  const downtime = [
    gapRow(dates[0], 'DISPATCH', 40, 'gap 07:30–08:10'),
    gapRow(dates[0], 'WAREHOUSE', 20, 'gap 08:10–08:30'),
    gapRow(dates[0], 'TRUCK_ISSUES', 30, 'gap 09:42–11:00'),
  ];
  const days = [{ date: dates[1], returned: '17:00' }, { date: dates[2], returned: '16:00' }];
  const p = periodStats(prep(stops, downtime, days), ALL);
  const sum = p.bar.segments.reduce((s, x) => s + x.minutes, 0);
  assert.ok(Math.abs(sum - (p.bar.endMin - p.bar.startMin)) < 1e-6);
  assert.deepEqual(p.bar.segments.map(s => s.key),
    ['delayBefore', 'driveToFirst', 'beforeUnlogged', 'work', 'pauseUnlogged', 'pauseLogged', 'closeout']);
  const seg = Object.fromEntries(p.bar.segments.map(s => [s.key, s.minutes]));
  assert.equal(p.bar.startMin, 450);
  assert.equal(p.bar.firstMin, 540);
  assert.equal(p.bar.endMin, 960 + 60 / 12);
  assert.ok(Math.abs(seg.delayBefore - 20 / 12) < 1e-9);
  assert.ok(Math.abs(seg.driveToFirst - 40 / 12) < 1e-9);
  assert.ok(Math.abs(seg.pauseLogged - 30 / 12) < 1e-9);
  assert.ok(Math.abs(seg.pauseUnlogged - (4 * 72 - 30) / 12) < 1e-9);
  noNaN(p);
});

test('statistics skip short days and the day list keeps them', () => {
  const p = periodStats(prep([...history(10), ...stopsOn(D, ['09:00', '12:00', '15:00'])]), ALL);
  assert.deepEqual([p.days, p.fullDays, p.orders], [11, 10, 93]);
  assert.equal(p.daily.length, 11);
  assert.deepEqual([p.daily[10].date, p.daily[10].qualifies, p.daily[10].flags], [D, false, 2]);
  assert.equal(p.pause.median, 0);
  assert.equal(p.pause.flags, 0);
  assert.equal(p.output.ordersBest, 9);
  assert.equal(p.headline.ordersAvg, 9);
  assert.equal(p.output.perOrder, (10 * 48 + 360) / (10 * 8 + 2));   // every day, short ones included
});

test('the range limits the days and leaves the usual times alone', () => {
  const model = prep([...history(15), ...stopsOn(D, every('10:00', 6, 30), { km: 0.7 })]);
  const week = periodStats(model, { from: '2026-09-08', to: '2026-09-12' });
  assert.deepEqual(week.daily.map(d => d.date), ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  assert.deepEqual([week.days, week.orders, week.from, week.to], [4, 36, '2026-09-08', '2026-09-12']);
  assert.deepEqual(week.usual, periodStats(model, ALL).usual);
  assert.equal(week.gapsCount, model.gapsCount);
  assert.deepEqual(week.usual[2], { label: '0.5 to 1 km', median: 30, count: 5 });
  assert.equal(week.nextDoorShare, 120 / 125);
  assert.equal(periodStats(model, { from: '2026-09-21', to: '' }).days, 2);     // open-ended: Sep 21 and the November day
});

test('the histogram bins on [lo, hi)', () => {
  const dates = weekdays(5);
  const p = periodStats(prep([0, 20.9, 21, 66, 156].flatMap((gap, i) =>
    gap ? dayWithGap(dates[i], gap) : stopsOn(dates[i], every('09:00', 9)))), ALL);
  assert.deepEqual(p.daily.map(d => Math.round(d.pauseUn * 10) / 10), [0, 14.9, 15, 60, 150]);
  assert.deepEqual(p.pause.bins.map(b => b.days), [2, 1, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual([p.pause.bins[0].lo, p.pause.bins[0].hi, p.pause.bins[9].hi], [0, 15, Infinity]);
  assert.deepEqual([p.pause.under60, p.pause.over90, p.pause.flags, p.pause.flagDays], [3, 1, 2, 2]);
  assert.equal(p.pause.median, 15);
  assert.equal(p.pause.longestMedian, 60);          // of the days that had a pause
  assert.equal(p.pause.longestAtMedian, 582);
  assert.equal(p.pause.perDay, 4 / 5);
});

test('category totals cover short days and leave out travel and breaks', () => {
  const [first] = weekdays(1);
  const p = periodStats(prep([...history(10), ...stopsOn(D, ['10:00', '10:06', '10:12'])], [
    gapRow(first, 'DISPATCH', 30, 'gap 07:30–08:00'),
    gapRow(first, 'WAREHOUSE', 10, 'gap 09:10–09:20'),
    gapRow(D, 'WAREHOUSE', 40, 'gap 08:00–08:40'),
    gapRow(D, 'BREAK', 15, ''),
    gapRow(D, 'MISC_TRAVEL', 20, 'gap 10:00–10:06'),
  ]), ALL);
  assert.deepEqual(p.categories.map(c => [c.category, c.label, c.minutes, c.days, c.before, c.between]),
    [['WAREHOUSE', 'Warehouse', 50, 2, 40, 10], ['DISPATCH', 'Dispatch', 30, 1, 30, 0]]);
  assert.deepEqual(p.categories.map(c => [c.share, c.beforeShare, c.betweenShare]),
    [[50 / 80, 0.8, 0.2], [30 / 80, 1, 0]]);
  assert.equal(p.headline.loggedBeforeShare, 70 / 80);
  assert.equal(p.loggedPerDay.total, 40 / 10);        // per-day figures use the full days only
  assert.equal(p.loggedPerDay.dispatchBefore, 3);
  assert.equal(p.loggedPerDay.otherBefore, 0);
  assert.equal(p.headline.loggedAvg, 4);
});

test('months are reported from the full days in each', () => {
  const p = periodStats(prep([...history(30), ...stopsOn('2026-10-31', ['09:00', '09:06'])]), ALL);
  assert.deepEqual(p.months.map(m => [m.month, m.days, m.ordersAvg, m.firstAvg, m.lastAvg, m.perOrder, m.pauseMedian, m.loggedAvg]),
    [['2026-09', 22, 9, 540, 588, 6, 0, 0], ['2026-10', 8, 9, 540, 588, 6, 0, 0]]);
});

test('a range with no qualifying day has null statistics and a correct day list', () => {
  const [a, b] = weekdays(2);
  const model = prep([...stopsOn(a, ['09:00', '09:30']), ...stopsOn(b, ['10:00', '10:30', '11:00'])]);
  const p = periodStats(model, ALL);
  assert.deepEqual([p.days, p.fullDays, p.orders], [2, 0, 5]);
  assert.equal(p.headline.pauseMedian, null);
  assert.equal(p.headline.ordersAvg, null);
  assert.equal(p.bar, null);
  assert.equal(p.pause.median, null);
  assert.equal(p.output.firstAvg, null);
  assert.deepEqual(p.months, []);
  assert.deepEqual(p.daily.map(d => [d.date, d.n]), [[a, 2], [b, 3]]);
  noNaN(p);
  const backwards = periodStats(model, { from: '2026-10-01', to: '2026-09-01' });
  assert.equal(backwards.days, 0);
  assert.deepEqual(backwards.daily, []);
  noNaN(backwards);
});

test('an empty model gives empty statistics', () => {
  const p = periodStats(prep([]), ALL);
  assert.deepEqual([p.days, p.fullDays, p.orders, p.bar, p.nextDoorShare], [0, 0, 0, null, null]);
  assert.deepEqual([p.daily, p.categories, p.months], [[], [], []]);
  assert.equal(p.usual.length, 7);
  assert.deepEqual(p.usual[0], { label: 'Next door (under 60 m)', median: null, count: 0 });
  noNaN(p);
});

// ── dayDetail ────────────────────────────────────────────────────────────────

test('the 30-day baseline is the 30 qualifying days before the day', () => {
  const dates = weekdays(40);
  const stops = dates.flatMap((d, i) => stopsOn(d, every(i < 5 ? '10:00' : '09:00', 9)));
  // a short day in the middle must not use up one of the thirty
  const model = prep([...stops, ...stopsOn('2026-10-17', ['09:00', '09:06'])]);
  const d36 = dayDetail(model, dates[35]);
  assert.deepEqual([d36.baselines.last30.days, d36.baselines.last30.firstAvg], [30, 540]);   // days 6 to 35
  assert.deepEqual([d36.baselines.all.days, d36.baselines.all.firstAvg], [40, 547.5]);
  assert.deepEqual([d36.prevDate, d36.nextDate], [dates[34], dates[36]]);
  assert.equal(d36.day.date, dates[35]);
  const d5 = dayDetail(model, dates[4]);
  assert.deepEqual([d5.baselines.last30.days, d5.baselines.last30.firstAvg], [4, 600]);
  const d1 = dayDetail(model, dates[0]);
  assert.deepEqual(d1.baselines.last30,
    { days: 0, ordersAvg: null, firstAvg: null, lastAvg: null, loggedBeforeAvg: null,
      loggedBetweenAvg: null, pauseMedian: null, longestMedian: null });
  assert.equal(d1.prevDate, null);
  assert.equal(dayDetail(model, dates[39]).nextDate, null);
  // the short day is still a neighbour to step to
  assert.equal(dayDetail(model, '2026-10-19').prevDate, '2026-10-17');
});

test('a baseline reports averages for the day shape and medians for the pauses', () => {
  const dates = weekdays(3);
  const model = prep([...stopsOn(dates[0], every('09:00', 9)), ...dayWithGap(dates[1], 36), ...dayWithGap(dates[2], 66),
    ...stopsOn(D, every('09:00', 9))],
    [gapRow(dates[0], 'DISPATCH', 30, 'gap 07:30–08:00'), gapRow(dates[1], 'OTHER', 12, 'gap 09:06–09:12')]);
  const b = dayDetail(model, D).baselines.last30;
  assert.deepEqual([b.days, b.ordersAvg, b.firstAvg, b.loggedBeforeAvg, b.loggedBetweenAvg], [3, 9, 540, 10, 4]);
  assert.equal(b.lastAvg, (588 + 618 + 648) / 3);
  assert.equal(b.pauseMedian, 30);          // 0, 30, 60
  assert.equal(b.longestMedian, 60);        // of the two days that had one: 30, 60
});

test('a one-log day opens with no gaps', () => {
  const d = dayDetail(prep([...history(10), ...stopsOn(D, ['11:15'])]), D);
  assert.deepEqual(d.day.gaps, []);
  assert.equal(d.day.pauseUnMin, 0);
  assert.equal(d.day.spanMin, 0);
  assert.deepEqual([d.day.n, d.day.qualifies, d.day.firstMin, d.day.lastMin], [1, false, 675, 675]);
  assert.equal(d.baselines.last30.days, 10);
});

test('dayDetail is null for a date with no logs', () => {
  const model = prep([...history(3), ...stopsOn('2026-07-01', ['10:00', '10:10'])]);
  assert.equal(dayDetail(model, '2026-12-25'), null);
  assert.equal(dayDetail(model, '2026-07-01'), null);      // a boat day, in a land audit
  assert.equal(dayDetail(model, ''), null);
});

// ── driveStats ───────────────────────────────────────────────────────────────

test('driveStats totals the legs', () => {
  const legs = [
    { distanceM: 30000, driveMin: 40, maxSpeed: 25, gaps: [{}] },
    { distanceM: 10000, driveMin: 20, maxSpeed: 20, gaps: [] },
  ];
  assert.deepEqual(driveStats(legs), { legs: 2, km: 40, driveMin: 60, avgKmh: 40, topKmh: 90, gaps: 1 });
  assert.equal(driveStats([]), null);
  assert.equal(driveStats(null), null);
  assert.equal(driveStats([{ distanceM: 0, driveMin: 0, maxSpeed: 0 }]).avgKmh, null);
});

// ── found by the whole-branch review ─────────────────────────────────────────

test('the phone\'s own lead-gap note is the drive to the first order', () => {
  // On a land day the phone lets the first order carry downtime through a zero-length
  // "lead" gap: both clocks are the first log's own minute, and the log has seconds.
  const stops = stopsOn(D, ['09:05:40', '09:20:00', '09:30:00']);
  const p = prep([...history(10), ...stops], [gapRow(D, 'DISPATCH', 35, 'gap 09:05–09:05')]);
  const day = dayOf(p, D);
  assert.deepEqual(day.delays.map(d => [d.where, d.driveToFirst, d.minutes]), [['before', true, 35]]);
  assert.equal(day.log.dispatchBefore, 35);
  assert.equal(day.pauseLoggedMin, 0);
});

// ── the pace on a day's route ────────────────────────────────────────────────
// Eleven full days worked next door (6 minutes a gap) and ten full days with the
// orders 0.3 km apart (12 minutes a gap), every one with a single gap 30 minutes
// over: a lunch. The usual time is then 6 next door and 12 at 0.3 km. The typical
// full day is the middle one of the 21, a next-door day: 8 gaps, 78 minutes from
// first to last meter, 48 of them at the usual pace: a share of 48/78.
const SPREAD = { km: 0.3 };
const withLunch = step => { const a = every('09:00', 5, step), [h, m] = a[4].split(':').map(Number);
  const t = h * 60 + m + step + 30;
  return [...a, ...every(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`, 4, step)]; };
const mixed = () => [...weekdays(11).flatMap(d => stopsOn(d, withLunch(6))),
  ...weekdays(10, '2026-10-01').flatMap(d => stopsOn(d, withLunch(12), SPREAD))];
const paceOf = (stops, downtime = []) => dayDetail(prep([...mixed(), ...stops], downtime), D).pace;

test('the typical full day is the middle one, and a route is priced at the usual pace', () => {
  const pace = paceOf(stopsOn(D, ['10:00', '10:12', '10:24', '11:06', '11:18'], SPREAD));
  const t = pace.typical;
  assert.deepEqual([t.days, t.perOrder, t.routeMin, t.ownMin, t.share, t.loggedMin, t.miss], [21, 6, 48, 78, 48 / 78, 0, 0]);
  assert.ok(Math.abs(t.km - 0.08) < 0.001);
  assert.deepEqual([pace.orders, pace.gaps, pace.usualMin, pace.perOrder, pace.tookMin, pace.ownMin, pace.share],
    [5, 4, 48, 12, 78, 78, 48 / 78]);
  assert.ok(Math.abs(pace.km - 1.2) < 0.001);
});

test('the same time on a spread-out route expects fewer orders than on a tight one', () => {
  // 78 minutes at the typical share is 48 at the usual pace: 4 gaps at 12 minutes, 5 orders
  const spread = paceOf(stopsOn(D, ['10:00', '10:12', '10:24', '11:06', '11:18'], SPREAD));
  assert.deepEqual([Math.round(spread.atPaceMin), spread.expected, spread.diff, Math.round(spread.paceMin)], [48, 5, 0, 0]);
  // the same 78 minutes next door: 48 at 6 minutes is 8 gaps, 9 orders. Five were logged.
  const tight = paceOf(stopsOn(D, ['10:00', '10:06', '10:12', '11:12', '11:18']));
  assert.deepEqual([tight.expected, tight.diff, Math.round(tight.paceMin)], [9, -4, 24]);
});

test('a delay logged against a gap comes off the time, and no more of it than the gap ran over', () => {
  const route = stopsOn(D, ['10:00', '10:12', '10:24', '11:34', '11:46'], SPREAD);     // the third gap is 58 over
  const none = paceOf(route);                      // 106 × 48/78 = 65.2 at the usual pace: 5.4 gaps
  assert.deepEqual([none.tookMin, none.loggedMin, none.ownMin, none.expected, none.diff, Math.round(none.paceMin)], [106, 0, 106, 6, -1, 17]);
  const part = paceOf(route, [gapRow(D, 'WAREHOUSE', 28, 'gap 10:24–11:34')]);
  assert.deepEqual([part.loggedMin, part.ownMin, part.expected, part.diff, Math.round(part.paceMin)], [28, 78, 5, 0, 0]);
  const more = paceOf(route, [gapRow(D, 'WAREHOUSE', 100, 'gap 10:24–11:34')]);
  assert.deepEqual([more.loggedMin, more.ownMin], [58, 48]);
  // a delay logged before the first meter is outside the time being paced
  const before = paceOf(route, [gapRow(D, 'DISPATCH', 60, 'gap 07:30–08:30'), gapRow(D, 'LUNCH', 30, '')]);
  assert.deepEqual([before.loggedMin, before.expected], [0, 6]);
});

test('a short day is paced by the same share of its own time', () => {
  // 24 minutes at 48/78 is 14.8 at the usual pace: 2.5 gaps at 6 minutes
  const short = paceOf(stopsOn(D, every('10:00', 5, 6)));
  assert.ok(Math.abs(short.atPaceMin - 24 * 48 / 78) < 1e-9);
  assert.deepEqual([short.expected, short.diff, Math.round(short.paceMin)], [3, 2, -9]);
});

test('quicker than usual is ahead of pace', () => {
  const quick = paceOf(stopsOn(D, ['10:00', '10:09', '10:18', '10:57', '11:06'], SPREAD));   // 9, 9, 39, 9
  assert.deepEqual([quick.tookMin, quick.usualMin], [66, 48]);
  assert.ok(quick.paceMin < 0);
  assert.equal(quick.diff, 1);
});

test('one order has no route to pace, and with no full day there is nothing to expect', () => {
  const one = paceOf(stopsOn(D, ['11:15']));
  assert.deepEqual([one.orders, one.gaps, one.expected, one.diff, one.paceMin, one.perOrder], [1, 0, null, null, null, null]);
  const alone = dayDetail(prep(stopsOn(D, every('10:00', 5, 12), SPREAD)), D).pace;
  assert.equal(alone.typical, null);
  assert.deepEqual([alone.expected, alone.diff, alone.paceMin, alone.atPaceMin], [null, null, null, null]);
  assert.deepEqual([alone.usualMin, alone.share], [48, 1]);            // against the median of its own gaps
});

test('the page can say how close the expected number has been on the full days to date', () => {
  // Three full days next door, 9 orders each, with one gap 30, 60 and 90 minutes over:
  // 78, 108 and 138 minutes, each with 48 at the usual pace. The typical share is the
  // middle one, 48/108. At that share the first day expects 7, the second 9, the third 11.
  const day = (date, over) => stopsOn(date, [...every('09:00', 5, 6),
    ...every(`${pad(9 + Math.floor((30 + over) / 60))}:${pad((30 + over) % 60)}`, 4, 6)]);
  const dates = weekdays(3);
  const p = prep(dates.flatMap((d, i) => day(d, 30 * (i + 1))));
  assert.deepEqual(dates.map(d => dayDetail(p, d).pace.diff), [2, 0, -2]);
  assert.equal(dayDetail(p, dates[0]).pace.typical.miss, 2);           // the middle of 0, 2 and 2
});

// ── a delay belongs to an order, and its time can fall after that order's log ──
// The phone files a delay under the gap BEFORE the order it is entered on (a gap is
// keyed to its arriving stop). But the time is often lost after the log is saved:
// log the meter, then the truck will not start. A field report found this: a delay
// entered on the problem order was filed under the short gap before its log, and the
// long gap after it read "nothing logged".
// Next door, so every gap's usual time is 6: gaps of 20, 10, 60 and 12 are 14, 4, 54 and 6 over.
const AFTER = ['10:00', '10:20', '10:30', '11:30', '11:42'];
const carried = downtime => dayOf(prep([...history(10), ...stopsOn(D, AFTER)], downtime), D);

test('what the gap before an order did not run over is taken off the gap after that order', () => {
  const day = carried([gapRow(D, 'TRUCK_ISSUES', 30, 'gap 10:20–10:30'), gapRow(D, 'TOOLS_MATERIAL', 15, 'gap 10:20–10:30')]);
  assert.deepEqual(day.gaps.map(g => g.over), [14, 4, 54, 6]);
  assert.deepEqual(day.gaps.map(g => g.loggedMin), [0, 45, 0, 0], 'each entry stays filed where it was entered');
  assert.deepEqual(day.gaps.map(g => g.carriedMin), [0, 0, 41, 0]);
  assert.deepEqual(day.gaps.map(g => g.carriedOutMin), [0, 41, 0, 0]);
  assert.deepEqual(day.gaps.map(g => [g.unloggedMin, g.flagged]), [[14, false], [0, false], [13, false], [0, false]]);
  assert.deepEqual([day.pauseUnMin, day.pauseLoggedMin, day.flags, day.longestMin], [27, 41, 0, 14]);
  // the delays say where they were counted
  assert.deepEqual(day.delays.map(d => [d.fromMin, d.toMin, d.carriedTo]),
    [[620, 630, { fromMin: 630, toMin: 690 }], [620, 630, { fromMin: 630, toMin: 690 }]]);
});

test('the gap before takes what it ran over first, and the rest goes one gap on and no further', () => {
  const day = carried([gapRow(D, 'TRUCK_ISSUES', 30, 'gap 10:00–10:20')]);       // 14 over: 14 used, 16 left
  assert.deepEqual(day.gaps.map(g => g.carriedMin), [0, 0, 0, 0]);          // the gap after is work, not a pause: nothing to take off
  assert.deepEqual(day.gaps.map(g => g.unloggedMin), [0, 0, 54, 0]);
  assert.equal(day.delays[0].carriedTo, null, 'nothing of it came off a pause after the order');
});

test('a gap\'s own entries count before anything carried into it, and never below zero', () => {
  const day = carried([gapRow(D, 'TRUCK_ISSUES', 45, 'gap 10:20–10:30'), gapRow(D, 'WAREHOUSE', 40, 'gap 10:30–11:30')]);
  assert.deepEqual(day.gaps.map(g => g.carriedMin), [0, 0, 14, 0]);         // 54 over, 40 its own, room for 14 of the 41
  assert.equal(day.gaps[2].unloggedMin, 0);
  const full = carried([gapRow(D, 'TRUCK_ISSUES', 45, 'gap 10:20–10:30'), gapRow(D, 'WAREHOUSE', 90, 'gap 10:30–11:30')]);
  assert.deepEqual([full.gaps[2].carriedMin, full.gaps[2].unloggedMin, full.gaps[3].carriedMin], [0, 0, 0]);
});

test('a delay on the last order has no gap after it, and one before the first meter is not carried', () => {
  const day = carried([gapRow(D, 'TRUCK_ISSUES', 30, 'gap 11:30–11:42'), gapRow(D, 'DISPATCH', 60, 'gap 07:30–08:30'),
    gapRow(D, 'LUNCH', 30, 'gap 10:20–10:30')]);
  assert.deepEqual(day.gaps.map(g => g.carriedMin), [0, 0, 0, 0]);
  assert.deepEqual(day.gaps.map(g => g.unloggedMin), [14, 0, 54, 0]);
});

test('the pace counts a carried delay once', () => {
  const p = prep([...history(10), ...stopsOn(D, AFTER)], [gapRow(D, 'TRUCK_ISSUES', 45, 'gap 10:20–10:30')]);
  const pace = dayDetail(p, D).pace;
  assert.deepEqual([pace.tookMin, pace.loggedMin, pace.ownMin], [102, 45, 57]);   // 4 from its own gap, 41 from the one after
});

// ── distance by road ─────────────────────────────────────────────────────────
// The page hands prepareAudit a `road` when the device holds an offline road map:
// km(a, b) is the shortest drive between two logs, or null where the map cannot reach.

test('with a road map a gap is measured and sorted by road, and by straight line where the map cannot reach', () => {
  const stops = stopsOn(D, ['10:00', '10:10', '10:20', '10:30'], { km: 0.3 });
  const answers = [0.35, 1.5, null], asked = [];
  const road = { name: 'Test District', km: (a, b) => { asked.push([a.id, b.id]); return answers[asked.length - 1]; } };
  const p = prepareAudit({ stops, downtime: [], days: [] }, { installer: WHO, mode: 'land', road });
  const gaps = p.days[0].gaps;
  assert.deepEqual(asked, [[`${D}-0`, `${D}-1`], [`${D}-1`, `${D}-2`], [`${D}-2`, `${D}-3`]]);
  assert.deepEqual(gaps.map(g => g.byRoad), [true, true, false]);
  assert.deepEqual(gaps.map(g => Math.round(g.km * 100) / 100), [0.35, 1.5, 0.3]);
  assert.deepEqual(gaps.map(g => Math.round(g.kmStraight * 100) / 100), [0.3, 0.3, 0.3]);
  assert.deepEqual(gaps.map(g => g.kind), [1, 3, 1], 'the 1.5 km drive is a "1 to 2 km" gap, not a "60 m to 0.5 km" one');
  assert.deepEqual(p.distance, { road: 2, straight: 1, map: 'Test District' });
});

test('without a road map every gap is a straight line, and a bad answer from one is ignored', () => {
  const stops = stopsOn(D, ['10:00', '10:10', '10:20', '10:30'], { km: 0.3 });
  const plain = prepareAudit({ stops, downtime: [], days: [] }, { installer: WHO, mode: 'land' });
  assert.deepEqual(plain.days[0].gaps.map(g => g.byRoad), [false, false, false]);
  assert.deepEqual(plain.distance, { road: 0, straight: 3, map: '' });
  const answers = [NaN, -1, Infinity];
  const bad = prepareAudit({ stops, downtime: [], days: [] },
    { installer: WHO, mode: 'land', road: { name: 'X', km: () => answers.shift() } });
  assert.deepEqual(bad.days[0].gaps.map(g => g.byRoad), [false, false, false]);
  const thrown = prepareAudit({ stops, downtime: [], days: [] },
    { installer: WHO, mode: 'land', road: { name: 'X', km: () => { throw new Error('corrupt pack'); } } });
  assert.deepEqual(thrown.distance, { road: 0, straight: 3, map: 'X' });
});

test('a gap beside a log with no pin is never asked of the road map', () => {
  const stops = stopsOn(D, ['10:00', '10:10', '10:20']);
  stops[1].lat = ''; stops[1].lng = '';
  let asked = 0;
  const p = prepareAudit({ stops, downtime: [], days: [] }, { installer: WHO, mode: 'land', road: { name: 'X', km: () => { asked++; return 1; } } });
  assert.equal(asked, 0);
  assert.deepEqual(p.days[0].gaps.map(g => [g.km, g.byRoad, g.kind]), [[null, false, -1], [null, false, -1]]);
  assert.deepEqual(p.distance, { road: 0, straight: 0, map: 'X' });
});

test('the pace card\'s distance follows the gaps', () => {
  const stops = stopsOn(D, ['10:00', '10:10', '10:20'], { km: 0.3 });
  const p = prepareAudit({ stops, downtime: [], days: [] }, { installer: WHO, mode: 'land', road: { name: 'X', km: () => 2 } });
  assert.equal(dayDetail(p, D).pace.km, 4);
});
