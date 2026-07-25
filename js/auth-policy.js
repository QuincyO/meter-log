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

// ── What the sign-in UI shows ──────────────────────────────────────────────
// Pure, so the copy and the state machine can be tested without a DOM. The
// rule these serve: login is a banner, never a wall. Every branch below either
// closes the sheet or explains itself — none of them stops anyone working.

/** The banner for a session state. `ok` shows nothing; the other two differ in
 *  that 'expired' still knows who you are, so it can be personal. */
export function bannerFor(state, name) {
  const who = String(name || '').trim();
  if (state === 'ok') return { show: false, tone: '', text: '', cta: '' };
  if (state === 'expired')
    return { show: true, tone: 'warn', cta: 'Sign in',
             text: who ? `New week — sign in again, ${who}` : 'New week — sign in again' };
  return { show: true, tone: 'info', cta: 'Sign in', text: 'Not signed in' };
}

/** Dismissal lasts the calendar day. Same shape as the driveRecord date guard:
 *  a stale or absent date reads as "not dismissed", so this fails toward showing
 *  the banner rather than toward hiding it forever. */
export function bannerDismissed(storedDay, today) {
  return !!storedDay && String(storedDay) === String(today);
}

/** How the sheet reacts to a signIn() result. Switches on the `kind` auth.js
 *  already returns — never on the error prose, which is why loginOutcome exists. */
export function signInFeedback(out) {
  const kind = out && out.kind;
  const msg = (out && out.message) || '';
  if (kind === 'ok')
    return { close: true, mode: null, tone: 'ok', text: '' };
  if (kind === 'needsPin')
    return { close: false, mode: 'signup', tone: 'info',
             text: 'Your PIN was reset — choose a new one' };
  if (kind === 'pending')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'Waiting for approval — you can keep logging meanwhile' };
  if (kind === 'locked')
    return { close: false, mode: 'signin', tone: 'error', text: msg || 'Too many tries — locked for now' };
  if (kind === 'offline')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'No signal — keep logging, your work is saved and will sync' };
  return { close: false, mode: 'signin', tone: 'error', text: msg || 'Wrong H number or PIN' };
}

/** How the sheet reacts to a signUp() result. 'active' means the row had been
 *  approved already (a PIN reset), so the PIN just set works immediately. */
export function signUpFeedback(out) {
  const kind = out && out.kind;
  const msg = (out && out.message) || '';
  if (kind === 'active')
    return { close: false, mode: 'signin', tone: 'ok', text: 'PIN set — sign in now' };
  if (kind === 'pending')
    return { close: false, mode: 'signin', tone: 'info',
             text: 'Signed up — an administrator has to approve you. You can keep logging meanwhile.' };
  if (kind === 'offline')
    return { close: false, mode: 'signup', tone: 'info',
             text: 'No signal — keep logging, your work is saved and will sync' };
  return { close: false, mode: 'signup', tone: 'error', text: msg || 'Could not sign up' };
}
