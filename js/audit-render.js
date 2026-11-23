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
//   • The DAY view is for a supervisor to skim (2026-11-23): charts, headlines, a few
//     numbers, and the installer's own notes. How a figure is worked out goes in the
//     closed sections at the bottom of the page (pageOnly), which the PDF leaves out.
//
// Blocks (the `t` field), and what each carries:
//   tiles {items:[[number, label]], per?}   bar {bar}   timeline {day}   legend {keys?, short?}
//   quote {label, text}  — the installer's own words
//   hist {bins, allowance}   pairs {rows:[[label, cell]]}   cap {text, screenOnly?}
//   table {head, rows, cls?, align?, flex?, dense?}  — a row is a list of cells, or
//     {cells, cls, gap, notes}; notes are lines under the row. flex (a column that takes
//     the spare width and wraps) and dense are for the PDF
//   two {left:[blocks], right:[blocks]}   h3 {text}   empty {text}
//   list {ordered, items}   slot {id}  — an empty element the view fills (page only)
// A cell is text, or {text, day?, flag?, tag?}: `day` makes the page's cell a
// button that opens that day; `flag` and `tag` are the small labels after it.
import { esc, attr } from './dom.js';
import { AUDIT } from './compute/audit.js';
import { fmtClock, fmtMin, fmtDur, fmtDate, dayBarHtml, pauseHistogramHtml, timelineHtml, timelineBlocks, legendHtml }
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
// The longest pause: its minutes, when it began, and the order logged at its end.
const longest = (min, at, wo) => (min > 0 ? `${fmtMin(min)} at ${fmtClock(at)}${wo ? ` (${wo})` : ''}` : '—');
const shortDate = d => fmtDate(d).replace(/, \d{4}$/, '');
const MODE_WORK = { land: 'land work', boat: 'boat work', all: 'land and boat work' };
const LAND_ONLY = 'The pause figures were checked against land work only.';
/** What each work mode is called in a heading. */
export const MODE_LABEL = { land: 'Land work', boat: 'Boat work', all: 'Land and boat work' };
/** Said in place of the drive-log numbers on a day with no legs (office view). */
export const NO_DRIVE_LOG = 'No drive log was recorded this day.';

/** Under the route map, on the page and in the PDF. */
export const ROUTE_CAPTION = 'Pins are numbered in the order worked and joined with straight lines, not the roads driven.';
/** The caption for the route actually drawn: along the road map's roads, or straight lines. */
export function routeCaption(byRoad){
  return byRoad ? 'Pins are numbered in the order worked. The line is the shortest drive by road, not always the one taken. '
    + 'A straight piece is off the road map.' : ROUTE_CAPTION;
}
// How the gaps were measured (prep.distance), as a note. Nothing is said when the
// device has no road map: straight lines are the ordinary case and the method says so.
const usesRoads = d => !!(d && d.road > 0);
function distanceNote(d){
  if(!d || !d.map) return [];
  if(!d.road) return [{ text: `The offline road map on this device (${d.map}) reaches none of these orders: distances are straight lines.` }];
  return [{ text: `Distances between orders are by road, from the offline road map on this device (${d.map}).`
    + (d.straight ? ` ${d.straight} of ${plural(d.road + d.straight, 'gap', 'gaps')} are off that map and are straight lines.` : '') }];
}

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
    case 'tiles': return `<div class="au-tiles${b.per === 3 ? ' three' : ''}">` + b.items.map(([n, label]) =>
      `<div class="au-tile"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('') + '</div>';
    case 'bar': return dayBarHtml(b.bar);
    case 'timeline': return timelineHtml(b.day);
    case 'legend': return legendHtml(b.keys, b.short);
    case 'quote': return `<p class="au-quote"><b>${esc(b.label)}:</b> ${esc(b.text)}</p>`;
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
            + row.cells.map((c, i) => `<td${right(b, i) ? ' class="n"' : ''}>${cellHtml(c)}</td>`).join('') + '</tr>'
            + (row.notes || []).map(t => `<tr class="au-noterow"><td></td><td colspan="${row.cells.length - 1}">${esc(t)}</td></tr>`).join(''); }).join('')
      + '</tbody></table></div>';
    default: return '';
  }
}
const blocksHtml = blocks => blocks.map(blockHtml).join('');
/** Sections → the page's cards. A `method` section is a closed <details>; a `pageOnly`
 *  one is left out of print, as it is of the PDF. */
export function sectionsHtml(sections){
  return sections.map(s => `<section class="card au-card${s.pageOnly ? ' au-noprint' : ''}">` + (s.method
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
  out.push(...distanceNote(prep.distance));
  return out;
}
const notesToHtml = list => list.map(n => `<p class="au-note${n.warn ? ' warn' : ''}">${esc(n.text)}</p>`).join('');
export function notesHtml(model){ return notesToHtml(notesList(model)); }

/** The lines above a day: late, never closed out, left out of the statistics. How the
 *  distances were measured is under the map and in the closed sections. */
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
    [mins(h.pauseMedian), 'unlogged pause time between meters on a typical day, unlogged breaks included'],
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
  const brk = p.breaks || {};
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
    ['Breaks and lunch logged, per day (average)', isNum(brk.loggedAvg) ? `${fmtMin(brk.loggedAvg)} min, against an allowance of ${AUDIT.BREAK_ALLOWANCE_MIN}` : '—'],
    ['Days with a break or lunch logged', `${brk.days || 0} of ${p.fullDays}` + (brk.overAllowance ? `, ${brk.overAllowance} over the allowance` : '')],
  ];
  return { title: 'Unlogged pause time per day', blocks: [
    { t: 'two',
      left: [p.fullDays ? { t: 'hist', bins: s.bins, allowance: AUDIT.BREAK_ALLOWANCE_MIN } : { t: 'empty', text: 'No full days to chart.' }],
      right: [{ t: 'pairs', rows }] },
    { t: 'cap', text: 'Time between meters with nothing logged against it: not the usual time for the stop, not a logged delay and not a logged break. '
      + `It includes any break or lunch that was not logged (the allowance is ${AUDIT.BREAK_ALLOWANCE_MIN} minutes a day), delays that were not logged, `
      + 'and stops that simply took longer than usual. The data cannot tell these apart. A break that is logged leaves this figure and is compared '
      + 'with the allowance on its own, so days from before breaks were logged show more here for the same work.' }] };
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
      longest(d.longest, d.longestAt, d.longestWo)]) },
    { t: 'cap', text: `Minutes. Open a day for its timeline and route. A long gap is one whose unlogged pause is ${AUDIT.FLAG_MIN} minutes or more: `
      + 'the time over the usual for that stop, less any delay logged against it.' }] };
}

/** Method and limits, as a section. */
export function methodSection(distance = null){
  const A = AUDIT, road = usesRoads(distance), mapName = road ? distance.map : '', start = fmtClock(A.SHIFT_START_MIN), end = fmtClock(A.DEFAULT_END_MIN);
  return { title: 'Method and limits', method: true, blocks: [
    { t: 'h3', text: 'How each number is worked out' },
    { t: 'list', ordered: true, items: [
      'Every log with the status installed, unable to install, visited or unaccounted counts as an order.',
      'Land or boat work is decided by the date, not by a tag on the log.',
      'Logs are grouped by calendar day and put in time order.',
      (road ? 'A gap is the time from one log to the next on the same day, with the distance between the two pins by road: '
          + `the shortest drive on the offline road map on this device (${mapName}). A gap that map cannot reach is measured in a straight line. `
        : 'A gap is the time from one log to the next on the same day, with the straight line distance between the two pins. ')
        + 'Gaps are sorted into seven kinds by that distance, from next door (under 60 m) to over 10 km.',
      'The usual time for a kind is this installer\'s own median gap of that kind, over all their work to date in the chosen work mode. '
        + `A kind with fewer than ${A.MIN_KIND_GAPS} gaps, and a gap beside a log with no pin, is compared with the median of every gap.`,
      `A gap ${A.PAUSE_OVER_MIN} minutes or more over its usual time is a pause, and the excess is its length. A smaller overrun stays work.`,
      'A delay is entered against an order and filed under the gap before that order\'s log. It is taken off that gap\'s pause, never below zero. '
        + 'What that gap did not run over is taken off the gap after the same order, because the time is often lost after the log is saved. '
        + 'It goes one gap and no further. Travel, break and lunch entries are not taken off.',
      'A break or lunch entered against a gap is placed on it the same way, after the delays: its own gap first, then the gap after the same order. '
        + 'It is not a delay. It is shown as a logged break and compared with the break allowance.',
      'What is left is unlogged pause time: nothing was logged against it. The typical day is the median of the daily totals.',
      'Working time is the gaps with each pause cut back to the usual time, so first-to-last-meter time is working time plus all pause time.',
      'A logged delay is placed before the first meter, between meters or after the last meter by the times in its entry. One with no times is "without a time of day".',
      `From ${A.FIRST_ORDER_FROM} a delay entered on the first order counts at that order and is taken off the gap after it. `
        + 'Before that date the first order was the only place to enter the morning\'s delay, so on those days it reads as before the first meter.',
      `The shift starts at ${start}. The day ends at the time set at close-out, at ${end} when the day was never closed out, `
        + 'or at the last meter when that is later. "Before the first meter, not logged" is the first meter less the start less the delay logged before it. '
        + '"Close-out and drive home" is the end of the day less the last meter.',
      `Per-day statistics use only days with ${A.MIN_ORDERS} or more orders. Shorter days are listed and can be opened.`,
      `A single gap is marked as a long gap when its unlogged pause is ${A.FLAG_MIN} minutes or more. That is the time over the usual for the stop, less any delay or break logged against it, so a ${A.FLAG_MIN}-minute gap is not by itself a long gap.`,
      `The break allowance is ${A.BREAK_ALLOWANCE_MIN} minutes a day: two 15-minute breaks and a 30-minute lunch. Breaks and lunch that are logged are compared with it.`,
      'The expected number of orders for a day is worked out from that day\'s own time and route. Take the time from first to last meter, '
        + 'less delay logged against those gaps (no more of a gap than it ran over). Take the share of it that a typical full day spends at the usual pace, '
        + 'which is the same gaps at their usual times divided by that time. Divide by the usual minutes per order on that day\'s route and add the first order. '
        + `The typical full day is the median of the days with ${A.MIN_ORDERS} or more orders. Orders further apart, or a shorter day, expect fewer orders.`,
    ] },
    { t: 'h3', text: 'What the data cannot show' },
    { t: 'list', ordered: false, items: [
      'It cannot separate a break from an unlogged delay. Both are a gap that ran long with nothing logged against it. A break only reads as a break when it was logged, '
        + 'so a day from before breaks were logged shows more unlogged pause than the same work would now.',
      'The comparison is with the installer\'s own usual pace, not a company standard and not another installer. A stop that took longer because the job was harder counts as a pause.',
      'A log records one moment per order, when the entry is saved. Arrival and departure are not recorded, so the first installation and the drive to it sit before the first log.',
      `The start is the ${start} rule and the end is the time recorded at close-out. Neither was checked against anything.`,
      road ? 'Distances are the shortest drive between pins on the offline road map, not the drive that was taken, and a straight line where that map does not reach. '
          + 'A device without that road map measures every gap in a straight line, so its figures differ.'
        : 'Distances are straight lines between pins. The route map joins the pins with straight lines too: it is the order worked, not the roads driven. '
          + 'With an offline road map on the device (Settings on the log page) they are measured by road instead.',
      'Logged delays are as entered. Reading morning dispatch as the drive to the first order is how the installer says it is used.',
      `The ${A.PAUSE_OVER_MIN}-minute threshold, the ${A.FLAG_MIN}-minute flag and the ${A.MIN_ORDERS}-order rule are choices.`,
      'On Boat and All: the pause method was only checked against land work.',
      'The expected number of orders is the installer\'s own usual pace applied to the route that was logged. It cannot see orders that were never given out, '
        + 'and it does not judge when the first and last meters were logged. A job that took longer at a stop counts against the pace like any other long gap. '
        + 'It is a yardstick: the day view says how close it has been on the full days to date.',
      'Drive logs exist only for the days and phones where tracking was switched on, and only while the app was in front. Average speed includes slow movement while parked.',
    ] }] };
}
/** Method and limits: closed until opened, open in print. */
export function methodHtml(distance){
  const s = methodSection(distance);
  return `<details class="au-method"><summary>${esc(s.title)}</summary>${blocksHtml(s.blocks)}</details>`;
}

/** The period view: eight sections in the order the owner approved. Empty when
 *  the view holds no days at all (the note above the audit says so). */
export function periodSections(p, prep){
  if(!p || !p.days) return [];
  return [headlineSection(p), barSection(p), pauseSection(p), monthSection(p), categorySection(p),
    outputSection(p, prep), dailySection(p), methodSection(prep.distance)];
}
export function periodHtml(p, prep){ return sectionsHtml(periodSections(p, prep)); }

// ── one day ──────────────────────────────────────────────────────────────────
const STATUS_LABEL = { INSTALLED: 'Installed', UTI: 'UTI', VISITED: 'Visited', UNACCOUNTED: 'Unaccounted' };
const metres = km => !isNum(km) ? 'not known (no pin)' : km < 1 ? Math.round(km * 1000) + ' m' : n1(km) + ' km';
const logName = (day, i) => `#${i + 1} ${day.logs[i].workOrderId || 'no order number'}`;

// What the installer wrote about an order: the UTI reason, then the note.
const noteOf = l => [l.status === 'UTI' ? l.utiReason : '', l.note].filter((t, i, all) => t && all.indexOf(t) === i).join(' - ');
const woOf = l => l.workOrderId || 'no order number';
const noteLine = l => (l.status === 'UTI' ? 'UTI: ' : 'Note: ') + noteOf(l);

// The day in six numbers, and the comment typed at End of day. "Usually" is the 30
// worked days before. The caption is the owner's condition for showing an expected
// number at all: whose pace it is, that it is not a target, how close it has been.
function glanceSection({ day, pace, baselines }){
  const b = baselines.last30, usually = text => (b.days ? `, usually ${text}` : '');
  const typ = pace.typical, count = st => day.logs.filter(l => l.status === st).length;
  const uti = count('UTI'), installed = count('INSTALLED'), other = day.n - uti - installed;
  const made = [`${installed} installed`, uti ? `${uti} UTI` : '', other ? plural(other, 'other visit', 'other visits') : ''].filter(Boolean).join(', ');
  const drive = day.log.dispatchBefore;
  const items = [
    [String(day.n), `${day.n === 1 ? 'order' : 'orders'} (${made})${usually(n0(b.ordersAvg))}`],
    !pace.gaps ? ['—', 'expected: one order is no route to pace']
      : pace.expected == null ? ['—', 'expected: no full day yet to compare with']
      : [pace.diff > 0 ? `${pace.diff} over` : pace.diff < 0 ? `${-pace.diff} under` : 'Level', `against ${pace.expected} expected on this route`],
    [day.n > 1 ? `${fmtClock(day.firstMin)}–${fmtClock(day.lastMin)}` : fmtClock(day.firstMin),
      (day.n > 1 ? 'first to last meter' : 'the only meter') + usually(`${fmtClock(b.firstAvg)}–${fmtClock(b.lastAvg)}`)],
    [fmtDur(day.log.total), `delays logged${drive > 0 ? `, ${fmtMin(drive)} min of it the drive to the first order` : ''}${usually(fmtDur(b.loggedAvg))}`],
    [mins(day.log.breaks), `break and lunch logged, of ${AUDIT.BREAK_ALLOWANCE_MIN} allowed`],
    [mins(day.pauseUnMin), `pauses with nothing logged (may include breaks)${usually(mins(b.pauseMedian))}`],
  ];
  const cap = [];
  if(pace.gaps && pace.expected != null) cap.push('Expected is this installer\'s own usual pace on this route, not a target. Half of full days land '
    + (typ.miss > 0 ? `within ${plural(typ.miss, 'order', 'orders')} of it.` : 'exactly on it.'));
  if(b.days) cap.push(`Usually means the ${plural(b.days, 'worked day', 'worked days')} before.`);
  return { title: 'The day at a glance', blocks: [{ t: 'tiles', per: 3, items },
    ...(day.comment ? [{ t: 'quote', label: 'Comment for the day', text: day.comment }] : []),
    ...(cap.length ? [{ t: 'cap', text: cap.join(' ') }] : [])] };
}

function timelineSection(day, forPage){
  return { title: 'Timeline of the day', blocks: [{ t: 'timeline', day },
    { t: 'legend', keys: timelineBlocks(day).map(b => b.key), short: true },
    ...(day.gaps.length ? [{ t: 'cap', screenOnly: true, text: 'Tap a block, or a row below, for its details.' }] : []),
    ...(forPage ? [{ t: 'slot', id: 'auGapDetail' }] : [])] };
}

// Where the time went: one row for each gap that ran long or had something entered on
// it, with the order logged at its end, what was entered, and what the installer wrote.
// A delay can be counted one gap after the one it was entered on (compute/audit.js);
// the row it was counted in says which order it came from.
//
// `told` is the orders whose note is already here, so the order list does not repeat it.
// A note belongs to its own order's row. A gap that ran long also takes the note of the
// order it FOLLOWS when that order has no row: log the meter, then the truck will not
// start, is written on the order already logged.
function timeRows(day){
  const rows = [], told = new Set(), entries = [...day.delays, ...(day.breaks || [])];
  const name = d => (d.driveToFirst ? 'Dispatch (drive to the first order)' : d.label);
  const logged = list => { const by = new Map();
    for(const d of list) by.set(name(d), (by.get(name(d)) || 0) + d.minutes);
    return [...by].map(([label, min]) => `${label} ${fmtMin(min)}`); };
  const words = list => list.filter(d => d.comment).map(d => `${name(d)}: ${d.comment}`);
  const own = l => { const i = day.logs.indexOf(l); told.add(i); return noteOf(l) ? [noteLine(l)] : []; };
  const add = (cells, notes, gap = null) => rows.push({ cells, notes, gap, ...(gap == null ? {} : { cls: 'au-logrow' }) });
  const where = w => entries.filter(d => d.where === w);

  const before = where('before'), onFirst = entries.filter(d => d.onFirst);
  if(before.length) add(['Before first meter', '', '', logged(before).join(', ')], words(before));
  if(onFirst.length) add([day.logs[0].clock, woOf(day.logs[0]), '', logged(onFirst).join(', ')], [...own(day.logs[0]), ...words(onFirst)]);
  for(const g of day.gaps){
    const here = entries.filter(d => !d.onFirst && d.gap === g.i);
    if(!g.isPause && !here.length) continue;
    const a = day.logs[g.i], b = day.logs[g.i + 1], said = logged(here), left = Math.round(g.unloggedMin);
    if(Math.round(g.carriedMin) > 0) said.push(`${fmtMin(g.carriedMin)} from the delay on ${woOf(a)}`);
    if(Math.round(g.breakCarriedMin) > 0) said.push(`${fmtMin(g.breakCarriedMin)} from the break on ${woOf(a)}`);
    if(g.isPause && left > 0) said.push(said.length ? `${left} not logged` : 'Nothing logged');
    const follows = g.isPause && !told.has(g.i) && noteOf(a) ? [`${woOf(a)}, ${noteLine(a)}`] : [];
    if(follows.length) told.add(g.i);
    add([`${fmtClock(Math.floor(g.atMin))}–${fmtClock(Math.floor(g.atMin + g.min))}`, woOf(b),
      g.isPause ? `+${fmtMin(g.over)}` : '', { text: said.join(', '), flag: g.flagged ? 'long gap' : '' }],
      [...follows, ...own(b), ...words(here)], g.i);
  }
  // entered between meters on a gap that no longer exists (an order was removed since)
  for(const d of entries.filter(x => x.where === 'between' && !x.onFirst && x.gap == null))
    add([`${fmtClock(d.fromMin)}–${fmtClock(d.toMin)}`, d.workOrderId || '', '', logged([d]).join('')], words([d]));
  const after = where('after');
  if(after.length) add(['After last meter', '', '', logged(after).join(', ')], words(after));
  for(const d of where('untimed')) add(['No time given', d.workOrderId || '', '', logged([d]).join('')], words([d]));
  return { rows, told };
}

function timeSection(day){
  const { rows } = timeRows(day);
  return { title: 'Where the time went', blocks: [
    rows.length ? { t: 'table', cls: 'au-time', flex: 3, head: ['Time', 'Order', 'Over usual', 'Logged (min)'], align: ['l', 'l', 'r', 'l'], rows }
      : { t: 'empty', text: 'No delay or break was logged, and no stop ran long.' },
    ...(rows.length ? [{ t: 'cap', text: 'The order is the one logged at the end of that time. Over usual is minutes past the usual time for that stop.' }] : []),
    ...(day.log.travel ? [{ t: 'cap', text: `Travel entered: ${fmtMin(day.log.travel)} min. It is not a delay.` }] : [])] };
}

// How the expected number was reached (compute/audit.js dayPace), in the day's own
// numbers: the arithmetic, how close it has been on this installer's full days, and what
// it cannot see. "Expected" is never called a target.
function paceSection({ pace, distance }){
  const title = 'How the expected number was worked out', closed = { title, method: true, pageOnly: true };
  if(!pace.gaps) return { ...closed, blocks: [{ t: 'empty', text: 'Only one order was logged, so there is no route to pace.' }] };
  const typ = pace.typical;
  const of = f => typ ? f(typ) : '—';
  const caps = [];
  if(pace.expected == null){
    caps.push(`No day with ${AUDIT.MIN_ORDERS} or more orders yet, so there is no typical day to expect a number from.`);
  } else {
    caps.push(`Expected: ${fmtMin(pace.tookMin)} min from first to last meter`
      + (pace.loggedMin > 0 ? `, less ${fmtMin(pace.loggedMin)} min of delay logged against those gaps, is ${fmtMin(pace.ownMin)} min. ` : '. ')
      + `On a typical full day ${share(typ.share)} of that time is at the usual pace, and the rest is breaks, lunch and stops that ran long. `
      + `That is ${fmtMin(pace.atPaceMin)} min. `
      + `At this route's ${n1(pace.perOrder)} usual min per order it is ${plural(pace.expected - 1, 'order', 'orders')} after the first: ${pace.expected}.`);
    caps.push('On the full days to date, half land '
      + (typ.miss > 0 ? `within ${plural(typ.miss, 'order', 'orders')} of` : 'exactly on') + ' their expected number.');
  }
  caps.push('Expected is not a target. It is this installer\'s own usual pace, the usual time for each distance between orders over all '
    + 'their work to date in this work mode, applied to the route that was logged and the time between the first and last meter. '
    + 'It does not judge when those two meters were logged; the next table has that. It cannot see orders that were never given out, '
    + 'and a job that took longer at a stop counts against the pace like any other long gap. '
    + `The right-hand column is over the days with ${AUDIT.MIN_ORDERS} or more orders, in minutes unless the row says otherwise.`);
  caps.push(...distanceNote(distance).map(n => n.text));
  return { ...closed, blocks: [
    { t: 'table', head: ['', 'This day', `Full days to date (${plural(typ ? typ.days : 0, 'day', 'days')})`],
      rows: [
        ['Usual minutes per order on the route (median)', n1(pace.perOrder), of(t => n1(t.perOrder))],
        [`Distance between orders, ${usesRoads(distance) ? 'by road' : 'straight line'}, km (median)`, n1(pace.km), of(t => n1(t.km))],
        ['First to last meter, less delay logged against those gaps (median)', fmtMin(pace.ownMin), of(t => fmtMin(t.ownMin))],
        ['The same gaps at the usual pace (median)', fmtMin(pace.usualMin), of(t => fmtMin(t.routeMin))],
        ['Share of that time at the usual pace (median)', share(pace.share), of(t => share(t.share))],
      ] },
    ...caps.map(text => ({ t: 'cap', text }))] };
}

function compareSection({ day, baselines }){
  const b30 = baselines.last30, all = baselines.all;
  const count = v => isNum(v) ? (Number.isInteger(v) ? String(v) : n1(v)) : '—';
  const row = (label, f, a, b, c) => [label, f(a), f(b), f(c)];
  return { title: 'This day, and how it compares', method: true, pageOnly: true, blocks: [{ t: 'table',
    head: ['', 'This day', `30 worked days before (${plural(b30.days, 'day', 'days')})`, `All to date (${plural(all.days, 'day', 'days')})`],
    rows: [
      row('Orders (average)', count, day.n, b30.ordersAvg, all.ordersAvg),
      row('First meter (average)', fmtClock, day.firstMin, b30.firstAvg, all.firstAvg),
      row('Last meter (average)', fmtClock, day.lastMin, b30.lastAvg, all.lastAvg),
      row('Delay logged before the first meter (average)', fmtMin, day.log.before, b30.loggedBeforeAvg, all.loggedBeforeAvg),
      row('Delay logged between meters (average)', fmtMin, day.log.between, b30.loggedBetweenAvg, all.loggedBetweenAvg),
      row('Break and lunch logged (average)', fmtMin, day.log.breaks, b30.breakAvg, all.breakAvg),
      row('Unlogged pause (median)', fmtMin, day.pauseUnMin, b30.pauseMedian, all.pauseMedian),
      ['Longest pause (median)', longest(day.longestMin, day.longestAtMin, day.longestWo),
        fmtMin(b30.longestMedian), fmtMin(all.longestMedian)],
    ] },
    { t: 'cap', text: `Minutes, and clock times. The two right-hand columns are over days with ${AUDIT.MIN_ORDERS} or more orders: `
      + 'the worked days just before this one, and all work to date in this work mode. '
      + 'Each of those uses the figure named in its row. The first column is simply this day.' }] };
}

function delaysSection(day){
  const span = d => `${fmtClock(d.fromMin)}–${fmtClock(d.toMin)}`;
  // The phone's two cards for downtime on no order write a fixed clock (00:00 and
  // 23:59), which is a filing key and not a time anything happened: do not print it.
  const noOrder = d => d.fromMin === d.toMin && (d.toMin === 0 || d.toMin === 1439);
  const wo = d => { const l = d.gap == null ? null : day.logs[d.gap + 1]; return l && l.workOrderId ? ` (${l.workOrderId})` : ''; };
  const against = d => d.where === 'untimed' ? 'no time of day'
    : d.where === 'before' ? (noOrder(d) ? 'before the first meter' : `${span(d)}, before the first meter`)
    : d.where === 'after' ? (noOrder(d) ? 'after the last meter' : `${span(d)}, after the last meter`)
    // entered on the first order, which has no gap before it
    : d.onFirst ? 'the first order' + (d.carriedTo
      ? `, counted in the gap after it (${fmtClock(d.carriedTo.fromMin)}–${fmtClock(d.carriedTo.toMin)})` : '')
    // entered on an order, filed under the gap before its log, counted where the time was lost
    : d.carriedTo ? `${span(d)}${wo(d)}, counted in the gap after it (${fmtClock(d.carriedTo.fromMin)}–${fmtClock(d.carriedTo.toMin)})` : span(d) + wo(d);
  // Breaks and lunch are listed apart: they are not delays, and they are compared
  // with the allowance. `placed` is how much of what was entered sits on a gap.
  const placed = day.pauseBreakMin || 0, breaks = day.breaks || [];
  return { title: 'Delays and breaks, as entered', method: true, pageOnly: true, blocks: [
    day.delays.length
      ? { t: 'table', head: ['Category', 'Minutes', 'Logged against'], rows: day.delays.map(d =>
          [d.driveToFirst ? 'Dispatch (drive to the first order)' : d.label, fmtMin(d.minutes), against(d)]) }
      : { t: 'empty', text: 'No delay was logged this day.' },
    ...(breaks.length ? [
      { t: 'h3', text: 'Breaks and lunch logged' },
      { t: 'table', head: ['Entry', 'Minutes', 'Logged against'], rows: breaks.map(d => [d.label, fmtMin(d.minutes), against(d)]) },
      { t: 'cap', text: `${fmtMin(day.log.breaks)} min of breaks or lunch, against an allowance of ${AUDIT.BREAK_ALLOWANCE_MIN} min. `
        + (placed + 0.5 < day.log.breaks ? `${fmtMin(placed)} min of it sits on a gap that ran long; the rest is on no gap. ` : '')
        + 'These are not delays: they are shown on the timeline as logged breaks.' }] : []),
    ...(day.log.travel ? [{ t: 'cap', text: `Also entered: ${fmtMin(day.log.travel)} min of travel. It is not a delay and is not taken off any pause.` }] : [])] };
}

function logsSection(day){
  const { told } = timeRows(day);
  return { title: 'Every order', blocks: [{ t: 'table', cls: 'au-logs', dense: true,
    head: ['#', 'Time', 'Order', 'Status', 'Min since last', 'Over usual'], align: ['l', 'l', 'l', 'l', 'r', 'r'],
    rows: day.logs.map((l, i) => {
      const g = i ? day.gaps[i - 1] : null, label = STATUS_LABEL[l.status] || l.status;
      const reason = l.status === 'UTI' && l.utiReason ? l.utiReason : '';
      return { cls: 'au-logrow', gap: g ? g.i : null, notes: !told.has(i) && l.note && l.note !== reason ? [`Note: ${l.note}`] : [],
        cells: [i + 1, l.clock, { text: l.workOrderId || '—', tag: l.pin ? '' : 'no pin' }, reason ? `${label}: ${reason}` : label,
          g ? fmtMin(g.min) : '—', g && g.isPause ? { text: `+${fmtMin(g.over)}`, flag: g.flagged ? 'long gap' : '' } : ''] };
    }) }] };
}

/** A day, as sections: what sits above the route map, what sits below it, and the
 *  closed sections that say how the figures were worked out (the page only).
 *  `forPage` adds the empty slot the page opens a gap's detail in. `detail` is
 *  dayDetail()'s result. */
export function daySections(detail, { forPage = false } = {}){
  const day = detail.day;
  return { top: [glanceSection(detail), timelineSection(day, forPage), timeSection(day)],
    bottom: [logsSection(day)],
    details: [paceSection(detail), compareSection(detail), delaysSection(day), { ...methodSection(detail.distance), pageOnly: true }] };
}
export function dayTopHtml(detail){ return sectionsHtml(daySections(detail, { forPage: true }).top); }
/** The order list, and under it the closed sections when given the whole detail. */
export function dayLogsHtml(day, detail = null){
  return sectionsHtml([logsSection(day), ...(detail ? daySections(detail).details : [])]);
}

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
      [g.byRoad ? 'Distance by road' : day.gaps.some(x => x.byRoad) ? 'Straight-line distance (off the road map)' : 'Straight-line distance', metres(g.km)],
      [`Usual time for ${kind}`, n1(g.usual) + ' min'],
      ['Over the usual time', g.over > 0 ? mins(g.over) : 'none'],
      ['Logged against this gap', mins(g.loggedMin)],
      ...(g.carriedOutMin > 0 ? [['Of that, counted in the gap after', mins(g.carriedOutMin)]] : []),
      ...(g.carriedMin > 0 ? [['Logged against the order before, counted here', mins(g.carriedMin)]] : []),
      ...(g.breakMin > 0 ? [['Logged as a break or lunch, counted here', mins(g.breakMin)]] : []),
      g.isPause ? ['Not logged', { text: mins(g.unloggedMin), flag: g.flagged ? 'long gap' : '' }]
        : ['Read as', `work (under ${AUDIT.PAUSE_OVER_MIN} minutes over)`],
    ] })
    + [a, b].filter(l => noteOf(l)).map(l => blockHtml({ t: 'quote', label: woOf(l), text: noteOf(l) })).join('') + '</div>';
}

/** The one line of drive-log numbers; '' with no legs. `s` = driveStats()'s result.
 *  The PDF is handed to other people and leaves the speeds out. */
export function driveLineHtml(s, { speeds = true } = {}){
  if(!s) return '';
  if(!speeds) return `${n1(s.km)} km driven · ${fmtDur(s.driveMin)} driving`;
  return `Top ${fmtMin(s.topKmh)} km/h · average ${fmtMin(s.avgKmh)} km/h · ${n1(s.km)} km · `
    + `${fmtDur(s.driveMin)} driving · ${plural(s.legs, 'leg', 'legs')}`;
}
