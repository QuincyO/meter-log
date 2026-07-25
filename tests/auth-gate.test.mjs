// Executes the real authorization gate from Code.gs against Apps Script stubs.
//
// Everything else in the auth test suite is a content assertion — necessary, but it
// cannot tell you whether the gate actually lets the right people through. This one
// runs it. The property that matters most is the first test: while REQUIRE_AUTH is
// off, behaviour must be byte-for-byte what it was before auth existed, because the
// flip is a production spine the whole crew depends on.
//
// The source is lifted out of Code.gs by regex (it runs in Apps Script and can't be
// imported). The patterns anchor on stable top-level declarations; if one stops
// matching, `grab` throws with the name so the failure points at what moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const SHARED_TOKEN = CODE.match(/const SHARED_TOKEN = '([^']+)'/)[1];

function grab(re, label) {
  const m = CODE.match(re);
  assert.ok(m, `could not lift ${label} out of Code.gs — did it move or get renamed?`);
  return m[0];
}

const SRC = [
  grab(/const SHARED_TOKEN = [^\n]*/, 'SHARED_TOKEN'),
  grab(/const ROLE_OWNER = [\s\S]*?const ALL_ROLES = [^\n]*/, 'role names'),
  grab(/const R_FIELD[\s\S]*?const R_MANAGE\s*=\s*\[[^\]]*\];/, 'capability sets'),
  grab(/const R_READ_ANY[\s\S]*?const R_ACT_FOR_OTHERS\s*=\s*R_OPS;/, 'actor sets'),
  grab(/const POST_POLICY = \{[\s\S]*?\n\};/, 'POST_POLICY'),
  grab(/const GET_POLICY = \{[\s\S]*?\n\};/, 'GET_POLICY'),
  grab(/function safeEquals\([\s\S]*?\n\}/, 'safeEquals'),
  grab(/function scriptProp\([\s\S]*?\n\}/, 'scriptProp'),
  grab(/function requireAuth\(\)[^\n]*/, 'requireAuth'),
  grab(/function authenticate\([\s\S]*?\n\}/, 'authenticate'),
  grab(/function applyScope\([\s\S]*?\n\}/, 'applyScope'),
  grab(/function scopeToSession\([\s\S]*?\n\}/, 'scopeToSession'),
].join('\n');

// Build a fresh sandbox per scenario so Script Properties and the session stub can
// differ between them.
function spine(props = {}, session = null) {
  const factory = new Function('PROPS', `
    const PropertiesService = { getScriptProperties: () => ({ getProperty: k => PROPS[k] || null }) };
    let SESSION_STUB = null;
    function verifySession(){ return SESSION_STUB; }
    function nameOfH(h){ return 'Name ' + h; }
    ${SRC}
    return { authenticate, applyScope, POST_POLICY, GET_POLICY,
             setSession: s => { SESSION_STUB = s; } };
  `);
  const api = factory(props);
  api.setSession(session);
  return api;
}
const post = (api, action, carrier = {}) => api.authenticate(action, { isGet: false, ...carrier });
const get  = (api, action, carrier = {}) => api.authenticate(action, { isGet: true,  ...carrier });

test('while REQUIRE_AUTH is off, the shared token still works exactly as before', () => {
  const api = spine({}, null);   // no REQUIRE_AUTH property set
  for (const action of ['addStop', 'endOfDay', 'saveWorklist', 'deleteEmployee', 'saveTeam']) {
    const r = post(api, action, { token: SHARED_TOKEN });
    assert.ok(r.ok, `${action} must still be allowed during the migration window`);
    assert.equal(r.sess, null, 'no session means no scoping is applied');
  }
  assert.ok(!post(api, 'addStop', { token: 'wrong' }).ok, 'a wrong token is still rejected');
});

test('flipping REQUIRE_AUTH on retires the shared token', () => {
  const api = spine({ REQUIRE_AUTH: 'true' }, null);
  const r = post(api, 'addStop', { token: SHARED_TOKEN });
  assert.ok(!r.ok, 'the shared token alone must no longer authorize a write');
  assert.equal(r.authError, 'required',
    'it must be flagged as an auth problem so queued writes wait instead of parking');
});

test('an installer is held to their own work', () => {
  const api = spine({}, { h: 'H1', role: 'installer' });
  assert.ok(post(api, 'addStop', { auth: 'tok' }).ok, 'may log their own stops');
  assert.ok(post(api, 'endOfDay', { auth: 'tok' }).ok, 'may close their own day');

  for (const denied of ['deleteEmployee', 'deleteTeam', 'saveTeam', 'saveWorklist',
                        'restoreStop', 'authApprove', 'authSetRole']) {
    const r = post(api, denied, { auth: 'tok' });
    assert.ok(!r.ok, `installer must not be able to call ${denied}`);
    assert.ok(r.forbidden, `${denied} should be a role refusal`);
    // A role refusal is permanent. If it carried authError the client would retry it
    // forever instead of eventually parking it.
    assert.ok(!r.authError, `${denied} must not be flagged as an auth error`);
  }
  assert.ok(!get(api, 'pins', { auth: 'tok' }).ok, 'no crew-wide analytics');
  assert.ok(!get(api, 'timing', { auth: 'tok' }).ok);
});

test('back-office views everything and writes nothing', () => {
  const api = spine({}, { h: 'H2', role: 'backoffice' });
  for (const allowed of ['pins', 'tracker', 'timing', 'boatdays', 'dispatch', 'downtime']) {
    assert.ok(get(api, allowed, { auth: 'tok' }).ok, `back-office needs ${allowed} for the map`);
  }
  assert.ok(post(api, 'authApprove', { auth: 'tok' }).ok, 'onboarding is their job');
  assert.ok(post(api, 'authResetPin', { auth: 'tok' }).ok);
  // Never captures, never edits, never plans — the user was explicit about this.
  for (const denied of ['addStop', 'endOfDay', 'saveWorklist', 'restoreStop', 'deleteEmployee']) {
    assert.ok(!post(api, denied, { auth: 'tok' }).ok, `back-office must not call ${denied}`);
  }
});

test('foreman runs operations for all crew but does no onboarding', () => {
  const api = spine({}, { h: 'H3', role: 'foreman' });
  assert.ok(post(api, 'saveWorklist', { auth: 'tok' }).ok, 'plans routes for all crew');
  assert.ok(post(api, 'restoreStop', { auth: 'tok' }).ok);
  assert.ok(post(api, 'addStop', { auth: 'tok' }).ok, 'still a field role');
  assert.ok(get(api, 'pins', { auth: 'tok' }).ok);
  assert.ok(!post(api, 'authApprove', { auth: 'tok' }).ok, 'onboarding is not theirs');
  assert.ok(!post(api, 'deleteTeam', { auth: 'tok' }).ok, 'roster management is not theirs');
  assert.ok(!post(api, 'authSetRole', { auth: 'tok' }).ok);
});

test('an unknown action is denied without being mistaken for an auth problem', () => {
  const api = spine({}, null);
  const r = post(api, 'totallyMadeUp', { token: SHARED_TOKEN });
  assert.ok(!r.ok);
  assert.equal(r.error, 'unknown action');
  assert.ok(!r.authError, 'it must park rather than retry forever');
});

test('a spoofed installerId is overwritten on writes, per role', () => {
  const api = spine();
  const spoof = () => ({ action: 'addStop', installerId: 'H999', installer: 'Somebody Else' });

  const mine = spoof();
  api.applyScope(api.POST_POLICY.addStop, { h: 'H1', role: 'installer' }, mine);
  assert.equal(mine.installerId, 'H1', 'an installer cannot log work as someone else');
  assert.equal(mine.installer, 'Name H1');

  // Back-office may READ the crew but must not WRITE for them, so a write is pinned.
  const bo = spoof();
  api.applyScope(api.POST_POLICY.addStop, { h: 'H2', role: 'backoffice' }, bo);
  assert.equal(bo.installerId, 'H2', 'read-any does not imply write-for-any');

  // Foreman legitimately acts for others.
  const fm = spoof();
  api.applyScope(api.POST_POLICY.addStop, { h: 'H3', role: 'foreman' }, fm);
  assert.equal(fm.installerId, 'H999', 'a foreman may act for their crew');
});

test('reads and writes scope differently for the same role', () => {
  const api = spine();
  const q = { action: 'day', installerId: 'H999' };
  api.applyScope(api.GET_POLICY.day, { h: 'H2', role: 'backoffice' }, q);
  assert.equal(q.installerId, 'H999', 'back-office reads anyone');

  const w = { action: 'endOfDay', installerId: 'H999' };
  api.applyScope(api.POST_POLICY.endOfDay, { h: 'H2', role: 'backoffice' }, w);
  assert.equal(w.installerId, 'H2', 'back-office writes only as itself');

  const r = { action: 'day', installerId: 'H999' };
  api.applyScope(api.GET_POLICY.day, { h: 'H1', role: 'installer' }, r);
  assert.equal(r.installerId, 'H1', 'an installer reads only their own day');
});
