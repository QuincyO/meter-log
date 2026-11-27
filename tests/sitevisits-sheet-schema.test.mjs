// The SiteVisits tab (one row per house timer) and the way the Drive screen reaches
// it. Positional append on the spine, a lazily-loaded module and a JS-built row on
// the phone — each of those fails silently if it drifts, so each is pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startVisit, endVisit, closeStale, orderOf } from '../js/site-visit.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = read('Code.gs');
const drive = read('js/drive.js');

function headers(name){
  const m = code.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);\\r?\\n`));
  assert.ok(m, `${name} not found in Code.gs`);
  return eval(m[1]);
}
const saveFn = () => code.match(/function saveSiteVisit\(b\)\s*\{[\s\S]*?\n\}/)[0];

// Cells in saveSiteVisit's positional row literal, and the body field each reads.
function rowCells(){
  const body = saveFn().match(/const row = \[([\s\S]*?)\];/)[1].replace(/\/\/[^\n]*/g, '');
  const cells = []; let depth = 0, cur = '';
  for(const ch of body){
    if('([{'.includes(ch)) depth++;
    else if(')]}'.includes(ch)) depth--;
    if(ch === ',' && depth === 0){ cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

test('saveSiteVisit writes one cell per SiteVisits header, each from the field of that name', () => {
  // A positional append: one cell off shifts every later column, and nothing reads
  // this tab yet to notice.
  const h = headers('SITEVISITS_HEADERS'), cells = rowCells();
  assert.equal(cells.length, h.length);
  h.forEach((name, i) => assert.match(cells[i], new RegExp(`\\bb\\.${name}\\b`),
    `column ${i + 1} (${name}) is built from "${cells[i]}"`));
  assert.equal(new Set(h).size, h.length, 'SITEVISITS_HEADERS has a duplicate column');
});

test('the phone sends exactly the fields the tab has', () => {
  const h = headers('SITEVISITS_HEADERS');
  const identity = ['installer', 'hNumber', 'workType'];     // added by drive.js sendVisit
  const now = { ms: 1_800_000_000_000, stamp: '2026-11-27 12:40:00', date: '2026-11-27' };
  const open = startVisit({ id: 'v1', order: orderOf({ workOrderId: '1' }, '1 Elm St'), now });
  const ended = endVisit(open, { endedBy: 'leave', now: { ...now, ms: now.ms + 600000 } }).row;
  for(const row of [ended, closeStale(open, '2026-11-28')])
    assert.deepEqual([...Object.keys(row), ...identity].sort(), [...h].sort());
  for(const key of identity)
    assert.match(drive, new RegExp(`action: 'saveSiteVisit'[\\s\\S]{0,160}\\b${key}\\b`));
});

test('SiteVisits is created by setupSheets, makes itself on the first write, and is served by doPost', () => {
  assert.match(code, /ensureTab\(ss, 'SiteVisits', SITEVISITS_HEADERS\)/);
  assert.match(saveFn(), /getSheetByName\('SiteVisits'\) \|\| ensureTab\(ss, 'SiteVisits', SITEVISITS_HEADERS\)/);
  assert.match(code, /case 'saveSiteVisit':\s*return json\(saveSiteVisit\(body\)\)/);
  assert.match(saveFn(), /bustRows\('SiteVisits'\)/);
});

test('saveSiteVisit never answers with a rejection the queue would keep', () => {
  // It rides the offline queue. A re-sent id must ack, and so must a row with
  // nothing on it: a definitive {ok:false} is parked on the phone, and a parked
  // item makes the Drive screen's refresh skip its worklist pull (autoSync).
  const fn = saveFn();
  assert.match(fn, /idExists\(sh, b\.id\)\) return \{ ok: true/);
  assert.ok(!/ok:\s*false/.test(fn), 'saveSiteVisit must not return ok:false');
});

test('a phone sends it, so it is not an admin action and nothing reads the tab yet', () => {
  const adminPost = code.match(/const ADMIN_POST = \{[\s\S]*?\};/)[0];
  assert.ok(!adminPost.includes('saveSiteVisit'));
  assert.ok(!/p\.action === 'siteVisits'/.test(code), 'collection only: no read endpoint');
});

test('the timer module is lazy, and sw.js was not touched for it', () => {
  // Any byte change to sw.js re-downloads the whole shell on every phone at its
  // next open (AGENTS.md, the activity-log rule). The module is fetched on first use.
  assert.ok(!read('sw.js').includes('site-visit'));
  assert.match(drive, /import\('\.\/site-visit\.js'\)\.then\([\s\S]*?\)\.catch\(/);
  assert.ok(!/^import[^\n]*site-visit/m.test(drive), 'no static import of site-visit.js');
});

test('the row is built in JS: no new markup, no new stylesheet rule', () => {
  // A phone runs a new drive.js against an older index.html and drive.css for as
  // long as its installer leaves Force update alone.
  for(const id of ['driveVisit', 'driveVisitPark', 'driveVisitLeave']){
    assert.ok(!read('index.html').includes(id), `index.html must not carry #${id}`);
    assert.ok(!read('css/drive.css').includes(id));
    assert.ok(drive.includes(`'${id}'`), `drive.js builds #${id}`);
  }
  assert.match(drive, /const pos = \$\('drivePos'\);\s*if\(visitUi \|\| !pos \|\| !pos\.parentNode\) return;/);
});

test('the live-minutes interval does not outlive the screen', () => {
  const body = name => drive.match(new RegExp(`async function ${name}\\(\\)\\{[\\s\\S]*?\\n  \\}`))[0];
  assert.match(body('close'), /stopVisitTick\(\)/);
  assert.match(body('teardown'), /stopVisitTick\(\)/);
  assert.match(body('open'), /startVisitTick\(\)/);
});

test('a finished timer goes through the offline queue, not the 3-minute refresh', () => {
  assert.match(drive, /await enqueue\(\{ token: c\.token, action: 'saveSiteVisit'/);
  const tick = drive.match(/async function tickAutoSync\(\)\{[\s\S]*?\n  \}/)[0];
  assert.ok(!/visit/i.test(tick), 'the refresh tick must not carry the timer upload');
});
