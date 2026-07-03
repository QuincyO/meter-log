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
import { CATEGORIES, BREAK_CATS, TRAVEL_ADJ_CATS, downtimeSummary } from './compute/categories.js';

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

// Build the PDF and return { blob, name }.
export function renderDailyLog(summary){
  const s = summary || {};
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
