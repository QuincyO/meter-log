// Invariants for the Auth foundation in Code.gs. These are content assertions in the
// style of tests/worklist-sheet-schema.test.mjs — Code.gs runs in Apps Script and
// can't be imported, so the guard is structural.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const fn = name => {
  const m = CODE.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name}() should exist in Code.gs`);
  return m[0];
};

test('the Auth tab is never exported to the git repo', () => {
  // exportSheetToGithub() commits every EXPORT_TABS tab to data/*.md and pushes it.
  // Auth holds PIN salts and hashes; publishing them into git history would be
  // extremely hard to walk back. This is the single most important line in the file.
  const m = CODE.match(/const EXPORT_TABS = \[[\s\S]*?\];/);
  assert.ok(m, 'EXPORT_TABS should exist');
  assert.ok(!/['"]Auth['"]/.test(m[0]),
    'Auth must NOT be in EXPORT_TABS — it would publish PIN hashes to the repository');
});

test('secrets come from Script Properties, never from source', () => {
  for (const prop of ['PIN_PEPPER', 'SESSION_SECRET']) {
    assert.match(CODE, new RegExp(`scriptProp\\('${prop}'\\)`),
      `${prop} must be read from Script Properties`);
    // A literal assignment would mean the secret sits in a file that deploys to a
    // public-capable Pages site via the repo.
    assert.ok(!new RegExp(`const ${prop}\\s*=\\s*['"]`).test(CODE),
      `${prop} must not be hardcoded in Code.gs`);
  }
});

test('roles are capability SETS, not a ladder', () => {
  // Foreman has edit+planner that Back-Office lacks; Back-Office has onboarding that
  // Foreman lacks. Neither contains the other, so any ordering is wrong and a
  // `level >= level` check would silently grant one the other's actions.
  for (const set of ['R_CAPTURE', 'R_OPS', 'R_DAY', 'R_VIEW', 'R_ONBOARD', 'R_MANAGE']) {
    assert.match(CODE, new RegExp(`const ${set}\\s*=\\s*\\[`), `${set} should be an array`);
  }
  assert.ok(!/ROLE_LEVEL|roleLevel|ROLE_RANK/.test(CODE),
    'no numeric role level may exist — roles are sets, see the capability table');

  const setOf = name => CODE.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`))[1];
  // Neither Foreman nor Back-Office carries a phone: Foremen work from laptops and
  // write the rare install on paper; Back-Office never installs at all.
  assert.ok(!/ROLE_BACKOFFICE/.test(setOf('R_CAPTURE')), 'Back-Office never captures');
  assert.ok(!/ROLE_FOREMAN/.test(setOf('R_CAPTURE')),    'Foreman never captures');
  assert.ok(!/ROLE_BACKOFFICE/.test(setOf('R_OPS')),     'Back-Office gets no edit/planner');
  assert.match(setOf('R_DAY'),     /ROLE_FOREMAN/,    'Foreman manages crew days from edit.html');
  assert.match(setOf('R_VIEW'),    /ROLE_BACKOFFICE/, 'Back-Office sees map + analytics');
  assert.match(setOf('R_ONBOARD'), /ROLE_BACKOFFICE/, 'Back-Office helps with onboarding');
  assert.ok(!/ROLE_FOREMAN/.test(setOf('R_ONBOARD')), 'Foreman does not onboard');
  assert.ok(!/ROLE_FOREMAN/.test(setOf('R_MANAGE')),  'Foreman does not manage the roster');
});

test('an Admin cannot mint another Admin or an Owner', () => {
  const src = fn('grantableRoles');
  assert.match(src, /ROLE_OWNER\) return ALL_ROLES/, 'Owner may grant anything');
  const adminLine = src.match(/granterRole === ROLE_ADMIN\) return \[([^\]]*)\]/);
  assert.ok(adminLine, 'the Admin branch should return an explicit list');
  assert.ok(!/ROLE_ADMIN|ROLE_OWNER/.test(adminLine[1]),
    'Admin must not be able to grant Admin or Owner');
  assert.match(adminLine[1], /ROLE_FOREMAN/);
  assert.match(adminLine[1], /ROLE_BACKOFFICE/);
  assert.match(adminLine[1], /ROLE_INSTALLER/);
});

test('identity is server-derived — a spoofed installerId is overwritten, not trusted', () => {
  const src = fn('scopeToSession');
  // The allow-set is passed in (reads and writes use different ones — see
  // tests/auth-policy.test.mjs), defaulting to the stricter write set.
  assert.match(src, /\(allowSet \|\| R_ACT_FOR_OTHERS\)\.indexOf\(sess\.role\)/,
    'only an explicit role set may act for others, and the default must be the write set');
  assert.match(src, /obj\.installerId = sess\.h/,
    'installerId must be overwritten from the session');
  assert.match(src, /obj\.hNumber\s*=\s*sess\.h/,
    'hNumber must be overwritten from the session');
});

test('session verification does not scan the Auth tab or touch the hash', () => {
  const src = fn('verifySession');
  assert.match(src, /authIndex\(\)/,
    'verification must use the cached projection, not a full Auth scan');
  assert.ok(!/authRowFor/.test(src),
    'verifySession must not pull the full row — that would put pinHash on the hot path');
  // The projection itself must never carry the hash into shared cache storage.
  const idx = fn('authIndex');
  assert.ok(!/pinHash|pinSalt/.test(idx),
    'the cached auth projection must not include the PIN salt or hash');
});

test('the per-request path never writes to the sheet', () => {
  // ensureTab() sets font weight and freezes a row — both writes. Calling it from
  // the verify path would fire sheet writes on every authenticated request.
  const src = fn('authRowFor');
  assert.ok(!/ensureAuthTab/.test(src),
    'authRowFor must not create the tab — it is on the request hot path');
  assert.match(src, /getSheetByName\('Auth'\)\) return null/,
    'a missing Auth tab should read as "no such user", not trigger creation');
});

test('a weak PIN is rejected at signup', () => {
  const src = fn('rejectWeakPin');
  assert.match(src, /PIN_LENGTH/, 'length is policy-driven');
  assert.match(src, /\^\(\\d\)\\1\+\$/, 'all-same-digit is rejected');
  assert.match(src, /asc\.indexOf\(p\)|desc\.indexOf\(p\)/, 'digit runs are rejected');
  assert.match(CODE, /const PIN_LENGTH = 6/, 'the user chose a 6-digit PIN');
});

test('sessions re-prompt on a fixed Monday anchor, not a rolling week', () => {
  const src = fn('nextMondayExpiry');
  // A rolling 7 days would drift: someone who first signed in on a Wednesday would
  // then be prompted every Wednesday instead of with everyone else on Monday.
  assert.match(src, /formatDate\(now, TIMEZONE, 'u'\)/, 'day-of-week must be read in Toronto');
  assert.match(src, /if \(!ahead\) ahead = 7;/, 'logging in ON Monday should get the NEXT one');
  assert.match(src, /SESSION_MIN_MS/, 'a fresh session must clear the 24h floor');
  assert.match(CODE, /const SESSION_ANCHOR_HOUR = 4/, 'the anchor sits before the workday');
  // addDaysYmd is what keeps a DST shift from moving the target onto the wrong day.
  assert.match(fn('addDaysYmd'), /Date\.UTC\([^)]*12\)/,
    'date arithmetic must be done at noon UTC so DST cannot shift the calendar day');
});
