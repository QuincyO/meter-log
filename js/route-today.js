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
// THE FROZEN SET IS THE DAY. Its membership changes on an explicit act and on
// nothing else: a new day, a Download, an Optimize press, a target change, or the
// installer tapping "Add to today". It shrinks as its orders are finished, and that
// is the only shrink there is.
//
// It did not used to be. Day 1 was sized `min(dayCapacity + extend, |set ∩ pending|)`,
// where `dayCapacity` was the meters/day target minus the meters actually installed
// today — so the day RE-SIZED ITSELF all day long, and `anchor.extend` existed to buy
// the room back when the installer agreed to work past it. Two things were wrong with
// that, and the field found both:
//   • the target is in METERS and the set is in ORDERS. An order carrying two meters
//     burns capacity twice as fast as it burns membership, so the tail of a list the
//     installer had committed to was stamped day 2 by mid-morning — and every walk-up
//     found in the field did the same thing to orders nobody had touched;
//   • once the target was MET with orders still pending, capacity hit 0, Day 1 held
//     nothing, and every remaining order was stamped day 2+ — a full day's work
//     silently declared tomorrow's.
// Reported as *"the next day's work orders are shuffling up every time … I download
// the WORK list when I start my day, I say I'm going to do X, and I want it to stay
// at that."* The 5-minute Drive refresh re-ran the whole thing on a timer, which is
// what made it constant. Installing extra now reads as being AHEAD OF PACE with a
// later finish clock (js/compute/estimate.js `targetOver`), never as a shorter list.
//
// `dayCapacity` survives for one narrow job — bounding an explicit mid-day target
// raise, see below. `anchor.extend` is gone; a legacy anchor carrying it is ignored.
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

/** The meters/day target this set was frozen under. `null` for a legacy `{date, ids}`
 *  anchor written before the field existed — which needsCommit deliberately reads as
 *  "unknown, so re-plan on the next Optimize", the one-shot that unsticks a day frozen
 *  by a target nobody can recover. */
export function anchorTarget(anchor){
  const n = Math.floor(Number(anchor && anchor.target));
  return isFinite(n) && n > 0 ? n : null;
}

/** Room a DELIBERATE mid-day re-plan may grow the day into: the meters/day target
 *  minus every meter already installed today, planned orders and walk-ups alike.
 *
 *  This is NOT the day's size — nothing here trims a set the installer has already
 *  committed to (see the header). Its one caller is `freshAnchorIds`' `opts.max` on
 *  the path where the installer raises the target at noon: growing today is their
 *  call to make, but growing it by a whole fresh target would haul up work the
 *  afternoon plainly cannot hold. Zero means a day already at its target, so an
 *  explicit re-plan adds nothing — it does not take anything away either. */
export function dayCapacity(target, installedToday){
  const t = Math.max(1, Math.floor(Number(target) || 1));
  const done = Math.max(0, Math.floor(Number(installedToday) || 0));
  return Math.max(0, t - done);
}

/** How many stops Day 1 holds: today's committed set, entire. Feeds
 *  scheduleRouteConstraints' `opts.day1Count`.
 *
 *  It used to take a capacity and return `min(capacity + extend, |set|)`, which is
 *  the re-sizing the header is about. Nothing overflows to Day 2 any more: an order
 *  leaves today by being finished, or because the installer moved it. */
export function day1Count(day1Ids){
  return (day1Ids || []).length;
}

/** Do we need to (re)commit today's set?
 *   - nothing pending             → no (nothing to anchor)
 *   - no anchor / a stale date     → yes (first route of a new day)
 *   - today's committed set empty  → only on an explicit re-plan (see below)
 *   - a re-plan whose target moved → yes (see below)
 *  Otherwise the frozen set still has work on it, so leave it exactly as it is.
 *  Deliberately keyed on the set's IDENTITY, never on dayCapacity: a day whose
 *  target is met still owns its unfinished orders, and hitting the target neither
 *  rolls tomorrow's work in nor pushes today's leftovers out.
 *
 *  `opts` = `{replan, target}`. Exactly TWO callers pass it: an explicit Optimize,
 *  and the meters/day box's own `change`. They differ in whether the day tags are
 *  fresh — Optimize has just re-solved them at the new target, the box has not —
 *  which is what `freshAnchorIds`' `opts.fromTags` exists to say. Every other caller
 *  (a logged stop, a Download, first view) passes nothing and keeps today frozen
 *  exactly as before. An Optimize at an UNCHANGED target must still not re-commit,
 *  or re-optimizing after finishing a few orders pulls tomorrow's work up — the
 *  whole reason the anchor exists. A legacy anchor (no stored target) reads as
 *  changed, so the first Optimize after this shipped re-plans once and then the
 *  field is always there. */
export function needsCommit(anchor, today, pending, opts){
  if(!(pending && pending.length)) return false;
  if(!anchor || anchor.date !== today) return true;
  // An exhausted set does NOT roll to the next chunk by itself. "I said I'd do X"
  // means the day ends at X; pulling tomorrow's orders up is the installer's call,
  // and an explicit re-plan (the Optimize press, or adding an order by hand) is how
  // they make it. Every PASSIVE caller — a logged stop, a Download, first view, the
  // 5-minute Drive refresh — leaves today finished and empty, which is the honest
  // reading of a completed day. `replan` here is deliberately not also conditioned on
  // a changed target: with the set spent there is nothing left to protect, so the
  // press means "give me more work today" whatever the target says.
  if(anchorDay1Ids(anchor, pending).length === 0) return Boolean(opts && opts.replan);
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
 *  `opts.max` caps how many orders may be frozen — the day's REMAINING room
 *  (`dayCapacity`), used when a mid-day re-plan raises the target. Without it,
 *  changing the target at noon would haul a whole fresh target's worth of tomorrow's
 *  orders into a day that is already half spent. It is now the ONLY place capacity
 *  touches the day at all, and it only ever bounds GROWTH the installer asked for —
 *  it can never trim a set already committed. Omitted ⇒ unbounded, which is the right
 *  answer for a day that has not started or is already closed out.
 *
 *  `opts.fromTags` (default TRUE) is whether those day tags can be trusted to
 *  describe the target being frozen at. Preferring them is right after an Optimize,
 *  which re-solves them at the new target immediately before committing. It is wrong
 *  when nothing has re-solved them — the meters/day box on its own — because the tags
 *  then still describe the OLD target, and preferring them makes a RAISED target do
 *  nothing at all: `min(capacity, group.length)` is capped by a group sized for the
 *  smaller number. Lowering still worked (capacity clamps it), so the control was
 *  silently one-way. Pass `false` and the set is taken by count instead; the
 *  appointment and lock constraints are re-imposed afterwards by
 *  `scheduleRouteConstraints`, so nothing timed is lost by ignoring the tags here. */
export function freshAnchorIds(pending, target, opts){
  const t = Math.max(1, Math.floor(Number(target) || 1));
  // `null`/absent is UNBOUNDED, and must not coerce to Number(null) === 0 — that
  // would silently freeze an empty day on the very path that means "no limit".
  const rawMax = (opts && opts.max != null) ? Math.floor(Number(opts.max)) : NaN;
  const max = isFinite(rawMax) && rawMax >= 0 ? rawMax : null;
  const cap = ids => max == null ? ids : ids.slice(0, max);
  const list = pending || [];
  // Absent ⇒ true: every existing caller relies on the tag preference.
  const fromTags = !(opts && opts.fromTags === false);
  const days = !fromTags ? [] : list
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
