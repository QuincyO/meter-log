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
  'newJNumber','oldJNumber','meterRead','status','utiReason','notes','noReadReason','meterReadReceived'
];
const DOWNTIME_HEADERS = [
  'id','timestamp','installer','category','minutes','workOrderId','note'
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
  'visited','unaccounted','autoIdleMin','travelMin','delayMin'
];
// Crew: one row per installer, keyed on the employee number ("H number"), so
// two people with the same name never collide. firstName/lastName are the
// display label; hNumber is the identity.
const EMPLOYEES_HEADERS = ['hNumber','firstName','lastName','active'];
// One row per BOAT (boatNumber, e.g. "11"). Each crew member on the boat is
// assigned a letter in memberLetters — a JSON map {hNumber: "A"} — and people
// who share a letter are partners, so member H100→"A" on boat 11 reads as team
// "11A". captainName + subName are free-text names shared across the whole boat
// (captains/subs aren't employees and move between boats); they're saved to the
// Captains/Subs lists for quick reuse.
const TEAMS_HEADERS = ['id','boatNumber','boatName','captainName','subName','memberLetters'];
// Quick-pick name lists that feed the team form's captain / sub dropdowns.
const CAPTAINS_HEADERS = ['name'];
const SUBS_HEADERS     = ['name'];
// Audit trail: one row per computed gap, written at end-of-day, so every Travel
// Time / Delay number on the daily log traces back to a row. `type` is Travel /
// Flagged / Launch / Return; `bucket` is travel, a downtime label, or unlabeled.
const TIMING_HEADERS = ['date','installer','fromTime','toTime','minutes','distanceM','type','bucket','workOrderId'];
// One row per installer per day holding the day "bookend" clock times — Departure
// (left dock) and Returned (back to land). These anchor the daily log's Launch /
// Return legs; persisting them (the field form used to discard them) is what lets
// the back-office edit.html regenerate a correct daily log any time.
const DAYS_HEADERS = ['date','installer','departure','returned'];

// Fields the web form is allowed to change on an existing stop.
const STOP_EDITABLE = [
  'workOrderId','unit','address','newJNumber','oldJNumber','status','utiReason','notes','noReadReason'
];

// ── Daily-log PDF (Phase 1) ────────────────────────────────────────────────
const TEMPLATE_TAB = 'DailyLog Template';
const PDF_FOLDER   = 'Meter Log — Daily Logs';
const BODY_START   = 10;   // first stop row in the template
const BODY_ROWS    = 18;   // printed blank rows, like the paper form

// Where each header value lands. Must match setupDailyLogTemplate() below —
// if you move a box there, update its anchor here.
const ANCHORS = {
  name:'B1', partner:'B2', captain:'B3',           // crew, auto-filled from the boat team
  boatTeam:'D1', boatName:'D2', date:'D3', sub:'D4',
  weather:'G2',
  delayTime:'D5',                                   // total same-island meter-to-meter delay
  departure:'D6', returned:'E7',                    // anchors the launch / return travel legs
  travelTime:'D8'                                   // total island-to-island travel
};

/** Builds the template tab to match the paper daily log. Re-run any time the
 *  layout changes (it deletes + rebuilds the tab). */
function setupDailyLogTemplate() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TEMPLATE_TAB);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(TEMPLATE_TAB);

  const COLS = 8, FOOTER = BODY_START + BODY_ROWS;   // 28
  [34, 84, 96, 168, 168, 120, 104, 76].forEach((w,i)=> sh.setColumnWidth(i+1, w));
  sh.getRange(1,1,FOOTER,COLS).setFontFamily('Arial').setFontSize(9)
    .setVerticalAlignment('middle').setWrap(true);

  const L = (a1, txt) => sh.getRange(a1).setValue(txt).setFontWeight('bold').setFontSize(8);

  // header — left A:B
  L('A1','Name:'); L('A2','Partner:'); L('A3','Captain:');
  sh.getRange('A4:B4').merge(); L('A4','Describe AM Delays:');
  sh.getRange('A5:B8').merge().setVerticalAlignment('top');
  // header — center-left C:D
  L('C1','Boat Team:'); L('C2','Boat Name:'); L('C3','Date:'); L('C4','Sub:');
  L('C5','Delay Time:'); L('C6','Departure Time:'); L('C7','Lunch Time:');
  L('C8','Travel Time:');
  // header — center-right E:F
  sh.getRange('E1:F1').merge(); L('E1','Launch / Body of Water:');
  sh.getRange('E2:F2').merge();
  sh.getRange('E3:F3').merge(); L('E3','Safety Concerns:');
  sh.getRange('E4:F5').merge().setVerticalAlignment('top');
  sh.getRange('E6:F6').merge(); L('E6','Returned to Land:');
  sh.getRange('E7:F7').merge(); sh.getRange('E8:F8').merge();
  // header — right G:H
  sh.getRange('G1:H1').merge(); L('G1','Weather / Wind & Direction:');
  sh.getRange('G2:H2').merge();
  sh.getRange('G3:H3').merge(); L('G3','Needed on Boat Teams:');
  sh.getRange('G4:H5').merge().setVerticalAlignment('top');
  sh.getRange('G6:H6').merge(); L('G6','Ride to 1st WO:');
  sh.getRange('G7:H7').merge(); sh.getRange('G8:H8').merge();

  // table header (row 9)
  sh.getRange(9,1,1,COLS)
    .setValues([['#','WO#','Old J #','New J # (or UTI reason)','Address','Island Name','Meter Read','Travel (min)']])
    .setFontWeight('bold').setFontSize(8).setHorizontalAlignment('center').setBackground('#EEF1F5');

  // footer (row 28)
  L('A'+FOOTER,'Total Installed:'); L('C'+FOOTER,"Total UTI's:");
  sh.getRange('E'+FOOTER+':H'+FOOTER).merge();

  // borders + heights
  sh.getRange(1,1,8,COLS).setBorder(true,true,true,true,true,true);
  sh.getRange(9,1,1+BODY_ROWS,COLS).setBorder(true,true,true,true,true,true);
  sh.getRange(FOOTER,1,1,COLS).setBorder(true,true,true,true,true,true);
  sh.setRowHeight(9,26); sh.setRowHeight(FOOTER,26);
  for (let r=BODY_START; r<FOOTER; r++) sh.setRowHeight(r,22);
  sh.getRange(BODY_START,1,BODY_ROWS,1).setHorizontalAlignment('center');
  sh.getRange(BODY_START,7,BODY_ROWS,2).setHorizontalAlignment('center');
  return sh;
}

/** Fills a copy of the template with the day, exports it to PDF, saves a copy
 *  to Drive, and returns the bytes (base64) so the phone downloads instantly. */
function buildDailyLogPdf(s) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tpl = ss.getSheetByName(TEMPLATE_TAB);
  if (!tpl) return { error: 'template tab missing — run setupDailyLogTemplate()' };

  // Everything worth printing on the log: installs, UTIs, and the new "we were
  // here" outcomes. DONE markers stay off the sheet (not the logger's work).
  const editable    = (s.stops||[]).filter(x => x.status==='INSTALLED' || x.status==='UTI'
                                              || x.status==='VISITED'  || x.status==='UNACCOUNTED');
  const installed   = (s.stops||[]).filter(x => x.status==='INSTALLED').length;
  const uti         = (s.stops||[]).filter(x => x.status==='UTI').length;
  const visited     = (s.stops||[]).filter(x => x.status==='VISITED').length;
  const unaccounted = (s.stops||[]).filter(x => x.status==='UNACCOUNTED').length;

  // When false (the End-of-day "Include delays & travel time" box was unchecked),
  // the PDF prints installs/UTIs only: Delay Time box, Travel Time box, per-stop
  // Travel column, and the Delays/Breaks/Misc footer line are all suppressed.
  // The day's totals are still computed and recorded — this only gates rendering.
  const showDT = s.includeDelays !== false;

  const copy = tpl.copyTo(ss).setName('_tmp_' + Date.now());
  try {
    const FOOTER0 = BODY_START + BODY_ROWS;
    const n = editable.length;
    const put = (a1, v) => copy.getRange(a1).setValue(v == null ? '' : v);

    put(ANCHORS.name,    s.installer);
    put(ANCHORS.partner, s.partner  || '');   // other crew on the boat team
    put(ANCHORS.captain, s.captain  || '');
    put(ANCHORS.sub,     s.sub      || '');
    put(ANCHORS.boatTeam,s.boatTeam || '');    // boat number + team letter, e.g. "11A"
    put(ANCHORS.boatName,s.boatName || '');
    put(ANCHORS.date,    s.date);
    put(ANCHORS.weather,    s.weather  || '');
    put(ANCHORS.delayTime, showDT ? (s.downtimeTotalMin || 0) : '');  // categorized downtime total (excl. Travel Time)
    put(ANCHORS.departure, s.departure || '');     // anchors the launch travel leg
    put(ANCHORS.returned,  s.returned  || '');     // anchors the return travel leg
    // Travel Time box is summed from the per-row column below, so the two always
    // reconcile on the page. The column shows every stop's full arrival gap, so this
    // total can overlap with the Delay Time box by design. s.travelMinutes (Tracker)
    // is now the same per-person total — both sum this installer's own arrival gaps.
    let travelColSum = 0;

    let footerRow = FOOTER0;
    if (n > BODY_ROWS) {                       // grow if a big day
      const extra = n - BODY_ROWS;
      copy.insertRowsAfter(FOOTER0 - 1, extra);
      copy.getRange(BODY_START,1,1,8).copyTo(copy.getRange(FOOTER0,1,extra,8), {formatOnly:true});
      footerRow = FOOTER0 + extra;
    }

    editable.forEach((x, i) => {
      const r = BODY_START + i;
      const reads = (x.meterRead || x.meterRead === 0)
        ? (x.meterRead + ((x.meterReadReceived || x.meterReadReceived === 0) ? (' / ' + x.meterReadReceived) : ''))
        : (x.noReadReason ? 'no read' : '');
      // The New-J# column doubles as the outcome column: J# for an install, the
      // reason for a UTI, and a "Visited/Unaccounted — {note}" line for the two
      // attendance outcomes. Reads stay blank for anything that isn't an install.
      const note4 =
        x.status === 'UTI'         ? (x.utiReason || 'UTI') :
        x.status === 'VISITED'     ? ('Visited' + (x.notes ? (' — ' + x.notes) : '')) :
        x.status === 'UNACCOUNTED' ? ('Unaccounted' + (x.notes ? (' — ' + x.notes) : '')) :
                                     (x.newJNumber || '');
      // Travel column = full minutes to reach this stop, i.e. the arrival gap from
      // the previous activity (first row = launch leg). Every stop with a preceding
      // gap gets a number, including one reached after a flagged delay. The Travel
      // Time box is the running sum of this column.
      const travel = showDT ? ((s.perStopTravel && x.id != null && s.perStopTravel[x.id]) || '') : '';
      if (travel) travelColSum += travel;
      copy.getRange(r,1,1,8).setValues([[
        i+1, x.workOrderId || '', x.oldJNumber || '',
        note4,
        locLabelSrv(x), '',                    // Island Name blank in Phase 1
        x.status === 'INSTALLED' ? reads : '',
        travel
      ]]);
    });
    put(ANCHORS.travelTime, showDT ? travelColSum : '');

    copy.getRange(footerRow, 2).setValue(installed);
    copy.getRange(footerRow, 4).setValue(uti);
    const extraCounts = (visited ? ('Visited ' + visited + '  ·  ') : '')
                      + (unaccounted ? ('Unaccounted ' + unaccounted + '  ·  ') : '');
    // Three independent lenses, each summing its own category set: real work delays,
    // lunch/breaks, and miscellaneous (non-WO→WO) travel. Breaks & Misc Travel were
    // subtracted from the WO→WO travel above, so they're reported separately here.
    const delays = (s.downtime||[]).filter(d => CATEGORIES.indexOf(d.category) >= 0);
    const breaks = (s.downtime||[]).filter(d => BREAK_CATS.indexOf(d.category) >= 0);
    const misc   = (s.downtime||[]).filter(d => TRAVEL_ADJ_CATS.indexOf(d.category) >= 0);
    const segs = ['Delays:  ' + downtimeSummary(delays)];
    if (breaks.length) segs.push('Breaks:  ' + downtimeSummary(breaks));
    if (misc.length)   segs.push('Misc Travel:  ' + downtimeSummary(misc));
    // showDT off → footer carries only the Visited/Unaccounted counts, no delay segments.
    copy.getRange(footerRow, 5).setValue(showDT
      ? (extraCounts + segs.join('   ·   '))
      : extraCounts.replace(/\s*·\s*$/, ''));
    SpreadsheetApp.flush();

    // FirstNameLastName_Date_DailyLog.pdf — e.g. SamRivera_2026-06-21_DailyLog.pdf
    const who  = String(s.installer||'').replace(/[^A-Za-z0-9]+/g,'') || 'Installer';
    const name = who + '_' + s.date + '_DailyLog.pdf';
    const blob = exportSheetPdf(ss.getId(), copy.getSheetId(), name);
    const file = getOrCreateFolder(PDF_FOLDER).createFile(blob);
    return { base64: Utilities.base64Encode(blob.getBytes()), url: file.getUrl(), name: name };
  } catch (err) {
    return { error: String(err) };
  } finally {
    ss.deleteSheet(copy);
  }
}

function exportSheetPdf(ssId, gid, name) {
  const params = ['format=pdf','gid='+gid,'size=letter','portrait=false','fitw=true',
    'gridlines=false','sheetnames=false','printtitle=false','pagenumbers=false',
    'top_margin=0.3','bottom_margin=0.3','left_margin=0.3','right_margin=0.3'].join('&');
  const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/'+ssId+'/export?'+params,
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  return res.getBlob().setName(name);
}
function getOrCreateFolder(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function locLabelSrv(s) {
  const unit = String(s.unit==null?'':s.unit).trim(), addr = String(s.address==null?'':s.address).trim();
  if (!addr) return '';
  return unit ? (unit + ' ' + addr) : addr;
}
const CAT_LABEL_SRV = { NEXT_GEN:'Next Gen', CELL_SIGNAL:'Cell Signal', BAD_WEATHER:'Bad Weather',
  WAREHOUSE:'Warehouse', TOOLS_MATERIAL:'Tools/Material', DISPATCH:'Dispatch',
  TRUCK_ISSUES:'Truck Issues', ASSIST:'Assist', URGENT_EER:'Urgent/EER', OTHER:'Other',
  LUNCH:'Lunch', BREAK:'Break', MISC_TRAVEL:'Misc Travel',
  // Logged like a downtime reason but counts as TRAVEL, not downtime (see buildDaySummary).
  TRAVEL_TIME:'Travel Time' };
function downtimeSummary(downtime) {
  const byCat = {}; let total = 0;
  (downtime||[]).forEach(d => { const c=d.category||'OTHER', m=Number(d.minutes)||0; byCat[c]=(byCat[c]||0)+m; total+=m; });
  const parts = Object.keys(byCat).map(c => (CAT_LABEL_SRV[c]||c)+' '+byCat[c]);
  return parts.length ? (parts.join(' · ') + ' · Total ' + total + ' min') : '0 min';
}

// Run once from the editor to grant the new Drive + external-request scopes.
function grantPermissions() {
  getOrCreateFolder(PDF_FOLDER);
  UrlFetchApp.fetch('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m');
}

// ── One-time setup: run this from the editor once ──────────────────────────
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab(ss, 'Stops', STOPS_HEADERS);
  ensureTab(ss, 'Downtime', DOWNTIME_HEADERS);
  ensureTab(ss, 'Tracker', TRACKER_HEADERS);
  ensureTab(ss, 'Employees', EMPLOYEES_HEADERS);
  ensureTab(ss, 'Teams', TEAMS_HEADERS);
  ensureTab(ss, 'Captains', CAPTAINS_HEADERS);
  ensureTab(ss, 'Subs', SUBS_HEADERS);
  ensureTab(ss, 'Timing', TIMING_HEADERS);
  ensureTab(ss, 'Days', DAYS_HEADERS);
  setupDailyLogTemplate();
}

function ensureTab(ss, name, headers) {
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
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SHARED_TOKEN) return json({ ok: false, error: 'bad token' });

    switch (body.action) {
      case 'addStop':        return json(addStop(body));
      case 'addDowntime':    return json(addDowntime(body));
      case 'updateStop':     return json(updateStop(body));
      case 'endOfDay':       return json(endOfDay(body));
      case 'previewDailyLog':return json(previewDailyLog(body));
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
    return json({ ok: true,
                  stops: stopsFor(p.installer, date),
                  downtime: downtimeFor(p.installer, date),
                  day: dayMeta(p.installer, date),
                  closed: dayClosed(p.installer, date) });
  }
  if (p.action === 'lookup')  return json(lookup(p));
  if (p.action === 'geocode') return json(geocode(parseFloat(p.lat), parseFloat(p.lng)));
  if (p.action === 'pins')    return json(pins());
  if (p.action === 'tracker') return json(tracker());
  if (p.action === 'timing')  return json(timing());
  if (p.action === 'roster')  return json(roster());
  if (p.action === 'idle') {
    const date = p.date || today();
    const id   = String(p.installerId == null ? '' : p.installerId).trim();
    const emp  = id ? employeeByH(id) : null;
    const installer = emp ? fullName(emp) : (p.installer || '');
    // Every meter-to-meter gap (short hops included) is offered for review so a break
    // can be subtracted from any of them. Gaps run between this installer's own
    // consecutive meters; a non-first installer's first gap (from the team's first
    // install) is included so its delays can be labelled too. (Launch/Return legs need
    // the bookend times, not known when this opens, so they aren't listed here.)
    const gi = installerGapStops(id, installer, date);
    const gaps = computeIdle(gi.stops).gaps
      .filter(g => g.type === 'Travel' || g.type === 'Flagged');
    // Attach any already-saved allocations (gap-tagged Downtime rows) so re-opening a
    // day from either surface pre-fills what was entered.
    const dt = downtimeFor(installer, date);
    const allocFor = (a, z) => dt
      .filter(d => { const m = gapNoteTimes(d.note); return m && m[1] === a && m[2] === z; })
      .map(d => ({ id: d.id, category: d.category, minutes: Number(d.minutes) || 0 }));
    return json({ ok: true, gaps: gaps.map(g => ({
      start: g.start, end: g.end, idleMin: g.idleMin, toWO: g.toWO, toId: g.toId,
      distM: g.distM, suggest: g.suggest, allocations: allocFor(g.start, g.end) })) });
  }
  return json({ ok: true, message: 'Meter Log spine is up.' });
}

// ── Actions ────────────────────────────────────────────────────────────────
function addStop(b) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stops');
  const id = b.id || newId();
  const row = [
    id, b.timestamp || now(), b.installer || '', b.workOrderId || '',
    b.unit || '', b.address || '', numOrBlank(b.lat), numOrBlank(b.lng),
    b.newJNumber || '', b.oldJNumber || '', numOrBlank(b.meterRead),
    b.status || '', b.utiReason || '', b.notes || '', b.noReadReason || '',
    numOrBlank(b.meterReadReceived)
  ];

  // Dedup: only INSTALLED stops with both a WO# and a new J# are checked.
  // UTI/DONE entries are always appended without restriction.
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
    if (history.length > 0) {
      sh.appendRow(row);
      return { ok: true, id: id, flagged: true, history: history };
    }
  }

  sh.appendRow(row);
  return { ok: true, id: id };
}

function addDowntime(b) {
  if (b.category === 'OTHER' && !(b.note || '').trim())
    return { ok: false, error: 'OTHER downtime needs a note' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Downtime');
  const id = b.id || newId();
  sh.appendRow([
    id, b.timestamp || now(), b.installer || '',
    (b.category || 'OTHER').toUpperCase(), parseInt(b.minutes, 10) || 0,
    b.workOrderId || '', b.note || ''
  ]);
  return { ok: true, id: id };
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
      return { ok: true, id: b.id };
    }
  }
  return { ok: false, error: 'id not found' };
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
  // installer's total — so a partner who installs first "owns" the morning launch leg,
  // and the other partner's first-stop travel starts from the team's prior install.
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

  const team = installerId ? teamForEmployee(installerId) : null;
  const hdr  = teamHeader(team, installerId);

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
  // minus the downtime subtracted from it — exactly the number saved). Gaps run between
  // this installer's OWN consecutive meters; only their first stop is anchored to the
  // team's first install (or the dock, if they installed first) — see installerGapStops.
  // `travelMinutes` (Tracker `travelMin`) is the per-person net total: only gaps that
  // land on this installer's OWN printable stops (incl. their own launch leg; the
  // row-less Return leg has no toId, so it's never counted). This mirrors the PDF box,
  // which sums the same per-stop column. A gap with no deductions is full travel; a
  // fully-consumed gap nets to 0 (prints blank), which reproduces old whole-gap days.
  const gi = installerGapStops(installerId, installer, date);
  const timing = computeIdle(gi.stops, gi.isFirst ? departure : '', returned);
  const perStopTravel = {};
  let travelMinutes = 0;
  const timingRows = timing.gaps.map(g => {
    const ded = dedByGap[gapKey(g.fromHHMM, g.toHHMM)] || 0;
    const net = Math.max(0, g.minutes - ded);
    const bucket = (g.minutes > 0 && ded >= g.minutes) ? 'delay' : (ded > 0 ? 'mixed' : 'travel');
    if (g.toId !== '' && g.toId != null) perStopTravel[g.toId] = net;
    if (g.type !== 'Return' && g.toId != null && g.toId !== '' && ownPrintableIds[g.toId])
      travelMinutes += net;
    return { fromTime: g.fromHHMM, toTime: g.toHHMM, minutes: g.minutes,
             distanceM: g.distM == null ? '' : g.distM, type: g.type, bucket: bucket, workOrderId: g.toWO };
  });

  return { date, installer, installerId, installed, uti, visited, unaccounted,
    // PDF-only flag: when false, buildDailyLogPdf omits the delay/travel cells.
    // It never affects the Tracker/Timing writes — analytics always gets full data.
    includeDelays: b.includeDelays !== false,
    downtimeTotalMin: downtimeTotal, byCategory: byCat,
    breaksTotalMin: breaksTotal, byBreak: byBreak, miscTravelMin: miscTravelTotal,
    travelMinutes: travelMinutes,
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
  const s = buildDaySummary(b);
  const byCat = s.byCategory;

  // Persist the bookend clock times so the daily log can always be rebuilt with
  // them — the field form used to discard departure/returned after the PDF.
  if (s.departure || s.returned) {
    saveDay({ date: s.date, installer: s.installer,
              departure: s.departure, returned: s.returned });
  }

  // Upsert one Tracker row per (date, installer) — overwrite in place if it's
  // already closed, else append.
  upsertDayRow('Tracker', s.date, s.installer, [
    s.date, s.installer, s.installed, s.uti, s.downtimeTotalMin,
    byCat.NEXT_GEN, byCat.CELL_SIGNAL, byCat.BAD_WEATHER, byCat.WAREHOUSE,
    byCat.TOOLS_MATERIAL, byCat.DISPATCH, byCat.TRUCK_ISSUES, byCat.ASSIST,
    byCat.URGENT_EER, byCat.OTHER, s.weather, s.notes,
    s.visited, s.unaccounted, '', s.travelMinutes, ''   // autoIdleMin + delayMin are legacy/blank
  ]);

  // Per-gap audit trail (one row each) so the Travel Time / Delay numbers trace.
  // Clear this day's prior rows first so a regenerate doesn't pile duplicates.
  const timingSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Timing');
  if (timingSh) {
    deleteDayRows('Timing', s.date, s.installer);
    if (s.timingRows && s.timingRows.length) {
      timingSh.getRange(timingSh.getLastRow() + 1, 1, s.timingRows.length, TIMING_HEADERS.length)
        .setValues(s.timingRows.map(r => [s.date, s.installer, r.fromTime, r.toTime,
          r.minutes, r.distanceM, r.type, r.bucket, r.workOrderId]));
    }
  }

  const pdf = buildDailyLogPdf(s);
  return { ok: true, summary: s, pdf };
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
      return;
    }
  }
  sh.appendRow(out);
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

  // Append the new allocations. Each carries the arriving WO + a `gap HH:MM–HH:MM`
  // note so buildDaySummary can attribute it back to the right gap.
  const allocs = (b.allocations || [])
    .filter(a => a && a.category && (parseInt(a.minutes, 10) || 0) > 0);
  if (allocs.length) {
    const ts = date + ' 12:00:00';   // anchored on the gap's date, not "now"
    sh.getRange(sh.getLastRow() + 1, 1, allocs.length, DOWNTIME_HEADERS.length).setValues(
      allocs.map(a => [ newId(), ts, installer, String(a.category).toUpperCase(),
        parseInt(a.minutes, 10) || 0, a.workOrderId || '',
        'gap ' + a.fromTime + '–' + a.toTime ]));
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
  return { departure: r ? (r.departure || '') : '', returned: r ? (r.returned || '') : '' };
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
  const s = buildDaySummary(b);
  return { ok: true, summary: s, pdf: buildDailyLogPdf(s) };
}

/** The activity list for ONE installer's gap calc. Their own stops drive every gap
 *  (so a partner installing mid-island never splits a gap), EXCEPT the first gap: when
 *  this installer isn't the team's first that day, we prepend a marker at the team's
 *  first install so their first stop's travel runs from the first person's meter, not
 *  the dock. `isFirst` tells the caller whether to anchor a Launch leg from departure. */
function installerGapStops(installerId, installer, date) {
  const own = stopsFor(installer, date);
  const team = installerId ? teamForEmployee(installerId) : null;
  const partners = teamPartnerNames(team, installerId);
  if (!partners.length) return { stops: own, isFirst: true };
  const ownSecs = own.map(s => secOfDay(s.timestamp)).filter(x => x != null);
  const ownFirst = ownSecs.length ? Math.min.apply(null, ownSecs) : null;
  let teamFirst = null, teamFirstSec = null;
  [own].concat(partners.map(n => stopsFor(n, date))).forEach(arr => arr.forEach(s => {
    const sec = secOfDay(s.timestamp); if (sec == null) return;
    if (teamFirstSec == null || sec < teamFirstSec) { teamFirstSec = sec; teamFirst = s; }
  }));
  // Installed first (or tied) → launch from the dock; else first gap from the first
  // person's install (no Launch leg of their own).
  if (teamFirst == null || ownFirst == null || ownFirst <= teamFirstSec)
    return { stops: own, isFirst: true };
  return { stops: [teamFirst].concat(own), isFirst: false };
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
    .map(s => ({ id: s.id, sec: secOfDay(s.timestamp), lat: numCoord(s.lat), lng: numCoord(s.lng), wo: s.workOrderId }))
    .filter(a => a.sec != null)
    .sort((a, b) => a.sec - b.sec);

  const gaps = [];
  const mk = (fromSec, toSec, type, toId, toWO, distM, suggest) => {
    const from = secToHHMM(fromSec), to = secToHHMM(toSec), minutes = Math.round((toSec - fromSec) / 60);
    gaps.push({ fromHHMM: from, toHHMM: to, minutes: minutes, distM: distM,
                type: type, toId: toId != null ? toId : '', toWO: toWO || '',
                suggest: suggest || '',
                start: from, end: to, idleMin: minutes, kind: 'gap' });   // aliases for renderIdleGaps
  };

  for (let i = 1; i < acts.length; i++) {
    const prev = acts[i - 1], cur = acts[i];
    if (cur.sec - prev.sec <= 0) continue;
    const moved = (prev.lat != null && prev.lng != null && cur.lat != null && cur.lng != null)
      ? Math.round(haversine(prev.lat, prev.lng, cur.lat, cur.lng)) : null;
    const flagged = (cur.sec - prev.sec) / 60 >= FLAG_GAP_MIN;
    mk(prev.sec, cur.sec, flagged ? 'Flagged' : 'Travel', cur.id, cur.wo, moved,
       flagged ? (moved != null && moved > SAME_ISLAND_M ? 'TRAVEL_TIME' : 'OTHER') : '');
  }

  // Launch → first stop and last stop → dock are always travel (coming from /
  // returning to land), anchored on the times entered at end of day.
  if (acts.length) {
    const dep = clockSec(departure), ret = clockSec(returned);
    const first = acts[0], last = acts[acts.length - 1];
    if (dep != null && first.sec > dep) mk(dep, first.sec, 'Launch', first.id, first.wo, null, '');
    if (ret != null && ret > last.sec)  mk(last.sec, ret, 'Return', null, '', null, '');
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
    active:    isTruthy(r.active, true)
  })).filter(e => e.hNumber);
}

function teamsList() {
  return rows('Teams').map(r => ({
    id:            String(r.id == null ? '' : r.id),
    boatNumber:    String(r.boatNumber == null ? '' : r.boatNumber).trim(),
    boatName:      String(r.boatName == null ? '' : r.boatName).trim(),
    captainName:   String(r.captainName == null ? '' : r.captainName).trim(),
    subName:       String(r.subName == null ? '' : r.subName).trim(),
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

  const r = upsertByHeader('Employees', 'hNumber', h,
    { hNumber: h, firstName: first, lastName: last, active: active });
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
  ['boatName', 'captainName', 'subName', 'memberLetters'].forEach(col => {
    if (headers.indexOf(col) === -1) {
      sh.getRange(1, next).setValue(col).setFontWeight('bold');
      next++;
    }
  });
}

/** Create a boat, or update one in place when its id is supplied. memberLetters
 *  is stored as a JSON map of employee number → team letter ({"H100":"A"}). */
function saveTeam(b) {
  ensureTeamsColumns();
  const memberLetters = normalizeLetters(parseMemberLetters(b.memberLetters));
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
    memberLetters: JSON.stringify(memberLetters)
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
    }
  }
}

// Crew/team lookups used by endOfDay's auto-fill.
function fullName(e) { return e ? (e.firstName + ' ' + e.lastName).trim() : ''; }
function employeeByH(h) { h = String(h).trim(); return employeesList().filter(e => e.hNumber === h)[0] || null; }
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
function pins() {
  return { ok: true, pins: rows('Stops').map(r => ({
    id: r.id, timestamp: r.timestamp, installer: r.installer,
    workOrderId: r.workOrderId, unit: r.unit, address: r.address,
    lat: (r.lat === '' || r.lat == null) ? null : Number(r.lat),
    lng: (r.lng === '' || r.lng == null) ? null : Number(r.lng),
    newJNumber: r.newJNumber, oldJNumber: r.oldJNumber,
    meterRead: r.meterRead, status: r.status, utiReason: r.utiReason,
    notes: r.notes
  })) };
}

/** All Tracker rows (the end-of-day running totals), for the viewer's trend
 *  charts. The viewer filters by installer + date range on its side. */
function tracker() {
  return { ok: true, tracker: rows('Tracker') };
}

/** Every per-gap audit row (the Timing tab). Feeds the analytics "avg time between
 *  meters" metric — the viewer filters by installer + date range and averages the
 *  WO→WO gaps (type Travel / Flagged) on its side. */
function timing() {
  return { ok: true, timing: rows('Timing') };
}

// ── Helpers ──────────────────────────────────────────────────────────────
function rows(tabName) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  const data = sh.getDataRange().getValues();
  const headers = data.shift();
  return data.map(row => {
    const o = {};
    headers.forEach((h, i) => o[h] = row[i]);
    return o;
  });
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
        return { created: false };
      }
    }
  }
  sh.appendRow(build(null));
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
function numOrBlank(v)  { return (v === null || v === undefined || v === '') ? '' : Number(v); }
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
    if (!hms) { const m = s.match(/[ T](\d{2}):(\d{2})(?::(\d{2}))?/); if (m) hms = m[1] + ':' + m[2] + ':' + (m[3] || '00'); }
  }
  if (!hms) return null;
  const p = hms.split(':');
  return (+p[0]) * 3600 + (+p[1]) * 60 + (+(p[2] || 0));
}
/** Seconds-since-midnight for an "HH:mm" clock string (a <input type=time>). */
function clockSec(v) { const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/); return m ? ((+m[1]) * 3600 + (+m[2]) * 60) : null; }
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
