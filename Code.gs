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

const CATEGORIES = [
  'NEXT_GEN', 'CELL_SIGNAL', 'BAD_WEATHER', 'WAREHOUSE', 'TOOLS_MATERIAL',
  'DISPATCH', 'TRUCK_ISSUES', 'ASSIST', 'URGENT_EER', 'OTHER'
];

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
  'dispatch','truckIssues','assist','urgentEer','other','weather','notes'
];
// Crew: one row per installer, keyed on the employee number ("H number"), so
// two people with the same name never collide. firstName/lastName are the
// display label; hNumber is the identity.
const EMPLOYEES_HEADERS = ['hNumber','firstName','lastName','active'];
// Boat teams: captainH + memberHs hold employee numbers (memberHs is a JSON
// array of H numbers, captain included). identifier is the A/B/C… label.
const TEAMS_HEADERS = ['id','identifier','boatName','boatNumber','captainH','memberHs'];

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
  boatTeam:'D1', boatName:'D2', date:'D3',
  weather:'G2'
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
    .setValues([['#','WO#','Old J #','New J # (or UTI reason)','Address','Island Name','Meter Read','Delays']])
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

  const editable  = (s.stops||[]).filter(x => x.status==='INSTALLED' || x.status==='UTI');
  const installed = (s.stops||[]).filter(x => x.status==='INSTALLED').length;
  const uti       = (s.stops||[]).filter(x => x.status==='UTI').length;

  const copy = tpl.copyTo(ss).setName('_tmp_' + Date.now());
  try {
    const FOOTER0 = BODY_START + BODY_ROWS;
    const n = editable.length;
    const put = (a1, v) => copy.getRange(a1).setValue(v == null ? '' : v);

    put(ANCHORS.name,    s.installer);
    put(ANCHORS.partner, s.partner  || '');   // other crew on the boat team
    put(ANCHORS.captain, s.captain  || '');
    put(ANCHORS.boatTeam,s.boatTeam || '');    // the A/B/C… identifier
    put(ANCHORS.boatName,s.boatName || '');
    put(ANCHORS.date,    s.date);
    put(ANCHORS.weather, s.weather  || '');

    let footerRow = FOOTER0;
    if (n > BODY_ROWS) {                       // grow if a big day
      const extra = n - BODY_ROWS;
      copy.insertRowsAfter(FOOTER0 - 1, extra);
      copy.getRange(BODY_START,1,1,8).copyTo(copy.getRange(FOOTER0,1,extra,8), {formatOnly:true});
      footerRow = FOOTER0 + extra;
    }

    editable.forEach((x, i) => {
      const r = BODY_START + i, isUti = x.status === 'UTI';
      const reads = (x.meterRead || x.meterRead === 0)
        ? (x.meterRead + ((x.meterReadReceived || x.meterReadReceived === 0) ? (' / ' + x.meterReadReceived) : ''))
        : (x.noReadReason ? 'no read' : '');
      copy.getRange(r,1,1,8).setValues([[
        i+1, x.workOrderId || '', x.oldJNumber || '',
        isUti ? (x.utiReason || 'UTI') : (x.newJNumber || ''),
        locLabelSrv(x), '',                    // Island Name blank in Phase 1
        isUti ? '' : reads,
        dtMinutesForWO(x.workOrderId, s.downtime)
      ]]);
    });

    copy.getRange(footerRow, 2).setValue(installed);
    copy.getRange(footerRow, 4).setValue(uti);
    copy.getRange(footerRow, 5).setValue('Delays:  ' + downtimeSummary(s.downtime));
    SpreadsheetApp.flush();

    const name = 'DailyLog_' + String(s.installer||'').replace(/[^A-Za-z0-9]+/g,'_') + '_' + s.date + '.pdf';
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
function dtMinutesForWO(wo, downtime) {
  const w = String(wo==null?'':wo).trim(); if (!w) return '';
  let m = 0; (downtime||[]).forEach(d => { if (String(d.workOrderId==null?'':d.workOrderId).trim()===w) m += Number(d.minutes)||0; });
  return m || '';
}
const CAT_LABEL_SRV = { NEXT_GEN:'Next Gen', CELL_SIGNAL:'Cell Signal', BAD_WEATHER:'Bad Weather',
  WAREHOUSE:'Warehouse', TOOLS_MATERIAL:'Tools/Material', DISPATCH:'Dispatch',
  TRUCK_ISSUES:'Truck Issues', ASSIST:'Assist', URGENT_EER:'Urgent/EER', OTHER:'Other' };
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
      case 'saveEmployee':   return json(saveEmployee(body));
      case 'deleteEmployee': return json(deleteEmployee(body));
      case 'saveTeam':       return json(saveTeam(body));
      case 'deleteTeam':     return json(deleteTeam(body));
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
    return json({ ok: true,
                  stops: stopsFor(p.installer, date),
                  downtime: downtimeFor(p.installer, date) });
  }
  if (p.action === 'lookup')  return json(lookup(p));
  if (p.action === 'geocode') return json(geocode(parseFloat(p.lat), parseFloat(p.lng)));
  if (p.action === 'pins')    return json(pins());
  if (p.action === 'tracker') return json(tracker());
  if (p.action === 'roster')  return json(roster());
  return json({ ok: true, message: 'Meter Log spine is up.' });
}

// ── Actions ────────────────────────────────────────────────────────────────
function addStop(b) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stops');
  const id = b.id || newId();
  sh.appendRow([
    id, b.timestamp || now(), b.installer || '', b.workOrderId || '',
    b.unit || '', b.address || '', numOrBlank(b.lat), numOrBlank(b.lng),
    b.newJNumber || '', b.oldJNumber || '', numOrBlank(b.meterRead),
    b.status || '', b.utiReason || '', b.notes || '', b.noReadReason || '',
    numOrBlank(b.meterReadReceived)
  ]);
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
 *  (plus the numeric meterRead/lat/lng) can change; id/timestamp/installer
 *  are preserved so a correction never rewrites who logged it or when. */
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

/** Computes today's totals for one installer and appends a Tracker row. When
 *  an installerId (H number) is supplied, the installer's boat team is looked
 *  up and Partner / Captain / Boat Team / Boat Name auto-fill the daily log. */
function endOfDay(b) {
  const installerId = String(b.installerId == null ? '' : b.installerId).trim();
  const emp  = installerId ? employeeByH(installerId) : null;
  // Prefer the crew record's canonical name so the sheet always reads the same
  // way; fall back to whatever the form sent.
  const installer = emp ? fullName(emp) : (b.installer || '');
  const date = b.date || today();
  const stops = stopsFor(installer, date);
  const installed = stops.filter(s => s.status === 'INSTALLED').length;
  const uti       = stops.filter(s => s.status === 'UTI').length;

  const dt = downtimeFor(installer, date);
  const byCat = {}; CATEGORIES.forEach(c => byCat[c] = 0);
  let total = 0;
  dt.forEach(d => { byCat[d.category] = (byCat[d.category] || 0) + d.minutes; total += d.minutes; });

  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Tracker').appendRow([
    date, installer, installed, uti, total,
    byCat.NEXT_GEN, byCat.CELL_SIGNAL, byCat.BAD_WEATHER, byCat.WAREHOUSE,
    byCat.TOOLS_MATERIAL, byCat.DISPATCH, byCat.TRUCK_ISSUES, byCat.ASSIST,
    byCat.URGENT_EER, byCat.OTHER, b.weather || '', b.notes || ''
  ]);

  const team = installerId ? teamForEmployee(installerId) : null;
  const hdr  = teamHeader(team, installerId);

  const summary = { date, installer, installed, uti, downtimeTotalMin: total,
    byCategory: byCat, notes: b.notes || '', weather: b.weather || '', stops, downtime: dt,
    partner: hdr.partner, captain: hdr.captain, boatTeam: hdr.boatTeam, boatName: hdr.boatName,
    team: team ? team.id : null };

  // Tracker row is already written, so a PDF hiccup can't block closing the day.
  const pdf = buildDailyLogPdf(summary);
  return { ok: true, summary, pdf };
}

// ── Crew + boat teams ──────────────────────────────────────────────────────
/** The whole crew + every team, in one call. teams.html and the installer's
 *  name picker both read this. */
function roster() {
  return { ok: true, employees: employeesList(), teams: teamsList() };
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
    id:         String(r.id == null ? '' : r.id),
    identifier: String(r.identifier == null ? '' : r.identifier).trim(),
    boatName:   String(r.boatName == null ? '' : r.boatName).trim(),
    boatNumber: String(r.boatNumber == null ? '' : r.boatNumber).trim(),
    captainH:   String(r.captainH == null ? '' : r.captainH).trim(),
    memberHs:   parseMembers(r.memberHs)
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

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Employees');
  const data = sh.getDataRange().getValues();
  const hCol = data[0].indexOf('hNumber');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][hCol]).trim() === h) {
      sh.getRange(i + 1, 1, 1, EMPLOYEES_HEADERS.length).setValues([[h, first, last, active]]);
      return { ok: true, hNumber: h, updated: true };
    }
  }
  sh.appendRow([h, first, last, active]);
  return { ok: true, hNumber: h, created: true };
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

/** Create a team, or update one in place when its id is supplied. memberHs is
 *  stored as a JSON array of employee numbers (captain included). */
function saveTeam(b) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Teams');
  const data = sh.getDataRange().getValues();
  const idCol = data[0].indexOf('id');

  const members  = parseMembers(b.memberHs);
  const captainH = String(b.captainH == null ? '' : b.captainH).trim();
  // Keep the captain on the roster even if the UI forgot to include them.
  if (captainH && members.indexOf(captainH) < 0) members.push(captainH);

  const out = [
    '', String(b.identifier == null ? '' : b.identifier).trim(),
    String(b.boatName == null ? '' : b.boatName).trim(),
    String(b.boatNumber == null ? '' : b.boatNumber).trim(),
    captainH, JSON.stringify(members)
  ];

  if (b.id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(b.id)) {
        out[0] = String(b.id);
        sh.getRange(i + 1, 1, 1, TEAMS_HEADERS.length).setValues([out]);
        return { ok: true, id: b.id, updated: true };
      }
    }
  }
  const id = newId();
  out[0] = id;
  sh.appendRow(out);
  return { ok: true, id: id, created: true };
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

/** Strip a departed employee out of every team's members + captain slot. */
function removeEmployeeFromTeams(h) {
  h = String(h).trim();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Teams');
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const capCol = headers.indexOf('captainH');
  const memCol = headers.indexOf('memberHs');
  for (let i = 1; i < data.length; i++) {
    let changed = false;
    const members = parseMembers(data[i][memCol]).filter(x => x !== h);
    if (members.length !== parseMembers(data[i][memCol]).length) {
      sh.getRange(i + 1, memCol + 1).setValue(JSON.stringify(members)); changed = true;
    }
    if (String(data[i][capCol]).trim() === h) {
      sh.getRange(i + 1, capCol + 1).setValue(''); changed = true;
    }
    if (changed) SpreadsheetApp.flush();
  }
}

// Crew/team lookups used by endOfDay's auto-fill.
function fullName(e) { return e ? (e.firstName + ' ' + e.lastName).trim() : ''; }
function employeeByH(h) { h = String(h).trim(); return employeesList().filter(e => e.hNumber === h)[0] || null; }
function nameOfH(h) { return fullName(employeeByH(h)); }
function teamForEmployee(h) {
  h = String(h).trim();
  return teamsList().filter(t => t.captainH === h || t.memberHs.indexOf(h) >= 0)[0] || null;
}
/** The header block the daily log auto-fills for this installer's boat team:
 *  partner = the rest of the crew (not you, not the captain); captain name;
 *  the A/B/C… identifier; and boat name with its number folded in. */
function teamHeader(team, selfH) {
  if (!team) return { partner: '', captain: '', boatTeam: '', boatName: '' };
  selfH = String(selfH || '').trim();
  const partners = team.memberHs
    .filter(h => h !== selfH && h !== team.captainH)
    .map(nameOfH).filter(Boolean);
  const boatName = team.boatName + (team.boatNumber ? (' #' + team.boatNumber) : '');
  return { partner: partners.join(', '), captain: nameOfH(team.captainH),
           boatTeam: team.identifier, boatName: boatName };
}

/** Parse a stored member list — JSON array preferred, comma/space-separated
 *  tolerated — into an array of trimmed employee numbers. */
function parseMembers(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (s.charAt(0) === '[') {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(x => String(x).trim()).filter(Boolean); } catch (e) {}
  }
  return s.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
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
    meterRead: r.meterRead, status: r.status, utiReason: r.utiReason
  })) };
}

/** All Tracker rows (the end-of-day running totals), for the viewer's trend
 *  charts. The viewer filters by installer + date range on its side. */
function tracker() {
  return { ok: true, tracker: rows('Tracker') };
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
