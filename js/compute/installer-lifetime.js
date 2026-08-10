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

// The measured on-site (dwell) model behind route ETAs — combined mode only.
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
