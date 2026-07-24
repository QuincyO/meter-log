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

function anchorIdSet(anchor){
  return new Set(((anchor && anchor.ids) || []).map(String));
}

/** The committed order IDs that are still pending, in the pending list's order.
 *  Shrinks as orders are finished/removed; empty once today's set is exhausted. */
export function anchorDay1Ids(anchor, pending){
  const set = anchorIdSet(anchor);
  return (pending || []).filter(p => p && set.has(String(p.id))).map(p => String(p.id));
}

/** Do we need to (re)commit today's set?
 *   - nothing pending            → no (nothing to anchor)
 *   - no anchor / a stale date    → yes (first route of a new day)
 *   - today's committed set empty → yes (all finished → roll to the next chunk)
 *  Otherwise the frozen set still has work on it, so leave it exactly as it is. */
export function needsCommit(anchor, today, pending){
  if(!(pending && pending.length)) return false;
  if(!anchor || anchor.date !== today) return true;
  return anchorDay1Ids(anchor, pending).length === 0;
}

/** The set to freeze when committing today. Prefer the route's CURRENT day-1
 *  group (the pending orders already tagged with the lowest `day`) so the freeze
 *  honours whatever sized that day — the optimizer's time-capacity shrink, the
 *  office's chunking, an appointment day. Only a never-routed list (no day tags at
 *  all) falls back to the first `target` orders by count. `pending` is the pending
 *  items in list order. */
export function freshAnchorIds(pending, target){
  const t = Math.max(1, Math.floor(Number(target) || 1));
  const list = pending || [];
  const days = list
    .map(p => (p && p.day !== '' && p.day != null && isFinite(Number(p.day))) ? Number(p.day) : null)
    .filter(d => d != null);
  if(days.length){
    const minDay = Math.min(...days);
    const group = list.filter(p => Number(p.day) === minDay).map(p => String(p.id));
    if(group.length) return group;
  }
  return list.slice(0, t).map(p => String(p.id));
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
