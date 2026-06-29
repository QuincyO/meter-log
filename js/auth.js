// ── Client-side session + page gate ─────────────────────────────────────────
// The login token + the user's role/identity/allowed-pages live in ONE localStorage
// key ('auth'), read SYNCHRONOUSLY so the per-page gate can run as the first line of
// a page module (an async IndexedDB read would race page boot). This is UX + the
// session carrier only — the REAL enforcement is server-side in Code.gs, so a tampered
// 'auth' blob gains nothing (any forged token fails the spine's signature check).
//
// Shape of the stored blob (written by login.js):
//   { token, role, displayName, hNumber, exp, pages }   // pages: '*' or ['index',…]
import { store } from './store.js';

const KEY = 'auth';

export function getSession(){
  try { return JSON.parse(store.get(KEY) || 'null'); } catch { return null; }
}
export function setSession(s){
  store.set(KEY, JSON.stringify(s || null));
  // Keep the legacy name/hNumber (which cfg() uses to stamp `installer` on every
  // logged stop) in sync with the token's identity, so installer-ownership checks
  // on the server match the logged-in user.
  if(s && s.displayName) store.set('name', s.displayName);
  if(s && s.hNumber != null) store.set('hNumber', String(s.hNumber));
}
export function clearSession(){ store.set(KEY, 'null'); }

export function sessionPresent(){ const s = getSession(); return !!(s && s.token); }
export function sessionValid(){ const s = getSession(); return !!(s && s.token && Number(s.exp) * 1000 > Date.now()); }
export function sessionExpiredOffline(){ return sessionPresent() && !sessionValid() && !navigator.onLine; }
export function role(){ const s = getSession(); return (s && s.role) || ''; }
export function displayName(){ const s = getSession(); return (s && s.displayName) || ''; }
// Privileged = the server said this user holds the editAnyInstaller capability
// (robust to custom role names / explicit page lists, unlike checking pages==='*').
export function isSupervisor(){ const s = getSession(); return !!(s && s.editAny); }

export function pageAllowed(page){
  const s = getSession(); if(!s) return false;
  const pages = s.pages;
  return pages === '*' || (Array.isArray(pages) && pages.indexOf(page) >= 0);
}

function currentPage(){ return (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/,'') || 'index'; }

// The gate. Call FIRST thing in a page module: requireLogin('index'|'map'|'teams'|'edit').
// - no session            → go to login
// - expired & ONLINE       → go to login (must re-auth)
// - expired & OFFLINE       → allow (keep logging; writes queue, held until re-login)
// - role lacks this page    → bounce to the capture page
// Throws after a redirect so the rest of the page module stops evaluating.
export function requireLogin(page){
  const next = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
  if(!sessionPresent()){
    location.replace('login.html?next=' + next);
    throw new Error('auth: redirecting to login');
  }
  if(!sessionValid() && navigator.onLine){
    location.replace('login.html?next=' + next);
    throw new Error('auth: session expired');
  }
  if(!pageAllowed(page)){
    location.replace('index.html');
    throw new Error('auth: role not permitted for ' + page);
  }
}

export function logout(){ clearSession(); location.replace('login.html'); }

// Inject a small "Name · Logout" control into the page's .bar (every page has one),
// plus a sticky banner if the session has expired while offline. Call after requireLogin.
export function mountAuthBar(){
  const s = getSession(); if(!s) return;
  const bar = document.querySelector('.bar') || document.body;
  if(!document.getElementById('authLogout')){
    const btn = document.createElement('button');
    btn.id = 'authLogout'; btn.type = 'button';
    btn.textContent = (s.displayName ? s.displayName.split(/\s+/)[0] : 'User') + ' · Logout';
    btn.style.cssText = 'margin-left:auto;background:transparent;border:1px solid rgba(255,255,255,.25);' +
      'color:inherit;font:600 12px system-ui;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap';
    btn.onclick = () => { if(confirm('Sign out?')) logout(); };
    bar.appendChild(btn);
  }
  if(sessionExpiredOffline()) showAuthBanner('Session expired — reconnect to sign in. You can keep logging; it syncs after you sign in.');
}

let _banner = null;
export function showAuthBanner(msg){
  if(_banner){ _banner.textContent = msg; return; }
  _banner = document.createElement('div');
  _banner.textContent = msg;
  _banner.style.cssText = 'position:sticky;top:0;z-index:9999;background:#7a1f1f;color:#fff;' +
    'padding:8px 12px;font:600 13px system-ui;text-align:center;cursor:pointer';
  _banner.onclick = () => { location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html')); };
  document.body.insertBefore(_banner, document.body.firstChild);
}

// Queue onAuthFail hook target: a write was rejected for a bad/expired session.
// Show a tappable banner; if online, take them to re-login (the durable queue keeps
// the write and drains it after sign-in).
export function promptRelogin(){
  showAuthBanner('Session expired — tap here to sign in again. Your logs are saved and will sync.');
}
