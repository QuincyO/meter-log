// ── dayCache: the storage-first local copy of the day's orders ──────────────
// Logging writes here immediately (applyOptimisticCache) so Today / End-of-day
// show a stop instantly and offline, before anything reaches the Sheet. Once the
// server acks a queued write, reconcileCache clears the _tempId pending marker
// and mirrors the dispatch side-effect.
import { idb } from './idb.js';
import { cfg } from './store.js';
import { stamp, localDate } from './time.js';

// Called from enqueue() immediately after a new item enters the queue.
// Adds an optimistic entry to today's dayCache so Today/EOD show it instantly.
export async function applyOptimisticCache(payload){
  const c = cfg(); if(!c.name) return;
  const key = `${c.name}|${localDate()}`;
  // Storage-first: if no local day copy exists yet (e.g. first log of the day,
  // or logged before ever pulling "Today's orders"), seed an empty one so the
  // stop lands on the phone immediately and survives offline.
  const cached = (await idb.get('dayCache', key))
    || { stops:[], downtime:[], day:{}, closed:false, cachedAt:stamp() };

  if(payload.action==='addStop' && payload.id){
    // Avoid double-add on flush retry
    if(cached.stops.some(s => s.id===payload.id)) return;
    cached.stops.push({
      id:payload.id, timestamp:payload.timestamp, installer:payload.installer,
      workOrderId:payload.workOrderId, unit:payload.unit, address:payload.address,
      lat:payload.lat, lng:payload.lng, newJNumber:payload.newJNumber,
      oldJNumber:payload.oldJNumber, meterRead:payload.meterRead,
      meterReadReceived:payload.meterReadReceived, status:payload.status,
      utiReason:payload.utiReason, notes:payload.notes, noReadReason:payload.noReadReason,
      _tempId:true
    });
    await idb.put('dayCache', cached, key);

  } else if(payload.action==='addDowntime' && payload.id){
    if(cached.downtime.some(d => d.id===payload.id)) return;
    cached.downtime.push({
      id:payload.id, timestamp:payload.timestamp, installer:payload.installer,
      category:payload.category, minutes:payload.minutes,
      workOrderId:payload.workOrderId, note:payload.note, _tempId:true
    });
    await idb.put('dayCache', cached, key);

  } else if(payload.action==='updateStop'){
    const idx = (cached.stops||[]).findIndex(s => s.id===payload.id);
    if(idx !== -1){ Object.assign(cached.stops[idx], payload); await idb.put('dayCache', cached, key); }
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
      cached.stops.push({...item, id:body.id});
      changed = true;
    }
    // The spine's applyDispatchDowntime may have written a DISPATCH downtime row
    // when the stop had requestedMeter=true. Mirror it in the cache.
    if(body.dispatch){
      cached.downtime.push({
        id:`dispatch-${body.id}`, timestamp:item.timestamp, installer:item.installer,
        category:'DISPATCH', minutes:body.dispatch.minutes, workOrderId:item.workOrderId,
        note:body.dispatch.measured ? 'dispatch (measured)' : 'dispatch (avg est.)'
      });
      changed = true;
    }
  } else if(item.action==='addDowntime' && body.ok && body.id){
    const idx = (cached.downtime||[]).findIndex(d => d.id===item.id);
    if(idx !== -1){
      delete cached.downtime[idx]._tempId;
      changed = true;
    } else if(!cached.downtime.some(d => d.id===body.id)){
      cached.downtime.push({...item, id:body.id});
      changed = true;
    }
  } else if(item.action==='saveTravel' && body.ok && cached.eodTravel){
    // The offline travel review reached the Sheet — drop the local pending copy
    // so the next load reads the authoritative gap rows back via `idle`.
    delete cached.eodTravel;
    changed = true;
  }
  if(changed) await idb.put('dayCache', cached, key);
}
