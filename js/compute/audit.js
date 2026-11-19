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
