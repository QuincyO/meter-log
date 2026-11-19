// ── What the Audits pages say ────────────────────────────────────────────────
// Pure: takes the numbers from js/compute/audit.js and returns what a view says.
// No DOM, no fetch, so node can read it (tests/audit-pages.test.mjs). The wiring
// (controls, the address bar, the map) is js/audit-view.js.
//
// A view is described ONCE, as a list of sections, each a title and a list of
// plain blocks (tiles, a table, a caption, a chart…). Two writers turn that list
// into something to look at: sectionsHtml() below for the page, and
// js/audit-pdf.js for the downloaded PDF. So the page and the PDF cannot drift
// apart in their wording, which matters here: the words are part of the contract.
// To change what the audit says, change the section builders, never a writer.
//
// Wording rules, all the owner's:
//   • An unlogged pause is "unlogged pause time, breaks included". The data cannot
//     tell a break from an unlogged delay and the page must not pretend it can.
//   • Dispatch logged before the first meter is "the drive to the first order".
//     His word was "usually", so the label names what was logged and no more.
//   • The time after the last meter is "close-out and drive home". The crew goes
//     home from the field; no label may send them anywhere else.
//   • A figure that rests on no days prints as a dash. Never invent one.
//
// Blocks (the `t` field), and what each carries:
//   tiles {items:[[number, label]]}   bar {bar}   timeline {day}   legend {}
//   hist {bins, allowance}   pairs {rows:[[label, cell]]}   cap {text, screenOnly?}
//   table {head, rows, cls?, align?}  — a row is a list of cells, or {cells, cls, gap}
//   two {left:[blocks], right:[blocks]}   h3 {text}   empty {text}
//   list {ordered, items}   slot {id}  — an empty element the view fills (page only)
// A cell is text, or {text, day?, flag?, tag?}: `day` makes the page's cell a
// button that opens that day; `flag` and `tag` are the small labels after it.
import { esc, attr } from './dom.js';
import { AUDIT } from './compute/audit.js';
import { fmtClock, fmtMin, fmtDur, fmtDate, dayBarHtml, pauseHistogramHtml, timelineHtml, legendHtml }
  from './audit-charts.js';

const isNum = v => typeof v === 'number' && isFinite(v);
const n0 = v => isNum(v) ? Math.round(v).toLocaleString('en-CA') : '—';
const n1 = v => isNum(v) ? (Math.round(v * 10) / 10).toFixed(1) : '—';
const share = v => isNum(v) ? Math.round(v * 100) + '%' : '—';
const mins = v => isNum(v) ? fmtMin(v) + ' min' : '—';
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const monthName = m => { const x = /^(\d{4})-(\d{2})$/.exec(m); return x ? MONTHS[+x[2] - 1] + ' ' + x[1] : m; };
const shortDate = d => fmtDate(d).replace(/, \d{4}$/, '');
const MODE_WORK = { land: 'land work', boat: 'boat work', all: 'land and boat work' };
const LAND_ONLY = 'The pause figures were checked against land work only.';
/** What each work mode is called in a heading. */
export const MODE_LABEL = { land: 'Land work', boat: 'Boat work', all: 'Land and boat work' };
/** Said in place of the drive-log numbers on a day with no legs (office view). */
export const NO_DRIVE_LOG = 'No drive log was recorded this day.';

/** Under the route map, on the page and in the PDF. */
export const ROUTE_CAPTION = 'Pins are numbered in the order the orders were logged and joined in that order with '
  + 'straight lines. It is the order worked, not the roads driven.';

// ── the HTML writer ──────────────────────────────────────────────────────────
function cellHtml(c){
  if(c == null) return '';
  if(typeof c !== 'object') return esc(c);
  return (c.day ? `<button type="button" class="au-daybtn" data-day="${attr(c.day)}">${esc(c.text)}</button>` : esc(c.text))
    + (c.flag ? ` <span class="au-flag">${esc(c.flag)}</span>` : '')
    + (c.tag ? ` <span class="au-tag">${esc(c.tag)}</span>` : '');
}
/** A cell as plain text, for a writer with no markup (the PDF). */
export function cellText(c){
  if(c == null) return '';
  if(typeof c !== 'object') return String(c);
  return String(c.text);
}
const right = (b, i) => (b.align ? b.align[i] === 'r' : i > 0);

function blockHtml(b){
  switch(b.t){
    case 'tiles': return '<div class="au-tiles">' + b.items.map(([n, label]) =>
      `<div class="au-tile"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('') + '</div>';
    case 'bar': return dayBarHtml(b.bar);
    case 'timeline': return timelineHtml(b.day);
    case 'legend': return legendHtml();
    case 'hist': return pauseHistogramHtml(b.bins, b.allowance);
    case 'cap': return `<p class="au-cap${b.screenOnly ? ' au-noprint' : ''}">${esc(b.text)}</p>`;
    case 'empty': return `<p class="au-empty">${esc(b.text)}</p>`;
    case 'h3': return `<h3>${esc(b.text)}</h3>`;
    case 'slot': return `<div id="${attr(b.id)}"></div>`;
    case 'list': { const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>` + b.items.map(t => `<li>${esc(t)}</li>`).join('') + `</${tag}>`; }
    case 'two': return `<div class="au-two"><div>${blocksHtml(b.left)}</div>${blocksHtml(b.right)}</div>`;
    case 'pairs': return '<table class="au-table au-pairs"><tbody>' + b.rows.map(([label, value]) =>
      `<tr><td>${esc(label)}</td><td class="n">${cellHtml(value)}</td></tr>`).join('') + '</tbody></table>';
    case 'table': return `<div class="au-scroll"><table class="au-table${b.cls ? ' ' + b.cls : ''}"><thead><tr>`
      + b.head.map((h, i) => `<th${right(b, i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
      + b.rows.map(r => { const row = Array.isArray(r) ? { cells: r } : r;
          return `<tr${row.cls ? ` class="${attr(row.cls)}"` : ''}${row.gap == null ? '' : ` data-gap="${row.gap}"`}>`
            + row.cells.map((c, i) => `<td${right(b, i) ? ' class="n"' : ''}>${cellHtml(c)}</td>`).join('') + '</tr>'; }).join('')
      + '</tbody></table></div>';
    default: return '';
  }
}
const blocksHtml = blocks => blocks.map(blockHtml).join('');
/** Sections → the page's cards. Method and limits is a closed <details>. */
export function sectionsHtml(sections){
  return sections.map(s => '<section class="card au-card">' + (s.method
    ? `<details class="au-method"><summary>${esc(s.title)}</summary>${blocksHtml(s.blocks)}</details>`
    : `<h2>${esc(s.title)}</h2>${blocksHtml(s.blocks)}`) + '</section>').join('');
}

// ── notes above the audit ────────────────────────────────────────────────────
/** The lines above a period: the empty state, what the statistics rest on, and
 *  the warning on Boat and All. Each is {text, warn?}. */
export function notesList({ prep, stats, name }){
  const out = [];
  if(prep.mode !== 'land') out.push({ text: LAND_ONLY, warn: true });
  if(!stats.days){
    out.push({ text: `No logs for ${name} in this view.` });
    if(prep.skippedOtherMode)
      out.push({ text: `${plural(prep.skippedOtherMode, 'log is', 'logs are')} in the other work mode.` });
    return out;
  }
  out.push({ text: `Statistics use the ${plural(stats.fullDays, 'day', 'days')} with `
    + `${AUDIT.MIN_ORDERS} or more orders, of ${plural(stats.days, 'day', 'days')}.` });
  return out;
}
const notesToHtml = list => list.map(n => `<p class="au-note${n.warn ? ' warn' : ''}">${esc(n.text)}</p>`).join('');
export function notesHtml(model){ return notesToHtml(notesList(model)); }

/** The lines above a day: late, never closed out, left out of the statistics. */
export function dayNotes(day, mode = 'land'){
  const out = [], end = fmtClock(AUDIT.DEFAULT_END_MIN);
  if(mode !== 'land') out.push({ text: LAND_ONLY, warn: true });
  if(!day.qualifies) out.push({ text: `Left out of the statistics (under ${AUDIT.MIN_ORDERS} orders).` });
  if(day.pastEnd && day.closed) out.push({ text: 'Worked past the set end time: the day runs to the last meter.' });
  if(!day.closed) out.push({ text: day.pastEnd
    ? `Not closed out, and the last meter was after ${end}: the day runs to the last meter.`
    : `Not closed out: ${end} is assumed.` });
  return out;
}
export function dayNotesHtml(day, mode){ return notesToHtml(dayNotes(day, mode)); }

// ── the period ───────────────────────────────────────────────────────────────
function headlineSection(p){
  const h = p.headline;
  return { title: 'Headline', blocks: [{ t: 'tiles', items: [
    [n0(p.orders), `orders logged on ${plural(p.days, 'working day', 'working days')}`],
    [n1(h.ordersAvg), `orders a day on average${isNum(h.ordersBest) ? ` (best day ${h.ordersBest})` : ''}`],
    [mins(h.pauseMedian), 'unlogged pause time between meters on a typical day, breaks included'],
    [mins(h.loggedAvg), `delay logged per day${isNum(h.loggedBeforeShare) ? `, ${share(h.loggedBeforeShare)} of all logged delay falls before the first meter` : ''}`],
  ] }] };
}

function barSection(p){
  const title = 'Where an average day goes';
  if(!p.bar) return { title, blocks: [{ t: 'empty',
    text: `No day with ${AUDIT.MIN_ORDERS} or more orders in this view, so there is no average day to draw.` }] };
  return { title, blocks: [{ t: 'bar', bar: p.bar }, { t: 'legend' }, { t: 'cap',
    text: 'Minutes of an average day, from the start of the shift to the end of the day. Averages are used here so '
      + 'the parts add up to the whole day; the typical-day (median) figures elsewhere on this page run a little lower. '
      + 'A log is written when a job is finished, so the first installation sits inside "Before the first meter, not logged". '
      + 'The last block is the time from the last meter log to the end of the day. Nothing in the log says how it was spent.' }] };
}

function pauseSection(p){
  const s = p.pause;
  const range = (a, b) => isNum(a) && isNum(b) ? `${fmtMin(a)} to ${fmtMin(b)} min` : '—';
  const rows = [
    ['Typical day (median)', mins(s.median)],
    ['Average', mins(s.avg)],
    ['Middle half of days', range(s.p25, s.p75)],
    ['Lowest tenth of days, up to', mins(s.p10)],
    ['Highest tenth of days, from', mins(s.p90)],
    [`Days under ${AUDIT.BREAK_ALLOWANCE_MIN} min`, `${s.under60} of ${p.fullDays}`],
    ['Days at 90 min or more', `${s.over90} of ${p.fullDays}`],
    ['Pauses a day', n1(s.perDay)],
    ['Typical longest pause', isNum(s.longestMedian)
      ? `${fmtMin(s.longestMedian)} min, starting around ${fmtClock(s.longestAtMedian)}` : '—'],
    ['Before logged delays are taken off', isNum(s.allMedian)
      ? `median ${fmtMin(s.allMedian)}, average ${fmtMin(s.allAvg)} min` : '—'],
    [`Long gaps (${AUDIT.FLAG_MIN}+ min of unlogged pause)`, `${s.flags} on ${plural(s.flagDays, 'day', 'days')}`],
  ];
  return { title: 'Unlogged pause time per day', blocks: [
    { t: 'two',
      left: [p.fullDays ? { t: 'hist', bins: s.bins, allowance: AUDIT.BREAK_ALLOWANCE_MIN } : { t: 'empty', text: 'No full days to chart.' }],
      right: [{ t: 'pairs', rows }] },
    { t: 'cap', text: 'Time between meters that is neither the usual time for the stop nor a logged delay. It includes breaks and lunch '
      + `(the allowance is ${AUDIT.BREAK_ALLOWANCE_MIN} minutes a day), delays that were not logged, and stops that simply took longer than usual. `
      + 'The data cannot tell these apart.' }] };
}

function monthSection(p){
  if(!p.months.length) return { title: 'By month', blocks: [{ t: 'empty', text: 'No full days in this view.' }] };
  return { title: 'By month', blocks: [{ t: 'table',
    head: ['Month', 'Days', 'Orders a day', 'First meter', 'Last meter', 'Min per order', 'Unlogged pause (median)', 'Logged delay (average)'],
    rows: p.months.map(m => [monthName(m.month), m.days, n1(m.ordersAvg), fmtClock(m.firstAvg), fmtClock(m.lastAvg),
      n1(m.perOrder), fmtMin(m.pauseMedian), fmtMin(m.loggedAvg)]) },
    { t: 'cap', text: 'Minutes per order is the time from the first to the last meter over the orders after the first, so pauses are in it.' }] };
}

function categorySection(p){
  const l = p.loggedPerDay;
  const cats = !p.categories.length ? [{ t: 'empty', text: 'No delay was logged in this view.' }] : [{ t: 'table',
    head: ['Category', 'Minutes', 'Share', 'Days logged', 'Before the first meter', 'Between meters'],
    rows: p.categories.map(c => [c.label, n0(c.minutes), share(c.share), c.days, share(c.beforeShare), share(c.betweenShare)]) },
    { t: 'cap', text: 'Every day in the period, short days included. Travel, break and lunch entries are left out.' }];
  return { title: 'Logged delays by category', blocks: [...cats,
    { t: 'h3', text: 'Logged delay per day (average)' },
    { t: 'pairs', rows: [
      ['Before the first meter', mins(l.before)],
      ['  of which dispatch (the drive to the first order)', mins(l.dispatchBefore)],
      ['  of which all other delays', mins(l.otherBefore)],
      ['Between meters', mins(l.between)],
      ['Logged without a time of day', mins(l.untimed)],
      ...(isNum(l.after) && l.after > 0 ? [['After the last meter', mins(l.after)]] : []),
      ['Total', mins(l.total)],
    ] }] };
}

function outputSection(p, prep){
  const o = p.output;
  const few = p.usual.some(u => u.count < AUDIT.MIN_KIND_GAPS && isNum(u.median));
  return { title: 'Output', blocks: [
    { t: 'pairs', rows: [
      ['Orders a day, average', n1(o.ordersAvg)],
      ['Orders a day, typical (median)', n0(o.ordersMedian)],
      ['Slowest tenth of days, up to', n0(o.ordersP10)],
      ['Best tenth of days, from', n0(o.ordersP90)],
      ['Best day', n0(o.ordersBest)],
      ['First meter, average', fmtClock(o.firstAvg)],
      ['First meter, middle half of days', isNum(o.firstP25) ? `${fmtClock(o.firstP25)} to ${fmtClock(o.firstP75)}` : '—'],
      ['Last meter, average', fmtClock(o.lastAvg)],
      ['First to last meter, average', mins(o.spanAvg)],
      ['Of that, working', mins(o.workAvg)],
      ['Minutes per order', n1(o.perOrder)],
      ['Installed', n0(p.status.installed)],
      ['Unable to install', n0(p.status.uti)],
      ['Other visits', n0(p.status.other)],
    ] },
    { t: 'h3', text: 'The usual time between two logs, by distance' },
    { t: 'table', head: ['Distance to the next order', 'Usual time (median)', 'Gaps'],
      rows: p.usual.map(u => [u.label, isNum(u.median) ? n1(u.median) + ' min' : '—',
        u.count + (u.count < AUDIT.MIN_KIND_GAPS && isNum(u.median) ? ' *' : '')]) },
    { t: 'cap', text: `From ${n0(p.gapsCount)} gaps, over all ${MODE_WORK[prep.mode] || 'work'} to date, whatever period is shown.`
      + (isNum(p.nextDoorShare) ? ` ${share(p.nextDoorShare)} of gaps are next door.` : '')
      + (few ? ` * Fewer than ${AUDIT.MIN_KIND_GAPS} gaps of this kind: the usual time over every gap is used.` : '')
      + (p.unpinned ? ` ${plural(p.unpinned, 'log has', 'logs have')} no pin in this period; a gap beside one is compared with the usual time over every gap.` : '') }] };
}

function dailySection(p){
  return { title: 'Day by day', blocks: [{ t: 'table', cls: 'au-days',
    head: ['Date', 'Orders', 'First meter', 'Last meter', 'Delay before first meter', 'Delay between meters', 'Unlogged pause', 'Longest pause'],
    rows: p.daily.slice().reverse().map(d => [
      { text: shortDate(d.date), day: d.date },
      d.n, fmtClock(d.firstMin), fmtClock(d.lastMin), fmtMin(d.loggedBefore), fmtMin(d.loggedBetween),
      { text: fmtMin(d.pauseUn), flag: d.flags ? plural(d.flags, 'long gap', 'long gaps') : '',
        tag: d.qualifies ? '' : `under ${AUDIT.MIN_ORDERS} orders` },
      d.longest > 0 ? `${fmtMin(d.longest)} at ${fmtClock(d.longestAt)}` : '—']) },
    { t: 'cap', text: `Minutes. Open a day for its timeline and route. A long gap is one whose unlogged pause is ${AUDIT.FLAG_MIN} minutes or more: `
      + 'the time over the usual for that stop, less any delay logged against it.' }] };
}

/** Method and limits, as a section. */
export function methodSection(){
  const A = AUDIT, start = fmtClock(A.SHIFT_START_MIN), end = fmtClock(A.DEFAULT_END_MIN);
  return { title: 'Method and limits', method: true, blocks: [
    { t: 'h3', text: 'How each number is worked out' },
    { t: 'list', ordered: true, items: [
      'Every log with the status installed, unable to install, visited or unaccounted counts as an order.',
      'Land or boat work is decided by the date, not by a tag on the log.',
      'Logs are grouped by calendar day and put in time order.',
      'A gap is the time from one log to the next on the same day, with the straight line distance between the two pins. '
        + 'Gaps are sorted into seven kinds by that distance, from next door (under 60 m) to over 10 km.',
      'The usual time for a kind is this installer\'s own median gap of that kind, over all their work to date in the chosen work mode. '
        + `A kind with fewer than ${A.MIN_KIND_GAPS} gaps, and a gap beside a log with no pin, is compared with the median of every gap.`,
      `A gap ${A.PAUSE_OVER_MIN} minutes or more over its usual time is a pause, and the excess is its length. A smaller overrun stays work.`,
      'A delay logged against that same gap is taken off the pause, never below zero. Travel, break and lunch entries are not taken off.',
      'What is left is unlogged pause time. The typical day is the median of the daily totals.',
      'Working time is the gaps with each pause cut back to the usual time, so first-to-last-meter time is working time plus all pause time.',
      'A logged delay is placed before the first meter, between meters or after the last meter by the times in its entry. One with no times is "without a time of day".',
      `The shift starts at ${start}. The day ends at the time set at close-out, at ${end} when the day was never closed out, `
        + 'or at the last meter when that is later. "Before the first meter, not logged" is the first meter less the start less the delay logged before it. '
        + '"Close-out and drive home" is the end of the day less the last meter.',
      `Per-day statistics use only days with ${A.MIN_ORDERS} or more orders. Shorter days are listed and can be opened.`,
      `A single gap is marked as a long gap when its unlogged pause is ${A.FLAG_MIN} minutes or more. That is the time over the usual for the stop, less any delay logged against it, so a ${A.FLAG_MIN}-minute gap is not by itself a long gap.`,
      `The break allowance is ${A.BREAK_ALLOWANCE_MIN} minutes a day: two 15-minute breaks and a 30-minute lunch.`,
    ] },
    { t: 'h3', text: 'What the data cannot show' },
    { t: 'list', ordered: false, items: [
      'It cannot separate a break from an unlogged delay. Both are a gap that ran long with nothing logged against it.',
      'The comparison is with the installer\'s own usual pace, not a company standard and not another installer. A stop that took longer because the job was harder counts as a pause.',
      'A log records one moment per order, when the entry is saved. Arrival and departure are not recorded, so the first installation and the drive to it sit before the first log.',
      `The start is the ${start} rule and the end is the time recorded at close-out. Neither was checked against anything.`,
      'Distances are straight lines between pins. The route map joins the pins with straight lines too: it is the order worked, not the roads driven.',
      'Logged delays are as entered. Reading morning dispatch as the drive to the first order is how the installer says it is used.',
      `The ${A.PAUSE_OVER_MIN}-minute threshold, the ${A.FLAG_MIN}-minute flag and the ${A.MIN_ORDERS}-order rule are choices.`,
      'On Boat and All: the pause method was only checked against land work.',
      'Drive logs exist only for the days and phones where tracking was switched on, and only while the app was in front. Average speed includes slow movement while parked.',
    ] }] };
}
/** Method and limits: closed until opened, open in print. */
export function methodHtml(){
  const s = methodSection();
  return `<details class="au-method"><summary>${esc(s.title)}</summary>${blocksHtml(s.blocks)}</details>`;
}

/** The period view: eight sections in the order the owner approved. Empty when
 *  the view holds no days at all (the note above the audit says so). */
export function periodSections(p, prep){
  if(!p || !p.days) return [];
  return [headlineSection(p), barSection(p), pauseSection(p), monthSection(p), categorySection(p),
    outputSection(p, prep), dailySection(p), methodSection()];
}
export function periodHtml(p, prep){ return sectionsHtml(periodSections(p, prep)); }

// ── one day ──────────────────────────────────────────────────────────────────
const STATUS_LABEL = { INSTALLED: 'Installed', UTI: 'UTI', VISITED: 'Visited', UNACCOUNTED: 'Unaccounted' };
const metres = km => !isNum(km) ? 'not known (no pin)' : km < 1 ? Math.round(km * 1000) + ' m' : n1(km) + ' km';
const logName = (day, i) => `#${i + 1} ${day.logs[i].workOrderId || 'no order number'}`;

function timelineSection(day, forPage){
  return { title: 'Timeline of the day', blocks: [{ t: 'timeline', day }, { t: 'legend' },
    ...(day.gaps.length ? [{ t: 'cap', screenOnly: true, text: 'One block per gap between logs. Pick a block, or a row in the list at the bottom, '
      + 'for its two orders, the distance, the usual time and what was logged against it.' }] : []),
    ...(forPage ? [{ t: 'slot', id: 'auGapDetail' }] : [])] };
}

function compareSection({ day, baselines }){
  const b30 = baselines.last30, all = baselines.all;
  const count = v => isNum(v) ? (Number.isInteger(v) ? String(v) : n1(v)) : '—';
  const row = (label, f, a, b, c) => [label, f(a), f(b), f(c)];
  return { title: 'This day, and how it compares', blocks: [{ t: 'table',
    head: ['', 'This day', `30 worked days before (${plural(b30.days, 'day', 'days')})`, `All to date (${plural(all.days, 'day', 'days')})`],
    rows: [
      row('Orders (average)', count, day.n, b30.ordersAvg, all.ordersAvg),
      row('First meter (average)', fmtClock, day.firstMin, b30.firstAvg, all.firstAvg),
      row('Last meter (average)', fmtClock, day.lastMin, b30.lastAvg, all.lastAvg),
      row('Delay logged before the first meter (average)', fmtMin, day.log.before, b30.loggedBeforeAvg, all.loggedBeforeAvg),
      row('Delay logged between meters (average)', fmtMin, day.log.between, b30.loggedBetweenAvg, all.loggedBetweenAvg),
      row('Unlogged pause (median)', fmtMin, day.pauseUnMin, b30.pauseMedian, all.pauseMedian),
      ['Longest pause (median)', day.longestMin > 0 ? `${fmtMin(day.longestMin)} at ${fmtClock(day.longestAtMin)}` : '—',
        fmtMin(b30.longestMedian), fmtMin(all.longestMedian)],
    ] },
    { t: 'cap', text: `Minutes, and clock times. The two right-hand columns are over days with ${AUDIT.MIN_ORDERS} or more orders: `
      + 'the worked days just before this one, and all work to date in this work mode. '
      + 'Each of those uses the figure named in its row. The first column is simply this day.' }] };
}

function delaysSection(day){
  const span = d => `${fmtClock(d.fromMin)}–${fmtClock(d.toMin)}`;
  const against = d => d.where === 'untimed' ? 'no time of day'
    : d.where === 'before' ? `${span(d)}, before the first meter`
    : d.where === 'after' ? `${span(d)}, after the last meter` : span(d);
  const extra = [day.log.breaks ? `${fmtMin(day.log.breaks)} min of breaks or lunch` : '',
    day.log.travel ? `${fmtMin(day.log.travel)} min of travel` : ''].filter(Boolean);
  return { title: 'Delays logged this day', blocks: [
    day.delays.length
      ? { t: 'table', head: ['Category', 'Minutes', 'Logged against'], rows: day.delays.map(d =>
          [d.driveToFirst ? 'Dispatch (drive to the first order)' : d.label, fmtMin(d.minutes), against(d)]) }
      : { t: 'empty', text: 'No delay was logged this day.' },
    ...(extra.length ? [{ t: 'cap', text: `Also entered: ${extra.join(' and ')}. These are not delays and are not taken off any pause.` }] : [])] };
}

function readAs(g){
  if(!g.isPause) return 'work';
  const over = fmtMin(g.over), un = fmtMin(g.unloggedMin), logged = fmtMin(g.over - g.unloggedMin);
  const flag = g.flagged ? 'long gap' : '';
  if(!(g.unloggedMin > 0)) return `pause ${over}, all logged as a delay`;
  if(!(g.over - g.unloggedMin > 0)) return { text: `pause ${over}, nothing logged`, flag };
  return { text: `pause ${over}: ${logged} logged as a delay, ${un} not logged`, flag };
}

function logsSection(day){
  return { title: 'Every log, in order', blocks: [{ t: 'table', cls: 'au-logs',
    head: ['#', 'Time', 'Order', 'Status', 'Gap', 'Usual', 'Read as'], align: ['l', 'l', 'l', 'l', 'r', 'r', 'l'],
    rows: day.logs.map((l, i) => {
      const g = i ? day.gaps[i - 1] : null;
      return { cls: 'au-logrow', gap: g ? g.i : null, cells: [i + 1, l.clock,
        { text: l.workOrderId || '—', tag: l.pin ? '' : 'no pin' }, STATUS_LABEL[l.status] || l.status,
        g ? fmtMin(g.min) : '—', g ? n1(g.usual) : '—', g ? readAs(g) : 'first meter'] };
    }) },
    { t: 'cap', text: `Gap is the minutes since the log before. Usual is the usual time for that distance. A gap ${AUDIT.PAUSE_OVER_MIN} minutes or more over the usual time is read as a pause.` }] };
}

/** A day, as sections: what sits above the route map and what sits below it.
 *  `forPage` adds the empty slot the page opens a gap's detail in. `detail` is
 *  dayDetail()'s result. */
export function daySections(detail, { forPage = false } = {}){
  return { top: [timelineSection(detail.day, forPage), compareSection(detail), delaysSection(detail.day)],
    bottom: [logsSection(detail.day)] };
}
export function dayTopHtml(detail){ return sectionsHtml(daySections(detail, { forPage: true }).top); }
export function dayLogsHtml(day){ return sectionsHtml([logsSection(day)]); }

/** What opens when a gap is picked (the page only). '' when the day has no such gap. */
export function gapDetailHtml(day, i){
  const g = day.gaps[i];
  if(!g) return '';
  const a = day.logs[i], b = day.logs[i + 1];
  const kind = g.kind < 0 ? 'every gap (a pin is missing)' : AUDIT.KIND_LABELS[g.kind];
  const place = l => `${esc(l.clock)}${l.address ? ', ' + esc(l.address) : ''}`;
  return `<div class="au-gap"><b>${esc(logName(day, i))}</b> (${place(a)}) to <b>${esc(logName(day, i + 1))}</b> (${place(b)})`
    + blockHtml({ t: 'pairs', rows: [
      ['Time between the two logs', mins(g.min)],
      ['Straight-line distance', metres(g.km)],
      [`Usual time for ${kind}`, n1(g.usual) + ' min'],
      ['Over the usual time', g.over > 0 ? mins(g.over) : 'none'],
      ['Logged against this gap', mins(g.loggedMin)],
      g.isPause ? ['Not logged', { text: mins(g.unloggedMin), flag: g.flagged ? 'long gap' : '' }]
        : ['Read as', `work (under ${AUDIT.PAUSE_OVER_MIN} minutes over)`],
    ] }) + '</div>';
}

/** The one line of drive-log numbers; '' with no legs. `s` = driveStats()'s result. */
export function driveLineHtml(s){
  if(!s) return '';
  return `Top ${fmtMin(s.topKmh)} km/h · average ${fmtMin(s.avgKmh)} km/h · ${n1(s.km)} km · `
    + `${fmtDur(s.driveMin)} driving · ${plural(s.legs, 'leg', 'legs')}`;
}
