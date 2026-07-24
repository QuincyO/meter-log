// ── Worklist duplicate detection + cleanup rules ─────────────────────────────
// The worklist is built from GPS pins labelled with nothing but a work-order
// number, entered by hand and synced across devices, so the same WO# can end up
// on the list more than once — two cards, one order. This module holds the pure
// rules for finding those and deciding which single copy survives; the screen
// (worklist.js) owns the IndexedDB deletes and the button.
//
// Pure and DOM-free (like js/drive-track.js / js/compute/*) so `node --test`
// covers the winner rule without a browser.
//
// The WINNER RULE, applied per group of orders sharing a normalized WO#
// (first match wins, most-important first):
//   1. already `wlStatus:'done'`  — a completed order must never be lost or
//      revert to pending, so it outranks everything (even GPS).
//   2. has GPS (`lat` AND `lng` finite) — the routable copy.
//   3. has an address (non-blank).
//   4. otherwise the first in the list's own order.
// Every other copy in the group is removed. Nothing is folded from the losers
// into the winner — the surviving row is kept exactly as it was.

/** Match key for a WO#: trimmed, upper-cased. Mirrors the `norm` used in the
 *  spine's addStop dedup and in markWorklistDone, so grouping matches how a
 *  logged stop completes a planned order. */
export function normalizeWo(v){
  return String(v == null ? '' : v).trim().toUpperCase();
}

// A coord is a real pin only if it's a finite number. Blank ('') and null are
// not pins — and Number('') is 0, so the blank check has to come first.
function coord(v){
  if(v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function hasGps(item){
  return !!item && coord(item.lat) !== null && coord(item.lng) !== null;
}
function hasAddress(item){
  return !!item && !!String(item.address || '').trim();
}
function isDone(item){
  return !!item && item.wlStatus === 'done';
}

/** Rank within a group — LOWER sorts earlier, so index 0 is the winner. The
 *  fourth tier (list order) is handled by keeping the input order stable, so
 *  this only needs the three boolean tiers. */
function rank(item){
  return (isDone(item) ? 0 : 4)
    + (hasGps(item) ? 0 : 2)
    + (hasAddress(item) ? 0 : 1);
}

/** Groups of 2+ orders that share a non-blank normalized WO#, each in the input
 *  list's own order. Orders with a blank WO# are never grouped — an address-only
 *  order is legitimate and must never merge with another blank one. */
export function duplicateGroups(items){
  const by = new Map();   // preserves first-seen (list) order
  for(const item of (items || [])){
    const key = normalizeWo(item && item.workOrderId);
    if(!key) continue;
    if(!by.has(key)) by.set(key, []);
    by.get(key).push(item);
  }
  return [...by.values()].filter(g => g.length > 1);
}

/** The single surviving copy of a duplicate group. Stable: ties (equal rank)
 *  keep the earliest in the input list. */
export function pickWinner(group){
  const g = group || [];
  let best = g[0] || null, bestRank = best ? rank(best) : Infinity;
  for(let i = 1; i < g.length; i++){
    const r = rank(g[i]);
    if(r < bestRank){ best = g[i]; bestRank = r; }
  }
  return best;
}

/** The whole plan: which ids to keep, which to remove, and a count for the
 *  button label. One function so the button's count and the scan action can
 *  never disagree. */
export function dedupePlan(items){
  const groups = duplicateGroups(items);
  const keepIds = new Set();
  const removeIds = [];
  for(const group of groups){
    const winner = pickWinner(group);
    for(const item of group){
      if(item === winner) keepIds.add(String(item.id));
      else removeIds.push(String(item.id));
    }
  }
  return { groups, keepIds, removeIds, dupCount: removeIds.length };
}
