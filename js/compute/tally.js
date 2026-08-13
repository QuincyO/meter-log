// ── Day tallies (shared by Today / End-of-day / Recent days) ────────────────
import { EER_UTI_REASON } from '../utiReasons.js';

// Statuses that earn a row on the log / review lists (everything but the
// coordinates-only DONE marker).
export const PRINTABLE = { INSTALLED:1, UTI:1, VISITED:1, UNACCOUNTED:1 };

// Count a day's stops + downtime into the fields the tally line + summaries use.
export function countDay(stops, downtime){
  const n = st => (stops||[]).filter(s => s.status===st).length;
  return {
    installed:   n('INSTALLED'),
    uti:         n('UTI'),
    visited:     n('VISITED'),
    unaccounted: n('UNACCOUNTED'),
    done:        n('DONE'),
    dtMin:       (downtime||[]).reduce((a,d)=>a+(Number(d.minutes)||0),0),
  };
}

// The day's hand-off tally, copied to the clipboard whenever a daily-log PDF is
// drawn so it can be pasted straight into the report the office asks for.
//
// Three things about the shape are deliberate:
//  • `Dispatched:` is copied EMPTY. That number comes from a system this app never
//    sees, so the installer types it in on paste — a made-up zero would read as a
//    real count.
//  • `EER` is a SUBSET of `UTI`, not a sibling: a UTI whose reason is the
//    electrical-repair pick is counted on both lines. Subtracting it would make
//    the UTI line disagree with the PDF's own UTI total.
//  • `TR` (the day's timed appointments) is passed in, because it lives on the
//    worklist orders rather than on the logged stops — see worklist.js
//    todayAppointmentCount().
export function tallyBlock(stops, apptCount){
  const c = countDay(stops, []);
  const eer = (stops||[]).filter(s =>
    s.status==='UTI' && String(s.utiReason==null?'':s.utiReason).trim() === EER_UTI_REASON).length;
  return [ 'Dispatched:',
           `Installed: ${c.installed}`,
           `UTI: ${c.uti}`,
           `TR: ${Number(apptCount)||0}`,
           `EER: ${eer}` ].join('\n');
}

// Shared tally line for the End-of-day / Today / Recent sheets.
export function tallyText(t){
  return `Installed ${t.installed} · UTI ${t.uti} · Downtime ${t.dtMin} min`
    + (t.visited ? ` · Visited ${t.visited}` : '')
    + (t.unaccounted ? ` · Unaccounted ${t.unaccounted}` : '')
    + (t.done ? ` · ${t.done} already-installed` : '');
}
