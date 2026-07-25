# Approvals Screen Implementation Plan (3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the people who hold `R_ONBOARD` a screen that renders the `pendingAuth` queue and runs the six approver actions, reachable from a phone on shift and from the back office.

**Architecture:** `js/approvals.js` follows the same shape as `js/auth-ui.js` — it injects its own markup, reuses `css/auth.css`, and mounts on `index.html` and `reports.html`. Its one real decision, which controls a row gets, is a pure exported function. Everything else is a thin call to `authAction` followed by a re-read: the spine re-checks every rule through `authTarget`, so there is no client-side rule worth duplicating.

**Tech Stack:** Native ES modules, no build step, no framework. Tests are `node --test "tests/*.test.mjs"`.

Spec: `docs/superpowers/specs/2026-07-25-signin-ui-design.md`
Depends on: plans 1 and 2 being complete.

## Global Constraints

- **Duplicate no rule from `Code.gs`.** `manageable` and `grantable` come off the response and are *advisory*; every action is re-checked server-side. The client shows what the server said it may show, and shows the server's refusal verbatim when it turns out to be wrong.
- **Never render a salt or a hash.** `pendingAuthRead` is projected and never sends them; do not add a field that would.
- **A blank role must still reach this screen.** That is the migration window, and it is how the first people get approved: `pendingAuthRead` with no session marks only *installer* rows manageable and returns an empty `grantable`, so the window can approve installers and mint no roles. Hiding the screen from a blank role would deadlock the rollout.
- **This screen is online-only and must say so** rather than failing silently. It never queues; `authAction` returns `{ok:false, error:'offline'}` and that is surfaced.
- **Adding a module means adding it to `sw.js` `SHELL` and bumping `CACHE`.** Plan 2 left it at `'meterlog-v36'`; this plan adds `js/approvals.js`, so it goes to `'meterlog-v37'`.
- Run `node --test "tests/*.test.mjs"` before every commit. ~386 tests are green at the start of this plan.
- **Test totals quoted in steps are approximate.** The gate is: zero failures, and the new tests in that step passing. Do not chase an exact number.

**Status strings, from `Code.gs:67-76`** — use these literals exactly: `'pending'`, `'active'`, `'reset'`, `'rejected'`, `'disabled'`.

---

## File Structure

| File | Responsibility |
|---|---|
| `js/approvals.js` (create) | `rowControls` (pure), `initApprovals()`, `openApprovals()`. Injects its own sheet and nav entry. |
| `css/auth.css` (modify) | Adds the list/row styling the sheet needs. |
| `js/pages/capture.js` (modify) | Calls `initApprovals()`. |
| `js/pages/reports.js` (modify) | Calls `initApprovals()`. |
| `sw.js` (modify) | Adds `js/approvals.js` to `SHELL`, bumps `CACHE` to v37. |
| `tests/approvals-ui.test.mjs` (create) | `rowControls` across statuses and privileges, plus wiring assertions. |

---

### Task 1: Which controls a row gets

**Files:**
- Create: `js/approvals.js` (the pure function only, for now)
- Test: `tests/approvals-ui.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `rowControls(user, grantable) → {approve, reject, resetPin, unlock, revoke, setRole: boolean, roles: string[]}`

  `user` is a row from `pendingAuthRead`: `{hNumber, name, onRoster, status, role, createdAt, approvedAt, approvedBy, lastLoginAt, failCount, locked, lockedUntil, manageable}`.

- [ ] **Step 1: Write the failing test**

Create `tests/approvals-ui.test.mjs`:

```js
// The approvals screen. Only one thing here is a real decision — which buttons a
// row gets — and it is pure so it can be tested directly.
//
// The rules it reflects live in Code.gs and are re-checked there on every action.
// These tests exist so the SCREEN does not offer a button the spine will refuse,
// not to re-implement the spine's authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowControls } from '../js/approvals.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const row = over => Object.assign({
  hNumber: 'H1234', name: 'Dana Reid', onRoster: true, status: 'pending',
  role: 'installer', locked: false, failCount: 0, manageable: true,
}, over);

const ALL_ROLES = ['owner', 'admin', 'foreman', 'backoffice', 'installer'];

test('a row this administrator may not touch gets no buttons at all', () => {
  // manageableRoles is the bound that stopped Back-Office resetting the Owner's
  // PIN and walking in as Owner. The screen must not offer what it closed.
  const c = rowControls(row({ manageable: false }), ALL_ROLES);
  assert.equal(c.approve, false);
  assert.equal(c.reject, false);
  assert.equal(c.resetPin, false);
  assert.equal(c.revoke, false);
  assert.equal(c.setRole, false);
  assert.deepEqual(c.roles, []);
});

test('a pending signup can be approved or rejected, and nothing else', () => {
  const c = rowControls(row({ status: 'pending' }), ALL_ROLES);
  assert.equal(c.approve, true);
  assert.equal(c.reject, true);
  assert.equal(c.resetPin, false);   // the spine refuses: approve or reject first
});

test('an active account can have its PIN reset or be revoked, not approved again', () => {
  const c = rowControls(row({ status: 'active' }), ALL_ROLES);
  assert.equal(c.approve, false);
  assert.equal(c.reject, false);     // the spine says "revoke instead of rejecting"
  assert.equal(c.resetPin, true);
  assert.equal(c.revoke, true);
});

test('a reset row can be reset again but not re-approved', () => {
  const c = rowControls(row({ status: 'reset' }), ALL_ROLES);
  assert.equal(c.resetPin, true);
  assert.equal(c.approve, false);
});

test('an already-revoked account is not offered revoke again', () => {
  const c = rowControls(row({ status: 'disabled' }), ALL_ROLES);
  assert.equal(c.revoke, false);
  assert.equal(c.setRole, false);
});

test('unlock appears only while they are actually locked out', () => {
  assert.equal(rowControls(row({ status: 'active', locked: true }), ALL_ROLES).unlock, true);
  assert.equal(rowControls(row({ status: 'active', locked: false }), ALL_ROLES).unlock, false);
});

test('back-office can approve an installer even though it can grant no roles', () => {
  // THE IMPORTANT ONE. grantableRoles is empty for Back-Office, and the spine only
  // vets a role CHANGE — so the screen must still offer Approve, or onboarding
  // stalls whenever no owner/admin is on shift.
  const c = rowControls(row({ status: 'pending' }), []);
  assert.equal(c.approve, true);
  assert.equal(c.setRole, false);
  assert.deepEqual(c.roles, []);
});

test('the role picker offers exactly what the spine said is grantable', () => {
  const c = rowControls(row({ status: 'active' }), ['foreman', 'installer']);
  assert.equal(c.setRole, true);
  assert.deepEqual(c.roles, ['foreman', 'installer']);
});

test('a missing user or a missing grantable list is handled, not thrown on', () => {
  assert.equal(rowControls(null, null).approve, false);
  assert.deepEqual(rowControls(row({}), null).roles, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approvals-ui.test.mjs`
Expected: FAIL — `ENOENT: ... js/approvals.js`

- [ ] **Step 3: Write minimal implementation**

Create `js/approvals.js` with just the pure function for now:

```js
// ── The approvals screen ────────────────────────────────────────────────────
// Renders the pendingAuth queue and runs the six approver actions. Mounted on
// index.html (an owner/admin approving from a phone on shift) and reports.html
// (Back-Office, who holds R_ONBOARD but cannot open the capture page).
//
// IT DUPLICATES NO RULE FROM Code.gs. `manageable` and `grantable` ride in on the
// response and are advisory; every action is re-checked server-side through
// authTarget. The screen shows what the spine said it may show, and shows the
// spine's refusal verbatim when that turns out to be wrong.

/** Which controls a row gets. Pure. Mirrors what the spine will actually accept,
 *  so the screen never offers a button that is guaranteed to be refused —
 *  which is a UI concern, not a security one. */
export function rowControls(user, grantable) {
  const roles = Array.isArray(grantable) ? grantable : [];
  if (!user || !user.manageable)
    return { approve: false, reject: false, resetPin: false, unlock: false,
             revoke: false, setRole: false, roles: [] };
  const status = String(user.status || '').trim();
  return {
    approve:  status === 'pending',
    // authReject refuses an active row outright ("revoke instead of rejecting").
    reject:   status === 'pending',
    // authResetPin refuses anything not already approved, to avoid parking a
    // pending row in 'reset' — where the next signup activates unapproved.
    resetPin: status === 'active' || status === 'reset',
    unlock:   !!user.locked,
    revoke:   status !== 'disabled',
    setRole:  roles.length > 0 && status !== 'disabled',
    roles:    roles,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/approvals-ui.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add js/approvals.js tests/approvals-ui.test.mjs
git commit -m "Decide which approver controls each account row gets"
```

---

### Task 2: The sheet, its styling, and the nav entry

**Files:**
- Modify: `js/approvals.js`
- Modify: `css/auth.css`
- Test: `tests/approvals-ui.test.mjs` (append)

**Interfaces:**
- Consumes: `rowControls` from Task 1; `pendingSignups`, `authAction`, `role`, `onAuthChange` from `js/auth.js`; `R_ONBOARD`, `roleAllows` from `js/auth-policy.js`; `$`, `esc`, `attr`, `toast` from `js/dom.js`.
- Produces:
  - `initApprovals() → void` — injects the sheet and a nav entry, shown only to `R_ONBOARD`. Safe to call twice and on any page.
  - `openApprovals() → void`

- [ ] **Step 1: Write the failing test**

Append to `tests/approvals-ui.test.mjs`:

```js
// ── the DOM half ───────────────────────────────────────────────────────────

const src = read('js/approvals.js');

test('it reads the queue and posts the six approver actions', () => {
  assert.match(src, /pendingSignups\s*\(/);
  for (const a of ['authApprove', 'authReject', 'authSetRole',
                   'authResetPin', 'authUnlock', 'authRevoke']) {
    assert.ok(src.includes(a), `should offer ${a}`);
  }
});

test('the entry is gated on R_ONBOARD, and a blank role passes', () => {
  // The migration window must reach this screen — it is how the first people get
  // approved. roleAllows lets a blank role through; do not add a check that does not.
  assert.match(src, /R_ONBOARD/);
  assert.match(src, /roleAllows\s*\(/);
});

test('it escapes what it renders, because names come off a sheet', () => {
  assert.match(src, /\besc\b/);
});

test('it re-reads after every action rather than patching its own list', () => {
  // The spine may refuse or partially apply; the list it returns is the truth.
  assert.match(src, /await\s+load\s*\(|load\s*\(\s*\)/);
});

test('it never renders credential material', () => {
  assert.doesNotMatch(src, /pinHash|pinSalt|pinIters/);
});

test('offline is surfaced, not swallowed', () => {
  assert.match(src, /offline/i);
});

test('the service worker ships it and the cache was bumped', () => {
  // Not pinned to an exact version, for the same reason as the other two suites:
  // a version-pinned assertion breaks whenever the next change bumps the shell.
  const sw = read('sw.js');
  assert.match(sw, /'\.\/js\/approvals\.js'/);
  assert.doesNotMatch(sw, /const CACHE = 'meterlog-v3[456]'/);
});

test('both mount points initialise it', () => {
  // index.html for owner/admin on a phone; reports.html because Back-Office holds
  // R_ONBOARD but cannot open the capture page at all.
  for (const p of ['capture', 'reports']) {
    const page = read(`js/pages/${p}.js`);
    assert.match(page, /import\s*\{[^}]*initApprovals[^}]*\}\s*from\s*'\.\.\/approvals\.js'/,
      `js/pages/${p}.js should import initApprovals`);
    assert.match(page, /initApprovals\s*\(\s*\)/, `js/pages/${p}.js should call initApprovals`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/approvals-ui.test.mjs`
Expected: FAIL — `pendingSignups` is not in `js/approvals.js`.

- [ ] **Step 3: Append the DOM half to `js/approvals.js`**

Add the imports at the top of the file, above the `rowControls` comment block:

```js
import { $, esc, attr, toast } from './dom.js';
import { pendingSignups, authAction, role, onAuthChange } from './auth.js';
import { R_ONBOARD, roleAllows } from './auth-policy.js';
```

and append below `rowControls`:

```js
const SHEET_HTML = `
<div class="auth-sheet hide" id="approvalsSheet" role="dialog" aria-modal="true" aria-labelledby="apprTitle">
  <div class="auth-card">
    <h2 id="apprTitle">Approvals</h2>
    <p class="auth-lede">Who is waiting to be let in, and every account already set up.</p>
    <p class="auth-msg hide" id="apprMsg"></p>
    <h3 class="appr-head">Waiting for approval</h3>
    <div id="apprPending"></div>
    <h3 class="appr-head">All accounts</h3>
    <div id="apprUsers"></div>
    <button class="auth-ghost" id="apprRefresh" type="button">Refresh</button>
    <button class="auth-ghost" id="apprClose" type="button">Close</button>
  </div>
</div>`;

let mounted = false;
let grantable = [];

/** Mount the sheet and a nav entry. The entry is shown only to R_ONBOARD — and a
 *  blank role passes, which is deliberate: that is the migration window, where the
 *  spine marks only installer rows manageable and grants no roles at all. Hiding
 *  it there would leave nobody able to approve the first people. */
export function initApprovals(){
  if(mounted || typeof document === 'undefined') return;
  mounted = true;
  document.body.insertAdjacentHTML('beforeend', SHEET_HTML);
  $('apprClose').onclick   = () => $('approvalsSheet').classList.add('hide');
  $('apprRefresh').onclick = load;
  $('approvalsSheet').addEventListener('click', e => {
    if(e.target === $('approvalsSheet')) $('approvalsSheet').classList.add('hide');
  });
  mountEntry();
  onAuthChange(paintEntry);
}

export function openApprovals(){
  if(!mounted) return;
  $('approvalsSheet').classList.remove('hide');
  load();
}

// ── the nav entry ──────────────────────────────────────────────────────────
// index.html has a ☰ menu; the back-office pages have a jump <select> that would
// navigate on pick, so those get a plain button in the bar instead.

function mountEntry(){
  const menu = document.getElementById('navMenu');
  if(menu){
    menu.insertAdjacentHTML('beforeend',
      '<button id="navApprovals" class="hide">✅ Approvals</button>');
  } else {
    const bar = document.querySelector('.bar');
    if(!bar) return;
    bar.insertAdjacentHTML('beforeend',
      '<button id="navApprovals" class="auth-mini hide" type="button">✅ Approvals</button>');
  }
  $('navApprovals').onclick = () => {
    const m = document.getElementById('navMenu');
    if(m) m.classList.add('hide');
    openApprovals();
  };
  paintEntry();
}

function paintEntry(){
  const el = document.getElementById('navApprovals');
  if(el) el.classList.toggle('hide', !roleAllows(R_ONBOARD, role()));
}

// ── loading and rendering ──────────────────────────────────────────────────

function say(text, tone){
  const el = $('apprMsg');
  el.textContent = text || '';
  el.className = 'auth-msg ' + (tone || '') + (text ? '' : ' hide');
}

async function load(){
  say('Loading…', '');
  const d = await pendingSignups();
  if(!d || !d.ok){
    const err = (d && d.error) || 'could not load';
    // This screen never queues — it is online-only by nature, and says so.
    say(err === 'offline'
      ? 'No signal — approvals need a connection. Everything else still works offline.'
      : err, 'error');
    return;
  }
  say('', '');
  grantable = d.grantable || [];
  const pending = d.pending || [];
  $('apprPending').innerHTML = pending.length
    ? pending.map(rowHTML).join('')
    : '<p class="appr-empty">Nobody is waiting.</p>';
  $('apprUsers').innerHTML = (d.users || []).map(rowHTML).join('')
    || '<p class="appr-empty">No accounts yet.</p>';
  for(const btn of document.querySelectorAll('#approvalsSheet [data-act]')){
    btn.onclick = () => act(btn.dataset.act, btn.dataset.h, btn);
  }
}

function rowHTML(u){
  const c = rowControls(u, grantable);
  const h = attr(u.hNumber);
  const bits = [];
  if(c.setRole){
    bits.push(`<select class="auth-field appr-role" data-role-for="${h}">`
      + c.roles.map(r =>
          `<option value="${attr(r)}"${r === u.role ? ' selected' : ''}>${esc(r)}</option>`).join('')
      + '</select>');
  }
  const btn = (act, label) => `<button class="auth-mini" data-act="${act}" data-h="${h}">${label}</button>`;
  if(c.approve)  bits.push(btn('authApprove',  'Approve'));
  if(c.reject)   bits.push(btn('authReject',   'Reject'));
  if(c.setRole)  bits.push(btn('authSetRole',  'Set role'));
  if(c.resetPin) bits.push(btn('authResetPin', 'Reset PIN'));
  if(c.unlock)   bits.push(btn('authUnlock',   'Unlock'));
  if(c.revoke)   bits.push(btn('authRevoke',   'Revoke'));

  const meta = [
    esc(u.hNumber),
    u.onRoster ? '' : 'not on the roster',
    esc(u.status || ''),
    esc(u.role || ''),
    u.locked ? 'locked' : '',
    u.lastLoginAt ? 'last in ' + esc(u.lastLoginAt) : '',
  ].filter(Boolean).join(' · ');

  return `<div class="appr-row">
    <div class="appr-who"><strong>${esc(u.name || u.hNumber)}</strong>
      <span class="appr-meta">${meta}</span></div>
    <div class="appr-actions">${bits.join('') || '<span class="appr-meta">view only</span>'}</div>
  </div>`;
}

async function act(action, hNumber, btn){
  btn.disabled = true;
  const extra = {};
  // A role picker on the row rides along: authApprove treats an unchanged role as
  // no grant at all, which is what lets Back-Office approve without granting.
  const sel = document.querySelector(`[data-role-for="${CSS.escape(hNumber)}"]`);
  if(sel && (action === 'authApprove' || action === 'authSetRole')) extra.role = sel.value;
  const resp = await authAction(action, hNumber, extra);
  btn.disabled = false;
  if(!resp || !resp.ok){
    const err = (resp && resp.error) || 'that did not work';
    // Shown verbatim: the spine is the authority, and its refusal is the reason.
    toast(err === 'offline' ? 'No signal — approvals need a connection' : err);
    return;
  }
  toast('Done ✓');
  await load();
}
```

- [ ] **Step 4: Add the row styling to `css/auth.css`**

Append:

```css
/* Approvals list */
.appr-head{margin:20px 0 6px;font-size:15px;font-weight:700}
.appr-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;
  justify-content:space-between;padding:10px 0;border-top:1px solid #E3E7EB}
.appr-who{min-width:0;flex:1 1 55%}
.appr-who strong{display:block;font-size:15px}
.appr-meta{font-size:13px;color:#5A626B}
.appr-actions{display:flex;flex-wrap:wrap;gap:6px;flex:0 1 auto}
.appr-actions .auth-mini{border-color:#C6CCD3;background:#F4F6F8;color:#13171C}
.appr-role{width:auto;padding:6px 8px;font-size:14px}
.appr-empty{margin:6px 0;font-size:14px;color:#5A626B}
```

- [ ] **Step 5: Wire both mount points and the service worker**

In `js/pages/capture.js`, add beside the plan-2 imports:

```js
import { initApprovals } from '../approvals.js';
```

and extend the plan-2 initialisation line:

```js
if (guardPage()) { initAuthUI(); applyRoleNav(); initApprovals(); }
```

In `js/pages/reports.js`, add the same import and extend its plan-2 line identically.

In `sw.js`, bump the cache and add the module:

```js
const CACHE = 'meterlog-v37';
```

```js
  './js/api.js', './js/auth.js', './js/auth-policy.js', './js/auth-ui.js',
  './js/nav-roles.js', './js/approvals.js',
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 402 tests.

- [ ] **Step 7: Verify against a test deployment**

**Do not do this against the production Sheet.** Follow `VERIFY.md` §"exercising write paths without writing to the production Sheet" — auth actions write real rows. Point `js/config.js` at a test deployment over a copy of the Sheet, and run `setupSheets()` once there so the `Auth` tab exists with `lastFailAt`.

Unregister the service worker and clear `caches` first (the shell is v37 now).

1. With no session, open `index.html` → ☰ → **Approvals** is listed (the migration window can approve installers).
2. It loads and shows "Nobody is waiting."
3. Sign up a test H number from the sign-in sheet, reopen Approvals, confirm the row appears with **Approve** and **Reject** and no role picker.
4. Approve it, then sign in as that H number and confirm the session works.
5. On `reports.html`, confirm the **Approvals** button appears in the bar and opens the same screen.
6. Set `localStorage.setItem('authRole','installer')` and reload: the Approvals entry is gone from both pages.
7. Offline: open Approvals and confirm it says approvals need a connection, and that **capture still works** on `index.html`.

- [ ] **Step 8: Commit**

```bash
git add js/approvals.js css/auth.css js/pages/capture.js js/pages/reports.js \
        sw.js tests/approvals-ui.test.mjs
git commit -m "Add the approvals screen for the onboarding queue"
```

---

### Task 3: Docs, and retire the handoff

**Files:**
- Modify: `AGENTS.md`, `HANDOFF.md`, `USER-GUIDE.md`
- Test: `tests/agent-instructions.test.mjs` (existing)

- [ ] **Step 1: Document the module in AGENTS.md**

Add to §"Frontend module layout", beside `auth-ui.js` and `nav-roles.js`:

```
`approvals.js` — the onboarding queue screen over the `pendingAuth` read, mounted on
`index.html` (owner/admin approving from a phone on shift) and `reports.html`
(Back-Office holds R_ONBOARD but cannot open the capture page). **It duplicates no
rule from `Code.gs`** — `manageable`/`grantable` ride in on the response and are
advisory; every action is re-checked through `authTarget`, and the spine's refusal is
shown verbatim. A blank role reaches it on purpose: that is the migration window,
where only installer rows are manageable and no role can be granted.
```

- [ ] **Step 2: Add a section to the user guide**

`help.html` renders `USER-GUIDE.md` through a markdown *subset* (`js/pages/help.js`) — headings, lists, `**bold**`, `` `code` ``. Keep inside it. Add a short section covering: signing in with your H number and 6-digit PIN, that the banner is only a reminder and the app works signed out, and that a new PIN needs an administrator's approval.

- [ ] **Step 3: Retire HANDOFF.md**

`HANDOFF.md` says it is transient and gets deleted when Phase 1 ships. Phase 1's *client* work is now done, but the rollout (item 4 — flipping `REQUIRE_AUTH` and rotating `SHARED_TOKEN`, per `DEPLOY.md`) has not happened. **Do not delete it yet.** Update §"Next, in order" so item 4 is all that remains, and note that items 1–3 landed.

- [ ] **Step 4: Run the suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS, 402 tests.

- [ ] **Step 5: Commit and push**

```bash
git add AGENTS.md HANDOFF.md USER-GUIDE.md
git commit -m "Document the approvals screen and the sign-in flow"
git push origin claude/security-scalability-architecture-t142cu
```

---

## Done when

- `node --test "tests/*.test.mjs"` is green at 402.
- `R_ONBOARD` roles — and a blank role — can open Approvals from `index.html` and `reports.html`; an installer cannot see it.
- A signup can be approved end-to-end against a **test** deployment, and the approved person can then sign in.
- Offline, the screen explains itself and capture still works.
- `sw.js` `CACHE` is `meterlog-v37`.

---

## What remains after this plan

Only the rollout, which is `DEPLOY.md`'s: run `setupSheets()`, set the three Script
Properties, bootstrap the first Owner with `makeOwner()`, get people signed up during
the migration window, then flip `REQUIRE_AUTH` to `'true'` and rotate `SHARED_TOKEN`.
Flipping it back is the rollback and needs no redeploy.

Still owed from the foundation work, unrelated to these three plans:
`tests/session-monday.test.mjs`.
