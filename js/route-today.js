// ── Today anchor (the frozen day-1 set) ─────────────────────────────────────
// The multi-day split (js/route.js, js/route-constraints.js) cuts the PENDING
// list into `target`-sized day chunks from the top. Completed orders are filtered
// out before that math, so Day 1 refills from the front of what's left every time
// a route is optimized/downloaded — which pulls tomorrow's orders up into today
// the moment you finish a few of today's. The installer wants the opposite: the
// set of orders that was "today" when the day's route was established stays today,
// shrinking only as they're finished, and only rolls into the next day's orders
// once today's are all done.
//
// The anchor is that frozen set: an ordered list of order IDs plus the date it was
// committed. It is phone-owned (persisted in localStorage by worklist.js, like the
// meters/day target) — no spine or sheet-schema change. These helpers are the pure
// decision layer over it: which committed orders are still today, when to (re)commit,
// and how to order the pending list so today's set leads. No DOM, no storage, no
// network — unit-tested in tests/route-today.test.mjs.
//
// The frozen set says WHICH orders are today; it does not say how many FIT. That is
// `dayCapacity` below: the meters/day target minus the meters actually installed
// today, counted from the day's real stops — so the walk-up meters a crew finds in
// the field consume the day's room just like planned ones do, and the tail of today's
// set rolls to tomorrow on its own. `anchor.extend` is the installer's override: the
// count of stops they explicitly agreed to work past that capacity ("add it to today,
// the day runs later"). A legacy `{date, ids}` anchor reads as extend 0.
//
// The anchor also remembers the meters/day `target` it was frozen under, because the
// freeze is keyed on the set's identity and would otherwise outlive the plan that
// sized it: an installer who routed at 6 meters/day and later set the target to 24
// kept a six-order day forever, and re-optimizing could not shift it. A CHANGED
// target on an explicit Optimize is the one extra reason to re-commit — see
// needsCommit's `opts.replan`.

function anchorIdSet(anchor){
  return new Set(((anchor && anchor.ids) || []).map(String));
}

/** The committed order IDs that are still pending, in the pending list's order.
 *  Shrinks as orders are finished/removed; empty once today's set is exhausted. */
export function anchorDay1Ids(anchor, pending){
  const set = anchorIdSet(anchor);
  return (pending || []).filter(p => p && set.has(String(p.id))).map(p => String(p.id));
}

/** Stops the installer has explicitly agreed to work past today's capacity.
 *  Absent/garbage (a legacy anchor) reads as none. */
export function anchorExtend(anchor){
  const n = Math.floor(Number(anchor && anchor.extend));
  return isFinite(n) && n > 0 ? n : 0;
}

/** The meters/day target this set was frozen under. `null` for a legacy `{date, ids}`
 *  anchor written before the field existed — which needsCommit deliberately reads as
 *  "unknown, so re-plan on the next Optimize", the one-shot that unsticks a day frozen
 *  by a target nobody can recover. */
export function anchorTarget(anchor){
  const n = Math.floor(Number(anchor && anchor.target));
  return isFinite(n) && n > 0 ? n : null;
}

/** Room left in the day: the meters/day target minus every meter already installed
 *  today — planned orders and walk-ups alike. Zero once the target is met, which is
 *  a FULL day, not an exhausted one: today's remaining orders roll to tomorrow but
 *  the anchor keeps its identity (see needsCommit). */
export function dayCapacity(target, installedToday){
  const t = Math.max(1, Math.floor(Number(target) || 1));
  const done = Math.max(0, Math.floor(Number(installedToday) || 0));
  return Math.max(0, t - done);
}

/** How many of today's committed orders actually fit — capacity plus whatever the
 *  installer chose to work past it, never more orders than today's set holds.
 *  Feeds scheduleRouteConstraints' `opts.day1Count`; the overflow falls to Day 2. */
export function day1Count(anchor, day1Ids, capacity){
  const room = Math.max(0, Math.floor(Number(capacity) || 0)) + anchorExtend(anchor);
  return Math.min(room, (day1Ids || []).length);
}

/** Do we need to (re)commit today's set?
 *   - nothing pending            → no (nothing to anchor)
 *   - no anchor / a stale date    → yes (first route of a new day)
 *   - today's committed set empty → yes (all finished → roll to the next chunk)
 *   - a re-plan whose target moved → yes (see below)
 *  Otherwise the frozen set still has work on it, so leave it exactly as it is.
 *  Deliberately keyed on the set's IDENTITY, never on dayCapacity: a day whose
 *  target is met still owns its unfinished orders, so hitting the target must not
 *  roll tomorrow's work in — it just pushes today's leftovers out to Day 2.
 *
 *  `opts` = `{replan, target}`, passed ONLY by an explicit Optimize. Changing the
 *  meters/day number is not itself a re-plan — the installer's deliberate press is,
 *  which is also the moment the day tags have just been re-solved at the new target,
 *  so the fresh commit reads a route that actually matches it. Every other caller
 *  (a logged stop, a Download, first view) passes nothing and keeps today frozen
 *  exactly as before. An Optimize at an UNCHANGED target must still not re-commit,
 *  or re-optimizing after finishing a few orders pulls tomorrow's work up — the
 *  whole reason the anchor exists. A legacy anchor (no stored target) reads as
 *  changed, so the first Optimize after this shipped re-plans once and then the
 *  field is always there. */
export function needsCommit(anchor, today, pending, opts){
  if(!(pending && pending.length)) return false;
  if(!anchor || anchor.date !== today) return true;
  if(anchorDay1Ids(anchor, pending).length === 0) return true;
  if(opts && opts.replan){
    const was = anchorTarget(anchor);
    const now = Math.max(1, Math.floor(Number(opts.target) || 1));
    if(was == null || was !== now) return true;
  }
  return false;
}

/** The set to freeze when committing today. Prefer the route's CURRENT day-1
 *  group (the pending orders already tagged with the lowest `day`) so the freeze
 *  honours whatever sized that day — the optimizer's time-capacity shrink, the
 *  office's chunking, an appointment day. Only a never-routed list (no day tags at
 *  all) falls back to the first `target` orders by count. `pending` is the pending
 *  items in list order.
 *
 *  `opts.max` caps how many orders may be frozen — the day's REMAINING room, used when
 *  a mid-day re-plan raises the target. It bounds MEMBERSHIP, not the day's displayed
 *  size (that stays day1Count's job): without it, changing the target at noon would
 *  haul a whole fresh target's worth of tomorrow's orders into a day that is already
 *  half spent. Omitted ⇒ unbounded, which is the right answer for a day that has not
 *  started or is already closed out. */
export function freshAnchorIds(pending, target, opts){
  const t = Math.max(1, Math.floor(Number(target) || 1));
  // `null`/absent is UNBOUNDED, and must not coerce to Number(null) === 0 — that
  // would silently freeze an empty day on the very path that means "no limit".
  const rawMax = (opts && opts.max != null) ? Math.floor(Number(opts.max)) : NaN;
  const max = isFinite(rawMax) && rawMax >= 0 ? rawMax : null;
  const cap = ids => max == null ? ids : ids.slice(0, max);
  const list = pending || [];
  const days = list
    .map(p => (p && p.day !== '' && p.day != null && isFinite(Number(p.day))) ? Number(p.day) : null)
    .filter(d => d != null);
  if(days.length){
    const minDay = Math.min(...days);
    const group = list.filter(p => Number(p.day) === minDay).map(p => String(p.id));
    if(group.length) return cap(group);
  }
  return cap(list.slice(0, t).map(p => String(p.id)));
}

/** Slot one new order into an existing sequence at its cheapest position —
 *  classic cheapest-insertion, the standard way to add a stop to a solved tour
 *  without re-solving it. `dist(aId, bId)` returns the distance between two orders
 *  (any unit) or null when either has no pin; the caller supplies it, so this stays
 *  free of geo math and of the matrix.
 *
 *  Cost of going in front of position k is the detour it adds:
 *  d(prev,new) + d(new,next) − d(prev,next). At either end there is only one
 *  new edge and nothing is removed. An order with no usable distance anywhere
 *  goes last, which is where an unpinnable order belongs anyway. */
export function insertByProximity(seq, newId, dist){
  const id = String(newId);
  const rest = (seq || []).map(String).filter(x => x !== id);
  if(!rest.length) return [id];
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  let bestAt = null, bestCost = Infinity;
  for(let k = 0; k <= rest.length; k++){
    const prev = k > 0 ? rest[k - 1] : null;
    const next = k < rest.length ? rest[k] : null;
    const inA = prev == null ? 0 : num(dist(prev, id));
    const inB = next == null ? 0 : num(dist(id, next));
    if(inA == null || inB == null) continue;          // unpinned neighbour — can't price
    const removed = (prev == null || next == null) ? 0 : (num(dist(prev, next)) || 0);
    const cost = inA + inB - removed;
    if(cost < bestCost){ bestCost = cost; bestAt = k; }
  }
  if(bestAt == null) return [...rest, id];            // nothing measurable — park it last
  return [...rest.slice(0, bestAt), id, ...rest.slice(bestAt)];
}

/** Reorder the pending sequence so today's committed orders lead — in their
 *  existing relative order — with everything else after. This is the "finish
 *  today before tomorrow" rule; it never reshuffles WITHIN either group, so the
 *  optimizer's geographic order is preserved inside today's set and inside the
 *  remaining days. Feeding this to scheduleRouteConstraints with
 *  `day1Count = today's set size` yields contiguous days with today first. */
export function orderAnchorFirst(pendingSeq, day1Ids){
  const set = new Set((day1Ids || []).map(String));
  const first = [], rest = [];
  for(const id of (pendingSeq || []).map(String)) (set.has(id) ? first : rest).push(id);
  return [...first, ...rest];
}
