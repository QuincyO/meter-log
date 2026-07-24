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
function clockLabel(min){
  const h = ((Math.floor(min / 60) + 11) % 12) + 1;
  return h + ':' + String(min % 60).padStart(2, '0');
}

// One horizon's projection: how many of the pending route stops land before H.
function paceFor(horizonMin, label, ctx){
  const { done, pendingCount, remainingTravelMin, onsitePerStop, now } = ctx;
  const installTimeLeft = horizonMin - now - remainingTravelMin;
  const more = installTimeLeft > 0 ? Math.floor(installTimeLeft / onsitePerStop) : 0;
  const willDo = Math.max(0, Math.min(more, pendingCount));
  const projected = done + willDo;
  const delta = pendingCount - willDo;   // route stops we won't reach by this horizon
  return { label, horizonMin, projected, delta, onPace: delta <= 0 };
}

// stops: today's cached stop records (any status). pendingCount: stops left in the
// route. remainingTravelMin: real remaining route travel. onsitePerStop: real
// on-site minutes per stop (travel excluded). finishByMin: installer's target
// finish-by clock (null → no target pace). nowMin: minutes-of-day override for
// tests. dayClosed: whether the day has been closed out.
// Returns { done, pendingCount, ready, paces:{ target, work } } — target is null
// when no finish-by is set; both paces are null when there's no usable pace yet.
export function projectDayReal({ stops, pendingCount, remainingTravelMin, onsitePerStop,
                                 finishByMin, nowMin, dayClosed }){
  const done = (stops || []).filter(s => PRINTABLE[s.status]).length;
  const pend = Math.max(0, pendingCount || 0);
  if(!(onsitePerStop > 0)) return { done, pendingCount: pend, ready: false, paces: { target: null, work: null } };

  const now = (nowMin == null) ? hhmmMin(clockOf(stamp())) : nowMin;
  const travel = Math.max(0, remainingTravelMin || 0);
  const ctx = { done, pendingCount: pend, remainingTravelMin: travel, onsitePerStop, now };

  const wh = workHorizon(now, dayClosed);
  const paces = {
    target: (finishByMin != null) ? paceFor(finishByMin, clockLabel(finishByMin), ctx) : null,
    work: paceFor(wh.min, wh.label, ctx),
  };
  return { done, pendingCount: pend, ready: true, paces };
}
