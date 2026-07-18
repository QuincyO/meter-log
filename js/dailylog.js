// ── Client-side daily-log PDF renderer ───────────────────────────────────────
// Draws the daily log on the phone (offline-capable) — a close reproduction of
// the paper template that the spine used to build via a Sheet copy + export.
// Takes a `summary` (the server's previewDailyLog/endOfDay summary when online,
// or compute/summary.js buildLocalSummary when offline) and returns a PDF Blob.
//
// Layout mirrors Code.gs setupDailyLogTemplate(): an 8-row header grid of labeled
// boxes (row 1-8), the table header, body rows (one per INSTALLED/UTI stop), and
// a totals footer. The 8 columns keep the template's width proportions.
//
// jsPDF ships as a UMD bundle (its ESM build isn't self-contained — it
// bare-imports @babel/runtime) exposing `window.jspdf.jsPDF`. It is ~350KB the
// page only needs at PDF time, so it is NOT a <script> tag anymore: ensureJsPDF
// injects it on demand (downloadDailyLog awaits it). The file stays in the
// service-worker SHELL, so the injected script resolves from cache offline and
// the no-signal end-of-day PDF keeps working.
import { parseLocalMs } from './time.js';
import { CATEGORIES, BREAK_CATS, TRAVEL_ADJ_CATS, CAT_LABEL, downtimeSummary } from './compute/categories.js';

function getJsPDF(){
  const ns = (typeof window !== 'undefined' && window.jspdf) || (typeof self !== 'undefined' && self.jspdf);
  if(!ns || !ns.jsPDF) throw new Error('jsPDF not loaded — include js/vendor/jspdf.umd.min.js');
  return ns.jsPDF;
}

let jspdfLoading = null;
function ensureJsPDF(){
  if(typeof window !== 'undefined' && window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if(!jspdfLoading){
    jspdfLoading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'js/vendor/jspdf.umd.min.js';
      s.onload = res;
      s.onerror = () => { jspdfLoading = null; rej(new Error('couldn’t load the PDF library')); };
      document.head.appendChild(s);
    });
  }
  return jspdfLoading;
}

const MARGIN = 21.6;                 // 0.3" like the old export
const COLW_RAW = [34, 84, 96, 168, 168, 120, 104, 76];
const HEAD_ROWS = 8;
const HROW_H = 16;                   // header grid row height
const THEAD_H = 18;                  // table header row height
const BROW_H  = 16;                  // body row height
const FOOTER_H = 20;

const TABLE_COLS = ['#','WO#','Old J #','New J # (or UTI reason)','Address','Island Name','Meter Read','Travel (min)'];

// Header grid boxes: [col, row, colspan, rowspan, label, valueKey]. Row/col are
// 0-based into the 8×8 grid; mirrors setupDailyLogTemplate()'s merges + anchors.
const HEADER_BOXES = [
  // A/B — name / partner / captain / AM-delays free area
  [0,0,1,1,'Name:'],        [1,0,1,1,null,'installer'],
  [0,1,1,1,'Partner:'],     [1,1,1,1,null,'partner'],
  [0,2,1,1,'Captain:'],     [1,2,1,1,null,'captain'],
  [0,3,2,1,'Describe AM Delays:'],
  [0,4,2,4,null],
  // C/D — boat / date / sub / delay / departure / lunch / travel
  [2,0,1,1,'Boat Team:'],   [3,0,1,1,null,'boatTeam'],
  [2,1,1,1,'Boat Name:'],   [3,1,1,1,null,'boatName'],
  [2,2,1,1,'Date:'],        [3,2,1,1,null,'date'],
  [2,3,1,1,'Sub:'],         [3,3,1,1,null,'sub'],
  [2,4,1,1,'Delay Time:'],  [3,4,1,1,null,'delayTime'],
  [2,5,1,1,'Departure Time:'], [3,5,1,1,null,'departure'],
  [2,6,1,1,'Lunch Time:'],  [3,6,1,1,null],
  [2,7,1,1,'Travel Time:'], [3,7,1,1,null,'travelTime'],
  // E/F — launch / safety / returned / boat dispatch
  [4,0,2,1,'Launch / Body of Water:'],
  [4,1,2,1,null],
  [4,2,2,1,'Safety Concerns:'],
  [4,3,2,2,null],
  [4,5,2,1,'Returned to Land:'],
  [4,6,2,1,null,'returned'],
  [4,7,2,1,'Boat Dispatch:'],
  // G/H — weather / needed-on-teams / ride to 1st WO / boat dispatch value
  [6,0,2,1,'Weather / Wind & Direction:'],
  [6,1,2,1,null,'weather'],
  [6,2,2,1,'Needed on Boat Teams:'],
  [6,3,2,2,null],
  [6,5,2,1,'Ride to 1st WO:'],
  [6,6,2,1,null],
  [6,7,2,1,null,'boatDispatch'],
];

function locLabel(s){
  const unit = String(s.unit==null?'':s.unit).trim(), addr = String(s.address==null?'':s.address).trim();
  if(!addr) return '';
  return unit ? (unit + ' ' + addr) : addr;
}

// File-name-safe installer + date, matching the old server naming.
function pdfName(s){
  const who = String(s.installer||'').replace(/[^A-Za-z0-9]+/g,'') || 'Installer';
  return who + '_' + (s.date||'') + '_DailyLog.pdf';
}

// Build the PDF and return { blob, name }. Two templates: the boat daily log
// (the original 8×8 header grid + travel column) and the land sheet (flat table
// with per-category DELAYS (MIN) columns, no travel) — picked by the summary's
// workType, which the spine and buildLocalSummary both set.
export function renderDailyLog(summary){
  const s = summary || {};
  if(s.workType === 'land') return renderLandDailyLog(s);
  const showDT = s.includeDelays !== false;

  const JsPDF = getJsPDF();
  const doc = new JsPDF({ orientation:'landscape', unit:'pt', format:'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - 2*MARGIN;
  const scale = contentW / COLW_RAW.reduce((a,b)=>a+b, 0);
  const colW = COLW_RAW.map(w => w*scale);
  const colX = []; let acc = MARGIN; colW.forEach(w => { colX.push(acc); acc += w; });
  const gridX = c => colX[c];
  const gridW = (c, cs) => { let w=0; for(let i=0;i<cs;i++) w += colW[c+i]; return w; };

  doc.setLineWidth(0.5);
  doc.setDrawColor(120);

  // Fit a string into maxW at the current font, truncating with an ellipsis.
  const fit = (txt, maxW) => {
    txt = String(txt==null?'':txt);
    if(doc.getTextWidth(txt) <= maxW) return txt;
    let t = txt;
    while(t.length > 1 && doc.getTextWidth(t+'…') > maxW) t = t.slice(0, -1);
    return t + '…';
  };
  // Draw text inside a box with padding + alignment + vertical centering.
  const put = (x, y, w, h, txt, opt) => {
    opt = opt || {};
    if(txt==null || txt==='') return;
    doc.setFont('helvetica', opt.bold ? 'bold' : 'normal');
    doc.setFontSize(opt.size || 9);
    const pad = opt.pad==null ? 3 : opt.pad;
    const t = fit(txt, w - 2*pad);
    const ty = y + h/2 + (opt.size||9)*0.34;   // rough vertical centre
    if(opt.align === 'center') doc.text(t, x + w/2, ty, { align:'center' });
    else doc.text(t, x + pad, ty);
  };

  // ── header grid ────────────────────────────────────────────────────────────
  const headTop = MARGIN;
  const values = {
    installer: s.installer || '', partner: s.partner || '', captain: s.captain || '',
    boatTeam: s.boatTeam || '', boatName: s.boatName || '', date: s.date || '', sub: s.sub || '',
    departure: s.departure || '', returned: s.returned || '', weather: s.weather || '',
    delayTime:    showDT ? num(s.downtimeTotalMin) : '',
    travelTime:   showDT ? num(travelColSum(s)) : '',
    boatDispatch: showDT ? num(s.boatDispatchMin) : '',
  };
  HEADER_BOXES.forEach(b => {
    const [c, r, cs, rs, label, vkey] = b;
    const x = gridX(c), y = headTop + r*HROW_H, w = gridW(c, cs), h = rs*HROW_H;
    doc.rect(x, y, w, h);
    if(label) put(x, y, w, HROW_H, label, { bold:true, size:7, pad:3 });
    if(vkey)  put(x, y, w, h, values[vkey], { size:9, pad:4 });
  });

  // ── table header ─────────────────────────────────────────────────────────
  let y = headTop + HEAD_ROWS*HROW_H;
  const drawTableHead = (yy) => {
    TABLE_COLS.forEach((t, i) => {
      // Re-set the fill before EVERY cell: drawing text emits `0 g` (black) which
      // becomes the current fill colour, so a single set-before-loop would leave
      // every cell after the first filled black.
      doc.setFillColor(238, 241, 245);
      doc.rect(colX[i], yy, colW[i], THEAD_H, 'FD');
      put(colX[i], yy, colW[i], THEAD_H, t, { bold:true, size:7.5, align:'center' });
    });
    return yy + THEAD_H;
  };
  y = drawTableHead(y);

  // ── body rows (installs + UTIs, like the old export) ───────────────────────
  const stops = s.stops || [];
  const editable = stops.filter(x => x.status==='INSTALLED' || x.status==='UTI');
  // Order by arrival time so the position numbers read 1..n.
  editable.sort((a, b) => (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));

  editable.forEach((x, i) => {
    if(y + BROW_H > pageH - MARGIN){            // new page → repeat the table head
      doc.addPage();
      y = drawTableHead(MARGIN);
    }
    const reads = (x.meterRead!=null && x.meterRead!=='')
      ? (String(x.meterRead) + ((x.meterReadReceived!=null && x.meterReadReceived!=='') ? (' / '+x.meterReadReceived) : ''))
      : (x.noReadReason ? 'no read' : '');
    const note4 = x.status==='UTI' ? (x.utiReason || 'UTI') : (x.newJNumber || '');
    const t = showDT && s.perStopTravel ? s.perStopTravel[x.id] : undefined;
    const travel = t==='~' ? '~' : (t==null || t===0 ? '' : String(t));
    const cells = [
      String(i+1), x.workOrderId||'', x.oldJNumber||'', note4,
      locLabel(x), '', (x.status==='INSTALLED' ? reads : ''), travel
    ];
    cells.forEach((cval, ci) => {
      doc.rect(colX[ci], y, colW[ci], BROW_H);
      const center = ci===0 || ci===6 || ci===7;
      put(colX[ci], y, colW[ci], BROW_H, cval, { size:8.5, align: center?'center':undefined });
    });
    y += BROW_H;
  });

  // ── footer (totals + visited / delay summary) ──────────────────────────────
  if(y + FOOTER_H > pageH - MARGIN){ doc.addPage(); y = MARGIN; }
  const installed   = stops.filter(x => x.status==='INSTALLED').length;
  const uti         = stops.filter(x => x.status==='UTI').length;
  const visited     = stops.filter(x => x.status==='VISITED').length;
  const unaccounted = stops.filter(x => x.status==='UNACCOUNTED').length;
  const done        = stops.filter(x => x.status==='DONE').length;
  const visitedTotal = visited + unaccounted + done;
  const extraCounts = visitedTotal ? ('Visited ' + visitedTotal + '  ·  ') : '';
  const dt = s.downtime || [];
  const delays = dt.filter(d => CATEGORIES.indexOf(d.category) >= 0);
  const breaks = dt.filter(d => BREAK_CATS.indexOf(d.category) >= 0);
  const misc   = dt.filter(d => TRAVEL_ADJ_CATS.indexOf(d.category) >= 0);
  const segs = ['Delays:  ' + downtimeSummary(delays)];
  if(breaks.length) segs.push('Breaks:  ' + downtimeSummary(breaks));
  if(misc.length)   segs.push('Misc Travel:  ' + downtimeSummary(misc));
  const footerText = showDT ? (extraCounts + segs.join('   ·   ')) : extraCounts.replace(/\s*·\s*$/, '');

  // Total Installed: | n | Total UTI's: | n | summary spanning the rest
  doc.rect(colX[0], y, colW[0]+colW[1], FOOTER_H);
  put(colX[0], y, colW[0]+colW[1], FOOTER_H, 'Total Installed:', { bold:true, size:7.5 });
  doc.rect(colX[2], y, colW[2], FOOTER_H);
  put(colX[2], y, colW[2], FOOTER_H, String(installed), { size:9, align:'center' });
  doc.rect(colX[3], y, colW[3], FOOTER_H);
  put(colX[3], y, colW[3], FOOTER_H, "Total UTI's:  " + uti, { bold:true, size:7.5 });
  const sx = colX[4], sw = gridW(4, 4);
  doc.rect(sx, y, sw, FOOTER_H);
  put(sx, y, sw, FOOTER_H, footerText, { size:7.5 });

  return { blob: doc.output('blob'), name: pdfName(s) };
}

// ── land daily log ───────────────────────────────────────────────────────────
// Reproduces the land crew's paper sheet: a header strip (Name / Date / Sign /
// Weather), one row per INSTALLED/UTI work order with its delay minutes spread
// across per-category DELAYS (MIN) columns, and a totals row summing each
// category. Travel time never prints here — it's tracked on the backend
// (Timing/Tracker) only. The delay columns are the 10 delay CATEGORIES in the
// paper sheet's order (the sheet's unlabeled spare column carries Other).
const LAND_DELAY_COLS = [
  'NEXT_GEN','CELL_SIGNAL','BAD_WEATHER','WAREHOUSE','TOOLS_MATERIAL',
  'DISPATCH','TRUCK_ISSUES','ASSIST','OTHER','URGENT_EER'
];
const LAND_DELAY_LABELS = {
  NEXT_GEN:'Next\nGen', CELL_SIGNAL:'Cell\nSignal', BAD_WEATHER:'Bad\nWeather',
  WAREHOUSE:'Ware-\nhouse', TOOLS_MATERIAL:'Tools\nMat.', DISPATCH:'Dis-\npatch',
  TRUCK_ISSUES:'Truck\nIssues', ASSIST:'Assist.', OTHER:'Other', URGENT_EER:'Urgent\nEER'
};
// Width proportions: 6 identity columns + 10 delay columns (scaled to the page).
const LAND_COLW_RAW = [52, 38, 128, 76, 96, 34].concat(LAND_DELAY_COLS.map(() => 33));
const LAND_HEAD_H  = 24;   // Name/Date/Sign/Weather strip + DELAYS (MIN) title
const LAND_THEAD_H = 24;   // column-label row (two-line delay labels)
const LAND_ROW_H   = 16;
const LAND_TOTAL_H = 18;

export function renderLandDailyLog(summary){
  const s = summary || {};
  const JsPDF = getJsPDF();
  const doc = new JsPDF({ orientation:'landscape', unit:'pt', format:'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const contentW = pageW - 2*MARGIN;
  const scale = contentW / LAND_COLW_RAW.reduce((a,b)=>a+b, 0);
  const colW = LAND_COLW_RAW.map(w => w*scale);
  const colX = []; let acc = MARGIN; colW.forEach(w => { colX.push(acc); acc += w; });
  const spanW = (c, n) => { let w=0; for(let i=0;i<n;i++) w += colW[c+i]; return w; };
  const DELAY0 = 6;                       // first delay column index

  doc.setLineWidth(0.5);
  doc.setDrawColor(120);

  const fit = (txt, maxW) => {
    txt = String(txt==null?'':txt);
    if(doc.getTextWidth(txt) <= maxW) return txt;
    let t = txt;
    while(t.length > 1 && doc.getTextWidth(t+'…') > maxW) t = t.slice(0, -1);
    return t + '…';
  };
  const put = (x, y, w, h, txt, opt) => {
    opt = opt || {};
    if(txt==null || txt==='') return;
    doc.setFont('helvetica', opt.bold ? 'bold' : 'normal');
    doc.setFontSize(opt.size || 9);
    const pad = opt.pad==null ? 3 : opt.pad;
    const lines = String(txt).split('\n');
    const lh = (opt.size||9) * 1.08;
    const ty0 = y + h/2 + (opt.size||9)*0.34 - (lines.length-1)*lh/2;
    lines.forEach((ln, i) => {
      const t = fit(ln, w - 2*pad);
      if(opt.align === 'center') doc.text(t, x + w/2, ty0 + i*lh, { align:'center' });
      else doc.text(t, x + pad, ty0 + i*lh);
    });
  };

  // ── header strip: Name / Date / Sign / Weather + DELAYS (MIN) title ────────
  let y = MARGIN;
  const leftW = spanW(0, DELAY0);
  const idW = leftW / 4;
  const idFields = [
    ['Name:',    s.installer || ''],
    ['Date:',    s.date || ''],
    ['Sign:',    ''],
    ['Weather:', s.weather || ''],
  ];
  idFields.forEach((f, i) => {
    const x = MARGIN + i*idW;
    doc.setFillColor(238, 241, 245);
    doc.rect(x, y, idW, LAND_HEAD_H, 'FD');
    put(x, y, idW, LAND_HEAD_H, f[0], { bold:true, size:8, pad:4 });
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    if(f[1]) doc.text(fit(f[1], idW - doc.getTextWidth(f[0]) - 14),
                      x + 6 + doc.getTextWidth(f[0]) + 3, y + LAND_HEAD_H/2 + 3);
  });
  doc.setFillColor(238, 241, 245);
  doc.rect(colX[DELAY0], y, spanW(DELAY0, LAND_DELAY_COLS.length), LAND_HEAD_H, 'FD');
  put(colX[DELAY0], y, spanW(DELAY0, LAND_DELAY_COLS.length), LAND_HEAD_H,
      'DELAYS (MIN)', { bold:true, size:9, align:'center' });
  y += LAND_HEAD_H;

  // ── column-label row (repeated on page breaks) ─────────────────────────────
  const HEAD_LABELS = ['WO#','Unit','House / Address','New J#','Meter Read / Notes','C /\nUTI']
    .concat(LAND_DELAY_COLS.map(c => LAND_DELAY_LABELS[c]));
  const drawTableHead = (yy) => {
    HEAD_LABELS.forEach((t, i) => {
      doc.setFillColor(238, 241, 245);   // re-set per cell — see boat renderer note
      doc.rect(colX[i], yy, colW[i], LAND_THEAD_H, 'FD');
      put(colX[i], yy, colW[i], LAND_THEAD_H, t, { bold:true, size:7, align:'center', pad:1 });
    });
    return yy + LAND_THEAD_H;
  };
  y = drawTableHead(y);

  // ── per-WO delay attribution ───────────────────────────────────────────────
  // Delay-category downtime keyed by WO#; breaks / misc travel / legacy
  // TRAVEL_TIME never print on this sheet. Rows without a WO# go to the
  // unassigned pool (still counted in the column totals below).
  const isDelay = c => CATEGORIES.indexOf(c) >= 0;
  const normWO = v => String(v==null?'':v).trim().toUpperCase();
  const byWO = {}; const colTotal = {}; const unassigned = {};
  (s.downtime || []).forEach(d => {
    const c = String(d.category||'OTHER').toUpperCase(), m = Number(d.minutes)||0;
    if(!isDelay(c) || !m) return;
    colTotal[c] = (colTotal[c]||0) + m;
    const wo = normWO(d.workOrderId);
    if(wo){ byWO[wo] = byWO[wo] || {}; byWO[wo][c] = (byWO[wo][c]||0) + m; }
    else  { unassigned[c] = (unassigned[c]||0) + m; }
  });

  // ── body rows ──────────────────────────────────────────────────────────────
  const stops = s.stops || [];
  const editable = stops.filter(x => x.status==='INSTALLED' || x.status==='UTI');
  editable.sort((a, b) => (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
  const woUsed = {};   // attribute a WO's delays to its first printed row only

  editable.forEach(x => {
    if(y + LAND_ROW_H > pageH - MARGIN){
      doc.addPage();
      y = drawTableHead(MARGIN);
    }
    const reads = (x.meterRead!=null && x.meterRead!=='')
      ? (String(x.meterRead) + ((x.meterReadReceived!=null && x.meterReadReceived!=='') ? (' / '+x.meterReadReceived) : ''))
      : '';
    // Meter Read / Notes doubles as the reason cell: a UTI prints its reason,
    // an unreadable install prints why there's no read.
    const readNotes = x.status==='UTI' ? (x.utiReason || 'UTI')
                    : (reads || x.noReadReason || '');
    const wo = normWO(x.workOrderId);
    const delays = (wo && !woUsed[wo]) ? (byWO[wo] || {}) : {};
    if(wo) woUsed[wo] = true;
    const cells = [
      x.workOrderId || '', x.unit || '', x.address || '',
      x.status==='INSTALLED' ? (x.newJNumber || '') : '',
      readNotes, x.status==='UTI' ? 'UTI' : 'C'
    ].concat(LAND_DELAY_COLS.map(c => delays[c] ? String(delays[c]) : ''));
    cells.forEach((cval, ci) => {
      doc.rect(colX[ci], y, colW[ci], LAND_ROW_H);
      const center = ci===1 || ci>=5;
      put(colX[ci], y, colW[ci], LAND_ROW_H, cval, { size:8.5, align: center?'center':undefined, pad:2 });
    });
    y += LAND_ROW_H;
  });

  // ── totals row: each delay column sums the whole day's minutes ─────────────
  if(y + LAND_TOTAL_H > pageH - MARGIN){ doc.addPage(); y = MARGIN; }
  const installed = stops.filter(x => x.status==='INSTALLED').length;
  const uti       = stops.filter(x => x.status==='UTI').length;
  doc.setFillColor(238, 241, 245);
  doc.rect(colX[0], y, spanW(0, DELAY0), LAND_TOTAL_H, 'FD');
  put(colX[0], y, spanW(0, DELAY0), LAND_TOTAL_H,
      `Totals · ${installed} Install · ${uti} UTI`, { bold:true, size:8.5 });
  LAND_DELAY_COLS.forEach((c, i) => {
    const ci = DELAY0 + i;
    doc.rect(colX[ci], y, colW[ci], LAND_TOTAL_H);
    put(colX[ci], y, colW[ci], LAND_TOTAL_H, colTotal[c] ? String(colTotal[c]) : '', { bold:true, size:8.5, align:'center' });
  });
  y += LAND_TOTAL_H;

  // Delay minutes that aren't attached to a WO# still count in the column
  // totals — say where they came from so the sheet reconciles at a glance.
  const unParts = LAND_DELAY_COLS.filter(c => unassigned[c])
    .map(c => (CAT_LABEL[c]||c) + ' ' + unassigned[c]);
  if(unParts.length){
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
    doc.text(fit('Not tied to a WO#: ' + unParts.join(' · ') + ' min', contentW), MARGIN + 2, y + 10);
  }

  return { blob: doc.output('blob'), name: pdfName(s) };
}

// Render + trigger a download (loading jsPDF on demand first). Returns the
// file name.
export async function downloadDailyLog(summary){
  await ensureJsPDF();
  const { blob, name } = renderDailyLog(summary);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

// ── small helpers ────────────────────────────────────────────────────────────
function num(v){ return (v==null || v==='') ? '' : String(v); }
// Travel Time box = sum of the per-stop Travel column actually printed — i.e. only
// the INSTALLED/UTI body rows, excluding the '~' launch — so the box reconciles
// with the column, exactly like the old Sheet export.
function travelColSum(s){
  const p = s.perStopTravel || {};
  let sum = 0;
  (s.stops || [])
    .filter(x => x.status==='INSTALLED' || x.status==='UTI')
    .forEach(x => { const v = p[x.id]; if(typeof v === 'number') sum += v; });
  return sum;
}
