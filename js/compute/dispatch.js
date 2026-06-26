// ── Client-side dispatch downtime ───────────────────────────────────────────
// "Dispatch" downtime is the wait between asking dispatch for a meter and getting
// on it. The phone computes it instantly when a "Requested meter?" stop is
// logged, so the live spine write stays a cheap append. The authoritative global
// match + Metrics refresh run once at end of day on the spine (off-peak).
//
// Source data: today's Dispatch requests (GET ?action=dispatch) + the stored
// running average (GET ?action=avgDispatchTime), both fetched best-effort while
// online and cached so an offline log still gets the estimate.
import { apiGet } from '../api.js';
import { store } from '../store.js';
import { parseLocalMs } from '../time.js';

const AVG_KEY = 'dispatchAvg';   // last-known running average, persisted for offline use
let _rows = null;                // today's Dispatch rows, cached in-memory for the session
let _avg  = null;

// Warm the caches from the spine (online only; safe to call repeatedly).
export async function refreshDispatch(){
  if(!navigator.onLine) return;
  try{ const d = await apiGet('dispatch'); if(d && d.ok && Array.isArray(d.dispatch)) _rows = d.dispatch; } catch {}
  try{
    const a = await apiGet('avgDispatchTime');
    if(a && a.ok && a.avgDispatchTime != null){ _avg = Number(a.avgDispatchTime); store.set(AVG_KEY, _avg); }
  } catch {}
}

function cachedAvg(){
  if(_avg != null) return _avg;
  const v = store.get(AVG_KEY);
  return (v == null || v === '') ? null : Number(v);
}

// Compute the dispatch downtime for a just-logged requested stop.
//   measured: the latest pending request with the same oldJ at/before the stop's
//             time (from the fetched Dispatch rows) → exact wait.
//   estimate: no local request data (offline / none matched) → the running avg.
//   null:     nothing to report (no match and no average yet).
// The spine's end-of-day reconcile later upgrades an estimate to the true
// measured value, so a wrong-guess offline never sticks.
export function computeDispatchDowntime(oldJ, stopTime){
  const norm = v => String(v == null ? '' : v).trim().toUpperCase();
  const key = norm(oldJ);
  const sMs = parseLocalMs(stopTime);
  if(key && sMs != null && Array.isArray(_rows)){
    let best = null;
    _rows.forEach(r => {
      if(norm(r.oldJNumber) !== key) return;
      const rMs = parseLocalMs(r.requestTime);
      if(rMs == null || rMs > sMs) return;
      if(!best || rMs > best) best = rMs;   // latest request at/before the stop
    });
    if(best != null) return { minutes: Math.max(0, Math.round((sMs - best)/60000)), measured: true };
  }
  const avg = cachedAvg();
  return avg == null ? null : { minutes: avg, measured: false };
}
