// Pure flush-outcome policy for the offline queue (js/queue.js). No browser deps,
// so the wedge-avoidance logic is unit-tested (tests/queue-policy.test.mjs).
//
// Background: flush() drains the FIFO head-first and only removes an item the spine
// *accepts*. Historically it stopped at the first item it couldn't deliver — so a
// single write the spine permanently rejects (a poison payload: an old/unknown
// action, a validation the server enforces, a malformed body) wedged EVERY write
// queued behind it, indefinitely. This policy tells transient failures (keep
// retrying) apart from definitive rejections (retry a few times, then PARK so the
// rest of the queue keeps draining) — a parked item is set aside, never dropped.

// Tries a definitively-rejected item gets before parking, so brief lock contention
// ('busy, retry') or a transient spine hiccup has a chance to clear on its own.
export const MAX_FLUSH_TRIES = 6;

// classifyFlush(respOk, respBody, tries) → what to do with a flush attempt:
//   'delivered'   — spine accepted it (ok / duplicate / flagged); drop from queue.
//   'park'        — spine keeps rejecting it; set aside so it can't wedge the FIFO.
//   'retry-count' — a fresh definitive rejection; keep it and count the strike.
//   'retry'       — transient (HTTP error, non-JSON/offline page, lock 'busy,
//                   retry'); keep and try later, never counts toward parking.
// `respOk` is fetch's resp.ok, `respBody` the parsed JSON (or null), `tries` how
// many times this item has already been definitively rejected.
export function classifyFlush(respOk, respBody, tries){
  if(respOk && respBody && (respBody.ok || respBody.duplicate || respBody.flagged)) return 'delivered';
  const definitiveReject = respOk && respBody && respBody.ok === false
    && !respBody.duplicate && !respBody.flagged
    && !/busy|retry/i.test(respBody.error || '');   // lock contention is transient
  if(definitiveReject) return (tries + 1) >= MAX_FLUSH_TRIES ? 'park' : 'retry-count';
  return 'retry';
}
