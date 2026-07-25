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

// A rejection that means "this credential isn't good right now" — NOT "this payload
// is bad". Rotating the shared token, an expired/revoked session, or a signed-out
// device all land here. Kept separate from a definitive reject because the write
// itself is perfectly valid and will succeed verbatim once the credential is
// refreshed; counting these toward parking would set aside a whole day's work for
// a reason that has nothing to do with the work.
//
// This is not hypothetical: the spine answers a bad credential with
// {ok:false, error:'bad token'} (Code.gs doPost/doGet), which matches none of the
// transient patterns below. Before this verdict existed, a credential rotation
// parked EVERY queued write on EVERY phone after six flush attempts — surfaced
// only as "N stuck" on the status pill, and recoverable only by a crew member
// noticing and tapping it. Any change to how credentials are issued must keep
// this classification working; tests/queue-policy.test.mjs guards it.
// Kept deliberately tight. `authError` above is the signal the spine should send;
// this only has to recognize the plain-text replies that exist today, and a loose
// pattern here would misfile a genuine poison payload as an auth problem and retry
// it forever instead of parking it.
const AUTH_REJECT_RE = /bad token|unauthoriz|unauthenticat|not authoriz|forbidden|sign in again|(token|session|credential)s? (is |was |has )?(expired|revoked|invalid)|invalid (token|session|credential)/i;
export function isAuthReject(respBody){
  if(!respBody || respBody.ok !== false) return false;
  if(respBody.authError) return true;                  // explicit server signal, preferred
  return AUTH_REJECT_RE.test(respBody.error || '');    // fallback for older/plainer replies
}

// classifyFlush(respOk, respBody, tries) → what to do with a flush attempt:
//   'delivered'   — spine accepted it (ok / duplicate / flagged); drop from queue.
//   'auth'        — the credential was rejected; keep the item, never count a
//                   strike, and let the caller raise a "sign in again" state.
//   'park'        — spine keeps rejecting it; set aside so it can't wedge the FIFO.
//   'retry-count' — a fresh definitive rejection; keep it and count the strike.
//   'retry'       — transient (HTTP error, non-JSON/offline page, lock 'busy,
//                   retry'); keep and try later, never counts toward parking.
// `respOk` is fetch's resp.ok, `respBody` the parsed JSON (or null), `tries` how
// many times this item has already been definitively rejected.
export function classifyFlush(respOk, respBody, tries){
  if(respOk && respBody && (respBody.ok || respBody.duplicate || respBody.flagged)) return 'delivered';
  // Checked before the definitive-reject test below, which would otherwise swallow
  // it: 'bad token' contains neither 'busy' nor 'retry'.
  if(respOk && isAuthReject(respBody)) return 'auth';
  const definitiveReject = respOk && respBody && respBody.ok === false
    && !respBody.duplicate && !respBody.flagged
    && !/busy|retry/i.test(respBody.error || '');   // lock contention is transient
  if(definitiveReject) return (tries + 1) >= MAX_FLUSH_TRIES ? 'park' : 'retry-count';
  return 'retry';
}
