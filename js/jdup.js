// ── Duplicate J# detection for a stop being logged ───────────────────────────
// A J number is a meter's serial: the New J# is the meter going in, the Old J#
// the one coming out. The same serial appearing twice means somebody mistyped or
// double-logged — but which entry is wrong is a judgement call the installer
// makes standing in the driveway, not one this code can make. So this module
// only ever *finds* conflicts. Nothing here rejects, discards or merges a stop;
// both copies are kept and the installer corrects one by hand.
//
// Pure and DOM-free (like js/worklist-dedup.js / js/route-dwell.js) so
// `node --test` covers the rules without a browser. `Code.gs` cannot import an
// ES module, so it carries a hand copy — held to this one by
// tests/jdup-parity.test.mjs.
//
// The MATCH RULE is same-field only:
//   New J# is compared against other stops' New J#, Old J# against other stops'
//   Old J#. NEVER across the two. A meter installed at one house (New J#) and
//   legitimately pulled out of another later (Old J#) carries the same serial in
//   both columns by design; cross-matching would flag every one of those.
//
// ONE carve-out, and it exists because the alternative is a false alarm on the
// crew's most ordinary day: an **Old J# repeated on the SAME work order is not a
// conflict**. A UTI records the old meter's serial, the crew comes back and
// installs — same site, same meter, same order, two rows, correctly. Without the
// carve-out every revisit would block the log. Nothing is lost by it: two real
// installs on one order still surface through the New J# rule (same meter) or
// the spine's WO#-keyed flag (different meter). An Old J# repeated across two
// DIFFERENT orders — the actual mistype — still fires.

/** Match key for a J number: trimmed, upper-cased. Deliberately the same shape
 *  as the ad-hoc `norm` the spine already uses for WO#/J# comparisons, so the
 *  two sides agree on what "the same number" means. Also used on installer
 *  names, which want exactly the same treatment. */
export function normalizeJ(v){
  return String(v == null ? '' : v).trim().toUpperCase();
}

/** The two columns that hold a J number on a Stops row. Order matters only for
 *  the order conflicts are reported in. */
export const J_FIELDS = ['newJNumber', 'oldJNumber'];

/** Human label per field — what the installer sees on the form. */
export const J_LABEL = { newJNumber: 'New J#', oldJNumber: 'Old J#' };

/** The calendar date of a stop timestamp ("2026-07-29 14:02:11" → "2026-07-29").
 *  Both `stamp()` (js/time.js) and `dateOf()` (Code.gs) are Toronto-pinned and
 *  zero-padded, so the prefix compares lexically. Returns '' for anything that
 *  isn't a recognisable stamp. */
export function stopDate(ts){
  const m = String(ts == null ? '' : ts).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** Is this stop on or after `fromDate` (inclusive, "YYYY-MM-DD")? A blank
 *  `fromDate` means no window. An unparseable timestamp is treated as OUTSIDE
 *  the window — a row we can't date can't be shown to the installer as "logged
 *  on …", and a silent match with no date beside it is worse than a miss. */
export function inWindowFrom(ts, fromDate){
  if(!fromDate) return true;
  const d = stopDate(ts);
  return d !== '' && d >= fromDate;
}

/** Every stop that shares a J number with `candidate`, one entry per matching
 *  (stop, field) pair, in the order the stops were given.
 *
 *  opts.from      — "YYYY-MM-DD" inclusive lower bound on the stop timestamp.
 *  opts.installer — only stops logged by this installer (name, normalized).
 *
 *  Four rules, each load-bearing:
 *   - **same-field only** (see the header note);
 *   - **a blank J# never matches** — normalizeJ('') === '' and an empty key is
 *     skipped, or every UTI (which has no New J#) would collide with every
 *     other UTI;
 *   - **self-exclusion by id** — the phone's index is refreshed from the
 *     optimistic dayCache write, so a stop would otherwise find itself;
 *   - **no status filter** — a duplicated Old J# on a UTI or a Visit is just as
 *     real as one on an install. Removed stops are already out of scope on both
 *     sides (the spine keeps them in StopsArchive; dayCache drops them);
 *   - **an Old J# on the same work order is not a conflict** — see the
 *     carve-out in the header note. */
export function jConflicts(candidate, stops, opts){
  const o = opts || {};
  const out = [];
  if(!candidate) return out;
  const selfId = candidate.id == null ? '' : String(candidate.id);
  const who = normalizeJ(o.installer);
  const wo = normalizeJ(candidate.workOrderId);
  for(const stop of (stops || [])){
    if(!stop) continue;
    if(selfId && String(stop.id) === selfId) continue;
    if(who && normalizeJ(stop.installer) !== who) continue;
    if(!inWindowFrom(stop.timestamp, o.from)) continue;
    const sameOrder = wo !== '' && normalizeJ(stop.workOrderId) === wo;
    for(const field of J_FIELDS){
      if(field === 'oldJNumber' && sameOrder) continue;
      const key = normalizeJ(candidate[field]);
      if(!key) continue;
      if(normalizeJ(stop[field]) !== key) continue;
      out.push({ stop: stop, field: field, value: key });
    }
  }
  return out;
}
