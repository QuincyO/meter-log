// ── Installer lifetime metrics (analytics view) ─────────────────────────────
// Pure shaping of the InstallerMetrics wide rows (?action=installerMetrics with
// no workType — combined + boat* + land* column groups) into what the analytics
// page renders. DOM-free so node --test covers the math. Sheet cells arrive as
// '' when blank — every reader here must map that to null, never NaN.

// '' / null / undefined → null; anything unparseable → null.
function num(v){
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// recent-30-workday pace vs lifetime pace. The steady band is max(2 min, 10%)
// so ordinary jitter (31 vs 32) never paints a trend arrow.
export function paceTrend(recent, lifetime){
  const r = num(recent), l = num(lifetime);
  if (r == null || l == null) return null;
  const band = Math.max(2, l * 0.1);
  if (r < l - band) return 'faster';
  if (r > l + band) return 'slower';
  return 'steady';
}

// One render-ready row per installer who has actually worked (days > 0 —
// a roster entry with no closed days yet stays off the table). Sorted by name.
export function lifetimeRows(metrics){
  return (metrics || [])
    .map(m => {
      const days = num(m.daysWorked), hours = num(m.hoursWorked);
      const logs = num(m.totalLogs), utis = num(m.utis), down = num(m.downtimeMin);
      return {
        name: String(m.name || '').trim(),
        days, hours, logs,
        installs:   num(m.installs),
        utis,
        avgPerDay:  num(m.avgPerDay),
        avgPerHour: num(m.avgPerHour),
        avgLogMin:  num(m.avgLogMin),
        recent30:   num(m.recent30AvgLogMin),
        trend:      paceTrend(m.recent30AvgLogMin, m.avgLogMin),
        utiRate:        (utis != null && logs) ? Math.round(utis / logs * 100) : null,
        downtimePerDay: (down != null && days) ? Math.round(down / days) : null,
        hoursPerDay:    (hours != null && days) ? Math.round(hours / days * 10) / 10 : null,
      };
    })
    .filter(r => r.days)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Land-vs-boat avg-minutes-per-log chart data: only installers with at least
// one mode measured; the missing mode is null so Chart.js just skips that bar.
export function modePace(metrics){
  const rows = (metrics || [])
    .map(m => ({ name: String(m.name || '').trim(), days: num(m.daysWorked),
      land: num(m.landAvgLogMin), boat: num(m.boatAvgLogMin) }))
    .filter(r => r.days && (r.land != null || r.boat != null))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    labels: rows.map(r => r.name),
    land:   rows.map(r => r.land),
    boat:   rows.map(r => r.boat),
  };
}

// ── Land / Boat / All split for the analytics view ──────────────────────────
// Boat vs land is decided by the row's DATE (plus a short list of known boat
// days after it), not by its workType tag. Every day before the first land day
// was boat work; since then it has been land, except the week boat work briefly
// came back. The tag can't be used for this, because the analytics rows don't
// agree on it: Timing and Dispatch have no tag at all, the `pins` read drops
// it, Downtime's gap-tagged saveTravel rows carry a blank tag (which
// normWorkType reads as boat) right through October, and Quincy's all-island
// 2026-08-06 was closed with a `land` Tracker row while its Stops say boat.
// Checked against the 2026-10-14 export: Tracker is boat through 2026-07-15,
// land from 2026-07-20.
export const LAND_START = '2026-07-20';
// Boat work done on or after LAND_START, by date → installer display names
// (the name the Stops/Tracker rows carry). From the island addresses on the
// `boat`-tagged Stops rows. If boat work resumes, add its days here.
export const BOAT_DAYS_AFTER_LAND_START = {
  '2026-08-04': ['Quincy Orta'],
  '2026-08-06': ['Quincy Orta'],
};

// ('yyyy-MM-dd' Toronto date, installer name) → 'boat' | 'land'.
export function workTypeOn(dateKey, installer){
  const d = String(dateKey || '');
  if (d < LAND_START) return 'boat';
  const names = BOAT_DAYS_AFTER_LAND_START[d];
  return names && names.includes(String(installer == null ? '' : installer).trim()) ? 'boat' : 'land';
}

// mode is 'land' | 'boat' | 'all'; anything else behaves as 'all'.
export function matchesWorkType(dateKey, installer, mode){
  if (mode !== 'land' && mode !== 'boat') return true;
  return workTypeOn(dateKey, installer) === mode;
}

// Client mirror of Code.gs installerMetricsRead's boat/land projection: maps the
// wide row's `boat*` / `land*` columns onto the canonical names, so lifetimeRows
// and dwellRows read one mode unchanged. 'all' (or anything else) returns the
// wide rows as-is — their unprefixed columns are already the combined figures.
const MODE_KEYS = ['daysWorked','hoursWorked','totalLogs','installs','utis','visited',
  'unaccounted','downtimeMin','avgLogMin','avgPerDay','avgPerHour','recent30AvgLogMin',
  'onSiteMin','extraMeterMin','travelMinPerKm','onSiteSource'];
export function metricsForMode(metrics, mode){
  if (mode !== 'land' && mode !== 'boat') return metrics || [];
  return (metrics || []).map(m => {
    const o = { hNumber: m.hNumber, name: m.name, workType: mode,
                firstDay: m.firstDay, lastDay: m.lastDay, updated: m.updated };
    MODE_KEYS.forEach(k => { o[k] = m[mode + k[0].toUpperCase() + k.slice(1)]; });
    return o;
  });
}

// The measured on-site (dwell) model behind route ETAs. Reads the canonical
// (unprefixed) fields — pass metricsForMode() output to see one mode.
// Rows with no dwell evidence at all (every field blank, source 'pace' or not)
// are dropped: 'pace' alone means "still guessing", which isn't worth a row.
export function dwellRows(metrics){
  return (metrics || [])
    .map(m => ({
      name: String(m.name || '').trim(),
      onSiteMin:      num(m.onSiteMin),
      extraMeterMin:  num(m.extraMeterMin),
      travelMinPerKm: num(m.travelMinPerKm) == null ? null : Math.round(num(m.travelMinPerKm) * 10) / 10,
      source: String(m.onSiteSource || '').trim() || null,
    }))
    .filter(r => r.onSiteMin != null || r.extraMeterMin != null || r.travelMinPerKm != null)
    .sort((a, b) => a.name.localeCompare(b.name));
}
