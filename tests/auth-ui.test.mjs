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
