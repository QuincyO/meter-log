/**
 * Meter Log — Apps Script Web App (the "spine")
 * ------------------------------------------------
 * Bind this to a Google Sheet (Extensions ▸ Apps Script), then deploy as a
 * Web App (Deploy ▸ New deployment ▸ Web app ▸ Execute as: Me ▸ Who has
 * access: Anyone). Copy the resulting /exec URL into your Shortcut and the
 * web form. Re-run setupSheets() once to create the tabs with headers.
 *
 * It does the deterministic work — appending stops, appending downtime,
 * editing a stop in place, and computing + appending the end-of-day total
 * row. Claude (via the Drive connector) does the formatted daily sheet and
 * summaries; it does NOT do this.
 *
 * v2 changes:
 *   • dateOf() now normalises any timestamp (Date object OR ISO string, UTC
 *     or local) to the Toronto calendar date — this is the fix for the
 *     "end of day is all zeros" bug.
 *   • New read action  ?action=lookup  — find a stop by WO# or J#.
 *   • New read action  ?action=geocode — reverse-geocode lat/lng to an
 *     address (no API key; uses the built-in Maps service).
 *   • New write action updateStop — edit a stored stop by its id.
 *   • endOfDay now stores an optional free-text note, and ?action=day also
 *     returns the day's downtime so the web form can preview totals.
 *   • New read action  ?action=pins    — every stop (with its coordinates)
 *     for the map + analytics viewer page.
 *   • New read action  ?action=tracker — all Tracker (end-of-day) rows for
 *     the viewer's trend charts.
 *
 * v3 changes (crew + boat teams):
 *   • Two new tabs: Employees (the crew, keyed on employee/"H" number) and
 *     Teams (boat teams — identifier, boat name/number, captain, members).
 *   • New read action  ?action=roster — the full crew + teams, for the
 *     teams.html admin page and the installer's name picker.
 *   • New write actions: saveEmployee / deleteEmployee / saveTeam /
 *     deleteTeam — managed entirely from teams.html.
 *   • endOfDay now accepts installerId (the H number). When present, the
 *     spine looks up the installer's boat team and auto-fills Partner,
 *     Captain, Boat Team (A/B/C…) and Boat Name on the daily-log PDF.
 */

// ── Config ───────────────────────────────────────────────────────────────
const SHARED_TOKEN = 'Bko1PP6sPFJMabph7ZF7TtZDLFqXuFOr'; // crude gate; must match the caller
const TIMEZONE     = 'America/Toronto';

// ── Travel / downtime tuning (field-tunable) ───────────────────────────────
// Timing is derived from the timestamps + GPS already on each stop. Walking the
// team's stops in time order, each gap between two consecutive stops is gated by
// TIME first:
//   • gap <  FLAG_GAP_MIN → travel (auto, silent; just driving between meters).
//   • gap >= FLAG_GAP_MIN → flagged at end-of-day for the installer to label.
// Distance only HINTS a flagged gap's default label: moved more than SAME_ISLAND_M
// pre-suggests "Travel Time" (a long ride); otherwise a real downtime reason.
const FLAG_GAP_MIN  = 20;   // gaps shorter than this are auto travel; ≥ this get flagged
const SAME_ISLAND_M = 500;  // a flagged gap that moved farther than this pre-suggests Travel Time

const CATEGORIES = [
  'NEXT_GEN', 'CELL_SIGNAL', 'BAD_WEATHER', 'WAREHOUSE', 'TOOLS_MATERIAL',
  'DISPATCH', 'TRUCK_ISSUES', 'ASSIST', 'URGENT_EER', 'OTHER'
];
// Allocation categories that are NOT delays — kept out of CATEGORIES so they never
// claim a Tracker per-category column. Both still subtract from a gap's WO→WO travel
// when entered at end-of-day review; they're summed onto their own daily-log lines.
const BREAK_CATS      = ['LUNCH', 'BREAK'];   // "Breaks" footer line
const TRAVEL_ADJ_CATS = ['MISC_TRAVEL'];      // "Misc Travel" footer line
// A gap allocation of any category EXCEPT legacy TRAVEL_TIME subtracts from that gap's
// travel. TRAVEL_TIME (old data) meant "the whole gap was still travel", so it must
// NOT be subtracted — this is what keeps already-closed days computing unchanged.
function isGapDeduction(cat) { return !!cat && cat !== 'TRAVEL_TIME'; }
// Maps a gap-allocation Downtime row's note (`gap HH:MM–HH:MM`, or the legacy
// `auto-detected gap …`) back to its two clock times, dash-char agnostic.
function gapNoteTimes(note) {
  return String(note == null ? '' : note).match(/gap\s+(\d{1,2}:\d{2}).+?(\d{1,2}:\d{2})/);
}

const STOPS_HEADERS = [
  'id','timestamp','installer','workOrderId','unit','address','lat','lng',
  'newJNumber','oldJNumber','meterRead','status','utiReason','notes','noReadReason','meterReadReceived',
  'requestedMeter',
  // 'boat' | 'land' — which side of the operation logged the stop. Appended last
  // so older sheets migrate cleanly (ensureTab fills the header); blank = boat.
  'workType'
];
// Removed stops, moved here (never hard-deleted) by archiveStop and moved back
// by restoreStop. Same columns as Stops plus the removal metadata, so a row can
// be inspected — or restored — without losing anything.
const STOPS_ARCHIVE_HEADERS = STOPS_HEADERS.concat(['removedAt', 'removedBy', 'reason']);
const DOWNTIME_HEADERS = [
  'id','timestamp','installer','category','minutes','workOrderId','note',
  'workType'   // 'boat' | 'land' (appended last; blank = boat)
];
const TRACKER_HEADERS = [
  'date','installer','installed','uti','downtimeTotalMin',
  'nextGen','cellSignal','badWeather','warehouse','toolsMaterial',
  'dispatch','truckIssues','assist','urgentEer','other','weather','notes',
  // Appended after 'notes' so older sheets migrate cleanly (ensureTab fills the
  // new header cells) and existing header-keyed rows never shift. visited /
  // unaccounted are the attendance counts; autoIdleMin is the legacy derived idle
  // (kept for old rows). travelMin / delayMin are the new distance-split totals:
  // travelMin = this installer's own arrival gaps (the rides leading to their own
  // stops, incl. their own launch leg, excl. the return leg) — per-person, so it
  // reconciles with the daily-log "Travel Time" box; delayMin = same-island
  // meter-to-meter time.
  'visited','unaccounted','autoIdleMin','travelMin','delayMin',
  'workType'   // 'boat' | 'land' — the mode the day was closed in (blank = boat)
];
// Crew: one row per installer, keyed on the employee number ("H number"), so
// two people with the same name never collide. firstName/lastName are the
// display label; hNumber is the identity. subName is the installer's own
// sub-foreman pick (capture-page Settings) — used only when they're not on a
// team; a team's subName always wins.
const EMPLOYEES_HEADERS = ['hNumber','firstName','lastName','active','subName'];
// One row per BOAT (boatNumber, e.g. "11"). Each crew member on the boat is
// assigned a letter in memberLetters — a JSON map {hNumber: "A"} — and people
// who share a letter are partners, so member H100→"A" on boat 11 reads as team
// "11A". captainName + subName are free-text names shared across the whole boat
// (captains/subs aren't employees and move between boats); they're saved to the
// Captains/Subs lists for quick reuse.
// `type` ('boat' | 'land', blank = boat) splits boat teams from land crews: a
// land crew reuses the same shape — boatNumber holds the crew number, subName
// holds the sub foreman, captainName/boatName stay blank.
const TEAMS_HEADERS = ['id','boatNumber','boatName','captainName','subName','memberLetters','type'];
// Quick-pick name lists that feed the team form's captain / sub dropdowns.
const CAPTAINS_HEADERS = ['name'];
const SUBS_HEADERS     = ['name'];
// Audit trail: one row per computed gap, written at end-of-day, so every Travel
// Time / Delay number on the daily log traces back to a row. `type` is Travel /
// Flagged / Launch / Return; `bucket` is travel, a downtime label, or unlabeled.
const TIMING_HEADERS = ['date','installer','fromTime','toTime','minutes','distanceM','type','bucket','workOrderId','fromStatus','toStatus'];
// One row per installer per day holding the day "bookend" clock times — Departure
// (left dock) and Returned (back to land). These anchor the daily log's Launch /
// Return legs; persisting them (the field form used to discard them) is what lets
// the back-office edit.html regenerate a correct daily log any time.
const DAYS_HEADERS = ['date','installer','departure','returned','dispatchMin','boatDispatchMin'];
// One row per BOAT per day — a snapshot of who crewed which boat that date, taken at
// end-of-day (Teams is otherwise current-state only, with no membership history). It's
// the historical record of daily boat teams AND the membership the viewer's boat-wide
// "log→log" metric groups by. memberLetters/memberNames are JSON copies of the team's
// {hNumber:"A"} map and the crew's display names at close time.
const BOATDAYS_HEADERS = ['date','boatNumber','boatName','captainName','subName','memberLetters','memberNames'];
// One row per dispatch request fired from the Apple Shortcut (action=dispatchRequest).
// `requestTime`+`oldJNumber` are written when the request fires; the rest are filled
// in place when a stop carrying the same oldJ is completed (see applyDispatchDowntime),
// so `matched`='Y' rows are the measured dispatch downtimes the average is built from.
const DISPATCH_HEADERS = ['id','requestTime','oldJNumber','installer','completedTime','minutes','matched'];

// Key/value summary metrics, one row per metric (keyed on `metric`). Currently
// just `avgDispatchTime` — the reconciled avg dispatch wait, refreshed by the
// hourly avgDispatchTimeJob trigger (and any editor run). Room for more later.
const METRICS_HEADERS = ['metric','value','updated'];

// Fields the web form is allowed to change on an existing stop.
const STOP_EDITABLE = [
  'workOrderId','unit','address','newJNumber','oldJNumber','status','utiReason','notes','noReadReason'
];

// Run once from the editor to grant the external-request scope (weather lookup).
function grantPermissions() {
  UrlFetchApp.fetch('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m');
}

// ── One-time setup: run this from the editor once ──────────────────────────
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab(ss, 'Stops', STOPS_HEADERS);
  ensureTab(ss, 'StopsArchive', STOPS_ARCHIVE_HEADERS);
  ensureTab(ss, 'Downtime', DOWNTIME_HEADERS);
  ensureTab(ss, 'Tracker', TRACKER_HEADERS);
  ensureTab(ss, 'Employees', EMPLOYEES_HEADERS);
  ensureTab(ss, 'Teams', TEAMS_HEADERS);
  ensureTab(ss, 'Captains', CAPTAINS_HEADERS);
  ensureTab(ss, 'Subs', SUBS_HEADERS);
  ensureTab(ss, 'Timing', TIMING_HEADERS);
  ensureTab(ss, 'Days', DAYS_HEADERS);
  ensureTab(ss, 'BoatDays', BOATDAYS_HEADERS);
  ensureTab(ss, 'Dispatch', DISPATCH_HEADERS);
  ensureTab(ss, 'Metrics', METRICS_HEADERS);
  // Keep entered bookend times as literal text so Sheets can't coerce "08:30"
  // into a 1899-epoch time value (which then reads back as a Date and prints a
  // date instead of a clock time on the daily log).
  const days = ss.getSheetByName('Days');
  days.getRange('C2:D').setNumberFormat('@');   // departure, returned (cols 3-4)
  // Same coercion bites the stop/downtime timestamps: a naive "2026-06-27 08:52:57"
  // string gets turned into a Date, which JSON serializes as UTC ("…Z"). Pin the
  // timestamp column to text so it stays the naive Toronto string it was written as.
  ss.getSheetByName('Stops').getRange('B2:B').setNumberFormat('@');     // timestamp
  ss.getSheetByName('StopsArchive').getRange('B2:B').setNumberFormat('@'); // timestamp
  ss.getSheetByName('Downtime').getRange('B2:B').setNumberFormat('@');  // timestamp
}

function ensureTab(ss, name, headers) {
  bustRows(name);
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
  } else {
    // Fill in any header cells added to the schema since the sheet was made
    // (e.g. Tracker 'notes', Stops 'noReadReason') without touching existing
    // labels or data. Re-run setupSheets() once to upgrade an older sheet.
    const have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v));
    headers.forEach((h, i) => { if (have[i] === undefined || have[i] === '') sh.getRange(1, i + 1).setValue(h); });
  }
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

// ── POST: capture layer sends JSON here ────────────────────────────────────
function doPost(e) {
  // Serialize all writes. Apps Script web apps can run concurrently, and several
  // actions read-modify-write the sheet (upsertDayRow, saveTravel, the addStop
  // dedup). A script lock keeps those atomic. If the lock can't be had quickly we
  // return a transient error so the client's offline queue keeps the item and
  // retries (it never drops it) — see js/queue.js flush().
  // previewDailyLog is the one POST that writes nothing (buildDaySummary is a
  // pure read), so it skips the lock entirely: the phones re-request it on every
  // settled EOD edit while prefetching the Finish summary, and at quitting time
  // that traffic must not queue behind the whole crew's real writes.
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json({ ok: false, error: String(err) }); }
  if (body.token !== SHARED_TOKEN) return json({ ok: false, error: 'bad token' });
  if (body.action === 'previewDailyLog') {
    try { return json(previewDailyLog(body)); }
    catch (err) { return json({ ok: false, error: String(err) }); }
  }

  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(25000)) return json({ ok: false, error: 'busy, retry' });
  } catch (e0) { /* lock service unavailable — proceed unlocked rather than block */ }
  try {
    switch (body.action) {
      case 'addStop':        return json(addStop(body));
      case 'addDowntime':    return json(addDowntime(body));
      case 'dispatchRequest':return json(dispatchRequest(body));
      case 'updateStop':     return json(updateStop(body));
      case 'archiveStop':    return json(archiveStop(body));
      case 'restoreStop':    return json(restoreStop(body));
      case 'endOfDay':       return json(endOfDay(body));
      case 'saveTravel':     return json(saveTravel(body));
      case 'saveDay':        return json(saveDay(body));
      case 'saveEmployee':   return json(saveEmployee(body));
      case 'deleteEmployee': return json(deleteEmployee(body));
      case 'saveTeam':       return json(saveTeam(body));
      case 'deleteTeam':     return json(deleteTeam(body));
      case 'saveCaptain':    return json(saveName('Captains', body.name));
      case 'deleteCaptain':  return json(deleteName('Captains', body.name));
      case 'saveSub':        return json(saveName('Subs', body.name));
      case 'deleteSub':      return json(deleteName('Subs', body.name));
      default:               return json({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e1) {}
  }
}

// ── GET: read-side for the map / lookup / "is this done?" check ───────────
function doGet(e) {
  const p = e.parameter || {};
  if (p.token !== SHARED_TOKEN) return json({ ok: false, error: 'bad token' });

  if (p.action === 'nearby') {
    return json(nearby(parseFloat(p.lat), parseFloat(p.lng),
                        p.radiusM ? parseFloat(p.radiusM) : 150));
  }
  if (p.action === 'day') {
    const date = p.date || today();
    // `day` (bookend times) + `closed` (a Tracker row already exists) let edit.html
    // pre-fill the Departure/Returned inputs and show whether the day is closed.
    // `boatMeta` (team header + whole-boat dispatch) seeds the offline daily-log
    // cache on a fresh load, when installerId is supplied (collision-safe by H#).
    return json({ ok: true,
                  stops: stopsFor(p.installer, date),
                  downtime: downtimeFor(p.installer, date),
                  day: dayMeta(p.installer, date),
                  boatMeta: p.installerId ? boatMetaFor(p.installerId, date) : null,
                  closed: dayClosed(p.installer, date) });
  }
  if (p.action === 'range') {
    // One installer's stops + downtime across a date window, grouped by day, in a
    // single call — feeds the phone's offline "recent days" cache (≤ ~a week) so
    // it isn't N separate `day` requests. boatMeta (when installerId given) lets a
    // recent-days pull seed the daily-log cache for each day too.
    const from = p.from || today();
    const to   = p.to   || today();
    const days = rangeData(p.installer, from, to);
    if (p.installerId) days.forEach(d => { d.boatMeta = boatMetaFor(p.installerId, d.date); });
    return json({ ok: true, days: days });
  }
  if (p.action === 'archived') {
    // One installer's removed (archived) stops for a date — edit.html's
    // "Removed stops" list, so a removal can be inspected and restored.
    return json({ ok: true, stops: archivedFor(p.installer, p.date || today()) });
  }
  if (p.action === 'lookup')  return json(lookup(p));
  if (p.action === 'geocode') return json(geocode(parseFloat(p.lat), parseFloat(p.lng)));
  // The five viewer reads accept an OPTIONAL from/to date window (yyyy-MM-dd,
  // Toronto, inclusive) so the map can pull "the last 60 days" instead of the
  // whole history every open. No params → the full tab, exactly as before.
  if (p.action === 'pins')    return json(pins(p.from, p.to));
  if (p.action === 'tracker') return json(tracker(p.from, p.to));
  if (p.action === 'downtime')return json(downtimeRows(p.from, p.to));
  if (p.action === 'timing')  return json(timing(p.from, p.to));
  if (p.action === 'boatdays')return json(boatDays(p.from, p.to));
  if (p.action === 'dispatch')return json(dispatchRows(p.from, p.to));
  if (p.action === 'avgDispatchTime') return json({ ok: true, avgDispatchTime: readMetric('avgDispatchTime') });
  if (p.action === 'roster')  return json(roster());
  if (p.action === 'idle') {
    const date = p.date || today();
    const id   = String(p.installerId == null ? '' : p.installerId).trim();
    const emp  = id ? employeeByH(id) : null;
    const installer = emp ? fullName(emp) : (p.installer || '');
    // Every meter-to-meter gap (short hops included) that arrives at one of THIS
    // installer's own stops is offered for review so a break can be subtracted from any
    // of them. Gaps run on the merged boat timeline — measured from the most recent boat
    // log — so a non-first installer's first gap (from a partner's prior log) is included
    // and labellable. (The boat-first stop has no incoming gap, so its dock launch '~'
    // isn't listed; Launch/Return legs need bookend times not known when this opens.)
    const gi = installerGapStops(id, installer, date);
    const ownIds = gi.ownIds;
    const gaps = computeIdle(gi.stops).gaps
      .filter(g => (g.type === 'Travel' || g.type === 'Flagged')
                && g.toId !== '' && g.toId != null && ownIds[g.toId]);
    // Attach any already-saved allocations (gap-tagged Downtime rows) so re-opening a
    // day from either surface pre-fills what was entered.
    const dt = downtimeFor(installer, date);
    const allocFor = (a, z) => dt
      .filter(d => { const m = gapNoteTimes(d.note); return m && m[1] === a && m[2] === z; })
      .map(d => ({ id: d.id, category: d.category, minutes: Number(d.minutes) || 0 }));
    // Pre-fill the dispatch wait as an editable DISPATCH deduction on the gap that
    // arrives at the requested install — unless one's already been saved for it.
    const avg = readMetric('avgDispatchTime');
    const dispatchRows = rows('Dispatch');
    const stopById = {};
    stopsFor(installer, date).forEach(s => { stopById[String(s.id)] = s; });
    return json({ ok: true, gaps: gaps.map(g => {
      const allocs = allocFor(g.start, g.end);
      if (!allocs.some(a => String(a.category).toUpperCase() === 'DISPATCH')) {
        const dm = dispatchSuggestMin(stopById[String(g.toId)], dispatchRows, avg);
        if (dm != null && dm > 0) allocs.push({ category: 'DISPATCH', minutes: dm });
      }
      return { start: g.start, end: g.end, idleMin: g.idleMin, toWO: g.toWO, toId: g.toId,
        distM: g.distM, suggest: g.suggest, allocations: allocs };
    }) });
  }
  return json({ ok: true, message: 'Meter Log spine is up.' });
}

// ── Actions ────────────────────────────────────────────────────────────────
function addStop(b) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stops');
  const id = b.id || newId();
  // Idempotency: if the client sent an id we already appended, this is a retry of
  // a write that actually succeeded (the client just never saw the response). Ack
  // it without writing a second row. Dispatch downtime already ran the first time.
  if (b.id && idExists(sh, b.id)) {
    // Idempotent retry — still refresh the boat meta so a late re-send keeps the
    // phone's offline daily-log cache current.
    const r = { ok: true, id: b.id };
    if (b.installerId) r.boatMeta = boatMetaFor(b.installerId, dateOf(b.timestamp || now()));
    return r;
  }
  b.timestamp = b.timestamp || now();   // resolve once so the Stops row, the
  // reconciled Dispatch completedTime, and applyDispatchDowntime all agree.
  const row = [
    id, b.timestamp, b.installer || '', b.workOrderId || '',
    b.unit || '', b.address || '', numOrBlank(b.lat), numOrBlank(b.lng),
    b.newJNumber || '', b.oldJNumber || '', numOrBlank(b.meterRead),
    b.status || '', b.utiReason || '', b.notes || '', b.noReadReason || '',
    numOrBlank(b.meterReadReceived),
    b.requestedMeter ? 'Y' : '',   // "Requested meter?" flag → end-of-day dispatch deduction
    normWorkType(b.workType)
  ];

  // Dedup: only INSTALLED stops with both a WO# and a new J# are checked.
  // UTI/DONE entries are always appended without restriction.
  let flagged = false, hist = null;
  if (b.status === 'INSTALLED' && b.workOrderId && b.newJNumber) {
    const norm = v => String(v == null ? '' : v).trim().toUpperCase();
    const history = rows('Stops').filter(r =>
      norm(r.workOrderId) === norm(b.workOrderId) && r.status === 'INSTALLED'
    );

    // Exact duplicate: same WO# + same newJNumber → reject without writing.
    if (history.some(r => norm(r.newJNumber) === norm(b.newJNumber))) {
      return { ok: false, duplicate: true, history: history };
    }

    // J# conflict: same WO# but a different newJNumber → write and warn.
    if (history.length > 0) { flagged = true; hist = history; }
  }

  sh.appendRow(row);
  bustRows('Stops');
  // No dispatch work here — the live write stays a cheap append. A "Requested
  // meter?" stop just carries the requestedMeter flag; the dispatch wait is
  // matched and pre-filled as an editable travel deduction at end of day
  // (?action=idle → dispatchSuggestMin), and the hourly avgDispatchTime trigger
  // keeps the running average + matched Dispatch rows fresh off the hot path.
  const res = { ok: true, id: id };
  if (flagged) { res.flagged = true; res.history = hist; }
  // Whole-boat dispatch + team header for the phone's offline daily-log cache.
  // One team-scoped read per log — keeps a value in cache as the crew works.
  if (b.installerId) res.boatMeta = boatMetaFor(b.installerId, dateOf(b.timestamp));
  return res;
}

/** End-of-day dispatch deduction suggested for a gap's arriving install — the
 *  wait between asking dispatch for a meter and getting on it. From today's
 *  Dispatch rows (keyed on oldJ) it takes the latest request at/before the stop
 *  carrying the same oldJ: same-day → the measured minutes (install − request);
 *  cross-day → avg×1.25 (don't count the overnight hours). A stop flagged
 *  "Requested meter?" with no logged request falls back to the running average.
 *  Returns null when there's nothing to suggest. Surfaced by ?action=idle so the
 *  EOD travel review pre-fills it as an editable DISPATCH deduction. */
function dispatchSuggestMin(stop, dispatchRows, avg) {
  if (!stop) return null;
  const norm = v => String(v == null ? '' : v).trim().toUpperCase();
  const st = norm(stop.status);
  if (st !== 'INSTALLED' && st !== 'UTI') return null;
  const key = norm(stop.oldJNumber);
  const sMs = localMs(stop.timestamp);
  let best = null;   // latest request at/before the stop carrying this oldJ
  if (key && sMs != null) {
    (dispatchRows || []).forEach(r => {
      if (norm(r.oldJNumber) !== key) return;
      const rMs = localMs(r.requestTime);
      if (rMs == null || rMs > sMs) return;
      if (!best || rMs > best.ms) best = { ms: rMs, ts: r.requestTime };
    });
  }
  if (best) {
    if (dateOf(best.ts) === dateOf(stop.timestamp))
      return Math.max(0, Math.round((sMs - best.ms) / 60000));   // measured, same day
    return avg == null ? null : Math.round(avg * 1.25);          // cross-day cap
  }
  const flagged = ['Y', 'TRUE', '1'].indexOf(
    String(stop.requestedMeter == null ? '' : stop.requestedMeter).trim().toUpperCase()) !== -1;
  return (flagged && avg != null) ? avg : null;
}

function addDowntime(b) {
  if (b.category === 'OTHER' && !(b.note || '').trim())
    return { ok: false, error: 'OTHER downtime needs a note' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Downtime');
  const id = b.id || newId();
  if (b.id && idExists(sh, b.id)) return { ok: true, id: b.id };   // idempotent retry — see addStop
  sh.appendRow([
    id, b.timestamp || now(), b.installer || '',
    (b.category || 'OTHER').toUpperCase(), parseInt(b.minutes, 10) || 0,
    b.workOrderId || '', b.note || '', normWorkType(b.workType)
  ]);
  bustRows('Downtime');
  return { ok: true, id: id };
}

/** Apple Shortcut endpoint: log a pending dispatch request keyed on oldJ. The
 *  request is closed out later by applyDispatchDowntime when the matching stop
 *  is completed. Sends only a time + oldJ (no installer — match is oldJ-only). */
function dispatchRequest(b) {
  if (!b.oldJ) return { ok: false, error: 'oldJ required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Dispatch');
  if (!sh) return { ok: false, error: 'Dispatch tab missing' };
  sh.appendRow([ newId(), b.time || now(), String(b.oldJ).trim(), '', '', '', '' ]);
  bustRows('Dispatch');
  return { ok: true };
}

/** Edit a stored stop in place, found by its id. Only STOP_EDITABLE fields
 *  (plus the numeric meterRead/lat/lng) can change; id/installer are preserved
 *  so a correction never rewrites who logged it. The clock part of `timestamp`
 *  CAN be corrected via `arrivalTime` ("HH:mm") — the calendar date is kept, so
 *  the stop never jumps days — because that time drives the daily log's per-row
 *  Travel (min) column. */
function updateStop(b) {
  if (!b.id) return { ok: false, error: 'id required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stops');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(b.id)) {
      const row = {};
      headers.forEach((h, j) => row[h] = data[i][j]);

      STOP_EDITABLE.forEach(k => { if (k in b) row[k] = b[k] == null ? '' : b[k]; });
      if ('meterRead' in b) row.meterRead = numOrBlank(b.meterRead);
      if ('meterReadReceived' in b) row.meterReadReceived = numOrBlank(b.meterReadReceived);
      if ('lat' in b)       row.lat       = numOrBlank(b.lat);
      if ('lng' in b)       row.lng       = numOrBlank(b.lng);
      // Swap only the clock, keeping the row's existing calendar date (fall back
      // to b.date if the stamp is somehow blank). Stored as a plain local string
      // so dateOf()/secOfDay() read it back the same way now() writes it.
      if (b.arrivalTime) {
        const datePart = dateOf(row.timestamp) || b.date || today();
        row.timestamp = datePart + ' ' + b.arrivalTime + ':00';
      }

      const out = headers.map(h => row[h]);
      sh.getRange(i + 1, 1, 1, headers.length).setValues([out]);   // i is 0=header, so sheet row = i+1
      bustRows('Stops');
      return { ok: true, id: b.id };
    }
  }
  // Not in Stops — if the back office archived it, ack the edit as TERMINAL so a
  // phone's queued offline update (or backfillAddresses patch) can't wedge its
  // FIFO queue forever retrying (flush() only dequeues on a recognized ok body).
  // The edit is deliberately dropped, not applied — the archive is a frozen record.
  const arch = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('StopsArchive');
  if (arch && idExists(arch, b.id)) return { ok: true, id: b.id, archived: true };
  return { ok: false, error: 'id not found' };
}

/** Move a Stops row to StopsArchive — the "remove from the log" action. Never a
 *  hard delete: the archive copy is appended BEFORE the source row is deleted, so
 *  a crash mid-way duplicates (converged by the idExists guard on retry) rather
 *  than loses data. Idempotent on id, and every outcome is TERMINAL ({ok:true})
 *  so a phone's offline queue always drains — an id found nowhere means the
 *  removal already happened (or there's nothing to remove), not "retry forever".
 *  If the stop's day was already closed, its Tracker/Timing rows are rebuilt
 *  from the surviving stops (regenerateDayRows). */
function archiveStop(b) {
  if (!b.id) return { ok: false, error: 'id required' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Stops');
  const arch = ss.getSheetByName('StopsArchive');
  if (!arch) return { ok: false, error: 'StopsArchive tab missing — run setupSheets()' };

  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(b.id)) {
      const row = {};
      headers.forEach((h, j) => row[h] = data[i][j]);
      // Archive first (skip if a crashed prior attempt already appended it).
      if (!idExists(arch, b.id)) {
        arch.appendRow(STOPS_HEADERS.map(h => (h in row) ? row[h] : '')
          .concat([now(), b.removedBy || '', b.reason || '']));
      }
      bustRows('StopsArchive');
      sh.deleteRow(i + 1);          // i is 0=header, so sheet row = i+1
      bustRows('Stops');

      // Closed day → rebuild its Tracker/Timing from what's left. Installer +
      // date come from the found row (authoritative), not the client.
      const installer = String(row.installer == null ? '' : row.installer).trim();
      const date = dateOf(row.timestamp) || b.date || today();
      let regenerated = false;
      if (installer && dayClosed(installer, date)) {
        regenerateDayRows(date, installer, b.installerId);
        regenerated = true;
      }
      return { ok: true, id: b.id, archived: true, regenerated: regenerated };
    }
  }
  // Not in Stops: a retry of a removal that already succeeded, or nothing to do.
  if (idExists(arch, b.id)) return { ok: true, id: b.id, archived: true, alreadyArchived: true };
  return { ok: true, id: b.id, missing: true };
}

/** Move a StopsArchive row back into Stops — undo of archiveStop, triggered from
 *  edit.html's "Removed stops" list. Only the STOPS_HEADERS portion returns (the
 *  removal metadata stays behind with the deleted archive row). Same append-
 *  before-delete ordering and id idempotency as archiveStop; a closed day gets
 *  its Tracker/Timing rebuilt so the counts go back up. Online-only UI, so an
 *  unknown id is a plain error (nothing can be wedged by it). */
function restoreStop(b) {
  if (!b.id) return { ok: false, error: 'id required' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Stops');
  const arch = ss.getSheetByName('StopsArchive');
  if (!arch) return { ok: false, error: 'StopsArchive tab missing — run setupSheets()' };

  const data = arch.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(b.id)) {
      const row = {};
      headers.forEach((h, j) => row[h] = data[i][j]);
      if (!idExists(sh, b.id)) {
        sh.appendRow(STOPS_HEADERS.map(h => (h in row) ? row[h] : ''));
      }
      bustRows('Stops');
      arch.deleteRow(i + 1);
      bustRows('StopsArchive');

      const installer = String(row.installer == null ? '' : row.installer).trim();
      const date = dateOf(row.timestamp) || b.date || today();
      let regenerated = false;
      if (installer && dayClosed(installer, date)) {
        regenerateDayRows(date, installer, b.installerId);
        regenerated = true;
      }
      return { ok: true, id: b.id, restored: true, regenerated: regenerated };
    }
  }
  if (idExists(sh, b.id)) return { ok: true, id: b.id, restored: true, alreadyRestored: true };
  return { ok: false, error: 'id not found' };
}

/** One installer's archived (removed) stops for a date — feeds edit.html's
 *  "Removed stops" list. Keyed the same way stopsFor is: display name + the
 *  stop timestamp's Toronto date. */
function archivedFor(installer, date) {
  // Tolerate a not-yet-created tab (code ships before setupSheets() is re-run).
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('StopsArchive')) return [];
  return rows('StopsArchive').filter(r =>
    sameName(r.installer, installer) && dateOf(r.timestamp) === date);
}

/** Find stops by work order # or J# (matches new or old J#). */
function lookup(p) {
  const norm = v => String(v == null ? '' : v).trim().toUpperCase();
  const wo = norm(p.wo), j = norm(p.j);
  if (!wo && !j) return { ok: false, error: 'provide wo or j' };

  const matches = rows('Stops').filter(r => {
    const woHit = wo && norm(r.workOrderId) === wo;
    const jHit  = j  && (norm(r.newJNumber) === j || norm(r.oldJNumber) === j);
    return woHit || jHit;
  });
  return { ok: true, matches: matches };
}

/** Reverse-geocode coordinates to a street address. Uses the built-in Maps
 *  service — no API key. The first run after adding this needs a re-auth so
 *  the Maps scope is granted; if it ever errors, the form just falls back to
 *  manual entry. */
function geocode(lat, lng) {
  try {
    if (isNaN(lat) || isNaN(lng)) return { ok: false, error: 'bad coords' };
    const res = Maps.newGeocoder().reverseGeocode(lat, lng);
    if (res && res.results && res.results.length) {
      return { ok: true, address: res.results[0].formatted_address };
    }
    return { ok: false, error: 'no result' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Builds the full day summary for one installer (counts, team header, the
 *  distance-split travel / delay totals, the per-stop delay map, stops + the
 *  categorized downtime). Pure read — writes nothing. Shared by endOfDay (which
 *  then appends the Tracker row) and previewDailyLog (which doesn't). When an
 *  installerId (H number) is supplied, the boat team is looked up and Partner /
 *  Captain / Boat Team / Boat Name auto-fill the daily log. */
function buildDaySummary(b) {
  const installerId = String(b.installerId == null ? '' : b.installerId).trim();
  const emp  = installerId ? employeeByH(installerId) : null;
  // Prefer the crew record's canonical name so the sheet always reads the same
  // way; fall back to whatever the form sent.
  const installer = emp ? fullName(emp) : (b.installer || '');
  const date = b.date || today();
  // Bookend times come from the request, else the persisted Days row, so a daily
  // log rebuilt later (edit.html) still anchors its Launch / Return legs.
  const persisted = dayMeta(installer, date);
  const departure = b.departure || persisted.departure || '';
  const returned  = b.returned  || persisted.returned  || '';
  const stops = stopsFor(installer, date);
  // The installer's own printable stops (same statuses the PDF prints as rows). Travel
  // is attributed per-person: only the gaps that land on one of these count toward this
  // installer's total — so on the merged boat timeline each segment belongs to whoever
  // arrived at it (a partner who logs first "owns" the dock launch, shown as '~').
  const ownPrintableIds = {};
  stops.filter(x => x.status === 'INSTALLED' || x.status === 'UTI'
                 || x.status === 'VISITED'  || x.status === 'UNACCOUNTED')
       .forEach(x => { if (x.id != null) ownPrintableIds[x.id] = true; });
  const installed   = stops.filter(s => s.status === 'INSTALLED').length;
  const uti         = stops.filter(s => s.status === 'UTI').length;
  const visited     = stops.filter(s => s.status === 'VISITED').length;
  const unaccounted = stops.filter(s => s.status === 'UNACCOUNTED').length;

  // Downtime rows for the day, sorted into four non-overlapping buckets by category:
  //   • delays → the 10 CATEGORIES (Delay Time box + Tracker per-cat columns)
  //   • breaks → LUNCH / BREAK (own daily-log line, kept OUT of the delay total)
  //   • misc   → MISC_TRAVEL (own daily-log line)
  //   • legacy TRAVEL_TIME → counts as travel, not a delay (back-compat, no bucket)
  const dt = downtimeFor(installer, date);
  const byCat = {}; CATEGORIES.forEach(c => byCat[c] = 0);
  const byBreak = {}; BREAK_CATS.forEach(c => byBreak[c] = 0);
  let downtimeTotal = 0, breaksTotal = 0, miscTravelTotal = 0;
  dt.forEach(d => {
    const c = d.category, m = d.minutes;
    if (BREAK_CATS.indexOf(c) >= 0)            { byBreak[c] += m; breaksTotal += m; }
    else if (TRAVEL_ADJ_CATS.indexOf(c) >= 0)  { miscTravelTotal += m; }
    else if (c === 'TRAVEL_TIME')              { /* travel, not a delay */ }
    else { byCat[c] = (byCat[c] || 0) + m; downtimeTotal += m; }
  });

  // Which template the phone should render: the caller's explicit workType wins
  // (the device knows its mode); a rebuild without one (edit.html) infers it from
  // the day's stops; a day with no typed stops falls back to boat.
  const typedStop = stops.find(s => String(s.workType || '').trim() !== '');
  const workType = b.workType ? normWorkType(b.workType)
                              : (typedStop ? normWorkType(typedStop.workType) : 'boat');

  const team = installerId ? teamForEmployee(installerId) : null;
  const hdr  = teamHeader(team, installerId);
  // No team sub (un-teamed installer, or a team card without one): fall back to
  // the installer's own Settings pick so the PDF "Sub:" box still fills.
  if (!hdr.sub && emp && emp.subName) hdr.sub = String(emp.subName).trim();
  // Whole-boat dispatch downtime for the PDF (sum of every crew member's own
  // DISPATCH downtime that day). May be stale if a teammate hasn't closed yet —
  // the Days sheet (updateBoatDispatch) is the always-current source of truth.
  const boatDispatchMin = team ? boatDispatchSum(team, date) : 0;

  // Sum the per-gap deductions, keyed by the gap's two clock times (dash-char
  // agnostic), so each gap's net travel = its raw minutes minus what was subtracted
  // from it. TRAVEL_TIME is excluded (it never subtracts — see isGapDeduction).
  const gapKey = (a, z) => a + '|' + z;
  const dedByGap = {};
  dt.forEach(d => {
    if (!isGapDeduction(d.category)) return;
    const m = gapNoteTimes(d.note); if (!m) return;
    const k = gapKey(m[1], m[2]);
    dedByGap[k] = (dedByGap[k] || 0) + d.minutes;
  });

  // Per-stop Travel column + the "Travel Time:" box now show NET travel (the raw gap
  // minus the downtime subtracted from it — exactly the number saved). Gaps run on the
  // merged boat timeline: travel to a stop is measured from the most recent boat log
  // (any member, any status), so a partner's installs cap the gap — see installerGapStops.
  // `travelMinutes` (Tracker `travelMin`) is the per-person net total: only gaps that
  // land on this installer's OWN printable stops (the dock launch '~' and the row-less
  // Return leg are both excluded). This mirrors the PDF box,
  // which sums the same per-stop column. A gap with no deductions is full travel; a
  // fully-consumed gap nets to 0 (prints blank), which reproduces old whole-gap days.
  const gi = installerGapStops(installerId, installer, date);
  const timing = computeIdle(gi.stops, gi.isFirst ? departure : '', returned);
  const ownIds = gi.ownIds;
  const perStopTravel = {};
  let travelMinutes = 0;
  // Keep only the boat segments that arrive at THIS installer's own stops (plus their
  // row-less Return leg) so a partner's segments aren't written under this installer or
  // double-counted when the partner also closes their day.
  const timingRows = timing.gaps
    .filter(g => g.type === 'Return' || (g.toId !== '' && g.toId != null && ownIds[g.toId]))
    .map(g => {
      const ded = dedByGap[gapKey(g.fromHHMM, g.toHHMM)] || 0;
      const net = Math.max(0, g.minutes - ded);
      const bucket = (g.minutes > 0 && ded >= g.minutes) ? 'delay' : (ded > 0 ? 'mixed' : 'travel');
      // Launch is the dock ride → shown as '~' below, excluded from the per-stop number AND the total.
      if (g.type !== 'Launch' && g.toId !== '' && g.toId != null) perStopTravel[g.toId] = net;
      if (g.type !== 'Launch' && g.type !== 'Return' && g.toId != null && g.toId !== ''
          && ownPrintableIds[g.toId]) travelMinutes += net;
      return { fromTime: g.fromHHMM, toTime: g.toHHMM, minutes: g.minutes,
               distanceM: g.distM == null ? '' : g.distM, type: g.type, bucket: bucket, workOrderId: g.toWO,
               fromStatus: g.fromStatus, toStatus: g.toStatus };
    });
  // The boat's first log shows '~' in its Travel cell — the morning ride is tracked
  // (Timing/Days) but never a meter-to-meter number, even with no Departure time set.
  if (gi.isFirst && gi.firstId != null) perStopTravel[gi.firstId] = '~';

  return { date, installer, installerId, installed, uti, visited, unaccounted, workType,
    // PDF-only flag: when false, the phone renderer omits the delay/travel cells.
    // It never affects the Tracker/Timing writes — analytics always gets full data.
    includeDelays: b.includeDelays !== false,
    downtimeTotalMin: downtimeTotal, byCategory: byCat,
    breaksTotalMin: breaksTotal, byBreak: byBreak, miscTravelMin: miscTravelTotal,
    travelMinutes: travelMinutes, boatDispatchMin: boatDispatchMin,
    perStopTravel: perStopTravel, timingRows: timingRows, idleGaps: timing.gaps,
    notes: b.notes || '', weather: b.weather || '', stops, downtime: dt,
    departure: departure, returned: returned,
    partner: hdr.partner, captain: hdr.captain, sub: hdr.sub,
    boatTeam: hdr.boatTeam, boatName: hdr.boatName,
    team: team ? team.id : null };
}

/** Computes today's totals for one installer, records the Tracker + Timing rows,
 *  and returns the daily-log PDF. Idempotent on (date, installer): re-closing a
 *  day overwrites its Tracker row and replaces its Timing rows instead of
 *  duplicating, so back-office regenerates (edit.html) stay clean. The Tracker row
 *  is written before the PDF so a PDF hiccup can't block closing the day. */
function endOfDay(b) {
  // The global dispatch match (avgDispatchTime) is NOT run here — with the
  // whole crew closing near quitting time it was the single longest hold on
  // the write lock (O(Stops × Dispatch)). It now runs on an hourly time
  // trigger (avgDispatchTimeJob — install once via createAvgDispatchTrigger).
  // The dispatch wait itself was already pre-filled and saved as a gap-tagged
  // DISPATCH travel deduction during the EOD review (saveTravel), so
  // buildDaySummary tallies it like any other allocation.

  const eodId = String(b.installerId == null ? '' : b.installerId).trim();
  const s = buildDaySummary(b);

  // Persist the bookend clock times so the daily log can always be rebuilt with
  // them — the field form used to discard departure/returned after the PDF.
  if (s.departure || s.returned) {
    saveDay({ date: s.date, installer: s.installer,
              departure: s.departure, returned: s.returned });
  }

  // Snapshot this installer's boat team for the day (BoatDays). Idempotent per
  // (date, boatNumber): each crew member who closes re-upserts the same row, so it
  // ends up reflecting the whole boat. Gives the viewer's boat-wide log→log metric
  // its daily membership and a standing record of who crewed which boat.
  // A land close skips the boat bookkeeping — BoatDays snapshots and the shared
  // boat dispatch only mean something for boat crews (the viewer's boat-wide
  // metrics group by them).
  const eodTeam = (eodId && s.workType !== 'land') ? teamForEmployee(eodId) : null;
  if (eodTeam) recordBoatDay(s.date, eodTeam);

  // Recompute the boat's shared dispatch downtime and write it (+ each member's
  // own total) onto every crew member's Days row, so the backend stays in sync
  // even when teammates close at different times.
  if (eodTeam) updateBoatDispatch(s.date, eodTeam);

  writeTrackerAndTiming(s);

  // The PDF is rendered on the phone from this summary (offline-capable) — the
  // spine no longer builds it. Return the summary only.
  return { ok: true, summary: s };
}

/** The Tracker upsert + Timing replace for one built day summary — shared by
 *  endOfDay (closing a day) and regenerateDayRows (rebuilding a closed day after
 *  a stop is archived/restored). */
function writeTrackerAndTiming(s) {
  const byCat = s.byCategory;
  // Upsert one Tracker row per (date, installer) — overwrite in place if it's
  // already closed, else append.
  upsertDayRow('Tracker', s.date, s.installer, [
    s.date, s.installer, s.installed, s.uti, s.downtimeTotalMin,
    byCat.NEXT_GEN, byCat.CELL_SIGNAL, byCat.BAD_WEATHER, byCat.WAREHOUSE,
    byCat.TOOLS_MATERIAL, byCat.DISPATCH, byCat.TRUCK_ISSUES, byCat.ASSIST,
    byCat.URGENT_EER, byCat.OTHER, s.weather, s.notes,
    s.visited, s.unaccounted, '', s.travelMinutes, '',   // autoIdleMin + delayMin are legacy/blank
    s.workType
  ]);

  // Per-gap audit trail (one row each) so the Travel Time / Delay numbers trace.
  // Clear this day's prior rows first so a regenerate doesn't pile duplicates.
  const timingSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Timing');
  if (timingSh) {
    deleteDayRows('Timing', s.date, s.installer);
    if (s.timingRows && s.timingRows.length) {
      timingSh.getRange(timingSh.getLastRow() + 1, 1, s.timingRows.length, TIMING_HEADERS.length)
        .setValues(s.timingRows.map(r => [s.date, s.installer, r.fromTime, r.toTime,
          r.minutes, r.distanceM, r.type, r.bucket, r.workOrderId, r.fromStatus, r.toStatus]));
    }
  }
}

/** Rebuild a closed day's Tracker + Timing from the CURRENT Stops/Downtime (the
 *  same math endOfDay runs) WITHOUT the close-time side effects: no Days write,
 *  no BoatDays snapshot (that would replace the historical record of who crewed
 *  the boat that day with today's roster), no boat-dispatch recompute (archiving
 *  a stop touches no Downtime row). The existing Tracker row's weather / notes /
 *  workType are preserved — they only ride in on the original close request.
 *  installerId keeps the team-aware gap merge, but only if it actually names
 *  this installer (a mismatched/absent id falls back to solo gaps). */
function regenerateDayRows(date, installer, installerId) {
  const prev = rows('Tracker').filter(r =>
    sameName(r.installer, installer) && dateOf(r.date) === date)[0] || null;
  const id = String(installerId == null ? '' : installerId).trim();
  const emp = id ? employeeByH(id) : null;
  const idOk = (emp && sameName(fullName(emp), installer)) ? id : '';
  writeTrackerAndTiming(buildDaySummary({
    date: date, installer: installer, installerId: idOk,
    weather: prev ? prev.weather : '', notes: prev ? prev.notes : '',
    workType: prev ? prev.workType : ''
  }));
}

/** Snapshot a boat's crew for one day into BoatDays — one row per (date, boatNumber),
 *  upserted in place so every member who closes (and any re-close) keeps it to a single
 *  current row. memberNames is the display-name list so the viewer can group stops by
 *  boat without the roster. Tolerates a not-yet-created tab (code can ship before
 *  setupSheets() adds BoatDays) so it never blocks closing the day. */
function recordBoatDay(date, team) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BoatDays');
  if (!sh) return;
  const boatNumber = String(team.boatNumber == null ? '' : team.boatNumber).trim();
  if (!boatNumber) return;
  const names = Object.keys(team.memberLetters).map(nameOfH).filter(Boolean);
  const out = [date, boatNumber, team.boatName || '', team.captainName || '',
              team.subName || '', JSON.stringify(team.memberLetters), JSON.stringify(names)];
  const data = sh.getDataRange().getValues();
  const H = data[0]; const dCol = H.indexOf('date'), bCol = H.indexOf('boatNumber');
  for (let r = 1; r < data.length; r++) {
    if (dateOf(data[r][dCol]) === date && String(data[r][bCol]).trim() === boatNumber) {
      sh.getRange(r + 1, 1, 1, out.length).setValues([out]);
      bustRows('BoatDays');
      return;
    }
  }
  sh.appendRow(out);
  bustRows('BoatDays');
}

/** Overwrite the row matching (date, installer) in a date+installer-keyed tab
 *  (Tracker), else append. `out` is the full positional row array. */
function upsertDayRow(tab, date, installer, out) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const data = sh.getDataRange().getValues();
  const H = data[0]; const dCol = H.indexOf('date'), iCol = H.indexOf('installer');
  for (let r = 1; r < data.length; r++) {
    if (dateOf(data[r][dCol]) === date && sameName(data[r][iCol], installer)) {
      sh.getRange(r + 1, 1, 1, out.length).setValues([out]);
      bustRows(tab);
      return;
    }
  }
  sh.appendRow(out);
  bustRows(tab);
}

/** Delete every row matching (date, installer) from a date+installer-keyed tab,
 *  bottom-up so indices stay valid. */
function deleteDayRows(tab, date, installer) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const data = sh.getDataRange().getValues();
  const H = data[0]; const dCol = H.indexOf('date'), iCol = H.indexOf('installer');
  for (let r = data.length - 1; r >= 1; r--) {
    if (dateOf(data[r][dCol]) === date && sameName(data[r][iCol], installer)) sh.deleteRow(r + 1);
  }
  bustRows(tab);
}

/** Replaces a day's gap-allocation Downtime rows (the per-gap travel deductions —
 *  delays, breaks, misc travel a reviewer subtracted from a WO→WO gap) with the
 *  posted set, so re-reviewing a day from either surface is idempotent and never
 *  duplicates. Only gap-tagged rows (note `gap HH:MM–HH:MM`) are touched — manual
 *  downtime logged from the field form is left alone. Rows are stamped on the gap's
 *  own date so a past day edited from edit.html still reads them back. */
function saveTravel(b) {
  const date = b.date || today();
  const installerId = String(b.installerId == null ? '' : b.installerId).trim();
  const emp = installerId ? employeeByH(installerId) : null;
  const installer = emp ? fullName(emp) : (b.installer || '');
  if (!installer) return { ok: false, error: 'installer required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Downtime');
  if (!sh) return { ok: false, error: 'Downtime tab missing' };

  // Drop this day's existing gap-tagged rows (bottom-up so indexes stay valid).
  const data = sh.getDataRange().getValues();
  const H = data[0];
  const iCol = H.indexOf('installer'), tsCol = H.indexOf('timestamp'), nCol = H.indexOf('note');
  for (let r = data.length - 1; r >= 1; r--) {
    if (sameName(data[r][iCol], installer) && dateOf(data[r][tsCol]) === date
        && gapNoteTimes(data[r][nCol])) sh.deleteRow(r + 1);
  }
  bustRows('Downtime');

  // Append the new allocations. Each carries the arriving WO + a `gap HH:MM–HH:MM`
  // note so buildDaySummary can attribute it back to the right gap.
  const allocs = (b.allocations || [])
    .filter(a => a && a.category && (parseInt(a.minutes, 10) || 0) > 0);
  if (allocs.length) {
    const ts = date + ' 12:00:00';   // anchored on the gap's date, not "now"
    sh.getRange(sh.getLastRow() + 1, 1, allocs.length, DOWNTIME_HEADERS.length).setValues(
      allocs.map(a => [ newId(), ts, installer, String(a.category).toUpperCase(),
        parseInt(a.minutes, 10) || 0, a.workOrderId || '',
        'gap ' + a.fromTime + '–' + a.toTime,
        // workType (8th col) — clients don't send it on saveTravel; blank = boat.
        b.workType ? normWorkType(b.workType) : '' ]));
    bustRows('Downtime');
  }
  return { ok: true, count: allocs.length };
}

/** Upsert the Days bookend row (one per date+installer). Reuses upsertDayRow's
 *  matching but writes only the four DAYS_HEADERS columns. */
function saveDay(b) {
  const date = b.date || today();
  const installer = b.installer || '';
  if (!installer) return { ok: false, error: 'installer required' };
  // Tolerate a not-yet-created Days tab (code can ship before setupSheets() runs)
  // so a missing tab never blocks closing the day from endOfDay.
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Days'))
    return { ok: false, error: 'Days tab missing — run setupSheets()' };
  upsertDayRow('Days', date, installer,
    [date, installer, b.departure || '', b.returned || '']);
  return { ok: true };
}

/** The persisted bookend times for an installer's day, or blanks (also when the
 *  Days tab doesn't exist yet). */
function dayMeta(installer, date) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Days')) return { departure: '', returned: '' };
  const r = rows('Days').filter(x => sameName(x.installer, installer) && dateOf(x.date) === date)[0];
  return { departure: r ? clockHHMM(r.departure) : '', returned: r ? clockHHMM(r.returned) : '' };
}

/** One installer's own dispatch downtime for a day = the sum of their
 *  DISPATCH-category Downtime rows (the editable gap deductions the EOD review
 *  writes via saveTravel). Mirrors buildDaySummary's byCategory.DISPATCH. */
function dispatchMinFor(installer, date) {
  return downtimeFor(installer, date)
    .filter(d => String(d.category).toUpperCase() === 'DISPATCH')
    .reduce((a, d) => a + (parseInt(d.minutes, 10) || 0), 0);
}

/** The whole-boat dispatch downtime for a day = the sum of every member's own
 *  dispatchMinFor. Dispatch waits stall the whole boat, so the crew share one
 *  number. Members are all H numbers on the boat that day (any letter). */
function boatDispatchSum(team, date) {
  if (!team) return 0;
  return Object.keys(team.memberLetters)
    .map(nameOfH).filter(Boolean)
    .reduce((a, name) => a + dispatchMinFor(name, date), 0);
}

/** The daily-log header block + whole-boat dispatch number for one installer's
 *  boat on a date — the bits the phone can't derive from its own cached stops.
 *  Returned on every addStop and the day/range reads so an offline daily-log PDF
 *  always has team names + the shared dispatch minutes already in cache. Returns
 *  null when no installerId is given (the caller leaves the cache untouched). */
function boatMetaFor(installerId, date) {
  const id = String(installerId == null ? '' : installerId).trim();
  if (!id) return null;
  const team = teamForEmployee(id);
  const hdr  = teamHeader(team, id);
  return { partner: hdr.partner, captain: hdr.captain, sub: hdr.sub,
           boatTeam: hdr.boatTeam, boatName: hdr.boatName,
           boatDispatchMin: team ? boatDispatchSum(team, date || today()) : 0 };
}

/** Header-aware partial upsert of a Days row: set only the named columns on the
 *  (date, installer) row, preserving everything else (bookends). Appends a fresh
 *  row if none exists yet — a teammate may not have closed their own day. */
function setDayFields(date, installer, fields) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Days');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  const H = data[0]; const dCol = H.indexOf('date'), iCol = H.indexOf('installer');
  for (let r = 1; r < data.length; r++) {
    if (dateOf(data[r][dCol]) === date && sameName(data[r][iCol], installer)) {
      Object.keys(fields).forEach(k => { const c = H.indexOf(k); if (c >= 0) data[r][c] = fields[k]; });
      sh.getRange(r + 1, 1, 1, H.length).setValues([data[r]]);
      bustRows('Days');
      return;
    }
  }
  const out = H.map(h => h === 'date' ? date : h === 'installer' ? installer
    : (k => k in fields ? fields[k] : '')(h));
  sh.appendRow(out);
  bustRows('Days');
}

/** Recompute the boat's shared dispatch downtime for a day and write it (plus
 *  each member's own total) onto every member's Days row. Called at endOfDay so
 *  the backend converges to the correct boat sum as each member closes — the
 *  last to close sees the most complete picture; earlier closers' PDFs may be
 *  stale, but the Days sheet always reflects the latest edit. */
function updateBoatDispatch(date, team) {
  if (!team) return;
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Days')) return;
  const members = Object.keys(team.memberLetters).map(nameOfH).filter(Boolean);
  const own = {}; let sum = 0;
  members.forEach(name => { const m = dispatchMinFor(name, date); own[name] = m; sum += m; });
  members.forEach(name => setDayFields(date, name, { dispatchMin: own[name], boatDispatchMin: sum }));
}

/** True when a Tracker row already exists for (installer, date) — the day is closed. */
function dayClosed(installer, date) {
  return rows('Tracker').some(r => sameName(r.installer, installer) && dateOf(r.date) === date);
}

/** Generates the daily-log PDF on demand WITHOUT closing the day: no Tracker row
 *  is written. Weather / notes stay blank unless the form sends them; departure /
 *  return fall back to the persisted Days row. The real endOfDay later fills the
 *  blanks. */
function previewDailyLog(b) {
  // Returns the summary the phone renders the PDF from — no Tracker/Timing write,
  // no server-side PDF. Weather / notes stay blank unless the form sends them;
  // departure / return fall back to the persisted Days row.
  return { ok: true, summary: buildDaySummary(b) };
}

/** The activity list for ONE installer's gap calc — the WHOLE boat's logs (every
 *  member, every status), merged into one timeline. Travel to any of this installer's
 *  stops is then measured from the most recent boat log, so a partner's installs cap
 *  the gap instead of inflating it. `ownIds` lets callers attribute each computed
 *  segment to the installer who arrived at it; `isFirst`/`firstId` mark whether this
 *  installer owns the boat's first log of the day (the dock launch → shown as '~'). */
function installerGapStops(installerId, installer, date) {
  const own = stopsFor(installer, date);
  const ownIds = {}; own.forEach(s => { if (s.id != null) ownIds[s.id] = true; });
  const team = installerId ? teamForEmployee(installerId) : null;
  const partners = teamPartnerNames(team, installerId);
  // Merge the whole boat's logs (all members, all statuses) so EVERY gap is measured
  // from the most recent boat log — a partner's installs cap the gap instead of
  // inflating it. No partners → just this installer's own stops.
  const merged = partners.length
    ? own.concat.apply(own, partners.map(n => stopsFor(n, date)))
    : own.slice();
  merged.sort((a, b) => (secOfDay(a.timestamp) || 0) - (secOfDay(b.timestamp) || 0));
  // This installer owns the boat's first log (ties → own) → they own the dock launch
  // ('~'); else their first gap runs from a partner's prior log.
  const firstSec = merged.length ? secOfDay(merged[0].timestamp) : null;
  const ownAtFirst = firstSec != null ? own.find(s => secOfDay(s.timestamp) === firstSec) : null;
  return { stops: merged, isFirst: !!ownAtFirst, ownIds: ownIds,
           firstId: ownAtFirst ? ownAtFirst.id : null };
}

/** The display names of the installer's same-letter boat-team partners (the
 *  array form of teamHeader().partner). */
function teamPartnerNames(team, selfH) {
  if (!team) return [];
  selfH = String(selfH || '').trim();
  const letter = team.memberLetters[selfH] || '';
  return Object.keys(team.memberLetters)
    .filter(h => h !== selfH && letter && team.memberLetters[h] === letter)
    .map(nameOfH).filter(Boolean);
}

/** Walk a day's team activity and emit ONE structured row per gap — the single
 *  source the totals, the PDF column, and the Timing audit tab all derive from.
 *  Each stop (any status: install, UTI, visited, unaccounted, done) is a marker
 *  carrying a timestamp + optional GPS, "since we still take the time to go and
 *  check." Between two consecutive markers the gap is typed by TIME:
 *    • gap <  FLAG_GAP_MIN → 'Travel' (auto, just driving between meters).
 *    • gap >= FLAG_GAP_MIN → 'Flagged' (surfaced at end-of-day to label; the
 *      distance-based `suggest` pre-fills Travel Time for a long ride else a
 *      downtime reason).
 *  Plus the 'Launch' leg (dock → first stop) and 'Return' leg (last stop → dock)
 *  when departure / return clock times are supplied. Each gap carries `toId` (the
 *  arriving stop, for the PDF column) and `distM`. `start`/`end`/`idleMin` are
 *  aliases the end-of-day labeller (renderIdleGaps) reads. The travel total and
 *  per-stop column are derived in buildDaySummary, which knows the gap labels. */
function computeIdle(teamStops, departure, returned) {
  const acts = (teamStops || [])
    .map(s => ({ id: s.id, sec: secOfDay(s.timestamp), lat: numCoord(s.lat), lng: numCoord(s.lng), wo: s.workOrderId, status: s.status }))
    .filter(a => a.sec != null)
    .sort((a, b) => a.sec - b.sec);

  const gaps = [];
  // fromStatus / toStatus record the gap's endpoint stop statuses so the backend
  // can separate the two lenses: install-to-install vs any-log-to-any-log. Dock
  // ends (Launch's from, Return's to) carry '' since there's no stop there.
  const mk = (fromSec, toSec, type, toId, toWO, distM, suggest, fromStatus, toStatus) => {
    const from = secToHHMM(fromSec), to = secToHHMM(toSec), minutes = Math.round((toSec - fromSec) / 60);
    gaps.push({ fromHHMM: from, toHHMM: to, minutes: minutes, distM: distM,
                type: type, toId: toId != null ? toId : '', toWO: toWO || '',
                suggest: suggest || '', fromStatus: fromStatus || '', toStatus: toStatus || '',
                start: from, end: to, idleMin: minutes, kind: 'gap' });   // aliases for renderIdleGaps
  };

  for (let i = 1; i < acts.length; i++) {
    const prev = acts[i - 1], cur = acts[i];
    if (cur.sec - prev.sec <= 0) continue;
    const moved = (prev.lat != null && prev.lng != null && cur.lat != null && cur.lng != null)
      ? Math.round(haversine(prev.lat, prev.lng, cur.lat, cur.lng)) : null;
    const flagged = (cur.sec - prev.sec) / 60 >= FLAG_GAP_MIN;
    mk(prev.sec, cur.sec, flagged ? 'Flagged' : 'Travel', cur.id, cur.wo, moved,
       flagged ? (moved != null && moved > SAME_ISLAND_M ? 'TRAVEL_TIME' : 'OTHER') : '',
       prev.status, cur.status);
  }

  // Launch → first stop and last stop → dock are always travel (coming from /
  // returning to land), anchored on the times entered at end of day.
  if (acts.length) {
    const dep = clockSec(departure), ret = clockSec(returned);
    const first = acts[0], last = acts[acts.length - 1];
    if (dep != null && first.sec > dep) mk(dep, first.sec, 'Launch', first.id, first.wo, null, '', '', first.status);
    if (ret != null && ret > last.sec)  mk(last.sec, ret, 'Return', null, '', null, '', last.status, '');
  }

  gaps.sort((a, b) => a.fromHHMM < b.fromHHMM ? -1 : a.fromHHMM > b.fromHHMM ? 1 : 0);
  return { gaps: gaps };
}

// ── Crew + boat teams ──────────────────────────────────────────────────────
/** The whole crew + every team, in one call. teams.html and the installer's
 *  name picker both read this. */
function roster() {
  return { ok: true, employees: employeesList(), teams: teamsList(),
           captains: namesList('Captains'), subs: namesList('Subs') };
}

/** The de-duplicated names from a quick-pick list tab (Captains / Subs). */
function namesList(tab) {
  const seen = {}, out = [];
  rows(tab).forEach(r => {
    const n = String(r.name == null ? '' : r.name).trim();
    if (n && !seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; out.push(n); }
  });
  return out;
}
/** Add a name to a quick-pick list if it isn't there yet (case-insensitive). */
function ensureName(tab, name) {
  name = String(name == null ? '' : name).trim();
  if (!name) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const data = sh.getDataRange().getValues();
  const col = data[0].indexOf('name');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]).trim().toLowerCase() === name.toLowerCase()) return;
  }
  sh.appendRow([name]);
  bustRows(tab);
}
function saveName(tab, name) {
  name = String(name == null ? '' : name).trim();
  if (!name) return { ok: false, error: 'name required' };
  ensureName(tab, name);
  return { ok: true, name: name };
}
function deleteName(tab, name) {
  name = String(name == null ? '' : name).trim();
  if (!name) return { ok: false, error: 'name required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const data = sh.getDataRange().getValues();
  const col = data[0].indexOf('name');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][col]).trim().toLowerCase() === name.toLowerCase()) {
      sh.deleteRow(i + 1);
      bustRows(tab);
      return { ok: true, name: name, deleted: true };
    }
  }
  return { ok: false, error: 'name not found' };
}

function employeesList() {
  return rows('Employees').map(r => ({
    hNumber:   String(r.hNumber == null ? '' : r.hNumber).trim(),
    firstName: String(r.firstName == null ? '' : r.firstName).trim(),
    lastName:  String(r.lastName == null ? '' : r.lastName).trim(),
    active:    isTruthy(r.active, true),
    subName:   String(r.subName == null ? '' : r.subName).trim()
  })).filter(e => e.hNumber);
}

function teamsList() {
  return rows('Teams').map(r => ({
    id:            String(r.id == null ? '' : r.id),
    boatNumber:    String(r.boatNumber == null ? '' : r.boatNumber).trim(),
    boatName:      String(r.boatName == null ? '' : r.boatName).trim(),
    captainName:   String(r.captainName == null ? '' : r.captainName).trim(),
    subName:       String(r.subName == null ? '' : r.subName).trim(),
    type:          normWorkType(r.type),
    memberLetters: normalizeLetters(parseMemberLetters(
      (r.memberLetters != null && r.memberLetters !== '') ? r.memberLetters : r.memberHs
    ))
  })).filter(t => t.id);
}

/** Add a crew member, or update one in place when the H number already exists. */
function saveEmployee(b) {
  const h = String(b.hNumber == null ? '' : b.hNumber).trim();
  if (!h) return { ok: false, error: 'employee number (H#) required' };
  const first = String(b.firstName == null ? '' : b.firstName).trim();
  const last  = String(b.lastName  == null ? '' : b.lastName ).trim();
  if (!first || !last) return { ok: false, error: 'first and last name required' };
  const active = b.active === false ? false : true;

  const fields = { hNumber: h, firstName: first, lastName: last, active: active };
  // subName only rides when the request carries it (the capture-page Settings
  // pick) — an omitted key preserves the existing cell, so admin saves and old
  // phones can never blank it; an explicit '' clears it on purpose.
  if (b.subName != null) {
    fields.subName = String(b.subName).trim();
    if (fields.subName) ensureName('Subs', fields.subName);
  }
  const r = upsertByHeader('Employees', 'hNumber', h, fields);
  const res = { ok: true, hNumber: h };
  res[r.created ? 'created' : 'updated'] = true;
  return res;
}

/** Remove a crew member and scrub them out of any team rosters / captaincies. */
function deleteEmployee(b) {
  const h = String(b.hNumber == null ? '' : b.hNumber).trim();
  if (!h) return { ok: false, error: 'employee number (H#) required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Employees');
  const data = sh.getDataRange().getValues();
  const hCol = data[0].indexOf('hNumber');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][hCol]).trim() === h) {
      sh.deleteRow(i + 1);
      bustRows('Employees');
      removeEmployeeFromTeams(h);
      return { ok: true, hNumber: h, deleted: true };
    }
  }
  return { ok: false, error: 'employee number not found' };
}

/** Ensures every required Teams column exists by name, appending any that are
 *  missing to the right. Handles any old schema variant (some sheets were
 *  created before captainName/subName/memberLetters existed). Safe on every
 *  save — it's a no-op once all columns are present. */
function ensureTeamsColumns() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Teams');
  if (!sh || sh.getLastColumn() === 0) return;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  let next = sh.getLastColumn() + 1;
  ['boatName', 'captainName', 'subName', 'memberLetters', 'type'].forEach(col => {
    if (headers.indexOf(col) === -1) {
      sh.getRange(1, next).setValue(col).setFontWeight('bold');
      next++;
    }
  });
}

/** Resolve a typed-in crew name to an employee H number, creating the Employees
 *  row when the name is new. Matches an existing employee by full name first
 *  (case-insensitive) so re-typing someone never makes a duplicate. Unlike
 *  saveEmployee this allows a single-word name (last name left blank). */
function ensureEmployeeByName(name) {
  name = String(name == null ? '' : name).trim();
  if (!name) return '';
  const match = employeesList().filter(e => fullName(e).toLowerCase() === name.toLowerCase())[0];
  if (match) return match.hNumber;
  const parts = name.split(/\s+/);
  const first = parts.shift();
  const last  = parts.join(' ');
  const h = newId();
  upsertByHeader('Employees', 'hNumber', h,
    { hNumber: h, firstName: first, lastName: last, active: true });
  return h;
}

/** Create a boat, or update one in place when its id is supplied. memberLetters
 *  is stored as a JSON map of employee number → team letter ({"H100":"A"}).
 *  newMembers ([{name, letter}]) are typed-in crew not yet in Employees; each is
 *  auto-created (or linked by name) and folded into memberLetters by H number. */
function saveTeam(b) {
  ensureTeamsColumns();
  const memberLetters = normalizeLetters(parseMemberLetters(b.memberLetters));
  (Array.isArray(b.newMembers) ? b.newMembers : []).forEach(m => {
    const h = ensureEmployeeByName(m && m.name);
    const L = String(m && m.letter == null ? '' : m.letter).trim().toUpperCase();
    if (h && L) memberLetters[h] = L;
  });
  const captainName   = String(b.captainName == null ? '' : b.captainName).trim();
  const subName       = String(b.subName == null ? '' : b.subName).trim();

  // Remember any new captain / sub names so they're in next time's dropdowns.
  ensureName('Captains', captainName);
  ensureName('Subs', subName);

  const id = b.id ? String(b.id) : newId();
  const r = upsertByHeader('Teams', 'id', b.id ? id : null, {
    id: id,
    boatNumber:    String(b.boatNumber == null ? '' : b.boatNumber).trim(),
    boatName:      String(b.boatName == null ? '' : b.boatName).trim(),
    captainName:   captainName,
    subName:       subName,
    memberLetters: JSON.stringify(memberLetters),
    type:          normWorkType(b.type)
  });
  const res = { ok: true, id: id };
  res[r.created ? 'created' : 'updated'] = true;
  return res;
}

function deleteTeam(b) {
  if (!b.id) return { ok: false, error: 'id required' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Teams');
  const data = sh.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(b.id)) {
      sh.deleteRow(i + 1);
      bustRows('Teams');
      return { ok: true, id: b.id, deleted: true };
    }
  }
  return { ok: false, error: 'id not found' };
}

/** Strip a departed employee off every boat. Captains/subs aren't employees,
 *  so those slots are left alone. */
function removeEmployeeFromTeams(h) {
  h = String(h).trim();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Teams');
  const data = sh.getDataRange().getValues();
  const memCol = data[0].indexOf('memberLetters');
  for (let i = 1; i < data.length; i++) {
    const obj = parseMemberLetters(data[i][memCol]);
    if (h in obj) {
      delete obj[h];
      sh.getRange(i + 1, memCol + 1).setValue(JSON.stringify(obj));
      SpreadsheetApp.flush();
      bustRows('Teams');
    }
  }
}

// Crew/team lookups used by endOfDay's auto-fill.
function fullName(e) { return e ? (e.firstName + ' ' + e.lastName).trim() : ''; }
// hNumber → employee index, built once per request (bustRows('Employees')
// clears it). nameOfH/employeeByH get called inside per-member loops
// (teamHeader, boatDispatchSum, recordBoatDay), so an O(1) lookup here keeps
// those loops from re-scanning the Employees tab every iteration.
function empIndex() {
  if (!EMP_IDX) {
    EMP_IDX = {};
    employeesList().forEach(e => { EMP_IDX[e.hNumber] = e; });
  }
  return EMP_IDX;
}
function employeeByH(h) { return empIndex()[String(h).trim()] || null; }
function nameOfH(h) { return fullName(employeeByH(h)); }
function teamForEmployee(h) {
  h = String(h).trim();
  return teamsList().filter(t => h in t.memberLetters)[0] || null;
}
/** The header block the daily log auto-fills for this installer's boat:
 *  partner = the others on the boat who share this installer's letter; captain +
 *  sub (free-text names, shared across the boat); boatTeam = boat number + the
 *  installer's letter ("11A"); and the boat name. */
function teamHeader(team, selfH) {
  if (!team) return { partner: '', captain: '', sub: '', boatTeam: '', boatName: '' };
  selfH = String(selfH || '').trim();
  const letter = team.memberLetters[selfH] || '';
  const partners = Object.keys(team.memberLetters)
    .filter(h => h !== selfH && letter && team.memberLetters[h] === letter)
    .map(nameOfH).filter(Boolean);
  return { partner: partners.join(', '), captain: team.captainName, sub: team.subName,
           boatTeam: (team.boatNumber + letter),   // e.g. "11A"
           boatName: team.boatName };
}

/** Parse a stored member→letter map (JSON object {hNumber:"A"}) into an object.
 *  Tolerates a blank cell or a legacy JSON array of H numbers (those members
 *  come back with no letter assigned). */
function parseMemberLetters(v) {
  if (v == null || v === '') return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  const s = String(v).trim();
  if (s.charAt(0) === '{') {
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch (e) {}
  }
  if (s.charAt(0) === '[') {   // legacy memberHs array → assign default letter 'A' so members survive migration
    try { const a = JSON.parse(s); if (Array.isArray(a)) { const o = {}; a.forEach(h => { const hh = String(h).trim(); if (hh) o[hh] = 'A'; }); return o; } } catch (e) {}
  }
  return {};
}
/** Trim/upper-case the letters and drop any blank H number or blank letter. */
function normalizeLetters(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(h => {
    const hh = String(h).trim(), L = String(obj[h] == null ? '' : obj[h]).trim().toUpperCase();
    if (hh && L) out[hh] = L;
  });
  return out;
}

// ── Reads ──────────────────────────────────────────────────────────────────
function stopsFor(installer, date) {
  return rows('Stops').filter(r =>
    (!installer || sameName(r.installer, installer)) && dateOf(r.timestamp) === date);
}
function downtimeFor(installer, date) {
  return rows('Downtime').filter(r =>
    (!installer || sameName(r.installer, installer)) && dateOf(r.timestamp) === date);
}

/** One installer's stops + downtime over [from, to] (inclusive, Toronto dates),
 *  grouped by day and sorted oldest→newest. Each `rows()` read is scanned once,
 *  so this is one pass instead of a `day` call per date. Returns the same shape
 *  the phone's dayCache stores. */
function rangeData(installer, from, to) {
  const inRange = ts => { const d = dateOf(ts); return d && d >= from && d <= to; };
  const byDate = {};
  const bucket = d => byDate[d] || (byDate[d] = { date: d, stops: [], downtime: [] });
  rows('Stops').forEach(r => {
    if ((!installer || sameName(r.installer, installer)) && inRange(r.timestamp))
      bucket(dateOf(r.timestamp)).stops.push(r);
  });
  rows('Downtime').forEach(r => {
    if ((!installer || sameName(r.installer, installer)) && inRange(r.timestamp))
      bucket(dateOf(r.timestamp)).downtime.push(r);
  });
  return Object.keys(byDate).sort().map(d => byDate[d]);
}

function nearby(lat, lng, radiusM) {
  const done = rows('Stops').filter(r => r.lat !== '' && r.lng !== '');
  const hits = done
    .map(r => Object.assign(r, { distanceM: haversine(lat, lng, +r.lat, +r.lng) }))
    .filter(r => r.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
  return { ok: true, alreadyDone: hits.length > 0, matches: hits };
}

/** Every stop, for the map + analytics viewer. The map plots the ones that
 *  have coordinates; the analytics view counts them all (a stop logged without
 *  GPS still counts toward installs/UTIs, it just can't be pinned). DONE
 *  markers are included so the map can show "already installed" spots — the
 *  viewer leaves them out of the install/UTI tallies. */
// True when a row's Toronto date lands inside the optional [from, to] window.
// Blank/missing bounds are open-ended, so windowless calls keep returning
// everything. Always compare via dateOf() — never a raw string slice.
function inWindow(d, from, to) {
  return !!d && (!from || d >= from) && (!to || d <= to);
}

function pins(from, to) {
  return { ok: true, pins: rows('Stops')
    .filter(r => (!from && !to) || inWindow(dateOf(r.timestamp), from, to))
    .map(r => ({
    id: r.id, timestamp: r.timestamp, installer: r.installer,
    workOrderId: r.workOrderId, unit: r.unit, address: r.address,
    lat: (r.lat === '' || r.lat == null) ? null : Number(r.lat),
    lng: (r.lng === '' || r.lng == null) ? null : Number(r.lng),
    newJNumber: r.newJNumber, oldJNumber: r.oldJNumber,
    meterRead: r.meterRead, status: r.status, utiReason: r.utiReason,
    notes: r.notes
  })) };
}

/** Tracker rows (the end-of-day running totals), for the viewer's trend
 *  charts, optionally windowed by [from, to]. The viewer still filters by
 *  installer + narrows the date range on its side. */
function tracker(from, to) {
  return { ok: true, tracker: rows('Tracker')
    .filter(r => (!from && !to) || inWindow(dateOf(r.date), from, to)) };
}

/** Downtime rows across ALL installers, optionally windowed by [from, to] on
 *  the row's Toronto date. Backs the reports page's open-day delay tallies —
 *  one call for the whole crew instead of a ?action=day per installer. */
function downtimeRows(from, to) {
  return { ok: true, downtime: rows('Downtime')
    .filter(r => (!from && !to) || inWindow(dateOf(r.timestamp), from, to)) };
}

/** Per-gap audit rows (the Timing tab), optionally windowed by [from, to].
 *  Feeds the analytics "avg time between meters" metric — the viewer filters
 *  by installer and averages the WO→WO gaps (type Travel / Flagged) on its side. */
function timing(from, to) {
  return { ok: true, timing: rows('Timing')
    .filter(r => (!from && !to) || inWindow(dateOf(r.date), from, to)) };
}

/** The daily boat-team snapshots (the BoatDays tab), optionally windowed by
 *  [from, to]. Feeds the viewer's boat-wide "log→log" metric (it groups stops by
 *  the boat each installer crewed that day) and is the historical record of who
 *  crewed which boat. Empty array if the tab doesn't exist yet (setupSheets()
 *  hasn't been re-run). */
function boatDays(from, to) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('BoatDays')) return { ok: true, boatDays: [] };
  return { ok: true, boatDays: rows('BoatDays')
    .filter(r => (!from && !to) || inWindow(dateOf(r.date), from, to)) };
}

/** Dispatch rows, optionally windowed by [from, to]. A matched row is dated by
 *  its completedTime, an unmatched (still-pending) one by its requestTime —
 *  the same way map.html dates them for the "avg dispatch downtime" tile. */
function dispatchRows(from, to) {
  return { ok: true, dispatch: rows('Dispatch')
    .filter(r => (!from && !to)
      || inWindow(dateOf(r.completedTime || r.requestTime), from, to)) };
}

// ── Helpers ──────────────────────────────────────────────────────────────
// True if a row with this id already exists. Reads only the id column (column A,
// the first header for every id-bearing tab) so the idempotency check stays cheap
// versus a full rows() load on the per-stop write path.
function idExists(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  const want = String(id);
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === want) return true;
  return false;
}

// Request-scoped memo for rows(): Apps Script re-initializes globals on every
// execution, so this caches within ONE doGet/doPost only — a `day` read that
// touches Stops six times scans the sheet once. Every write site must call
// bustRows(tab) so a read-after-write inside the same request stays fresh.
const ROWS_MEMO = {};
let EMP_IDX = null;   // hNumber → employee, rebuilt lazily (see empIndex)

// On top of the per-request memo, the small slow-changing tabs also sit in
// CacheService ACROSS requests (6h TTL, ~90KB guard vs the 100KB/key limit —
// 75 employees is ~6KB). Roster data is read by nearly every action (name
// lookups, team joins, the roster GET) but only changes when an admin saves,
// so the write sites' bustRows() also evicts the CacheService copy. A
// cross-instance race can serve a roster a few seconds stale right after an
// admin edit — accepted: teams.html re-fetches after each save anyway, and no
// field write depends on second-level roster freshness. The big/hot tabs
// (Stops, Downtime, …) are deliberately NOT here: too large for the 100KB cap
// and written on every log.
const CACHED_TABS = { Employees: 1, Teams: 1, Captains: 1, Subs: 1, Metrics: 1 };
const CACHED_TABS_TTL_S = 21600;   // 6h, the CacheService max
function scriptCache() {
  try { return CacheService.getScriptCache(); } catch (e) { return null; }
}

function bustRows(tabName) {
  delete ROWS_MEMO[tabName];
  if (tabName === 'Employees') EMP_IDX = null;
  if (CACHED_TABS[tabName]) {
    const c = scriptCache();
    if (c) try { c.remove('rows:' + tabName); } catch (e) {}
  }
}

function rows(tabName) {
  if (ROWS_MEMO[tabName]) return ROWS_MEMO[tabName];
  const cacheable = !!CACHED_TABS[tabName];
  if (cacheable) {
    const c = scriptCache();
    const hit = c && c.get('rows:' + tabName);
    if (hit) {
      try { return (ROWS_MEMO[tabName] = JSON.parse(hit)); } catch (e) {}
    }
  }
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  const mapped = data.map(row => {
    const o = {};
    // Sheets silently coerces a naive timestamp string into a Date in the cell;
    // JSON.stringify would then serialize it as UTC ("…Z"), leaking the Toronto↔UTC
    // offset into every reader. Normalize any Date back to the app's naive
    // Toronto-local string contract here, at the single read boundary.
    headers.forEach((h, i) => o[h] = (row[i] instanceof Date)
      ? Utilities.formatDate(row[i], TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : row[i]);
    return o;
  });
  if (cacheable) {
    const c = scriptCache();
    if (c) {
      const s = JSON.stringify(mapped);
      if (s.length < 90000) try { c.put('rows:' + tabName, s, CACHED_TABS_TTL_S); } catch (e) {}
    }
  }
  return (ROWS_MEMO[tabName] = mapped);
}

/** Write a record keyed by header NAME, not column position, so a reordered
 *  sheet can't scramble data (rows() already reads by name; this keeps writes
 *  symmetric). `fields` is a {header: value} map. The row whose keyField cell
 *  equals keyValue is overwritten in place — cells whose header isn't in
 *  `fields` keep their current value; if no match (or keyValue is blank/null) a
 *  new row is appended with only the named cells filled. Returns {created}. */
function upsertByHeader(tabName, keyField, keyValue, fields) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const build = existing => headers.map((h, j) =>
    (h in fields) ? fields[h] : (existing ? existing[j] : ''));

  const keyCol = headers.indexOf(keyField);
  if (keyCol !== -1 && keyValue !== '' && keyValue != null) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][keyCol]).trim() === String(keyValue).trim()) {
        sh.getRange(i + 1, 1, 1, headers.length).setValues([build(data[i])]);
        bustRows(tabName);
        return { created: false };
      }
    }
  }
  sh.appendRow(build(null));
  bustRows(tabName);
  return { created: true };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json(obj)      { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function now()          { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }
function today()        { return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'); }
function newId()        { return Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
// Parse a Toronto-local "yyyy-MM-dd HH:mm[:ss]" (or ISO 'T' form) into a Date.
// Any trailing zone marker is ignored — both the request time and the stop
// timestamp are naive Toronto strings, so a component-wise Date keeps the diff exact.
function parseLocal(s) {
  const m = String(s == null ? '' : s).replace('T', ' ')
    .match(/(\d{4})-(\d\d)-(\d\d)[ ](\d{1,2}):(\d\d)(?::(\d\d))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6] || 0) : null;
}
// Epoch ms from a Date or a Toronto-local string; null if unparseable. A Sheets
// datetime cell can read back as a Date, so the dispatch matcher accepts both.
function localMs(v) {
  if (v instanceof Date) return v.getTime();
  const d = parseLocal(v);
  return d ? d.getTime() : null;
}
// Canonical Toronto 'yyyy-MM-dd HH:mm:ss' from a Date or local string (echoes the
// raw value back if unparseable) — so completedTime can be compared exactly.
function localStamp(v) {
  const ms = localMs(v);
  return ms == null ? String(v == null ? '' : v)
                    : Utilities.formatDate(new Date(ms), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}
/** The single source of truth for dispatch matching. Pairs every requested
 *  meter (Dispatch) to the completed install (Stops, status INSTALLED/UTI)
 *  carrying the same oldJ — each request taking the earliest still-unused
 *  install at/after its requestTime, so two requests for one meter can't both
 *  claim a single install. For each pair it FILLS that Dispatch row
 *  (installer/completedTime/minutes/matched='Y'), then persists the rounded mean
 *  wait to the Metrics tab (`avgDispatchTime`) and returns it (null if nothing
 *  pairs). Retroactive and idempotent — re-runs converge; unmatched rows are
 *  left untouched. */
function avgDispatchTime() {
  const norm = v => String(v == null ? '' : v).trim().toUpperCase();
  const installs = rows('Stops')
    .filter(r => { const s = norm(r.status); return s === 'INSTALLED' || s === 'UTI'; })
    .map(r => ({ oldJ: norm(r.oldJNumber), t: localMs(r.timestamp),
                 ts: localStamp(r.timestamp), installer: r.installer || '', used: false }))
    .filter(r => r.oldJ && r.t != null);

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Dispatch');
  const data = sh.getDataRange().getValues();
  const H = data[0]; const c = n => H.indexOf(n);
  // Row indices sorted by requestTime so earliest requests claim installs first.
  const reqIdx = [];
  for (let r = 1; r < data.length; r++) {
    const t = localMs(data[r][c('requestTime')]);
    if (norm(data[r][c('oldJNumber')]) && t != null)
      reqIdx.push({ r: r, t: t, reqDate: dateOf(data[r][c('requestTime')]) });
  }
  reqIdx.sort((a, b) => a.t - b.t);

  // First pass: pair each request to its earliest unused install. A pair whose
  // install lands on a later day than the request is "cross-day" — its raw wait is
  // many overnight hours, so it's kept out of the mean (and recorded below as
  // avg×1.25, not the raw gap) so it can't inflate the running average.
  const pairs = [];
  reqIdx.forEach(({ r, t, reqDate }) => {
    const oldJ = norm(data[r][c('oldJNumber')]);
    let best = null;
    installs.forEach(inst => {
      if (inst.used || inst.oldJ !== oldJ || inst.t < t) return;
      if (!best || inst.t < best.t) best = inst;
    });
    if (!best) return;
    best.used = true;
    pairs.push({ r: r, best: best, rawMin: Math.max(0, Math.round((best.t - t) / 60000)),
                 sameDay: dateOf(best.ts) === reqDate });
  });

  // Mean from same-day pairs only; cross-day pairs are recorded at avg×1.25.
  const ok = pairs.filter(p => p.sameDay && !isNaN(p.rawMin) && p.rawMin > 0).map(p => p.rawMin);
  const avg = ok.length ? Math.round(ok.reduce((a, x) => a + x, 0) / ok.length) : null;
  const crossMin = avg == null ? null : Math.round(avg * 1.25);

  // Second pass: fill each matched row. Only writes a row whose value changes.
  pairs.forEach(({ r, best, rawMin, sameDay }) => {
    const minutes = sameDay ? rawMin : (crossMin == null ? rawMin : crossMin);
    if (String(data[r][c('matched')]).trim().toUpperCase() !== 'Y'
        || Number(data[r][c('minutes')]) !== minutes
        || localStamp(data[r][c('completedTime')]) !== best.ts
        || !sameName(data[r][c('installer')], best.installer)) {
      data[r][c('installer')]     = best.installer;
      data[r][c('completedTime')] = best.ts;
      data[r][c('minutes')]       = minutes;
      data[r][c('matched')]       = 'Y';
      sh.getRange(r + 1, 1, 1, H.length).setValues([data[r]]);
      bustRows('Dispatch');
    }
  });

  ensureMetricsTab();
  upsertByHeader('Metrics', 'metric', 'avgDispatchTime',
    { metric: 'avgDispatchTime', value: avg == null ? '' : avg, updated: now() });
  return avg;
}

// Read a stored Metrics value by name as a Number, or null if absent/blank.
function readMetric(name) {
  ensureMetricsTab();
  const hit = rows('Metrics').find(r => String(r.metric).trim() === name);
  if (!hit || hit.value === '' || hit.value == null) return null;
  const n = Number(hit.value);
  return isNaN(n) ? null : n;
}

// Create the Metrics tab (with headers) on the fly if setupSheets() hasn't been
// re-run yet, so the dispatch code can't throw on an older sheet.
function ensureMetricsTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Metrics')) ensureTab(ss, 'Metrics', METRICS_HEADERS);
}
function numOrBlank(v)  { return (v === null || v === undefined || v === '') ? '' : Number(v); }
// Work type is binary; anything that isn't explicitly 'land' (incl. legacy blank
// rows written before the column existed) is boat work.
function normWorkType(v) { return String(v == null ? '' : v).trim().toLowerCase() === 'land' ? 'land' : 'boat'; }
function sameName(a, b) { return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim(); }
function numCoord(v)    { return (v === '' || v == null || isNaN(Number(v))) ? null : Number(v); }

/** Seconds-since-midnight (Toronto) for a stop timestamp. Mirrors dateOf(): a
 *  real Date or a UTC/offset ISO string is read in Toronto; a plain local stamp
 *  ("2026-06-19 10:58:04") has its time part taken as-is. Returns null if no
 *  time can be found. All idle math is same-day, so a seconds-of-day diff sidesteps
 *  epoch/timezone parsing entirely. */
function secOfDay(ts) {
  let hms;
  if (ts instanceof Date) {
    hms = Utilities.formatDate(ts, TIMEZONE, 'HH:mm:ss');
  } else {
    const s = String(ts);
    if (/T.*(Z|[+\-]\d\d:?\d\d)$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) hms = Utilities.formatDate(d, TIMEZONE, 'HH:mm:ss');
    }
    if (!hms) { const m = s.match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/); if (m) hms = m[1] + ':' + m[2] + ':' + (m[3] || '00'); }
  }
  if (!hms) return null;
  const p = hms.split(':');
  return (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0));
}
/** Seconds-since-midnight for an "HH:mm" clock string (a <input type=time>). */
function clockSec(v) { const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/); return m ? ((+m[1]) * 3600 + (+m[2]) * 60) : null; }
/** Normalize any Days-cell bookend value to an "HH:mm" clock string (or '').
 *  Handles a literal "HH:mm" string, a full timestamp, and a Date object that
 *  Sheets produced by coercing an entered time. Mirrors secOfDay's Date path. */
function clockHHMM(v) {
  if (v === '' || v == null) return '';
  if (v instanceof Date) return Utilities.formatDate(v, TIMEZONE, 'HH:mm');
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}
/** Seconds-since-midnight back to "HH:mm" for display. */
function secToHHMM(sec) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2); }
/** Coerce a sheet cell to a boolean. Blank cells fall back to `dflt` so an
 *  Employees row written before the 'active' column existed reads as active. */
function isTruthy(v, dflt) {
  if (v === '' || v == null) return dflt;
  if (v === true || v === false) return v;
  const s = String(v).trim().toLowerCase();
  return !(s === 'false' || s === 'no' || s === '0' || s === 'n');
}

/**
 * Normalise a timestamp to its Toronto calendar date (yyyy-MM-dd).
 *
 * Why this exists: when a stop is read back from the Sheet, the timestamp
 * cell can come back as a real Date object (Sheets often coerces an
 * ISO-looking string on the way in). The old code did String(ts).slice(0,10),
 * which on a Date gives "Fri Jun 19 …" — never equal to "2026-06-19", so
 * every row was filtered out and end-of-day totals came back all zeros.
 * It also fixes the web form's UTC stamps (…Z): an evening stop in Toronto
 * carries the NEXT day's UTC date, which used to land in the wrong day.
 */
function dateOf(ts) {
  if (ts instanceof Date) {
    return Utilities.formatDate(ts, TIMEZONE, 'yyyy-MM-dd');
  }
  const s = String(ts);
  // Has an explicit UTC 'Z' or numeric offset → it's an absolute instant; convert to Toronto.
  if (/T.*(Z|[+\-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
  }
  // Otherwise it's already a local string (now() output) or a plain date → first 10 chars.
  return s.slice(0, 10);
}

// ── GitHub markdown export ─────────────────────────────────────────────────
// Nightly snapshot of every data tab to data/*.md, committed to `main` in one
// atomic commit via the GitHub Git Data API. Trigger-driven — see
// createDailyExportTrigger(). Auth is a fine-grained PAT in Script Properties
// (GITHUB_TOKEN + GITHUB_REPO); a real secret, never hardcoded here.

// Escape one cell value for a GitHub-flavored-markdown table. Date cells (some
// columns hold real Date objects) render as Toronto 'yyyy-MM-dd HH:mm:ss'.
function mdEscapeCell(value) {
  let s;
  if (value == null) s = '';
  else if (Object.prototype.toString.call(value) === '[object Date]')
    s = Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  else s = String(value);
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

// Render one tab as: H1 + "_<n> rows · exported <ts> <tz>_" + GFM table (or
// "_(no rows)_" when there is no data). Trailing newline so files end clean.
function tabToMarkdown(name, headers, dataRows, exportedAt) {
  const meta = '_' + dataRows.length + ' row' + (dataRows.length === 1 ? '' : 's') +
    ' · exported ' + exportedAt + ' ' + TIMEZONE + '_';
  let body;
  if (!dataRows.length) {
    body = '_(no rows)_';
  } else {
    const head = '| ' + headers.map(mdEscapeCell).join(' | ') + ' |';
    const sep  = '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |';
    const lines = dataRows.map(function (r) {
      return '| ' + headers.map(function (_, i) { return mdEscapeCell(r[i]); }).join(' | ') + ' |';
    });
    body = [head, sep].concat(lines).join('\n');
  }
  return '# ' + name + '\n\n' + meta + '\n\n' + body + '\n';
}

// The data/README.md index: timestamp + a bullet per tab linking its file.
function buildIndexMarkdown(index, exportedAt) {
  const lines = index.map(function (t) {
    return '- [' + t.name + '](' + t.name + '.md) — ' +
      t.count + ' row' + (t.count === 1 ? '' : 's');
  });
  return '# Sheet export\n\n_Exported ' + exportedAt + ' ' + TIMEZONE + '_\n\n' +
    'Nightly Markdown snapshot of the meter-log Google Sheet.\n\n' +
    lines.join('\n') + '\n';
}

// Tabs exported, in order. Explicit (NOT ss.getSheets()) so the "DailyLog
// Template" tab is never exported. Headers still come live from each sheet, so
// a column reorder needs no change here — only adding a brand-new tab does.
const EXPORT_TABS = [
  'Stops', 'StopsArchive', 'Downtime', 'Tracker', 'Employees', 'Teams', 'Captains', 'Subs',
  'Timing', 'Days', 'BoatDays', 'Dispatch', 'Metrics'
];

// Read every EXPORT_TABS tab into [{path, content}] markdown files, plus the
// data/README.md index. A missing tab is skipped (run setupSheets() to create
// it). Header row + raw cell values come straight from the live sheet.
function buildExportFiles() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const exportedAt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm');
  const files = [];
  const index = [];
  EXPORT_TABS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const values = sh.getDataRange().getValues();
    const headers = values.length ? values[0] : [];
    const dataRows = values.slice(1);
    files.push({
      path: 'data/' + name + '.md',
      content: tabToMarkdown(name, headers, dataRows, exportedAt)
    });
    index.push({ name: name, count: dataRows.length });
  });
  files.push({ path: 'data/README.md', content: buildIndexMarkdown(index, exportedAt) });
  return files;
}

// Push every file in `files` to `main` in ONE atomic commit via the Git Data
// API (ref → base commit → new tree → new commit → move ref). Returns the new
// commit SHA. Throws (with the response body) on any non-2xx, so a partial push
// can never happen — the ref only moves after every blob/tree/commit succeeds.
function githubCommitFiles(files, message) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO');
  if (!token || !repo)
    throw new Error('Set GITHUB_TOKEN and GITHUB_REPO in Script Properties (Project Settings ▸ Script Properties).');

  const api = 'https://api.github.com/repos/' + repo + '/git';
  function gh(path, method, payload) {
    const opt = {
      method: method,
      muteHttpExceptions: true,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
    const res = UrlFetchApp.fetch(api + path, opt);
    const code = res.getResponseCode();
    if (code < 200 || code >= 300)
      throw new Error('GitHub ' + method + ' ' + path + ' → ' + code + ': ' + res.getContentText());
    return JSON.parse(res.getContentText());
  }

  const ref        = gh('/ref/heads/main', 'get');
  const baseSha    = ref.object.sha;
  const baseCommit = gh('/commits/' + baseSha, 'get');
  const tree = gh('/trees', 'post', {
    base_tree: baseCommit.tree.sha,
    tree: files.map(function (f) {
      return { path: f.path, mode: '100644', type: 'blob', content: f.content };
    })
  });
  const commit = gh('/commits', 'post', {
    message: message, tree: tree.sha, parents: [baseSha]
  });
  gh('/refs/heads/main', 'patch', { sha: commit.sha });
  return commit.sha;
}

// Diagnostic — run from the editor when exportSheetToGithub() 404s. It probes,
// in order: the GITHUB_REPO/token props, who the token authenticates as, whether
// the token can see the repo, and what the repo's default branch ref is. Each
// line in the log isolates one cause (bad repo string / token lacks repo access /
// default branch isn't 'main'). Never writes anything.
function githubDiag() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO');
  Logger.log('GITHUB_REPO  = ' + JSON.stringify(repo) + (repo && repo.trim() !== repo ? '  ⚠ has surrounding whitespace' : ''));
  Logger.log('GITHUB_TOKEN = ' + (token ? (token.slice(0, 7) + '… (' + token.length + ' chars)') : 'MISSING'));
  if (!token || !repo) { Logger.log('→ set both in Project Settings ▸ Script Properties'); return; }

  function probe(label, url) {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28' }
    });
    const code = res.getResponseCode();
    let note = '';
    try { const b = JSON.parse(res.getContentText());
          note = b.login || b.full_name || b.default_branch || b.message || ''; } catch (e) {}
    Logger.log(label + ' → ' + code + (note ? '  ' + note : ''));
    return code === 200 ? JSON.parse(res.getContentText()) : null;
  }

  probe('GET /user (who the token is)        ', 'https://api.github.com/user');
  const r = probe('GET /repos/' + repo + ' (can token see repo)', 'https://api.github.com/repos/' + repo.trim());
  if (r) {
    Logger.log('repo default_branch = ' + r.default_branch +
      (r.default_branch !== 'main' ? "  ⚠ NOT 'main' — the export targets main; rename the branch or change the code" : ''));
    Logger.log('repo permissions    = ' + JSON.stringify(r.permissions || {}) +
      ((r.permissions && r.permissions.push) ? '' : '  ⚠ no push/write — PAT needs Contents: Read AND write'));
  } else {
    Logger.log("→ 404/403 on the repo means the fine-grained PAT wasn't granted access to THIS repo. " +
      "Fix: the PAT's Resource owner = QuincyO, Repository access = select meter-log, Permissions ▸ Contents = Read and write.");
  }
}

// Trigger entry point: snapshot every tab and push it to main in one commit.
function exportSheetToGithub() {
  const files = buildExportFiles();
  const sha = githubCommitFiles(files, 'Nightly sheet export — ' + today());
  Logger.log('Pushed export commit ' + sha + ' (' + files.length + ' files).');
  return sha;
}

// Trigger entry point: refresh the dispatch request↔install match + the Metrics
// average. Runs hourly (see createAvgDispatchTrigger) instead of inside
// endOfDay, so the O(Stops × Dispatch) pairing never sits in the write lock
// while the whole crew is closing. Skips quietly if a write holds the lock —
// the next hourly run catches up (avgDispatchTime is idempotent/retroactive).
function avgDispatchTimeJob() {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(5000)) { Logger.log('avgDispatchTimeJob: lock busy, skipped'); return; }
  } catch (e0) { /* lock service unavailable — proceed unlocked */ }
  try { avgDispatchTime(); } finally { try { lock.releaseLock(); } catch (e1) {} }
}

// Run ONCE by hand from the editor to install the hourly dispatch-average
// trigger. Idempotent: deletes any existing avgDispatchTimeJob trigger first,
// so re-running doesn't stack duplicates.
function createAvgDispatchTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'avgDispatchTimeJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('avgDispatchTimeJob')
    .timeBased().everyHours(1).create();
  Logger.log('Hourly avgDispatchTime trigger installed.');
}

// Run ONCE by hand from the editor to install the nightly (~3am Toronto)
// trigger. Idempotent: deletes any existing exportSheetToGithub trigger first,
// so re-running doesn't stack duplicates.
function createDailyExportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'exportSheetToGithub') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('exportSheetToGithub')
    .timeBased().atHour(3).everyDays(1).inTimezone(TIMEZONE).create();
  Logger.log('Daily export trigger installed (~3am ' + TIMEZONE + ').');
}

// ── GitHub markdown export — self-tests (run from the editor) ───────────────
function test_markdownFormatting() {
  if (mdEscapeCell('a|b') !== 'a\\|b')   throw new Error('pipe not escaped');
  if (mdEscapeCell('a\nb') !== 'a<br>b') throw new Error('newline not escaped');
  if (mdEscapeCell('a\\b') !== 'a\\\\b') throw new Error('backslash not escaped');
  if (mdEscapeCell(null) !== '')         throw new Error('null should be empty string');
  if (mdEscapeCell(0) !== '0')           throw new Error('0 should stringify');

  const md = tabToMarkdown('T', ['x', 'y'], [[1, 2]], '2026-06-28 03:00');
  if (md.indexOf('# T') !== 0)            throw new Error('missing H1');
  if (md.indexOf('1 row ') === -1)       throw new Error('singular row count');
  if (md.indexOf('| x | y |') === -1)    throw new Error('missing header row');
  if (md.indexOf('| --- | --- |') === -1) throw new Error('missing separator row');
  if (md.indexOf('| 1 | 2 |') === -1)    throw new Error('missing data row');

  const empty = tabToMarkdown('E', ['x'], [], '2026-06-28 03:00');
  if (empty.indexOf('0 rows') === -1)    throw new Error('plural row count');
  if (empty.indexOf('_(no rows)_') === -1) throw new Error('empty tab body');

  const idx = buildIndexMarkdown([{ name: 'Stops', count: 3 }], '2026-06-28 03:00');
  if (idx.indexOf('[Stops](Stops.md)') === -1) throw new Error('index link');
  if (idx.indexOf('3 rows') === -1)      throw new Error('index row count');

  Logger.log('test_markdownFormatting OK');
}

function test_buildExportFiles() {
  const files = buildExportFiles();
  // The EXPORT_TABS tabs that actually exist + the index. setupSheets() must have run.
  if (!files.length) throw new Error('no files produced');
  const paths = files.map(function (f) { return f.path; });
  if (paths.indexOf('data/README.md') === -1) throw new Error('missing index file');
  if (paths.indexOf('data/Stops.md') === -1)  throw new Error('missing Stops file');
  files.forEach(function (f) {
    if (f.path.indexOf('data/') !== 0) throw new Error('bad path: ' + f.path);
    if (typeof f.content !== 'string' || !f.content.length)
      throw new Error('empty content: ' + f.path);
  });
  Logger.log('test_buildExportFiles OK — ' + files.length + ' files: ' + paths.join(', '));
}

// Verifies the missing-config guard WITHOUT hitting GitHub. Safe to run anytime.
function test_githubConfigGuard() {
  const props = PropertiesService.getScriptProperties();
  const savedToken = props.getProperty('GITHUB_TOKEN');
  const savedRepo  = props.getProperty('GITHUB_REPO');
  props.deleteProperty('GITHUB_TOKEN');
  props.deleteProperty('GITHUB_REPO');
  let threw = false;
  try { githubCommitFiles([{ path: 'data/x.md', content: 'x' }], 'msg'); }
  catch (e) { threw = (e.message.indexOf('Script Properties') !== -1); }
  // restore whatever was there so we don't clobber real config
  if (savedToken != null) props.setProperty('GITHUB_TOKEN', savedToken);
  if (savedRepo  != null) props.setProperty('GITHUB_REPO', savedRepo);
  if (!threw) throw new Error('expected a clear Script Properties error');
  Logger.log('test_githubConfigGuard OK');
}

// Verifies the request-scoped rows() memo: repeat reads hit the memo, and a
// write (via upsertByHeader → bustRows) makes the next read see fresh data.
// Writes one throwaway Metrics row and deletes it after. Run from the editor.
function test_rowsMemo() {
  ensureMetricsTab();
  const a = rows('Metrics');
  if (rows('Metrics') !== a) throw new Error('rows() not memoized within a request');
  upsertByHeader('Metrics', 'metric', '_memoTest',
    { metric: '_memoTest', value: '1', updated: now() });
  const b = rows('Metrics');
  if (b === a) throw new Error('write did not bust the memo');
  if (!b.some(r => String(r.metric) === '_memoTest'))
    throw new Error('read-after-write missed the new row');
  // cleanup the throwaway row
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Metrics');
  const data = sh.getDataRange().getValues();
  const mCol = data[0].indexOf('metric');
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][mCol]) === '_memoTest') sh.deleteRow(i + 1);
  }
  bustRows('Metrics');
  Logger.log('test_rowsMemo OK');
}

// Verifies the viewer reads' optional from/to window: no params returns the
// full tab, a window returns only in-range rows, and the two partitions add
// back up. Pure reads — safe to run anytime from the editor.
function test_dateWindow() {
  const all = pins().pins;
  const from = '2000-01-01', mid = today();
  const windowed = pins(from, mid).pins;
  windowed.forEach(r => {
    const d = dateOf(r.timestamp);
    if (!d || d < from || d > mid) throw new Error('out-of-window pin: ' + r.id);
  });
  const dateless = all.filter(r => !dateOf(r.timestamp)).length;
  if (windowed.length + dateless !== all.length)
    throw new Error('window [2000-01-01, today] should cover every dated pin: '
      + windowed.length + ' + ' + dateless + ' dateless ≠ ' + all.length);
  if (tracker().tracker.length < tracker(mid, mid).tracker.length)
    throw new Error('windowed tracker larger than full tracker');
  Logger.log('test_dateWindow OK — ' + all.length + ' pins, '
    + windowed.length + ' in window, ' + dateless + ' dateless');
}
