// ── Trivial synchronous device config (localStorage) ────────────────────────
// Policy: durable offline DATA lives in IndexedDB (see idb.js / daycache.js).
// localStorage holds only the person's name + H number, read synchronously by
// cfg() all over the UI. Losing it just re-prompts for a name — no data loss.
import { WEB_APP_URL, SHARED_TOKEN } from './config.js';

// Falls back to an in-memory map if localStorage is blocked (e.g. a sandboxed preview).
export const store = (() => {
  let mem = {};
  try { localStorage.setItem('__t','1'); localStorage.removeItem('__t');
        return { get:k=>localStorage.getItem(k), set:(k,v)=>localStorage.setItem(k,v) }; }
  catch { return { get:k=>mem[k]??null, set:(k,v)=>{mem[k]=String(v)} }; }
})();

export const cfg = () => ({ name:store.get('name')||'', hNumber:store.get('hNumber')||'', url:WEB_APP_URL, token:SHARED_TOKEN });
