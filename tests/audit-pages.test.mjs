// The Audits pages: audits.html (office, behind the password) and my-audit.html
// (the installer's own, on the phone). Static checks on the files that are easy
// to break without noticing, plus the HTML the pure render module produces from
// made-up days. Nothing here is a real installer's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { prepareAudit, periodStats, dayDetail } from '../js/compute/audit.js';
import { periodHtml, notesHtml, methodHtml, dayTopHtml, dayLogsHtml, gapDetailHtml, dayNotesHtml,
  driveLineHtml, routeCaption, ROUTE_CAPTION } from '../js/audit-render.js';
import { driveRuns, offMapHtml } from '../js/audit-map.js';
import { encodeTrack } from '../js/drive-track.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const exists = p => existsSync(new URL('../' + p, import.meta.url));
const AUDIT_FILES = ['audits.html', 'my-audit.html', 'css/audits.css', 'js/audit-view.js',
  'js/audit-render.js', 'js/audit-charts.js', 'js/audit-map.js', 'js/audit-pdf.js', 'js/audit-roads.js', 'js/pages/audits.js',
  'js/pages/my-audit.js', 'js/compute/audit.js'].filter(exists);

const pad = n => String(n).padStart(2, '0');
const WHO = 'Pat Example';
function stopsOn(date, clocks){
  return clocks.map((c, i) => ({ id: `${date}-${i}`, timestamp: `${date} ${c}:00`, status: 'INSTALLED',
    workOrderId: String(900000 + i), address: `${i + 1} Main St`, lat: 44 + i * 0.00009, lng: -79 }));
}
const every = (first, count, step = 6) => Array.from({ length: count }, (_, i) => {
  const [h, m] = first.split(':').map(Number), t = h * 60 + m + i * step;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
});
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08'];
const FULL = DATES.flatMap(d => stopsOn(d, every('09:00', 9)));
const LONG = stopsOn('2026-10-01', [...every('09:00', 8), '11:00']);        // one 72-minute pause
const SHORT = stopsOn('2026-10-02', ['10:00', '10:06']);
const DOWN = [{ timestamp: '2026-09-01 12:00:00', category: 'DISPATCH', minutes: 30, note: 'gap 07:30–08:00' }];
const build = (stops, mode = 'land', range = { from: '', to: '' }, downtime = DOWN) => {
  const prep = prepareAudit({ stops, downtime, days: [] }, { installer: WHO, mode });
  return { prep, stats: periodStats(prep, range) };
};

// ── the files ────────────────────────────────────────────────────────────────

test('the office page waits for the login gate and the shared view never does', () => {
  assert.match(read('js/pages/audits.js'), /\nawait requireAdmin\(\);/);
  for(const f of ['js/audit-view.js', 'js/audit-render.js', 'js/audit-charts.js'])
    assert.doesNotMatch(read(f), /admin-auth|driveTracks/, f);
});

test('the audit files stay out of the service worker', () => {
  assert.doesNotMatch(read('sw.js'), /audit/i);
});

test('audits.html uses the vendored Leaflet and no CDN', () => {
  const html = read('audits.html');
  assert.match(html, /css\/vendor\/leaflet\.css/);
  assert.match(html, /<script defer src="js\/vendor\/leaflet\.js"><\/script>/);
  assert.match(html, /<script type="module" src="js\/pages\/audits\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('audits.html carries every id the view binds, and the office dropdown', () => {
  const html = read('audits.html');
  for(const id of ['status', 'statusText', 'auWho', 'auMode', 'auFrom', 'auTo', 'auDay', 'auPrint',
    'auBack', 'auPrev', 'auNext', 'auNote', 'auPeriod', 'auDayView', 'auMap', 'toast', 'navSel'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  for(const mode of ['land', 'boat', 'all']) assert.match(html, new RegExp(`data-mode="${mode}"`));
  assert.match(html, /<option value="audits" selected>Audits<\/option>/);
  for(const v of ['log', 'map', 'analytics', 'teams', 'edit', 'reports', 'planner', 'help'])
    assert.match(html, new RegExp(`<option value="${v}">`), v);
});

test('the view guards every id it binds', () => {
  // A page running new script against older cached markup (or the reverse) must
  // not die on a missing element: every lookup lands in a const that is tested.
  assert.doesNotMatch(read('js/audit-view.js'), /\$\('\w+'\)\s*\./);
});

test('nothing in the audit files says drive back', () => {
  for(const f of AUDIT_FILES) assert.doesNotMatch(read(f), /drive back|return(ed|s|ing)? to the yard/i, f);
});

// ── what the period view says ────────────────────────────────────────────────

test('the period view has its eight sections in order', () => {
  const { prep, stats } = build([...FULL, ...LONG, ...SHORT]);
  const html = periodHtml(stats, prep);
  const heads = [...html.matchAll(/<h2[^>]*>([^<]+)</g)].map(m => m[1].trim());
  assert.deepEqual(heads, ['Headline', 'Where an average day goes', 'Unlogged pause time per day',
    'By month', 'Logged delays by category', 'Output', 'Day by day']);
  assert.ok(html.indexOf('Day by day') < html.indexOf('<summary>Method and limits</summary>'));
  assert.doesNotMatch(html, /NaN|undefined|>null</);
});

test('day rows are buttons carrying their date, newest first, with their tags', () => {
  const { prep, stats } = build([...FULL, ...LONG, ...SHORT]);
  const html = periodHtml(stats, prep);
  const days = [...html.matchAll(/<button type="button" class="au-daybtn" data-day="([\d-]+)"/g)].map(m => m[1]);
  assert.deepEqual(days, ['2026-10-02', '2026-10-01', ...DATES.slice().reverse()]);
  const row = date => html.slice(html.indexOf(`data-day="${date}"`), html.indexOf('</tr>', html.indexOf(`data-day="${date}"`)));
  assert.match(row('2026-10-01'), /1 long gap/);
  assert.doesNotMatch(row('2026-10-01'), /under 8 orders/);
  assert.match(row('2026-10-02'), /under 8 orders/);
  assert.doesNotMatch(row('2026-09-01'), /long gap/);
});

test('a view with no full day draws the day list and no invented figure', () => {
  const { prep, stats } = build(SHORT, 'land', { from: '', to: '' }, []);
  const html = periodHtml(stats, prep);
  assert.match(html, /data-day="2026-10-02"/);
  assert.match(html, /No day with 8 or more orders/);
  assert.doesNotMatch(html, /NaN|undefined|>null</);
  assert.doesNotMatch(html, /au-stack"/);                    // no average-day bar
});

test('the notes say what the statistics rest on, and warn on Boat and All', () => {
  const land = build([...FULL, ...SHORT]);
  const note = notesHtml({ ...land, name: WHO });
  assert.match(note, /Statistics use the 6 days with 8 or more orders, of 7 days\./);
  assert.doesNotMatch(note, /checked against land work only/);
  for(const mode of ['boat', 'all']){
    const m = build([...FULL, ...SHORT], mode);
    assert.match(notesHtml({ ...m, name: WHO }), /The pause figures were checked against land work only\./, mode);
  }
  const boat = build(FULL, 'boat');
  assert.match(notesHtml({ ...boat, name: WHO }), /No logs for Pat Example in this view\./);
  assert.equal(periodHtml(boat.stats, boat.prep), '');
  const none = build(FULL, 'land', { from: '2027-01-01', to: '' });
  assert.match(notesHtml({ ...none, name: WHO }), /No logs for Pat Example in this view\./);
});

test('a name is escaped wherever it is printed', () => {
  const m = build([...FULL], 'boat');
  assert.doesNotMatch(notesHtml({ ...m, name: '<img src=x onerror=alert(1)>' }), /<img/);
});

test('method and limits states the rules with the values in use', () => {
  const html = methodHtml();
  assert.match(html, /<details class="au-method">/);
  for(const phrase of ['07:30', '10 minutes', '45 minutes', '8 or more orders', '60 minutes',
    'cannot separate a break from an unlogged delay', 'straight line', 'expected number of orders',
    'cannot see orders that were never given out'])
    assert.match(html, new RegExp(phrase), phrase);
});

// ── the single day ───────────────────────────────────────────────────────────

const DAY = '2026-10-05';
// first meter 10:00; a 60-minute gap with 20 minutes logged against it; last 11:12
const DAY_STOPS = stopsOn(DAY, ['10:00', '10:06', '11:06', '11:12']);
const DAY_DOWN = [
  { timestamp: `${DAY} 12:00:00`, category: 'DISPATCH', minutes: 30, note: 'gap 07:30–08:00' },
  { timestamp: `${DAY} 12:00:00`, category: 'WAREHOUSE', minutes: 40, note: 'gap 08:00–10:00' },
  { timestamp: `${DAY} 12:00:00`, category: 'TOOLS_MATERIAL', minutes: 20, note: 'gap 10:06–11:06' },
  { timestamp: `${DAY} 12:00:00`, category: 'OTHER', minutes: 10, note: 'gap 11:12–11:30' },
  { timestamp: `${DAY} 12:00:00`, category: 'CELL_SIGNAL', minutes: 5, note: '' },
  { timestamp: `${DAY} 12:00:00`, category: 'LUNCH', minutes: 30, note: '' },
];
const detailOf = (stops, date, downtime = [], days = []) =>
  dayDetail(prepareAudit({ stops: [...FULL, ...stops], downtime, days }, { installer: WHO, mode: 'land' }), date);

test('the day view compares the day with both baselines and says how many days each used', () => {
  const html = dayTopHtml(detailOf(DAY_STOPS, DAY, DAY_DOWN));
  const heads = [...html.matchAll(/<h2[^>]*>([^<]+)</g)].map(m => m[1].trim());
  assert.deepEqual(heads, ['Timeline of the day', 'Pace on this route', 'This day, and how it compares', 'Delays logged this day']);
  assert.match(html, /<th class="n">This day<\/th><th class="n">30 worked days before \(6 days\)<\/th><th class="n">All to date \(6 days\)<\/th>/);
  for(const label of ['Orders (average)', 'First meter (average)', 'Last meter (average)',
    'Delay logged before the first meter (average)', 'Delay logged between meters (average)',
    'Unlogged pause (median)', 'Longest pause (median)'])
    assert.ok(html.includes(`<td>${label}</td>`), label);
  assert.match(html, /<td>Unlogged pause \(median\)<\/td><td class="n">34<\/td><td class="n">0<\/td>/);
  assert.match(html, /34 at 10:06/);
  assert.match(html, /id="auGapDetail"/);
  assert.doesNotMatch(html, /NaN|undefined|>null</);
});

test('the day view says how on pace the day was, and shows its arithmetic', () => {
  // Six full days next door, 6 minutes a gap and nothing over: on a typical full day
  // all of the time between first and last meter is at the usual pace. This day: gaps
  // of 6, 60 and 6, so 72 minutes, 20 of them logged against the long gap. The 52 left,
  // at 6 minutes an order, is 8.7 orders after the first: 10 expected, 4 logged.
  const html = dayTopHtml(detailOf(DAY_STOPS, DAY, DAY_DOWN));
  const card = html.slice(html.indexOf('Pace on this route'), html.indexOf('This day, and how it compares'));
  const tile = (n, label) => assert.ok(card.includes(`<div class="au-tile"><b>${n}</b><span>${label}</span></div>`), `${n} ${label}`);
  tile('4', 'orders logged');
  tile('10', 'expected for the time between first and last meter, on this route');
  tile('6 under', 'against the expected number');
  tile('6.0 min', 'usual time per order on this route (full days: 6.0)');
  assert.match(card, /<th class="n">This day<\/th><th class="n">Full days to date \(6 days\)<\/th>/);
  assert.match(card, /<td>Usual minutes per order on the route \(median\)<\/td><td class="n">6\.0<\/td><td class="n">6\.0<\/td>/);
  assert.match(card, /<td>First to last meter, less delay logged against those gaps \(median\)<\/td><td class="n">52<\/td><td class="n">48<\/td>/);
  assert.match(card, /<td>The same gaps at the usual pace \(median\)<\/td><td class="n">18<\/td><td class="n">48<\/td>/);
  assert.match(card, /<td>Share of that time at the usual pace \(median\)<\/td><td class="n">35%<\/td><td class="n">100%<\/td>/);
  assert.ok(card.includes('<td>Distance between orders, straight line, km (median)</td>'));
  assert.ok(card.includes('Expected: 72 min from first to last meter, less 20 min of delay logged against those gaps, is 52 min. '
    + 'On a typical full day 100% of that time is at the usual pace, and the rest is breaks, lunch and stops that ran long. That is 52 min. '
    + 'At this route\'s 6.0 usual min per order it is 9 orders after the first: 10.'), 'the arithmetic');
  assert.match(card, /On the full days to date, half land exactly on their expected number\./);
  assert.match(card, /Expected is not a target\./);
  assert.match(card, /cannot see orders that were never given out/);
  assert.doesNotMatch(card, /NaN|undefined|>null<|\byour\b/);

  // worked at the usual pace with nothing logged: exactly the expected number
  const steady = dayTopHtml(detailOf(stopsOn(DAY, every('10:00', 5)), DAY));
  assert.ok(steady.includes('<b>5</b><span>expected for the time between first and last meter, on this route</span>'));
  assert.ok(steady.includes('<b>Level</b><span>against the expected number</span>'));
  assert.match(steady, /Expected: 24 min from first to last meter\. On a typical full day/);

  // nine orders five minutes apart: quicker than the usual six, so one over
  const quick = dayTopHtml(detailOf(stopsOn(DAY, every('10:00', 9, 5)), DAY));
  assert.ok(quick.includes('<b>1 over</b><span>against the expected number</span>'));
});

test('a day with one order, or with no full day to compare with, says so and invents nothing', () => {
  const one = dayTopHtml(detailOf(stopsOn(DAY, ['11:15']), DAY));
  assert.match(one, /Pace on this route<\/h2><p class="au-empty">Only one order was logged, so there is no route to pace\.<\/p>/);
  const alone = dayTopHtml(dayDetail(prepareAudit({ stops: stopsOn(DAY, every('10:00', 5)), downtime: [], days: [] },
    { installer: WHO, mode: 'land' }), DAY));
  assert.ok(alone.includes('<b>—</b><span>expected for the time between first and last meter, on this route</span>'));
  assert.ok(alone.includes('<b>6.0 min</b><span>usual time per order on this route</span>'));
  assert.match(alone, /No day with 8 or more orders yet, so there is no typical day to expect a number from\./);
  assert.match(alone, /<th class="n">Full days to date \(0 days\)<\/th>/);
  assert.doesNotMatch(alone, /NaN|undefined|>null</);
});

test('dispatch before the first meter is labelled as the drive to the first order', () => {
  const html = dayTopHtml(detailOf(DAY_STOPS, DAY, DAY_DOWN));
  assert.match(html, /<td>Dispatch \(drive to the first order\)<\/td><td class="n">30<\/td><td class="n">07:30–08:00, before the first meter<\/td>/);
  assert.match(html, /<td>Warehouse<\/td><td class="n">40<\/td><td class="n">08:00–10:00, before the first meter<\/td>/);
  assert.match(html, /<td>Tools\/Material<\/td><td class="n">20<\/td><td class="n">10:06–11:06<\/td>/);
  assert.match(html, /<td>Other<\/td><td class="n">10<\/td><td class="n">11:12–11:30, after the last meter<\/td>/);
  assert.match(html, /<td>Cell Signal<\/td><td class="n">5<\/td><td class="n">no time of day<\/td>/);
  assert.doesNotMatch(html, /<td>Lunch<\/td>/);
  assert.match(html, /30 min of breaks or lunch/);
  // dispatch between meters is an ordinary delay
  const mid = dayTopHtml(detailOf(DAY_STOPS, DAY,
    [{ timestamp: `${DAY} 12:00:00`, category: 'DISPATCH', minutes: 15, note: 'gap 10:06–11:06' }]));
  assert.match(mid, /<td>Dispatch<\/td><td class="n">15<\/td>/);
  assert.match(dayTopHtml(detailOf(DAY_STOPS, DAY)), /No delay was logged this day/);
});

test('every log is listed with how its gap was read', () => {
  const d = detailOf(DAY_STOPS, DAY, DAY_DOWN);
  const html = dayLogsHtml(d.day);
  assert.match(html, /<h2[^>]*>Every log, in order</);
  const rows = [...html.matchAll(/<tr class="au-logrow"[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1].replace(/<[^>]+>/g, '|'));
  assert.equal(rows.length, 4);
  assert.match(rows[0], /10:00.*900000.*Installed.*first meter/);
  assert.match(rows[1], /10:06.*work/);
  assert.match(rows[2], /11:06.*pause 54: 20 logged as a delay, 34 not logged/);
  assert.match(rows[3], /11:12.*work/);
  assert.match(html, /<tr class="au-logrow" data-gap="1">/);
  const long = dayLogsHtml(detailOf(stopsOn(DAY, ['10:00', '11:00']), DAY).day);
  assert.match(long, /pause 54, nothing logged <span class="au-flag">long gap<\/span>/);
});

test('a gap opens with its two orders, the distance, the usual time, the overrun and what was logged', () => {
  const d = detailOf(DAY_STOPS, DAY, DAY_DOWN);
  const html = gapDetailHtml(d.day, 1);
  for(const piece of ['#2', '900001', '10:06', '#3', '900002', '11:06', '60 min', 'Next door (under 60 m)',
    '6.0 min', '54 min', '20 min', '34 min', '10 m'])
    assert.ok(html.includes(piece), piece);
  const nopin = DAY_STOPS.map((s, i) => i === 2 ? { ...s, lat: null, lng: null } : s);
  assert.match(gapDetailHtml(detailOf(nopin, DAY).day, 1), /no pin/);
  assert.equal(gapDetailHtml(d.day, 99), '');
});

test('the day notes say when a day ran late, was never closed out, or is left out', () => {
  const closed = [{ date: DAY, departure: '07:30', returned: '16:00' }];
  const short = dayNotesHtml(detailOf(DAY_STOPS, DAY, [], closed).day);
  assert.match(short, /Left out of the statistics \(under 8 orders\)/);
  assert.doesNotMatch(short, /Not closed out|Worked past/);
  assert.match(dayNotesHtml(detailOf(DAY_STOPS, DAY).day), /Not closed out: 16:00 is assumed/);
  const late = dayNotesHtml(detailOf(stopsOn(DAY, [...every('15:30', 9)]), DAY, [], closed).day);
  assert.match(late, /Worked past the set end time/);
  assert.doesNotMatch(late, /Left out|Not closed out/);
  assert.equal(dayNotesHtml(detailOf(stopsOn(DAY, every('09:00', 9)), DAY, [], closed).day), '');
});

test('a one-log day renders with no gaps and no invented figure', () => {
  const d = detailOf(stopsOn(DAY, ['11:15']), DAY);
  const html = dayTopHtml(d) + dayLogsHtml(d.day) + dayNotesHtml(d.day);
  assert.doesNotMatch(html, /NaN|undefined|>null</);
  assert.equal((dayLogsHtml(d.day).match(/class="au-logrow"/g) || []).length, 1);
});

test('the drive line gives the speeds, the distance, the driving time and the legs', () => {
  assert.equal(driveLineHtml({ legs: 2, km: 40.04, driveMin: 91, avgKmh: 40.4, topKmh: 89.6, gaps: 1 }),
    'Top 90 km/h · average 40 km/h · 40.0 km · 1 h 31 min driving · 2 legs');
  assert.equal(driveLineHtml({ legs: 1, km: 3.21, driveMin: 12, avgKmh: null, topKmh: 0, gaps: 0 }),
    'Top 0 km/h · average — km/h · 3.2 km · 12 min driving · 1 leg');
  assert.equal(driveLineHtml(null), '');
});

// ── the route map and the drive log ──────────────────────────────────────────

test('the map module never fetches, and the view draws the drive log only when the office gave it a loader', () => {
  assert.doesNotMatch(read('js/audit-map.js'), /apiGet\(|from '\.\/api\.js'/);
  assert.match(read('js/audit-view.js'), /if\s*\(\s*loadDriveLegs\s*\)/);
  assert.doesNotMatch(read('js/audit-view.js'), /admin-auth|driveTracks/);
  assert.match(read('js/pages/audits.js'), /apiGet\('driveTracks'/);
});

test('a drive leg is cut into runs where the recording jumped', () => {
  const t0 = 1790000000000;
  const pts = [0, 10, 20, 200, 210].map((s, i) => ({ lat: 44 + i * 0.001, lng: -79, t: t0 + s * 1000, spd: 10 }));
  const runs = driveRuns({ encoded: encodeTrack(pts), startTime: t0 });
  assert.deepEqual(runs.map(r => r.length), [3, 2]);
  assert.deepEqual(runs[0][0], [44, -79]);
  assert.deepEqual(driveRuns({ encoded: '', startTime: t0 }), []);
  assert.deepEqual(driveRuns({}), []);
});

test('logs with no pin are listed under the map by their place in the day', () => {
  const stops = DAY_STOPS.map((s, i) => i === 1 || i === 3 ? { ...s, lat: null, lng: null } : s);
  const html = offMapHtml(detailOf(stops, DAY).day);
  assert.match(html, /Not on the map: #2 900001 \(no pin\), #4 900003 \(no pin\)/);
  assert.equal(offMapHtml(detailOf(DAY_STOPS, DAY).day), '');
});

// ── the installer's page and the menus ───────────────────────────────────────

test('the installer page is never gated and never asks for a gated read', () => {
  const src = read('js/pages/my-audit.js');
  assert.doesNotMatch(src, /admin-auth|requireAdmin|apiGet\('driveTracks'|apiGet\('downtime'/);
  assert.match(src, /fixedInstaller:\s*name/);
  // its own drive log: the name AND the H number, one day, through the read that is not gated
  assert.match(src, /apiGet\('myDriveTracks', \{ installer, hNumber, from: date, to: date \}\)/);
  assert.match(src, /loadDriveLegs:\s*hNumber \? loadDriveLegs : null/, 'a phone with no H number in Settings asks for nothing');
  assert.match(src, /cfg\(\)\.name/);
});

test('my-audit.html has the view\'s ids, no picker and no office dropdown', () => {
  const html = read('my-audit.html');
  for(const id of ['status', 'statusText', 'auMode', 'auFrom', 'auTo', 'auDay', 'auPrint', 'auBack',
    'auPrev', 'auNext', 'auNote', 'auPeriod', 'auDayView', 'auMap', 'toast'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /id="auWho"|id="navSel"/);
  assert.match(html, /<a href="\.\/index\.html">← Back to the log<\/a>/);
  assert.match(html, /<script type="module" src="js\/pages\/my-audit\.js"><\/script>/);
  assert.match(html, /<script defer src="js\/vendor\/leaflet\.js"><\/script>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('both pages share one body: the same view ids in the same order', () => {
  const ids = f => [...read(f).matchAll(/id="(au\w+)"/g)].map(m => m[1]).filter(id => id !== 'auWho');
  assert.deepEqual(ids('my-audit.html'), ids('audits.html'));
});

test('every office page lists Audits and knows where it goes', () => {
  for(const p of ['map', 'teams', 'edit', 'reports', 'planner']){
    assert.match(read(`${p}.html`), /<option value="audits">Audits<\/option>/, p);
    assert.match(read(`js/pages/${p}.js`), /value\s*===?\s*'audits'|v\s*===?\s*'audits'/, p);
    assert.match(read(`js/pages/${p}.js`), /audits\.html/, p);
  }
});

test('the log page menu opens My audit without help from capture.js', () => {
  // The entry carries its own action. A phone can run this markup against an older
  // cached capture.js (or the reverse) for as long as it likes; a new id bound in
  // capture.js would throw there and take the rest of the page's wiring with it.
  const html = read('index.html');
  assert.match(html, /<button type="button" onclick="location\.href='my-audit\.html'">📊 My audit<\/button>/);
  const menu = html.slice(html.indexOf('id="navMenu"'), html.indexOf('</div>', html.indexOf('id="navMenu"')));
  assert.ok(menu.indexOf('navHelp') < menu.indexOf('my-audit.html'), 'after Help');
  assert.doesNotMatch(read('js/pages/capture.js'), /my-audit|navAudit/);
});

// ── found by the whole-branch review ─────────────────────────────────────────

test('a gap read as work still shows what was logged against it', () => {
  // 6 minutes next door is work, and 7 minutes were logged against it
  const d = detailOf(stopsOn(DAY, ['10:00', '10:06', '10:12']), DAY,
    [{ timestamp: `${DAY} 12:00:00`, category: 'ASSIST', minutes: 7, note: 'gap 10:00–10:06' }]);
  const html = gapDetailHtml(d.day, 0);
  assert.match(html, /Logged against this gap<\/td><td class="n">7 min/);
  assert.match(html, /Read as<\/td><td class="n">work/);
  assert.match(gapDetailHtml(d.day, 1), /Logged against this gap<\/td><td class="n">0 min/);
});

test('a long gap is described as what the code flags: 45 minutes of unlogged pause', () => {
  const { prep, stats } = build([...FULL, ...LONG]);
  const html = periodHtml(stats, prep);
  assert.match(html, /A long gap is one whose unlogged pause is 45 minutes or more/);
  assert.match(html, /Long gaps \(45\+ min of unlogged pause\)/);
  assert.match(methodHtml(), /long gap when its unlogged pause is 45 minutes or more/);
  assert.doesNotMatch(html + read('USER-GUIDE.md'), /45 minutes or more (between two logs )?with nothing logged against it/);
});

test('sheet values are escaped wherever a day prints them', () => {
  const bad = '<img src=x onerror=alert(1)>';
  const stops = stopsOn(DAY, ['10:00', '11:00']).map(s => ({ ...s, workOrderId: bad, address: bad }));
  const d = detailOf(stops, DAY, [{ timestamp: `${DAY} 12:00:00`, category: bad, minutes: 5, note: 'gap 10:00–11:00' }]);
  const html = dayTopHtml(d) + dayLogsHtml(d.day) + gapDetailHtml(d.day, 0) + offMapHtml({ logs: d.day.logs.map(l => ({ ...l, pin: false })) });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ── Download PDF ─────────────────────────────────────────────────────────────

test('both pages offer Download PDF, and the PDF module asks the spine for nothing', () => {
  for(const page of ['audits.html', 'my-audit.html']){
    const html = read(page);
    assert.match(html, /id="auPrint">Download PDF<\/button>/, page);
    assert.match(html, /id="auPrintDay">Download PDF<\/button>/, page);
    assert.doesNotMatch(html, />Print</, page);
    assert.doesNotMatch(html, /jspdf/i, page + ': the PDF library is loaded on demand, not by the page');
  }
  const pdf = read('js/audit-pdf.js');
  assert.doesNotMatch(pdf, /apiGet\(|apiPost\(|from '\.\/api\.js'|admin-auth|driveTracks/);
  assert.match(pdf, /js\/vendor\/jspdf\.umd\.min\.js/);
  assert.doesNotMatch(read('js/audit-view.js'), /window\.print\(\)\s*;?\s*\n\s*if\(el\.print\)/);
});

test('both pages carry Send PDF beside Download PDF, hidden until the script finds it can share', () => {
  for(const page of ['audits.html', 'my-audit.html']){
    const html = read(page);
    // hidden in the markup: a page whose script is older than its markup must not show a dead button
    assert.match(html, /id="auPrint">Download PDF<\/button>\s*<button type="button" class="btn hide" id="auSend">Send PDF<\/button>/, page);
    assert.match(html, /id="auPrintDay">Download PDF<\/button>\s*<button type="button" class="btn hide" id="auSendDay">Send PDF<\/button>/, page);
  }
});

// ── a delay whose time fell after its order's log ────────────────────────────

test('a delay counted in the gap after its order says so, in the delays, the log list, the gap detail and the method', () => {
  // next door, usual 6: the 10:20–10:30 gap ran 4 over and the 10:30–11:30 gap 54 over
  const stops = stopsOn(DAY, ['10:00', '10:20', '10:30', '11:30', '11:42']);
  const d = detailOf(stops, DAY, [
    { timestamp: `${DAY} 12:00:00`, category: 'TRUCK_ISSUES', minutes: 30, note: 'gap 10:20–10:30' },
    { timestamp: `${DAY} 12:00:00`, category: 'TOOLS_MATERIAL', minutes: 15, note: 'gap 10:20–10:30' },
    { timestamp: `${DAY} 12:00:00`, category: 'WAREHOUSE', minutes: 5, note: 'gap 10:00–10:20' },
  ]);
  const top = dayTopHtml(d);
  assert.ok(top.includes('10:20–10:30, counted in the gap after it (10:30–11:30)'));
  assert.equal(top.split('counted in the gap after it').length - 1, 2, 'the two entries on that order, and not the third');
  assert.match(dayLogsHtml(d.day), /pause 54: 41 logged as a delay, 13 not logged/);
  assert.match(gapDetailHtml(d.day, 1), /Logged against this gap<\/td><td class="n">45 min/);
  assert.match(gapDetailHtml(d.day, 1), /Of that, counted in the gap after<\/td><td class="n">41 min/);
  assert.match(gapDetailHtml(d.day, 2), /Logged against this gap<\/td><td class="n">0 min/);
  assert.match(gapDetailHtml(d.day, 2), /Logged against the order before, counted here<\/td><td class="n">41 min/);
  assert.match(gapDetailHtml(d.day, 2), /Not logged<\/td><td class="n">13 min/);
  assert.doesNotMatch(gapDetailHtml(d.day, 0), /counted in the gap after|counted here/);
  assert.match(methodHtml(), /What that gap did not run over is taken off the gap after the same order/);
});

// ── distance by road: the words follow the method in use ─────────────────────

const ROAD = { name: 'Test District', km: (a, b) => (a.id.endsWith('-0') ? null : 1.2) };   // each day's first gap is off the map
const roadPrep = () => prepareAudit({ stops: [...FULL, ...stopsOn(DAY, every('10:00', 5))], downtime: [], days: [] },
  { installer: WHO, mode: 'land', road: ROAD });

test('with a road map the page says distances are by road, names the map and counts what it could not reach', () => {
  const prep = roadPrep(), stats = periodStats(prep, { from: '', to: '' });
  assert.deepEqual(prep.distance, { road: 45, straight: 7, map: 'Test District' });
  const note = notesHtml({ prep, stats, name: WHO });
  assert.match(note, /Distances between orders are by road, from the offline road map on this device \(Test District\)\. 7 of 52 gaps are off that map and are straight lines\./);
  const period = periodHtml(stats, prep);
  assert.match(period, /with the distance between the two pins by road: the shortest drive on the offline road map on this device \(Test District\)/);
  assert.match(period, /A device without that road map measures every gap in a straight line, so its figures differ\./);
  assert.doesNotMatch(period, /with the straight line distance between the two pins/);
  const d = dayDetail(prep, DAY);
  assert.match(dayNotesHtml(d.day, prep.mode, prep.distance), /Distances between orders are by road/);
  assert.ok(dayTopHtml(d).includes('<td>Distance between orders, by road, km (median)</td>'));
  assert.match(gapDetailHtml(d.day, 0), /Straight-line distance \(off the road map\)<\/td>/);
  assert.match(gapDetailHtml(d.day, 1), /Distance by road<\/td><td class="n">1\.2 km/);
  assert.equal(routeCaption(true), 'Pins are numbered in the order the orders were logged. The line between them follows the roads on the '
    + 'offline road map: the shortest drive, which is not always the one taken. A straight piece is a gap the road map could not reach.');
  assert.equal(routeCaption(false), ROUTE_CAPTION);
});

test('without a road map nothing about the wording changes, and a map that reaches nothing says so', () => {
  const plain = build([...FULL, ...SHORT]);
  assert.doesNotMatch(notesHtml({ ...plain, name: WHO }), /road/);
  assert.match(periodHtml(plain.stats, plain.prep), /with the straight line distance between the two pins/);
  assert.match(periodHtml(plain.stats, plain.prep), /With an offline road map on the device \(Settings on the log page\) they are measured by road instead\./);
  const none = prepareAudit({ stops: FULL, downtime: [], days: [] }, { installer: WHO, mode: 'land', road: { name: 'Far Away', km: () => null } });
  assert.match(notesHtml({ prep: none, stats: periodStats(none, { from: '', to: '' }), name: WHO }),
    /The offline road map on this device \(Far Away\) reaches none of these orders: distances are straight lines\./);
  assert.match(methodHtml(), /with the straight line distance between the two pins/);
});
