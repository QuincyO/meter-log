// ── Plan-mode "expected stops today" projection ─────────────────────────────
// Quiet pace-so-far estimate shown only in plan mode on the capture page.
// The benchmark is the observed time between the stops logged so far today —
// the log-to-log gap (travel + on-site time per meter) that computeGapsLocal
// already derives — projected forward to the fixed workday horizon.
//
// Horizon is fixed by the crew's schedule: regular end of day 4:00 PM, overtime
// ceiling 5:00 PM. Before 4:00 we project to 4:00; once past it (working OT) we
// project to the 5:00 ceiling. Count basis is every printable stop, since the
// time is spent regardless of the outcome (DONE markers are excluded).
import { PRINTABLE } from './tally.js';
import { computeGapsLocal } from './gaps.js';
import { clockOf, hhmmMin, stamp } from '../time.js';

const QUIT_MIN = 16 * 60;  // 4:00 PM — regular end of day
const OT_MIN   = 17 * 60;  // 5:00 PM — overtime ceiling

// stops: today's cached stop records (any status). nowMin: minutes-of-day
// override for testing; defaults to the current Toronto clock.
// Returns { done, ready:false } when there's no pace yet (< 2 stops), else
// { done, ready:true, avgCadence, projected, label }.
export function projectDay(stops, nowMin){
  const printable = (stops || []).filter(s => PRINTABLE[s.status]);
  const done = printable.length;
  // land=false so no zero-length lead gap dilutes the average.
  const gaps = computeGapsLocal(printable, [], null, false);
  if(gaps.length < 1) return { done, ready:false };

  const avg = gaps.reduce((a, g) => a + g.idleMin, 0) / gaps.length;
  const now = (nowMin == null) ? hhmmMin(clockOf(stamp())) : nowMin;

  let target = QUIT_MIN, label = '4:00';
  if(now >= QUIT_MIN){ target = OT_MIN; label = '5:00 OT'; }

  const left = target - now;
  const more = (left > 0 && avg > 0) ? Math.round(left / avg) : 0;

  return { done, ready:true, avgCadence: Math.round(avg), projected: done + more, label };
}
