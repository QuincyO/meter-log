// Executes the real auth ACTIONS from Code.gs — signup, login, the wrong-PIN ladder
// and the approver actions — against Apps Script stubs and an in-memory Sheet.
//
// Same reasoning as tests/auth-gate.test.mjs, and the same reason it runs the code
// instead of asserting on its text: these handlers mint and revoke the credentials
// for a production spine ~200 people depend on. A content assertion can tell you a
// check is written; only running it tells you the check holds. The properties that
// matter most are the two escalation paths — a signup must never overwrite a live
// credential, and Back-Office must never be able to reset the Owner's PIN.
//
// Toronto is forced before anything reads a clock: Code.gs formats timestamps in
// TIMEZONE but parses them back with a component-wise `new Date(y, m, d, …)`, which
// reads as HOST-local. That round-trip is only exact when the two agree, which in
// Apps Script they do (the script timezone IS Toronto) and here they must be made to.
process.env.TZ = 'America/Toronto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function grab(re, label) {
  const m = CODE.match(re);
  assert.ok(m, `could not lift ${label} out of Code.gs — did it move or get renamed?`);
  return m[0];
}

// One contiguous constants block and one contiguous implementation block, so the
// lift stays a lift rather than a re-listing of every function that could drift.
const SRC = [
  grab(/const TIMEZONE\s*= [^\n]*/, 'TIMEZONE'),
  grab(/const SHARED_TOKEN\s*= [^\n]*/, 'SHARED_TOKEN'),
  grab(/const AUTH_HEADERS = \[[\s\S]*?const PIN_ITERS_DEFAULT = \d+;/, 'the auth constants'),
  grab(/function parseLocal\(s\) \{[\s\S]*?\n\}/, 'parseLocal'),
  grab(/function localMs\(v\) \{[\s\S]*?\n\}/, 'localMs'),
  grab(/function scriptProp\(name\) \{[\s\S]*?\nfunction pendingAuthRead\(sess\) \{[\s\S]*?\n\}/,
       'the auth implementation'),
].join('\n');

// ── Apps Script stubs ──────────────────────────────────────────────────────
// A fake Sheet keyed by tab name, plus just enough of Utilities/CacheService/
// LockService for the real code to run unmodified.
function spine(opts = {}) {
  const props = Object.assign({ PIN_PEPPER: 'test-pepper', SESSION_SECRET: 'test-secret' },
                              opts.props || {});
  const store = { Auth: [], Employees: (opts.employees || []).map(e => ({ ...e })) };

  const factory = new Function('PROPS', 'STORE', 'HMAC', 'FMT', `
    const cacheStore = new Map();
    const PropertiesService = { getScriptProperties: () => ({ getProperty: k => PROPS[k] || null }) };
    const CacheService = { getScriptCache: () => ({
      get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put: (k, v) => cacheStore.set(k, v),
      remove: k => cacheStore.delete(k),
    }) };
    let locks = 0;
    const LockService = { getScriptLock: () => ({
      tryLock: () => { locks++; return true; },
      releaseLock: () => { locks--; },
    }) };
    const SpreadsheetApp = { getActiveSpreadsheet: () => ({
      getSheetByName: n => (STORE[n] ? { name: n } : null),
    }) };
    const Utilities = {
      computeHmacSha256Signature: (data, key) => HMAC(data, key),
      base64Encode: b => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
      base64DecodeWebSafe: s => Array.from(Buffer.from(String(s), 'base64url')),
      newBlob: s => ({ getBytes: () => Array.from(Buffer.from(String(s), 'utf8')),
                       getDataAsString: () => Buffer.from(s).toString('utf8') }),
      formatDate: (d, tz, f) => FMT(d, tz, f),
    };
    const Logger = { log: () => {} };

    // Sheet plumbing the auth code leans on. rows() hands back copies so a handler
    // mutating what it read cannot silently edit the store.
    function rows(tab) { return (STORE[tab] || []).map(r => ({ ...r })); }
    function bustRows() {}
    function scriptCache() { return CacheService.getScriptCache(); }
    function ensureTab(ss, name, headers) {
      if (!STORE[name]) STORE[name] = [];
      STORE[name].HEADERS = headers;
    }
    function upsertByHeader(tab, keyField, keyValue, fields) {
      if (!STORE[tab]) STORE[tab] = [];
      const hit = STORE[tab].find(r =>
        String(r[keyField] ?? '').trim() === String(keyValue ?? '').trim());
      if (hit) { Object.assign(hit, fields); return { created: false }; }
      const row = {};
      AUTH_HEADERS.forEach(h => { row[h] = ''; });
      STORE[tab].push(Object.assign(row, fields));
      return { created: true };
    }
    function employeesList() { return STORE.Employees.map(e => ({ ...e })); }
    function employeeByH(h) {
      return STORE.Employees.find(e => String(e.hNumber).trim() === String(h).trim()) || null;
    }
    function nameOfH(h) {
      const e = employeeByH(h);
      return e ? (e.firstName + ' ' + e.lastName).trim() : '';
    }
    function previewDailyLog() { return { ok: true }; }
    function now() { return FMT(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); }

    ${SRC}

    return { authSignup, authLogin, authApprove, authReject, authSetRole, authResetPin,
             authUnlock, authRevoke, pendingAuthRead, verifySession, makeOwner,
             manageableRoles, grantableRoles, authenticate,
             UNLOCKED_POST, POST_POLICY, GET_POLICY,
             heldLocks: () => locks, wipeCache: () => cacheStore.clear(),
             row: h => STORE.Auth.find(r => String(r.hNumber).trim() === h) || null,
             setRow: (h, f) => Object.assign(STORE.Auth.find(r => r.hNumber === h), f) };
  `);
  return factory(props, store, hmac, formatDate);
}

const hmac = (data, key) => {
  const buf = Array.isArray(data) ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
  return Array.from(createHmac('sha256', Buffer.from(String(key), 'utf8')).update(buf).digest());
};

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function formatDate(d, tz, fmt) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz === 'UTC' ? 'UTC' : 'America/Toronto', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  if (fmt === 'u') return String(DOW.indexOf(p.weekday) + 1);
  return fmt.replace('yyyy-MM-dd', `${p.year}-${p.month}-${p.day}`)
            .replace('HH:mm:ss', `${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const CREW = [
  { hNumber: 'H1', firstName: 'Owen',  lastName: 'Boss',   active: true },
  { hNumber: 'H2', firstName: 'Adele', lastName: 'Minn',   active: true },
  { hNumber: 'H3', firstName: 'Bo',    lastName: 'Office', active: true },
  { hNumber: 'H4', firstName: 'Ina',   lastName: 'Staller', active: true },
  { hNumber: 'H5', firstName: 'Fern',  lastName: 'Man',    active: true },
];
const PIN = '284917', PIN2 = '736154';
const sess = (h, role) => ({ h, role });

/** A spine with an owner, an admin, a back-office and an active installer — built
 *  the way a real one is: makeOwner from the editor, the Owner picks a PIN, then
 *  everyone else signs up and is approved. */
function staffed() {
  const api = spine({ employees: CREW });
  api.makeOwner('H1');
  assert.equal(api.authSignup({ hNumber: 'H1', pin: PIN }).status, 'active');
  for (const [h, role] of [['H2', 'admin'], ['H3', 'backoffice'], ['H4', 'installer']]) {
    assert.ok(api.authSignup({ hNumber: h, pin: PIN }).ok);
    assert.ok(api.authApprove({ hNumber: h, role }, sess('H1', 'owner')).ok);
  }
  return api;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

test('the first Owner can actually get in', () => {
  // The whole rollout starts here: makeOwner() from the script editor, then that
  // person sets a PIN like everyone else. makeOwner deliberately writes no PIN — it
  // proves ownership of the script, not knowledge of a credential — so the row it
  // leaves behind MUST be one that authSignup will accept.
  const api = spine({ employees: CREW });
  api.makeOwner('H1');

  const signup = api.authSignup({ hNumber: 'H1', pin: PIN });
  assert.ok(signup.ok, 'the Owner must be able to choose a PIN');
  assert.equal(signup.status, 'active', 'and needs nobody to approve them — there is nobody');

  const login = api.authLogin({ hNumber: 'H1', pin: PIN });
  assert.ok(login.ok, 'and then log in');
  assert.equal(login.role, 'owner');
  assert.equal(api.verifySession(login.auth).role, 'owner');

  // And the door closes behind them like anyone else's.
  assert.ok(!api.authSignup({ hNumber: 'H1', pin: PIN2 }).ok);
});

test('re-running makeOwner on someone who already has a PIN does not unset it', () => {
  const api = staffed();
  api.authSignup({ hNumber: 'H5', pin: PIN });
  api.authApprove({ hNumber: 'H5' }, sess('H1', 'owner'));
  const hash = api.row('H5').pinHash;

  api.makeOwner('H5');
  assert.equal(api.row('H5').pinHash, hash, 'the PIN survives the promotion');
  assert.equal(api.row('H5').status, 'active');
  const r = api.authLogin({ hNumber: 'H5', pin: PIN });
  assert.ok(r.ok);
  assert.equal(r.role, 'owner');
});

// ── Signup ─────────────────────────────────────────────────────────────────

test('a signup only ever writes a PIN to a row that has none', () => {
  // The single most important property here. If signing up again could re-set the
  // PIN, then knowing a colleague's H number would be enough to become them, and
  // every role check downstream would be decorative.
  const api = staffed();
  const r = api.authSignup({ hNumber: 'H4', pin: PIN2 });
  assert.ok(!r.ok, 'signing up over an active account must be refused');
  assert.match(r.error, /already registered/);
  assert.ok(api.authLogin({ hNumber: 'H4', pin: PIN }).ok, 'the original PIN still works');
  assert.ok(!api.authLogin({ hNumber: 'H4', pin: PIN2 }).ok, 'the attempted new PIN does not');

  // A row still WAITING for approval is the same attack shifted a few hours earlier:
  // overwrite the pending PIN and the approver, who sees only an H number they were
  // expecting, lets in whoever typed last.
  assert.ok(api.authSignup({ hNumber: 'H5', pin: PIN }).ok);
  const hijack = api.authSignup({ hNumber: 'H5', pin: PIN2 });
  assert.ok(!hijack.ok, 'a pending signup must not be overwritable either');
  assert.match(hijack.error, /waiting to be approved/);

  api.authApprove({ hNumber: 'H5' }, sess('H1', 'owner'));
  assert.ok(api.authLogin({ hNumber: 'H5', pin: PIN }).ok, 'the PIN that was signed up with wins');
  assert.ok(!api.authLogin({ hNumber: 'H5', pin: PIN2 }).ok);
});

test('a signup lands in the queue, and cannot sign in until it is approved', () => {
  const api = spine({ employees: CREW });
  const r = api.authSignup({ hNumber: 'H4', pin: PIN });
  assert.ok(r.ok);
  assert.equal(r.status, 'pending');
  assert.equal(r.onRoster, true, 'the approver needs to know this H number is real crew');

  const login = api.authLogin({ hNumber: 'H4', pin: PIN });
  assert.ok(!login.ok);
  assert.ok(login.pending, 'the phone shows "waiting for approval", not "wrong PIN"');
});

test('a weak PIN is refused before anything is written', () => {
  const api = spine({ employees: CREW });
  for (const bad of ['1234', '111111', '123456', '198412', 'abcdef']) {
    const r = api.authSignup({ hNumber: 'H4', pin: bad });
    assert.ok(!r.ok, `${bad} should be refused`);
    assert.match(r.error, /^PIN must be /, 'the message completes "PIN must be …"');
  }
  assert.equal(api.row('H4'), null, 'a refused signup leaves no row behind');
});

test('an H number off the roster can still sign up, but is flagged for the approver', () => {
  // Deliberate: the crew is onboarded into Employees by an admin, and requiring that
  // first would mean nobody can sign up before someone else acts. The approver sees
  // onRoster:false and decides.
  const api = spine({ employees: CREW });
  const r = api.authSignup({ hNumber: 'H999', pin: PIN });
  assert.ok(r.ok);
  assert.equal(r.onRoster, false);
  assert.equal(api.pendingAuthRead(sess('H1', 'owner')).pending[0].onRoster, false);
});

test('a typo\'d H number is matched to the roster\'s own spelling', () => {
  // The Auth key, Employees.hNumber and the installerId stamped onto every write have
  // to be one string — nameOfH and every name-keyed read of Stops depend on it.
  const api = spine({ employees: CREW });
  assert.equal(api.authSignup({ hNumber: '  h4 ', pin: PIN }).hNumber, 'H4');
  assert.ok(api.row('H4'), 'the row is keyed on the roster spelling');
});

// ── Login ──────────────────────────────────────────────────────────────────

test('an approved person logs in and gets a token the gate accepts', () => {
  const api = staffed();
  const r = api.authLogin({ hNumber: 'H4', pin: PIN });
  assert.ok(r.ok);
  assert.equal(r.role, 'installer');
  assert.equal(r.name, 'Ina Staller');
  assert.ok(r.expires > Date.now() + 24 * 3600 * 1000, 'a fresh session clears the 24h floor');

  const v = api.verifySession(r.auth);
  assert.ok(v, 'the token the login handed out must verify');
  assert.equal(v.h, 'H4');
  assert.equal(v.role, 'installer');
  assert.ok(!api.verifySession(r.auth + 'x'), 'a tampered token must not');
});

test('a wrong PIN and an unknown H number are indistinguishable', () => {
  // Different answers would hand a caller half the credential: probe H numbers until
  // the message changes, then you know which ones are worth guessing PINs against.
  const api = staffed();
  const wrongPin = api.authLogin({ hNumber: 'H4', pin: PIN2 });
  const noSuchH  = api.authLogin({ hNumber: 'H404', pin: PIN2 });
  assert.ok(!wrongPin.ok && !noSuchH.ok);
  assert.equal(wrongPin.error, noSuchH.error);
});

test('the PIN hash never leaves the spine', () => {
  const api = staffed();
  const seen = JSON.stringify([api.authLogin({ hNumber: 'H4', pin: PIN }),
                               api.authSignup({ hNumber: 'H5', pin: PIN2 }),
                               api.pendingAuthRead(sess('H1', 'owner'))]);
  const stored = api.row('H4');
  assert.ok(stored.pinHash && stored.pinSalt, 'the row does hold them');
  assert.ok(!seen.includes(stored.pinHash), 'no response may carry the hash');
  assert.ok(!seen.includes(stored.pinSalt), 'nor the salt');
  assert.ok(!/pinHash|pinSalt|pinIters/.test(seen), 'nor even the field names');
});

// ── The wrong-PIN ladder ───────────────────────────────────────────────────

test('five wrong PINs lock the account, and the lockout survives a cache wipe', () => {
  // Rate limiting is the real defence for a 6-digit PIN — a million candidates falls
  // in an afternoon if you can simply keep guessing.
  const api = staffed();
  for (let i = 0; i < 4; i++) {
    const r = api.authLogin({ hNumber: 'H4', pin: PIN2 });
    assert.ok(!r.locked, `attempt ${i + 1} should not lock yet`);
  }
  const fifth = api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.ok(fifth.locked, 'the fifth wrong PIN locks it');
  assert.match(fifth.error, /try again in \d+ min/);

  // The CacheService copy is only a fast path. Evicting it must not reset anything —
  // otherwise a lockout could be waited out in seconds instead of minutes.
  api.wipeCache();
  const after = api.authLogin({ hNumber: 'H4', pin: PIN });
  assert.ok(after.locked, 'the durable row is the authority');
  assert.ok(!after.auth, 'and the CORRECT PIN is refused while locked');
});

test('hammering a locked account cannot escalate it to the permanent step', () => {
  // Otherwise anyone who knew a colleague's H number could lock them out for good.
  const api = staffed();
  for (let i = 0; i < 5; i++) api.authLogin({ hNumber: 'H4', pin: PIN2 });
  const before = Number(api.row('H4').failCount);
  for (let i = 0; i < 40; i++) api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.equal(Number(api.row('H4').failCount), before,
    'attempts made while locked must not count toward the ladder');
});

test('an honest fumble hours ago does not count toward today\'s attempts', () => {
  const api = staffed();
  for (let i = 0; i < 4; i++) api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.equal(Number(api.row('H4').failCount), 4);

  // Push the last failure outside PIN_FAIL_WINDOW_S. The next one starts a fresh count.
  api.setRow('H4', { lastFailAt: formatDate(new Date(Date.now() - 3600e3), 'x', 'yyyy-MM-dd HH:mm:ss') });
  const r = api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.ok(!r.locked, 'a stale window must not lock on what would have been the fifth');
  assert.equal(Number(api.row('H4').failCount), 1);
});

test('a correct PIN clears the ladder, and an admin can unlock', () => {
  const api = staffed();
  for (let i = 0; i < 3; i++) api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.ok(api.authLogin({ hNumber: 'H4', pin: PIN }).ok);
  assert.equal(Number(api.row('H4').failCount), 0, 'a success resets the count');

  for (let i = 0; i < 5; i++) api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.ok(api.authLogin({ hNumber: 'H4', pin: PIN }).locked);
  assert.ok(api.authUnlock({ hNumber: 'H4' }, sess('H3', 'backoffice')).ok);
  assert.ok(api.authLogin({ hNumber: 'H4', pin: PIN }).ok, 'unlocking lets them straight back in');
});

// ── Approver actions and the escalation paths ──────────────────────────────

test('Back-Office cannot reset the Owner\'s PIN', () => {
  // The takeover this design has to refuse: clearing the Owner's PIN parks the row in
  // 'reset', where the next signup chooses a new PIN and walks in as Owner. R_ONBOARD
  // alone would allow it, which is why manageableRoles exists.
  const api = staffed();
  for (const victim of ['H1', 'H2']) {
    const r = api.authResetPin({ hNumber: victim }, sess('H3', 'backoffice'));
    assert.ok(!r.ok, `back-office must not reset ${victim}'s PIN`);
    assert.match(r.error, /not allowed for your role/);
  }
  assert.equal(api.row('H1').status, 'active',
    'the Owner\'s row must not have been parked in "reset", which is the way in');
  assert.ok(api.authLogin({ hNumber: 'H1', pin: PIN }).ok, 'the Owner still owns their account');
  assert.ok(api.authResetPin({ hNumber: 'H4' }, sess('H3', 'backoffice')).ok,
    'resetting an installer IS their job');
});

test('an Admin can neither mint nor demote an Owner or another Admin', () => {
  const api = staffed();
  const admin = sess('H2', 'admin');
  for (const role of ['owner', 'admin']) {
    const r = api.authSetRole({ hNumber: 'H4', role }, admin);
    assert.ok(!r.ok, `an admin must not grant ${role}`);
  }
  // The other end of the same rule: taking a role away is as powerful as giving one.
  const demote = api.authSetRole({ hNumber: 'H1', role: 'installer' }, admin);
  assert.ok(!demote.ok, 'an admin must not demote the Owner');
  assert.equal(api.row('H1').role, 'owner');

  assert.ok(api.authSetRole({ hNumber: 'H4', role: 'foreman' }, admin).ok, 'but may staff up');
  assert.equal(api.row('H4').role, 'foreman');
});

test('a role change takes effect on the next request, without reissuing the token', () => {
  const api = staffed();
  const token = api.authLogin({ hNumber: 'H4', pin: PIN }).auth;
  assert.equal(api.verifySession(token).role, 'installer');
  api.authSetRole({ hNumber: 'H4', role: 'foreman' }, sess('H1', 'owner'));
  assert.equal(api.verifySession(token).role, 'foreman',
    'the role is read from the roster, not the token');
});

test('nobody administers their own account', () => {
  // An Owner who could revoke or demote themselves can lock the whole system out;
  // the editor-run makeOwner() is the escape hatch, not a web action.
  const api = staffed();
  for (const fn of ['authRevoke', 'authResetPin', 'authSetRole', 'authApprove']) {
    const r = api[fn]({ hNumber: 'H1', role: 'installer' }, sess('H1', 'owner'));
    assert.ok(!r.ok, `${fn} on yourself must be refused`);
    assert.match(r.error, /another administrator/);
  }
});

test('revoking someone invalidates the token they are already holding', () => {
  const api = staffed();
  const token = api.authLogin({ hNumber: 'H4', pin: PIN }).auth;
  assert.ok(api.verifySession(token));
  assert.ok(api.authRevoke({ hNumber: 'H4' }, sess('H2', 'admin')).ok);
  assert.ok(!api.verifySession(token), 'the session must stop verifying immediately');
  assert.ok(!api.authLogin({ hNumber: 'H4', pin: PIN }).ok, 'and they cannot sign back in');
  assert.match(api.authSignup({ hNumber: 'H4', pin: PIN2 }).error, /not available/,
    'nor sign up again — getting back in takes an administrator');
});

test('a rejected signup frees the H number to try again', () => {
  // The usual reason to reject is a typo'd H number, so this one must NOT be terminal
  // the way a revoke is.
  const api = spine({ employees: CREW });
  api.makeOwner('H1');
  api.authSignup({ hNumber: 'H4', pin: PIN });
  assert.ok(api.authReject({ hNumber: 'H4' }, sess('H1', 'owner')).ok);
  assert.ok(!api.row('H4').pinHash, 'the PIN material is wiped');

  const retry = api.authSignup({ hNumber: 'H4', pin: PIN2 });
  assert.ok(retry.ok, 'they may sign up again');
  assert.equal(retry.status, 'pending', 'and go back through approval');
});

test('a PIN reset lets exactly one signup through, with no second approval', () => {
  const api = staffed();
  assert.ok(api.authResetPin({ hNumber: 'H4' }, sess('H3', 'backoffice')).ok);
  const blocked = api.authLogin({ hNumber: 'H4', pin: PIN });
  assert.ok(blocked.needsPin, 'the old PIN is gone and the phone is told to sign up again');

  const again = api.authSignup({ hNumber: 'H4', pin: PIN2 });
  assert.equal(again.status, 'active', 'the reset WAS the approval — re-approving is busywork');
  assert.ok(api.authLogin({ hNumber: 'H4', pin: PIN2 }).ok);
  // And the door closes behind them.
  assert.ok(!api.authSignup({ hNumber: 'H4', pin: PIN }).ok);
});

test('a still-pending signup cannot be turned into an approved one by resetting it', () => {
  // Otherwise 'reset' would be a way to activate someone nobody ever approved.
  const api = staffed();
  api.authSignup({ hNumber: 'H5', pin: PIN });
  const r = api.authResetPin({ hNumber: 'H5' }, sess('H1', 'owner'));
  assert.ok(!r.ok);
  assert.match(r.error, /not approved yet/);
});

test('approval records who did it, and refuses a signup with no PIN yet', () => {
  const api = spine({ employees: CREW });
  api.makeOwner('H1');
  // makeOwner deliberately leaves the Owner without a PIN until they sign up.
  const r = api.authApprove({ hNumber: 'H1' }, sess('H1', 'owner'));
  assert.ok(!r.ok, 'and you cannot approve yourself in any case');

  api.authSignup({ hNumber: 'H4', pin: PIN });
  assert.ok(api.authApprove({ hNumber: 'H4' }, sess('H1', 'owner')).ok);
  assert.equal(api.row('H4').approvedBy, 'H1');
  assert.ok(api.row('H4').approvedAt);
  assert.ok(api.authApprove({ hNumber: 'H4' }, sess('H1', 'owner')).alreadyActive,
    're-approving is a no-op, not an error — the approvals UI can be double-tapped');
});

test('Back-Office can approve the installer in front of them', () => {
  // They grant no roles at all, so an approvals screen echoing back the role it is
  // displaying must not read as an attempted grant. Only a CHANGE is a grant.
  const api = staffed();
  api.authSignup({ hNumber: 'H5', pin: PIN2 });
  const bo = sess('H3', 'backoffice');
  assert.ok(api.authApprove({ hNumber: 'H5', role: 'installer' }, bo).ok);
  assert.equal(api.row('H5').status, 'active');
  assert.equal(api.row('H5').approvedBy, 'H3');
});

// ── The migration window ───────────────────────────────────────────────────

test('the shared token can approve an installer but cannot mint privilege', () => {
  // While REQUIRE_AUTH is off the shared token carries requests and the session is
  // null. It already authorizes deleteEmployee, so it is not a boundary — but a role
  // granted through it would OUTLIVE the window, and that must not be possible.
  const api = spine({ employees: CREW });
  api.authSignup({ hNumber: 'H4', pin: PIN });
  assert.ok(api.authApprove({ hNumber: 'H4' }, null).ok, 'onboarding still works');
  assert.equal(api.row('H4').role, 'installer');
  assert.equal(api.row('H4').approvedBy, 'shared-token');

  api.authSignup({ hNumber: 'H5', pin: PIN2 });
  assert.ok(!api.authApprove({ hNumber: 'H5', role: 'owner' }, null).ok,
    'no session may not name a role at approval');
  assert.ok(!api.authSetRole({ hNumber: 'H4', role: 'admin' }, null).ok,
    'and may not change one afterwards');

  api.makeOwner('H1');
  assert.ok(!api.authRevoke({ hNumber: 'H1' }, null).ok,
    'nor touch an account above installer');
});

// ── The onboarding read ────────────────────────────────────────────────────

test('pendingAuth projects the queue and says what this administrator may do', () => {
  const api = staffed();
  api.authSignup({ hNumber: 'H5', pin: PIN2 });

  const owner = api.pendingAuthRead(sess('H1', 'owner'));
  assert.equal(owner.pending.length, 1);
  assert.equal(owner.pending[0].hNumber, 'H5');
  assert.deepEqual(owner.grantable.sort(),
    ['admin', 'backoffice', 'foreman', 'installer', 'owner']);
  assert.equal(owner.users.find(u => u.hNumber === 'H1').manageable, false,
    'your own row is never yours to act on');

  const bo = api.pendingAuthRead(sess('H3', 'backoffice'));
  assert.deepEqual(bo.grantable, [], 'back-office onboards but assigns no roles');
  assert.equal(bo.users.find(u => u.hNumber === 'H4').manageable, true);
  assert.equal(bo.users.find(u => u.hNumber === 'H1').manageable, false,
    'the Owner is visible but not actionable — the flag must match manageableRoles');
});

// ── Dispatch wiring ────────────────────────────────────────────────────────

test('login and signup are dispatched outside the crew\'s write lock', () => {
  // On a Monday morning ~200 people sign in within a few minutes. Holding the single
  // script lock through that many PIN hashes would stall every capture in the field.
  const api = spine({ employees: CREW });
  assert.ok(api.UNLOCKED_POST.authLogin, 'authLogin must be in UNLOCKED_POST');
  assert.ok(api.UNLOCKED_POST.authSignup, 'authSignup must be in UNLOCKED_POST');
  assert.ok(api.UNLOCKED_POST.previewDailyLog, 'previewDailyLog stays there too');
  for (const locked of ['addStop', 'endOfDay', 'authApprove', 'authRevoke']) {
    assert.ok(!api.UNLOCKED_POST[locked], `${locked} writes and must hold the lock`);
  }
  // Every lock this code takes is also released — a leaked script lock would wedge
  // the spine for everyone until the request timed out.
  api.authSignup({ hNumber: 'H4', pin: PIN });
  api.authLogin({ hNumber: 'H4', pin: PIN2 });
  assert.equal(api.heldLocks(), 0);
});

test('every auth action is reachable and gated', () => {
  const api = spine({ employees: CREW });
  const actions = ['authSignup', 'authLogin', 'authApprove', 'authReject', 'authSetRole',
                   'authResetPin', 'authUnlock', 'authRevoke'];
  for (const a of actions) {
    assert.ok(api.POST_POLICY[a], `${a} needs a POST_POLICY entry`);
    assert.notEqual(api.authenticate(a, { isGet: false, token: 'nope' }).error, 'unknown action',
      `${a} must be dispatchable — it was policy-only for a whole phase`);
  }
  assert.ok(api.GET_POLICY.pendingAuth);
});
