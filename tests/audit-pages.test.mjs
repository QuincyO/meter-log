// The Audits pages: audits.html (office, behind the password) and my-audit.html
// (the installer's own, on the phone). Static checks on the files that are easy
// to break without noticing, plus the HTML the pure render module produces from
// made-up days. Nothing here is a real installer's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { prepareAudit, periodStats, dayDetail } from '../js/compute/audit.js';
import { periodHtml, notesHtml, methodHtml, dayTopHtml, dayLogsHtml, gapDetailHtml, dayNotesHtml,
  driveLineHtml } from '../js/audit-render.js';
import { driveRuns, offMapHtml } from '../js/audit-map.js';
import { encodeTrack } from '../js/drive-track.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const exists = p => existsSync(new URL('../' + p, import.meta.url));
const AUDIT_FILES = ['audits.html', 'my-audit.html', 'css/audits.css', 'js/audit-view.js',
  'js/audit-render.js', 'js/audit-charts.js', 'js/audit-map.js', 'js/pages/audits.js',
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
    'cannot separate a break from an unlogged delay', 'straight line'])
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
  assert.deepEqual(heads, ['Timeline of the day', 'This day, and how it compares', 'Delays logged this day']);
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
  assert.doesNotMatch(src, /admin-auth|requireAdmin|driveTracks|apiGet\('downtime'/);
  assert.match(src, /fixedInstaller:\s*name/);
  assert.match(src, /loadDriveLegs:\s*null/);
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
