// ── Day tallies (shared by Today / End-of-day / Recent days) ────────────────
import { EER_UTI_REASON } from '../utiReasons.js';
import { localDate } from '../time.js';

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
// Four things about the shape are deliberate:
//  • **The DATE LINE MUST COME FIRST, and it must start with a digit.** This is not
//    decoration — it is what stops iOS mangling the whole paste. A `Word:` at
//    position 0 is a valid URI scheme, so `Dispatched:\nInstalled: 17…` parses as a
//    URL with scheme `dispatched:`. iOS's pasteboard sniffs that, publishes a
//    `public.url` flavour beside the plain text, and any app that prefers URLs —
//    Messages does — pastes the percent-encoded form instead:
//        Dispatched:%0AInstalled%3A%2017%0AUTI%3A%204…
//    which is what the crew SMS'd to the office on 2026-08-14. An app that takes the
//    plain-text flavour showed the same clipboard correctly, which is why it looked
//    like a phone bug rather than a format one. A leading `YYYY-MM-DD` defeats it
//    structurally: a scheme may not begin with a digit, so there is no URL to detect.
//    **Do not reorder these lines and do not drop the date** — `Installed:` is just
//    as valid a scheme as `Dispatched:`, and filling Dispatched in (`Dispatched: 0`)
//    does not help either; only the first line's shape matters. Pinned by
//    tests/day-tally-block.test.mjs, which asserts the block does not parse as a URL.
//  • `Dispatched:` is copied EMPTY. That number comes from a system this app never
//    sees, so the installer types it in on paste — a made-up zero would read as a
//    real count.
//  • `EER` is a SUBSET of `UTI`, not a sibling: a UTI whose reason is the
//    electrical-repair pick is counted on both lines. Subtracting it would make
//    the UTI line disagree with the PDF's own UTI total.
//  • `TR` (the day's timed appointments) is passed in, because it lives on the
//    worklist orders rather than on the logged stops — see worklist.js
//    todayAppointmentCount().
//
// `date` defaults to today rather than being omitted when absent: a blank first
// line would be trimmed by the same pasteboard sniffing and hand the bug straight
// back, so the guard line always exists.
export function tallyBlock(stops, apptCount, date){
  const c = countDay(stops, []);
  const eer = (stops||[]).filter(s =>
    s.status==='UTI' && String(s.utiReason==null?'':s.utiReason).trim() === EER_UTI_REASON).length;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date||'')) ? String(date) : localDate();
  return [ day,
           'Dispatched:',
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
