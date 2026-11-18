import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usualStartClock, dayEndEstimate, flatOutPerDay } from '../js/route-constraints.js';
import * as conf from '../js/config.js';

const stop = (eta, onSite = 10) => ({ scheduledEta: eta, scheduledOnSiteMin: onSite });
const BREAKS = [{ at:'10:00', min:15 }, { at:'12:00', min:30 }, { at:'14:00', min:15 }];
// Ten stops whose earliest ETA is 09:30 and whose latest departure is 11:30: 120 minutes of work.
const tenStopsOver120 = () => [stop('09:30'), ...Array(8).fill(stop('10:00')), stop('11:20')];

test('the new constants are exactly the agreed values', () => {
  assert.equal(conf.ROUTE_USUAL_START, '09:30');
  assert.deepEqual(conf.ROUTE_BREAKS, BREAKS);
  assert.equal(conf.ROUTE_FLAT_OUT_END, '15:30');
});

test('the usual start is the usual first log less one job', () => {
  assert.equal(usualStartClock(597, 12, '09:30'), '09:45');
});
test('no measurement, or a nonsense one, is the fallback', () => {
  for(const v of ['', null, undefined, NaN, 0, 120, 900]) assert.equal(usualStartClock(v, 12, '09:30'), '09:30');
});
test('the 05:00 and 14:00 bounds are inclusive and apply to the measured log', () => {
  assert.equal(usualStartClock(300, 0, '09:30'), '05:00');
  assert.equal(usualStartClock(840, 0, '09:30'), '14:00');
  assert.equal(usualStartClock(299, 0, '09:30'), '09:30');
  assert.equal(usualStartClock(841, 0, '09:30'), '09:30');
  // The bound is on the measurement, not on the clock after subtracting a job.
  assert.equal(usualStartClock(305, 12, '09:30'), '04:53');
});
test('a missing or non-finite on-site time subtracts nothing', () => {
  for(const v of [undefined, null, NaN, 'abc']) assert.equal(usualStartClock(597, v, '09:30'), '09:57');
});

test('a full day ends after its work, its breaks and its delays', () => {
  // 09:30 first arrival, last stop arrives 14:40 and takes 10 → work ends 14:50.
  const day = [stop('09:30'), ...Array(23).fill(stop('11:00')), stop('14:40')];
  const e = dayEndEstimate(day, { delayPerStopMin: 2, breaks: BREAKS });
  assert.deepEqual([e.startMin, e.workEndMin, e.delayMin, e.breakMin, e.endMin],
    [570, 890, 50, 60, 1000]);                         // 16:40
});
test('a break already past when the day starts is not counted', () => {
  const e = dayEndEstimate([stop('12:30'), stop('13:00')], { delayPerStopMin: 0, breaks: BREAKS });
  assert.equal(e.breakMin, 0);                         // ends 13:10, before the 14:00 break
});
test('a break the delays push the day into is counted', () => {
  // Work ends 13:55, just short of the 14:00 break; ten stops at 2 min of delay push it past.
  const day = [stop('13:00'), ...Array(8).fill(stop('13:30')), stop('13:45')];
  assert.equal(dayEndEstimate(day, { delayPerStopMin: 0, breaks: BREAKS }).breakMin, 0);
  const e = dayEndEstimate(day, { delayPerStopMin: 2, breaks: BREAKS });
  assert.deepEqual([e.workEndMin, e.delayMin, e.breakMin, e.endMin], [835, 20, 15, 870]);
});
test('an evening re-plan takes no breaks at all', () => {
  const day = [stop('17:14'), stop('19:00'), stop('21:00'), stop('22:26')];
  const e = dayEndEstimate(day, { delayPerStopMin: 3, breaks: BREAKS });
  assert.equal(e.breakMin, 0);
});
test('the first log of the day is the start once there is one', () => {
  assert.equal(dayEndEstimate([stop('11:00')], { breaks: BREAKS, startedMin: 552 }).startMin, 552);
});
test('startedMin replaces only the start: breaks still read the earliest ETA', () => {
  // The stops still to do begin at 11:00, so the 10:00 break is past even though the day started 09:12.
  const e = dayEndEstimate([stop('11:00')], { breaks: BREAKS, startedMin: 552 });
  assert.equal(e.breakMin, 0);
  assert.equal(e.endMin, 670);
});
test('a stop with no on-site time uses the fallback, and a blank delay or missing breaks are zero', () => {
  const e = dayEndEstimate([{ scheduledEta:'09:00' }], { fallbackOnSiteMin: 12, delayPerStopMin: '' });
  assert.deepEqual([e.workEndMin, e.delayMin, e.breakMin, e.endMin], [552, 0, 0, 552]);
  assert.equal(dayEndEstimate([stop('09:00')], { delayPerStopMin: NaN }).delayMin, 0);
});
test('no ETAs, no estimate', () => {
  assert.equal(dayEndEstimate([{ id:'a' }], { breaks: BREAKS }), null);
  assert.equal(dayEndEstimate([], { breaks: BREAKS }), null);
});

test('flat out is how many stops fit between the start and the cut-off', () => {
  // Two days of 10 stops, each spanning 120 min of work → 12 min a stop.
  // 09:30 → 15:30 is 360 min, less 60 of breaks = 300, over (12 + 3) = 20.
  const days = [tenStopsOver120(), tenStopsOver120()];
  const f = flatOutPerDay(days, { startMin: 570, endMin: 930, delayPerStopMin: 3, breaks: BREAKS });
  assert.equal(f.perDay, 20);
  assert.equal(f.workPerStopMin, 12);
});
test('a late start loses the breaks it starts after as well as the time', () => {
  // 13:00 → 15:30 is 150 min; only the 14:00 break lies ahead → 135 / 12 = 11.
  const f = flatOutPerDay([tenStopsOver120()], { startMin: 780, endMin: 930, delayPerStopMin: 0, breaks: BREAKS });
  assert.equal(f.perDay, 11);
});
test('days with a single ETA do not count towards the per-stop work', () => {
  const f = flatOutPerDay([tenStopsOver120(), [stop('09:30', 90)]], { startMin: 570, endMin: 930, delayPerStopMin: 3, breaks: BREAKS });
  assert.equal(f.workPerStopMin, 12);
});
test('nothing optimized, nothing to say', () => {
  assert.equal(flatOutPerDay([[{ id:'a' }]], { startMin:570, endMin:930, breaks:BREAKS }), null);
});

test('nothing that sizes a day reads the day-end or flat-out helpers', () => {
  const names = ['flatOutPerDay', 'dayEndEstimate', 'ROUTE_FLAT_OUT_END', 'ROUTE_BREAKS'];
  const whole = f => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');
  for(const f of ['route.js', 'route-today.js']){
    for(const n of names) assert.equal(whole(f).includes(n), false, `${f} mentions ${n}`);
  }
  const src = whole('route-constraints.js');
  const fnText = name => {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0, i = open;
    for(; i < src.length; i++){
      if(src[i] === '{') depth++;
      else if(src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  };
  for(const fn of ['scheduleRouteConstraints', 'simulateDay', 'placeAppointments']){
    const text = fnText(fn);
    for(const n of names) assert.equal(text.includes(n), false, `${fn} mentions ${n}`);
  }
});
