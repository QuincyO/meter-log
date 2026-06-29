// ── offline queue (IndexedDB-backed) ────────────────────────────────────────
// Un-synced writes live in the IndexedDB 'queue' store, not localStorage — it's
// the system of record until each write reaches the Sheet, so it must be durable
// (localStorage gets evicted under storage pressure on mobile). The
// auto-increment '_seq' key gives FIFO order: idb.all('queue') returns items
// oldest-first, so q[0] is the head.
import { idb } from './idb.js';
import { cfg } from './store.js';
import { $ } from './dom.js';
import { applyOptimisticCache, reconcileCache } from './daycache.js';

const queueAll = async () => (await idb.all('queue')) || [];

// A page registers UI side-effects here (e.g. the duplicate/conflict notice, the
// session-expired prompt). Keeps the queue page-agnostic — no import back into a page.
let _hooks = { onResult: null, onAuthFail: null };
export function setQueueHooks(h){ Object.assign(_hooks, h); }

// Client-generated id so a write is idempotent: the same queued item keeps its
// id across retries, and the spine skips it if that id was already appended.
const newId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 8);
export async function enqueue(payload){
  if((payload.action==='addStop' || payload.action==='addDowntime') && !payload.id) payload.id = newId();
  await idb.put('queue', payload);   // auto-assigns _seq; preserves order
  paint(); flush();
  applyOptimisticCache(payload);     // async fire-and-forget — updates the day copy immediately
}

// One-time migration: drain any queue left in localStorage by the pre-IDB build
// into the durable store, then drop the old key so nothing is lost on upgrade.
export async function migrateLegacyQueue(){
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem('queue') || '[]'); } catch { legacy = []; }
  if(!Array.isArray(legacy) || !legacy.length) return;
  for(const item of legacy){ const {_seq, ...rest} = item || {}; await idb.put('queue', rest); }
  try { localStorage.removeItem('queue'); } catch {}
}

// Re-entrancy guard: flush() is triggered from enqueue + online/focus/visibility +
// explicit awaits, which fire near-simultaneously when signal returns. Without this,
// two concurrent runs each take their own queue snapshot and re-send/lose items.
let flushing = false;
export async function flush(){
  if(flushing) return;
  const c = cfg(); if(!c.url || !navigator.onLine) { paint(); return; }
  flushing = true;
  try{
    while(true){
      const q = await queueAll();   // re-read each pass so a mid-flush enqueue is picked up
      if(!q.length) break;
      const item = q[0];            // lowest _seq = head of the queue
      const {_seq, ...body} = item; // _seq is an internal key — don't send it
      let resp;
      try{
        // Inject the CURRENT session fresh on every attempt (not at enqueue time):
        // a write may have sat queued for days, so a re-login heals the backlog.
        const send = Object.assign({}, body, { token:cfg().token, session:cfg().session });
        resp = await fetch(c.url, { method:'POST', headers:{'Content-Type':'text/plain'},
                                    body: JSON.stringify(send) });   // text/plain dodges CORS preflight
      } catch { break; }            // genuine network failure — keep the whole queue for next trigger
      let respBody = null;
      try { respBody = await resp.json(); } catch {}
      // A rejected session keeps the item (it's never dropped) and asks the page to
      // prompt a re-login; once signed in, the next flush attaches the new token.
      if(respBody && (respBody.error === 'auth' || respBody.error === 'forbidden')){
        if(_hooks.onAuthFail) _hooks.onAuthFail(respBody);
        break;
      }
      // Only a real 2xx with a recognized result counts as delivered. An HTTP error
      // (500 / quota / timeout page) or a transient {ok:false} is KEPT and retried —
      // a busy-window failure must never silently drop a logged stop. The client id
      // makes the eventual retry idempotent, so a timed-out-but-succeeded write
      // (where we never saw the response) won't duplicate.
      const delivered = resp.ok && respBody && (respBody.ok || respBody.duplicate || respBody.flagged);
      if(!delivered) break;
      await idb.del('queue', _seq);   // remove the head only on a genuine success
      reconcileCache(respBody, body);          // swap temp ids, mirror dispatch side-effect
      if(_hooks.onResult) _hooks.onResult(respBody, body);
    }
  } finally { flushing = false; }
  paint();
}

export async function paint(){
  const p = $('status'), t = $('statusText');
  if(!p || !t) return;                         // a page without the status pill — no-op
  const n = (await queueAll()).length;
  p.classList.remove('wait','off');
  if(!navigator.onLine){ p.classList.add('off'); t.textContent = n ? n+' waiting — offline' : 'Offline'; }
  else if(n){ p.classList.add('wait'); t.textContent = n+' sending…'; }
  else t.textContent = 'All synced';
}
