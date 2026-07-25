// ── The sign-in banner and sheet ────────────────────────────────────────────
// The DOM half of per-user auth; every decision it makes lives in the pure
// auth-policy.js beside it. It injects its own markup and ships its own CSS so
// it can mount on any page — a session expires at a fixed Monday 04:00, and the
// person it strands may be on edit.html rather than the capture page.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: login is a banner, never a wall.
// This module may nudge, explain and offer. It may not redirect, disable the
// capture form, or stand between a tap and the offline queue. A phone with no
// signal on a Monday cannot get a session and still has a day of meters to log.
import { $, toast } from './dom.js';
import { store } from './store.js';
import { localDate } from './time.js';
import { auth, signIn, signUp, signOut, onAuthChange } from './auth.js';
import { bannerFor, bannerDismissed, signInFeedback, signUpFeedback } from './auth-policy.js';

const BANNER_HTML = `
<div class="auth-banner hide" id="authBanner">
  <span class="auth-banner-text" id="authBannerText"></span>
  <span class="auth-banner-actions">
    <button class="auth-mini" id="authBannerCta" type="button">Sign in</button>
    <button class="auth-dismiss" id="authBannerX" type="button" aria-label="Dismiss">✕</button>
  </span>
</div>`;

const SHEET_HTML = `
<div class="auth-sheet hide" id="authSheet" role="dialog" aria-labelledby="authTitle">
  <div class="auth-card">
    <h2 id="authTitle">Sign in</h2>
    <p class="auth-lede" id="authLede">Your employee number and your 6-digit PIN.</p>

    <div id="authForm">
      <label for="authH">Employee # (H)</label>
      <input id="authH" class="auth-field auth-mono" autocapitalize="characters" autocomplete="username">
      <label for="authPin">PIN</label>
      <input id="authPin" class="auth-field auth-mono" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password">
      <div id="authConfirmWrap" class="hide">
        <label for="authPin2">Confirm PIN</label>
        <input id="authPin2" class="auth-field auth-mono" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password">
      </div>
      <p class="auth-msg hide" id="authMsg"></p>
      <button class="auth-primary" id="authSubmit" type="button">Sign in</button>
      <button class="auth-ghost" id="authSwitch" type="button">New here? Create a PIN</button>
    </div>

    <div id="authMe" class="auth-me hide">
      <p id="authMeText"></p>
      <button class="auth-ghost" id="authSignOut" type="button">Sign out</button>
    </div>

    <p class="auth-note">You can keep logging with no signal. Signing in is only how
      your work reaches the office — nothing you log is ever lost by being signed out.</p>
    <button class="auth-ghost" id="authClose" type="button">Close</button>
  </div>
</div>`;

// The banner's Sign-in CTA hides itself the moment a session exists
// (bannerFor('ok', …) => {show:false}), so it can never be the route to
// Sign out. This nav entry is the module's own, permanent way in — it is
// never hidden in either auth state, matching the other plain-button
// entries already in #navMenu (the capture page's ☰ dropdown).
const NAV_HTML = `<button id="navSignIn" type="button">🔑 Sign in</button>`;

let mounted = false;
let mode = 'signin';          // 'signin' | 'signup'

/** Mount once, paint, and subscribe. Safe to call on any page and twice. */
export function initAuthUI(){
  if(mounted || typeof document === 'undefined') return;
  // Guard against a retried mount after a partial failure: `mounted` only
  // latches once wiring below succeeds (see the comment at the bottom of this
  // function), so a caller may legitimately call initAuthUI() again after an
  // exception. Without this check that retry would insertAdjacentHTML a
  // second banner + sheet on top of the first.
  if(document.getElementById('authBanner')) return;

  // The banner sits directly under the page's top bar on every page that has
  // one, so it reads as chrome rather than as part of the form beneath it.
  const bar = document.querySelector('.bar');
  if(bar) bar.insertAdjacentHTML('afterend', BANNER_HTML);
  else document.body.insertAdjacentHTML('afterbegin', BANNER_HTML);
  document.body.insertAdjacentHTML('beforeend', SHEET_HTML);

  // The nav entry: #navMenu is the capture page's ☰ dropdown (a page-owned
  // list of plain <button id="…"> children); a page without one (map/teams/…)
  // gets the button appended to its top bar instead.
  const navMenu = document.getElementById('navMenu');
  if(navMenu) navMenu.insertAdjacentHTML('beforeend', NAV_HTML);
  else if(bar) bar.insertAdjacentHTML('beforeend', NAV_HTML);

  $('authBannerCta').onclick = () => openAuthSheet();
  $('authBannerX').onclick   = dismissBanner;
  $('authClose').onclick     = closeAuthSheet;
  $('authSwitch').onclick    = () => setMode(mode === 'signin' ? 'signup' : 'signin');
  $('authSubmit').onclick    = submit;
  $('authSignOut').onclick   = () => { signOut(); setMode('signin'); closeAuthSheet(); toast('Signed out'); };
  if($('navSignIn')) $('navSignIn').onclick = () => {
    // Matches the other #navMenu buttons' own onclick handlers, which close
    // the dropdown before acting.
    const menu = document.getElementById('navMenu');
    if(menu) menu.classList.add('hide');
    openAuthSheet();
  };

  // Backdrop tap closes. It is dismissible by design.
  $('authSheet').addEventListener('click', e => { if(e.target === $('authSheet')) closeAuthSheet(); });
  // Escape closes too — there is no focus trap and nothing is `inert`, so
  // this is a courtesy dismissal, not a modal behaviour.
  $('authSheet').addEventListener('keydown', e => { if(e.key === 'Escape') closeAuthSheet(); });
  // Enter submits from either PIN field.
  for(const id of ['authPin', 'authPin2']){
    $(id).addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });
  }

  // Only latch `mounted` once the wiring above has actually succeeded — if an
  // exception were thrown partway through, leaving this false lets a later
  // call retry instead of permanently no-op-ing openAuthSheet() for the page.
  mounted = true;
  onAuthChange(paintBanner);
  onAuthChange(paintNav);
  paintBanner();
  paintNav();
}

export function openAuthSheet(next){
  if(!mounted) return;
  setMode(next || (auth().state === 'ok' ? 'signin' : mode));
  $('authSheet').classList.remove('hide');
  // Land focus on whatever still needs input: signed in, that's Sign out;
  // otherwise the PIN when the H number is already known (a remembered
  // session or Settings), else the H-number field itself.
  if(auth().state === 'ok') $('authSignOut').focus();
  else ($('authH').value ? $('authPin') : $('authH')).focus();
}

export function closeAuthSheet(){ if(mounted) $('authSheet').classList.add('hide'); }

// ── banner ─────────────────────────────────────────────────────────────────

function paintBanner(){
  const el = $('authBanner'); if(!el) return;
  const a = auth();
  const b = bannerFor(a.state, a.name);
  const hidden = bannerDismissed(store.get('authBannerDay'), localDate());
  el.className = 'auth-banner ' + (b.tone || '') + ((b.show && !hidden) ? '' : ' hide');
  $('authBannerText').textContent = b.text;
  $('authBannerCta').textContent = b.cta || 'Sign in';
}

function dismissBanner(){
  store.set('authBannerDay', localDate());
  paintBanner();
}

// ── nav entry ──────────────────────────────────────────────────────────────
// Never hidden — it is the only route to openAuthSheet() once the banner is
// dismissed for the day (or, once signed in, the only route to Sign out).
function paintNav(){
  const el = $('navSignIn'); if(!el) return;
  el.textContent = auth().state === 'ok' ? '👤 Account' : '🔑 Sign in';
}

// ── the sheet ──────────────────────────────────────────────────────────────

function setMode(next){
  mode = next === 'signup' ? 'signup' : 'signin';
  const a = auth();
  const signedIn = a.state === 'ok';

  $('authForm').classList.toggle('hide', signedIn);
  $('authMe').classList.toggle('hide', !signedIn);

  if(signedIn){
    $('authTitle').textContent = 'Signed in';
    $('authLede').textContent = 'This device is signed in. Your work syncs under this account.';
    $('authMeText').innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = a.name || a.hNumber || 'Signed in';
    $('authMeText').appendChild(strong);
    // An explicit break rather than relying on `.auth-me strong{display:block}`
    // to do the separating — this text still reads right if that rule ever moves.
    $('authMeText').appendChild(document.createElement('br'));
    $('authMeText').appendChild(
      document.createTextNode(`${a.hNumber || ''}${a.role ? ' · ' + a.role : ''}`));
    return;
  }

  $('authTitle').textContent = mode === 'signup' ? 'Create a PIN' : 'Sign in';
  $('authLede').textContent  = mode === 'signup'
    ? 'Claim your employee number and pick a 6-digit PIN. An administrator approves you before it works.'
    : 'Your employee number and your 6-digit PIN.';
  $('authSubmit').textContent = mode === 'signup' ? 'Create PIN' : 'Sign in';
  $('authSwitch').textContent = mode === 'signup'
    ? 'Already have a PIN? Sign in' : 'New here? Create a PIN';
  $('authConfirmWrap').classList.toggle('hide', mode !== 'signup');

  // Pre-fill from the session we remember, else the H number already in Settings.
  if(!$('authH').value) $('authH').value = auth().hNumber || store.get('hNumber') || '';
}

function say(text, tone){
  const el = $('authMsg');
  el.textContent = text || '';
  el.className = 'auth-msg ' + (tone || '') + (text ? '' : ' hide');
}

async function submit(){
  // Enter on #authPin/#authPin2 calls submit() directly (see the keydown
  // wiring above), bypassing the click path's `btn.disabled` guard. Two
  // concurrent Enters on a slow link would each post authLogin and each count
  // a strike on the server's wrong-PIN lockout ladder (5 fails -> 15 min,
  // 10 -> 60 min, 15 -> locked until an administrator unlocks it) — a rung a
  // field installer with no signal cannot reach anyone to clear.
  if($('authSubmit').disabled) return;

  const h   = $('authH').value.trim();
  const pin = $('authPin').value.trim();
  if(!h){ say('Enter your employee number', 'error'); return; }
  // Mirrors Code.gs PIN_LENGTH (6); the weak-PIN rules (no repeats/runs/years)
  // stay server-side and are surfaced verbatim, not duplicated here.
  if(!/^\d{6}$/.test(pin)){ say('Your PIN is 6 digits', 'error'); return; }
  if(mode === 'signup' && $('authPin2').value.trim() !== pin){
    say('The two PINs do not match', 'error'); return;
  }

  const btn = $('authSubmit');
  btn.disabled = true;
  btn.textContent = mode === 'signup' ? 'Creating…' : 'Signing in…';
  try {
    const out = mode === 'signup' ? await signUp(h, pin) : await signIn(h, pin);
    const fb  = mode === 'signup' ? signUpFeedback(out) : signInFeedback(out);
    if(fb.close){
      $('authPin').value = ''; $('authPin2').value = '';
      say('', '');
      closeAuthSheet();
      toast(`Signed in as ${auth().name || h}`);
      return;
    }
    // A mode switch is a fresh start for the PIN fields — a reset PIN typed into
    // a signup form would otherwise silently become the new one.
    if(fb.mode && fb.mode !== mode){ $('authPin').value = ''; $('authPin2').value = ''; setMode(fb.mode); }
    say(fb.text, fb.tone);
  } finally {
    btn.disabled = false;
    // Re-derive from the current `mode` rather than restoring the label
    // captured before the request: a needsPin outcome flips `mode` to 'signup'
    // above, and the pre-submit "Sign in" string would otherwise stick on a
    // button that now belongs to the create-a-PIN form.
    btn.textContent = mode === 'signup' ? 'Create PIN' : 'Sign in';
  }
}
