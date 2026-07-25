# Per-Role Nav and Page Guard Implementation Plan (2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide nav entries a role cannot use, redirect anyone who lands on a page their role cannot open, and make the sign-in sheet reachable from all seven pages instead of only the capture page.

**Architecture:** `js/nav-roles.js` is a thin DOM layer over `canSeePage`/`homePageFor`, which already exist and are already tested. Its one genuinely testable decision — which nav values survive for a given role — is a pure exported function. The bulk of this plan is mounting `initAuthUI()` (from plan 1) plus the guard on the six non-capture pages.

**Tech Stack:** Native ES modules, no build step, no framework. Tests are `node --test "tests/*.test.mjs"`.

Spec: `docs/superpowers/specs/2026-07-25-signin-ui-design.md`
Depends on: plan 1 (`2026-07-25-auth-ui-1-banner-and-sheet.md`) being complete.

## Global Constraints

- **This is inert during the migration window and must stay that way.** `roleAllows` treats a blank role as "allowed everything", and until people sign in that is everybody. Any change that makes a blank role fail a check locks the whole crew out of a production spine.
- **It must work offline.** `authRole` is remembered through expiry on purpose, so the nav stays correct with no signal. Never gate the nav on `state === 'ok'`.
- **The guard redirects; it never blanks a page or blocks capture.** `homePageFor` always returns a page the role can open, so a redirect cannot dead-end. If the destination equals the current page, do nothing — a redirect loop is worse than a wrong nav entry.
- **The role sets are a mirror of `Code.gs`, not a security boundary.** The spine re-checks every request. Do not add a rule here that does not exist there.
- **Adding a module means adding it to `sw.js` `SHELL` and bumping `CACHE`.** Plan 1 left it at `'meterlog-v35'`; this plan adds `js/nav-roles.js`, so it goes to `'meterlog-v36'`.
- Run `node --test "tests/*.test.mjs"` before every commit. ~359 tests are green at the start of this plan.
- **Test totals quoted in steps are approximate.** The gate is: zero failures, and the new tests in that step passing. Do not chase an exact number.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/nav-roles.js` (create) | `NAV_PAGES`, `visibleNavValues` (pure), `currentPage`, `guardPage`, `applyRoleNav`. |
| `js/pages/{map,edit,teams,reports,planner,help}.js` (modify) | Call `guardPage()`, `initAuthUI()`, `applyRoleNav()`. |
| `{map,edit,teams,reports,planner,help}.html` (modify) | Add the `css/auth.css` link. |
| `js/pages/capture.js` (modify) | Call `guardPage()` and `applyRoleNav()` alongside the existing `initAuthUI()`. |
| `js/pages/help.js` (modify) | Back button falls back to `landingPage()`, not a hardcoded `index.html`. |
| `sw.js` (modify) | Add `js/nav-roles.js` to `SHELL`, bump `CACHE` to v36. |
| `tests/nav-roles.test.mjs` (create) | The pure filter for every role, the guard's destination, and the mount wiring. |

---

### Task 1: The nav filter and page guard

**Files:**
- Create: `js/nav-roles.js`
- Test: `tests/nav-roles.test.mjs`

**Interfaces:**
- Consumes: `canSeePage`, `homePageFor` from `js/auth-policy.js`; `role` from `js/auth.js`; `toast` from `js/dom.js`.
- Produces:
  - `NAV_PAGES: {[navValue: string]: string}` — jump-menu `<option>` value → page filename.
  - `visibleNavValues(values: string[], role: string) → string[]` (pure)
  - `currentPage() → string`
  - `guardPage() → boolean` — `true` if the page may be shown, `false` if a redirect was started.
  - `applyRoleNav() → void`

- [ ] **Step 1: Write the failing test**

Create `tests/nav-roles.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nav-roles.test.mjs`
Expected: FAIL — `ENOENT: ... js/nav-roles.js`

- [ ] **Step 3: Write minimal implementation**

Create `js/nav-roles.js`:

```js
// ── Per-role nav hiding and the wrong-page guard ────────────────────────────
// A thin DOM layer over canSeePage/homePageFor in auth-policy.js. It hides links
// a role cannot use, because a menu entry that always answers "not allowed for
// your role" is worse than no entry at all.
//
// IT IS NOT A SECURITY BOUNDARY. The role sets it reads are a mirror of Code.gs
// kept only for this purpose; the spine re-checks every request through
// POST_POLICY/GET_POLICY, which is the only authority.
//
// Two properties are load-bearing:
//   1. A BLANK ROLE SEES EVERYTHING. That is the migration window — until people
//      sign up, it is the entire crew. roleAllows() handles this; do not add a
//      check here that bypasses it.
//   2. It reads the REMEMBERED role, never session validity. authRole survives
//      expiry on purpose so the nav stays correct on a phone with no signal.
import { canSeePage, homePageFor } from './auth-policy.js';
import { role } from './auth.js';
import { toast } from './dom.js';

/** Jump-menu <option> value → the page it opens. `analytics` is map.html#analytics,
 *  so it shares map.html's permission; a value missing from here is left alone. */
export const NAV_PAGES = {
  log:       'index.html',
  map:       'map.html',
  analytics: 'map.html',
  teams:     'teams.html',
  edit:      'edit.html',
  reports:   'reports.html',
  planner:   'planner.html',
  help:      'help.html',
};

/** Pure: which of these nav values a role should still see. An unrecognised value
 *  survives — a new menu entry should appear until someone maps it, not vanish. */
export function visibleNavValues(values, roleName) {
  return (values || []).filter(v => {
    const page = NAV_PAGES[v];
    return !page || canSeePage(page, roleName);
  });
}

/** The current page's filename, defaulting to index.html for a bare directory. */
export function currentPage() {
  const path = (typeof location !== 'undefined' && location.pathname) || '';
  return path.replace(/^.*\//, '') || 'index.html';
}

const REDIRECT_KEY = 'navRedirectMsg';

/** Send someone off a page their role cannot open. Returns false when a redirect
 *  has been started, so a caller can skip loading data it is about to discard.
 *  Never dead-ends: homePageFor always names a page the role can open, and an
 *  equal destination is left alone rather than reloaded forever. */
export function guardPage() {
  const page = currentPage();
  const r = role();
  if (canSeePage(page, r)) return true;
  const dest = homePageFor(r);
  if (!dest || dest === page) return true;
  // The toast has to survive the navigation, so it is handed to the destination.
  try { sessionStorage.setItem(REDIRECT_KEY,
    `That page isn’t part of your role — opened ${dest} instead`); } catch {}
  location.replace(dest);
  return false;
}

/** Drop the nav entries this role cannot use, and deliver any redirect notice. */
export function applyRoleNav() {
  const r = role();
  const sel = document.getElementById('navSel');
  if (sel) {
    for (const opt of [...sel.options]) {
      const page = NAV_PAGES[opt.value];
      if (page && !canSeePage(page, r)) opt.remove();
    }
  }
  const help = document.getElementById('navHelp');
  if (help && !canSeePage('help.html', r)) help.classList.add('hide');
  deliverRedirectNotice();
}

function deliverRedirectNotice() {
  let msg = null;
  try {
    msg = sessionStorage.getItem(REDIRECT_KEY);
    if (msg) sessionStorage.removeItem(REDIRECT_KEY);
  } catch { /* private mode — the redirect still happened, just silently */ }
  if (msg) toast(msg);
}
```

- [ ] **Step 4: Add it to the service worker**

In `sw.js`, bump the cache:

```js
const CACHE = 'meterlog-v36';
```

and add the module beside the other auth files:

```js
  './js/api.js', './js/auth.js', './js/auth-policy.js', './js/auth-ui.js', './js/nav-roles.js',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 372 tests.

- [ ] **Step 6: Commit**

```bash
git add js/nav-roles.js sw.js tests/nav-roles.test.mjs
git commit -m "Add per-role nav filtering and the wrong-page guard"
```

---

### Task 2: Mount the guard and sign-in sheet on the five back-office pages

**Files:**
- Modify: `map.html`, `edit.html`, `teams.html`, `reports.html`, `planner.html`
- Modify: `js/pages/map.js`, `js/pages/edit.js`, `js/pages/teams.js`, `js/pages/reports.js`, `js/pages/planner.js`
- Test: `tests/nav-roles.test.mjs` (append)

**Interfaces:**
- Consumes: `guardPage`, `applyRoleNav` from Task 1; `initAuthUI` from plan 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/nav-roles.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nav-roles.test.mjs`
Expected: FAIL — the stylesheet and import assertions fail for all six pages.

- [ ] **Step 3: Add the stylesheet link to each page**

In each of `map.html`, `edit.html`, `teams.html`, `reports.html`, `planner.html`, add the link immediately after that page's own stylesheet:

- `map.html` after `<link rel="stylesheet" href="css/map.css">`
- `edit.html` after `<link rel="stylesheet" href="css/edit.css">`
- `teams.html` after `<link rel="stylesheet" href="css/teams.css">`
- `reports.html` after `<link rel="stylesheet" href="css/reports.css">`
- `planner.html` after `<link rel="stylesheet" href="css/planner.css">`

The line to add is identical in all five:

```html
<link rel="stylesheet" href="css/auth.css">
```

- [ ] **Step 4: Wire each page module**

In each of `js/pages/map.js`, `edit.js`, `teams.js`, `reports.js`, `planner.js`, add these two imports below the existing `import { ... } from '../api.js';` line:

```js
import { guardPage, applyRoleNav } from '../nav-roles.js';
import { initAuthUI } from '../auth-ui.js';
```

and immediately after the import block — **before any data loading runs**, so a redirect does not fire off reads it is about to throw away — add:

```js
// Role gate first: a redirect here should happen before this page fetches
// anything. Inert during the migration window, when every role is blank.
if (guardPage()) { initAuthUI(); applyRoleNav(); }
```

- [ ] **Step 5: Add the same to the capture page**

In `js/pages/capture.js`, extend the plan-1 import:

```js
import { initAuthUI } from '../auth-ui.js';
import { guardPage, applyRoleNav } from '../nav-roles.js';
```

and change the plan-1 initialisation line near the end of the file to:

```js
// The sign-in banner and the role gate. Mounted last so it paints over a page
// that is already working — it never gates capture for a blank or installer role.
if (guardPage()) { initAuthUI(); applyRoleNav(); }
```

- [ ] **Step 6: Run tests**

The test file written in Step 1 covers `help` as well, and Task 3 is what implements
it — so two cases are expected to be red at the end of *this* task. That is the
intended state, not a failure to fix here.

Run: `node --test tests/nav-roles.test.mjs`
Expected: every `map`/`edit`/`teams`/`reports`/`planner` case passes, plus the capture
case. The two `help.html` / `js/pages/help.js` cases FAIL — Task 3 makes them pass.

Confirm nothing else regressed:

Run: `node --test "tests/*.test.mjs"`
Expected: the only failures are those two `help` cases.

- [ ] **Step 7: Commit**

```bash
git add map.html edit.html teams.html reports.html planner.html \
        js/pages/map.js js/pages/edit.js js/pages/teams.js \
        js/pages/reports.js js/pages/planner.js js/pages/capture.js \
        tests/nav-roles.test.mjs
git commit -m "Mount the sign-in sheet and role guard on the back-office pages"
```

---

### Task 3: The help page, and its Back button

**Files:**
- Modify: `help.html`, `js/pages/help.js`
- Test: `tests/nav-roles.test.mjs` (append)

**Interfaces:**
- Consumes: `guardPage`, `applyRoleNav`, `initAuthUI`, and `landingPage` from `js/auth.js`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/nav-roles.test.mjs`:

```js
test('help Back falls back to a page the role can actually open', () => {
  // It hardcoded index.html, which a Foreman cannot open — the guard would
  // bounce them onward, but that is a redirect to nowhere with extra steps.
  const src = read('js/pages/help.js');
  assert.match(src, /landingPage\s*\(\s*\)/);
  assert.doesNotMatch(src, /window\.location\.href\s*=\s*'index\.html'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/nav-roles.test.mjs`
Expected: FAIL — `landingPage` is not in `js/pages/help.js`.

- [ ] **Step 3: Write the implementation**

In `help.html`, add after `<link rel="stylesheet" href="css/help.css">`:

```html
<link rel="stylesheet" href="css/auth.css">
```

In `js/pages/help.js`, extend the import at the top:

```js
import { $, esc } from '../dom.js';
import { guardPage, applyRoleNav } from '../nav-roles.js';
import { initAuthUI } from '../auth-ui.js';
import { landingPage } from '../auth.js';
```

Add the gate immediately after the imports:

```js
// help.html is open to every role, so this never redirects — it mounts the
// sign-in sheet, which matters because Back can strand someone here.
if (guardPage()) { initAuthUI(); applyRoleNav(); }
```

and change the Back handler (~line 62) from the hardcoded fallback to:

```js
$('backBtn').onclick = () => {
  if(document.referrer && history.length > 1) history.back();
  // No referrer (opened cold, or from the app shell) — go where this role can
  // actually work, not to index.html, which a Foreman would just be bounced off.
  else window.location.href = landingPage();
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 386 tests.

- [ ] **Step 5: Verify in a browser**

Follow `VERIFY.md`, **unregistering the service worker and clearing `caches` first** (the shell is v36 now).

With no session — the migration window — confirm:
1. Every page opens exactly as before; no menu entry has disappeared.
2. The sign-in banner appears on all seven pages.

Then simulate a role. In the console on `map.html`:

```js
localStorage.setItem('authRole', 'installer'); location.reload();
```

Confirm:
3. You are redirected to `index.html`, with a toast explaining why.
4. `index.html`'s nav still works; the sign-in banner is present.

Then:

```js
localStorage.setItem('authRole', 'backoffice'); location.href = 'planner.html';
```

Confirm:
5. You land on `map.html` (back-office's first allowed page), not planner.
6. The jump menu on that page no longer lists Route Planner, Crew & Teams, or Log.

Clean up: `localStorage.removeItem('authRole'); location.reload();` — and confirm the full menu is back.

- [ ] **Step 6: Commit**

```bash
git add help.html js/pages/help.js tests/nav-roles.test.mjs
git commit -m "Mount the role guard on help, and land Back somewhere the role can open"
```

---

### Task 4: Update the docs

**Files:**
- Modify: `AGENTS.md` (§"Frontend module layout"), `HANDOFF.md`

- [ ] **Step 1: Document the module in AGENTS.md**

Add to §"Frontend module layout", beside the `auth-ui.js` entry added in plan 1:

```
`nav-roles.js` — per-role nav hiding (`applyRoleNav`) and the wrong-page redirect
(`guardPage`), over `canSeePage`/`homePageFor`. Mounted on all seven pages. **Inert
while a role is blank** — that is the migration window, and a blank role sees
everything. It reads the *remembered* role, never session validity, so the nav stays
correct on a phone with no signal. Like the role sets it reads, it is UI hiding and
never a security boundary.
```

- [ ] **Step 2: Mark step 2 done in HANDOFF.md**

Under §"Next, in order", record that per-role nav hiding has landed, leaving items 3 and 4.

- [ ] **Step 3: Run the suite and push**

```bash
node --test "tests/*.test.mjs"
git add AGENTS.md HANDOFF.md
git commit -m "Document the role nav and page guard"
git push origin claude/security-scalability-architecture-t142cu
```

---

## Done when

- `node --test "tests/*.test.mjs"` is green at 386.
- All seven pages show the sign-in banner and open the sheet.
- With no role set, every page and every menu entry behaves exactly as before.
- With a role set, unusable menu entries are gone and a wrong page redirects once, with no loop.
- `sw.js` `CACHE` is `meterlog-v36`.
