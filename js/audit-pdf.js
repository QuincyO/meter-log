// ── The audit as a downloaded PDF ────────────────────────────────────────────
// "Download PDF" on audits.html and my-audit.html. The file is built on the device
// with the vendored jsPDF (the same library the daily-log PDF uses), so there is
// no print dialog and nothing is sent anywhere.
//
// This is a WRITER, not a second copy of the audit. What a view says is decided
// once, in js/audit-render.js, as a list of sections; the page writes those
// sections as HTML and this file writes the same sections as a Letter-size
// document. To change the audit's words or numbers, change the section builders.
// Change this file only to change how a kind of block is drawn on paper.
//
// Things that are easy to get wrong here:
//   • jsPDF's built-in fonts draw Latin text and a little punctuation, nothing
//     else. Every string goes through pdfText(), which keeps what the font has
//     (–, —, ·, ‹, ›, curly quotes, accents) and drops or replaces the rest. An
//     address or order number from the sheet can hold anything.
//   • The route map has NO street background. The page's map tiles are images
//     from another site; they are not embedded. Pins and lines are drawn on a
//     plain box from the coordinates alone, so the PDF needs no signal.
//   • Blocks marked screenOnly (a hint to tap something) and slots (elements the
//     page fills in) are skipped. A PDF has nothing to tap.
//   • A table can be longer than a page. Its heading row is drawn again at the
//     top of each page it runs onto.
import { driveStats } from './compute/audit.js';
import { SEGMENTS, fmtClock, fmtMin, fmtDate, timelineBlocks, endLabel, histCaption } from './audit-charts.js';
import { MODE_LABEL, NO_DRIVE_LOG, ROUTE_CAPTION, periodSections, daySections, methodSection, notesList, dayNotes,
  driveLineHtml } from './audit-render.js';
import { driveRuns, offMapText } from './audit-map.js';

const PAGE = { w: 612, h: 792, m: 42 };             // US Letter, in points
const INK = [19, 23, 28], SOFT = [90, 99, 110], LINE = [217, 222, 229], RED = [214, 69, 0];
const GREEN = [30, 142, 90], PURPLE = [124, 58, 237], GROUND = [241, 243, 245];
const SEG = Object.fromEntries(SEGMENTS.map(s => [s.key, s]));
const rgb = hex => (hex.length === 4 ? [1, 2, 3].map(i => parseInt(hex[i] + hex[i], 16)) : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

// What the built-in font can draw: printable ASCII, Latin-1, and this punctuation.
const DRAWABLE = /[ -~¡-ÿ–—‘’“”•…‹›]/;
/** Any value → text the PDF font can draw. */
export function pdfText(v){
  const s = String(v == null ? '' : v).replace(/→/g, '->').replace(/←/g, '<-').replace(/≥/g, '>=').replace(/≤/g, '<=');
  return [...s].map(ch => (/\s/.test(ch) ? ' ' : DRAWABLE.test(ch) ? ch : '')).join('').replace(/ {2,}/g, ' ').trim();
}

/** 'Audit - <name> - <day | from to to>.pdf', safe as a file name everywhere. */
export function auditPdfName({ name, from, to, day }){
  const who = pdfText(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/ {2,}/g, ' ').trim() || 'installer';
  const when = day || (from && to ? (from === to ? from : `${from} to ${to}`) : from || to || '');
  return `Audit - ${who}${when ? ' - ' + when : ''}.pdf`;
}

// ── what goes in ─────────────────────────────────────────────────────────────
/** The period view as a PDF model. `today` is 'yyyy-MM-dd'. */
export function periodPdfModel({ name, prep, stats, today }){
  const first = stats.daily.length ? stats.daily[0].date : '', last = stats.daily.length ? stats.daily[stats.daily.length - 1].date : '';
  return { title: `Audit: ${name}`,
    sub: [MODE_LABEL[prep.mode] || 'Work', first ? `${fmtDate(first)} to ${fmtDate(last)}` : 'no logs', `made ${fmtDate(today)}`].join(' · '),
    notes: notesList({ prep, stats, name }), sections: periodSections(stats, prep),
    fileName: auditPdfName({ name, from: first, to: last }) };
}
/** One day as a PDF model. `drive` is null on the installer's page; on the office
 *  page it is { legs, show }: the day's drive-log legs and whether the overlay is
 *  switched on. The numbers line is printed whenever there are legs; the track is
 *  drawn only when it is showing on the page. */
export function dayPdfModel({ name, prep, detail, drive, today }){
  const day = detail.day, parts = daySections(detail);
  const legs = drive && drive.show && drive.legs.length ? drive.legs : null;
  const off = offMapText(day);
  const route = { title: 'Route worked', blocks: [
    ...(drive ? [{ t: 'cap', text: drive.legs.length ? driveLineHtml(driveStats(drive.legs)) : NO_DRIVE_LOG }] : []),
    { t: 'map', day, legs },
    ...(off ? [{ t: 'cap', text: off }] : []),
    { t: 'cap', text: ROUTE_CAPTION + (legs ? ' The purple line is where the truck drove.' : '') }] };
  return { title: `Audit: ${name}`,
    sub: [MODE_LABEL[prep.mode] || 'Work', fmtDate(day.date), `made ${fmtDate(today)}`].join(' · '),
    notes: dayNotes(day, prep.mode), sections: [...parts.top, route, ...parts.bottom, methodSection()],
    fileName: auditPdfName({ name, day: day.date }) };
}

// ── drawing ──────────────────────────────────────────────────────────────────
function pen(doc){
  const c = { doc, y: PAGE.m, bottom: PAGE.h - PAGE.m - 14, full: { x: PAGE.m, w: PAGE.w - 2 * PAGE.m } };
  c.font = (size, bold = false, color = INK) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color); };
  c.put = (text, x, y, opts) => { const t = pdfText(text); if(t) doc.text(t, x, y, opts); };
  c.width = text => doc.getTextWidth(pdfText(text));
  c.wrap = (text, width) => { const t = pdfText(text); return t ? doc.splitTextToSize(t, Math.max(20, width)) : []; };
  /** Start a new page when fewer than `h` points are left. True when it did. */
  c.need = h => { if(c.y + h <= c.bottom) return false; doc.addPage(); c.y = PAGE.m; return true; };
  c.rule = (x, w, color = LINE, weight = 0.5) => { doc.setDrawColor(...color); doc.setLineWidth(weight); doc.line(x, c.y, x + w, c.y); };
  return c;
}

function paragraph(c, f, text, { size = 9, bold = false, color = INK, lead = 1.32, after = 4 } = {}){
  c.font(size, bold, color);
  for(const line of c.wrap(text, f.w)){
    c.need(size * lead);
    c.font(size, bold, color);                 // a new page resets nothing, but be sure
    c.y += size * lead;
    c.put(line, f.x, c.y - size * 0.28);
  }
  c.y += after;
}

function tiles(c, f, items){
  const gap = 8, n = items.length || 1, tw = (f.w - gap * (n - 1)) / n;
  c.font(7.8);
  const labels = items.map(([, label]) => c.wrap(label, tw - 14));
  const h = 30 + Math.max(...labels.map(l => l.length), 1) * 9.6 + 6;
  c.need(h + 6);
  items.forEach(([num], i) => {
    const x = f.x + i * (tw + gap);
    c.doc.setDrawColor(...LINE); c.doc.setLineWidth(0.7); c.doc.roundedRect(x, c.y, tw, h, 4, 4, 'S');
    c.font(14, true); c.put(num, x + 7, c.y + 19);
    c.font(7.8, false, SOFT); labels[i].forEach((line, k) => c.put(line, x + 7, c.y + 31 + k * 9.6));
  });
  c.y += h + 8;
}

// The stacked bar: the average day (numbers inside the wide parts) and a single
// day's timeline (a long gap outlined). `ends` carries the four clock marks.
function stack(c, f, blocks, ends, { numbers = false } = {}){
  const total = blocks.reduce((s, b) => s + b.minutes, 0);
  if(!(total > 0)) return;
  c.need(56);
  c.font(7.6, false, SOFT);
  c.put(`${fmtClock(ends.startMin)} start`, f.x, c.y + 7);
  c.put(`${ends.label} ${fmtClock(ends.endMin)}`, f.x + f.w, c.y + 7, { align: 'right' });
  const top = c.y + 11, h = 18;
  let x = f.x;
  const flagged = [];
  for(const b of blocks){
    const w = b.minutes / total * f.w, s = SEG[b.key];
    c.doc.setFillColor(...rgb(s.color)); c.doc.rect(x, top, w, h, 'F');
    if(!numbers && w > 1.2){ c.doc.setDrawColor(255, 255, 255); c.doc.setLineWidth(0.4); c.doc.line(x + w, top, x + w, top + h); }
    if(numbers && w > 20){ c.font(7.6, true, rgb(s.ink)); c.put(fmtMin(b.minutes), x + w / 2, top + 12, { align: 'center' }); }
    if(b.flag) flagged.push([x, w]);
    x += w;
  }
  for(const [fx, fw] of flagged){ c.doc.setDrawColor(...INK); c.doc.setLineWidth(1.3); c.doc.rect(fx, top, fw, h, 'S'); }
  const span = ends.endMin - ends.startMin;
  const mark = (min, text) => {
    const p = span > 0 ? Math.max(0, Math.min(1, (min - ends.startMin) / span)) : 0, mx = f.x + p * f.w;
    c.doc.setDrawColor(...SOFT); c.doc.setLineWidth(0.7); c.doc.line(mx, top + h + 1, mx, top + h + 5);
    c.font(7.6, false, SOFT);
    c.put(text, mx, top + h + 13, { align: p < 0.12 ? 'left' : p > 0.88 ? 'right' : 'center' });
  };
  mark(ends.firstMin, 'first meter ' + fmtClock(ends.firstMin));
  if(ends.lastMin > ends.firstMin) mark(ends.lastMin, 'last meter ' + fmtClock(ends.lastMin));
  c.y = top + h + 20;
}

function legend(c, f){
  c.font(7.8, false, INK);
  let x = f.x; c.need(12); c.y += 9;
  for(const s of SEGMENTS){
    const w = 10 + c.width(s.label) + 12;
    if(x + w > f.x + f.w + 0.5 && x > f.x){ x = f.x; c.need(11); c.y += 11; }
    c.doc.setFillColor(...rgb(s.color)); c.doc.rect(x, c.y - 6.4, 6.5, 6.5, 'F');
    c.font(7.8, false, INK); c.put(s.label, x + 10, c.y);
    x += w;
  }
  c.y += 7;
}

function histogram(c, f, bins, allowance){
  const chart = 68, colW = f.w / bins.length, max = Math.max(...bins.map(b => b.days), 0);
  c.need(chart + 44);
  const base = c.y + 12 + chart;
  bins.forEach((b, i) => {
    const x = f.x + i * colW, h = max > 0 ? b.days / max * chart : 0;
    c.doc.setFillColor(...RED); c.doc.rect(x + 2, base - Math.max(h, 0.6), colW - 4, Math.max(h, 0.6), 'F');
    c.font(7.6, true); c.put(String(b.days), x + colW / 2, base - Math.max(h, 0.6) - 3, { align: 'center' });
    c.font(6.4, false, SOFT); c.put(isFinite(b.hi) ? `${b.lo}–${b.hi}` : `${b.lo}+`, x + colW / 2, base + 9, { align: 'center' });
  });
  const at = bins.findIndex(b => b.lo === allowance);
  if(at >= 0){
    c.doc.setDrawColor(...INK); c.doc.setLineWidth(1); c.doc.setLineDashPattern([2.5, 2.5], 0);
    c.doc.line(f.x + at * colW, c.y + 2, f.x + at * colW, base + 2);
    c.doc.setLineDashPattern([], 0);
  }
  c.y = base + 14;
  paragraph(c, f, histCaption(allowance), { size: 7.6, color: SOFT });
}

// A cell as what to draw: its text, and a small label after it (red for a flag).
function cellParts(cell){
  if(cell == null || typeof cell !== 'object') return { text: pdfText(cell), bold: false, label: '', red: false, indent: 0 };
  return { text: pdfText(cell.text), bold: !!cell.day, label: pdfText(cell.flag || cell.tag || ''), red: !!cell.flag,
    indent: cell.indent || 0 };
}

// A table: the first column on the left and the rest on the right, unless the
// block says otherwise. `bare` (the two-column figure lists) has no heading row.
function table(c, f, block){
  const size = 8.2, lead = 10, padX = 4, gapLabel = 5;
  const cols = block.head.length;
  const right = i => (block.align ? block.align[i] === 'r' : i > 0);
  const rows = block.rows.map(r => (Array.isArray(r) ? r : r.cells).map(cellParts));
  const textW = p => { c.font(size, p.bold); return c.width(p.text); };
  const labelW = p => { if(!p.label) return 0; c.font(size - 1, true); return c.width(p.label); };
  const headW = text => { c.font(size - 0.4, true); return c.width(text); };
  // Each column wants room for its widest cell and its whole heading; at the least
  // it needs its widest cell and the longest single word of its heading.
  const base = [], want = [];
  for(let i = 0; i < cols; i++){
    const cells = Math.max(0, ...rows.map(r => { const p = r[i]; return p ? p.indent + textW(p) + (p.label ? gapLabel + labelW(p) : 0) : 0; }));
    base[i] = Math.max(cells, ...pdfText(block.head[i]).split(' ').map(headW)) + padX * 2;
    want[i] = Math.max(base[i], headW(block.head[i]) + padX * 2);
  }
  const sum = a => a.reduce((s, v) => s + v, 0);
  let widths;
  if(sum(want) <= f.w){ const k = f.w / sum(want); widths = want.map(v => v * k); }
  else if(sum(base) <= f.w){ const spare = f.w - sum(base), ask = sum(want.map((v, i) => v - base[i])) || 1;
    widths = base.map((v, i) => v + spare * (want[i] - v) / ask); }
  else { const k = f.w / sum(base); widths = base.map(v => v * k); }
  const xs = widths.map((_, i) => f.x + sum(widths.slice(0, i)));
  const room = i => widths[i] - padX * 2;
  const edge = i => (right(i) ? xs[i] + widths[i] - padX : xs[i] + (i ? padX : 0));
  const opts = i => (right(i) ? { align: 'right' } : undefined);

  const heading = () => {
    if(block.bare){ c.rule(f.x, f.w); return; }
    c.font(size - 0.4, true, SOFT);
    const lines = block.head.map((h, i) => c.wrap(h, room(i)));
    const h = Math.max(1, ...lines.map(l => l.length)) * (lead - 0.6) + 5;
    lines.forEach((l, i) => l.forEach((line, k) => c.put(line, edge(i), c.y + h - 4 - (l.length - 1 - k) * (lead - 0.6), opts(i))));
    c.y += h; c.rule(f.x, f.w, INK, 0.8);
  };
  c.need(block.bare ? 20 : 46); heading();
  for(const row of rows){
    const lines = row.map((p, i) => { c.font(size, p.bold); return c.wrap(p.text, room(i) - p.indent); });
    // a cell's small label follows its text when there is room, else goes under it
    const lastW = row.map((p, i) => { c.font(size, p.bold); return lines[i].length ? c.width(lines[i][lines[i].length - 1]) : 0; });
    const under = row.map((p, i) => !!p.label && p.indent + lastW[i] + gapLabel + labelW(p) > room(i) + 0.5);
    const h = Math.max(1, ...lines.map((l, i) => l.length + (under[i] ? 1 : 0))) * lead + 5;
    if(c.need(h + 1)) heading();
    row.forEach((p, i) => {
      const last = lines[i].length - 1, lw = labelW(p), beside = p.label && !under[i];
      lines[i].forEach((line, k) => {
        // on a right-aligned cell the label takes the edge and the text sits before it
        const shift = right(i) && beside && k === last ? lw + gapLabel : 0;
        c.font(size, p.bold);
        c.put(line, edge(i) + (right(i) ? -shift : p.indent), c.y + 11 + k * lead, opts(i));
      });
      if(!p.label) return;
      const y = c.y + 11 + Math.max(0, last) * lead + (under[i] ? lead : 0);
      c.font(size - 1, true, p.red ? RED : SOFT);
      if(right(i) || under[i]) c.put(p.label, edge(i) + (right(i) ? 0 : p.indent), y, opts(i));
      else c.put(p.label, edge(i) + p.indent + lastW[i] + gapLabel, y);
    });
    c.y += h; c.rule(f.x, f.w);
  }
  c.y += 6;
}

// Two columns, label and figure. A label written with leading spaces ("  of
// which…") is a sub-line of the one above and is drawn indented.
function pairs(c, f, rows){
  table(c, f, { head: ['', ''], bare: true, rows: rows.map(([label, value]) =>
    [/^\s/.test(String(label)) ? { text: label, indent: 12 } : label, value]) });
}

function list(c, f, block){
  const size = 8.6, lead = size * 1.34, indent = 15;
  block.items.forEach((item, i) => {
    c.font(size);
    const lines = c.wrap(item, f.w - indent);
    c.need(lead * Math.min(lines.length, 2));
    lines.forEach((line, k) => {
      c.need(lead); c.font(size); c.y += lead;
      if(!k) c.put(block.ordered ? `${i + 1}.` : '•', f.x + indent - 5, c.y - size * 0.28, { align: 'right' });
      c.put(line, f.x + indent, c.y - size * 0.28);
    });
    c.y += 2.5;
  });
  c.y += 4;
}

// The route: numbered pins joined in the order logged, on a plain box. No tiles.
function routeMap(c, f, day, legs){
  const pinned = day.logs.map((l, i) => ({ ...l, n: i + 1 })).filter(l => l.pin);
  const runs = (legs || []).flatMap(leg => driveRuns(leg));
  const pts = [...pinned.map(l => [l.lat, l.lng]), ...runs.flat()];
  if(!pinned.length){ paragraph(c, f, 'No pins to draw: no order this day has a location.', { color: SOFT }); return; }
  const h = 236, padIn = 18;
  c.need(h + 10);
  const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
  const latMid = (Math.min(...lats) + Math.max(...lats)) / 2, squeeze = Math.cos(latMid * Math.PI / 180) || 1;
  const xOf = lng => lng * squeeze, minX = Math.min(...lngs.map(xOf)), maxX = Math.max(...lngs.map(xOf));
  const minY = Math.min(...lats), maxY = Math.max(...lats);
  const scale = Math.min((f.w - padIn * 2) / Math.max(maxX - minX, 1e-9), (h - padIn * 2) / Math.max(maxY - minY, 1e-9), 4e6);
  const cx = f.x + f.w / 2, cy = c.y + h / 2, midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  const at = ([lat, lng]) => [cx + (xOf(lng) - midX) * scale, cy - (lat - midY) * scale];
  c.doc.setFillColor(...GROUND); c.doc.setDrawColor(...LINE); c.doc.setLineWidth(0.7);
  c.doc.roundedRect(f.x, c.y, f.w, h, 5, 5, 'FD');
  const path = (points, color, weight) => { c.doc.setDrawColor(...color); c.doc.setLineWidth(weight);
    for(let i = 1; i < points.length; i++){ const [x1, y1] = at(points[i - 1]), [x2, y2] = at(points[i]); c.doc.line(x1, y1, x2, y2); } };
  for(const run of runs) path(run, PURPLE, 1.5);
  path(pinned.map(l => [l.lat, l.lng]), GREEN, 1.7);
  for(const l of pinned){
    const [x, y] = at([l.lat, l.lng]);
    c.doc.setFillColor(...(l.status === 'INSTALLED' ? GREEN : l.status === 'UTI' ? RED : SOFT));
    c.doc.setDrawColor(255, 255, 255); c.doc.setLineWidth(1);
    c.doc.circle(x, y, 6.4, 'FD');
    c.font(l.n > 99 ? 4.6 : 5.8, true, [255, 255, 255]); c.put(String(l.n), x, y + 2, { align: 'center' });
  }
  c.y += h + 8;
}

function drawBlock(c, f, b){
  switch(b.t){
    case 'tiles': return tiles(c, f, b.items);
    case 'bar': return stack(c, f, b.bar.segments, { ...b.bar, label: 'end' }, { numbers: true });
    case 'timeline': { const blocks = timelineBlocks(b.day);
      stack(c, f, blocks, { ...b.day, label: endLabel(b.day) });
      // the page hatches a long gap; on paper it is outlined
      if(blocks.some(x => x.flag)) paragraph(c, f, 'A long gap is outlined in black.', { size: 7.8, color: SOFT, after: 2 });
      return undefined; }
    case 'legend': return legend(c, f);
    case 'hist': return histogram(c, f, b.bins, b.allowance);
    case 'pairs': return pairs(c, f, b.rows);
    case 'table': return table(c, f, b);
    case 'cap': return b.screenOnly ? undefined : paragraph(c, f, b.text, { size: 7.8, color: SOFT, after: 6 });
    case 'empty': return paragraph(c, f, b.text, { color: SOFT });
    case 'h3': c.need(34); c.y += 4; return paragraph(c, f, b.text, { size: 9.4, bold: true, after: 2 });
    case 'list': return list(c, f, b);
    case 'map': return routeMap(c, f, b.day, b.legs);
    case 'two': {
      // side by side: the chart on the left, its figures on the right
      c.need(210);
      const y0 = c.y, page = c.doc.internal.getNumberOfPages();
      b.left.forEach(x => drawBlock(c, { x: f.x, w: f.w * 0.5 }, x));
      const yLeft = c.y, stayed = c.doc.internal.getNumberOfPages() === page;
      if(stayed) c.y = y0;
      b.right.forEach(x => drawBlock(c, stayed ? { x: f.x + f.w * 0.55, w: f.w * 0.45 } : f, x));
      if(stayed && c.doc.internal.getNumberOfPages() === page) c.y = Math.max(c.y, yLeft);
      return undefined;
    }
    default: return undefined;                  // 'slot' and anything the page alone uses
  }
}

/** Draw the audit into `doc` (a jsPDF document in points, Letter). Returns it. */
export function drawAuditPdf(doc, model){
  const c = pen(doc), f = c.full;
  c.font(15, true); c.y += 12; c.put(model.title, f.x, c.y);
  c.y += 14; c.font(8.6, false, SOFT); c.put(model.sub, f.x, c.y);
  c.y += 7; c.rule(f.x, f.w, INK, 1.2); c.y += 8;
  for(const note of model.notes || []) paragraph(c, f, note.text, { size: 9, bold: !!note.warn, color: note.warn ? INK : SOFT });
  for(const section of model.sections || []){
    c.need(64); c.y += 6; c.rule(f.x, f.w, LINE, 0.8); c.y += 13;
    c.font(7.6, true, SOFT); c.put(pdfText(section.title).toUpperCase(), f.x, c.y, { charSpace: 0.9 });
    c.y += 8;
    for(const b of section.blocks) drawBlock(c, f, b);
  }
  const n = doc.internal.getNumberOfPages();
  for(let i = 1; i <= n; i++){
    doc.setPage(i); c.font(7, false, SOFT);
    c.put(`${model.title} · ${model.sub}`, f.x, PAGE.h - 24);
    c.put(`Page ${i} of ${n}`, f.x + f.w, PAGE.h - 24, { align: 'right' });
  }
  return doc;
}

/** A new Letter document with the audit drawn in it. */
export function buildAuditPdf(jsPDF, model){
  return drawAuditPdf(new jsPDF({ unit: 'pt', format: 'letter' }), model);
}

// ── in the browser: load the library on demand, then hand over the file ──────
// jsPDF is ~350 KB and only needed at this moment, so it is injected when asked
// for, exactly as js/dailylog.js does. The file is in the service worker's shell
// (the daily log put it there), so it comes from the cache.
let loading = null;
function ensureJsPDF(){
  if(window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if(!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/jspdf.umd.min.js';
    s.onload = res;
    s.onerror = () => { loading = null; rej(new Error('could not load the PDF library')); };
    document.head.appendChild(s);
  });
  return loading;
}
async function pdfBlob(model){
  await ensureJsPDF();
  return buildAuditPdf(window.jspdf.jsPDF, model).output('blob');
}
function saveBlob(blob, fileName){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
/** Build the PDF and start its download. Resolves to the file name. */
export async function downloadAuditPdf(model){
  saveBlob(await pdfBlob(model), model.fileName);
  return model.fileName;
}

// ── "Send PDF": the system share sheet ───────────────────────────────────────
// The page sends nothing itself. It hands the file to the phone's share sheet and
// the person picks the app (messages, mail) and the recipient there. Four steps,
// kept apart so js/audit-view.js can decide what a refusal means:
//   can()   is there a share sheet that takes a PDF file? (many desktop browsers: no)
//   file()  the same PDF the download makes, as a named File
//   send()  open the share sheet with it. The FILE ALONE: a title or text beside a
//           file makes some apps drop the file or attach the text as a second item.
//   save()  the fallback, an ordinary download of that file
export const auditPdfShare = {
  can(){
    try {
      return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
        && !!navigator.canShare({ files: [new File([''], 'audit.pdf', { type: 'application/pdf' })] });
    } catch { return false; }
  },
  async file(model){ return new File([await pdfBlob(model)], model.fileName, { type: 'application/pdf' }); },
  send(file){ return navigator.share({ files: [file] }); },
  save(file){ saveBlob(file, file.name); },
};
