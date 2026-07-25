// Per-role nav hiding and the wrong-page guard.
//
// The test that matters most is the migration-window one: a blank role must see
// everything. Until people sign in that is the whole crew, and a filter that
// gets it wrong hides a production app from 200 people at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV_PAGES, visibleNavValues } from '../js/nav-roles.js';
import { homePageFor, ROLES } from '../js/auth-policy.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// The full jump menu, in the order the back-office pages list it.
const ALL = ['log', 'map', 'analytics', 'teams', 'edit', 'reports', 'planner', 'help'];

test('a blank role sees the whole menu — this is the migration window', () => {
  assert.deepEqual(visibleNavValues(ALL, ''), ALL);
  assert.deepEqual(visibleNavValues(ALL, null), ALL);
});

test('an owner sees everything too', () => {
  assert.deepEqual(visibleNavValues(ALL, 'owner'), ALL);
});

test('an installer keeps the capture page and help, and loses the back office', () => {
  const v = visibleNavValues(ALL, 'installer');
  assert.ok(v.includes('log'));
  assert.ok(v.includes('help'));
  for (const gone of ['map', 'analytics', 'teams', 'edit', 'reports', 'planner']) {
    assert.ok(!v.includes(gone), `installer should not see ${gone}`);
  }
});

test('back-office reads the whole crew but gets no planner and no capture page', () => {
  // R_VIEW without R_OPS. Reading for others is not writing for others.
  const v = visibleNavValues(ALL, 'backoffice');
  assert.ok(v.includes('map'));
  assert.ok(v.includes('analytics'));
  assert.ok(v.includes('reports'));
  assert.ok(!v.includes('planner'));
  assert.ok(!v.includes('log'));
  assert.ok(!v.includes('teams'));
});

test('a foreman gets edit and planner but not crew management', () => {
  const v = visibleNavValues(ALL, 'foreman');
  assert.ok(v.includes('edit'));
  assert.ok(v.includes('planner'));
  assert.ok(!v.includes('teams'));   // R_MANAGE is owner/admin only
});

test('analytics follows map, because it is map.html#analytics', () => {
  assert.equal(NAV_PAGES.analytics, 'map.html');
  const v = visibleNavValues(ALL, 'installer');
  assert.equal(v.includes('map'), v.includes('analytics'));
});

test('an unknown nav value is left alone rather than silently dropped', () => {
  // A new menu entry added without touching NAV_PAGES should still render.
  assert.deepEqual(visibleNavValues(['somethingNew'], 'installer'), ['somethingNew']);
});

test('every role has somewhere to land, so the guard can never dead-end', () => {
  for (const r of [...ROLES, '']) {
    const dest = homePageFor(r);
    assert.ok(dest, `${r || 'blank'} should have a landing page`);
    assert.ok(visibleNavValues([Object.keys(NAV_PAGES).find(k => NAV_PAGES[k] === dest)]
      .filter(Boolean), r).length > 0 || dest === 'help.html',
      `${r || 'blank'} should be able to open its own landing page ${dest}`);
  }
});

// ── the DOM half ───────────────────────────────────────────────────────────

const nav = read('js/nav-roles.js');

test('the guard refuses to redirect to the page it is already on', () => {
  // Without this, a role whose landing page it cannot open would reload forever.
  assert.match(nav, /dest === page|page === dest/);
});

test('the guard uses replace, so Back does not bounce them straight out again', () => {
  assert.match(nav, /location\.replace/);
});

test('nav filtering reads the remembered role, not the session validity', () => {
  // authRole survives expiry on purpose: the nav must stay right with no signal.
  assert.doesNotMatch(nav, /state\s*===\s*'ok'/);
});

test('the service worker ships the module and the cache was bumped', () => {
  // Not pinned to an exact version — plan 3 bumps again. See the same note in
  // tests/auth-ui.test.mjs.
  const sw = read('sw.js');
  assert.match(sw, /'\.\/js\/nav-roles\.js'/);
  assert.doesNotMatch(sw, /const CACHE = 'meterlog-v3[45]'/);
});
