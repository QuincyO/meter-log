// The Audits pages: audits.html (office, behind the password) and my-audit.html
// (the installer's own, on the phone). Static checks on the files that are easy
// to break without noticing, plus the HTML the pure render module produces from
// made-up days. Nothing here is a real installer's data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { prepareAudit, periodStats } from '../js/compute/audit.js';
import { periodHtml, notesHtml, methodHtml } from '../js/audit-render.js';

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
