// ── Client-side WO→WO gap computation ───────────────────────────────────────
// Mirrors Code.gs computeIdle()'s per-consecutive-stop walk so the end-of-day
// travel editor works with no signal. When online, the authoritative `idle`
// response (which also applies team-partner first-gap logic this local pass
// skips) overrides these.
import { clockOf, hhmmMin } from '../time.js';

// Pull the two clock times out of a gap-tagged downtime note ("gap HH:MM–HH:MM"),
// dash-char agnostic. Mirrors gapNoteTimes() on the spine.
export function gapNoteTimes(note){
  return String(note==null?'':note).match(/gap\s+(\d{1,2}:\d{2}).+?(\d{1,2}:\d{2})/);
}

// ── a saveTravel the Sheet has confirmed ─────────────────────────────────────
// saveTravel REPLACES the day's gap-tagged Downtime rows with the posted set, so
// once one is acked the phone knows exactly what the Sheet holds without asking.
// settleTravel makes the cached day say so: the cached gap-tagged rows are rebuilt
// from the acked allocations (manual downtime rows are left alone), and the
// `eodTravel` stash — "edits the Sheet has not confirmed" — is dropped ONLY when it
// is that same set. Both halves matter now that Today's orders saves downtime
// mid-day:
//  • dropping the stash without rebuilding the rows left the cache with neither, so
//    an entry made at 10:00 vanished from the card the next time it was opened
//    offline — and the next save, a whole-day replace, then deleted it for real;
//  • dropping the stash on ANY ack threw away a newer edit still queued behind it.
// Returns true when `cached` changed. Pure: the callers own the IndexedDB write.
const travelSetKey = list => JSON.stringify((list||[])
  .filter(a => a && a.category && (parseInt(a.minutes,10)||0) > 0)
  .map(a => [String(a.fromTime||''), String(a.toTime||''), String(a.workOrderId==null?'':a.workOrderId),
             String(a.category).toUpperCase(), parseInt(a.minutes,10)||0]));
export function settleTravel(cached, allocations, o){
  if(!cached) return false;
  const opt = o || {};
  const acked = (allocations||[]).filter(a => a && a.category && (parseInt(a.minutes,10)||0) > 0);
  const date = opt.date || '';
  cached.downtime = (cached.downtime||[]).filter(d => !gapNoteTimes(d.note)).concat(
    acked.map((a, i) => ({
      id: 'gap-' + i,
      timestamp: date ? (date + ' 12:00:00') : '',   // anchored on the day, like saveTravel
      installer: opt.installer || '',
      category: String(a.category).toUpperCase(),
      minutes: parseInt(a.minutes,10) || 0,
      workOrderId: a.workOrderId || '',
      note: 'gap ' + a.fromTime + '–' + a.toTime,
      workType: ''                                   // saveTravel writes it blank
    })));
  if(Array.isArray(cached.eodTravel) && travelSetKey(cached.eodTravel) === travelSetKey(acked))
    delete cached.eodTravel;
  return true;
}

// Each gap is keyed to its arriving stop (toId) and carries the deductions
// already entered: from `pending` (offline review not yet synced) when present,
// otherwise from gap-tagged Downtime rows (server-synced). Times use clockOf's
// zero-padded HH:MM, matching secToHHMM on the spine so saved allocations
// round-trip.
//
// `land` (land mode only) prepends a zero-length "lead" gap on the first stop so
// its work order can carry downtime at end of day — the first WO is never any
// WO→WO gap's arriving stop, so it otherwise has no allocation editor. The lead
// gap is anchored on the first stop's own clock time for BOTH start and end
// (`gap HH:MM–HH:MM`): stable across reopens (independent of the editable Start
// bookend) and `from==to` so it never collides with a real WO→WO or Launch gap.
// Mirrors the server's land branch in the `?action=idle` handler.
export function computeGapsLocal(stops, downtime, pending, land){
  const acts = (stops||[])
    .map(s => ({ id:s.id, hhmm:clockOf(s.timestamp), min:hhmmMin(clockOf(s.timestamp)), wo:s.workOrderId }))
    .filter(a => a.min!=null)
    .sort((a,b)=> a.min - b.min);
  const gaps = [];
  if(land && acts.length){
    const f = acts[0];
    gaps.push({ start:f.hhmm, end:f.hhmm, idleMin:0, toWO:f.wo||'', toId:f.id, lead:true });
  }
  // `fromWO`/`fromId` name the stop the crew LEFT, and exist so a caller can price
  // the drive this gap contains (js/worklist.js onsitePerStopReal nets it out to
  // recover on-site time). The gap is still KEYED to its arriving stop — `toId` is
  // what allocations hang off — so nothing that reads the `to` side changes.
  for(let i=1;i<acts.length;i++){
    const prev=acts[i-1], cur=acts[i];
    if(cur.min - prev.min <= 0) continue;
    gaps.push({ start:prev.hhmm, end:cur.hhmm, idleMin:cur.min-prev.min,
      fromWO:prev.wo||'', fromId:prev.id, toWO:cur.wo||'', toId:cur.id });
  }
  const dt = downtime||[];
  gaps.forEach(g => {
    if(pending && pending.length){
      g.allocations = pending
        .filter(a => a.fromTime===g.start && a.toTime===g.end)
        .map(a => ({ category:a.category, minutes:Number(a.minutes)||0 }));
    } else {
      g.allocations = dt
        .filter(d => { const m=gapNoteTimes(d.note); return m && m[1]===g.start && m[2]===g.end; })
        .map(d => ({ category:d.category, minutes:Number(d.minutes)||0 }));
    }
  });
  return gaps;
}
