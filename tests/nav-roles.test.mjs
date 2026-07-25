// Per-role nav hiding and the wrong-page guard.
//
// The test that matters most is the migration-window one: a blank role must see
// everything. Until people sign in that is the whole crew, and a filter that
// gets it wrong hides a production app from 200 people at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAV_PAGES, visibleNavValues } from '../js/nav-roles.js';
import { homePageFor, ROLES, canSeePage } from '../js/auth-policy.js';
import { store } from '../js/store.js';

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

// ── the DOM behaviour tests ────────────────────────────────────────────────────
// These tests dynamically import nav-roles.js with fake globals to verify the
// actual behavior, not just the presence of code patterns. This catches semantic
// regressions (e.g., currentPage() output format drifting from homePageFor()).

test('the loop guard holds: no redirect when already on the home page', async () => {
  const { guardPage } = await setupDomTest();

  for (const r of [...ROLES, '']) {
    store.set('authRole', r);
    const home = homePageFor(r);
    globalThis.location.pathname = home;
    globalThis.location.replaceWasCalled = false;

    const result = guardPage();

    assert.equal(result, true, `guardPage() should return true for role '${r}' on its home page '${home}'`);
    assert.equal(globalThis.location.replaceWasCalled, false,
      `location.replace should not be called for role '${r}' on ${home}`);
  }

  teardownDomTest();
});

test('a wrong page redirects exactly once to the home page', async () => {
  const { guardPage } = await setupDomTest();

  // Installer on map.html should redirect to index.html
  store.set('authRole', 'installer');
  globalThis.location.pathname = 'map.html';
  globalThis.location.replaceWasCalled = false;
  globalThis.location.replaceUrl = null;

  const result = guardPage();

  assert.equal(result, false, 'guardPage() should return false when starting a redirect');
  assert.equal(globalThis.location.replaceWasCalled, true, 'location.replace should be called');
  assert.equal(globalThis.location.replaceUrl, 'index.html', 'should redirect to installer home page');

  teardownDomTest();
});

test('a blank role is never redirected from any page', async () => {
  const { guardPage } = await setupDomTest();
  const pages = ['index.html', 'map.html', 'teams.html', 'edit.html', 'reports.html', 'planner.html', 'help.html'];

  store.set('authRole', '');

  for (const page of pages) {
    globalThis.location.pathname = page;
    globalThis.location.replaceWasCalled = false;

    const result = guardPage();

    assert.equal(result, true, `blank role should not be redirected from ${page}`);
    assert.equal(globalThis.location.replaceWasCalled, false,
      `location.replace should not be called for blank role on ${page}`);
  }

  teardownDomTest();
});

test('currentPage() derives a bare filename from nested paths and trailing slashes', async () => {
  const { currentPage } = await setupDomTest();

  const cases = [
    ['/app/index.html', 'index.html'],
    ['/deep/nested/path/map.html', 'map.html'],
    ['/path/', 'index.html'],
    ['/', 'index.html'],
    ['index.html', 'index.html'],
  ];

  for (const [pathname, expected] of cases) {
    globalThis.location.pathname = pathname;
    const result = currentPage();
    assert.equal(result, expected, `currentPage() for pathname '${pathname}' should be '${expected}'`);
  }

  teardownDomTest();
});

test('applyRoleNav() removes forbidden options and leaves allowed ones', async () => {
  const { applyRoleNav } = await setupDomTest();

  store.set('authRole', 'installer');

  // Create a nav select with all options that can be removed
  const removedOptions = [];
  const options = ALL.map(v => ({
    value: v,
    remove: function() {
      removedOptions.push(this.value);
    }
  }));

  globalThis.document.getElementById = (id) => {
    if (id === 'navSel') return { options };
    if (id === 'navHelp') return { classList: { add: () => {} } };
    return null;
  };

  applyRoleNav();

  assert.ok(!removedOptions.includes('log'), 'log (index.html) should not be removed for installer');
  assert.ok(!removedOptions.includes('help'), 'help should not be removed for installer');
  assert.ok(removedOptions.includes('map'), 'map should be removed for installer');
  assert.ok(removedOptions.includes('teams'), 'teams should be removed for installer');

  teardownDomTest();
});

test('the redirect notice is delivered once, then cleared from sessionStorage', async () => {
  const { guardPage, applyRoleNav } = await setupDomTest();

  store.set('authRole', 'installer');
  globalThis.location.pathname = 'map.html';

  // First redirect: should set the message
  const redirectStarted = guardPage() === false;
  assert.equal(redirectStarted, true, 'guardPage should start a redirect from map.html for installer');
  const msgAfterRedirect = globalThis.sessionStorageData.navRedirectMsg;
  assert.ok(msgAfterRedirect, 'redirect message should be set in sessionStorage after guardPage');

  // applyRoleNav should read the message and clear it
  applyRoleNav();

  const msgAfterApply = globalThis.sessionStorageData.navRedirectMsg;
  assert.equal(msgAfterApply, undefined,
    'message should be cleared from sessionStorage after applyRoleNav calls deliverRedirectNotice');

  teardownDomTest();
});

// ── Test helpers ───────────────────────────────────────────────────────────

async function setupDomTest() {
  // Set up fake globals that nav-roles.js will use
  globalThis.location = {
    pathname: '/app/index.html',
    replace: function(url) {
      this.replaceWasCalled = true;
      this.replaceUrl = url;
    },
    replaceWasCalled: false,
    replaceUrl: null,
  };

  globalThis.document = {
    getElementById: (id) => {
      if (id === 'navSel') return null;
      if (id === 'navHelp') return null;
      return null;
    },
    hidden: false,
    addEventListener: () => {},
  };

  globalThis.sessionStorageData = {};
  globalThis.sessionStorage = {
    getItem: (k) => globalThis.sessionStorageData[k] ?? null,
    setItem: (k, v) => { globalThis.sessionStorageData[k] = v; },
    removeItem: (k) => { delete globalThis.sessionStorageData[k]; },
  };

  // localStorage falls back to in-memory in store.js if it fails
  globalThis.localStorage = {
    getItem: (k) => globalThis.__localStorage?.[k] ?? null,
    setItem: (k, v) => {
      if (!globalThis.__localStorage) globalThis.__localStorage = {};
      globalThis.__localStorage[k] = v;
    },
    removeItem: (k) => { if (globalThis.__localStorage) delete globalThis.__localStorage[k]; },
  };

  // Import nav-roles with the fake globals in place
  return import('../js/nav-roles.js');
}

function teardownDomTest() {
  // Clean up globals so they don't leak into other tests
  delete globalThis.location;
  delete globalThis.document;
  delete globalThis.sessionStorage;
  delete globalThis.localStorage;
  delete globalThis.__localStorage;
  delete globalThis.testNavOptions;
  delete globalThis.testToastMsg;
  delete globalThis.sessionStorageData;
}

function setSessionRole(roleName) {
  if (!globalThis.__localStorage) globalThis.__localStorage = {};
  globalThis.__localStorage.authRole = roleName;
}
