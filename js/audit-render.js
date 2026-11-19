// ── What the Audits pages say, as HTML strings ───────────────────────────────
// Pure: takes the numbers from js/compute/audit.js and returns markup. No DOM, no
// fetch, so node can read what a view says (tests/audit-pages.test.mjs). The
// wiring (controls, the address bar, the map) is js/audit-view.js.
//
// Wording rules, all the owner's:
//   • An unlogged pause is "unlogged pause time, breaks included". The data cannot
//     tell a break from an unlogged delay and the page must not pretend it can.
//   • Dispatch logged before the first meter is "the drive to the first order".
//     His word was "usually", so the label names what was logged and no more.
//   • The time after the last meter is "close-out and drive home". The crew goes
//     home from the field; no label may send them anywhere else.
//   • A figure that rests on no days prints as a dash. Never invent one.
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

const card = (title, body, cls = '') =>
  `<section class="card au-card${cls ? ' ' + cls : ''}"><h2>${esc(title)}</h2>${body}</section>`;
const table = (head, rows, cls = '') => `<div class="au-scroll"><table class="au-table${cls ? ' ' + cls : ''}">`
  + `<thead><tr>${head.map((h, i) => `<th${i ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>`
  + `<tbody>${rows.join('')}</tbody></table></div>`;
const tr = cells => '<tr>' + cells.map((c, i) => `<td${i ? ' class="n"' : ''}>${c}</td>`).join('') + '</tr>';
const pair = (label, value) => `<tr><td>${esc(label)}</td><td class="n">${value}</td></tr>`;
const pairs = rows => `<table class="au-table au-pairs"><tbody>${rows.join('')}</tbody></table>`;
const cap = text => `<p class="au-cap">${text}</p>`;

/** The lines above the audit: the empty state, what the statistics rest on, and
 *  the warning on Boat and All. `name` is the installer's display name. */
export function notesHtml({ prep, stats, name }){
  const out = [];
  if(prep.mode !== 'land')
    out.push('<p class="au-note warn">The pause figures were checked against land work only.</p>');
  if(!stats.days){
    out.push(`<p class="au-note">No logs for ${esc(name)} in this view.</p>`);
    if(prep.skippedOtherMode)
      out.push(`<p class="au-note">${plural(prep.skippedOtherMode, 'log is', 'logs are')} in the other work mode.</p>`);
    return out.join('');
  }
  out.push(`<p class="au-note">Statistics use the ${plural(stats.fullDays, 'day', 'days')} with `
    + `${AUDIT.MIN_ORDERS} or more orders, of ${plural(stats.days, 'day', 'days')}.</p>`);
  return out.join('');
}

function headlineCard(p){
  const h = p.headline;
  const tile = (n, t) => `<div class="au-tile"><b>${n}</b><span>${t}</span></div>`;
  return card('Headline', '<div class="au-tiles">'
    + tile(n0(p.orders), `orders logged on ${plural(p.days, 'working day', 'working days')}`)
    + tile(n1(h.ordersAvg), `orders a day on average${isNum(h.ordersBest) ? ` (best day ${h.ordersBest})` : ''}`)
    + tile(mins(h.pauseMedian), 'unlogged pause time between meters on a typical day, breaks included')
    + tile(mins(h.loggedAvg), `delay logged per day${isNum(h.loggedBeforeShare) ? `, ${share(h.loggedBeforeShare)} of all logged delay falls before the first meter` : ''}`)
    + '</div>');
}

function barCard(p){
  if(!p.bar) return card('Where an average day goes',
    `<p class="au-empty">No day with ${AUDIT.MIN_ORDERS} or more orders in this view, so there is no average day to draw.</p>`);
  return card('Where an average day goes', dayBarHtml(p.bar) + legendHtml()
    + cap('Minutes of an average day, from the start of the shift to the end of the day. Averages are used here so '
      + 'the parts add up to the whole day; the typical-day (median) figures elsewhere on this page run a little lower. '
      + 'A log is written when a job is finished, so the first installation sits inside "Before the first meter, not logged". '
      + 'The last block is the time from the last meter log to the end of the day. Nothing in the log says how it was spent.'));
}

function pauseCard(p){
  const s = p.pause;
  const range = (a, b) => isNum(a) && isNum(b) ? `${fmtMin(a)} to ${fmtMin(b)} min` : '—';
  const rows = [
    pair('Typical day (median)', mins(s.median)),
    pair('Average', mins(s.avg)),
    pair('Middle half of days', range(s.p25, s.p75)),
    pair('Lowest tenth of days, up to', mins(s.p10)),
    pair('Highest tenth of days, from', mins(s.p90)),
    pair(`Days under ${AUDIT.BREAK_ALLOWANCE_MIN} min`, `${s.under60} of ${p.fullDays}`),
    pair('Days at 90 min or more', `${s.over90} of ${p.fullDays}`),
    pair('Pauses a day', n1(s.perDay)),
    pair('Typical longest pause', isNum(s.longestMedian)
      ? `${fmtMin(s.longestMedian)} min, starting around ${fmtClock(s.longestAtMedian)}` : '—'),
    pair('Before logged delays are taken off', isNum(s.allMedian)
      ? `median ${fmtMin(s.allMedian)}, average ${fmtMin(s.allAvg)} min` : '—'),
    pair(`Long gaps (${AUDIT.FLAG_MIN}+ min, nothing logged)`,
      `${s.flags} on ${plural(s.flagDays, 'day', 'days')}`),
  ];
  return card('Unlogged pause time per day', '<div class="au-two"><div>'
    + (p.fullDays ? pauseHistogramHtml(s.bins, AUDIT.BREAK_ALLOWANCE_MIN) : '<p class="au-empty">No full days to chart.</p>')
    + '</div>' + pairs(rows) + '</div>'
    + cap(`Time between meters that is neither the usual time for the stop nor a logged delay. It includes breaks and lunch `
      + `(the allowance is ${AUDIT.BREAK_ALLOWANCE_MIN} minutes a day), delays that were not logged, and stops that simply took longer than usual. `
      + 'The data cannot tell these apart.'));
}

function monthCard(p){
  if(!p.months.length) return card('By month', '<p class="au-empty">No full days in this view.</p>');
  return card('By month', table(
    ['Month', 'Days', 'Orders a day', 'First meter', 'Last meter', 'Min per order', 'Unlogged pause (median)', 'Logged delay (average)'],
    p.months.map(m => tr([esc(monthName(m.month)), m.days, n1(m.ordersAvg), fmtClock(m.firstAvg), fmtClock(m.lastAvg),
      n1(m.perOrder), fmtMin(m.pauseMedian), fmtMin(m.loggedAvg)])))
    + cap('Minutes per order is the time from the first to the last meter over the orders after the first, so pauses are in it.'));
}

function categoryCard(p){
  const l = p.loggedPerDay;
  const cats = !p.categories.length ? '<p class="au-empty">No delay was logged in this view.</p>' : table(
    ['Category', 'Minutes', 'Share', 'Days logged', 'Before the first meter', 'Between meters'],
    p.categories.map(c => tr([esc(c.label), n0(c.minutes), share(c.share), c.days, share(c.beforeShare), share(c.betweenShare)])))
    + cap('Every day in the period, short days included. Travel, break and lunch entries are left out.');
  const perDay = pairs([
    pair('Before the first meter', mins(l.before)),
    pair('  of which dispatch (the drive to the first order)', mins(l.dispatchBefore)),
    pair('  of which all other delays', mins(l.otherBefore)),
    pair('Between meters', mins(l.between)),
    pair('Logged without a time of day', mins(l.untimed)),
    ...(isNum(l.after) && l.after > 0 ? [pair('After the last meter', mins(l.after))] : []),
    pair('Total', mins(l.total)),
  ]);
  return card('Logged delays by category', cats + '<h3>Logged delay per day (average)</h3>' + perDay);
}

function outputCard(p, prep){
  const o = p.output;
  const rows = [
    pair('Orders a day, average', n1(o.ordersAvg)),
    pair('Orders a day, typical (median)', n0(o.ordersMedian)),
    pair('Slowest tenth of days, up to', n0(o.ordersP10)),
    pair('Best tenth of days, from', n0(o.ordersP90)),
    pair('Best day', n0(o.ordersBest)),
    pair('First meter, average', fmtClock(o.firstAvg)),
    pair('First meter, middle half of days', isNum(o.firstP25) ? `${fmtClock(o.firstP25)} to ${fmtClock(o.firstP75)}` : '—'),
    pair('Last meter, average', fmtClock(o.lastAvg)),
    pair('First to last meter, average', mins(o.spanAvg)),
    pair('Of that, working', mins(o.workAvg)),
    pair('Minutes per order', n1(o.perOrder)),
    pair('Installed', n0(p.status.installed)),
    pair('Unable to install', n0(p.status.uti)),
    pair('Other visits', n0(p.status.other)),
  ];
  const usual = table(['Distance to the next order', 'Usual time (median)', 'Gaps'],
    p.usual.map(u => tr([esc(u.label), isNum(u.median) ? n1(u.median) + ' min' : '—',
      u.count + (u.count < AUDIT.MIN_KIND_GAPS && isNum(u.median) ? ' *' : '')])));
  const few = p.usual.some(u => u.count < AUDIT.MIN_KIND_GAPS && isNum(u.median));
  return card('Output', pairs(rows)
    + '<h3>The usual time between two logs, by distance</h3>' + usual
    + cap(`From ${n0(p.gapsCount)} gaps, over all ${esc(MODE_WORK[prep.mode] || 'work')} to date, whatever period is shown.`
      + (isNum(p.nextDoorShare) ? ` ${share(p.nextDoorShare)} of gaps are next door.` : '')
      + (few ? ` * Fewer than ${AUDIT.MIN_KIND_GAPS} gaps of this kind: the usual time over every gap is used.` : '')
      + (p.unpinned ? ` ${plural(p.unpinned, 'log has', 'logs have')} no pin in this period; a gap beside one is compared with the usual time over every gap.` : '')));
}

function dailyCard(p){
  const rows = p.daily.slice().reverse().map(d => {
    const tags = (d.flags ? ` <span class="au-flag">${plural(d.flags, 'long gap', 'long gaps')}</span>` : '')
      + (d.qualifies ? '' : ` <span class="au-tag">under ${AUDIT.MIN_ORDERS} orders</span>`);
    return tr([
      `<button type="button" class="au-daybtn" data-day="${attr(d.date)}">${esc(shortDate(d.date))}</button>`,
      d.n, fmtClock(d.firstMin), fmtClock(d.lastMin), fmtMin(d.loggedBefore), fmtMin(d.loggedBetween),
      fmtMin(d.pauseUn) + tags,
      d.longest > 0 ? `${fmtMin(d.longest)} at ${fmtClock(d.longestAt)}` : '—']);
  });
  return card('Day by day', table(
    ['Date', 'Orders', 'First meter', 'Last meter', 'Delay before first meter', 'Delay between meters', 'Unlogged pause', 'Longest pause'],
    rows, 'au-days')
    + cap(`Minutes. Open a day for its timeline and route. A long gap is ${AUDIT.FLAG_MIN} minutes or more with nothing logged against it.`));
}

/** Method and limits: closed until opened, open in print. */
export function methodHtml(){
  const A = AUDIT, start = fmtClock(A.SHIFT_START_MIN), end = fmtClock(A.DEFAULT_END_MIN);
  const li = items => '<ol>' + items.map(t => `<li>${t}</li>`).join('') + '</ol>';
  const ul = items => '<ul>' + items.map(t => `<li>${t}</li>`).join('') + '</ul>';
  return '<details class="au-method"><summary>Method and limits</summary>'
    + '<h3>How each number is worked out</h3>'
    + li([
      'Every log with the status installed, unable to install, visited or unaccounted counts as an order.',
      'Land or boat work is decided by the date, not by a tag on the log.',
      'Logs are grouped by calendar day and put in time order.',
      'A gap is the time from one log to the next on the same day, with the straight line distance between the two pins. '
        + 'Gaps are sorted into seven kinds by that distance, from next door (under 60 m) to over 10 km.',
      `The usual time for a kind is this installer's own median gap of that kind, over all their work to date in the chosen work mode. `
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
      `A single gap is marked as a long gap when ${A.FLAG_MIN} minutes or more of it has nothing logged against it.`,
      `The break allowance is ${A.BREAK_ALLOWANCE_MIN} minutes a day: two 15-minute breaks and a 30-minute lunch.`,
    ])
    + '<h3>What the data cannot show</h3>'
    + ul([
      'It cannot separate a break from an unlogged delay. Both are a gap that ran long with nothing logged against it.',
      'The comparison is with the installer\'s own usual pace, not a company standard and not another installer. A stop that took longer because the job was harder counts as a pause.',
      'A log records one moment per order, when the entry is saved. Arrival and departure are not recorded, so the first installation and the drive to it sit before the first log.',
      `The start is the ${start} rule and the end is the time recorded at close-out. Neither was checked against anything.`,
      'Distances are straight lines between pins. The route map joins the pins with straight lines too: it is the order worked, not the roads driven.',
      'Logged delays are as entered. Reading morning dispatch as the drive to the first order is how the installer says it is used.',
      `The ${A.PAUSE_OVER_MIN}-minute threshold, the ${A.FLAG_MIN}-minute flag and the ${A.MIN_ORDERS}-order rule are choices.`,
      'On Boat and All: the pause method was only checked against land work.',
      'Drive logs exist only for the days and phones where tracking was switched on, and only while the app was in front. Average speed includes slow movement while parked.',
    ])
    + '</details>';
}

/** The period view: eight sections in the order the owner approved. '' when the
 *  view holds no days at all (the note above the audit says so). */
export function periodHtml(p, prep){
  if(!p || !p.days) return '';
  return headlineCard(p) + barCard(p) + pauseCard(p) + monthCard(p) + categoryCard(p)
    + outputCard(p, prep) + dailyCard(p) + `<section class="card au-card">${methodHtml()}</section>`;
}

// ── One day ──────────────────────────────────────────────────────────────────
const STATUS_LABEL = { INSTALLED: 'Installed', UTI: 'UTI', VISITED: 'Visited', UNACCOUNTED: 'Unaccounted' };
const metres = km => !isNum(km) ? 'not known (no pin)' : km < 1 ? Math.round(km * 1000) + ' m' : n1(km) + ' km';
const logName = (day, i) => `#${i + 1} ${esc(day.logs[i].workOrderId || 'no order number')}`;

/** The lines above a day: late, never closed out, left out of the statistics. */
export function dayNotesHtml(day){
  const out = [], end = fmtClock(AUDIT.DEFAULT_END_MIN);
  if(!day.qualifies) out.push(`Left out of the statistics (under ${AUDIT.MIN_ORDERS} orders).`);
  if(day.pastEnd && day.closed) out.push('Worked past the set end time: the day runs to the last meter.');
  if(!day.closed) out.push(day.pastEnd
    ? `Not closed out, and the last meter was after ${end}: the day runs to the last meter.`
    : `Not closed out: ${end} is assumed.`);
  return out.map(t => `<p class="au-note">${t}</p>`).join('');
}

function compareCard({ day, baselines }){
  const b30 = baselines.last30, all = baselines.all;
  const row = (label, f, a, b, c) => tr([esc(label), f(a), f(b), f(c)]);
  const count = v => isNum(v) ? (Number.isInteger(v) ? String(v) : n1(v)) : '—';
  return card('This day, and how it compares', table(
    ['', 'This day', `30 worked days before (${plural(b30.days, 'day', 'days')})`, `All to date (${plural(all.days, 'day', 'days')})`], [
      row('Orders (average)', count, day.n, b30.ordersAvg, all.ordersAvg),
      row('First meter (average)', fmtClock, day.firstMin, b30.firstAvg, all.firstAvg),
      row('Last meter (average)', fmtClock, day.lastMin, b30.lastAvg, all.lastAvg),
      row('Delay logged before the first meter (average)', fmtMin, day.log.before, b30.loggedBeforeAvg, all.loggedBeforeAvg),
      row('Delay logged between meters (average)', fmtMin, day.log.between, b30.loggedBetweenAvg, all.loggedBetweenAvg),
      row('Unlogged pause (median)', fmtMin, day.pauseUnMin, b30.pauseMedian, all.pauseMedian),
      tr(['Longest pause (median)', day.longestMin > 0 ? `${fmtMin(day.longestMin)} at ${fmtClock(day.longestAtMin)}` : '—',
        fmtMin(b30.longestMedian), fmtMin(all.longestMedian)]),
    ])
    + cap(`Minutes, and clock times. The two right-hand columns are over days with ${AUDIT.MIN_ORDERS} or more orders: `
      + 'the worked days just before this one, and all work to date in this work mode. '
      + 'Each of those uses the figure named in its row. The first column is simply this day.'));
}

function delaysCard(day){
  const span = d => `${fmtClock(d.fromMin)}–${fmtClock(d.toMin)}`;
  const against = d => d.where === 'untimed' ? 'no time of day'
    : d.where === 'before' ? `${span(d)}, before the first meter`
    : d.where === 'after' ? `${span(d)}, after the last meter` : span(d);
  const extra = [day.log.breaks ? `${fmtMin(day.log.breaks)} min of breaks or lunch` : '',
    day.log.travel ? `${fmtMin(day.log.travel)} min of travel` : ''].filter(Boolean);
  return card('Delays logged this day', (day.delays.length
    ? table(['Category', 'Minutes', 'Logged against'], day.delays.map(d =>
        tr([esc(d.driveToFirst ? 'Dispatch (drive to the first order)' : d.label), fmtMin(d.minutes), esc(against(d))])))
    : '<p class="au-empty">No delay was logged this day.</p>')
    + (extra.length ? cap(`Also entered: ${extra.join(' and ')}. These are not delays and are not taken off any pause.`) : ''));
}

/** The top of the day view: timeline, comparison, delays. The gap detail opens
 *  inside #auGapDetail. `detail` = dayDetail()'s result. */
export function dayTopHtml(detail){
  const day = detail.day;
  return card('Timeline of the day', timelineHtml(day) + legendHtml()
    + (day.gaps.length ? '<p class="au-cap au-noprint">One block per gap between logs. Pick a block, or a row in the list at the bottom, for its two orders, the distance, the usual time and what was logged against it.</p>' : '')
    + '<div id="auGapDetail"></div>')
    + compareCard(detail) + delaysCard(day);
}

function readAs(g){
  if(!g.isPause) return 'work';
  const over = fmtMin(g.over), un = fmtMin(g.unloggedMin), logged = fmtMin(g.over - g.unloggedMin);
  const flag = g.flagged ? ' <span class="au-flag">long gap</span>' : '';
  if(!(g.unloggedMin > 0)) return `pause ${over}, all logged as a delay`;
  if(!(g.over - g.unloggedMin > 0)) return `pause ${over}, nothing logged${flag}`;
  return `pause ${over}: ${logged} logged as a delay, ${un} not logged${flag}`;
}

/** Every log of the day, in order, each with the gap before it and how it was read. */
export function dayLogsHtml(day){
  const rows = day.logs.map((l, i) => {
    const g = i ? day.gaps[i - 1] : null;
    const cells = [i + 1, esc(l.clock), esc(l.workOrderId || '—') + (l.pin ? '' : ' <span class="au-tag">no pin</span>'),
      esc(STATUS_LABEL[l.status] || l.status), g ? fmtMin(g.min) : '—', g ? n1(g.usual) : '—', g ? readAs(g) : 'first meter'];
    return `<tr class="au-logrow"${g ? ` data-gap="${g.i}"` : ''}>`
      + cells.map((c, k) => `<td${k > 3 && k < 6 ? ' class="n"' : ''}>${c}</td>`).join('') + '</tr>';
  });
  return card('Every log, in order', '<div class="au-scroll"><table class="au-table au-logs"><thead><tr>'
    + ['#', 'Time', 'Order', 'Status'].map(h => `<th>${h}</th>`).join('')
    + '<th class="n">Gap</th><th class="n">Usual</th><th>Read as</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
    + cap(`Gap is the minutes since the log before. Usual is the usual time for that distance. A gap ${AUDIT.PAUSE_OVER_MIN} minutes or more over the usual time is read as a pause.`));
}

/** What opens when a gap is picked. '' when the day has no such gap. */
export function gapDetailHtml(day, i){
  const g = day.gaps[i];
  if(!g) return '';
  const a = day.logs[i], b = day.logs[i + 1];
  const kind = g.kind < 0 ? 'every gap (a pin is missing)' : AUDIT.KIND_LABELS[g.kind];
  const place = l => `${esc(l.clock)}${l.address ? ', ' + esc(l.address) : ''}`;
  return `<div class="au-gap"><b>${logName(day, i)}</b> (${place(a)}) to <b>${logName(day, i + 1)}</b> (${place(b)})`
    + pairs([
      pair('Time between the two logs', mins(g.min)),
      pair('Straight-line distance', metres(g.km)),
      pair(`Usual time for ${kind}`, n1(g.usual) + ' min'),
      pair('Over the usual time', g.over > 0 ? mins(g.over) : 'none'),
      ...(g.isPause ? [pair('Logged against this gap', mins(g.loggedMin)),
        pair('Not logged', mins(g.unloggedMin) + (g.flagged ? ' <span class="au-flag">long gap</span>' : ''))]
        : [pair('Read as', `work (under ${AUDIT.PAUSE_OVER_MIN} minutes over)`)]),
    ]) + '</div>';
}

/** The one line of drive-log numbers; '' with no legs. `s` = driveStats()'s result. */
export function driveLineHtml(s){
  if(!s) return '';
  return `Top ${fmtMin(s.topKmh)} km/h · average ${fmtMin(s.avgKmh)} km/h · ${n1(s.km)} km · `
    + `${fmtDur(s.driveMin)} driving · ${plural(s.legs, 'leg', 'legs')}`;
}
