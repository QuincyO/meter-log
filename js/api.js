// ── Thin fetch wrappers over the Apps Script spine ──────────────────────────
// apiGet/apiPost inject the token + Web App URL from cfg() so call sites stop
// repeating that plumbing. They throw on a network failure (callers keep their
// own try/catch); the offline queue (queue.js) does NOT go through apiPost — it
// posts raw queued bodies directly so it can own retry semantics.
import { cfg } from './store.js';
import { enc } from './dom.js';

// GET ?token=…&action=…&<params>. `params` values are URL-encoded.
export async function apiGet(action, params = {}){
  const c = cfg();
  let u = `${c.url}?token=${enc(c.token)}&action=${enc(action)}`;
  for(const k in params){
    const v = params[k];
    if(v !== undefined && v !== null) u += `&${k}=${enc(v)}`;
  }
  return (await fetch(u)).json();
}

// POST {token, ...body}. text/plain dodges the CORS preflight.
export async function apiPost(body){
  const c = cfg();
  const resp = await fetch(c.url, {
    method:'POST', headers:{'Content-Type':'text/plain'},
    body: JSON.stringify(Object.assign({ token:c.token }, body))
  });
  return resp.json();
}
