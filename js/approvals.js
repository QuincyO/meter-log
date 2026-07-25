// The approvals screen. `manageable` and `grantable` are advisory — the spine
// re-checks every action server-side. This function exists only so the screen does
// not offer a button that is guaranteed to be refused, which is a UI concern, not
// a security one.
import { $, esc, attr, toast } from './dom.js';
import { pendingSignups, authAction, role, onAuthChange } from './auth.js';
import { R_ONBOARD, R_MANAGE, roleAllows } from './auth-policy.js';

/** Which action buttons a row gets, based on status, lock state, role
 *  grantability, and the ACTING administrator's own role. Pure and testable —
 *  `actorRole` is threaded in by the caller rather than read off a module
 *  global, so this stays a pure function of its arguments. */
export function rowControls(user, grantable, actorRole) {
  const roles = Array.isArray(grantable) ? grantable : [];
  if (!user || !user.manageable)
    return { approve: false, reject: false, resetPin: false, unlock: false,
             revoke: false, setRole: false, roles: [] };
  const status = String(user.status || '').trim();
  return {
    // The spine would accept approving a disabled row with its old PIN intact
    // (authApprove only short-circuits on 'active'). This screen does not offer that —
    // Reject wipes the PIN and frees the H number for fresh signup, preventing silent
    // credential resurrection. Product decision, not an oversight; do not widen.
    approve:  status === 'pending',
    // Reject frees the H number in three cases: typo'd signup (pending), stalled reset
    // (reset), or revoked account (disabled). authReject refuses an active row.
    reject:   status === 'pending' || status === 'reset' || status === 'disabled',
    // authResetPin refuses anything not already approved, to avoid parking a
    // pending row in 'reset' — where the next signup activates unapproved.
    resetPin: status === 'active' || status === 'reset',
    unlock:   !!user.locked,
    // authRevoke (Code.gs) requires R_MANAGE, not R_ONBOARD — Back-Office holds
    // the latter but not the former, so it was being shown a button the spine
    // always refuses. roleAllows is the same drift-guarded mirror paintEntry()
    // already uses for R_ONBOARD; tests/auth-client.test.mjs fails the build if
    // it drifts from Code.gs. It fails open for a blank actorRole, which is
    // correct: the migration window really can revoke.
    revoke:   status !== 'disabled' && roleAllows(R_MANAGE, actorRole),
    setRole:  roles.length > 0 && status !== 'disabled',
    roles:    roles.slice(),
  };
}

// ── the DOM half ─────────────────────────────────────────────────────────────

const SHEET_HTML = `
<div class="auth-sheet hide" id="approvalsSheet" role="dialog" aria-modal="true" aria-labelledby="apprTitle">
  <div class="auth-card">
    <h2 id="apprTitle">Approvals</h2>
    <p class="auth-lede">Who is waiting to be let in, and every account already set up.</p>
    <p class="auth-msg hide" id="apprMsg"></p>
    <h3 class="appr-head">Waiting for approval</h3>
    <div id="apprPending"></div>
    <h3 class="appr-head">All accounts</h3>
    <div id="apprUsers"></div>
    <button class="auth-ghost" id="apprRefresh" type="button">Refresh</button>
    <button class="auth-ghost" id="apprClose" type="button">Close</button>
  </div>
</div>`;

let mounted = false;
let loading = false;
let grantable = [];

/** Mount the sheet and a nav entry. The entry is shown only to R_ONBOARD — and a
 *  blank role passes, which is deliberate: that is the migration window, where the
 *  spine marks only installer rows manageable and grants no roles at all. Hiding
 *  it there would leave nobody able to approve the first people. */
export function initApprovals(){
  if(mounted || typeof document === 'undefined') return;

  // Guarded on the sheet's own markup, not on `mounted` — the same per-element
  // pattern initAuthUI() uses and the same reason: `mounted` only latches once
  // the wiring below finishes, so a caller retrying after a partial failure
  // skips markup a prior attempt already placed and still reaches the wiring
  // it never got to, instead of being permanently no-op'd for the page.
  if(!document.getElementById('approvalsSheet'))
    document.body.insertAdjacentHTML('beforeend', SHEET_HTML);

  $('apprClose').onclick   = () => $('approvalsSheet').classList.add('hide');
  $('apprRefresh').onclick = load;
  $('approvalsSheet').addEventListener('click', e => {
    if(e.target === $('approvalsSheet')) $('approvalsSheet').classList.add('hide');
  });
  mountEntry();

  // Only latch once the wiring above has actually finished — the exact
  // anti-pattern just removed from initAuthUI() was latching this before the
  // wiring, which would have permanently no-op'd a retry after a partial throw.
  mounted = true;
  onAuthChange(paintEntry);
}

export function openApprovals(){
  if(!mounted) return;
  $('approvalsSheet').classList.remove('hide');
  return load();
}

// ── the nav entry ──────────────────────────────────────────────────────────
// index.html has a ☰ menu; the back-office pages have a jump <select> that would
// navigate on pick, so those get a plain button in the bar instead.

function mountEntry(){
  if(!document.getElementById('navApprovals')){
    const menu = document.getElementById('navMenu');
    if(menu){
      menu.insertAdjacentHTML('beforeend',
        '<button id="navApprovals" class="hide" type="button">✅ Approvals</button>');
    } else {
      const bar = document.querySelector('.bar');
      if(!bar) return;
      bar.insertAdjacentHTML('beforeend',
        '<button id="navApprovals" class="auth-mini hide" type="button">✅ Approvals</button>');
    }
  }
  $('navApprovals').onclick = () => {
    const m = document.getElementById('navMenu');
    if(m) m.classList.add('hide');
    openApprovals();
  };
  paintEntry();
}

function paintEntry(){
  const el = document.getElementById('navApprovals');
  if(el) el.classList.toggle('hide', !roleAllows(R_ONBOARD, role()));
}

// ── loading and rendering ──────────────────────────────────────────────────

function say(text, tone){
  const el = $('apprMsg');
  el.textContent = text || '';
  el.className = 'auth-msg ' + (tone || '') + (text ? '' : ' hide');
}

async function load(){
  // apprRefresh, openApprovals() and act()'s trailing reload can all trigger a
  // load() while one is already in flight; without this a slower, staler
  // pendingSignups() response can resolve last and paint over a fresher one.
  // Only one fetch is ever in flight — a caller that arrives mid-load just
  // no-ops rather than racing it.
  if(loading) return;
  loading = true;
  try {
    say('Loading…', '');
    const d = await pendingSignups();
    if(!d || !d.ok){
      const err = (d && d.error) || 'could not load';
      // This screen never queues — it is online-only by nature, and says so.
      say(err === 'offline'
        ? 'No signal — approvals need a connection. Everything else still works offline.'
        : err, 'error');
      return;
    }
    say('', '');
    grantable = d.grantable || [];
    // The role of the administrator LOOKING at this screen, not the row being
    // rendered — rowControls() needs it to decide whether Revoke is offered
    // (R_MANAGE), threaded in here rather than read off a module global so the
    // function stays pure.
    const actorRole = role();
    const pending = d.pending || [];
    $('apprPending').innerHTML = pending.length
      ? pending.map(u => rowHTML(u, actorRole)).join('')
      : '<p class="appr-empty">Nobody is waiting.</p>';
    // pendingAuthRead's `pending` is a filter OVER `users`, not a disjoint set —
    // every pending account is already in `users` too. Drop it here so "All
    // accounts" doesn't render it a second time; the row-scoped lookup in act()
    // (below) is the real fix for the click-the-wrong-copy bug this caused, but
    // there is no reason for the screen to show the same person twice anyway.
    const others = (d.users || []).filter(u => u.status !== 'pending');
    $('apprUsers').innerHTML = others.map(u => rowHTML(u, actorRole)).join('')
      || '<p class="appr-empty">No accounts yet.</p>';
    for(const btn of document.querySelectorAll('#approvalsSheet [data-act]')){
      // .catch, not a bare call: act() can reject (a defensive try/finally lives
      // inside it too, but an onclick that drops a rejection on the floor is an
      // unhandled-rejection warning waiting to happen the next time someone
      // touches this function). The arrow has no braces so the promise chain
      // itself is what onclick() returns — tests await it directly.
      btn.onclick = () => act(btn.dataset.act, btn.dataset.h, btn)
        .catch(err => {
          // A throw here means the operator tapped something and the screen
          // never explained why nothing happened — console.warn alone is
          // invisible to anyone who isn't at devtools.
          console.warn('approval action failed', err);
          toast('Something went wrong — try again');
        });
    }
  } finally {
    loading = false;
  }
}

// authReject means two different things to whoever is looking at the row: on a
// 'pending' signup it is a plain refusal ("Reject"), but on a 'reset' or
// 'disabled' row the same call wipes the PIN and frees the H number so the
// person can sign up again — labelling that "Reject" would read as punitive
// when it's actually a reset-and-reopen. Same action, label matches the effect.
const REJECT_LABEL = { pending: 'Reject', reset: 'Free H#', disabled: 'Free H#' };

// Revoke and Reset PIN get a confirm() and nothing else here does. Both render
// as identically-styled .auth-mini buttons in a flex-wrap row, so on a narrow
// phone Reset PIN can reflow into the spot next to the harmless Unlock — a
// mis-tap locks a working installer out mid-shift until they re-signup AND get
// re-approved. This screen is not the first place in the app to guard a
// destructive tap this way: removing a stop (js/pages/capture.js), restoring
// one (js/pages/edit.js) and closing a day (js/pages/reports.js) all confirm()
// first. Approve/Reject/Unlock/Set role stay unguarded on purpose — they are
// each reversible from this same screen (see the REJECT_LABEL comment above).
const CONFIRM_ACTION = {
  authRevoke:   name => `Revoke ${name}'s account? They will be signed out immediately `
    + 'and will have to sign up again from scratch to regain access.',
  authResetPin: name => `Reset ${name}'s PIN? Their current PIN stops working immediately `
    + '— they will need to set a new one before they can sign in again.',
};

function rowHTML(u, actorRole){
  const c = rowControls(u, grantable, actorRole);
  const h = attr(u.hNumber);
  const name = attr(u.name || u.hNumber);
  const bits = [];
  if(c.setRole){
    // data-current is the row's role AT LOAD TIME — act() compares the picker's
    // live value against this to decide whether the operator actually changed
    // anything (see the comment on that check, below).
    bits.push(`<select class="auth-field appr-role" data-current="${attr(u.role || '')}">`
      + c.roles.map(r =>
          `<option value="${attr(r)}"${r === u.role ? ' selected' : ''}>${esc(r)}</option>`).join('')
      + '</select>');
  }
  // data-name rides along on every action button so act() can name the person
  // in a confirm() prompt without re-walking the row for it.
  const btn = (act, label) => `<button class="auth-mini" data-act="${act}" data-h="${h}" data-name="${name}">${label}</button>`;
  if(c.approve)  bits.push(btn('authApprove',  'Approve'));
  if(c.reject)   bits.push(btn('authReject',   REJECT_LABEL[String(u.status || '').trim()] || 'Reject'));
  if(c.setRole)  bits.push(btn('authSetRole',  'Set role'));
  if(c.resetPin) bits.push(btn('authResetPin', 'Reset PIN'));
  if(c.unlock)   bits.push(btn('authUnlock',   'Unlock'));
  if(c.revoke)   bits.push(btn('authRevoke',   'Revoke'));

  const meta = [
    esc(u.hNumber),
    u.onRoster ? '' : 'not on the roster',
    esc(u.status || ''),
    esc(u.role || ''),
    u.locked ? 'locked' : '',
    u.lastLoginAt ? 'last in ' + esc(u.lastLoginAt) : '',
  ].filter(Boolean).join(' · ');

  return `<div class="appr-row">
    <div class="appr-who"><strong>${esc(u.name || u.hNumber)}</strong>
      <span class="appr-meta">${meta}</span></div>
    <div class="appr-actions">${bits.join('') || '<span class="appr-meta">view only</span>'}</div>
  </div>`;
}

async function act(action, hNumber, btn){
  // Revoke and Reset PIN only: see the comment on CONFIRM_ACTION above for why
  // just these two. Asked BEFORE btn.disabled — a cancelled confirm must leave
  // the row exactly as it was, not touch the button at all.
  const confirmMsg = CONFIRM_ACTION[action];
  if(confirmMsg && !confirm(confirmMsg(btn.dataset.name || hNumber))) return;

  btn.disabled = true;
  try {
    const extra = {};
    // Scoped to the row this button lives in, NOT a document-wide lookup by H
    // number: pendingAuthRead's `pending` is a filter OVER `users`, so before
    // load() started excluding pending rows from #apprUsers (see above), the
    // same H number could render in BOTH sections at once, and a document-wide
    // `querySelector` always finds the first (Waiting-for-approval) copy — so
    // editing the All-accounts picker and tapping Set role there silently
    // posted whatever the OTHER row's picker showed. Scoping to the clicked
    // row's own ancestor is correct regardless of whether the two sections
    // ever overlap again.
    const sel = btn.closest('.appr-row').querySelector('.appr-role');
    if(sel && action === 'authSetRole'){
      // authSetRole ALWAYS carries a role — Code.gs computes `role = ''` when
      // none is posted and refuses with "you cannot assign the role (blank)".
      // An untouched picker still shows a real selected option (rowHTML()
      // pre-selects the row's current role), so posting sel.value
      // unconditionally here is exactly "set it to what the picker shows",
      // never a value the operator didn't choose.
      extra.role = sel.value;
    } else if(sel && action === 'authApprove'
              && sel.value !== (sel.dataset.current || '')){
      // Approve is different: posting no role at all is a valid, safe outcome
      // (approve as whatever role the row already has), so here a role is only
      // posted when the operator actually changed the picker. If
      // manageableRoles/grantableRoles (Code.gs) ever let the current role
      // fall out of the option list, the picker would default to its first
      // option and an untouched Approve would silently become a role change —
      // this guard is what stops that, and it does not apply to authSetRole,
      // whose entire job is changing the role.
      extra.role = sel.value;
    }
    const resp = await authAction(action, hNumber, extra);
    if(!resp || !resp.ok){
      const err = (resp && resp.error) || 'that did not work';
      // Shown verbatim: the spine is the authority, and its refusal is the reason.
      toast(err === 'offline' ? 'No signal — approvals need a connection' : err);
      return;
    }
    toast('Done ✓');
    await load();
  } finally {
    // Always, not just on the two returns above: the one throw path this used
    // to have (CSS.escape, absent in some legacy WebViews) is gone now that the
    // lookup above no longer needs it, but a bare assignment with no
    // try/finally is one future edit away from leaving a tapped button
    // disabled forever with nothing on screen explaining why.
    btn.disabled = false;
  }
}
