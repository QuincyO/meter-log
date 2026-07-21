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
  for(let i=1;i<acts.length;i++){
    const prev=acts[i-1], cur=acts[i];
    if(cur.min - prev.min <= 0) continue;
    gaps.push({ start:prev.hhmm, end:cur.hhmm, idleMin:cur.min-prev.min, toWO:cur.wo||'', toId:cur.id });
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
