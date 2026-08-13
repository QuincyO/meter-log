// ── Local daily-log summary (offline mirror of Code.gs buildDaySummary) ──────
// Builds the summary object the PDF renderer consumes, entirely from the phone's
// cached day — so the daily log generates with no signal. When online the
// authoritative server summary (previewDailyLog / endOfDay) is used instead; this
// is the offline fallback.
//
// Fidelity note: gaps run on THIS installer's own stops only (no merged-boat
// timeline, no partner-owned launch leg) — an accepted offline approximation,
// already flagged in compute/gaps.js. Team header + whole-boat dispatch come from
// the cached `boatMeta` the spine returns on each log / day read.
import { parseLocalMs } from '../time.js';
import { computeGapsLocal, gapNoteTimes } from './gaps.js';
import { BREAK_CATS, TRAVEL_ADJ_CATS } from './categories.js';

// Categories that don't subtract from a gap's travel (legacy "whole gap was
// travel" marker). Everything else entered on a gap is a deduction.
const NON_DEDUCTION = { TRAVEL_TIME: 1 };

// The end-of-day travel review's deductions are Downtime rows the spine has not been
// told about yet, and the PDF prints its delays FROM the downtime rows: the land
// template's per-WO DELAYS grid, the boat "Delay Time" box and the "Delays:" footer
// all read `summary.downtime`. Netting them out of travel (below) without also
// printing them is how a fallback PDF came out with a blank delay grid for work the
// installer had just typed — while the same minutes reached the Sheet moments later
// via saveTravel. So synthesize the rows saveTravel would have written: same
// `gap HH:MM–HH:MM` note, the arriving WO, the category and the minutes.
//
// saveTravel REPLACES the day's gap-tagged rows rather than adding to them, so a
// partly-synced review must drop the existing gap-tagged rows before appending, or a
// deduction already on the Sheet would be counted twice. Gated on a non-empty pending
// list for the same reason computeGapsLocal is: with nothing pending, the saved rows
// ARE the review, and the printed rows and the travel netting must always describe
// the same set.
function mergePendingTravel(downtime, pending, o){
  if(!pending || !pending.length) return downtime;
  const date = o.date || '';
  return downtime.filter(d => !gapNoteTimes(d.note)).concat(
    pending.filter(a => a && a.category && (Number(a.minutes) || 0) > 0).map((a, i) => ({
      id: 'pending-' + i,
      timestamp: date ? (date + ' 12:00:00') : '',   // anchored on the day, like saveTravel
      installer: o.installer || '',
      category: String(a.category).toUpperCase(),
      minutes: Number(a.minutes) || 0,
      workOrderId: a.workOrderId || '',
      note: 'gap ' + a.fromTime + '–' + a.toTime,
      workType: o.workType === 'land' ? 'land' : 'boat'
    })));
}

export function buildLocalSummary(opts){
  const o = opts || {};
  // Keep every status (incl. DONE) — DONE markers are gap-timeline markers and
  // feed the footer's "Visited" tally, exactly like the spine's stopsFor(). The
  // renderer filters to INSTALLED/UTI for the body rows.
  const stops    = o.stops || [];
  const day      = o.day || {};
  const bm       = o.boatMeta || {};
  const downtime = mergePendingTravel(o.downtime || [], o.pendingTravel, o);

  // Net travel per arriving stop = gap minutes − the minutes subtracted from it.
  const gaps = computeGapsLocal(stops, downtime, o.pendingTravel);
  const perStopTravel = {};
  gaps.forEach(g => {
    if (g.toId == null || g.toId === '') return;
    const ded = (g.allocations || [])
      .filter(a => !NON_DEDUCTION[String(a.category||'').toUpperCase()])
      .reduce((s, a) => s + (Number(a.minutes) || 0), 0);
    perStopTravel[g.toId] = Math.max(0, (g.idleMin || 0) - ded);
  });
  // The day's first log shows '~' (the morning ride is tracked, never a
  // meter-to-meter number). Locally that's just the earliest stop by time.
  const ordered = stops.slice().sort((a,b) => (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
  if (ordered.length) perStopTravel[ordered[0].id] = '~';

  // Per-person travel total = sum of the printable rows' net travel (excludes the
  // '~' launch and non-printable VISITED/UNACCOUNTED gaps), mirroring the spine.
  const printableIds = {};
  stops.filter(x => x.status==='INSTALLED' || x.status==='UTI').forEach(x => { printableIds[x.id] = 1; });
  let travelMinutes = 0;
  Object.keys(perStopTravel).forEach(id => {
    const v = perStopTravel[id]; if (typeof v === 'number' && printableIds[id]) travelMinutes += v;
  });

  // Delay Time box = only the 10 CATEGORIES; breaks / misc-travel / legacy
  // TRAVEL_TIME are excluded (mirrors buildDaySummary's bucketing).
  let downtimeTotalMin = 0;
  downtime.forEach(d => {
    const c = String(d.category||'').toUpperCase(), m = Number(d.minutes)||0;
    if (BREAK_CATS.indexOf(c) >= 0) return;
    if (TRAVEL_ADJ_CATS.indexOf(c) >= 0) return;
    if (c === 'TRAVEL_TIME') return;
    downtimeTotalMin += m;
  });

  return {
    date: o.date, installer: o.installer || '', installerId: o.installerId || '',
    workType: o.workType === 'land' ? 'land' : 'boat',
    partner: bm.partner || '', captain: bm.captain || '', sub: bm.sub || '',
    boatTeam: bm.boatTeam || '', boatName: bm.boatName || '',
    boatDispatchMin: bm.boatDispatchMin || 0,
    includeDelays: o.includeDelays !== false,
    weather: o.weather || '', notes: o.notes || '',
    downtimeTotalMin, travelMinutes,
    departure: day.departure || '', returned: day.returned || '',
    perStopTravel, stops, downtime
  };
}
