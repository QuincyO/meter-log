// Pure route scheduling constraints shared by the phone worklist and desktop
// planner. Geography is solved first; this layer fixes appointments/locks into
// calendar slots and fills the remaining slots in that geographic order.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// On-site install minutes derived from the installer's 30-day pace. The pace
// (recent30AvgLogMin) is a log-to-log gap that already bundles the typical short
// drive between stops, so we subtract a nominal baseline drive to get the hands-on
// portion — then the scheduler adds each leg's REAL road-travel time on top. Net
// effect: a route whose legs run about the baseline behaves like the historical
// pace, while a travel-heavy route correctly runs longer (fewer stops fit by the
// finish clock — the home-bias vs production balance). Floored so it never vanishes.
//
// This is now the FALLBACK, not the model: it lives in js/route-dwell.js alongside
// the measured per-stop dwell that supersedes it, and is re-exported here because
// callers and tests already import it from this module.
export { MIN_ONSITE_MIN, NOMINAL_TRAVEL_MIN, onSiteMinutes } from './route-dwell.js';
import { onSiteMinutes } from './route-dwell.js';

function dateAtUtc(text){
  if(!DATE_RE.test(String(text || ''))) return null;
  const [y,m,d] = String(text).split('-').map(Number);
  const out = new Date(Date.UTC(y, m - 1, d));
  return out.getUTCFullYear() === y && out.getUTCMonth() === m - 1 && out.getUTCDate() === d ? out : null;
}
function dateText(d){ return d.toISOString().slice(0, 10); }
function weekend(text){
  const d = dateAtUtc(text); if(!d) return false;
  return d.getUTCDay() === 0 || d.getUTCDay() === 6;
}
function timeMin(text){
  const m = String(text || '').match(TIME_RE);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function clock(min){
  const n = Math.max(0, Math.round(min));
  return String(Math.floor(n / 60) % 24).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}
function label(item){ return `WO ${item.workOrderId || item.id || '?'}`; }

export function addWorkdays(start, offset){
  const d = dateAtUtc(start);
  if(!d) throw new Error('Route start date is invalid');
  let left = Math.max(0, Number(offset) || 0);
  while(left){ d.setUTCDate(d.getUTCDate() + 1); if(d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--; }
  return dateText(d);
}

export function workdayOffset(start, target){
  const a = dateAtUtc(start), b = dateAtUtc(target);
  if(!a || !b || b < a) return -1;
  let n = 0, d = new Date(a);
  while(dateText(d) !== dateText(b)){
    d.setUTCDate(d.getUTCDate() + 1);
    if(d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  return n;
}

export function currentRoutePlacement(items, itemId, target){
  const route = (items || []).filter(Boolean);
  const index = route.findIndex(x => x.id === itemId);
  if(index < 0) return { day:1, slot:1 };
  const item = route[index];
  const assignedDay = Number(item.day) || 0;
  if(assignedDay){
    const sameDay = route.filter(x => Number(x.day) === assignedDay);
    const withinDay = sameDay.findIndex(x => x.id === itemId);
    return { day:assignedDay, slot:Math.max(1, withinDay + 1) };
  }
  const perDay = Math.max(1, Math.floor(Number(target) || 1));
  return { day:Math.floor(index / perDay) + 1, slot:(index % perDay) + 1 };
}

// `travel` (optional) is the run's road-duration lookup (js/route.js travelLookup):
// { fromStart(id) } for the morning drive out of the muster point to a day's first
// stop, { between(fromId,toId) } for the drive between two stops. When present, each
// stop's arrival is the previous departure plus real travel, and departure is arrival
// plus on-site time — so ETAs reflect actual road time. When absent (straight-line /
// no durations), the legacy flat-pace cadence is used unchanged. A leg with no known
// duration (a free-slot placeholder, or a missing matrix cell) falls back to a
// nominal drive so the simulation still advances.
//
// `dwell` (optional) is the run's on-site lookup (js/route-dwell.js dwellLookup).
// It is the exact mirror of `travel`: present ⇒ each stop is charged its OWN dwell
// (measured on-site time, cut to `extraMeterMin` for a repeat meter at an address
// the crew is already parked at, scaled by a site's history); absent ⇒ the flat
// pace-derived `onSiteMinutes(pace)` every stop got before, unchanged.
function simulateDay(slotIds, byId, firstMin, pace, travel, dwell){
  const schedule = {}, errors = [];
  const flatOnSite = onSiteMinutes(pace);
  // The route's typical dwell, used for the between-leg fallback only. Taking it
  // from `dwell.base` rather than a per-item value keeps the fallback stable across
  // a day whose stops price differently.
  const baseOnSite = dwell ? dwell.base : flatOnSite;
  const moveFallback = Math.max(1, pace - baseOnSite);
  let delayed = 0;         // total appointment wait (flat model + return value)
  let departClock = firstMin;   // running departure clock (time model)
  let prevId = null, prevItem = null;
  slotIds.forEach((id, i) => {
    const item = byId[id];
    let raw;
    if(travel){
      const move = (i === 0) ? travel.fromStart(id) : travel.between(prevId, id);
      raw = departClock + (move == null ? (i === 0 ? 0 : moveFallback) : move);
    } else {
      raw = firstMin + i * pace + delayed;
    }
    let eta = raw, waitMin = 0;
    if(item && item.appointmentTime){
      const deadline = timeMin(item.appointmentTime);
      if(deadline == null) errors.push(`${label(item)} has an invalid appointment time`);
      else if(raw > deadline) errors.push(`${label(item)} would arrive at ${clock(raw)}, after ${item.appointmentTime}`);
      else {
        const windowStart = deadline - 20;
        if(raw < windowStart){ waitMin = windowStart - raw; delayed += waitMin; eta = windowStart; }
      }
    }
    // `prevItem` is the previous stop on THIS day only — simulateDay is called once
    // per day and both trackers reset with it, so a day's first stop can never be
    // read as a repeat meter of the last stop of the day before.
    const onSite = dwell ? dwell.forItem(item, prevItem) : flatOnSite;
    schedule[id] = { slot:i + 1, eta:clock(eta), waitMin:Math.round(waitMin),
      onSiteMin:Math.round(onSite) };
    departClock = eta + onSite;   // leave after the on-site work
    prevId = id; prevItem = item;
  });
  return { schedule, errors, waitMin:delayed };
}

function placeAppointments(date, count, fixed, appointments, byId, firstMin, pace, travel, dwell){
  if(!appointments.length) return { anchors:{...fixed} };
  const ordered = appointments.slice().sort((a,b) =>
    String(a.appointmentTime).localeCompare(String(b.appointmentTime)) || label(a).localeCompare(label(b)));
  let best = null;
  const occupied = new Set(Object.keys(fixed).map(Number));
  const chosen = {...fixed};

  function visit(i, lastSlot){
    if(i === ordered.length){
      const slots = Array(count).fill(null);
      Object.keys(chosen).forEach(k => { slots[Number(k) - 1] = chosen[k]; });
      // Empty slots still consume one cadence interval; use stable placeholders
      // for simulation, then discard their schedule entries.
      for(let k = 0; k < count; k++) if(!slots[k]) slots[k] = `__free_${k}`;
      const sim = simulateDay(slots, byId, firstMin, pace, travel, dwell);
      if(sim.errors.length) return;
      const vector = ordered.map(x => Number(Object.keys(chosen).find(k => chosen[k] === x.id)));
      if(!best || sim.waitMin < best.waitMin ||
          (sim.waitMin === best.waitMin && vector.join(',') > best.vector.join(',')))
        best = { anchors:{...chosen}, waitMin:sim.waitMin, vector };
      return;
    }
    const item = ordered[i];
    if(item.lockedDate){
      const slot = Number(item.lockedSlot);
      if(slot <= lastSlot) return;
      visit(i + 1, slot);
      return;
    }
    for(let slot = lastSlot + 1; slot <= count; slot++){
      if(occupied.has(slot)) continue;
      occupied.add(slot); chosen[slot] = item.id;
      visit(i + 1, slot);
      delete chosen[slot]; occupied.delete(slot);
    }
  }
  visit(0, 0);
  if(!best) throw new Error(`Timed appointments on ${date} cannot fit without a late arrival: ${ordered.map(label).join(', ')}`);
  return best;
}

export function scheduleRouteConstraints(items, geographicIds, opts={}){
  const route = (geographicIds || []).slice();
  const byId = {}; (items || []).forEach(x => { if(x && x.id) byId[x.id] = x; });
  const orderedItems = route.map(id => byId[id]).filter(Boolean);
  if(orderedItems.length !== route.length) throw new Error('Route contains an unknown work order');

  const startDate = String(opts.routeStartDate || '');
  if(!dateAtUtc(startDate)) throw new Error('Route start date is invalid');
  if(weekend(startDate)) throw new Error('Route start date must be a weekday');
  const firstMin = timeMin(opts.firstStopTime);
  if(firstMin == null) throw new Error('First-stop time is invalid');
  const pace = Math.round(Number(opts.paceMin) || 0);
  if(pace < 1) throw new Error('Pace must be at least 1 minute per stop');
  const target = Math.max(1, Math.floor(Number(opts.target) || 1));
  // The today anchor (js/route-today.js): when set, Day 1 holds EXACTLY this many
  // stops instead of a full `target` — the frozen "today's orders" set that shrinks
  // as they're finished. Days 2+ still fill by `target`. Omitted ⇒ unchanged
  // behaviour: every day sizes to `target`. Never larger than the pending count.
  // ZERO IS A REAL VALUE, not "unset": it means today's meters/day target is already
  // met, so Day 1 takes no stops and everything falls to Day 2. Test against null,
  // never truthiness, or a full day silently refills to a whole fresh target.
  const rawDay1 = Number(opts.day1Count);
  const day1Count = (opts.day1Count == null || !isFinite(rawDay1))
    ? null : Math.max(0, Math.floor(rawDay1));
  const capFor = i => (i === 0 && day1Count != null) ? day1Count : target;
  // Real road-travel lookup (js/route.js travelLookup), or null on a straight-line
  // run — passed straight through to the day simulation so ETAs reflect actual drive
  // times when we have them and fall back to flat pace when we don't.
  const travel = opts.travel || null;
  // Per-stop on-site lookup (js/route-dwell.js dwellLookup). Same contract as
  // `travel` above, and the same trap: a caller that forgets it gets the old flat
  // dwell silently, with no error to notice. Every optimize path must pass both.
  const dwell = opts.dwell || null;

  let latestDay = Math.max(0, Math.ceil(route.length / target) - 1);
  const constrainedByDay = {}, minByDay = {};
  for(const item of orderedItems){
    const apptDate = String(item.appointmentDate || ''), apptTime = String(item.appointmentTime || '');
    if(Boolean(apptDate) !== Boolean(apptTime)) throw new Error(`${label(item)} needs both appointment date and time`);
    if(apptDate && weekend(apptDate)) throw new Error(`Weekend appointment is not supported for ${label(item)}`);
    const lockDate = String(item.lockedDate || '');
    const lockSlot = Number(item.lockedSlot);
    if(Boolean(lockDate) !== Boolean(lockSlot)) throw new Error(`${label(item)} has an incomplete position lock`);
    if(lockDate && weekend(lockDate)) throw new Error(`Weekend lock is not supported for ${label(item)}`);
    if(apptDate && lockDate && apptDate !== lockDate) throw new Error(`${label(item)} appointment and lock use different dates`);
    const date = lockDate || apptDate;
    if(!date) continue;
    const day = workdayOffset(startDate, date);
    if(day < 0) throw new Error(`${label(item)} is dated before the route starts`);
    latestDay = Math.max(latestDay, day);
    (constrainedByDay[day] = constrainedByDay[day] || []).push(item);
    minByDay[day] = Math.max(
      minByDay[day] || 0,
      constrainedByDay[day].length,
      lockSlot || 1
    );
  }

  const counts = Array(latestDay + 1).fill(0).map((_,i) => minByDay[i] || 0);
  let used = counts.reduce((a,b) => a + b, 0);
  if(used > route.length) throw new Error('Locked queue slots require more work orders than are available');
  let remaining = route.length - used;
  for(let i = 0; i < counts.length && remaining; i++){
    const add = Math.min(remaining, Math.max(0, capFor(i) - counts[i]));
    counts[i] += add; remaining -= add;
  }
  while(remaining){ const add = Math.min(remaining, target); counts.push(add); remaining -= add; }

  const anchorsByDay = {};
  for(let day = 0; day < counts.length; day++){
    const date = addWorkdays(startDate, day), fixed = {}, appts = [];
    for(const item of (constrainedByDay[day] || [])){
      if(item.lockedDate){
        const slot = Number(item.lockedSlot);
        if(slot < 1 || slot > counts[day]) throw new Error(`${label(item)} is locked beyond the available slots on ${date}`);
        if(fixed[slot]) throw new Error(`${label(byId[fixed[slot]])} and ${label(item)} are both locked to ${date} slot ${slot}`);
        fixed[slot] = item.id;
      }
      if(item.appointmentDate) appts.push(item);
    }
    anchorsByDay[day] = placeAppointments(date, counts[day], fixed, appts, byId, firstMin, pace, travel, dwell).anchors;
  }

  const anchorIds = new Set(); Object.values(anchorsByDay).forEach(a => Object.values(a).forEach(id => anchorIds.add(id)));
  const free = route.filter(id => !anchorIds.has(id));
  let freeAt = 0;
  const finalIds = [], scheduleById = {}, dayOf = {};
  for(let day = 0; day < counts.length; day++){
    const date = addWorkdays(startDate, day), ids = [];
    for(let slot = 1; slot <= counts[day]; slot++) ids.push(anchorsByDay[day][slot] || free[freeAt++]);
    const sim = simulateDay(ids, byId, firstMin, pace, travel, dwell);
    if(sim.errors.length) throw new Error(sim.errors.join('; '));
    ids.forEach(id => {
      finalIds.push(id); dayOf[id] = day + 1;
      scheduleById[id] = { date, ...sim.schedule[id] };
    });
  }
  return { orderedIds:finalIds, dayOf, scheduleById };
}
