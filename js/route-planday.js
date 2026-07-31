// ── The plan day (which day the route being built is FOR) ───────────────────
// The phone used to hardwire the route's start date to `nextWeekday(localDate())`
// — a name that reads like "tomorrow" but is only a weekend clamp, so on any
// weekday it returned TODAY. An installer planning at 5pm on a day they never
// worked got a route dated today, with every order frozen into a day that was
// already over, and an appointment booked for tomorrow pushed out to Day 2
// (route-constraints.js maps an appointment's date to a day index relative to the
// start date, so a start date of today puts tomorrow one day out by construction).
//
// The calendar date is load-bearing in exactly one place: appointments and locks.
// "Tuesday 10am" is a promise to a customer and cannot be said as a day index.
// Day chunking, the meters/day target, ETAs and the today anchor are all purely
// relative and only ever needed a day NUMBER. So the fix is not to strip dates
// out of the worklist — it is to let the phone say which day it is planning.
//
// These helpers are that decision, kept pure: no DOM, no storage, no clock of
// their own (the caller passes `today`/`nowMin`), unit-tested in
// tests/route-planday.test.mjs. worklist.js owns the side-effecting half —
// reading the store, tallying the day, and re-keying the anchor on the result.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// UTC-based like route-constraints.js dateAtUtc, deliberately: a plan date is a
// calendar label, never an instant, so keeping the arithmetic off local time
// means no DST edge can shift a day.
function dateAtUtc(text){
  if(!DATE_RE.test(String(text || ''))) return null;
  const [y, m, d] = String(text).split('-').map(Number);
  const out = new Date(Date.UTC(y, m - 1, d));
  return out.getUTCFullYear() === y && out.getUTCMonth() === m - 1 && out.getUTCDate() === d ? out : null;
}
function dateText(d){ return d.toISOString().slice(0, 10); }
function isWeekendDate(d){ return d.getUTCDay() === 0 || d.getUTCDay() === 6; }

/** Is this a valid `yyyy-MM-dd` that falls on a weekday? */
export function isWorkday(text){
  const d = dateAtUtc(text);
  return Boolean(d) && !isWeekendDate(d);
}

/** The given date if it is a weekday, else the next Monday. A WEEKEND CLAMP —
 *  it does not advance a weekday by a single day. This was `nextWeekday` in
 *  worklist.js, and the misreading of that name is the whole reason routes were
 *  stuck on today; the name now says what it does. */
export function weekdayOnOrAfter(date){
  const d = dateAtUtc(date);
  if(!d) return '';
  while(isWeekendDate(d)) d.setUTCDate(d.getUTCDate() + 1);
  return dateText(d);
}

/** The next WORKING day strictly after `date` — advance one calendar day, then
 *  skip any weekend. Friday → Monday, Saturday → Monday. The genuinely-tomorrow
 *  helper the codebase never had. */
export function nextWorkday(date){
  const d = dateAtUtc(date);
  if(!d) return '';
  d.setUTCDate(d.getUTCDate() + 1);
  while(isWeekendDate(d)) d.setUTCDate(d.getUTCDate() + 1);
  return dateText(d);
}

/** Which day is the route being planned for?
 *
 *  `{ today, nowMin, finishByMin, dayClosed, dayStarted, override }` — the caller
 *  supplies every reading, so this stays pure. `dayClosed`/`dayStarted` are about
 *  TODAY (is the day the installer is standing in spent?), never about the day
 *  being planned; conflating the two is the easiest mistake here.
 *
 *  Returns `{ date, source }`:
 *   - `override` — the installer picked a day by hand. Honoured only while it is a
 *     weekday AND has not passed; a stale override is DROPPED rather than carried,
 *     or Wednesday's phone keeps planning Monday forever.
 *   - `rolled`  — today is spent (closed out, or nothing logged and the finish-by
 *     clock has gone by), so the plan is for the next working day. A day that is
 *     under way never rolls, however late it is: the crew is still driving it.
 *   - `today`   — the previous behaviour, unchanged, weekend clamp included.
 */
export function resolvePlanDay(opts){
  const o = opts || {};
  const today = String(o.today || '');
  const base = weekdayOnOrAfter(today) || today;

  const override = String(o.override || '');
  // Deliberate and therefore never clamped: if the picked day conflicts with an
  // appointment, that is surfaced as the "dated before the route starts" warning
  // rather than silently overruling the installer.
  if(isWorkday(override) && override >= today) return { date: override, source: 'override' };

  // `null`/absent is an UNKNOWN clock, and must not coerce to Number(null) === 0 —
  // that reads as "midnight, past a finish-by of midnight" and rolls every call.
  // Same trap route-constraints.js documents for opts.day1Count, where 0 is a real
  // count (a locked day whose work is finished) and only null means "unset".
  const min = v => (v == null || v === '') ? null : (isFinite(Number(v)) ? Number(v) : null);
  const nowMin = min(o.nowMin), finishByMin = min(o.finishByMin);
  const pastFinish = nowMin != null && finishByMin != null && nowMin >= finishByMin;
  const answer = (o.dayClosed || (!o.dayStarted && pastFinish))
    ? { date: nextWorkday(today), source: 'rolled' }
    : { date: base, source: 'today' };

  // The roll must never jump OVER a live appointment. scheduleRouteConstraints
  // refuses to place an order dated before the route starts — and it refuses by
  // throwing, which costs the whole route rather than that one order, so a plan
  // day past a still-pending commitment breaks everything. Clamp back to it.
  const soonest = String(o.soonestAppointment || '');
  if(isWorkday(soonest) && soonest >= today && soonest < answer.date)
    return { date: soonest, source: 'appointment' };
  return answer;
}

/** The earliest appointment still worth planning around: pending orders only,
 *  dated on or after today. A missed one (dated in the past) is deliberately not
 *  returned — it cannot be honoured by any plan day, so letting it clamp would
 *  drag the route onto a dead date. */
export function soonestAppointment(items, today){
  const live = (items || [])
    .filter(x => x && x.wlStatus !== 'done' && !isSetAside(x))
    .map(x => String((x && x.appointmentDate) || ''))
    .filter(d => isWorkday(d) && d >= String(today || ''));
  return live.length ? live.sort()[0] : '';
}

/** Pending orders whose position lock is pinned to a day before the one being
 *  planned. A lock is a routing convenience — "hold this at slot 3 that day" —
 *  and `toggleOrderLock` derives its date from the order's `scheduledDate`, so
 *  every lock is stamped with the plan day that was current when it was set.
 *  Move the plan day forward and those become unsatisfiable; the solver then
 *  throws on them and takes the entire route down with it. They are expired
 *  rather than honoured: the day they named has gone. */
export function staleLockIds(items, planDay){
  const day = String(planDay || '');
  return (items || [])
    .filter(x => x && x.wlStatus !== 'done' && !isSetAside(x))
    .filter(x => {
      const d = String(x.lockedDate || '');
      return DATE_RE.test(d) && d < day;
    })
    .map(x => String(x.id));
}

// A local copy of route-variants.js isIgnored — importing it would drag the
// constraint solver in behind it, and this module is deliberately dependency-free.
function isSetAside(x){
  const v = x && x.ignored;
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
}

/** Human label for the plan-date hint: "Tue · tomorrow", "today", "Thu · in 3 days".
 *  Counts CALENDAR days between the two dates, not workdays — "tomorrow" has to
 *  mean tomorrow even when tomorrow is a Saturday that clamps to Monday. */
export function planDayLabel(date, today){
  const a = dateAtUtc(today), b = dateAtUtc(date);
  if(!a || !b) return '';
  const days = Math.round((b - a) / 86400000);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][b.getUTCDay()];
  if(days === 0) return 'today';
  if(days === 1) return `${wd} · tomorrow`;
  if(days > 1) return `${wd} · in ${days} days`;
  return `${wd} · ${-days} day${days === -1 ? '' : 's'} ago`;
}
