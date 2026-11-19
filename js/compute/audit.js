// ── The audit's numbers ──────────────────────────────────────────────────────
// Every figure on the Audits pages (audits.html for the office, my-audit.html for
// the installer) is worked out here, in the browser, from ONE spine read
// (`?action=audit&installer=`): that installer's printable logs, their Downtime
// rows and their Days start/end times, for all dates. Pure and DOM-free, so
// `node --test` covers it (tests/audit-compute.test.mjs).
//
// The method, in the order the code runs it:
//   1. Logs are grouped by Toronto calendar day and sorted by time.
//   2. A gap is the time from one log to the next on the same day, with the
//      straight-line distance between the two pins. Seven kinds by distance.
//   3. The usual time for a kind is the median gap of that kind over EVERY day in
//      the work mode, whatever range the page is showing. A short range or a
//      single day then still has a stable "usual".
//   4. A gap 10+ minutes over the usual time for its kind is a pause; the excess is
//      its length. Logged delays whose note names that gap come off it.
//   5. What is left is unlogged pause time. It cannot tell a break from an
//      unlogged delay, and nothing here pretends it can.
//
// Easy to get wrong:
//   • Land or boat comes from the DATE (workTypeOn), never from a row's workType
//     tag. Downtime rows are never filtered by mode at all: a gap delay is written
//     with a blank workType, which reads as boat, so a mode filter would drop every
//     logged delay from a land audit. The row's key finds its gap.
//   • pct() is the value at floor(n × p) of the sorted list. It is deliberately NOT
//     the spine's dwellMedian: the page has to reproduce a report that was built
//     with this definition, and the spine's stored figure uses a different window.
//   • A timestamp can have a one-digit hour ("2026-09-01 9:05:00"). Parse it; never
//     slice or compare it as text.
import { gapNoteTimes } from './gaps.js';
import { CAT_LABEL } from './categories.js';
// workTypeOn joined installer-lifetime.js on 2026-10-14. That file is in the
// service worker's shell, so a phone can hold an older copy of it beside a new
// copy of this file: reach it through the namespace and check it is there.
import * as lifetime from './installer-lifetime.js';

export const AUDIT = {
  SHIFT_START_MIN: 450,        // 07:30, the owner's rule for every installer
  DEFAULT_END_MIN: 960,        // 16:00, used when the day was never closed out
  MIN_ORDERS: 8,               // a day needs this many orders to enter the statistics
  PAUSE_OVER_MIN: 10,          // a gap this far over its usual time is a pause
  FLAG_MIN: 45,                // an unlogged pause this long is a "long gap"
  BREAK_ALLOWANCE_MIN: 60,     // two 15-minute breaks and a 30-minute lunch
  BASELINE_DAYS: 30,           // the "30 worked days before" comparison
  MIN_KIND_GAPS: 5,            // fewer gaps of a kind than this: use the all-gap median
  KIND_KM: [0.06, 0.5, 1, 2, 5, 10, Infinity],
  KIND_LABELS: ['Next door (under 60 m)', '60 m to 0.5 km', '0.5 to 1 km', '1 to 2 km',
    '2 to 5 km', '5 to 10 km', 'Over 10 km'],
  PAUSE_BINS: [[0, 15], [15, 30], [30, 45], [45, 60], [60, 75], [75, 90], [90, 105],
    [105, 120], [120, 150], [150, Infinity]],
};

const PRINTABLE = { INSTALLED: 1, UTI: 1, VISITED: 1, UNACCOUNTED: 1 };
const NOT_DEDUCTED = { BREAK: 1, LUNCH: 1, MISC_TRAVEL: 1, TRAVEL_TIME: 1 };
const BREAKS = { BREAK: 1, LUNCH: 1 };
const TRAVEL = { MISC_TRAVEL: 1, TRAVEL_TIME: 1 };

/** The value at floor(n × p) of the sorted list; null when the list is empty. */
export function pct(list, p){
  const s = (list || []).slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
}
export function mean(list){
  return list && list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}
/** Which of the seven distance kinds a gap of `km` is; -1 with no distance. */
export function kindOf(km){
  return km == null ? -1 : AUDIT.KIND_KM.findIndex(b => km < b);
}

const dateOf = ts => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts == null ? '' : ts)); return m ? m[1] : ''; };
// Minutes after midnight, the seconds as a fraction; null with no clock.
const minOf = ts => {
  const m = /[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(ts == null ? '' : ts));
  return m ? Number(m[1]) * 60 + Number(m[2]) + (Number(m[3]) || 0) / 60 : null;
};
const hhmmMin = s => { const m = /(\d{1,2}):(\d{2})/.exec(String(s == null ? '' : s)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const pad = n => String(n).padStart(2, '0');
const clock = min => pad(Math.floor(min / 60)) + ':' + pad(Math.floor(min % 60));
const hasPin = (lat, lng) => lat !== '' && lat != null && lng !== '' && lng != null
  && isFinite(Number(lat)) && isFinite(Number(lng)) && Number(lat) !== 0;
const R = 6371000, rad = d => d * Math.PI / 180;
function km(a, b){
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) / 1000;
}
function modeOf(date, installer){
  return typeof lifetime.workTypeOn === 'function' ? lifetime.workTypeOn(date, installer) : 'land';
}
const emptyLog = () => ({ before: 0, between: 0, after: 0, untimed: 0, total: 0,
  dispatchBefore: 0, otherBefore: 0, breaks: 0, travel: 0 });

/** raw = the `audit` read ({ stops, downtime, days }); mode = 'land' | 'boat' | 'all'.
 *  Returns every day in the mode, oldest first, with its gaps, pauses and delays. */
export function prepareAudit(raw, { installer = '', mode = 'land' } = {}){
  const src = raw || {};
  const inMode = date => (mode !== 'land' && mode !== 'boat') || modeOf(date, installer) === mode;

  // 1. Logs by day.
  const byDay = new Map();
  const status = { installed: 0, uti: 0, other: 0 };
  let orders = 0, unpinned = 0, skippedOtherMode = 0;
  for(const s of src.stops || []){
    const st = String(s.status == null ? '' : s.status).toUpperCase();
    if(!PRINTABLE[st]) continue;
    const date = dateOf(s.timestamp), min = minOf(s.timestamp);
    if(!date || min == null) continue;
    if(!inMode(date)){ skippedOtherMode++; continue; }
    const pin = hasPin(s.lat, s.lng);
    orders++;
    status[st === 'INSTALLED' ? 'installed' : st === 'UTI' ? 'uti' : 'other']++;
    if(!pin) unpinned++;
    if(!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push({ id: s.id, min, clock: clock(min),
      workOrderId: s.workOrderId == null ? '' : String(s.workOrderId), status: st,
      address: s.address == null ? '' : String(s.address),
      lat: pin ? Number(s.lat) : null, lng: pin ? Number(s.lng) : null, pin });
  }
  for(const logs of byDay.values()) logs.sort((a, b) => a.min - b.min);

  // 2. Logged delays, by where in the day they fall. A row on a date with no logs
  //    in the mode has no day to belong to and is skipped.
  const dayLog = new Map(), dayDelays = new Map(), inGap = new Map();
  for(const r of src.downtime || []){
    const date = dateOf(r.timestamp), logs = byDay.get(date);
    if(!logs) continue;
    const minutes = Number(r.minutes) || 0;
    if(!(minutes > 0)) continue;
    const category = String(r.category == null ? '' : r.category).trim().toUpperCase() || 'OTHER';
    const first = logs[0].min, last = logs[logs.length - 1].min;
    const note = gapNoteTimes(r.note);
    const fromMin = note ? hhmmMin(note[1]) : null, toMin = note ? hhmmMin(note[2]) : null;
    const where = !note ? 'untimed'
      : toMin <= Math.floor(first) ? 'before'
      : fromMin >= Math.floor(last) ? 'after' : 'between';
    if(!dayLog.has(date)){ dayLog.set(date, emptyLog()); dayDelays.set(date, []); }
    const log = dayLog.get(date);
    if(BREAKS[category]){ log.breaks += minutes; continue; }
    if(TRAVEL[category]){ log.travel += minutes; continue; }
    log[where] += minutes; log.total += minutes;
    const driveToFirst = category === 'DISPATCH' && where === 'before';
    if(driveToFirst) log.dispatchBefore += minutes;
    if(where === 'between' && !NOT_DEDUCTED[category]){
      const key = date + '|' + fromMin + '|' + toMin;
      inGap.set(key, (inGap.get(key) || 0) + minutes);
    }
    dayDelays.get(date).push({ category, label: CAT_LABEL[category] || category, minutes, where,
      fromMin, toMin, driveToFirst });
  }

  // 3. Gaps, then the usual time for each kind over every day in the mode.
  const allGaps = [];
  const dayGaps = new Map();
  for(const [date, logs] of byDay){
    const gaps = [];
    for(let i = 0; i + 1 < logs.length; i++){
      const a = logs[i], b = logs[i + 1];
      const dist = a.pin && b.pin ? km(a, b) : null;
      gaps.push({ i, atMin: a.min, min: b.min - a.min, km: dist, kind: kindOf(dist),
        loggedMin: inGap.get(date + '|' + Math.floor(a.min) + '|' + Math.floor(b.min)) || 0 });
    }
    dayGaps.set(date, gaps);
    allGaps.push(...gaps);
  }
  const usualAny = pct(allGaps.map(g => g.min), .5);
  const kindCounts = AUDIT.KIND_KM.map((_, k) => allGaps.filter(g => g.kind === k).length);
  const usual = AUDIT.KIND_KM.map((_, k) => kindCounts[k] >= AUDIT.MIN_KIND_GAPS
    ? pct(allGaps.filter(g => g.kind === k).map(g => g.min), .5) : usualAny);

  // 4. Each day's pauses and totals.
  const closeouts = new Map();
  for(const d of src.days || []) closeouts.set(dateOf(d.date), hhmmMin(d.returned));
  const days = [];
  for(const [date, logs] of byDay){
    const gaps = dayGaps.get(date);
    let workMin = 0, pauseAllMin = 0, pauseUnMin = 0, pauses = 0, longestMin = 0, longestAtMin = null, flags = 0;
    for(const g of gaps){
      g.usual = g.kind < 0 ? usualAny : usual[g.kind];
      g.over = g.min - g.usual;
      g.isPause = g.over >= AUDIT.PAUSE_OVER_MIN;
      g.unloggedMin = g.isPause ? Math.max(0, g.over - g.loggedMin) : 0;
      g.flagged = g.unloggedMin >= AUDIT.FLAG_MIN;
      if(!g.isPause){ workMin += g.min; continue; }
      workMin += g.usual; pauses++; pauseAllMin += g.over; pauseUnMin += g.unloggedMin;
      if(g.flagged) flags++;
      if(g.unloggedMin > longestMin){ longestMin = g.unloggedMin; longestAtMin = g.atMin; }
    }
    const log = dayLog.get(date) || emptyLog();
    log.otherBefore = log.before - log.dispatchBefore;
    const delays = (dayDelays.get(date) || []).slice().sort((a, b) =>
      (a.fromMin == null ? Infinity : a.fromMin) - (b.fromMin == null ? Infinity : b.fromMin));
    const firstMin = logs[0].min, lastMin = logs[logs.length - 1].min;
    const startMin = Math.min(AUDIT.SHIFT_START_MIN, firstMin);
    const returned = closeouts.get(date);
    const closed = returned != null;
    let endMin = closed ? returned : AUDIT.DEFAULT_END_MIN;
    let endSource = closed ? 'closeout' : 'default', pastEnd = false;
    // The owner's rule: a last meter logged after the set end time moves the end
    // of the day out to that meter, and close-out and drive home then shows 0.
    if(lastMin > endMin){ endMin = lastMin; endSource = 'lastMeter'; pastEnd = true; }
    days.push({ date, workType: modeOf(date, installer), n: logs.length,
      qualifies: logs.length >= AUDIT.MIN_ORDERS,
      startMin, endMin, endSource, closed, pastEnd, firstMin, lastMin, spanMin: lastMin - firstMin,
      logs, gaps, workMin, pauseAllMin, pauseUnMin, pauseLoggedMin: pauseAllMin - pauseUnMin,
      pauses, longestMin, longestAtMin, flags, log, delays,
      beforeUnloggedMin: firstMin - startMin - log.before, closeoutMin: endMin - lastMin });
  }
  days.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  return { installer, mode, days, usual, usualAny, kindCounts, gapsCount: allGaps.length,
    orders, status, unpinned, skippedOtherMode };
}

// ── Period statistics ────────────────────────────────────────────────────────
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
const col = (list, f) => list.map(f);

// The figures a comparison column shows, over a list of qualifying days. Averages
// for the shape of the day and the logged delay, medians for the pause figures:
// the same statistic the rest of the page uses for each measure.
function summarize(list){
  return {
    days: list.length,
    ordersAvg: mean(col(list, d => d.n)),
    firstAvg: mean(col(list, d => d.firstMin)),
    lastAvg: mean(col(list, d => d.lastMin)),
    loggedBeforeAvg: mean(col(list, d => d.log.before)),
    loggedBetweenAvg: mean(col(list, d => d.log.between)),
    pauseMedian: pct(col(list, d => d.pauseUnMin), .5),
    longestMedian: pct(col(list, d => d.longestMin).filter(v => v > 0), .5),
  };
}

/** Everything the period view shows, for the days from `from` to `to` (each
 *  'yyyy-MM-dd', or '' for open-ended). Per-day statistics use only the days with
 *  8+ orders; the day list, the order counts and the category totals use them all.
 *  The usual times are prep's, over every day in the mode, whatever the range. */
export function periodStats(prep, { from = '', to = '' } = {}){
  const inRange = prep.days.filter(d => (!from || d.date >= from) && (!to || d.date <= to));
  const full = inRange.filter(d => d.qualifies);
  const U = col(full, d => d.pauseUnMin), A = col(full, d => d.pauseAllMin);
  const N = col(full, d => d.n), F = col(full, d => d.firstMin), L = col(full, d => d.lastMin);

  const status = { installed: 0, uti: 0, other: 0 };
  let unpinned = 0;
  for(const d of inRange) for(const l of d.logs){
    status[l.status === 'INSTALLED' ? 'installed' : l.status === 'UTI' ? 'uti' : 'other']++;
    if(!l.pin) unpinned++;
  }
  const orders = sum(inRange, d => d.n);

  // Logged delays by category, over every day in range. Break, lunch and travel
  // rows never reach a day's `delays`, so they are not here either.
  const cats = new Map();
  for(const d of inRange) for(const x of d.delays){
    const c = cats.get(x.category) || { category: x.category, label: x.label, minutes: 0,
      before: 0, between: 0, after: 0, untimed: 0, dates: new Set() };
    c.minutes += x.minutes; c[x.where] += x.minutes; c.dates.add(d.date);
    cats.set(x.category, c);
  }
  const catTotal = sum([...cats.values()], c => c.minutes);
  const categories = [...cats.values()].sort((a, b) => b.minutes - a.minutes).map(c => ({
    category: c.category, label: c.label, minutes: c.minutes, share: c.minutes / catTotal,
    days: c.dates.size, before: c.before, between: c.between, after: c.after, untimed: c.untimed,
    beforeShare: c.before / c.minutes, betweenShare: c.between / c.minutes }));

  const byMonth = new Map();
  for(const d of full){
    const m = d.date.slice(0, 7);
    if(!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(d);
  }
  const perOrder = list => { const steps = sum(list, d => Math.max(0, d.n - 1)); return steps ? sum(list, d => d.spanMin) / steps : null; };
  const months = [...byMonth.keys()].sort().map(m => {
    const list = byMonth.get(m);
    return { month: m, days: list.length, ordersAvg: mean(col(list, d => d.n)),
      firstAvg: mean(col(list, d => d.firstMin)), lastAvg: mean(col(list, d => d.lastMin)),
      perOrder: perOrder(list), pauseMedian: pct(col(list, d => d.pauseUnMin), .5),
      loggedAvg: mean(col(list, d => d.log.total)) };
  });

  const loggedAvg = mean(col(full, d => d.log.total));
  const ordersAvg = mean(N), ordersBest = N.length ? Math.max(...N) : null;
  // Averages, so the parts add up to the day. A day's "before the first meter, not
  // logged" can be negative (more delay logged before the first meter than there
  // was time); the average is floored at zero for drawing.
  const bar = !full.length ? null : {
    startMin: mean(col(full, d => d.startMin)), endMin: mean(col(full, d => d.endMin)),
    firstMin: mean(F), lastMin: mean(L),
    segments: [
      { key: 'delayBefore', minutes: mean(col(full, d => d.log.otherBefore)) },
      { key: 'driveToFirst', minutes: mean(col(full, d => d.log.dispatchBefore)) },
      { key: 'beforeUnlogged', minutes: Math.max(0, mean(col(full, d => d.beforeUnloggedMin))) },
      { key: 'work', minutes: mean(col(full, d => d.workMin)) },
      { key: 'pauseUnlogged', minutes: mean(U) },
      { key: 'pauseLogged', minutes: mean(col(full, d => d.pauseLoggedMin)) },
      { key: 'closeout', minutes: mean(col(full, d => d.closeoutMin)) },
    ] };
  const pinnedGaps = prep.kindCounts.reduce((a, b) => a + b, 0);

  return {
    from, to, mode: prep.mode, orders, days: inRange.length, fullDays: full.length,
    status, unpinned, gapsCount: prep.gapsCount,
    nextDoorShare: pinnedGaps ? prep.kindCounts[0] / pinnedGaps : null,
    headline: { orders, days: inRange.length, ordersAvg, ordersBest,
      pauseMedian: pct(U, .5), loggedAvg,
      loggedBeforeShare: catTotal ? sum(categories, c => c.before) / catTotal : null },
    bar,
    pause: {
      median: pct(U, .5), avg: mean(U), p25: pct(U, .25), p75: pct(U, .75), p10: pct(U, .1), p90: pct(U, .9),
      perDay: mean(col(full, d => d.pauses)),
      longestMedian: pct(col(full, d => d.longestMin).filter(v => v > 0), .5),
      longestAtMedian: pct(full.filter(d => d.longestAtMin != null).map(d => d.longestAtMin), .5),
      allMedian: pct(A, .5), allAvg: mean(A),
      bins: AUDIT.PAUSE_BINS.map(([lo, hi]) => ({ lo, hi, days: U.filter(u => u >= lo && u < hi).length })),
      under60: U.filter(u => u < AUDIT.BREAK_ALLOWANCE_MIN).length, over90: U.filter(u => u >= 90).length,
      flags: sum(full, d => d.flags), flagDays: full.filter(d => d.flags > 0).length },
    months, categories,
    loggedPerDay: {
      dispatchBefore: mean(col(full, d => d.log.dispatchBefore)),
      otherBefore: mean(col(full, d => d.log.otherBefore)),
      before: mean(col(full, d => d.log.before)), between: mean(col(full, d => d.log.between)),
      after: mean(col(full, d => d.log.after)), untimed: mean(col(full, d => d.log.untimed)),
      total: loggedAvg },
    output: {
      ordersAvg, ordersMedian: pct(N, .5), ordersP10: pct(N, .1), ordersP90: pct(N, .9), ordersBest,
      firstAvg: mean(F), firstMedian: pct(F, .5), firstP25: pct(F, .25), firstP75: pct(F, .75),
      lastAvg: mean(L), lastMedian: pct(L, .5),
      spanAvg: mean(col(full, d => d.spanMin)), workAvg: mean(col(full, d => d.workMin)),
      perOrder: perOrder(inRange) },      // every day in range, as the report it replaces had it
    usual: AUDIT.KIND_LABELS.map((label, k) => ({ label, median: prep.usual[k], count: prep.kindCounts[k] })),
    daily: inRange.map(d => ({ date: d.date, n: d.n, qualifies: d.qualifies, firstMin: d.firstMin,
      lastMin: d.lastMin, loggedBefore: d.log.before, loggedBetween: d.log.between,
      pauseUn: d.pauseUnMin, longest: d.longestMin, longestAt: d.longestAtMin, flags: d.flags,
      pastEnd: d.pastEnd, closed: d.closed })),
  };
}

// ── One day ──────────────────────────────────────────────────────────────────
/** One day with its neighbours and the two baselines it is compared with: the up
 *  to 30 most recent qualifying days strictly before it, and every qualifying day.
 *  Null when the date has no logs in the mode. */
// ── The pace on a day's route ────────────────────────────────────────────────
// "How on pace was this day?" The answer is an expected number of orders for the
// time the day actually had between its first and last meter, on the route that was
// actually logged, at the installer's own usual pace. Nothing else is compared.
//
//   own time   first-to-last-meter time, less delay logged against those gaps. A
//              logged delay excuses no more than its gap ran over, as in the pause rule.
//   usual      the same gaps, each at the usual time for its distance.
//   share      usual ÷ own time: how much of the day's time was at the usual pace.
//              The rest is breaks, lunch, unlogged delay and stops that ran long. A
//              typical full day has plenty of it; it is not a fault.
//   at pace    own time × the TYPICAL full day's share.
//   expected   1 + at pace ÷ this route's usual minutes per order.
//
// A spread-out route costs more usual minutes per order, so the same time expects
// fewer orders; a short day (a late first meter, an early last one) expects fewer
// too. The figure deliberately takes the first and last meter as given: when they
// were logged is shown elsewhere on the page and is not judged here.
//
// "Typical" is the middle full day (pct .5, the page's median) of every full day in
// the mode, like the usual times: not only the days before this one.
//
// THIS IS THE THIRD FORMULA; the first two were measured against one installer's
// real history and dropped. Don't go back to either.
//   1. A fixed budget (a typical day's route time, moved by the delay logged that
//      day against the average) missed the logged count badly on most days: days
//      differ far more in length than in logged delay.
//   2. Own time less a typical day's minutes over the usual pace, cut down in
//      proportion for a shorter day but never raised for a longer one, was biased:
//      half of all days are shorter than the middle one, so it expected too many
//      orders on average. A share of the time scales both ways and is not.
// Even so the figure is a yardstick. `typical.miss` (half the full days land within
// this many orders of their expected number) exists so the page can say how close it
// has been, instead of implying a precision it does not have.
function routeOf(day){
  const gaps = day.gaps;
  const usualMin = sum(gaps, g => g.usual);
  const loggedMin = sum(gaps, g => Math.min(g.loggedMin, Math.max(0, g.over)));
  const ownMin = day.spanMin - loggedMin;
  return { orders: day.n, gaps: gaps.length, usualMin, tookMin: day.spanMin, loggedMin, ownMin,
    share: ownMin > 0 ? usualMin / ownMin : null, perOrder: gaps.length ? usualMin / gaps.length : null,
    km: sum(gaps, g => g.km == null ? 0 : g.km) };
}
function expectedOn(r, share){
  const atPaceMin = r.ownMin * share;
  const expected = Math.max(1, Math.round(1 + atPaceMin / r.perOrder));
  // paceMin: minutes of usual-pace work the day is short of (+) or ahead of (−) its expected number
  return { atPaceMin, expected, diff: r.orders - expected, paceMin: atPaceMin - r.usualMin };
}
function dayPace(prep, day){
  const r = routeOf(day);
  const full = prep.days.filter(d => d.qualifies).map(routeOf).filter(x => x.share != null);
  let typical = null;
  if(full.length){
    typical = { days: full.length, perOrder: pct(full.map(x => x.perOrder), .5),
      km: pct(full.map(x => x.km), .5), routeMin: pct(full.map(x => x.usualMin), .5),
      ownMin: pct(full.map(x => x.ownMin), .5), share: pct(full.map(x => x.share), .5),
      loggedMin: mean(full.map(x => x.loggedMin)) };
    typical.miss = pct(full.map(x => Math.abs(expectedOn(x, typical.share).diff)), .5);
  }
  const none = { atPaceMin: null, expected: null, diff: null, paceMin: null };
  return { ...r, typical, ...(typical && r.gaps && r.perOrder > 0 ? expectedOn(r, typical.share) : none) };
}

export function dayDetail(prep, date){
  const i = prep.days.findIndex(d => d.date === date);
  if(i < 0) return null;
  const full = prep.days.filter(d => d.qualifies);
  return {
    day: prep.days[i],
    pace: dayPace(prep, prep.days[i]),
    prevDate: i > 0 ? prep.days[i - 1].date : null,
    nextDate: i + 1 < prep.days.length ? prep.days[i + 1].date : null,
    baselines: {
      last30: summarize(full.filter(d => d.date < date).slice(-AUDIT.BASELINE_DAYS)),
      all: summarize(full),
    },
  };
}

// ── The day's drive log (office view only) ───────────────────────────────────
/** Totals over the rows of the `driveTracks` read for one day; null with no legs.
 *  distanceM is metres, driveMin minutes, maxSpeed metres per second. */
export function driveStats(legs){
  if(!legs || !legs.length) return null;
  const km = sum(legs, l => Number(l.distanceM) || 0) / 1000;
  const driveMin = sum(legs, l => Number(l.driveMin) || 0);
  return { legs: legs.length, km, driveMin,
    avgKmh: driveMin > 0 ? km / (driveMin / 60) : null,
    topKmh: Math.max(...legs.map(l => Number(l.maxSpeed) || 0)) * 3.6,
    gaps: sum(legs, l => Array.isArray(l.gaps) ? l.gaps.length : 0) };
}
