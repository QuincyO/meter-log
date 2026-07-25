// Every action the spine dispatches must have an explicit policy entry. An action
// missing from POST_POLICY/GET_POLICY is DENIED at runtime ("unknown action"), so
// the risk this test catches is the opposite one: shipping a new endpoint that
// nobody decided the audience for, and only finding out when a role can't use it —
// or worse, when the wrong role can.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

// The actions doPost actually dispatches: `case 'x': return json(...)`.
const postActions = [...CODE.matchAll(/case '([a-zA-Z]+)':\s*return json\(/g)].map(m => m[1]);
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
