// ── Per-user session: sign in, sign up, and who the app thinks you are ──────
// The stateful half of the client auth story; the decisions live in the pure
// auth-policy.js beside it. Storage is localStorage via store.js (a session is a
// small string read synchronously before every request, and losing it costs a
// sign-in, not data). The credential itself is injected by store.js authFields(),
// which both api.js and the offline queue already use — this module only decides
// what is in there.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: **login is a banner, never a wall.**
// A PIN can only be checked server-side, so a phone with no signal on a Monday
// cannot get a session — and that phone still has a full day of meters to log.
// Nothing in this module may block the app from opening, block capture, or block
// a write from being queued. It reports state; the UI nudges. See AGENTS.md.
import { store, cfg } from './store.js';
import { apiPost, apiGet } from './api.js';
import { sessionState, sessionFromLogin, loginOutcome, canSeePage, homePageFor } from './auth-policy.js';

const KEYS = ['auth', 'authExp', 'authH', 'authRole', 'authName'];

const listeners = new Set();
/** Subscribe to sign-in / sign-out / expiry. Returns an unsubscribe. */
export function onAuthChange(fn){ listeners.add(fn); return () => listeners.delete(fn); }
function announce(){ for(const fn of [...listeners]) { try { fn(auth()); } catch {} } }

/** Everything the UI needs to know about the current session, in one read.
 *  `state` is 'none' | 'expired' | 'ok'; the rest is who we last knew you to be,
 *  which survives an expiry on purpose so the sign-in sheet can pre-fill. */
export function auth(){
  const c = cfg();
  return { state: sessionState(c, Date.now()), token: c.auth, expires: c.authExp,
           hNumber: c.authH, role: c.authRole, name: c.authName };
}
export const signedIn = () => auth().state === 'ok';

/** The role to gate UI on. A blank role means "no session yet" — during the
 *  migration window that is everybody, and they must keep seeing the whole app. */
export const role = () => auth().role;
export const can = page => canSeePage(page, role());
export const landingPage = () => homePageFor(role());

function write(fields){
  for(const k of KEYS) store.set(k, fields && fields[k] != null ? String(fields[k]) : '');
  announce();
}

/** Sign out locally. Deliberately touches NOTHING but the session keys: the queue,
 *  the day cache, the worklist and the person's name/H number all survive, because
 *  signing out must never cost un-synced work. There is no server call — the spine
 *  is stateless and revocation is an approver action (authRevoke). */
export function signOut(){ write(null); }

/** H number + PIN → a session. Returns a loginOutcome kind the sheet can switch on
 *  rather than an error string it has to pattern-match. */
export async function signIn(hNumber, pin){
  let resp = null;
  try { resp = await apiPost({ action: 'authLogin', hNumber, pin }); }
  catch { return { kind: 'offline' }; }
  const out = loginOutcome(resp);
  if(out.kind === 'ok'){
    write(sessionFromLogin(resp));
    // The spine matched the H number against the roster and told us the canonical
    // spelling and name; adopt them so every later write agrees with the server.
    if(resp.hNumber) store.set('hNumber', resp.hNumber);
    if(resp.name)    store.set('name', resp.name);
  }
  return out;
}

/** Claim an H number and choose a PIN. A first signup lands in the approval queue;
 *  one made against a PIN an approver cleared activates immediately, and the spine
 *  says which via `pending`. */
export async function signUp(hNumber, pin){
  let resp = null;
  try { resp = await apiPost({ action: 'authSignup', hNumber, pin }); }
  catch { return { kind: 'offline' }; }
  if(!resp || !resp.ok) return { kind: 'failed', message: (resp && resp.error) || 'could not sign up' };
  return { kind: resp.pending ? 'pending' : 'active', hNumber: resp.hNumber, onRoster: resp.onRoster };
}

/** The onboarding queue, for the approvals screen. R_ONBOARD only — anyone else
 *  gets a role refusal from the spine, which is the authority. */
export async function pendingSignups(){
  try { return await apiGet('pendingAuth'); }
  catch { return { ok: false, error: 'offline' }; }
}

/** Approve / reject / set role / reset PIN / unlock / revoke. Thin by design: the
 *  spine re-checks every one of these against the caller's session, so there is no
 *  client-side rule worth duplicating here. */
export async function authAction(action, hNumber, extra = {}){
  try { return await apiPost({ action, hNumber, ...extra }); }
  catch { return { ok: false, error: 'offline' }; }
}

// A session expires at a fixed Monday 04:00, so a phone left open over the weekend
// crosses that boundary without any request happening. Re-announce on wake so the
// banner appears when they pick the phone up, not on their first failed write.
if(typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', () => { if(!document.hidden) announce(); });
}
