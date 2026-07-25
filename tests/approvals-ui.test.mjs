// The approvals screen. Only one thing here is a real decision — which buttons a
// row gets — and it is pure so it can be tested directly.
//
// The rules it reflects live in Code.gs and are re-checked there on every action.
// These tests exist so the SCREEN does not offer a button the spine will refuse,
// not to re-implement the spine's authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowControls, initApprovals, openApprovals } from '../js/approvals.js';

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

// ── behavioural DOM tests ────────────────────────────────────────────────────
// The suite above is source-text greps (the brief asked for that, so it stays),
// but none of it would catch a wrong-row bug, a stuck-disabled button, a missing
// confirm(), or a role posted the operator never chose — a regex can't see what
// the code actually DOES with a click. These tests run the real load()/act()
// against a minimal fake DOM, following the fake-globals-before-use pattern in
// tests/nav-roles.test.mjs — extended here because, unlike nav-roles.js,
// approvals.js parses whole HTML strings (insertAdjacentHTML / innerHTML) into
// real elements rather than only touching markup already on the page, so the
// fake document needs to actually parse.
//
// initApprovals() latches its `mounted` flag permanently once called (by
// design — see its own doc comment), and a dynamic import of an
// already-imported module returns the cached, already-evaluated instance (same
// caveat nav-roles.test.mjs notes), so there is no way to get a second, freshly
// mounted sheet later in this process. One fake document is built and mounted
// into ONCE, below, and every test after reuses it — load() fully replaces
// #apprPending/#apprUsers's contents on every call, which is enough isolation
// between scenarios without needing a fresh DOM per test.

// A tiny HTML→element tree, just enough of the DOM API for what approvals.js
// touches: insertAdjacentHTML/innerHTML, classList, dataset, closest(),
// querySelector(All) over id/class/attribute selectors (with a descendant
// combinator), and a <select>'s .value.
const decodeEntities = s => s.replace(/&amp;|&lt;|&gt;|&quot;/g,
  m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[m]));

class FakeText { constructor(text) { this.text = text; } }

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this._value = undefined;
    this._onclick = null;
    const self = this;
    this.classList = {
      _set: () => new Set((self.attrs.get('class') || '').split(/\s+/).filter(Boolean)),
      add(c) { const s = this._set(); s.add(c); self.attrs.set('class', [...s].join(' ')); },
      remove(c) { const s = this._set(); s.delete(c); self.attrs.set('class', [...s].join(' ')); },
      toggle(c, force) {
        const s = this._set(); const has = s.has(c);
        const want = force === undefined ? !has : force;
        if (want) s.add(c); else s.delete(c);
        self.attrs.set('class', [...s].join(' '));
      },
      contains(c) { return this._set().has(c); },
    };
    this.dataset = new Proxy({}, {
      get: (_, prop) => self.attrs.get('data-' + String(prop).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase())),
      set: (_, prop, val) => { self.attrs.set('data-' + String(prop).replace(/[A-Z]/g, ch => '-' + ch.toLowerCase()), String(val)); return true; },
    });
  }
  get id() { return this.attrs.get('id') || ''; }
  get className() { return this.attrs.get('class') || ''; }
  set className(v) { this.attrs.set('class', v); }
  get value() { return this._value !== undefined ? this._value : this._defaultValue(); }
  set value(v) { this._value = v; }
  _defaultValue() {
    if (this.tagName !== 'select') return '';
    const opts = this.children.filter(c => c instanceof FakeElement && c.tagName === 'option');
    const sel = opts.find(o => o.attrs.has('selected'));
    return ((sel || opts[0]) && (sel || opts[0]).attrs.get('value')) || '';
  }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = v; }
  get onclick() { return this._onclick; }
  set onclick(fn) { this._onclick = fn; }
  addEventListener() {}
  get textContent() { return collectText(this); }
  set textContent(v) { this.children = [new FakeText(String(v))]; }
  set innerHTML(html) { this.children = parseHTML(html); for (const c of this.children) c.parentNode = this; }
  get innerHTML() { return ''; }   // never read by approvals.js — write-only here
  insertAdjacentHTML(pos, html) {
    const nodes = parseHTML(html);
    for (const n of nodes) n.parentNode = this;
    if (pos === 'afterbegin') this.children.unshift(...nodes);
    else this.children.push(...nodes);   // 'beforeend' is the only position approvals.js uses
  }
  closest(sel) {
    let node = this;
    while (node) { if (node.matches(sel)) return node; node = node.parentNode; }
    return null;
  }
  matches(sel) { return elementMatchesCompound(this, parseCompound(sel.trim())); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
}

function collectText(node) {
  let s = '';
  for (const c of node.children) s += c instanceof FakeText ? c.text : collectText(c);
  return s;
}

function parseAttrs(raw, map) {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(raw))) map.set(m[1], m[2] !== undefined ? decodeEntities(m[2]) : '');
}

function parseHTML(html) {
  const roots = [];
  const stack = [];
  const append = node => {
    node.parentNode = stack.length ? stack[stack.length - 1] : null;
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
  };
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, closing, tagName, rawAttrs, text] = m;
    if (text != null) { append(new FakeText(decodeEntities(text))); continue; }
    if (closing) { stack.pop(); continue; }
    const el = new FakeElement(tagName.toLowerCase());
    parseAttrs(rawAttrs, el.attrs);
    append(el);
    stack.push(el);
  }
  return roots;
}

// Simple-selector parsing: an optional leading tag, then any mix of #id,
// .class and [attr] / [attr="value"] — enough for every selector approvals.js
// actually uses ('.appr-row', '.appr-role', '.bar', '[data-act]',
// '#approvalsSheet [data-act]', '[data-act="authRevoke"]').
function parseCompound(sel) {
  const tagM = sel.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  const tag = tagM ? tagM[0].toLowerCase() : null;
  const rest = tagM ? sel.slice(tagM[0].length) : sel;
  const parts = rest.match(/(#[-\w]+)|(\.[-\w]+)|(\[[^\]]+\])/g) || [];
  let id = null; const classes = []; const attrs = [];
  for (const p of parts) {
    if (p[0] === '#') id = p.slice(1);
    else if (p[0] === '.') classes.push(p.slice(1));
    else {
      const body = p.slice(1, -1);
      const eq = body.indexOf('=');
      if (eq === -1) attrs.push({ name: body, value: null });
      else attrs.push({ name: body.slice(0, eq), value: body.slice(eq + 1).trim().replace(/^["']|["']$/g, '') });
    }
  }
  return { tag, id, classes, attrs };
}
function elementMatchesCompound(el, c) {
  if (!(el instanceof FakeElement)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    if (!el.attrs.has(a.name)) return false;
    if (a.value !== null && el.attrs.get(a.name) !== a.value) return false;
  }
  return true;
}
function collectDescendants(node, compound, out) {
  for (const child of node.children) {
    if (!(child instanceof FakeElement)) continue;
    if (elementMatchesCompound(child, compound)) out.push(child);
    collectDescendants(child, compound, out);
  }
}
function queryAll(root, sel) {
  const parts = sel.trim().split(/\s+/).map(parseCompound);
  let candidates = [root];
  for (const part of parts) {
    const next = [];
    for (const c of candidates) collectDescendants(c, part, next);
    candidates = next;
  }
  return candidates;
}

function findById(node, id) {
  for (const c of node.children) {
    if (!(c instanceof FakeElement)) continue;
    if (c.id === id) return c;
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

class FakeDocument {
  constructor() { this.body = new FakeElement('body'); }
  getElementById(id) { return findById(this.body, id); }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
}

// A controllable global fetch: GET (apiGet — called with no second arg) and
// POST (apiPost — called with {method:'POST', body}) both go through
// pendingSignups()/authAction() unmodified, so these tests run the REAL client
// code, not a re-implementation of it.
function stubFetch({ getResponse, onPost }) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!opts) return { json: async () => getResponse };
    const body = JSON.parse(opts.body);
    const resp = (onPost && onPost(body)) || { ok: true };
    return { json: async () => resp };
  };
  return () => { globalThis.fetch = orig; };
}

// Mount once. See the block comment above for why this can't be redone per test.
const fakeDoc = new FakeDocument();
globalThis.document = fakeDoc;
initApprovals();

test('DOM: mounted the sheet into the fake document', () => {
  assert.ok(fakeDoc.getElementById('approvalsSheet'), 'the sheet should exist');
  assert.ok(fakeDoc.getElementById('apprPending'));
  assert.ok(fakeDoc.getElementById('apprUsers'));
});

test('DOM: editing the All-accounts copy of a duplicated H# posts THAT row\'s picker', async () => {
  // Reproduces the exact shape of the reported bug: the same H number rendered
  // once in Waiting-for-approval and once in All accounts (pendingAuthRead's
  // `pending` being a filter over `users`, pre-fix-4). The old code read the
  // role picker via a document-wide querySelector keyed only on H number, which
  // always found the FIRST such element — the Waiting-for-approval copy —
  // regardless of which row's Set role button was actually tapped.
  let posted = null;
  const restore = stubFetch({
    getResponse: {
      ok: true, grantable: ['foreman', 'installer'],
      pending: [row({ status: 'pending', role: 'installer' })],
      users:   [row({ status: 'active',  role: 'installer' })],
    },
    onPost: body => { posted = body; return { ok: true }; },
  });
  try {
    await openApprovals();
    const pendingRow = fakeDoc.getElementById('apprPending').querySelector('.appr-row');
    const usersRow   = fakeDoc.getElementById('apprUsers').querySelector('.appr-row');
    assert.ok(pendingRow && usersRow, 'both sections should render a row for this H#');
    assert.equal(pendingRow.querySelector('.appr-role').value, 'installer');

    usersRow.querySelector('.appr-role').value = 'foreman';         // the operator's edit
    await usersRow.querySelector('[data-act="authSetRole"]').onclick();

    assert.equal(posted.role, 'foreman', 'should post the edited (All-accounts) row\'s value');
    assert.equal(pendingRow.querySelector('.appr-role').value, 'installer',
      'the OTHER row must stay untouched — proves the lookup is scoped to the clicked row');
  } finally { restore(); }
});

test('DOM: a failing action re-enables its button', async () => {
  const restore = stubFetch({
    getResponse: { ok: true, grantable: [], pending: [row({ status: 'pending' })], users: [] },
    onPost: () => ({ ok: false, error: 'spine says no' }),
  });
  try {
    await openApprovals();
    const btn = fakeDoc.getElementById('apprPending').querySelector('[data-act="authApprove"]');
    assert.equal(btn.disabled, false);
    await btn.onclick();
    assert.equal(btn.disabled, false, 'a refused action must not leave the button stuck disabled');
  } finally { restore(); }
});

test('DOM: a genuinely duplicated pending entry is not shown twice in #apprUsers', async () => {
  // pendingAuthRead's `pending` really is a filter over `users` — the same
  // record can arrive in both arrays with the SAME status. load() must not
  // render that pending account a second time under "All accounts".
  const restore = stubFetch({
    getResponse: {
      ok: true, grantable: [],
      pending: [row({ status: 'pending' })],
      users:   [row({ status: 'pending' })],
    },
  });
  try {
    await openApprovals();
    assert.equal(fakeDoc.getElementById('apprPending').querySelectorAll('.appr-row').length, 1);
    assert.equal(fakeDoc.getElementById('apprUsers').querySelectorAll('.appr-row').length, 0,
      'a pending account should not also render under All accounts');
  } finally { restore(); }
});

test('DOM: an unexpected throw inside act() still re-enables the button', async () => {
  // The bug this guards against: the one throw path act() used to have
  // (CSS.escape, absent in some legacy WebViews) is gone now that the row-scoped
  // lookup no longer needs it — but the try/finally is meant to survive ANY
  // future addition that throws, not just that one. Simulate a future addition
  // throwing by breaking .closest() on the button itself, independent of
  // CSS.escape entirely.
  const restore = stubFetch({
    getResponse: { ok: true, grantable: [], pending: [row({ status: 'pending' })], users: [] },
  });
  try {
    await openApprovals();
    const btn = fakeDoc.getElementById('apprPending').querySelector('[data-act="authApprove"]');
    btn.closest = () => { throw new Error('simulated failure from a future addition'); };
    await btn.onclick();   // onclick's own .catch swallows the rejection — see fix 2's second half
    assert.equal(btn.disabled, false, 'a thrown error must not leave the button stuck disabled');
  } finally { restore(); }
});

test('DOM: no role is posted when the picker is untouched, and it is when changed', async () => {
  const calls = [];
  const restore = stubFetch({
    getResponse: {
      ok: true, grantable: ['foreman', 'installer'],
      pending: [], users: [row({ status: 'active', role: 'installer' })],
    },
    onPost: body => { calls.push(body); return { ok: true }; },
  });
  try {
    await openApprovals();
    const setRoleBtn1 = fakeDoc.getElementById('apprUsers').querySelector('[data-act="authSetRole"]');
    await setRoleBtn1.onclick();   // picker never touched — still shows 'installer'
    assert.ok(!('role' in calls[0]), 'no role should be posted when the picker was not touched');

    // The action above re-ran load(), which re-rendered the row from scratch —
    // grab fresh elements rather than reusing the (now-superseded) ones above.
    const row2 = fakeDoc.getElementById('apprUsers').querySelector('.appr-row');
    row2.querySelector('.appr-role').value = 'foreman';
    await row2.querySelector('[data-act="authSetRole"]').onclick();
    assert.equal(calls[1].role, 'foreman', 'a real change should be posted');
  } finally { restore(); }
});

test('DOM: Revoke and Reset PIN confirm first, and honour a Cancel', async () => {
  for (const action of ['authRevoke', 'authResetPin']) {
    let postCount = 0;
    const restore = stubFetch({
      getResponse: {
        ok: true, grantable: [],
        pending: [], users: [row({ status: 'active', locked: false, name: 'Dana Reid' })],
      },
      onPost: () => { postCount++; return { ok: true }; },
    });
    const origConfirm = globalThis.confirm;
    const confirmCalls = [];
    globalThis.confirm = msg => { confirmCalls.push(msg); return false; };
    try {
      await openApprovals();
      const btn = fakeDoc.getElementById('apprUsers').querySelector(`[data-act="${action}"]`);
      await btn.onclick();
      assert.equal(postCount, 0, `${action} must not post when confirm() is cancelled`);
      assert.equal(confirmCalls.length, 1, `${action} should ask for confirmation`);
      assert.match(confirmCalls[0], /Dana Reid/, 'the confirm text should name the person');

      globalThis.confirm = () => true;
      await btn.onclick();   // a cancelled confirm never reached load(), so `btn` is still current
      assert.equal(postCount, 1, `${action} should post once confirm() is accepted`);
    } finally {
      globalThis.confirm = origConfirm;
      restore();
    }
  }
});

test('DOM: Approve, Reject, Unlock and Set role do NOT confirm first', async () => {
  // The stub always answers with the same canned lists regardless of what was
  // posted, so the same buttons keep reappearing after each action's reload —
  // good enough to click each one in turn on a fresh, freely re-queried row.
  const restore = stubFetch({
    getResponse: {
      ok: true, grantable: ['installer'],
      pending: [row({ hNumber: 'H1', status: 'pending', role: 'installer' })],
      users:   [row({ hNumber: 'H9', status: 'active', locked: true, role: 'installer' })],
    },
    onPost: () => ({ ok: true }),
  });
  const origConfirm = globalThis.confirm;
  let confirmCalled = false;
  globalThis.confirm = () => { confirmCalled = true; return true; };
  const clickWithoutConfirming = async (containerId, action) => {
    confirmCalled = false;
    const btn = fakeDoc.getElementById(containerId).querySelector(`[data-act="${action}"]`);
    assert.ok(btn, `expected a ${action} button in #${containerId}`);
    await btn.onclick();
    assert.equal(confirmCalled, false, `${action} must not confirm`);
  };
  try {
    await openApprovals();
    await clickWithoutConfirming('apprPending', 'authApprove');
    await clickWithoutConfirming('apprPending', 'authReject');
    await clickWithoutConfirming('apprUsers', 'authUnlock');
    await clickWithoutConfirming('apprUsers', 'authSetRole');
  } finally {
    globalThis.confirm = origConfirm;
    restore();
  }
});
