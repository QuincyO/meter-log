// Every action the spine dispatches must have an explicit policy entry. An action
// missing from POST_POLICY/GET_POLICY is DENIED at runtime ("unknown action"), so
// the risk this test catches is the opposite one: shipping a new endpoint that
// nobody decided the audience for, and only finding out when a role can't use it —
// or worse, when the wrong role can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

// The actions doPost actually dispatches. There are TWO dispatch sites and both
// have to be read: the switch inside the script lock, and the UNLOCKED_POST table
// that runs ahead of it. An action reachable only through the second one would
// otherwise slip past every check in this file.
const unlocked = CODE.match(/const UNLOCKED_POST = \{[\s\S]*?\};/);
assert.ok(unlocked, 'UNLOCKED_POST should exist — doPost dispatches through it');
const postActions = [...new Set([
  ...[...CODE.matchAll(/case '([a-zA-Z]+)':\s*return json\(/g)].map(m => m[1]),
  ...[...unlocked[0].matchAll(/([a-zA-Z]+):/g)].map(m => m[1]),
])];
// The actions doGet actually dispatches: `p.action === 'x'`.
const getActions = [...new Set([...CODE.matchAll(/p\.action === '([a-zA-Z]+)'/g)].map(m => m[1]))];

const policyKeys = name => {
  const m = CODE.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`));
  assert.ok(m, `${name} should exist`);
  return [...m[0].matchAll(/^\s{2}([a-zA-Z]+):\s*\{/gm)].map(x => x[1]);
};

test('every doPost action has a POST_POLICY entry', () => {
  assert.ok(postActions.length >= 20, `expected the full action list, found ${postActions.length}`);
  const policy = policyKeys('POST_POLICY');
  const missing = postActions.filter(a => !policy.includes(a));
  assert.deepEqual(missing, [], `doPost dispatches these with no policy entry: ${missing}`);
});

test('every doGet action has a GET_POLICY entry', () => {
  const policy = policyKeys('GET_POLICY');
  const missing = getActions.filter(a => !policy.includes(a));
  assert.deepEqual(missing, [], `doGet dispatches these with no policy entry: ${missing}`);
});

test('destructive roster actions are Owner/Admin only', () => {
  const m = CODE.match(/const POST_POLICY = \{[\s\S]*?\n\};/)[0];
  for (const action of ['deleteEmployee', 'deleteTeam', 'deleteCaptain', 'deleteSub',
                        'saveTeam', 'authSetRole', 'authRevoke']) {
    const row = m.match(new RegExp(`${action}:\\s*\\{([^}]*)\\}`));
    assert.ok(row, `${action} should have a policy entry`);
    assert.match(row[1], /R_MANAGE/, `${action} must be restricted to R_MANAGE (Owner/Admin)`);
  }
});

test('the whole-list worklist replace is not open to installers', () => {
  const m = CODE.match(/const POST_POLICY = \{[\s\S]*?\n\};/)[0];
  const row = m.match(/saveWorklist:\s*\{([^}]*)\}/);
  assert.match(row[1], /R_OPS/,
    'saveWorklist wipes and rewrites an installer\'s whole order list — OPS only');
});

test('reading for others and writing for others are separate privileges', () => {
  // Back-Office must read the whole crew (that is the map/analytics job) but must
  // never write for anyone. Collapsing these into one set would silently grant it.
  assert.match(CODE, /const R_READ_ANY\s*=\s*R_VIEW/);
  assert.match(CODE, /const R_ACT_FOR_OTHERS\s*=\s*R_OPS/);
  const scope = CODE.match(/function applyScope\([\s\S]*?\n\}/)[0];
  assert.match(scope, /policy\.read \? R_READ_ANY : R_ACT_FOR_OTHERS/,
    'reads and writes must pick different allow-sets');
});

test('the gate runs before any handler in doPost and doGet', () => {
  const post = CODE.match(/function doPost\(e\) \{[\s\S]*?switch \(body\.action\)/)[0];
  assert.match(post, /authenticate\(body\.action/, 'doPost must authenticate before dispatch');
  assert.match(post, /applyScope\(POST_POLICY\[body\.action\], gate\.sess, body\)/,
    'doPost must stamp identity onto the body before any handler reads it');

  const get = CODE.match(/function doGet\(e\) \{[\s\S]*?p\.action === 'nearby'/)[0];
  assert.match(get, /authenticate\(p\.action/, 'doGet must authenticate before dispatch');
  assert.match(get, /applyScope\(GET_POLICY\[p\.action\], gate\.sess, p\)/);
});

test('an auth failure is flagged so the offline queue retries instead of parking', () => {
  // The client classifies on `authError` first (js/queue-policy.js isAuthReject).
  // Without it a rejected session would look like a poison payload and a whole
  // crew's un-synced writes would be set aside.
  const fn = CODE.match(/function authenticate\([\s\S]*?\n\}/)[0];
  assert.match(fn, /authError: 'expired'/);
  assert.match(fn, /authError: 'required'/);
  // A role refusal is NOT an auth error — retrying it forever would wedge the queue,
  // so it must fall through to the definitive-reject path and eventually park.
  assert.match(fn, /forbidden: true/);
  const post = CODE.match(/function doPost\(e\) \{[\s\S]*?switch \(body\.action\)/)[0];
  assert.match(post, /gate\.forbidden[\s\S]*?error: gate\.error \}/,
    'a forbidden response must omit authError so it parks rather than retrying forever');
});

test('a PIN hash never sits behind the crew\'s write lock', () => {
  // On a Monday morning ~200 people sign in within a few minutes of each other. If
  // authLogin ran inside doPost's script lock, every capture in the field would queue
  // behind that many PIN hashes. Both credential endpoints dispatch ahead of it.
  const m = CODE.match(/const UNLOCKED_POST = \{[\s\S]*?\};/)[0];
  for (const action of ['authLogin', 'authSignup', 'previewDailyLog']) {
    assert.match(m, new RegExp(`${action}:`), `${action} must dispatch before the lock`);
  }
  // They do still write, so they must take a short lock of their own around the row.
  assert.match(CODE.match(/function authLogin\([\s\S]*?\n\}/)[0], /withAuthLock\(/,
    'authLogin writes the row and must lock for that part');
});

test('onboarding is bounded by WHOSE account you may administer, not just R_ONBOARD', () => {
  // R_ONBOARD contains Back-Office. Without a second bound, Back-Office could
  // authResetPin the OWNER — which parks the row in 'reset', where the next signup
  // picks a new PIN and walks in as Owner. Reading someone's rows, writing for them,
  // and administering their account are three separate privileges.
  const src = CODE.match(/function manageableRoles\([\s\S]*?\n\}/);
  assert.ok(src, 'manageableRoles() should exist');
  const bo = src[0].match(/ROLE_BACKOFFICE\)\s*return \[([^\]]*)\]/);
  assert.ok(bo, 'Back-Office needs an explicit branch');
  assert.ok(!/ROLE_OWNER|ROLE_ADMIN|ROLE_FOREMAN/.test(bo[1]),
    'Back-Office may administer installers and nobody else');

  const target = CODE.match(/function authTarget\([\s\S]*?\n\}/);
  assert.ok(target, 'authTarget() should exist');
  assert.match(target[0], /manageableRoles\(sess\.role\)/,
    'every approver action must resolve its target through this check');
  for (const action of ['authApprove', 'authReject', 'authSetRole', 'authResetPin',
                        'authUnlock', 'authRevoke']) {
    assert.match(CODE.match(new RegExp(`function ${action}\\([\\s\\S]*?\\n\\}`))[0],
      /authTarget\(sess, b\.hNumber\)/, `${action} must go through authTarget`);
  }
});

test('a signup only ever writes a PIN to a row that has none', () => {
  // If a signup could overwrite an existing PIN, knowing a colleague's H number would
  // be enough to become them and every role check downstream would be decorative.
  // The check is on the HASH rather than on the status list on purpose: it then also
  // covers a row still waiting for approval, and cannot be defeated by adding a new
  // status later and forgetting to list it here.
  const src = CODE.match(/function authSignup\([\s\S]*?\n\}/)[0];
  assert.match(src, /if \(row && row\.pinHash\)\s*\n?\s*return \{ ok: false/,
    'any row that already carries a hash must be refused');
  assert.match(src, /status === AUTH_DISABLED/, 'and a revoked one gets its own message');
});

test('roster is projected so installers do not receive everyone\'s home address', () => {
  const fn = CODE.match(/function roster\(sess\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /R_READ_ANY\.indexOf\(sess\.role\)/,
    'only viewer roles should get unprojected rows');
  assert.match(fn, /mine \? e :/,
    'your own row comes through whole; everyone else\'s is projected');

  // The projected branch — everything after `mine ? e :` — is the object handed to a
  // non-viewer for OTHER people. It must carry identity fields and nothing more.
  const projected = fn.split('mine ? e :')[1];
  assert.ok(projected, 'the projection branch should be present');
  for (const leaked of ['homeAddress', 'homeLat', 'homeLng']) {
    assert.ok(!projected.includes(leaked),
      `the projected row must not include ${leaked} — that is the whole point`);
  }
  for (const kept of ['hNumber', 'firstName', 'lastName', 'subName']) {
    assert.ok(projected.includes(kept), `the projected row still needs ${kept}`);
  }
  assert.match(CODE, /roster\(SESSION\)/, 'the GET handler must pass the session through');
});
