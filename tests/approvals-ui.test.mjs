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
