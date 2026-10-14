// The admin gate (Code.gs isAdmin / ADMIN_GET / ADMIN_POST) is the only thing
// standing between the public token in js/config.js and every stop's GPS. Two
// ways it can fail, both silent: an office read slips out of the gated set (the
// data is public again), or a capture-side action slips IN (the crew's phones
// start getting "admin required" and the offline queue parks real stops).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = read('Code.gs');

function constObj(name){
  const m = code.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`));
  assert.ok(m, `${name} not found in Code.gs`);
  return eval('(' + m[1] + ')');
}
function fnSrc(name){
  const m = code.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\r?\\n\\}`));
  assert.ok(m, `function ${name} not found in Code.gs`);
  return m[0];
}

const ADMIN_GET = constObj('ADMIN_GET');
const ADMIN_POST = constObj('ADMIN_POST');

// Evaluate the real isAdmin/getNeedsAdmin against stubbed Apps Script services.
function harness(adminKeyProp){
  const cache = new Map();
  const env = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'ADMIN_KEY' ? adminKeyProp : null) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    ADMIN_GET, ADMIN_POST,
    ADMIN_MAX_FAILS: Number(code.match(/const ADMIN_MAX_FAILS = (\d+)/)[1]),
    ADMIN_LOCKOUT_S: Number(code.match(/const ADMIN_LOCKOUT_S = (\d+)/)[1]),
  };
  const names = Object.keys(env);
  const make = new Function(...names, `${fnSrc('isAdmin')}\n${fnSrc('getNeedsAdmin')}\nreturn { isAdmin, getNeedsAdmin };`);
  return make(...names.map(n => env[n]));
}

test('GPS and crew-wide office reads are gated', () => {
  for(const a of ['pins', 'driveTracks', 'archived', 'nearby', 'tracker', 'timing', 'boatdays', 'dispatch', 'downtime'])
    assert.ok(ADMIN_GET[a], `${a} must be in ADMIN_GET`);
  for(const a of ['restoreStop', 'saveTeam', 'deleteTeam', 'deleteEmployee', 'saveSub', 'deleteSub', 'saveCaptain', 'deleteCaptain'])
    assert.ok(ADMIN_POST[a], `${a} must be in ADMIN_POST`);
});

test('isAdmin fails closed when ADMIN_KEY is unset', () => {
  const { isAdmin } = harness(null);
  assert.equal(isAdmin('anything'), false);
  assert.equal(isAdmin(''), false);
  assert.equal(harness('').isAdmin(''), false);
});

test('isAdmin accepts only the exact key, and locks out after repeated misses', () => {
  const { isAdmin } = harness('correct horse');
  assert.equal(isAdmin('correct horse'), true);
  assert.equal(isAdmin(undefined), false);
  for(let i = 0; i < 10; i++) assert.equal(isAdmin('guess' + i), false);
  assert.equal(isAdmin('correct horse'), false, 'locked out after 10 bad keys');
});

test('day/range need admin only when asking for every installer', () => {
  const { getNeedsAdmin } = harness('k');
  assert.equal(getNeedsAdmin({ action: 'day', installer: 'Quincy Orta' }), false);
  assert.equal(getNeedsAdmin({ action: 'range', installer: 'Quincy Orta' }), false);
  assert.equal(getNeedsAdmin({ action: 'day' }), true);
  assert.equal(getNeedsAdmin({ action: 'range', installer: '  ' }), true);
  assert.equal(getNeedsAdmin({ action: 'pins' }), true);
  assert.equal(getNeedsAdmin({ action: 'roster' }), false);
});

test('doGet and doPost check the gate before dispatching any action', () => {
  const get = fnSrc('doGet'), post = fnSrc('doPost');
  const g = get.indexOf('getNeedsAdmin(p) && !isAdmin(p.adminKey)');
  assert.ok(g > 0, 'doGet gate missing');
  assert.ok(g < get.indexOf("p.action === 'nearby'"), 'doGet gate must precede the first read');
  const q = post.indexOf('ADMIN_POST[body.action] && !isAdmin(body.adminKey)');
  assert.ok(q > 0, 'doPost gate missing');
  assert.ok(q < post.indexOf('switch (body.action)'), 'doPost gate must precede the switch');
});

// Every action the capture phone, the wo-bot or the Apple Shortcut sends must
// stay token-only — gating one silently breaks the crew's safety-critical path.
test('no capture-side action is admin-gated', () => {
  const OFFICE = new Set(['map.js', 'edit.js', 'teams.js', 'reports.js', 'planner.js']);
  const files = [
    ...readdirSync(new URL('../js/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => 'js/' + f),
    ...readdirSync(new URL('../js/pages/', import.meta.url)).filter(f => f.endsWith('.js') && !OFFICE.has(f)).map(f => 'js/pages/' + f),
    'tools/wo-bot/bot.mjs',
  ];
  const used = new Set(['dispatchRequest']); // the Apple Shortcut
  for(const f of files){
    const src = read(f);
    for(const m of src.matchAll(/apiGet\(\s*'([A-Za-z]+)'/g)) used.add(m[1]);
    for(const m of src.matchAll(/action\s*:\s*'([A-Za-z]+)'/g)) used.add(m[1]);
    for(const m of src.matchAll(/spine(?:Get|Post)\(\s*'([A-Za-z]+)'/g)) used.add(m[1]);
  }
  used.delete('adminCheck'); // admin-auth.js's own login probe
  for(const a of ['addStop', 'day', 'range', 'worklist', 'roster', 'endOfDay'])
    assert.ok(used.has(a), `scanner should have found ${a} — did a caller's shape change?`);
  for(const a of used){
    assert.ok(!ADMIN_GET[a], `${a} is called by the capture side but is in ADMIN_GET`);
    assert.ok(!ADMIN_POST[a], `${a} is called by the capture side but is in ADMIN_POST`);
  }
});

test('every office page waits for the login gate', () => {
  for(const p of ['map', 'edit', 'teams', 'reports', 'planner'])
    assert.match(read(`js/pages/${p}.js`), /\nawait requireAdmin\(\);/, `${p}.js must await requireAdmin()`);
  assert.doesNotMatch(read('js/pages/capture.js'), /admin-auth/, 'the capture page must never be gated');
});

test('the nightly export refuses to write into the Pages-served app repo', () => {
  assert.match(code, /const EXPORT_FORBIDDEN_REPOS = \[[^\]]*'quincyo\/meter-log'/);
  assert.match(fnSrc('githubCommitFiles'), /EXPORT_FORBIDDEN_REPOS\.indexOf/);
});
