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
  if(c.session) u += `&session=${enc(c.session)}`;
  for(const k in params){
    const v = params[k];
    if(v !== undefined && v !== null) u += `&${k}=${enc(v)}`;
  }
  return (await fetch(u)).json();
}

// POST {token, session, ...body}. text/plain (no custom headers) dodges the CORS
// preflight — the session rides in the body, never an Authorization header.
export async function apiPost(body){
  const c = cfg();
  const resp = await fetch(c.url, {
    method:'POST', headers:{'Content-Type':'text/plain'},
    body: JSON.stringify(Object.assign({ token:c.token, session:c.session }, body))
  });
  return resp.json();
}
