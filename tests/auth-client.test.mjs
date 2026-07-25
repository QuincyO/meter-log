// The client half of per-user auth: the credential every request carries, and the
// role mirror the UI hides links with.
//
// The most valuable test here is the drift guard. js/auth-policy.js duplicates
// Code.gs's capability sets so the nav can hide what a role cannot use, and a
// duplicated table is a table that goes stale — silently, because the symptom is a
// link that shouldn't be there (or worse, a missing one) rather than an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as policy from '../js/auth-policy.js';

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const CODE = read('Code.gs');
const STORE = read('js/store.js');
const QUEUE = read('js/queue.js');
const API = read('js/api.js');
const AUTH = read('js/auth.js');

// ── The mirror ─────────────────────────────────────────────────────────────

test('the client role sets match Code.gs exactly', () => {
  // Resolve a Code.gs set to plain role strings, following the two forms it uses:
  //   const R_X = [ROLE_A, ROLE_B];
  //   const R_Y = R_X.concat([ROLE_C]);
  const roleWord = t => t.trim().replace(/^ROLE_/, '').toLowerCase();
  const resolve = name => {
    const m = CODE.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `${name} should exist in Code.gs`);
    const expr = m[1];
    const concat = expr.match(/^(\w+)\.concat\(\[([^\]]*)\]\)/);
    if (concat) return resolve(concat[1]).concat(concat[2].split(',').map(roleWord));
    const list = expr.match(/\[([^\]]*)\]/);
    assert.ok(list, `${name} should be an array literal or a .concat of one`);
    return list[1].split(',').map(roleWord).filter(Boolean);
  };

  for (const name of ['R_CAPTURE', 'R_OPS', 'R_DAY', 'R_CLOSE', 'R_VIEW',
                      'R_ONBOARD', 'R_MANAGE']) {
    assert.deepEqual([...policy[name]].sort(), [...resolve(name)].sort(),
      `${name} has drifted between Code.gs and js/auth-policy.js — the nav will hide `
      + 'the wrong things. Change both, or delete the mirror.');
  }
  assert.deepEqual([...policy.ROLES].sort(),
    [...resolve('ALL_ROLES')].sort(), 'the role list itself must match');
});

test('the mirror is documented as a convenience, not a boundary', () => {
  const src = read('js/auth-policy.js');
  // Tolerant of a comment line wrap — the point is that the words are present.
  assert.match(src, /not a security\s*(?:\/\/)?\s*boundary/i,
    'someone will eventually try to enforce something with this — say so in the file');
  assert.match(src, /MIRROR OF Code\.gs/i, 'and that it is a copy of something authoritative');
});

// ── Page gating ────────────────────────────────────────────────────────────

test('a role only sees the pages it can actually use', () => {
  // Foreman and Back-Office work from laptops and never log a meter, so the capture
  // page is hidden from them even though it is the app's front door.
  assert.ok(!policy.canSeePage('index.html', 'foreman'));
  assert.ok(!policy.canSeePage('index.html', 'backoffice'));
  assert.ok(policy.canSeePage('index.html', 'installer'));
  assert.ok(policy.canSeePage('index.html', 'owner'));

  assert.ok(!policy.canSeePage('map.html', 'installer'), 'no crew-wide analytics');
  assert.ok(!policy.canSeePage('teams.html', 'foreman'), 'roster management is Owner/Admin');
  assert.ok(policy.canSeePage('edit.html', 'foreman'));
  assert.ok(!policy.canSeePage('edit.html', 'backoffice'));
  for (const r of policy.ROLES) assert.ok(policy.canSeePage('help.html', r), 'help is everyone\'s');
});

test('an unknown page is shown rather than hidden', () => {
  // Failing closed here would mean a page added without touching this table
  // silently disappears for everyone — a much worse failure than an extra link,
  // since the spine refuses whatever the page tries to do anyway.
  assert.ok(policy.canSeePage('brand-new.html', 'installer'));
});

test('everyone sees everything until they have a session', () => {
  // The migration window: the spine still accepts the shared token, nobody has
  // signed up yet, and hiding the app from them would be the wall this design
  // refuses to build.
  for (const page of Object.keys(policy.PAGE_ROLES)) {
    assert.ok(policy.canSeePage(page, ''), `${page} must stay visible with no role`);
    assert.ok(policy.canSeePage(page, null));
  }
});

test('a role that cannot open a page has somewhere to land', () => {
  assert.equal(policy.homePageFor('installer'), 'index.html');
  assert.equal(policy.homePageFor('foreman'), 'edit.html', 'a laptop role starts in the editor');
  assert.equal(policy.homePageFor('backoffice'), 'map.html');
  assert.equal(policy.homePageFor(''), 'index.html', 'no session still lands on capture');
  for (const r of policy.ROLES) {
    assert.ok(policy.canSeePage(policy.homePageFor(r), r), `${r} must be able to open its landing page`);
  }
});

// ── Session state ──────────────────────────────────────────────────────────

test('an expired session still knows who you are', () => {
  const now = 1_000_000;
  assert.equal(policy.sessionState({}, now), 'none');
  assert.equal(policy.sessionState({ auth: 't', authExp: now + 1 }, now), 'ok');
  assert.equal(policy.sessionState({ auth: 't', authExp: now - 1 }, now), 'expired');
  // Three states rather than a boolean so the prompt can say "signed out, sign back
  // in as H4" instead of asking a person who they are every Monday.
  assert.equal(policy.sessionState({ auth: 't' }, now), 'expired', 'no expiry reads as expired');
});

test('only a response carrying a token counts as a login', () => {
  assert.equal(policy.sessionFromLogin({ ok: true }), null, 'ok without a token is not a session');
  assert.equal(policy.sessionFromLogin({ auth: 'x' }), null, 'a token without ok is not either');
  assert.equal(policy.sessionFromLogin(null), null);
  const s = policy.sessionFromLogin({ ok: true, auth: 'tok', expires: 42,
                                      hNumber: 'H4', role: 'installer', name: 'Ina Staller' });
  assert.deepEqual(s, { auth: 'tok', authExp: 42, authH: 'H4',
                        authRole: 'installer', authName: 'Ina Staller' });
});

test('every way a login can fail has its own outcome', () => {
  // The sheet switches on `kind`. Matching on error prose instead would break the
  // day someone rewords a message in Code.gs.
  assert.equal(policy.loginOutcome({ ok: true, auth: 't' }).kind, 'ok');
  assert.equal(policy.loginOutcome({ ok: false, pending: true }).kind, 'pending');
  assert.equal(policy.loginOutcome({ ok: false, locked: true }).kind, 'locked');
  assert.equal(policy.loginOutcome({ ok: false, needsPin: true }).kind, 'needsPin');
  assert.equal(policy.loginOutcome({ ok: false, authFailed: true }).kind, 'failed');
  assert.equal(policy.loginOutcome(null).kind, 'offline');
  // These three are the ones a person can act on, so they must carry the spine's
  // wording through — "try again in 12 min" is the whole message.
  assert.equal(policy.loginOutcome({ ok: false, locked: true, error: 'try again in 12 min' }).message,
    'try again in 12 min');
});

// ── The credential ─────────────────────────────────────────────────────────

test('one function decides what every request is authenticated with', () => {
  // AGENTS.md §"Security note": swapping credentials must touch one place. It moved
  // from queue.js to store.js when the session arrived, precisely so the direct
  // api.js calls share it instead of growing a second copy.
  assert.match(STORE, /export function authFields\(\)/,
    'authFields belongs in store.js, beside cfg()');
  assert.match(QUEUE, /import \{ cfg, authFields \} from '\.\/store\.js'/);
  assert.match(API, /import \{ cfg, authFields \} from '\.\/store\.js'/);
  assert.ok(!/const authFields\s*=/.test(QUEUE),
    'queue.js must not keep a local copy — that is how the two drift apart');
});

test('the queue still resolves the credential at send time', () => {
  // The invariant that outranks the auth work: a write already in the queue must
  // stay sendable. It may sit in IndexedDB for days across a rotation or an expiry.
  assert.match(QUEUE, /token:_staleToken, \.\.\.stored/,
    'any credential stored on the item must be stripped');
  assert.match(QUEUE, /\{ \.\.\.stored, \.\.\.authFields\(\) \}/,
    'and the CURRENT one spread in at send time');
});

test('a session is sent alongside the shared token, not instead of it', () => {
  // Signup and login have no session by definition and the spine gates them on the
  // shared token, so dropping it the moment a session exists would lock the sign-in
  // sheet out of the very endpoint it needs.
  const fn = STORE.match(/export function authFields\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /if\(c\.token\)\s*f\.token = c\.token;/);
  assert.match(fn, /if\(c\.auth\)\s*f\.auth\s*= c\.auth;/);
});

test('an expired session is still sent, so the spine can say so precisely', () => {
  const fn = STORE.match(/export function authFields\(\)[\s\S]*?\n\}/)[0];
  assert.ok(!/authExp|expired|Date\.now/.test(fn),
    'authFields must not filter on expiry — an omitted token reads as "no credential" '
    + '(authError: required) instead of "session expired", and the queue needs the difference');
});

test('the GET query carries the credential too', () => {
  assert.match(API, /Object\.entries\(authFields\(\)\)/,
    'apiGet must inject the same credential as apiPost, not just the token');
});

test('the service worker ships the auth modules', () => {
  // A module missing from SHELL is fetched from the network on every open and is
  // simply absent offline — which for this pair means the app cannot tell a signed-in
  // phone from a signed-out one on the water.
  const sw = read('sw.js');
  for (const m of ['./js/auth.js', './js/auth-policy.js']) {
    assert.ok(sw.includes(`'${m}'`), `SHELL is missing ${m}`);
  }
});

// ── The banner, not a wall ─────────────────────────────────────────────────

test('signing out costs no un-synced work', () => {
  // A phone can hold a day of queued meters. Clearing storage on sign-out would
  // throw them away, and it is the obvious "tidy" thing for someone to add later.
  const fn = AUTH.match(/export function signOut\(\)[^\n]*/)[0];
  assert.ok(!/idb|deleteDatabase|clear\(\)|localStorage\.clear/.test(fn),
    'signOut must touch the session keys and nothing else');
  assert.match(AUTH, /KEYS = \['auth', 'authExp', 'authH', 'authRole', 'authName'\]/);
});

test('nothing in the auth module can gate the app from opening', () => {
  // The offline-Monday rule: a PIN can only be checked server-side, so a phone with
  // no signal on a Monday cannot get a session — and it still has a day of meters to
  // log. Every entry point here must be able to answer without a network.
  assert.match(AUTH, /login is a banner, never a wall/i,
    'the rule must be stated in the file someone would edit to break it');
  for (const fn of ['signIn', 'signUp']) {
    const src = AUTH.match(new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n\\}`))[0];
    assert.match(src, /catch \{ return \{ kind: 'offline' \} \}|catch \{ return \{ kind: 'offline' \}; \}/,
      `${fn} must answer 'offline' rather than throwing into the caller`);
  }
});
