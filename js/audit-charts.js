// ── The audit's charts and number formats, as plain HTML strings ─────────────
// No canvas and no library: every chart is boxes with inline widths, so it prints
// exactly as drawn and node can test it (tests/audit-charts.test.mjs). The colours
// are inline too, so nothing here depends on a stylesheet having loaded; the
// layout classes (au-*) live in css/audits.css.
//
// The labels are the owner's words and are part of the contract. The crew goes
// home from the field: nothing may call the end of the day a drive anywhere but
// home. "Unlogged pauses (breaks included)" is worded that way because the data
// cannot tell a break from an unlogged delay.
import { esc, attr } from './dom.js';

export const SEGMENTS = [   // order is the drawing order
  { key: 'delayBefore',    label: 'Logged delays before the first meter',                               color: '#F59E0B', ink: '#1a1300' },
  { key: 'driveToFirst',   label: 'Drive to the first order (dispatch logged before the first meter)',  color: '#2563EB', ink: '#fff' },
  { key: 'beforeUnlogged', label: 'Before the first meter, not logged',                                 color: '#94A3B8', ink: '#13171C' },
  { key: 'work',           label: 'Working',                                                            color: '#1E8E5A', ink: '#fff' },
  { key: 'pauseUnlogged',  label: 'Unlogged pauses (breaks included)',                                  color: '#D64500', ink: '#fff' },
  { key: 'pauseLogged',    label: 'Pause time logged as a delay',                                       color: '#FCD34D', ink: '#1a1300' },
  { key: 'closeout',       label: 'Close-out and drive home',                                           color: '#64748B', ink: '#fff' },
];
const SEG = Object.fromEntries(SEGMENTS.map(s => [s.key, s]));

const pad = n => String(n).padStart(2, '0');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isNum = v => typeof v === 'number' && isFinite(v);

/** Minutes after midnight → 'HH:MM', rounded to the minute; '—' with no value. */
export function fmtClock(min){
  if(!isNum(min)) return '—';
  const t = Math.round(min);
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
/** Minutes, rounded to a whole number; '—' with no value. */
export function fmtMin(min){ return isNum(min) ? String(Math.round(min)) : '—'; }
/** 91 → '1 h 31 min'; under an hour, '45 min'. */
export function fmtDur(min){
  if(!isNum(min)) return '—';
  const t = Math.round(min);
  return t < 60 ? t + ' min' : Math.floor(t / 60) + ' h ' + (t % 60) + ' min';
}
/** 'yyyy-MM-dd' → 'Mon Nov 16, 2026'. Built by hand so it reads the same on every
 *  phone, whatever its locale. */
export function fmtDate(dateKey){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if(!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const w = share => (Math.round(share * 100000) / 1000) + '%';   // three decimals

// A bar with its four clock marks: start and end above it at the edges, first and
// last meter below it at their place along it.
function framed(blocks, cls, { startMin, firstMin, lastMin, endMin }, endLabel){
  const span = endMin - startMin;
  const at = min => span > 0 ? Math.max(0, Math.min(100, (min - startMin) / span * 100)) : 0;
  // A label is centred on its mark, except near an end, where half of it would hang
  // off the card: there it is anchored to the mark's inner side.
  const tick = (min, text) => { const p = at(min);
    return `<span class="au-tick${p < 12 ? ' l' : p > 88 ? ' r' : ''}" style="left:${w(p / 100)}">${esc(text)}</span>`; };
  return `<div class="au-stackwrap"><div class="au-ends"><span>${fmtClock(startMin)} start</span><span>${esc(endLabel)} ${fmtClock(endMin)}</span></div>`
    + `<div class="${cls}">${blocks}</div>`
    + `<div class="au-ticks">${tick(firstMin, 'first meter ' + fmtClock(firstMin))}`
    + (lastMin > firstMin ? tick(lastMin, 'last meter ' + fmtClock(lastMin)) : '') + '</div></div>';
}

/** periodStats().bar → the stacked average-day bar; '' when there is no bar. */
export function dayBarHtml(bar){
  if(!bar) return '';
  const totalMin = bar.segments.reduce((s, x) => s + x.minutes, 0);
  if(!(totalMin > 0)) return '';
  const blocks = bar.segments.map(x => {
    const s = SEG[x.key], share = x.minutes / totalMin;
    return `<i class="au-blk" data-seg="${x.key}" style="width:${w(share)};background:${s.color};color:${s.ink}"`
      + ` title="${attr(s.label + ': ' + fmtMin(x.minutes) + ' min')}">${share > 0.045 ? fmtMin(x.minutes) : ''}</i>`;
  }).join('');
  return framed(blocks, 'au-stack', bar, 'end');
}

/** Days by unlogged pause time. `bins` = periodStats().pause.bins; the column whose
 *  range starts at the break allowance carries the dashed allowance line. */
export function pauseHistogramHtml(bins, allowanceMin){
  if(!bins || !bins.length) return '';
  const max = Math.max(...bins.map(b => b.days), 0);
  const cols = bins.map(b => {
    const label = isFinite(b.hi) ? `${b.lo}–${b.hi}` : `${b.lo}+`;
    const h = max > 0 ? Math.round(b.days / max * 1000) / 10 : 0;
    return `<div class="au-hcol${b.lo === allowanceMin ? ' allow' : ''}" data-lo="${b.lo}">`
      + `<span class="au-hn">${b.days}</span><span class="au-hbar"><i style="height:${h}%"></i></span>`
      + `<span class="au-hl">${label}</span></div>`;
  }).join('');
  return `<div class="au-hist" role="img" aria-label="Number of days by minutes of unlogged pause time">${cols}</div>`
    + `<div class="au-hcap">${esc(histCaption(allowanceMin))}</div>`;
}
/** The line under the histogram, on the page and in the PDF. */
export const histCaption = allowanceMin =>
  `Minutes of unlogged pause time in the day. The dashed line is the ${fmtMin(allowanceMin)}-minute break allowance.`;

/** One day (a DayRec from prepareAudit) as blocks from its start to its end: the
 *  time before the first meter split three ways, then per gap its work, the part
 *  of a pause that was logged as a delay and the part that was not, then close-out
 *  and drive home. Each is { key, minutes, gap, flag, title }: `key` is a SEGMENTS
 *  key, `gap` the gap's index (null outside the gaps), `flag` a long gap. Zero-
 *  length blocks are left out. The page and the PDF both draw from this list. */
export function timelineBlocks(day){
  const out = [];
  if(!day || !(day.endMin - day.startMin > 0)) return out;
  const block = (key, minutes, gap, flag, title) => {
    if(!(minutes > 0)) return;
    out.push({ key, minutes, gap, flag: !!flag, title: title || (SEG[key].label + ': ' + fmtMin(minutes) + ' min') });
  };
  // Before the first meter. More delay can be logged there than there was time;
  // the logged blocks are then scaled to fit and the unlogged block is empty.
  const room = day.firstMin - day.startMin;
  const logged = day.log.otherBefore + day.log.dispatchBefore;
  const fit = logged > room && logged > 0 ? room / logged : 1;
  block('delayBefore', day.log.otherBefore * fit, null, false,
    SEG.delayBefore.label + ': ' + fmtMin(day.log.otherBefore) + ' min');
  block('driveToFirst', day.log.dispatchBefore * fit, null, false,
    SEG.driveToFirst.label + ': ' + fmtMin(day.log.dispatchBefore) + ' min');
  block('beforeUnlogged', Math.max(0, room - logged));
  for(const g of day.gaps){
    const from = fmtClock(g.atMin), to = fmtClock(g.atMin + g.min);
    block('work', g.isPause ? g.usual : g.min, g.i, false, `${from}–${to}: ${fmtMin(g.min)} min`);
    if(!g.isPause) continue;
    block('pauseLogged', g.over - g.unloggedMin, g.i, false,
      `${from}–${to}: ${fmtMin(g.over - g.unloggedMin)} min logged as a delay`);
    block('pauseUnlogged', g.unloggedMin, g.i, g.flagged,
      `${from}–${to}: ${fmtMin(g.unloggedMin)} min, nothing logged`);
  }
  block('closeout', day.closeoutMin);
  return out;
}

/** The timeline as HTML. A gap's blocks are buttons carrying data-gap="<index>". */
export function timelineHtml(day){
  const blocks = timelineBlocks(day);
  if(!blocks.length) return '';
  const span = day.endMin - day.startMin;
  const html = blocks.map(b => { const tag = b.gap == null ? 'i' : 'button';
    return `<${tag}${b.gap == null ? '' : ' type="button"'} class="au-blk${b.flag ? ' flag' : ''}" data-seg="${b.key}"`
      + `${b.gap == null ? '' : ` data-gap="${b.gap}"`} style="width:${w(b.minutes / span)};background:${SEG[b.key].color}"`
      + ` title="${attr(b.title)}"></${tag}>`; }).join('');
  return framed(html, 'au-stack au-timeline', day, endLabel(day));
}
/** What the right-hand end of a day's bar is called. */
export const endLabel = day => (day.endSource === 'lastMeter' ? 'last meter' : 'end');

/** The colour key. `keys` = the SEGMENTS keys to show (all of them when omitted),
 *  always listed in drawing order. */
export function legendHtml(keys){
  const want = keys ? new Set(keys) : null;
  return '<div class="au-key">' + SEGMENTS.filter(s => !want || want.has(s.key))
    .map(s => `<span style="--c:${s.color}">${esc(s.label)}</span>`).join('') + '</div>';
}
