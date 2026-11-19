// The audit's numbers (js/compute/audit.js), over made-up days where every answer
// can be worked out by hand. Nothing here is a real installer's data: the name is
// Pat Example and the days are built by the two helpers below. A real person's
// figures must never be committed (GitHub Pages publishes the whole tree).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT, pct, mean, kindOf, prepareAudit }
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
