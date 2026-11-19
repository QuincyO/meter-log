// ── Audits, the office page (audits.html) ────────────────────────────────────
// One installer's work over a period and on a single day: where the day goes, the
// delays they logged and the pause time nothing was logged against. Read-only.
// The view itself is js/audit-view.js, shared with the installer's own page
// (my-audit.html); this entry adds the two things only the office has: the
// installer picker and the day's drive log.
//
// The drive-log fetch lives in THIS file and nowhere else on purpose. `driveTracks`
// is behind the office password, and tests/admin-gate.test.mjs scans every other
// script as capture-side code that must never name a gated read. Moving the call
// into the shared view would fail that test, and rightly: the phone runs the view.
import { $ } from '../dom.js';
import { apiGet } from '../api.js';
import { requireAdmin } from '../admin-auth.js';
import { initAuditView } from '../audit-view.js';

// Office page: nothing below runs until the admin password is accepted (the
// spine enforces it regardless — see js/admin-auth.js).
await requireAdmin();

const fullName = e => ((e.firstName || '') + ' ' + (e.lastName || '')).trim();

async function loadInstallers(){
  // The same per-tab roster cache the other office pages share: paint from it if
  // the read fails, refresh it when the read succeeds.
  let roster = null;
  try { roster = JSON.parse(sessionStorage.getItem('rosterCache') || 'null'); } catch {}
  try {
    const res = await apiGet('roster');
    if(res && res.ok){
      roster = res;
      try { sessionStorage.setItem('rosterCache', JSON.stringify(res)); } catch {}
    }
  } catch {}
  const names = ((roster && roster.employees) || []).map(fullName).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

async function loadDriveLegs(installer, date){
  const res = await apiGet('driveTracks', { installer, from: date, to: date });
  if(!res || res.ok === false) throw new Error((res && res.error) || 'no answer');
  return res.driveTracks || [];
}

// top-bar navigation
const nav = $('navSel');
if(nav){
  nav.onchange = e => {
    const v = e.target.value;
    if(v === 'log')            window.location.href = 'index.html';
    else if(v === 'map')       window.location.href = 'map.html';
    else if(v === 'analytics') window.location.href = 'map.html#analytics';
    else if(v === 'teams')     window.location.href = 'teams.html';
    else if(v === 'edit')      window.location.href = 'edit.html';
    else if(v === 'reports')   window.location.href = 'reports.html';
    else if(v === 'planner')   window.location.href = 'planner.html';
    else if(v === 'help')      window.location.href = 'help.html';
  };
  window.addEventListener('pageshow', () => { nav.value = 'audits'; });
}

initAuditView({ installers: await loadInstallers(), fixedInstaller: null, loadDriveLegs });
