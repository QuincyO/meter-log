// ── Time / clock helpers, pinned to Toronto so the date logic matches the
//    spine (Code.gs dateOf) regardless of the device's own time zone. ────────

// Capture-time stamp, Toronto local, readable + sortable: "2026-06-19 10:58:04".
// hourCycle:'h23' with hour:'2-digit' still yields an UNPADDED hour ("9") in some
// engines, and a single-digit hour breaks every `\d\d`-hour parser downstream
// (secOfDay/clockOf), silently dropping the stop from gap math. Pad explicitly
// (and fold the legacy h23 "24" midnight to "00").
export function stamp(){
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Toronto', hourCycle:'h23',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  }).formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  const pad = v => String(v).padStart(2,'0');
  const hh = p.hour === '24' ? '00' : pad(p.hour);
  return `${p.year}-${p.month}-${p.day} ${hh}:${pad(p.minute)}:${pad(p.second)}`;
}

// Toronto-local calendar date "YYYY-MM-DD". Matches dateOf() in Code.gs.
// Used as part of the dayCache key so cached data is date-scoped automatically.
export function localDate(){
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return `${p.year}-${p.month}-${p.day}`;
}

// Toronto-local calendar date `offsetDays` from today, "YYYY-MM-DD". Negative =
// past. Used for cache retention windows + the recent-days range. Lexically
// comparable with localDate() since both are zero-padded YYYY-MM-DD.
export function localDateOffset(offsetDays){
  const d = new Date(Date.now() + offsetDays*86400000);
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(d).forEach(x => p[x.type] = x.value);
  return `${p.year}-${p.month}-${p.day}`;
}

// Parse a naive Toronto-local stamp ("yyyy-MM-dd HH:mm:ss" / ISO-ish) to ms.
// Both endpoints of any diff are parsed the same way, so the device's own zone
// cancels out — mirrors parseLocal() on the spine. Returns null if unparseable.
export function parseLocalMs(s){
  const m = String(s||'').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0)).getTime() : null;
}

// "…T9:00…" / "… 9:00 …" → "09:00"; tolerates a single-digit hour and zero-pads it
// so the "HH:MM" it returns matches the spine's padded gap keys (secToHHMM).
export function clockOf(ts){ const m = String(ts??'').match(/[ T](\d{1,2}):(\d{2})/); return m ? (('0'+m[1]).slice(-2)+':'+m[2]) : ''; }
export function hhmmMin(t){ const m = /^(\d{1,2}):(\d{2})$/.exec(String(t||'')); return m ? (+m[1])*60 + (+m[2]) : null; }

// 1 → "1st", 2 → "2nd", … for the work-order position chip.
export function ordinal(n){ const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10] || s[v] || s[0]); }
