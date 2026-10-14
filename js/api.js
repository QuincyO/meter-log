// ── Thin fetch wrappers over the Apps Script spine ──────────────────────────
// apiGet/apiPost inject the token + Web App URL from cfg() so call sites stop
// repeating that plumbing. They throw on a network failure (callers keep their
// own try/catch); the offline queue (queue.js) does NOT go through apiPost — it
// posts raw queued bodies directly so it can own retry semantics.
import { cfg } from './store.js';
import { enc } from './dom.js';

// Fetch once, retry a single time on a network-layer throw. Mobile browsers
// routinely drop the first fetch right after a WiFi sleep/wake (the same event
// that leaves navigator.onLine stuck false) — one retry turns that transient
// into a successful load instead of a "Couldn't load" toast. A real offline
// still fails on the retry and throws, so callers' catch handling is unchanged.
// Reads are idempotent; queued writes carry client ids, so a retried POST can't
// duplicate.
async function fetchRetry(url, opts){
  try { return await fetch(url, opts); }
  catch { return await fetch(url, opts); }
}

// The office pages' admin password (js/admin-auth.js stores it after a
// successful login). Attached to every call when present; the spine only looks
// at it for its ADMIN_GET/ADMIN_POST actions, so the capture page — which never
// logs in — is unaffected. Deliberately NOT a named export or import: api.js is
// on the capture page's critical path, and per-file shell skew makes a new
// named binding a link error waiting to happen (AGENTS.md, cross-file contract).
function adminKey(){
  try { return localStorage.getItem('adminKey') || ''; } catch { return ''; }
}
// A refused key is cleared, and the gate (if this page has one) is told via a
// window hook — again no import, so a page without admin-auth.js ignores it.
function checkAdmin(res){
  if(res && res.ok === false && res.error === 'admin required'){
    try { localStorage.removeItem('adminKey'); } catch {}
    try { if(typeof window.__onAdminRequired === 'function') window.__onAdminRequired(); } catch {}
  }
  return res;
}

// GET ?token=…&action=…&<params>. `params` values are URL-encoded.
export async function apiGet(action, params = {}){
  const c = cfg();
  let u = `${c.url}?token=${enc(c.token)}&action=${enc(action)}`;
  const ak = adminKey();
  if(ak) u += `&adminKey=${enc(ak)}`;
  for(const k in params){
    const v = params[k];
    if(v !== undefined && v !== null) u += `&${k}=${enc(v)}`;
  }
  return checkAdmin(await (await fetchRetry(u)).json());
}

// Optional observer for direct writes — the capture page's activity log
// (js/activity-log.js) registers it; no other page does. It receives the
// CALLER's body (the token is merged in below and never passed on) and must not
// be able to change what apiPost returns or throws, hence the fence.
let _postHook = null;
export function setApiHook(fn){ _postHook = fn; }

// POST {token, ...body}. text/plain dodges the CORS preflight.
export async function apiPost(body){
  const c = cfg();
  const t0 = Date.now();
  let res, error;
  try {
    const ak = adminKey();
    const resp = await fetchRetry(c.url, {
      method:'POST', headers:{'Content-Type':'text/plain'},
      body: JSON.stringify(Object.assign(ak ? { token:c.token, adminKey:ak } : { token:c.token }, body))
    });
    res = checkAdmin(await resp.json());
    return res;
  } catch(e){ error = e; throw e; }
  finally { if(_postHook) try { _postHook({ body, res, error, ms: Date.now() - t0 }); } catch {} }
}
