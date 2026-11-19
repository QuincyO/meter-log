import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usualStartClock, dayEndEstimate, flatOutPerDay, breakMinutesLeft } from '../js/route-constraints.js';
import * as conf from '../js/config.js';

const stop = (eta, onSite = 10) => ({ scheduledEta: eta, scheduledOnSiteMin: onSite });
// Ten stops whose earliest ETA is 09:30 and whose latest departure is 11:30: 120 minutes of work.
const tenStopsOver120 = () => [stop('09:30'), ...Array(8).fill(stop('10:00')), stop('11:20')];
const days = [tenStopsOver120(), tenStopsOver120()];
// 25 stops, first arrival 09:30, last arrival 14:40 and 10 on site → work ends 14:50.
const fullDay = () => [stop('09:30'), ...Array(23).fill(stop('11:00')), stop('14:40')];
const lateStartDay = () => [stop('10:09'), stop('11:00'), stop('12:00')];

test('the new constants are exactly the agreed values', () => {
  assert.equal(conf.ROUTE_USUAL_START, '09:30');
  assert.equal(conf.ROUTE_BREAK_MIN, 60);
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
  const e = dayEndEstimate(fullDay(), { delayPerStopMin: 2, breakMin: 60 });
  assert.deepEqual([e.startMin, e.workEndMin, e.delayMin, e.breakMin, e.endMin],
    [570, 890, 50, 60, 1000]);                         // 16:40
});
test('a full day adds its whole break allowance, whenever the day starts', () => {
  assert.equal(dayEndEstimate(fullDay(), { delayPerStopMin: 2, breakMin: 60 }).endMin, 1000);
  // A day whose first stop is at 10:09 is no different: the 60 is somewhere in the day.
  assert.equal(dayEndEstimate(lateStartDay(), { breakMin: 60 }).breakMin, 60);
});
test('no break allowance given, none added', () => {
  const e = dayEndEstimate(fullDay(), { delayPerStopMin: 2 });
  assert.deepEqual([e.breakMin, e.endMin], [0, 940]);
  assert.equal(dayEndEstimate(fullDay(), { breakMin: '' }).breakMin, 0);
  assert.equal(dayEndEstimate(fullDay(), { breakMin: NaN }).breakMin, 0);
});
test('the first log of the day is the start once there is one', () => {
  assert.equal(dayEndEstimate([stop('11:00')], { breakMin: 60, startedMin: 552 }).startMin, 552);
});
test('startedMin replaces only the start, not the work end', () => {
  const e = dayEndEstimate([stop('11:00')], { breakMin: 0, startedMin: 552 });
  assert.equal(e.endMin, 670);
});
test('a stop with no on-site time uses the fallback, and a blank delay is zero', () => {
  const e = dayEndEstimate([{ scheduledEta:'09:00' }], { fallbackOnSiteMin: 12, delayPerStopMin: '' });
  assert.deepEqual([e.workEndMin, e.delayMin, e.breakMin, e.endMin], [552, 0, 0, 552]);
  assert.equal(dayEndEstimate([stop('09:00')], { delayPerStopMin: NaN }).delayMin, 0);
});
test('no ETAs, no estimate', () => {
  assert.equal(dayEndEstimate([{ id:'a' }], { breakMin: 60 }), null);
  assert.equal(dayEndEstimate([], { breakMin: 60 }), null);
});

test('a day not started has all its breaks left', () => { assert.equal(breakMinutesLeft(60, 0, 0, 25), 60); });
test('half the stops left is half the breaks left', () => { assert.equal(breakMinutesLeft(60, 0, 10, 10), 30); });
test('a logged lunch is taken off what is left', () => {
  assert.equal(breakMinutesLeft(60, 30, 2, 18), 30);    // 54 by share, 30 by what is unlogged
  assert.equal(breakMinutesLeft(60, 75, 2, 18), 0);     // logged more than the allowance
});
test('nothing left to do, no breaks left', () => { assert.equal(breakMinutesLeft(60, 0, 20, 0), 0); });
test('blank or non-finite break inputs count as 0, and the answer is whole minutes', () => {
  assert.equal(breakMinutesLeft(60, '', '', 10), 60);
  assert.equal(breakMinutesLeft(60, NaN, undefined, 10), 60);
  assert.equal(breakMinutesLeft(60, 0, 1, 2), 40);
  assert.equal(Number.isInteger(breakMinutesLeft(60, 0, 1, 3)), true);   // 45
  assert.equal(breakMinutesLeft(50, 0, 2, 1), 17);                        // 16.67 rounds up
});

test('flat out takes the whole allowance off the window', () => {
  // Two days of 10 stops, each spanning 120 min of work → 12 min a stop.
  // 09:30 → 15:30 is 360, less 60 = 300, over (12 + 3) = 20.
  const f = flatOutPerDay(days, { startMin: 570, endMin: 930, delayPerStopMin: 3, breakMin: 60 });
  assert.equal(f.perDay, 20);
  assert.equal(f.workPerStopMin, 12);
  // A 10:09 start loses only its 39 minutes: 321 − 60 = 261, over 15 = 17.
  assert.equal(flatOutPerDay(days, { startMin: 609, endMin: 930, delayPerStopMin: 3, breakMin: 60 }).perDay, 17);
});
test('flat out is never below 0', () => {
  assert.equal(flatOutPerDay(days, { startMin: 900, endMin: 930, delayPerStopMin: 3, breakMin: 60 }).perDay, 0);
});
test('days with a single ETA do not count towards the per-stop work', () => {
  const f = flatOutPerDay([tenStopsOver120(), [stop('09:30', 90)]], { startMin: 570, endMin: 930, delayPerStopMin: 3, breakMin: 60 });
  assert.equal(f.workPerStopMin, 12);
});
test('a stop with no on-site time on it uses the fallback, in the flat-out figure too', () => {
  const bare = () => [{ scheduledEta:'09:00' }, { scheduledEta:'10:00' }];
  assert.equal(flatOutPerDay([bare()], { startMin: 570, endMin: 930, breakMin: 0 }).workPerStopMin, 30);   // the last stop counted as zero work
  const f = flatOutPerDay([bare()], { startMin: 570, endMin: 930, breakMin: 0, fallbackOnSiteMin: 10 });
  assert.equal(f.workPerStopMin, 35);                  // 09:00 → 10:10 is 70 min over 2 stops
});
test('nothing optimized, nothing to say', () => {
  assert.equal(flatOutPerDay([[{ id:'a' }]], { startMin:570, endMin:930, breakMin:60 }), null);
});

test('nothing that sizes a day reads the day-end or flat-out helpers', () => {
  const names = ['flatOutPerDay', 'dayEndEstimate', 'breakMinutesLeft', 'usualStartClock', 'ROUTE_FLAT_OUT_END', 'ROUTE_BREAK_MIN', 'ROUTE_USUAL_START',
    'breakAllowance', 'pauseMinPerDay', 'wlPauseMinPerDay', 'breakMeasured'];
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

// ── a day whose ETAs cross midnight (field report 2026-11-18) ────────────────
// In the evening Day 1 is re-planned from "now", so its 'HH:MM' ETAs run 19:30 …
// 00:42 and wrap. Read as clocks, its earliest was 00:03 and its span 1440 minutes,
// which dragged the flat-out figure from 17 a day to 10.

const clockAt = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(Math.round(m) % 60).padStart(2, '0');
// `count` stops from `fromMin`, every `everyMin`, each `onSite` on site.
const runOf = (count, fromMin, everyMin, onSite) =>
  Array.from({ length: count }, (_, k) => stop(clockAt(fromMin + Math.round(everyMin * k)), onSite));
const eveningDay = () => runOf(25, 1170, 13, 13);          // 19:30 … 00:42
const morningDay = count => runOf(count, 609, 13.3, 13.3);  // 10:09, every 13.3

test('a day whose ETAs run past midnight is un-wrapped, not 24 hours long', () => {
  const day = eveningDay();
  assert.equal(day[0].scheduledEta, '19:30');
  assert.equal(day[24].scheduledEta, '00:42');
  const e = dayEndEstimate(day, { breakMin: 0 });
  // The last arrival is 00:42 next day = 1482, plus 13 on site.
  assert.deepEqual([e.startMin, e.workEndMin, e.endMin], [1170, 1495, 1495]);
});

test('a normal long day is not un-wrapped', () => {
  // 08:10 to 16:40 is 8.5 hours, under the 12 that marks a wrap.
  const e = dayEndEstimate([stop('08:10'), stop('11:30'), stop('16:40')], { breakMin: 0 });
  assert.deepEqual([e.startMin, e.workEndMin], [490, 1010]);
});

test('an evening Day 1 crossing midnight leaves the flat-out figure where the morning had it', () => {
  // 113 orders over five days (25, 25, 25, 25, 13), usual start 10:09, 1.5 delay.
  // 261 minutes of room (10:09 → 15:30 less 60) over about 13.3 + 1.5 a stop = 17.
  const o = { startMin: 609, endMin: 930, delayPerStopMin: 1.5, breakMin: 60 };
  const rest = [morningDay(25), morningDay(25), morningDay(25), morningDay(13)];
  assert.equal(flatOutPerDay([eveningDay(), ...rest], o).perDay, 17);
  assert.equal(flatOutPerDay([morningDay(25), ...rest], o).perDay, 17);
});

test('one wildly long day among five does not move the flat-out figure', () => {
  const o = { startMin: 570, endMin: 930, delayPerStopMin: 3, breakMin: 60 };
  const normal = flatOutPerDay([tenStopsOver120(), tenStopsOver120(), tenStopsOver120(),
    tenStopsOver120(), tenStopsOver120()], o);
  // Ten stops spread over ten hours: 60 minutes a stop on this one day.
  const odd = flatOutPerDay([tenStopsOver120(), tenStopsOver120(), tenStopsOver120(),
    tenStopsOver120(), [stop('08:00'), ...Array(8).fill(stop('12:00')), stop('17:50')]], o);
  assert.equal(odd.workPerStopMin, 12);
  assert.deepEqual([odd.perDay, odd.workPerStopMin], [normal.perDay, normal.workPerStopMin]);
});
