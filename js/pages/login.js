// ── Login page (login.html) ─────────────────────────────────────────────────
// Posts {action:'login', username, password} to the spine, stores the returned
// signed session via auth.js, and redirects to the requested (whitelisted) page.
// Works whether or not ENFORCE_AUTH is on — login is always reachable.
import { apiPost } from '../api.js';
import { setSession, sessionValid } from '../auth.js';

const $ = id => document.getElementById(id);

// Only ever redirect to a known in-app page (no open-redirect via ?next=).
const ALLOWED_NEXT = { 'index.html':1, 'map.html':1, 'teams.html':1, 'edit.html':1 };
function nextTarget(){
  const n = new URLSearchParams(location.search).get('next') || '';
  return ALLOWED_NEXT[n] ? n : 'index.html';
}

// Already signed in (and unexpired)? Skip straight through.
if(sessionValid()) location.replace(nextTarget());

const form = $('loginForm'), btn = $('loginBtn'), err = $('err');
const showErr = m => { err.textContent = m; err.classList.add('show'); };
const clearErr = () => err.classList.remove('show');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErr();
  const username = $('u').value.trim();
  const password = $('p').value;
  if(!username || !password){ showErr('Enter your username and password.'); return; }
  btn.classList.add('loading'); btn.disabled = true;
  try{
    const r = await apiPost({ action:'login', username, password });
    if(r && r.ok){
      setSession({ token:r.session, role:r.role, displayName:r.displayName,
                   hNumber:r.hNumber, exp:r.exp, pages:(r.access && r.access.pages) || [],
                   editAny: !!r.editAny });
      location.replace(nextTarget());
      return;
    }
    if(r && r.error === 'locked'){
      const mins = Math.ceil((r.retryAfter || 900) / 60);
      showErr('Too many attempts. Try again in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.');
    } else if(r && r.error === 'bad token'){
      showErr('App is misconfigured (bad app token). Contact your supervisor.');
    } else {
      showErr('Incorrect username or password.');
    }
  } catch(_){
    showErr('Can’t reach the server. Check your connection and try again.');
  } finally {
    btn.classList.remove('loading'); btn.disabled = false;
  }
});
