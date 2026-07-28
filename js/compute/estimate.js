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

// Minutes-of-day → bare 12-hour clock label ("2:00", "3:45"). Exported because
// the route-finish clock (routeFinishLabel below) is the same kind of readout.
export function clockLabel(min){
  const h = ((Math.floor(min / 60) + 11) % 12) + 1;
  return h + ':' + String(min % 60).padStart(2, '0');
}

// One horizon's projection: how many installs land before H, and how that lands
// against the two things worth being short of.
//
// `targetShort` is the headline and `routeShort` is the footnote, and they answer
// different questions:
//   targetShort — projected installs vs the installer's METERS/DAY TARGET.
//   routeShort  — projected installs vs the stops still on today's route.
//
// `onPace` used to mean routeShort, and that made it a question that answers
// itself. Today's route is Day 1, and Day 1 is sized `dayCapacity(target,
// installedToday)` = target − what's already installed (js/route-today.js) — so
// the day shrinks by exactly what has been done and the gauge then asks "will I
// finish what's left?". Reported from the field as "it just sets the target to be
// the remaining metres — it always says I'm on pace", which was literally true.
// The target is the only denominator that doesn't move underneath the answer.
//
// `target` absent/0 ⇒ there is no target to be short of, so onPace falls back to
// the route comparison unchanged. Nothing else is a valid reading of "no target".
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
    onPace: target > 0 ? targetShort === 0 : routeShort <= 0 };
}

// stops: today's cached stop records (any status). pendingCount: stops left in the
// route. remainingTravelMin: real remaining route travel. onsitePerStop: real
// on-site minutes per stop (travel excluded). finishByMin: installer's target
// finish-by clock (null → no target pace). target: the meters/day target, which is
// what "on pace" is measured against (see paceFor). nowMin: minutes-of-day
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
    routeFinishLabel: routeFinishMin == null ? null : clockLabel(routeFinishMin) };
}
