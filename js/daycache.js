// ── dayCache: the storage-first local copy of the day's orders ──────────────
// Logging writes here immediately (applyOptimisticCache) so Today / End-of-day
// show a stop instantly and offline, before anything reaches the Sheet. Once the
// server acks a queued write, reconcileCache clears the _tempId pending marker
// and mirrors the dispatch side-effect.
import { idb } from './idb.js';
import { cfg } from './store.js';
import { apiGet } from './api.js';
import { withActivity } from './dom.js';
import { stamp, localDate, localDateOffset } from './time.js';

// An empty day copy, seeded when logging before any server pull exists.
const emptyDay = () => ({ stops:[], downtime:[], day:{}, closed:false, cachedAt:stamp() });

// Strip the transport-only keys so a cached record is purely the stop/downtime
// data. Everything else rides along verbatim — adding a new field to addStop /
// addDowntime is cached automatically, no change here required.
const dataOf = ({ token, action, _seq, ...rest }) => rest;

// Called from enqueue() immediately after a new item enters the queue.
// Adds an optimistic entry to today's dayCache so Today/EOD show it instantly.
export async function applyOptimisticCache(payload){
  const c = cfg(); if(!c.name) return;
  const key = `${c.name}|${localDate()}`;
  // Storage-first: if no local day copy exists yet (e.g. first log of the day,
  // or logged before ever pulling "Today's orders"), seed an empty one so the
  // stop lands on the phone immediately and survives offline.
  const cached = (await idb.get('dayCache', key)) || emptyDay();

  if(payload.action==='addStop' && payload.id){
    // Avoid double-add on flush retry
    if(cached.stops.some(s => s.id===payload.id)) return;
    // Store the whole record (any field added to addStop is cached automatically).
    cached.stops.push({ ...dataOf(payload), _tempId:true });
    await idb.put('dayCache', cached, key);

  } else if(payload.action==='addDowntime' && payload.id){
    if(cached.downtime.some(d => d.id===payload.id)) return;
    cached.downtime.push({ ...dataOf(payload), _tempId:true });
    await idb.put('dayCache', cached, key);

  } else if(payload.action==='updateStop'){
    const idx = (cached.stops||[]).findIndex(s => s.id===payload.id);
    if(idx !== -1){ Object.assign(cached.stops[idx], dataOf(payload)); await idb.put('dayCache', cached, key); }

  } else if(payload.action==='archiveStop' && payload.id){
    // Remove-from-log: drop the stop locally AND tombstone its id, so a server
    // pull that races the queued archive (server still has the row) can't
    // resurrect it. The tombstone clears once the server acks (reconcileCache).
    cached.stops = (cached.stops||[]).filter(s => s.id!==payload.id);
    cached.removedIds = (cached.removedIds||[]).filter(id => id!==payload.id).concat([payload.id]);
    await idb.put('dayCache', cached, key);
  }
}

// Called from flush() once the server acks a queued item.
// Clears the _tempId pending marker and handles the dispatch side-effect
// (applyDispatchDowntime on the server silently appended a DISPATCH Downtime row).
// The stop id stays the same (client-generated, used by server as-is).
export async function reconcileCache(body, item){
  const c = cfg(); if(!c.name) return;
  const key = `${c.name}|${localDate()}`;
  const cached = await idb.get('dayCache', key);
  if(!cached) return;
  let changed = false;

  if(item.action==='addStop' && body.ok && body.id){
    const idx = (cached.stops||[]).findIndex(s => s.id===item.id);
    if(idx !== -1){
      delete cached.stops[idx]._tempId;
      changed = true;
    } else if(!cached.stops.some(s => s.id===body.id)){
      cached.stops.push({...dataOf(item), id:body.id});
      changed = true;
    }
    // (Dispatch downtime is now computed + enqueued client-side as its own
    // addDowntime row, so there's no server-side dispatch side-effect to mirror.)
  } else if(item.action==='addDowntime' && body.ok && body.id){
    const idx = (cached.downtime||[]).findIndex(d => d.id===item.id);
    if(idx !== -1){
      delete cached.downtime[idx]._tempId;
      changed = true;
    } else if(!cached.downtime.some(d => d.id===body.id)){
      cached.downtime.push({...dataOf(item), id:body.id});
      changed = true;
    }
  } else if(item.action==='saveTravel' && body.ok && cached.eodTravel){
    // The offline travel review reached the Sheet — drop the local pending copy
    // so the next load reads the authoritative gap rows back via `idle`.
    delete cached.eodTravel;
    changed = true;
  } else if(item.action==='archiveStop' && body.ok && (cached.removedIds||[]).includes(item.id)){
    // The removal reached the Sheet — the server no longer returns the row, so
    // the tombstone has done its job.
    cached.removedIds = cached.removedIds.filter(id => id!==item.id);
    changed = true;
  }
  // The spine returns boatMeta (team header + whole-boat dispatch) on every log —
  // cache it so the offline daily-log PDF always has those values fresh.
  if(body.boatMeta){ cached.boatMeta = body.boatMeta; changed = true; }
  if(changed) await idb.put('dayCache', cached, key);
}

// ── retention ───────────────────────────────────────────────────────────────
// Keep the installer's own data for the last `keepDays` days; drop older
// dayCache entries so the phone holds ~a week, not an unbounded history. Keys
// are "name|YYYY-MM-DD", so the date suffix compares lexically against the
// cutoff. Run on load (fire-and-forget).
export async function pruneDayCache(keepDays = 8){
  const keys = (await idb.keys('dayCache')) || [];
  const cutoff = localDateOffset(-keepDays);   // anything strictly older than this goes
  for(const k of keys){
    const datePart = String(k).split('|')[1];
    if(datePart && datePart < cutoff) await idb.del('dayCache', k);
  }
}

// ── recent days (offline-viewable history) ──────────────────────────────────
// Pull the installer's own stops + downtime for the last `days` days in ONE
// request (cheaper than N× `day`) and write each date into dayCache, merged so a
// still-pending local row is never clobbered. Best-effort: online only.
export async function cacheRecentDays(days = 7){
  const c = cfg(); if(!c.name || !c.url || !navigator.onLine) return;
  const from = localDateOffset(-(days-1)), to = localDate();
  let res;
  // installerId lets the spine attach boatMeta (team header + whole-boat dispatch)
  // per day, so a recent-days pull seeds the offline daily-log cache too.
  try { res = await withActivity('Loading recent days…',
    () => apiGet('range', { installer:c.name, installerId:c.hNumber, from, to })); }
  catch { return; }
  if(!res || !res.ok || !Array.isArray(res.days)) return;
  for(const d of res.days){
    const key = `${c.name}|${d.date}`;
    const local = await idb.get('dayCache', key);
    const removedIds = (local && local.removedIds) || [];
    const stops    = mergePendingRows(d.stops,    local && local.stops, removedIds);
    const downtime = mergePendingRows(d.downtime, local && local.downtime);
    await idb.put('dayCache', {
      stops, downtime,
      day:(d.day || (local && local.day) || {}),
      boatMeta: d.boatMeta || (local && local.boatMeta) || null,
      closed: d.closed != null ? !!d.closed : !!(local && local.closed),
      cachedAt: stamp(),
      eodTravel: local && local.eodTravel,
      removedIds
    }, key);
  }
}

// Read the cached days for the window, newest first. Pure local — works offline.
export async function loadRecentDays(days = 7){
  const c = cfg(); if(!c.name) return [];
  const out = [];
  for(let i=0;i<days;i++){
    const date = localDateOffset(-i);
    const cached = await idb.get('dayCache', `${c.name}|${date}`);
    out.push({ date, stops:(cached&&cached.stops)||[], downtime:(cached&&cached.downtime)||[],
               day:(cached&&cached.day)||{}, closed:!!(cached&&cached.closed), cached:!!cached });
  }
  return out;
}

// Server-wins-by-id merge that still overlays locally-pending (_tempId) rows, so
// caching a day never drops un-synced work — and drops rows whose id is
// tombstoned (removed locally, archiveStop still queued: the server hasn't heard
// yet, so its copy must not resurrect the stop). Mirrors mergePending in capture.js.
function mergePendingRows(serverArr, cachedArr, removedIds){
  const dead = new Set((removedIds || []).map(String));
  const out = (serverArr || []).filter(r => !dead.has(String(r.id)));
  const ids = new Set(out.map(r => String(r.id)));
  (cachedArr || []).forEach(r => { if(r._tempId && !ids.has(String(r.id)) && !dead.has(String(r.id))) out.push(r); });
  return out;
}
