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

// `session` is the signed login token (set by auth.js under the 'auth' key); every
// apiGet/apiPost/flush sends it so the spine can authenticate the caller. `token`
// (SHARED_TOKEN) stays as the coarse first gate. name/hNumber are seeded from the
// session at login, so they match the token's identity (installer-ownership compares
// them server-side). Parsed inline here to keep this low-level module free of an
// auth.js import (auth.js imports store, so importing back would be a cycle).
export const cfg = () => {
  let s = null; try { s = JSON.parse(store.get('auth') || 'null'); } catch {}
  return { name:store.get('name')||'', hNumber:store.get('hNumber')||'',
           url:WEB_APP_URL, token:SHARED_TOKEN,
           session:(s && s.token) || '', role:(s && s.role) || '' };
};
