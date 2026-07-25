// The approvals screen. `manageable` and `grantable` are advisory — the spine
// re-checks every action server-side. This function exists only so the screen does
// not offer a button that is guaranteed to be refused, which is a UI concern, not
// a security one.
import { $, esc, attr, toast } from './dom.js';
import { pendingSignups, authAction, role, onAuthChange } from './auth.js';
import { R_ONBOARD, roleAllows } from './auth-policy.js';

/** Which action buttons a row gets, based on status, lock state, and role
 *  grantability. Pure and testable. */
export function rowControls(user, grantable) {
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
    revoke:   status !== 'disabled',
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
let grantable = [];

/** Mount the sheet and a nav entry. The entry is shown only to R_ONBOARD — and a
 *  blank role passes, which is deliberate: that is the migration window, where the
 *  spine marks only installer rows manageable and grants no roles at all. Hiding
 *  it there would leave nobody able to approve the first people. */
export function initApprovals(){
  if(mounted || typeof document === 'undefined') return;
  mounted = true;
  document.body.insertAdjacentHTML('beforeend', SHEET_HTML);
  $('apprClose').onclick   = () => $('approvalsSheet').classList.add('hide');
  $('apprRefresh').onclick = load;
  $('approvalsSheet').addEventListener('click', e => {
    if(e.target === $('approvalsSheet')) $('approvalsSheet').classList.add('hide');
  });
  mountEntry();
  onAuthChange(paintEntry);
}

export function openApprovals(){
  if(!mounted) return;
  $('approvalsSheet').classList.remove('hide');
  load();
}

// ── the nav entry ──────────────────────────────────────────────────────────
// index.html has a ☰ menu; the back-office pages have a jump <select> that would
// navigate on pick, so those get a plain button in the bar instead.

function mountEntry(){
  const menu = document.getElementById('navMenu');
  if(menu){
    menu.insertAdjacentHTML('beforeend',
      '<button id="navApprovals" class="hide">✅ Approvals</button>');
  } else {
    const bar = document.querySelector('.bar');
    if(!bar) return;
    bar.insertAdjacentHTML('beforeend',
      '<button id="navApprovals" class="auth-mini hide" type="button">✅ Approvals</button>');
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
  const pending = d.pending || [];
  $('apprPending').innerHTML = pending.length
    ? pending.map(rowHTML).join('')
    : '<p class="appr-empty">Nobody is waiting.</p>';
  $('apprUsers').innerHTML = (d.users || []).map(rowHTML).join('')
    || '<p class="appr-empty">No accounts yet.</p>';
  for(const btn of document.querySelectorAll('#approvalsSheet [data-act]')){
    btn.onclick = () => act(btn.dataset.act, btn.dataset.h, btn);
  }
}

// authReject means two different things to whoever is looking at the row: on a
// 'pending' signup it is a plain refusal ("Reject"), but on a 'reset' or
// 'disabled' row the same call wipes the PIN and frees the H number so the
// person can sign up again — labelling that "Reject" would read as punitive
// when it's actually a reset-and-reopen. Same action, label matches the effect.
const REJECT_LABEL = { pending: 'Reject', reset: 'Free H#', disabled: 'Free H#' };

function rowHTML(u){
  const c = rowControls(u, grantable);
  const h = attr(u.hNumber);
  const bits = [];
  if(c.setRole){
    bits.push(`<select class="auth-field appr-role" data-role-for="${h}">`
      + c.roles.map(r =>
          `<option value="${attr(r)}"${r === u.role ? ' selected' : ''}>${esc(r)}</option>`).join('')
      + '</select>');
  }
  const btn = (act, label) => `<button class="auth-mini" data-act="${act}" data-h="${h}">${label}</button>`;
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
  btn.disabled = true;
  const extra = {};
  // A role picker on the row rides along: authApprove treats an unchanged role as
  // no grant at all, which is what lets Back-Office approve without granting.
  const sel = document.querySelector(`[data-role-for="${CSS.escape(hNumber)}"]`);
  if(sel && (action === 'authApprove' || action === 'authSetRole')) extra.role = sel.value;
  const resp = await authAction(action, hNumber, extra);
  btn.disabled = false;
  if(!resp || !resp.ok){
    const err = (resp && resp.error) || 'that did not work';
    // Shown verbatim: the spine is the authority, and its refusal is the reason.
    toast(err === 'offline' ? 'No signal — approvals need a connection' : err);
    return;
  }
  toast('Done ✓');
  await load();
}
