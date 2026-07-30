// ── Real-data on-pace projection (drive mode + plan banner + tuning what-if) ──
// Reprojects the *actual remaining route* from real working data: travel and
// on-site time are separated (travel excluded from onsitePerStop; the pending
// route's real remaining travel is subtracted from the time left), and the count
// is capped at the stops left in the route. Pure and DOM-free — the caller
// (js/worklist.js paceContext) sources the real inputs (drive-recorder speed,
// worklist leg metres, observed cadence) with graceful fallbacks, so this stays
// uniform and unit-testable.
import { PRINTABLE } from './tally.js';
import { clockOf, hhmmMin, stamp } from '../time.js';

const WORK_MIN = 15 * 60 + 45;  // 3:45 PM — regular end of day
const OT_MIN2  = 16 * 60 + 45;  // 4:45 PM — overtime ceiling
const OT_TRIP  = 16 * 60;       // past 4:00 PM (with the day still open) opens OT

// The regular-working-hours horizon: 3:45 PM, escalating to 4:45 PM OT once it's
// past 4:00 PM and the day hasn't been closed out yet. Closing out the day drops
// the escalation (the day is done, so there's nothing left to project into OT).
export function workHorizon(nowMin, dayClosed){
  if(!dayClosed && nowMin > OT_TRIP) return { min: OT_MIN2, label: '4:45 OT' };
  return { min: WORK_MIN, label: '3:45' };
}

// Minutes-of-day → bare 12-hour clock label ("2:00", "3:45").
//
// **Only safe for the fixed HORIZONS** — WORK_MIN and OT_MIN2 above, and a
// caller-supplied finishByMin inside the working day. Those are constants that
// cannot leave the afternoon, so the missing am/pm reads correctly by context.
export function clockLabel(min){
  const h = ((Math.floor(min / 60) + 11) % 12) + 1;
  return h + ':' + String(min % 60).padStart(2, '0');
}

// Minutes-from-midnight → an UNAMBIGUOUS clock ("6:05 pm", "1:10 am").
//
// Anything DERIVED gets this one, never clockLabel. The route-finish clock is
// `now + travel + stops × on-site` — it has no ceiling, and on a day that fell
// behind it runs past noon, past knock-off, and past midnight. Rendered through
// clockLabel, a real 23:29 printed as "11:29" on a screen the crew was reading at
// 11:36 in the MORNING: a finish time that looked seven hours in the past. It was
// reported as the clock going backwards, and the rest of the card was right — the
// line was already amber, because routeFinishMin > horizonMin fired correctly.
// Only the text lied.
//
// Past 24 h a meridiem alone is not enough — "1:10 am" for a finish two days out is
// the same ambiguity in a new hat — so a day marker is appended there and only
// there. Every reading inside today, tonight included, is the plain meridiem clock.
export function finishLabel(min){
  if(min == null || !isFinite(min)) return null;
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const days = Math.floor(Math.round(min) / 1440);
  return clockLabel(t) + (t < 12 * 60 ? ' am' : ' pm') + (days > 0 ? ` +${days}d` : '');
}

// One horizon's projection: how many installs land before H, and how that lands
// against the two things worth being short of.
//
// `routeShort` is the headline and `targetShort` is the footnote, and they answer
// different questions:
//   routeShort  — projected installs vs the stops still on today's route.
//   targetShort — projected installs vs the installer's METERS/DAY TARGET.
//
// **`onPace` is the ROUTE**, because the target's job is upstream. The meters/day
// number is what SIZES the day — `dayCapacity(target, installedToday)` decides how
// many orders sit on Day 1 (js/route-today.js) — and once it has, the driver's
// question is "am I going to finish the route in front of me?".
//
// This was briefly the other way round, on the theory that Day 1 "moves underneath
// the answer" as it is re-sized to `target − installed`. It does not: Day 1 is
// `min(capacity + extend, |anchor.ids ∩ pending|)`, and a completed install drops
// BOTH terms by one, so the finished stop simply moves from `pendingCount` into
// `done` and their sum holds still all day. The two readings are in fact the same
// number whenever the list is long enough to fill the target —
// `targetShort = target − done − willDo = pendingCount − willDo = routeShort`. They
// diverge in exactly one case, a route SHORTER than the target, and there the
// target reading is the useless one: "16 short of 24" when there are four orders
// left in the world is not a pace the driver can do anything about.
//
// (The field report that prompted the detour — "it always says I'm on pace" — had a
// second and sufficient cause, fixed in the same commit: a phone the crew only
// drives by never invalidates the dayCache, so `done` was 0 all day. That fix is
// the load-bearing one and it stays. See AGENTS.md.)
//
// `target` absent/0 ⇒ `targetShort` is null and there is simply no footnote.
function paceFor(horizonMin, label, ctx){
  const { done, pendingCount, remainingTravelMin, onsitePerStop, now, target } = ctx;
  const installTimeLeft = horizonMin - now - remainingTravelMin;
  const more = installTimeLeft > 0 ? Math.floor(installTimeLeft / onsitePerStop) : 0;
  const willDo = Math.max(0, Math.min(more, pendingCount));
  const projected = done + willDo;
  const routeShort = pendingCount - willDo;   // route stops we won't reach by H
  // Deliberately NOT echoed back as `target` — `paces.target` is already the
  // finish-by HORIZON, and `paces.target.target` would be two unrelated meanings
  // of the word one dot apart. The meters/day number is returned once, at the top
  // level, and callers read it from there.
  const targetShort = target > 0 ? Math.max(0, target - projected) : null;
  return { label, horizonMin, projected, routeShort, targetShort,
    onPace: routeShort <= 0 };
}

// stops: today's cached stop records (any status). pendingCount: stops left in the
// route. remainingTravelMin: real remaining route travel. onsitePerStop: real
// on-site minutes per stop (travel excluded). finishByMin: installer's target
// finish-by clock (null → no target pace). target: the meters/day target — the
// caption's footnote, NOT what "on pace" means (see paceFor). nowMin: minutes-of-day
// override for tests. dayClosed: whether the day has been closed out.
// Returns { done, pendingCount, target, ready, routeFinishMin, routeFinishLabel,
// paces:{ target, work } } — paces.target is null when no finish-by is set; both
// paces are null when there's no usable pace yet.
//
// routeFinishMin is when the LAST stop still on today's route is done: the same
// three terms paceFor inverts (now + remaining travel + stops × on-site), read
// forward instead of against a horizon. Deriving it from the identical inputs is
// the point — a separately-sourced clock could disagree with the "~N installs"
// number sitting right above it on the gauge. It does not belong to a horizon, so
// it sits at the top level rather than inside a pace; null when there is no route
// left to finish.
//
// Its label goes through finishLabel, NOT clockLabel: unlike the horizons this is
// unbounded and routinely lands in the evening. See finishLabel.
export function projectDayReal({ stops, pendingCount, remainingTravelMin, onsitePerStop,
                                 finishByMin, target, nowMin, dayClosed }){
  const done = (stops || []).filter(s => PRINTABLE[s.status]).length;
  const pend = Math.max(0, pendingCount || 0);
  const goal = Math.max(0, Math.floor(Number(target) || 0));
  if(!(onsitePerStop > 0)) return { done, pendingCount: pend, target: goal || null, ready: false,
    routeFinishMin: null, routeFinishLabel: null, paces: { target: null, work: null } };

  const now = (nowMin == null) ? hhmmMin(clockOf(stamp())) : nowMin;
  const travel = Math.max(0, remainingTravelMin || 0);
  const ctx = { done, pendingCount: pend, remainingTravelMin: travel, onsitePerStop, now, target: goal };

  const wh = workHorizon(now, dayClosed);
  const paces = {
    target: (finishByMin != null) ? paceFor(finishByMin, clockLabel(finishByMin), ctx) : null,
    work: paceFor(wh.min, wh.label, ctx),
  };
  const routeFinishMin = pend > 0 ? Math.round(now + travel + pend * onsitePerStop) : null;
  return { done, pendingCount: pend, target: goal || null, ready: true, paces,
    routeFinishMin,
    routeFinishLabel: finishLabel(routeFinishMin) };
}
