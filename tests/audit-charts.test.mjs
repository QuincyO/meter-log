// The audit's charts are plain HTML strings (js/audit-charts.js), so they print as
// drawn and can be checked here without a browser. Made-up days only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEGMENTS, fmtClock, fmtMin, fmtDate, fmtDur, dayBarHtml, pauseHistogramHtml,
  timelineHtml, legendHtml } from '../js/audit-charts.js';
import { AUDIT, prepareAudit, periodStats } from '../js/compute/audit.js';

const pad = n => String(n).padStart(2, '0');
function stopsOn(date, clocks){
  return clocks.map((c, i) => ({ id: `${date}-${i}`, timestamp: `${date} ${c}:00`, status: 'INSTALLED',
    workOrderId: String(900000 + i), address: `${i + 1} Main St`, lat: 44 + i * 0.00009, lng: -79 }));
}
const every = (first, count, step = 6) => Array.from({ length: count }, (_, i) => {
  const [h, m] = first.split(':').map(Number), t = h * 60 + m + i * step;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
});
const HISTORY = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']
  .flatMap(d => stopsOn(d, every('09:00', 9)));
const D = '2026-11-02';
const model = (stops, downtime = []) =>
  prepareAudit({ stops: [...HISTORY, ...stops], downtime, days: [] }, { installer: 'Pat Example', mode: 'land' });
const dayOf = (m, date = D) => m.days.find(d => d.date === date);
const widths = html => [...html.matchAll(/data-seg="(\w+)"[^>]*?style="width:([\d.]+)%/g)].map(m => [m[1], Number(m[2])]);
const total = html => widths(html).reduce((s, w) => s + w[1], 0);

test('fmtClock and fmtMin round and tolerate null', () => {
  assert.equal(fmtClock(605.4), '10:05');
  assert.equal(fmtClock(599.6), '10:00');       // never "09:60"
  assert.equal(fmtClock(450), '07:30');
  assert.equal(fmtClock(null), '—');
  assert.equal(fmtMin(69.6), '70');
  assert.equal(fmtMin(0), '0');
  assert.equal(fmtMin(null), '—');
  assert.equal(fmtMin(undefined), '—');
});

test('fmtDate names the weekday without leaning on the locale', () => {
  assert.equal(fmtDate('2026-11-16'), 'Mon Nov 16, 2026');
  assert.equal(fmtDate('2026-09-01'), 'Tue Sep 1, 2026');
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDur(91), '1 h 31 min');
  assert.equal(fmtDur(45.4), '45 min');
  assert.equal(fmtDur(null), '—');
});

test('the bar draws seven segments whose widths total 100%', () => {
  const m = model(stopsOn(D, [...every('09:00', 8), '11:00']),
    [{ timestamp: `${D} 12:00:00`, category: 'DISPATCH', minutes: 30, note: 'gap 07:30–08:00' },
     { timestamp: `${D} 12:00:00`, category: 'WAREHOUSE', minutes: 20, note: 'gap 09:42–11:00' }]);
  const html = dayBarHtml(periodStats(m, { from: '', to: '' }).bar);
  assert.deepEqual(widths(html).map(w => w[0]), SEGMENTS.map(s => s.key));
  assert.ok(Math.abs(total(html) - 100) < 0.05, `widths total ${total(html)}`);
  assert.match(html, /07:30/);
  assert.match(html, /16:00/);
});

test('a null bar draws nothing', () => assert.equal(dayBarHtml(null), ''));

test('the histogram draws one column per bin and marks the allowance', () => {
  const bins = AUDIT.PAUSE_BINS.map(([lo, hi], i) => ({ lo, hi, days: i === 2 ? 8 : i === 9 ? 2 : 0 }));
  const html = pauseHistogramHtml(bins, 60);
  assert.equal((html.match(/class="au-hcol/g) || []).length, 10);
  assert.equal((html.match(/au-hcol allow/g) || []).length, 1);
  assert.match(html, /au-hcol allow"[^>]*data-lo="60"/);
  assert.match(html, /150\+/);
  assert.match(html, /height:100%/);            // the tallest bin
  assert.match(html, /height:25%/);
  assert.equal(pauseHistogramHtml([], 60), '');
  assert.doesNotMatch(pauseHistogramHtml(bins.map(b => ({ ...b, days: 0 })), 60), /NaN/);
});

test('the timeline splits a long gap into work, logged delay and unlogged pause, in that order', () => {
  const m = model(stopsOn(D, ['10:00', '10:06', '11:06', '11:12']),
    [{ timestamp: `${D} 12:00:00`, category: 'WAREHOUSE', minutes: 20, note: 'gap 10:06–11:06' }]);
  const html = timelineHtml(dayOf(m));
  const gap1 = [...html.matchAll(/data-seg="(\w+)" data-gap="1"/g)].map(x => x[1]);
  assert.deepEqual(gap1, ['work', 'pauseLogged', 'pauseUnlogged']);
  assert.deepEqual([...html.matchAll(/data-seg="(\w+)" data-gap="0"/g)].map(x => x[1]), ['work']);
  assert.deepEqual(widths(html).map(w => w[0]),
    ['beforeUnlogged', 'work', 'work', 'pauseLogged', 'pauseUnlogged', 'work', 'closeout']);
  assert.ok(Math.abs(total(html) - 100) < 0.05, `widths total ${total(html)}`);
});

test('a flagged gap is marked and an unflagged one is not', () => {
  const html = timelineHtml(dayOf(model(stopsOn(D, ['10:00', '10:51', '11:41']))));
  assert.match(html, /class="au-blk flag" data-seg="pauseUnlogged" data-gap="0"/);
  assert.match(html, /class="au-blk" data-seg="pauseUnlogged" data-gap="1"/);
});

test('logged delays before the first meter are drawn before it, and never wider than the time there was', () => {
  const rows = (a, b) => [
    { timestamp: `${D} 12:00:00`, category: 'DISPATCH', minutes: a, note: 'gap 07:30–08:00' },
    { timestamp: `${D} 12:00:00`, category: 'NEXT_GEN', minutes: b, note: 'gap 08:00–09:00' }];
  const html = timelineHtml(dayOf(model(stopsOn(D, ['10:00', '10:06']), rows(30, 60))));
  assert.deepEqual(widths(html).map(w => w[0]).slice(0, 3), ['delayBefore', 'driveToFirst', 'beforeUnlogged']);
  // 300 minutes logged before a first meter 150 minutes into the day
  const over = timelineHtml(dayOf(model(stopsOn(D, ['10:00', '10:06']), rows(100, 200))));
  assert.deepEqual(widths(over).map(w => w[0]).slice(0, 2), ['delayBefore', 'driveToFirst']);
  assert.ok(Math.abs(total(over) - 100) < 0.05, `widths total ${total(over)}`);
});

test('a one-log day draws only the before-first-meter and close-out blocks', () => {
  const html = timelineHtml(dayOf(model(stopsOn(D, ['11:15']))));
  assert.deepEqual(widths(html).map(w => w[0]), ['beforeUnlogged', 'closeout']);
  assert.ok(Math.abs(total(html) - 100) < 0.05);
  assert.doesNotMatch(html, /NaN|data-gap/);
});

test('the legend lists the keys it is given, in drawing order', () => {
  const html = legendHtml(['closeout', 'work']);
  assert.ok(html.indexOf('Working') < html.indexOf('Close-out and drive home'));
  assert.doesNotMatch(html, /Unlogged pauses/);
  assert.equal(legendHtml().match(/<span /g).length, SEGMENTS.length);
});

test('labels are the owner\'s words and never say drive back', () => {
  const label = k => SEGMENTS.find(s => s.key === k).label;
  assert.match(label('driveToFirst'), /^Drive to the first order/);
  assert.equal(label('closeout'), 'Close-out and drive home');
  assert.equal(label('pauseUnlogged'), 'Unlogged pauses (unlogged breaks included)');
  assert.equal(label('pauseBreak'), 'Break or lunch, logged');
  assert.equal(label('beforeUnlogged'), 'Before the first meter, not logged');
  assert.doesNotMatch(JSON.stringify(SEGMENTS), /drive back|return to the yard/i);
});

// ── found by the whole-branch review ─────────────────────────────────────────

test('a clock mark near either end of the bar is anchored inside it', () => {
  // first meter five minutes into the day, last meter after the set end time
  const early = timelineHtml(dayOf(model(stopsOn(D, ['07:35', '07:41', '16:30']))));
  assert.match(early, /class="au-tick l"[^>]*>first meter 07:35</);
  assert.match(early, /class="au-tick r"[^>]*>last meter 16:30</);
  const mid = timelineHtml(dayOf(model(stopsOn(D, ['10:00', '10:06', '13:00']))));
  assert.match(mid, /class="au-tick"[^>]*>first meter 10:00</);
  assert.match(mid, /class="au-tick"[^>]*>last meter 13:00</);
});
