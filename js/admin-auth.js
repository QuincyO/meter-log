// ── Office-page login gate ──────────────────────────────────────────────────
// The office pages (map/analytics, edit, teams, reports, planner) start with
//   await requireAdmin();
// right after their imports. A module pauses at a top-level await, so nothing
// below it — no handler binding, no load() — runs until the owner is in.
//
// This is the AFFORDANCE, not the lock. The page source is public on GitHub
// Pages, so anyone can skip this box; what they cannot skip is the spine, which
// refuses its ADMIN_GET/ADMIN_POST actions without `adminKey` equal to the
// ADMIN_KEY Script Property (Code.gs isAdmin). js/api.js attaches the stored
// key to every call. The capture page never imports this file and never logs in.
import { apiGet } from './api.js';

const KEY = 'adminKey';
const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
const setKey = v => { try { localStorage.setItem(KEY, v); } catch {} };
const dropKey = () => { try { localStorage.removeItem(KEY); } catch {} };

const CSS = `
#adminGate{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  background:#f4f5f7;color:#16181d;font:16px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
#adminGate form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px;background:#fff;
  border:1px solid #d9dce3;border-radius:12px;padding:24px}
#adminGate h1{margin:0;font-size:20px}
#adminGate p{margin:0;font-size:14px;color:#5b6070}
#adminGate input{font:inherit;padding:10px 12px;border:1px solid #c5c9d3;border-radius:8px;background:#fff;color:inherit}
#adminGate button{font:inherit;font-weight:600;padding:10px 12px;border:0;border-radius:8px;background:#2f5bd3;color:#fff;cursor:pointer}
#adminGate button:disabled{opacity:.6;cursor:default}
#adminGate .err{color:#b42318;min-height:1.2em}
#adminGate a{color:inherit;font-size:14px}
#adminLogout{position:fixed;left:12px;bottom:12px;z-index:99999;font:13px system-ui,sans-serif;padding:6px 10px;
  border-radius:8px;border:1px solid #c5c9d3;background:#fff;color:#16181d;cursor:pointer;opacity:.85}
@media (prefers-color-scheme: dark){
  #adminGate{background:#111318;color:#e8eaf0}
  #adminGate form{background:#1b1e25;border-color:#2c313c}
  #adminGate p{color:#a3a9b8}
  #adminGate input{background:#111318;border-color:#3a4050}
  #adminGate .err{color:#ff8a80}
  #adminLogout{background:#1b1e25;color:#e8eaf0;border-color:#3a4050}
}`;

function injectCss(){
  if(document.getElementById('adminGateCss')) return;
  const s = document.createElement('style');
  s.id = 'adminGateCss';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// Once in: a way back out, and a re-lock if the spine ever refuses the key
// (changed ADMIN_KEY, lockout) — api.js clears the key, then calls this hook.
function unlocked(){
  window.__onAdminRequired = () => location.reload();
  if(document.getElementById('adminLogout')) return;
  const b = document.createElement('button');
  b.id = 'adminLogout';
  b.type = 'button';
  b.textContent = '🔒 Log out';
  b.onclick = () => { dropKey(); location.reload(); };
  document.body.appendChild(b);
}

function showBox(){
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.id = 'adminGate';
    wrap.innerHTML = `
      <form autocomplete="on">
        <h1>Office login</h1>
        <p>This page needs the admin password.</p>
        <input type="password" name="password" autocomplete="current-password" placeholder="Password" required>
        <button type="submit">Unlock</button>
        <div class="err" role="alert"></div>
        <a href="./index.html">← Back to the log</a>
      </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const input = wrap.querySelector('input');
    const btn = wrap.querySelector('button');
    const err = wrap.querySelector('.err');
    input.focus();
    form.onsubmit = async e => {
      e.preventDefault();
      const v = input.value;
      if(!v) return;
      btn.disabled = true; err.textContent = '';
      setKey(v);
      let res = null;
      try { res = await apiGet('adminCheck'); }
      catch { dropKey(); err.textContent = 'Couldn’t reach the server — check the connection.'; btn.disabled = false; return; }
      if(res && res.ok){ wrap.remove(); resolve(); return; }
      dropKey();
      err.textContent = 'Not accepted. After 10 wrong tries, logins pause for 10 minutes.';
      input.select();
      btn.disabled = false;
    };
  });
}

export async function requireAdmin(){
  injectCss();
  if(getKey()){
    try {
      const res = await apiGet('adminCheck');
      if(res && res.ok){ unlocked(); return; }
      // Refused: api.js has already dropped the key — fall through to the box.
    } catch {
      // No network. Let the page open on the stored key; its own reads will fail
      // or be refused (which re-locks via the hook) exactly as they would anyway.
      unlocked(); return;
    }
  }
  await showBox();
  unlocked();
}
