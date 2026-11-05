// ── Today anchor (the LOCKED day-1 set) ─────────────────────────────────────
// The multi-day split (js/route.js, js/route-constraints.js) cuts the PENDING
// list into `target`-sized day chunks from the top. Completed orders are filtered
// out before that math, so Day 1 refills from the front of what's left every time
// a route is optimized/downloaded — which pulls tomorrow's orders up into today
// the moment you finish a few of today's. That is the right behaviour while the
// installer is still PLANNING and exactly the wrong one once they have decided
// which orders they are driving.
//
// So the installer says which. `js/worklist.js` owns a 🔓/🔒 toggle (and
// `js/pages/planner.js` the same one for the office); these helpers are the pure
// layer under its LOCKED half. No DOM, no storage, no network — unit-tested in
// tests/route-today.test.mjs.
//
//   🔓 UNLOCKED — no anchor is read and none is committed. `day1Count` is null and
//      every day is sized by the meters/day target, so changing the target and
//      re-optimizing genuinely re-plans the week.
//   🔒 LOCKED   — the anchor is the frozen set: an ordered list of order IDs plus
//      the date it was locked for and the target it was locked at. Day 1 is that
//      set intersected with pending, ENTIRE. It shrinks as its orders are finished
//      and grows only when the installer taps "Add to today"; nothing else moves it.
//
// THE LOCK PRESS IS THE ONLY COMMIT. That is the whole point of the toggle, and it
// is a deliberate retreat from what used to be here: a `needsCommit` that tried to
// INFER when the installer meant to re-plan, from a target change, an Optimize
// press, a day roll and an exhausted set — plus a `dayCapacity` bound on how far a
// mid-day re-plan could grow the day and a `fromTags` flag for whether the day tags
// could be trusted. Every one of those was a correct fix to a real report, and the
// installer still could not answer "is my day settled right now, and what do I press
// to change it?" Inference is now a toggle, and the machinery is gone rather than
// extended. Two of its lessons are load-bearing and survive as rules:
//   • the target counts METERS and the set counts ORDERS, so nothing PASSIVE may
//     re-size a locked day from meters installed (the one explicit exception is the
//     Optimize press, below). An order carrying two meters, or any walk-up,
//     spends the room faster than it spends the list, and the tail of a committed day
//     used to be stamped day 2 by mid-morning because of it. Installing past the
//     target reads as being AHEAD OF PACE with a later finish clock
//     (js/compute/estimate.js `targetOver`), never as a shorter list;
//   • an EXHAUSTED locked set stays exhausted. A finished day is finished; more work
//     arrives by unlocking, or by hand through "Add to today". It must never roll to
//     the next chunk by itself.
//
// The anchor records the `target` it was locked at so the read-only meters/day box
// can show the number the day was settled on. `anchor.extend` is gone; a legacy
// anchor carrying it is ignored.
//
// ONE deliberate carve-out from "nothing may re-size a locked day from meters
// installed" (2026-11-05): an explicit 🧭 Optimize press WHILE LOCKED plans Day 1 as
// `target − installs logged on the plan day` (installCount / remainingDay1 below),
// chosen fresh from every pending order, and that new Day 1 replaces the frozen set.
// The target is a day's worth of installs set in the morning, so a mid-day re-plan
// that handed back a whole fresh target (24 more after 6 done, instead of the 18
// left) was answering the wrong question. The rule stands for every PASSIVE path —
// a logged stop, the Drive screen's autoSync, a Download, the per-log re-anchor
// never re-size — and the subtraction lives in exactly one call site on each page.

/** Installs logged on a day that count against the meters/day target: the day's
 *  INSTALLED stops, and only those — list orders and walk-ups alike, because a meter
 *  is a meter whoever planned it. A UTI spends no meter; a VISITED or UNACCOUNTED
 *  stop installed nothing either (owner's call, 2026-11-05: "I only want installs to
 *  count"); the coordinates-only DONE marker never counts. This is deliberately
 *  narrower than the pace gauge's `done` (every PRINTABLE status), which answers a
 *  different question — stops worked, not meters installed. */
export function installCount(stops){
  return (stops || []).filter(s => s && s.status === 'INSTALLED').length;
}

/** How big a LOCKED Optimize plans Day 1: the target less the installs, floored at
 *  zero. ZERO IS A REAL ANSWER — the day's target is met, so Day 1 holds nothing and
 *  everything falls to Day 2+; unlocking is how the crew asks for more. `null` only
 *  when there is no usable target, which route.js / route-constraints.js read as
 *  "unset" (size Day 1 by the target like any other day). */
export function remainingDay1(target, installs){
  const t = Math.floor(Number(target));
  if(!isFinite(t) || t <= 0) return null;
  return Math.max(0, t - Math.max(0, Math.floor(Number(installs) || 0)));
}

/** The pending orders tagged day 1 EXACTLY, in list order. Unlike `taggedDay1Ids`
 *  (the lowest tagged day — right for the 🔒 press, which freezes the day on screen)
 *  this does not slide to day 2 when day 1 is empty: the anchor written after a
 *  locked Optimize that planned an empty Day 1 must freeze EMPTY, or tomorrow's
 *  orders become today's the moment the target is met. */
export function strictDay1Ids(pending){
  return (pending || []).filter(p => p && Number(p.day) === 1).map(p => String(p.id));
}

function anchorIdSet(anchor){
  return new Set(((anchor && anchor.ids) || []).map(String));
}

/** The committed order IDs that are still pending, in the pending list's order.
 *  Shrinks as orders are finished/removed; empty once today's set is exhausted. */
export function anchorDay1Ids(anchor, pending){
  const set = anchorIdSet(anchor);
  return (pending || []).filter(p => p && set.has(String(p.id))).map(p => String(p.id));
}

/** The meters/day target this set was locked at — what the read-only meters/day box
 *  shows while the lock is on. `null` for a legacy `{date, ids}` anchor written
 *  before the field existed, and for one written by a build that had no lock. */
export function anchorTarget(anchor){
  const n = Math.floor(Number(anchor && anchor.target));
  return isFinite(n) && n > 0 ? n : null;
}

/** How many stops Day 1 holds while the list is LOCKED: the frozen set, entire.
 *  Feeds scheduleRouteConstraints' `opts.day1Count` — which is deliberately NOT
 *  passed at all while unlocked, so days size by the target like any other day.
 *
 *  It used to take a capacity and return `min(capacity + extend, |set|)`, which is
 *  the re-sizing the header is about. Nothing overflows to Day 2 any more: an order
 *  leaves today by being finished, or because the installer moved it. ZERO is a real
 *  answer (a locked day whose work is done), not "unset" — see route-constraints.js. */
export function day1Count(day1Ids){
  return (day1Ids || []).length;
}

/** The pending orders carrying the LOWEST `day` tag — the route's current day 1, as
 *  last stamped by an Optimize or a Download. `[]` when nothing is tagged at all
 *  (a list that has never been routed).
 *
 *  Two callers, and they want it for different reasons. `freshAnchorIds` uses it as
 *  the set to freeze, because the tagged group is literally what is on the screen the
 *  installer is looking at when they press 🔒. `applyTodayAnchor` uses its SIZE while
 *  UNLOCKED, to hold the day steady across the passive re-schedules (a logged stop,
 *  the Drive screen's 3-minute refresh, a Download) — an unlocked day is one a
 *  deliberate act may re-plan, not one that re-plans itself in the background. */
export function taggedDay1Ids(pending){
  const list = pending || [];
  const days = list
    .map(p => (p && p.day !== '' && p.day != null && isFinite(Number(p.day))) ? Number(p.day) : null)
    .filter(d => d != null);
  if(!days.length) return [];
  const minDay = Math.min(...days);
  return list.filter(p => Number(p.day) === minDay).map(p => String(p.id));
}

/** The set to freeze at the moment the installer presses 🔒: the route's current
 *  day-1 group, whatever sized it — the last Optimize, the office's chunking, an
 *  appointment day. Only a never-routed list (no day tags at all) falls back to the
 *  first `target` orders by count. `pending` is the pending items in list order.
 *
 *  There is exactly one caller and one mode now. It used to carry `opts.max` (a
 *  `dayCapacity` bound on a mid-day target raise) and `opts.fromTags` (whether the
 *  tags described the target being frozen at) — both existed to make an INFERRED
 *  re-commit behave, and neither has anything to infer once the press is the only
 *  commit there is. */
export function freshAnchorIds(pending, target){
  const tagged = taggedDay1Ids(pending);
  if(tagged.length) return tagged;
  const t = Math.max(1, Math.floor(Number(target) || 1));
  return (pending || []).slice(0, t).map(p => String(p.id));
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
