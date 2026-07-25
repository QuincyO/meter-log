// ── Pure auth policy for the frontend ──────────────────────────────────────
// No DOM, no storage, no fetch — the same split as queue-policy.js, so the
// decisions can be unit-tested directly (tests/auth-client.test.mjs).
//
// THE ROLE SETS BELOW ARE A MIRROR OF Code.gs, AND A MIRROR IS A LIABILITY.
// They exist only to hide UI a role cannot use — a nav link that always answers
// "not allowed for your role" is worse than no link. They are NOT a security
// boundary and must never be treated as one: every request is re-checked by the
// spine's POST_POLICY/GET_POLICY, which is the only authority. Editing a set
// here without editing Code.gs (or the reverse) is caught by
// tests/auth-client.test.mjs, which parses both and fails on any drift.

export const ROLES = ['owner', 'admin', 'foreman', 'backoffice', 'installer'];

// Capability sets — NOT a ladder. Foreman has edit/planner that Back-Office
// lacks; Back-Office has onboarding that Foreman lacks. Neither contains the
// other, so there is no correct ordering; always test membership.
export const R_CAPTURE = ['owner', 'admin', 'installer'];
export const R_OPS     = ['owner', 'admin', 'foreman'];
export const R_DAY     = ['owner', 'admin', 'foreman', 'installer'];
export const R_CLOSE   = ['owner', 'admin', 'foreman', 'installer', 'backoffice'];
export const R_VIEW    = ['owner', 'admin', 'foreman', 'backoffice'];
export const R_ONBOARD = ['owner', 'admin', 'backoffice'];
export const R_MANAGE  = ['owner', 'admin'];

/** Membership test. A blank role is the migration window (no session yet) and is
 *  allowed everything — the spine is still accepting the shared token, and hiding
 *  the app from a crew that hasn't signed up yet would be the wall this design
 *  explicitly refuses to build. */
export function roleAllows(set, role) {
  const r = String(role || '').trim();
  return !r || set.indexOf(r) !== -1;
}

// Which roles have any business opening each page. Capture is the interesting
// one: Foreman and Back-Office work from laptops and never log a meter, so
// index.html is hidden from them even though it is the app's front door.
export const PAGE_ROLES = {
  'index.html':   R_CAPTURE,
  'map.html':     R_VIEW,
  'edit.html':    R_OPS,
  'planner.html': R_OPS,
  'teams.html':   R_MANAGE,
  'reports.html': R_VIEW,
  'help.html':    ROLES,
};

export function canSeePage(page, role) {
  const set = PAGE_ROLES[String(page || '').replace(/^.*\//, '')];
  return set ? roleAllows(set, role) : true;
}

/** Where to send someone whose role cannot open the page they landed on. Ordered
 *  by what that role actually does all day, so a Foreman opening the capture link
 *  from an old bookmark lands on the editor rather than a dead end. */
export function homePageFor(role) {
  const order = ['index.html', 'edit.html', 'map.html', 'help.html'];
  return order.find(p => canSeePage(p, role)) || 'help.html';
}

/** The session as the UI should treat it. Deliberately three states, not a
 *  boolean: 'expired' still knows WHO you are, so the sign-in prompt can pre-fill
 *  the H number and the banner can say "signed out" instead of "sign in". */
export function sessionState(cfgLike, nowMs) {
  const c = cfgLike || {};
  if (!c.auth) return 'none';
  return Number(c.authExp || 0) > nowMs ? 'ok' : 'expired';
}

/** What a login response should be stored as, or null if it isn't one. Kept pure
 *  so the "what counts as a successful login" rule is testable without a network. */
export function sessionFromLogin(resp) {
  if (!resp || !resp.ok || !resp.auth) return null;
  return { auth: String(resp.auth), authExp: Number(resp.expires || 0),
           authH: String(resp.hNumber || ''), authRole: String(resp.role || ''),
           authName: String(resp.name || '') };
}

/** How the sign-in sheet should react to a failed login. The spine answers with
 *  flags rather than prose the client has to pattern-match, so this stays a
 *  lookup rather than a regex over error strings. */
export function loginOutcome(resp) {
  if (!resp) return { kind: 'offline' };
  if (resp.ok && resp.auth) return { kind: 'ok' };
  if (resp.locked) return { kind: 'locked', message: resp.error || 'locked' };
  if (resp.pending) return { kind: 'pending', message: resp.error || 'waiting for approval' };
  if (resp.needsPin) return { kind: 'needsPin', message: resp.error || 'choose a new PIN' };
  return { kind: 'failed', message: resp.error || 'wrong H number or PIN' };
}
