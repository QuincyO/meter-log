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
  try {
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
  } finally { teardownDomTest(); }
});

test('a wrong page redirects exactly once to the home page', async () => {
  const { guardPage } = await setupDomTest();
  try {
    // Installer on map.html should redirect to index.html
    store.set('authRole', 'installer');
    globalThis.location.pathname = 'map.html';
    globalThis.location.replaceWasCalled = false;
    globalThis.location.replaceUrl = null;

    const result = guardPage();

    assert.equal(result, false, 'guardPage() should return false when starting a redirect');
    assert.equal(globalThis.location.replaceWasCalled, true, 'location.replace should be called');
    assert.equal(globalThis.location.replaceUrl, 'index.html', 'should redirect to installer home page');
  } finally { teardownDomTest(); }
});

test('a blank role is never redirected from any page', async () => {
  const { guardPage } = await setupDomTest();
  try {
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
  } finally { teardownDomTest(); }
});

test('currentPage() derives a bare filename from nested paths and trailing slashes', async () => {
  const { currentPage } = await setupDomTest();
  try {
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
  } finally { teardownDomTest(); }
});

test('applyRoleNav() removes forbidden options and leaves allowed ones', async () => {
  const { applyRoleNav } = await setupDomTest();
  try {
    store.set('authRole', 'installer');

    // Create a nav select with all options that can be removed
    const removedOptions = [];
    const options = ALL.map(v => ({
      value: v,
      remove: function() {
        removedOptions.push(this.value);
      }
    }));

    globalThis.document.querySelectorAll = (selector) => {
      if (selector === '#navSel, #viewSel') return [{ options }];
      return [];
    };
    globalThis.document.getElementById = (id) => {
      if (id === 'navHelp') return { classList: { add: () => {} } };
      return null;
    };

    applyRoleNav();

    assert.ok(!removedOptions.includes('log'), 'log (index.html) should not be removed for installer');
    assert.ok(!removedOptions.includes('help'), 'help should not be removed for installer');
    assert.ok(removedOptions.includes('map'), 'map should be removed for installer');
    assert.ok(removedOptions.includes('teams'), 'teams should be removed for installer');
  } finally { teardownDomTest(); }
});

test('applyRoleNav() leaves the full menu untouched during the migration window', async () => {
  // The blank role is the migration window — until people sign in that is the
  // entire crew. If applyRoleNav ever removed options for a blank role, it would
  // hide most of the app from all 200 installers at once. This test ensures that
  // path stays inert during the transition.
  const { applyRoleNav } = await setupDomTest();
  try {
    store.set('authRole', '');

    // Create a nav select with all options that can be removed
    const removedOptions = [];
    const options = ALL.map(v => ({
      value: v,
      remove: function() {
        removedOptions.push(this.value);
      }
    }));

    globalThis.document.querySelectorAll = (selector) => {
      if (selector === '#navSel, #viewSel') return [{ options }];
      return [];
    };
    globalThis.document.getElementById = (id) => {
      if (id === 'navHelp') return { classList: { add: () => {} } };
      return null;
    };

    applyRoleNav();

    assert.deepEqual(removedOptions, [], 'blank role should remove zero nav options (full menu survives)');
    assert.deepEqual(options.map(o => o.value), ALL, 'options remain in original order');
  } finally { teardownDomTest(); }
});

test('applyRoleNav() filters map.html\'s #viewSel for the backoffice role', async () => {
  // Map.html predates the shared jump menu and uses #viewSel instead of #navSel.
  // The filtering logic must work on both, or map.html's nav won't be filtered.
  const { applyRoleNav } = await setupDomTest();
  try {
    store.set('authRole', 'backoffice');

    // Map.html's real option list
    const mapOptions = ['map', 'analytics', 'teams', 'edit', 'reports', 'help'];
    const removedOptions = [];
    const options = mapOptions.map(v => ({
      value: v,
      remove: function() {
        removedOptions.push(this.value);
      }
    }));

    globalThis.document.querySelectorAll = (selector) => {
      if (selector === '#navSel, #viewSel') return [{ options }];
      return [];
    };
    globalThis.document.getElementById = (id) => {
      if (id === 'navHelp') return { classList: { add: () => {} } };
      return null;
    };

    applyRoleNav();

    assert.ok(removedOptions.includes('teams'), 'backoffice should not see teams option on map.html');
    assert.ok(removedOptions.includes('edit'), 'backoffice should not see edit option on map.html');
    assert.ok(!removedOptions.includes('map'), 'map should remain for backoffice');
    assert.ok(!removedOptions.includes('analytics'), 'analytics should remain for backoffice');
    assert.ok(!removedOptions.includes('reports'), 'reports should remain for backoffice');
    assert.ok(!removedOptions.includes('help'), 'help should remain for backoffice');
  } finally { teardownDomTest(); }
});

test('applyRoleNav() leaves #viewSel untouched for a blank role', async () => {
  // Blank role is the migration window and must see everything, including on map.html.
  const { applyRoleNav } = await setupDomTest();
  try {
    store.set('authRole', '');

    const mapOptions = ['map', 'analytics', 'teams', 'edit', 'reports', 'help'];
    const removedOptions = [];
    const options = mapOptions.map(v => ({
      value: v,
      remove: function() {
        removedOptions.push(this.value);
      }
    }));

    globalThis.document.querySelectorAll = (selector) => {
      if (selector === '#navSel, #viewSel') return [{ options }];
      return [];
    };
    globalThis.document.getElementById = (id) => {
      if (id === 'navHelp') return { classList: { add: () => {} } };
      return null;
    };

    applyRoleNav();

    assert.deepEqual(removedOptions, [], 'blank role should remove zero options from #viewSel');
  } finally { teardownDomTest(); }
});

test('every jump-menu option value is a known NAV_PAGES key', () => {
  // The #viewSel bug was a wrong assumption no test caught: an option whose
  // value doesn't match a NAV_PAGES key isn't dropped by visibleNavValues (an
  // unknown value survives by design, so a new entry still renders before
  // someone maps it) — but it also means a *renamed* value silently stops being
  // filtered, and a back-office user sees an entry that just bounces them.
  // Scoped to the jump-menu <select> itself (id="navSel" on edit/teams/reports/
  // planner, id="viewSel" on map) because these pages carry other, unrelated
  // <select> elements (edit.html #who, reports.html #sub, planner.html #plWho)
  // whose values must not be swept into this check.
  const pages = {
    'map.html': 'viewSel',
    'edit.html': 'navSel',
    'teams.html': 'navSel',
    'reports.html': 'navSel',
    'planner.html': 'navSel',
  };
  for (const [page, selId] of Object.entries(pages)) {
    const html = read(page);
    const selMatch = html.match(new RegExp(`<select[^>]*\\bid="${selId}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(selMatch, `${page} should carry a #${selId} jump-menu <select>...</select> block`);
    const values = [...selMatch[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]);
    assert.ok(values.length > 0, `${page}'s #${selId} should have at least one <option value="…">`);
    for (const v of values) {
      assert.ok(v in NAV_PAGES, `${page}'s #${selId} option value "${v}" is not a NAV_PAGES key`);
    }
  }
});

test('map.html and other back-office pages use different select ids', () => {
  // Map.html's #viewSel and the other pages' #navSel must not drift apart, or
  // filtering will silently stop working. Assert they exist and are correct.
  const mapHtml = read('map.html');
  assert.match(mapHtml, /id="viewSel"/, 'map.html should carry id="viewSel" for its jump menu');

  const backOfficePages = ['edit.html', 'teams.html', 'reports.html', 'planner.html'];
  for (const page of backOfficePages) {
    const content = read(page);
    assert.match(content, /id="navSel"/, `${page} should carry id="navSel" for its jump menu`);
  }
});

test('the redirect notice is delivered once, then cleared from sessionStorage', async () => {
  const { guardPage, applyRoleNav } = await setupDomTest();
  try {
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
  } finally { teardownDomTest(); }
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
    querySelectorAll: (selector) => [],
  };

  globalThis.sessionStorageData = {};
  globalThis.sessionStorage = {
    getItem: (k) => globalThis.sessionStorageData[k] ?? null,
    setItem: (k, v) => { globalThis.sessionStorageData[k] = v; },
    removeItem: (k) => { delete globalThis.sessionStorageData[k]; },
  };

  // js/nav-roles.js is already imported statically at the top of this file, so
  // this dynamic import does not re-evaluate the module against these fake
  // globals — it returns the cached, already-evaluated module from that static
  // import. It works only because nav-roles.js reads location/document/
  // sessionStorage exclusively inside function bodies, never at module scope;
  // a module-scope DOM read added there later would break these tests
  // confusingly (silently seeing the real, DOM-less globals from the static
  // import instead) rather than being caught by them.
  return import('../js/nav-roles.js');
}

function teardownDomTest() {
  // Clean up globals so they don't leak into other tests
  delete globalThis.location;
  delete globalThis.document;
  delete globalThis.sessionStorage;
  delete globalThis.testNavOptions;
  delete globalThis.testToastMsg;
  delete globalThis.sessionStorageData;
  // A failed assertion above must not leave a non-blank role for whatever test
  // runs next in this file — that is exactly the state the migration-window
  // test exists to protect against.
  store.set('authRole', '');
}

// ── every page mounts it ───────────────────────────────────────────────────
// A Foreman's session expires Monday 04:00 and their remembered role redirects
// them off the capture page. If the sheet is not mounted where they land, they
// have no way to sign in at all.

const PAGES = ['map', 'edit', 'teams', 'reports', 'planner', 'help'];

for (const p of PAGES) {
  test(`${p}.html loads the auth stylesheet`, () => {
    assert.match(read(`${p}.html`), /<link rel="stylesheet" href="css\/auth\.css">/);
  });

  test(`js/pages/${p}.js guards the page and mounts the sign-in sheet`, () => {
    const src = read(`js/pages/${p}.js`);
    assert.match(src, /import\s*\{[^}]*guardPage[^}]*\}\s*from\s*'\.\.\/nav-roles\.js'/);
    assert.match(src, /guardPage\s*\(\s*\)/);
    assert.match(src, /initAuthUI\s*\(\s*\)/);
    assert.match(src, /applyRoleNav\s*\(\s*\)/);
  });
}

test('the capture page guards itself too', () => {
  // index.html is hidden from foreman/backoffice, so it needs the same guard.
  const src = read('js/pages/capture.js');
  assert.match(src, /guardPage\s*\(\s*\)/);
  assert.match(src, /applyRoleNav\s*\(\s*\)/);
});

test('help Back falls back to a page the role can actually open', () => {
  // It hardcoded index.html, which a Foreman cannot open — the guard would
  // bounce them onward, but that is a redirect to nowhere with extra steps.
  const src = read('js/pages/help.js');
  assert.match(src, /landingPage\s*\(\s*\)/);
  assert.doesNotMatch(src, /window\.location\.href\s*=\s*'index\.html'/);
});
