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
<div class="auth-sheet hide" id="authSheet" role="dialog" aria-modal="true" aria-labelledby="authTitle">
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

let mounted = false;
let mode = 'signin';          // 'signin' | 'signup'

/** Mount once, paint, and subscribe. Safe to call on any page and twice. */
export function initAuthUI(){
  if(mounted || typeof document === 'undefined') return;
  mounted = true;

  // The banner sits directly under the page's top bar on every page that has
  // one, so it reads as chrome rather than as part of the form beneath it.
  const bar = document.querySelector('.bar');
  if(bar) bar.insertAdjacentHTML('afterend', BANNER_HTML);
  else document.body.insertAdjacentHTML('afterbegin', BANNER_HTML);
  document.body.insertAdjacentHTML('beforeend', SHEET_HTML);

  $('authBannerCta').onclick = () => openAuthSheet();
  $('authBannerX').onclick   = dismissBanner;
  $('authClose').onclick     = closeAuthSheet;
  $('authSwitch').onclick    = () => setMode(mode === 'signin' ? 'signup' : 'signin');
  $('authSubmit').onclick    = submit;
  $('authSignOut').onclick   = () => { signOut(); setMode('signin'); toast('Signed out'); };

  // Backdrop tap closes. It is dismissible by design.
  $('authSheet').addEventListener('click', e => { if(e.target === $('authSheet')) closeAuthSheet(); });
  // Enter submits from either PIN field.
  for(const id of ['authPin', 'authPin2']){
    $(id).addEventListener('keydown', e => { if(e.key === 'Enter') submit(); });
  }

  onAuthChange(paintBanner);
  paintBanner();
}

export function openAuthSheet(next){
  if(!mounted) return;
  setMode(next || (auth().state === 'ok' ? 'signin' : mode));
  $('authSheet').classList.remove('hide');
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
  const h   = $('authH').value.trim();
  const pin = $('authPin').value.trim();
  if(!h){ say('Enter your employee number', 'error'); return; }
  if(!/^\d{6}$/.test(pin)){ say('Your PIN is 6 digits', 'error'); return; }
  if(mode === 'signup' && $('authPin2').value.trim() !== pin){
    say('The two PINs do not match', 'error'); return;
  }

  const btn = $('authSubmit');
  btn.disabled = true;
  const label = btn.textContent;
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
    btn.textContent = label;
  }
}
