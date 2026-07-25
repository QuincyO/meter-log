# Sign-in Banner and Sheet Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the capture page a dismissible "not signed in" banner and a sign-in / create-a-PIN sheet built on the `js/auth.js` API that already exists.

**Architecture:** Pure decisions (what the banner says, what each login outcome does to the sheet) go in `js/auth-policy.js` beside `sessionState`/`loginOutcome` and are unit-tested directly. `js/auth-ui.js` is the DOM half: it injects its own banner and sheet markup so it can later mount on any page, and owns its own open/close rather than joining `capture.js`'s `.sheet` machinery. `css/auth.css` is fully self-contained — it must not rely on `capture.css`, because plan 2 mounts this on pages that don't load it.

**Tech Stack:** Native ES modules, no build step, no framework, no package manager. Tests are `node --test "tests/*.test.mjs"`.

Spec: `docs/superpowers/specs/2026-07-25-signin-ui-design.md`

## Global Constraints

- **Login is a banner, never a wall.** Nothing here may block the app opening, block capture, or block a write from being queued. A phone with no signal on a Monday cannot get a session and still has a full day of meters to log.
- **No new markup in `index.html` for the sheet or banner.** `auth-ui.js` injects both. Plan 2 mounts the same module on six more pages; duplicated markup is the drift failure this repo has already been bitten by.
- **`css/auth.css` must not depend on `css/capture.css` or `css/tokens.css`.** Use its own class names (`auth-*`), not the existing `.sheet` / `.card` / `.primary` / `.ghost`.
- **Do not touch `js/queue.js`, `js/store.js` `authFields()`, or anything on the `enqueue()` path.** A write with no valid credential must still queue.
- **Adding a module or stylesheet means adding it to `sw.js` `SHELL` and bumping `CACHE`.** `CACHE` goes from `'meterlog-v34'` to `'meterlog-v35'` in this plan. Later plans in this series must not bump it again unless they add files.
- Roles in `js/auth-policy.js` are a mirror of `Code.gs` and exist only to hide unusable UI. Never a security boundary.
- Run `node --test "tests/*.test.mjs"` before every commit. 333 tests are green at the start of this plan.
- **Test totals quoted in steps are approximate.** The gate is: zero failures, and the new tests in that step passing. Do not chase an exact number.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/auth-policy.js` (modify) | Gains four pure functions: `bannerFor`, `bannerDismissed`, `signInFeedback`, `signUpFeedback`. |
| `css/auth.css` (create) | Banner + sheet styling, self-contained. |
| `js/auth-ui.js` (create) | Injects the banner + sheet, wires them to `js/auth.js`, exports `initAuthUI()` / `openAuthSheet()`. |
| `js/pages/capture.js` (modify) | Imports and calls `initAuthUI()`. |
| `index.html` (modify) | Adds `<link rel="stylesheet" href="css/auth.css">`. |
| `sw.js` (modify) | Adds the two new files to `SHELL`, bumps `CACHE` to v35. |
| `tests/auth-ui.test.mjs` (create) | The four pure functions, plus shell/wiring assertions. |

---

### Task 1: The pure banner and outcome decisions

**Files:**
- Modify: `js/auth-policy.js` (append at end of file)
- Test: `tests/auth-ui.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `bannerFor(state: 'none'|'expired'|'ok', name: string) → {show: boolean, tone: string, text: string, cta: string}`
  - `bannerDismissed(storedDay: string|null, today: string) → boolean`
  - `signInFeedback(out: {kind, message?}) → {close: boolean, mode: 'signin'|'signup'|null, tone: string, text: string}`
  - `signUpFeedback(out: {kind, message?}) → {close: boolean, mode: 'signin'|'signup'|null, tone: string, text: string}`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-ui.test.mjs`:

```js
// The sign-in banner and sheet. The pure half is here in full; the DOM half
// (js/auth-ui.js) is asserted structurally, the same way the tuning screen is.
//
// The property that matters most: none of this can gate the app. A signed-out
// phone with no signal still opens, still captures, still queues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bannerFor, bannerDismissed, signInFeedback, signUpFeedback } from '../js/auth-policy.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ── the banner ─────────────────────────────────────────────────────────────

test('a valid session shows no banner at all', () => {
  assert.equal(bannerFor('ok', 'Dana Reid').show, false);
});

test('never signed in asks plainly, with no name to use', () => {
  const b = bannerFor('none', '');
  assert.equal(b.show, true);
  assert.equal(b.cta, 'Sign in');
  assert.match(b.text, /not signed in/i);
});

test('an expired session names the person, because we still know who they are', () => {
  // authName/authH survive expiry on purpose so the prompt can be personal.
  const b = bannerFor('expired', 'Dana Reid');
  assert.equal(b.show, true);
  assert.match(b.text, /Dana Reid/);
  assert.match(b.text, /new week/i);
});

test('an expired session with no remembered name still reads sensibly', () => {
  const b = bannerFor('expired', '');
  assert.equal(b.show, true);
  assert.doesNotMatch(b.text, /undefined|null|,\s*$/);
});

// ── dismissal is day-scoped ────────────────────────────────────────────────

test('dismissing hides it for that day only', () => {
  assert.equal(bannerDismissed('2026-07-25', '2026-07-25'), true);
  assert.equal(bannerDismissed('2026-07-24', '2026-07-25'), false);
});

test('a missing dismissal reads as "show it"', () => {
  // Same shape as driveRecord's date guard: absent or stale means not dismissed.
  assert.equal(bannerDismissed(null, '2026-07-25'), false);
  assert.equal(bannerDismissed('', '2026-07-25'), false);
});

// ── what each login outcome does to the sheet ──────────────────────────────

test('a good login closes the sheet', () => {
  assert.equal(signInFeedback({ kind: 'ok' }).close, true);
});

test('a reset PIN switches the sheet to create-a-PIN mode', () => {
  // The spine says needsPin; making the person find the signup toggle themselves
  // is the difference between a working reset and a support call.
  const f = signInFeedback({ kind: 'needsPin' });
  assert.equal(f.mode, 'signup');
  assert.equal(f.close, false);
  assert.match(f.text, /reset/i);
});

test('a pending signup says so and says the work still counts', () => {
  const f = signInFeedback({ kind: 'pending' });
  assert.equal(f.close, false);
  assert.match(f.text, /keep logging/i);
});

test('a lockout surfaces the spine message rather than inventing one', () => {
  const f = signInFeedback({ kind: 'locked', message: 'locked until 09:41' });
  assert.equal(f.close, false);
  assert.equal(f.tone, 'error');
  assert.match(f.text, /09:41/);
});

test('offline reassures instead of erroring — this is the offline-Monday moment', () => {
  const f = signInFeedback({ kind: 'offline' });
  assert.equal(f.close, false);
  assert.notEqual(f.tone, 'error');
  assert.match(f.text, /keep logging/i);
});

test('a wrong PIN is an error that keeps the sheet open on the sign-in form', () => {
  const f = signInFeedback({ kind: 'failed', message: 'wrong H number or PIN' });
  assert.equal(f.close, false);
  assert.equal(f.mode, 'signin');
  assert.equal(f.tone, 'error');
});

test('signup that lands active sends them to sign in with the PIN they just set', () => {
  const f = signUpFeedback({ kind: 'active' });
  assert.equal(f.mode, 'signin');
  assert.equal(f.close, false);
});

test('signup that lands pending explains the wait and does not block logging', () => {
  const f = signUpFeedback({ kind: 'pending' });
  assert.match(f.text, /approve/i);
  assert.match(f.text, /keep logging/i);
});

test('a failed signup keeps them on the signup form with the spine reason', () => {
  const f = signUpFeedback({ kind: 'failed', message: 'that H number is not on the roster' });
  assert.equal(f.mode, 'signup');
  assert.equal(f.tone, 'error');
  assert.match(f.text, /roster/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth-ui.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../js/auth-policy.js' does not provide an export named 'bannerFor'`

- [ ] **Step 3: Write minimal implementation**

Append to `js/auth-policy.js`:

```js
// ── What the sign-in UI shows ──────────────────────────────────────────────
// Pure, so the copy and the state machine can be tested without a DOM. The
// rule these serve: login is a banner, never a wall. Every branch below either
// closes the sheet or explains itself — none of them stops anyone working.

/** The banner for a session state. `ok` shows nothing; the other two differ in
 *  that 'expired' still knows who you are, so it can be personal. */
export function bannerFor(state, name) {
  const who = String(name || '').trim();
  if (state === 'ok') return { show: false, tone: '', text: '', cta: '' };
  if (state === 'expired')
    return { show: true, tone: 'warn', cta: 'Sign in',
             text: who ? `New week — sign in again, ${who}` : 'New week — sign in again' };
  return { show: true, tone: 'info', cta: 'Sign in', text: 'Not signed in' };
}

/** Dismissal lasts the calendar day. Same shape as the driveRecord date guard:
 *  a stale or absent date reads as "not dismissed", so this fails toward showing
 *  the banner rather than toward hiding it forever. */
export function bannerDismissed(storedDay, today) {
  return !!storedDay && String(storedDay) === String(today);
}

/** How the sheet reacts to a signIn() result. Switches on the `kind` auth.js
 *  already returns — never on the error prose, which is why loginOutcome exists. */
export function signInFeedback(out) {
  const kind = out && out.kind;
  const msg = (out && out.message) || '';
  if (kind === 'ok')
    return { close: true, mode: null, tone: 'ok', text: '' };
  if (kind === 'needsPin')
    return { close: false, mode: 'signup', tone: 'info',
             text: 'Your PIN was reset — choose a new one' };
  if (kind === 'pending')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'Waiting for approval — you can keep logging meanwhile' };
  if (kind === 'locked')
    return { close: false, mode: 'signin', tone: 'error', text: msg || 'Too many tries — locked for now' };
  if (kind === 'offline')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'No signal — keep logging, your work is saved and will sync' };
  return { close: false, mode: 'signin', tone: 'error', text: msg || 'Wrong H number or PIN' };
}

/** How the sheet reacts to a signUp() result. 'active' means the row had been
 *  approved already (a PIN reset), so the PIN just set works immediately. */
export function signUpFeedback(out) {
  const kind = out && out.kind;
  const msg = (out && out.message) || '';
  if (kind === 'active')
    return { close: false, mode: 'signin', tone: 'ok', text: 'PIN set — sign in now' };
  if (kind === 'pending')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'Signed up — an administrator has to approve you. You can keep logging meanwhile.' };
  if (kind === 'offline')
    return { close: false, mode: 'signup', tone: 'info',
             text: 'No signal — keep logging, your work is saved and will sync' };
  return { close: false, mode: 'signup', tone: 'error', text: msg || 'Could not sign up' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auth-ui.test.mjs`
Expected: PASS, 16 tests.

Then run the whole suite to be sure the mirror drift test still passes — it resolves sets by name, so the additions are inert, but confirm rather than assume:

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 349 tests.

- [ ] **Step 5: Commit**

```bash
git add js/auth-policy.js tests/auth-ui.test.mjs
git commit -m "Decide what the sign-in banner and sheet say"
```

---

### Task 2: The stylesheet

**Files:**
- Create: `css/auth.css`
- Test: `tests/auth-ui.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: the class names `js/auth-ui.js` uses in Task 3 — `.auth-banner`, `.auth-banner.warn`, `.auth-banner-text`, `.auth-mini`, `.auth-dismiss`, `.auth-sheet`, `.auth-card`, `.auth-field`, `.auth-primary`, `.auth-ghost`, `.auth-msg`, `.auth-msg.error`, `.auth-msg.ok`, `.hide`.

- [ ] **Step 1: Write the failing test**

Append to `tests/auth-ui.test.mjs`:

```js
// ── the stylesheet stands alone ────────────────────────────────────────────

test('auth.css defines its own hide and card styling, borrowing nothing', () => {
  // Plan 2 mounts this on reports.html and friends, which never load capture.css.
  // If auth.css leans on .sheet/.card/.primary the sign-in screen renders as
  // unstyled text on five of the seven pages.
  const css = read('css/auth.css');
  for (const cls of ['.auth-banner', '.auth-sheet', '.auth-card', '.auth-primary', '.auth-msg']) {
    assert.ok(css.includes(cls), `css/auth.css should define ${cls}`);
  }
  assert.match(css, /\.auth-sheet\.hide|\.hide\b/, 'auth.css must define its own .hide');
});

test('the sheet is a fixed overlay so it works on a page with any layout', () => {
  const css = read('css/auth.css');
  assert.match(css, /\.auth-sheet\s*\{[^}]*position\s*:\s*fixed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth-ui.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open '.../css/auth.css'`

- [ ] **Step 3: Write minimal implementation**

Create `css/auth.css`:

```css
/* Sign-in banner + sheet. DELIBERATELY SELF-CONTAINED: js/auth-ui.js mounts on
   every page, including reports/map/teams/edit/planner, which do not load
   capture.css. Nothing here may depend on .sheet/.card/.primary/.ghost or on
   the tokens.css variables — colours are literal for the same reason. */

.auth-banner{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:10px 14px;font-size:14px;font-weight:600;
  background:#E8F0FE;border-bottom:1.5px solid #7FA8E8;color:#123A6B}
.auth-banner.warn{background:#FFF3CD;border-bottom-color:#E0B000;color:#7A5800}
.auth-banner.hide{display:none}
.auth-banner-text{flex:1 1 auto;min-width:0}
.auth-banner-actions{display:flex;gap:8px;flex:none;align-items:center}
.auth-mini{font:inherit;font-weight:700;padding:5px 12px;border-radius:8px;cursor:pointer;
  border:1.5px solid currentColor;background:rgba(255,255,255,.65);color:inherit}
.auth-dismiss{background:none;border:none;font-size:17px;cursor:pointer;
  padding:0 2px;color:inherit;opacity:.6}

/* The sheet: a fixed, scrollable overlay. Tapping the backdrop closes it —
   it is dismissible by design, never a gate. */
.auth-sheet{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;
  justify-content:center;background:rgba(0,0,0,.45);overflow-y:auto;padding:0}
.auth-sheet.hide{display:none}
.auth-card{width:100%;max-width:520px;background:#fff;color:#13171C;
  border-radius:16px 16px 0 0;padding:20px 18px 28px;
  font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (min-width:560px){
  .auth-sheet{align-items:center}
  .auth-card{border-radius:16px}
}
.auth-card h2{margin:0 0 6px;font-size:20px}
.auth-lede{margin:0 0 14px;font-size:14px;color:#5A626B}
.auth-card label{display:block;margin:12px 0 4px;font-size:14px;font-weight:600}
.auth-field{width:100%;box-sizing:border-box;padding:12px;font-size:17px;
  border:1.5px solid #C6CCD3;border-radius:10px;background:#fff;color:inherit}
.auth-field:focus{outline:2px solid #3B7DD8;outline-offset:1px}
.auth-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  letter-spacing:.08em}
.auth-primary{width:100%;margin-top:16px;padding:14px;font:inherit;font-weight:700;
  border:none;border-radius:10px;background:#1B5FB8;color:#fff;cursor:pointer}
.auth-primary:disabled{opacity:.55;cursor:default}
.auth-ghost{width:100%;margin-top:10px;padding:11px;font:inherit;font-weight:600;
  border:1.5px solid #C6CCD3;border-radius:10px;background:none;color:inherit;cursor:pointer}
.auth-msg{margin:12px 0 0;padding:10px 12px;border-radius:8px;font-size:14px;
  background:#E8F0FE;color:#123A6B}
.auth-msg.error{background:#FEECEC;color:#7A1A00}
.auth-msg.ok{background:#E6F6EA;color:#14532D}
.auth-msg.hide{display:none}
.auth-note{margin:14px 0 0;font-size:13px;color:#5A626B}
.auth-me{font-size:15px}
.auth-me strong{display:block;font-size:17px;margin-bottom:2px}
.hide{display:none}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auth-ui.test.mjs`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add css/auth.css tests/auth-ui.test.mjs
git commit -m "Add a self-contained stylesheet for the sign-in UI"
```

---

### Task 3: The banner and sheet module

**Files:**
- Create: `js/auth-ui.js`
- Test: `tests/auth-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `bannerFor`, `bannerDismissed`, `signInFeedback`, `signUpFeedback` from Task 1; the class names from Task 2; `auth`, `signIn`, `signUp`, `signOut`, `onAuthChange` from `js/auth.js`; `store` from `js/store.js`; `$`, `toast` from `js/dom.js`; `localDate` from `js/time.js`.
- Produces:
  - `initAuthUI() → void` — injects the DOM once, paints, subscribes. Safe to call on any page and safe to call twice.
  - `openAuthSheet(mode?: 'signin'|'signup') → void`
  - `closeAuthSheet() → void`

- [ ] **Step 1: Write the failing test**

Append to `tests/auth-ui.test.mjs`:

```js
// ── the DOM half ───────────────────────────────────────────────────────────
// Structural assertions, in the style of the tuning-screen tests: they check the
// wiring exists, not that a browser renders it. VERIFY.md covers the real thing.

const ui = read('js/auth-ui.js');

test('the module injects its own markup rather than needing it in the page', () => {
  // This is what lets plan 2 mount it on six more pages without copying markup.
  assert.match(ui, /insertAdjacentHTML|innerHTML\s*=/);
  assert.match(ui, /id="authBanner"/);
  assert.match(ui, /id="authSheet"/);
});

test('the sheet has both modes and a confirm field for signup', () => {
  assert.match(ui, /id="authH"/);
  assert.match(ui, /id="authPin"/);
  assert.match(ui, /id="authPin2"/);
  assert.match(ui, /id="authSubmit"/);
  assert.match(ui, /id="authSwitch"/);
});

test('the PIN fields are 6-digit numeric and masked', () => {
  assert.match(ui, /id="authPin"[^>]*type="password"/);
  assert.match(ui, /id="authPin"[^>]*inputmode="numeric"/);
  assert.match(ui, /id="authPin"[^>]*maxlength="6"/);
});

test('it re-paints on auth change, which is what surfaces a weekend expiry', () => {
  // A session dies at a fixed Monday 04:00 with no request happening; auth.js
  // re-announces on wake, and this is the listener that turns that into a banner.
  assert.match(ui, /onAuthChange\s*\(/);
});

test('it routes outcomes through the tested policy instead of re-deciding', () => {
  assert.match(ui, /signInFeedback/);
  assert.match(ui, /signUpFeedback/);
  assert.match(ui, /bannerFor/);
  assert.match(ui, /bannerDismissed/);
});

test('signing out is offered, and goes through auth.js signOut', () => {
  // signOut() touches only the session keys — the queue, day cache and worklist
  // must survive it, so this must never grow its own storage clearing.
  assert.match(ui, /\bsignOut\b/);
  assert.doesNotMatch(ui, /localStorage\.clear|deleteDatabase|caches\.delete/);
});

test('nothing here gates capture', () => {
  // No redirect, no disabling of the form, no early return that hides the page.
  assert.doesNotMatch(ui, /location\.(replace|assign|href)\s*=/);
  assert.doesNotMatch(ui, /document\.body\.style\.display/);
});

// ── shipping ───────────────────────────────────────────────────────────────

test('the service worker ships the new module and stylesheet', () => {
  const sw = read('sw.js');
  assert.match(sw, /'\.\/js\/auth-ui\.js'/);
  assert.match(sw, /'\.\/css\/auth\.css'/);
});

test('the cache version was bumped, or phones keep the old shell', () => {
  // Deliberately "not v34" rather than "is v35": plans 2 and 3 each add a module
  // and bump again, and a test pinned to an exact version would fail the moment
  // the next plan lands. What matters is that the shell moved past the last
  // release that lacked these files.
  assert.doesNotMatch(read('sw.js'), /const CACHE = 'meterlog-v34'/);
});

test('the capture page loads the stylesheet and initialises the module', () => {
  assert.match(read('index.html'), /<link rel="stylesheet" href="css\/auth\.css">/);
  const capture = read('js/pages/capture.js');
  assert.match(capture, /import\s*\{[^}]*initAuthUI[^}]*\}\s*from\s*'\.\.\/auth-ui\.js'/);
  assert.match(capture, /initAuthUI\s*\(\s*\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth-ui.test.mjs`
Expected: FAIL — `ENOENT: ... js/auth-ui.js`

- [ ] **Step 3: Write minimal implementation**

Create `js/auth-ui.js`:

```js
// ── The sign-in banner and sheet ────────────────────────────────────────────
// The DOM half of per-user auth; every decision it makes lives in the pure
// auth-policy.js beside it. It injects its own markup and ships its own CSS so
// it can mount on any page — a session expires at a fixed Monday 04:00, and the
// person it strands may be on edit.html rather than the capture page.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: login is a banner, never a wall.
// This module may nudge, explain and offer. It may not redirect, disable the
// capture form, or stand between a tap and the offline queue. A phone with no
// signal on a Monday cannot get a session and still has a day of meters to log.
import { $, toast } from './dom.js';
import { store } from './store.js';
import { localDate } from './time.js';
import { auth, signIn, signUp, signOut, onAuthChange } from './auth.js';
import { bannerFor, bannerDismissed, signInFeedback, signUpFeedback } from './auth-policy.js';

const BANNER_HTML = `
<div class="auth-banner hide" id="authBanner">
  <span class="auth-banner-text" id="authBannerText"></span>
  <span class="auth-banner-actions">
    <button class="auth-mini" id="authBannerCta" type="button">Sign in</button>
    <button class="auth-dismiss" id="authBannerX" type="button" aria-label="Dismiss">✕</button>
  </span>
</div>`;

const SHEET_HTML = `
<div class="auth-sheet hide" id="authSheet" role="dialog" aria-modal="true" aria-labelledby="authTitle">
  <div class="auth-card">
    <h2 id="authTitle">Sign in</h2>
    <p class="auth-lede" id="authLede">Your employee number and your 6-digit PIN.</p>

    <div id="authForm">
      <label for="authH">Employee # (H)</label>
      <input id="authH" class="auth-field auth-mono" autocapitalize="characters" autocomplete="username">
      <label for="authPin">PIN</label>
      <input id="authPin" class="auth-field auth-mono" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password">
      <div id="authConfirmWrap" class="hide">
        <label for="authPin2">Confirm PIN</label>
        <input id="authPin2" class="auth-field auth-mono" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password">
      </div>
      <p class="auth-msg hide" id="authMsg"></p>
      <button class="auth-primary" id="authSubmit" type="button">Sign in</button>
      <button class="auth-ghost" id="authSwitch" type="button">New here? Create a PIN</button>
    </div>

    <div id="authMe" class="auth-me hide">
      <p id="authMeText"></p>
      <button class="auth-ghost" id="authSignOut" type="button">Sign out</button>
    </div>

    <p class="auth-note">You can keep logging with no signal. Signing in is only how
      your work reaches the office — nothing you log is ever lost by being signed out.</p>
    <button class="auth-ghost" id="authClose" type="button">Close</button>
  </div>
</div>`;

let mounted = false;
let mode = 'signin';          // 'signin' | 'signup'

/** Mount once, paint, and subscribe. Safe to call on any page and twice. */
export function initAuthUI(){
  if(mounted || typeof document === 'undefined') return;
  mounted = true;

  // The banner sits directly under the page's top bar on every page that has
  // one, so it reads as chrome rather than as part of the form beneath it.
  const bar = document.querySelector('.bar');
  if(bar) bar.insertAdjacentHTML('afterend', BANNER_HTML);
  else document.body.insertAdjacentHTML('afterbegin', BANNER_HTML);
  document.body.insertAdjacentHTML('beforeend', SHEET_HTML);

  $('authBannerCta').onclick = () => openAuthSheet();
  $('authBannerX').onclick   = dismissBanner;
  $('authClose').onclick     = closeAuthSheet;
  $('authSwitch').onclick    = () => setMode(mode === 'signin' ? 'signup' : 'signin');
  $('authSubmit').onclick    = submit;
  $('authSignOut').onclick   = () => { signOut(); setMode('signin'); toast('Signed out'); };

  // Backdrop tap closes. It is dismissible by design.
  $('authSheet').addEventListener('click', e => { if(e.target === $('authSheet')) closeAuthSheet(); });
  // Enter submits from either PIN field.
  for(const id of ['authPin', 'authPin2']){
    $(id).addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });
  }

  onAuthChange(paintBanner);
  paintBanner();
}

export function openAuthSheet(next){
  if(!mounted) return;
  setMode(next || (auth().state === 'ok' ? 'signin' : mode));
  $('authSheet').classList.remove('hide');
}

export function closeAuthSheet(){ if(mounted) $('authSheet').classList.add('hide'); }

// ── banner ─────────────────────────────────────────────────────────────────

function paintBanner(){
  const el = $('authBanner'); if(!el) return;
  const a = auth();
  const b = bannerFor(a.state, a.name);
  const hidden = bannerDismissed(store.get('authBannerDay'), localDate());
  el.className = 'auth-banner ' + (b.tone || '') + ((b.show && !hidden) ? '' : ' hide');
  $('authBannerText').textContent = b.text;
  $('authBannerCta').textContent = b.cta || 'Sign in';
}

function dismissBanner(){
  store.set('authBannerDay', localDate());
  paintBanner();
}

// ── the sheet ──────────────────────────────────────────────────────────────

function setMode(next){
  mode = next === 'signup' ? 'signup' : 'signin';
  const a = auth();
  const signedIn = a.state === 'ok';

  $('authForm').classList.toggle('hide', signedIn);
  $('authMe').classList.toggle('hide', !signedIn);

  if(signedIn){
    $('authTitle').textContent = 'Signed in';
    $('authLede').textContent = 'This device is signed in. Your work syncs under this account.';
    $('authMeText').innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = a.name || a.hNumber || 'Signed in';
    $('authMeText').appendChild(strong);
    $('authMeText').appendChild(
      document.createTextNode(`${a.hNumber || ''}${a.role ? ' · ' + a.role : ''}`));
    return;
  }

  $('authTitle').textContent = mode === 'signup' ? 'Create a PIN' : 'Sign in';
  $('authLede').textContent  = mode === 'signup'
    ? 'Claim your employee number and pick a 6-digit PIN. An administrator approves you before it works.'
    : 'Your employee number and your 6-digit PIN.';
  $('authSubmit').textContent = mode === 'signup' ? 'Create PIN' : 'Sign in';
  $('authSwitch').textContent = mode === 'signup'
    ? 'Already have a PIN? Sign in' : 'New here? Create a PIN';
  $('authConfirmWrap').classList.toggle('hide', mode !== 'signup');

  // Pre-fill from the session we remember, else the H number already in Settings.
  if(!$('authH').value) $('authH').value = auth().hNumber || store.get('hNumber') || '';
}

function say(text, tone){
  const el = $('authMsg');
  el.textContent = text || '';
  el.className = 'auth-msg ' + (tone || '') + (text ? '' : ' hide');
}

async function submit(){
  const h   = $('authH').value.trim();
  const pin = $('authPin').value.trim();
  if(!h){ say('Enter your employee number', 'error'); return; }
  if(!/^\d{6}$/.test(pin)){ say('Your PIN is 6 digits', 'error'); return; }
  if(mode === 'signup' && $('authPin2').value.trim() !== pin){
    say('The two PINs do not match', 'error'); return;
  }

  const btn = $('authSubmit');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
  try {
    const out = mode === 'signup' ? await signUp(h, pin) : await signIn(h, pin);
    const fb  = mode === 'signup' ? signUpFeedback(out) : signInFeedback(out);
    if(fb.close){
      $('authPin').value = ''; $('authPin2').value = '';
      say('', '');
      closeAuthSheet();
      toast(`Signed in as ${auth().name || h}`);
      return;
    }
    // A mode switch is a fresh start for the PIN fields — a reset PIN typed into
    // a signup form would otherwise silently become the new one.
    if(fb.mode && fb.mode !== mode){ $('authPin').value = ''; $('authPin2').value = ''; setMode(fb.mode); }
    say(fb.text, fb.tone);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
```

- [ ] **Step 4: Wire it into the capture page**

In `index.html`, add the stylesheet after the `capture.css` link (line ~19):

```html
<link rel="stylesheet" href="css/capture.css">
<link rel="stylesheet" href="css/auth.css">
<link rel="stylesheet" href="css/drive.css">
```

In `js/pages/capture.js`, add the import beside the other module imports (after the `geocodeOne` import, ~line 23):

```js
import { initAuthUI } from '../auth-ui.js';
```

and call it near the other end-of-file initialisation, immediately before the existing `if(!store.get('name')) setTimeout(...)` line (~line 1678):

```js
// The sign-in banner. Mounted last so it paints over a page that is already
// working — it never gates any of the above.
initAuthUI();
```

In `sw.js`, bump the cache and add both files to `SHELL`:

```js
const CACHE = 'meterlog-v35';
```

add `'./css/auth.css',` to the CSS group:

```js
  './css/help.css', './css/planner.css', './css/drive.css', './css/auth.css',
```

and `'./js/auth-ui.js'` to the shared-JS group:

```js
  './js/api.js', './js/auth.js', './js/auth-policy.js', './js/auth-ui.js',
```

- [ ] **Step 5: Run the tests**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 359 tests, 0 fail.

- [ ] **Step 6: Verify in a browser**

Follow `VERIFY.md`. **Unregister the service worker and clear `caches` first** — a profile that loaded the app before will keep serving the v34 shell and none of this will appear.

Confirm, on `http://localhost:8731/index.html`:
1. The banner reads "Not signed in" with a **Sign in** button.
2. **The capture form works with the banner showing** — pick INSTALLED, fill a WO#, and confirm the Log button is live. This is the whole point; do not skip it.
3. Tapping ✕ hides the banner and it stays hidden on reload.
4. Tapping **Sign in** opens the sheet; the backdrop and Close both dismiss it.
5. With the network throttled to offline, submitting shows "No signal — keep logging…" and **not** an error.

- [ ] **Step 7: Commit**

```bash
git add js/auth-ui.js css/auth.css index.html js/pages/capture.js sw.js tests/auth-ui.test.mjs
git commit -m "Add the sign-in banner and sheet to the capture page"
```

---

### Task 4: Update the docs

**Files:**
- Modify: `AGENTS.md` (§"Frontend module layout")
- Modify: `HANDOFF.md` (§"Next, in order")

**Interfaces:**
- Consumes: everything above. Produces: nothing code-facing.

- [ ] **Step 1: Add the module to AGENTS.md**

In `AGENTS.md` §"Frontend module layout", extend the `auth.js` bullet with a sentence describing `auth-ui.js`:

```
`auth-ui.js` — the sign-in banner + sheet. Injects its own markup and ships its own
self-contained `css/auth.css` because it mounts on every page, not just the capture
one: a session expires at a fixed Monday 04:00 and may strand someone on `edit.html`.
It may nudge and explain but **may never redirect, disable capture, or sit between a
tap and the queue** — login is a banner, never a wall.
```

- [ ] **Step 2: Mark the step done in HANDOFF.md**

Under §"Next, in order", change item 1 to record that the sheet has landed and what is left, keeping the numbering of items 2–4 intact.

- [ ] **Step 3: Run the doc test**

`tests/agent-instructions.test.mjs` asserts things about the instruction files.

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 359 tests.

- [ ] **Step 4: Commit and push**

This repo's deploy model is git, and the branch is `claude/security-scalability-architecture-t142cu`. Push the branch, not `main`.

```bash
git add AGENTS.md HANDOFF.md
git commit -m "Document the sign-in UI module"
git push origin claude/security-scalability-architecture-t142cu
```

---

## Done when

- `node --test "tests/*.test.mjs"` is green at 359.
- The capture page shows a dismissible sign-in banner and a working sign-in / create-a-PIN sheet.
- The capture form is fully usable while signed out, offline, with the banner showing.
- `sw.js` `CACHE` is `meterlog-v35` and both new files are in `SHELL`.
