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

// How long a scheduled day actually runs, in minutes: the plan's start clock
// through the last stop's DEPARTURE (its ETA plus its own on-site minutes).
// The inverse of `simulateDay` — it reads back the schedule that function wrote
// instead of modelling the day a second way, which is the whole point. The
// worklist's day divider used to carry `count × avgLogMin + 60`, a historical
// log-to-log cadence that knew nothing about this route's distance or this
// installer's measured on-site time, so the header and the ETA badges under it
// could disagree by an hour with nothing on screen explaining which to believe.
//
// Three things worth keeping:
//   - the span starts at `firstStopTime`, the DEPARTURE clock simulateDay starts
//     from, so the drive out from the muster point is inside the number;
//   - the last departure is taken as a MAX rather than "the last element", so a
//     caller that hands the day over in any order still gets the right answer;
//   - a stop with no saved `scheduledOnSiteMin` falls back to the run's dwell
//     base rather than costing nothing, which would quietly shorten the day.
// Returns null when the day carries no ETAs at all (never optimized, or an
// unroutable list) — the caller decides what to show instead.
export function dayDurationMin(items, firstStopTime, fallbackOnSiteMin){
  const start = timeMin(firstStopTime);
  if(start == null) return null;
  const fallback = Number(fallbackOnSiteMin);
  let last = null;
  (items || []).forEach(x => {
    if(!x) return;
    const eta = timeMin(x.scheduledEta);
    if(eta == null) return;
    const onSite = Number(x.scheduledOnSiteMin);
    const depart = eta + ((isFinite(onSite) && onSite > 0) ? onSite
      : (isFinite(fallback) && fallback > 0 ? fallback : 0));
    if(last == null || depart > last) last = depart;
  });
  return last == null ? null : Math.max(0, Math.round(last - start));
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

// The order the installer locked to the route's FIRST slot (Day 1, slot 1), or
// null. Optimize hands it to the solver as `leadId` so Day 1 is built outward from
// it (js/route.js solveWithLead). A lock anywhere else is still only a scheduling
// pin, placed by scheduleRouteConstraints below. Callers pass their pending list.
export function routeLeadId(items, routeStartDate){
  if(!dateAtUtc(routeStartDate)) return null;
  const hit = (items || []).find(x => x && x.id && x.lockedDate && Number(x.lockedSlot) === 1
    && workdayOffset(routeStartDate, x.lockedDate) === 0);
  return hit ? hit.id : null;
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
//
// Lateness is REPORTED, never thrown. An appointment the day cannot reach in time
// records `lateMin` on its own schedule entry and accrues into the day's total, so
// the caller can rank arrangements by it (placeAppointments) and the UI can badge
// the one stop that misses. `errors` is now only for input that cannot be scheduled
// at all — an unparseable appointment time. It used to carry the late arrivals too,
// and every caller treated a non-empty `errors` as fatal, which is how one
// unreachable appointment took an entire 24-stop route down with it.
function simulateDay(slotIds, byId, firstMin, pace, travel, dwell){
  const schedule = {}, errors = [];
  const flatOnSite = onSiteMinutes(pace);
  // The route's typical dwell, used for the between-leg fallback only. Taking it
  // from `dwell.base` rather than a per-item value keeps the fallback stable across
  // a day whose stops price differently.
  const baseOnSite = dwell ? dwell.base : flatOnSite;
  const moveFallback = Math.max(1, pace - baseOnSite);
  let delayed = 0;         // total appointment wait (flat model + return value)
  let lateTotal = 0;       // total appointment overshoot, for ranking arrangements
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
    let eta = raw, waitMin = 0, lateMin = 0;
    if(item && item.appointmentTime){
      const deadline = timeMin(item.appointmentTime);
      if(deadline == null) errors.push(`${label(item)} has an invalid appointment time`);
      else if(raw > deadline){ lateMin = raw - deadline; lateTotal += lateMin; }
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
      lateMin:Math.round(lateMin), onSiteMin:Math.round(onSite) };
    departClock = eta + onSite;   // leave after the on-site work
    prevId = id; prevItem = item;
  });
  return { schedule, errors, waitMin:delayed, lateMin:lateTotal };
}

// `freeIds` are the unconstrained orders that will actually fill this day's empty
// slots, in the order scheduleRouteConstraints will hand them out. Passing them in
// is what makes the search honest: it used to pad with `__free_k` placeholders,
// and `travelLookup` has no matrix row for a placeholder, so every free leg priced
// at the nominal `pace − onSite` fallback and the drive OUT of the muster point at
// **zero** (simulateDay's `i === 0` branch). A day of 30-minute drives was
// therefore searched as a day of 10-minute ones; a slot that looked comfortably
// on time arrived an hour late in the real simulation right after, which threw and
// took the whole route with it — while an on-time arrangement (the appointment
// first, then a long wait) sat there unconsidered. The search and the final
// simulation must price the identical day or the choice means nothing.
//
// Ranking, in order: an on-time arrangement always beats a late one, however long
// the wait it costs — sitting 70 minutes in a driveway is the acceptable outcome
// and missing the appointment is not. Among on-time arrangements the least waiting
// still wins (the latest non-late slot, so the day stays productive). Only when NO
// arrangement is on time does the least-late one carry the day, and then it is
// reported through `lateMin` rather than thrown.
// `fillSlots` (optional) replaces the free-list padding below with the caller's own
// day assembly — the reflow path's fillDay — so the search prices exactly the day the
// final simulation will walk once the route carries on from each anchor.
function placeAppointments(date, count, fixed, appointments, byId, firstMin, pace, travel, dwell, freeIds, fillSlots){
  if(!appointments.length) return { anchors:{...fixed} };
  const ordered = appointments.slice().sort((a,b) =>
    String(a.appointmentTime).localeCompare(String(b.appointmentTime)) || label(a).localeCompare(label(b)));
  let best = null, late = null;
  const occupied = new Set(Object.keys(fixed).map(Number));
  const chosen = {...fixed};

  function visit(i, lastSlot){
    if(i === ordered.length){
      let slots;
      if(fillSlots) slots = fillSlots(chosen);
      else {
        slots = Array(count).fill(null);
        Object.keys(chosen).forEach(k => { slots[Number(k) - 1] = chosen[k]; });
        // Empty slots take the real orders that will occupy them. The `__free_k`
        // placeholder survives only as a backstop for a caller that supplied no free
        // list (or too short a one); simulateDay still prices it at the dwell base.
        let f = 0;
        for(let k = 0; k < count; k++)
          if(!slots[k]) slots[k] = (freeIds && freeIds[f] != null) ? freeIds[f++] : `__free_${k}`;
      }
      const sim = simulateDay(slots, byId, firstMin, pace, travel, dwell);
      if(sim.errors.length) return;
      const vector = ordered.map(x => Number(Object.keys(chosen).find(k => chosen[k] === x.id)));
      if(sim.lateMin > 0){
        if(!late || sim.lateMin < late.lateMin
            || (sim.lateMin === late.lateMin && sim.waitMin < late.waitMin))
          late = { anchors:{...chosen}, waitMin:sim.waitMin, lateMin:sim.lateMin, vector };
        return;
      }
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
  // Nothing at all was placeable — not "everything was late" (that lands in `late`),
  // but no arrangement existed: locks out of order, or an unparseable appointment
  // time on every candidate. That is still a hard error.
  if(!best && !late) throw new Error(`Timed appointments on ${date} cannot be placed in order: ${ordered.map(label).join(', ')}`);
  return best || late;
}

// One day's slots for the reflow path: anchors where they were placed, and each run
// of free slots filled from `pool` (ordered ids, route order). A run that follows an
// anchor asks `reflow(fromId, toId|null, k, availIds)` for its k stops — nearest-first
// from the anchor, ending near `toId` when another anchor closes the run. A run at
// the start of the day, or after `keepAfter`, takes the pool in route order, as the
// non-reflow path always has. Anything reflow does not supply is topped up in route
// order, so a short or odd answer can never drop or duplicate an order.
function fillDay(count, anchors, pool, reflow, keepAfter){
  const slots = Array(count).fill(null);
  Object.keys(anchors).forEach(k => { slots[Number(k) - 1] = anchors[k]; });
  const isAnchor = slots.map(Boolean);
  let avail = pool.slice(), pad = 0;
  for(let s = 0; s < count; ){
    if(isAnchor[s]){ s++; continue; }
    let e = s; while(e < count && !isAnchor[e]) e++;
    const k = e - s;
    const from = s > 0 ? slots[s - 1] : null;
    const availSet = new Set(avail);
    const got = [], seen = new Set();
    if(from && from !== keepAfter){
      for(const id of (reflow(from, e < count ? slots[e] : null, k, avail) || [])){
        if(got.length >= k) break;
        if(availSet.has(id) && !seen.has(id)){ got.push(id); seen.add(id); }
      }
    }
    for(const id of avail){ if(got.length >= k) break; if(!seen.has(id)){ got.push(id); seen.add(id); } }
    while(got.length < k) got.push(`__free_${pad++}`);
    got.forEach((id, j) => { slots[s + j] = id; });
    avail = avail.filter(id => !seen.has(id));
    s = e;
  }
  return slots;
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
  // The clock DAY 1 departs on, when it differs from every other day's. A route
  // re-solved at 11:40 from where the crew is standing is a route that departs at
  // 11:40, and pricing it from 08:15 makes every ETA on it a morning ETA — and
  // makes placeAppointments search an afternoon against a morning clock, which is
  // the optimistic direction that fails late instead of early.
  // Absent/unparseable ⇒ null ⇒ every day keeps `firstMin`, byte-identical to
  // before. Same null-is-unset trap as `opts.day1Count` below: `0` is midnight,
  // a real value, so this must be tested against null and never truthiness.
  // ETAs ONLY. Nothing about day SIZING may read it — `counts[]`/`capFor` below
  // are deliberately untouched, or the finish-by clock AGENTS.md buried is back
  // under a new name.
  const rawDay1First = opts.day1FirstStopTime == null || opts.day1FirstStopTime === ''
    ? null : timeMin(opts.day1FirstStopTime);
  const firstMinFor = day => (day === 0 && rawDay1First != null) ? rawDay1First : firstMin;
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
  const constrainedByDay = {}, minByDay = {}, constrainedIds = new Set();
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
    constrainedIds.add(item.id);
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

  // Each day's locks (slot → id) and timed appointments, validated.
  function dayConstraints(day, date){
    const fixed = {}, appts = [];
    for(const item of (constrainedByDay[day] || [])){
      if(item.lockedDate){
        const slot = Number(item.lockedSlot);
        if(slot < 1 || slot > counts[day]) throw new Error(`${label(item)} is locked beyond the available slots on ${date}`);
        if(fixed[slot]) throw new Error(`${label(byId[fixed[slot]])} and ${label(item)} are both locked to ${date} slot ${slot}`);
        fixed[slot] = item.id;
      }
      if(item.appointmentDate) appts.push(item);
    }
    return { fixed, appts };
  }

  // REFLOW — Optimize only (opts.reflow, built by js/route.js anchorFiller). After a
  // timed appointment or a locked stop the route CARRIES ON FROM IT: the free slots
  // that follow are re-chosen nearest-first from the anchor (ending near the next
  // anchor when there is one), drawing on every order still unplaced, whatever day
  // it was tagged for. Without it those slots took the next stops of a sequence
  // solved with the anchor left out, so an appointment across town was followed by
  // the drive straight back to the cluster it interrupted (field report 2026-11-03).
  // Opt-in because every other caller (drag, the per-log re-anchor) must keep the
  // order it is handed.
  const reflow = typeof opts.reflow === 'function' ? opts.reflow : null;
  if(reflow){
    let pool = route.filter(id => !constrainedIds.has(id));
    const finalIds = [], scheduleById = {}, dayOf = {};
    for(let day = 0; day < counts.length; day++){
      const date = addWorkdays(startDate, day);
      const { fixed, appts } = dayConstraints(day, date);
      const nFree = Math.max(0, counts[day] - (constrainedByDay[day] || []).length);
      // A locked work list (day1Count) freezes Day 1's MEMBERS: reflow may reorder
      // them, never swap one for a later day's order.
      const dayPool = (day === 0 && day1Count != null) ? pool.slice(0, nFree) : pool;
      // The lead (a LOCK in Day 1 slot 1) was already grown from by the solver
      // (route.js solveWithLead), so the stretch after it keeps the solver's order.
      const keepAfter = day === 0 ? (fixed[1] || null) : null;
      const fill = anchors => fillDay(counts[day], anchors, dayPool, reflow, keepAfter);
      const anchors = placeAppointments(date, counts[day], fixed, appts, byId,
        firstMinFor(day), pace, travel, dwell, null, fill).anchors;
      const ids = fill(anchors);
      const used = new Set(ids);
      pool = pool.filter(id => !used.has(id));
      const sim = simulateDay(ids, byId, firstMinFor(day), pace, travel, dwell);
      if(sim.errors.length) throw new Error(sim.errors.join('; '));
      ids.forEach(id => {
        finalIds.push(id); dayOf[id] = day + 1;
        scheduleById[id] = { date, ...sim.schedule[id] };
      });
    }
    return { orderedIds:finalIds, dayOf, scheduleById };
  }

  // Every anchor is a constrained item and every constrained item becomes an anchor
  // (placeAppointments only ever chooses from `fixed` + this day's appointments), so
  // the free list is known BEFORE the slots are picked — which is what lets each
  // day's search simulate the orders that will really fill it. `freeCursor` hands
  // them out in the same day order the final loop below consumes them.
  const freeAll = route.filter(id => !constrainedIds.has(id));
  const anchorsByDay = {};
  let freeCursor = 0;
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
    const freeForDay = freeAll.slice(freeCursor,
      freeCursor + Math.max(0, counts[day] - (constrainedByDay[day] || []).length));
    freeCursor += freeForDay.length;
    anchorsByDay[day] = placeAppointments(date, counts[day], fixed, appts, byId,
      firstMinFor(day), pace, travel, dwell, freeForDay).anchors;
  }

  const anchorIds = new Set(); Object.values(anchorsByDay).forEach(a => Object.values(a).forEach(id => anchorIds.add(id)));
  const free = route.filter(id => !anchorIds.has(id));
  let freeAt = 0;
  const finalIds = [], scheduleById = {}, dayOf = {};
  for(let day = 0; day < counts.length; day++){
    const date = addWorkdays(startDate, day), ids = [];
    for(let slot = 1; slot <= counts[day]; slot++) ids.push(anchorsByDay[day][slot] || free[freeAt++]);
    const sim = simulateDay(ids, byId, firstMinFor(day), pace, travel, dwell);
    if(sim.errors.length) throw new Error(sim.errors.join('; '));
    ids.forEach(id => {
      finalIds.push(id); dayOf[id] = day + 1;
      scheduleById[id] = { date, ...sim.schedule[id] };
    });
  }
  return { orderedIds:finalIds, dayOf, scheduleById };
}
