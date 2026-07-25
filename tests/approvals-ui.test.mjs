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

test('a disabled row offers reject to free the H number, but not approve', () => {
  // A revoked account cannot be approved directly — it would reactivate the old
  // PIN. The way to reinstate is through reject, which wipes the PIN material and
  // frees the H number for a fresh signup and approval.
  const c = rowControls(row({ status: 'disabled' }), ALL_ROLES);
  assert.equal(c.reject, true);
  assert.equal(c.approve, false);
});

test('a reset row offers reject alongside reset-pin, freeing a stalled H number', () => {
  // A stuck reset row can be rejected to free the H number for signup again.
  const c = rowControls(row({ status: 'reset' }), ALL_ROLES);
  assert.equal(c.reject, true);
  assert.equal(c.resetPin, true);
});

test('a rejected row offers neither approve nor reject', () => {
  // A row already rejected is a terminal state; re-rejecting is noise.
  const c = rowControls(row({ status: 'rejected' }), ALL_ROLES);
  assert.equal(c.approve, false);
  assert.equal(c.reject, false);
});

test('an active row still offers no reject', () => {
  // The spine refuses to reject an active row — revoke instead.
  const c = rowControls(row({ status: 'active' }), ALL_ROLES);
  assert.equal(c.reject, false);
});

test('a missing user or a missing grantable list is handled, not thrown on', () => {
  assert.equal(rowControls(null, null).approve, false);
  assert.deepEqual(rowControls(row({}), null).roles, []);
});

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
  // The migration window must reach this screen — it is how the first people are
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

test('reject carries a status-dependent label, because the same action means two different things', () => {
  // 'Reject' reads right on a pending signup; on a reset/disabled row the same
  // authReject call wipes the PIN and frees the H number, which 'Reject' alone
  // would not convey.
  assert.match(src, /pending['"]?\s*:\s*['"]Reject['"]/);
  assert.match(src, /reset['"]?\s*:\s*['"][^'"]+['"]/);
  assert.match(src, /disabled['"]?\s*:\s*['"][^'"]+['"]/);
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
