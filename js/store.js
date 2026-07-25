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

// The session rides here too: it is a small string read synchronously before every
// request, which is exactly what this module is for, and losing it costs a sign-in
// rather than any data. `authExp` is epoch ms — the Monday the spine issued it for.
export const cfg = () => ({
  name:    store.get('name')    || '',
  hNumber: store.get('hNumber') || '',
  url: WEB_APP_URL, token: SHARED_TOKEN,
  auth:     store.get('auth')     || '',
  authExp:  Number(store.get('authExp') || 0),
  authH:    store.get('authH')    || '',
  authRole: store.get('authRole') || '',
  authName: store.get('authName') || '',
});

/** The ONE place that knows what a request is authenticated with — used by both
 *  api.js (direct calls) and queue.js (queued writes, resolved at send time, never
 *  stored on the item). Swapping credentials should touch this function and nothing
 *  else; see AGENTS.md §"Security note".
 *
 *  Both are sent while the migration window is open. The spine prefers the session
 *  and only falls back to the shared token while REQUIRE_AUTH is off — and signup/
 *  login still REQUIRE the token, since by definition they have no session yet.
 *  An expired session is deliberately still sent: it earns a precise 'session
 *  expired' from the spine, which the queue reads as "wait for sign-in" rather than
 *  as a poison payload, where omitting it would look like no credential at all. */
export function authFields(){
  const c = cfg();
  const f = {};
  if(c.token) f.token = c.token;
  if(c.auth)  f.auth  = c.auth;
  return f;
}
