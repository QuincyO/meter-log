// ── offline queue (IndexedDB-backed) ────────────────────────────────────────
// Un-synced writes live in the IndexedDB 'queue' store, not localStorage — it's
// the system of record until each write reaches the Sheet, so it must be durable
// (localStorage gets evicted under storage pressure on mobile). The
// auto-increment '_seq' key gives FIFO order: idb.all('queue') returns items
// oldest-first, so q[0] is the head.
import { idb } from './idb.js';
import { cfg, authFields } from './store.js';
import { $, activeActivity, onActivityChange } from './dom.js';
import { applyOptimisticCache, reconcileCache } from './daycache.js';
import { classifyFlush } from './queue-policy.js';

// The credential a queued write is sent with is resolved at SEND time (below, via
// authFields) — it is deliberately NOT stored on the item. Queued writes can sit in
// IndexedDB for days (a phone offline on the water, a parked item awaiting review),
// and a credential that was current at enqueue() time may well have been rotated,
// expired or replaced by then. Baking it in at enqueue was how a token rotation used
// to strand a whole day of work.
//
// authFields lives in store.js so that ONE function serves both the queue and the
// direct api.js calls; it now returns a per-user session alongside the shared token.
// Do not re-add a local copy here.

const queueAll = async () => (await idb.all('queue')) || [];

// A page registers UI side-effects here (e.g. the duplicate/conflict notice).
// Keeps the queue page-agnostic — no import back into a specific page.
let _hooks = { onResult: null, onAuthRequired: null };
export function setQueueHooks(h){ Object.assign(_hooks, h); }

// Client-generated id so a write is idempotent: the same queued item keeps its
// id across retries, and the spine skips it if that id was already appended.
const newId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 8);
export async function enqueue(payload){
  if((payload.action==='addStop' || payload.action==='addDowntime') && !payload.id) payload.id = newId();
  await idb.put('queue', payload);   // auto-assigns _seq; preserves order
  // Update the day copy BEFORE flush can reach the server: an awaited enqueue()
  // is then guaranteed to see the optimistic state (e.g. the archiveStop
  // tombstone) when it re-renders, and reconcileCache never races the write.
  await applyOptimisticCache(payload);
  paint(); flush();
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
// Whether the last flush attempt failed at the network layer. This — not the
// unreliable navigator.onLine — drives the "offline" pill: some mobile browsers
// leave navigator.onLine stuck at a false `false` after a WiFi sleep/wake, which
// used to wedge the whole queue. We now always attempt the send and let the real
// fetch outcome decide.
let lastFlushFailed = false;
// Whether the last flush stopped because the spine rejected our credential. Drives
// the pill's "sign in to sync" wording, and is cleared by the next delivered write.
let needsAuth = false;
export const authBlocked = () => needsAuth;
export async function flush(){
  if(flushing) return;
  needsAuth = false;   // re-evaluated by this run; a fresh credential clears it
  const c = cfg(); if(!c.url) { paint(); return; }
  flushing = true;
  try{
    while(true){
      const q = await queueAll();   // re-read each pass so a mid-flush enqueue is picked up
      // Skip parked (poison) items: they've been definitively rejected too many
      // times and are set aside so they can't wedge the writes queued behind them.
      const item = q.find(it => !it._parked);
      if(!item) break;
      // Drop the internal keys AND any credential the item was stored with — items
      // enqueued by an older build carry a `token` that may be long rotated. The
      // current one is spread in below, so a stale snapshot can never be sent.
      const {_seq, _tries, _parked, _error, token:_staleToken, ...stored} = item;
      const body = { ...stored, ...authFields() };
      let resp;
      try{
        resp = await fetch(c.url, { method:'POST', headers:{'Content-Type':'text/plain'},
                                    body: JSON.stringify(body) });   // text/plain dodges CORS preflight
      } catch { lastFlushFailed = true; break; }   // genuine network failure — keep the whole queue for next trigger
      let respBody = null;
      try { respBody = await resp.json(); } catch {}
      // classifyFlush distinguishes delivered / poison / transient. The client id
      // makes any eventual retry idempotent, so a timed-out-but-succeeded write
      // (where we never saw the response) won't duplicate.
      const verdict = classifyFlush(resp.ok, respBody, _tries || 0);
      if(verdict === 'delivered'){
        lastFlushFailed = false;        // a real send got through — we're reaching the server
        await idb.del('queue', _seq);   // remove only on a genuine accept
        reconcileCache(respBody, body);          // swap temp ids, mirror dispatch side-effect
        if(_hooks.onResult) _hooks.onResult(respBody, body);
        continue;
      }
      if(verdict === 'auth'){
        // The credential was rejected. The write is fine — it will go through
        // verbatim once the device has a good credential again — so the item keeps
        // its place and its strike count. Stop draining (every item behind it would
        // fail identically) and surface it so the UI can prompt a sign-in.
        lastFlushFailed = false;        // we reached the spine; this isn't an offline state
        needsAuth = true;
        if(_hooks.onAuthRequired) _hooks.onAuthRequired(respBody);
        break;
      }
      if(verdict === 'park'){
        // The spine keeps rejecting this item — a poison payload. Set it aside so it
        // stops blocking everything behind it, but never drop it: it stays in the
        // durable queue, flagged, and is surfaced (pill + notice) for review/retry.
        lastFlushFailed = false;        // we reached the server — this isn't an offline state
        const why = respBody && respBody.error;
        await idb.put('queue', { ...item, _tries: (_tries || 0) + 1, _parked: true, _error: why });
        if(_hooks.onResult) _hooks.onResult({ parked: true, error: why }, body);
        continue;                       // keep draining the rest of the queue
      }
      if(verdict === 'retry-count'){
        lastFlushFailed = false;        // the spine answered — just not success yet
        await idb.put('queue', { ...item, _tries: (_tries || 0) + 1 });
        break;                          // a few more tries on later triggers before parking
      }
      // 'retry' — transient. JSON body ⇒ we reached the spine (lock 'busy'), keep the
      // pill calm; a non-JSON/HTTP-error page ⇒ transport problem, drive the pill.
      lastFlushFailed = !(resp.ok && respBody);
      break;
    }
  } finally { flushing = false; }
  paint();
}

// The parked (set-aside poison) items, for the "Stuck uploads" review screen.
export async function parkedItems(){
  return (await queueAll()).filter(it => it._parked);
}

// Un-park every set-aside item and try again — "Retry all". Resets the strike count
// (and clears the last error) so each gets a full run.
export async function retryParked(){
  const items = await queueAll();
  for(const it of items) if(it._parked) await idb.put('queue', { ...it, _parked: false, _tries: 0, _error: undefined });
  return flush();
}

// Un-park and retry ONE item by its _seq (a row's Retry button).
export async function retryParkedOne(seq){
  const it = (await queueAll()).find(i => i._seq === seq);
  if(it && it._parked) await idb.put('queue', { ...it, _parked: false, _tries: 0, _error: undefined });
  return flush();
}

// Drop ONE parked item — the "Discard" button. Guarded to parked-only so a race can
// never delete an item that's still trying. A discarded write is gone for good.
export async function discardParkedOne(seq){
  const it = (await queueAll()).find(i => i._seq === seq);
  if(it && it._parked) await idb.del('queue', seq);
  return paint();
}

export async function paint(){
  const p = $('status'), t = $('statusText');
  if(!p || !t) return;                         // a page without the status pill — no-op
  const items = await queueAll();
  const parked  = items.filter(i => i._parked).length;   // poison items set aside
  const pending = items.length - parked;                 // still trying
  const act = activeActivity();                // read after the await so it reflects live state
  p.classList.remove('wait','off','busy');
  // A running background job takes precedence over the queue state (it's short-
  // lived and reverts on its own) and shows online OR offline — local work like
  // PDF generation is worth surfacing even with no signal.
  if(act){ p.classList.add('busy'); t.textContent = act; return; }
  if(pending && needsAuth){
    // Nothing is lost and nothing is stuck — the writes are queued and will drain
    // as soon as the device has a good credential. Say that, rather than showing a
    // failure the crew can't act on.
    p.classList.add('off');
    t.textContent = pending + ' waiting — sign in to sync';
  }
  else if(pending && lastFlushFailed){
    // A transport failure (fetch threw or an HTTP/offline page came back), NOT a
    // server rejection — those clear lastFlushFailed. Distinguish a truly-offline
    // phone from a spine that isn't answering: navigator.onLine is reliable when
    // TRUE, so a false reading only keeps the old "offline" wording, never a wrong
    // "online" one.
    p.classList.add('off');
    t.textContent = pending + (navigator.onLine ? ' waiting — server not responding'
                                                : ' waiting — offline');
  }
  else if(pending){
    p.classList.add('wait');
    t.textContent = pending + ' sending…' + (parked ? ` · ${parked} stuck` : '');
  }
  else if(parked){ p.classList.add('off'); t.textContent = parked + ' stuck — tap to review'; }
  else t.textContent = 'All synced';
}

// Repaint the pill whenever an activity starts/ends (registered on load).
onActivityChange(paint);
