// ── My audit, the installer's own page (my-audit.html) ───────────────────────
// The same audit the office sees on audits.html, for the one name in this phone's
// Settings: where the day goes, the delays logged and the pause time nothing was
// logged against, over a period and for a single day. Opened from ☰ ▸ My audit on
// the log page. Read-only, and it needs a connection.
//
// No password. It asks the spine for one named installer with the app's public
// token, exactly as the log page does for its own day. "Only their own" is
// therefore the name in Settings, not a lock: per-installer sign-in does not
// exist. What this page must never do is import the office gate or ask for a
// password-gated read. tests/admin-gate.test.mjs scans this file as capture-side
// code.
//
// The drive log (owner's decision, 2026-11-19): an installer sees their OWN, through
// `myDriveTracks`, which wants the name and the H number that belongs to it and
// gives one day at a time. The office read of anyone's drive log (`driveTracks`)
// stays behind the password and must never be asked for here. A phone with no H
// number in Settings is given no loader, and the shared view then draws nothing.
import { $ } from '../dom.js';
import { cfg } from '../store.js';
import { apiGet } from '../api.js';
import { initAuditView } from '../audit-view.js';

const name = String(cfg().name || '').trim();
const hNumber = String(cfg().hNumber || '').trim();
const whose = $('whose');
if(whose) whose.textContent = name || '—';

async function loadDriveLegs(installer, date){
  const res = await apiGet('myDriveTracks', { installer, hNumber, from: date, to: date });
  if(!res || res.ok === false) throw new Error((res && res.error) || 'no answer');
  // a spine from before this read answers an unknown action with a bare ok
  if(!Array.isArray(res.driveTracks)) throw new Error('the server does not have this yet');
  return res.driveTracks;
}

if(!name){
  const note = $('auNote'), controls = $('auPeriodControls'), text = $('statusText');
  if(note) note.innerHTML = '<p class="au-note">Set your name in Settings on the log page first.</p>';
  if(controls) controls.classList.add('hide');
  if(text) text.textContent = 'No name set';
} else {
  initAuditView({ installers: null, fixedInstaller: name, loadDriveLegs: hNumber ? loadDriveLegs : null });
}
