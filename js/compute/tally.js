// ── Day tallies (shared by Today / End-of-day / Recent days) ────────────────

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

// Shared tally line for the End-of-day / Today / Recent sheets.
export function tallyText(t){
  return `Installed ${t.installed} · UTI ${t.uti} · Downtime ${t.dtMin} min`
    + (t.visited ? ` · Visited ${t.visited}` : '')
    + (t.unaccounted ? ` · Unaccounted ${t.unaccounted}` : '')
    + (t.done ? ` · ${t.done} already-installed` : '');
}
