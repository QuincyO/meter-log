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
// code, and the drive log (the one thing the office view has that this does not)
// is behind that password. So there is no drive-log loader here, and the shared
// view draws nothing for it.
import { $ } from '../dom.js';
import { cfg } from '../store.js';
import { initAuditView } from '../audit-view.js';

const name = String(cfg().name || '').trim();
const whose = $('whose');
if(whose) whose.textContent = name || '—';

if(!name){
  const note = $('auNote'), controls = $('auPeriodControls'), text = $('statusText');
  if(note) note.innerHTML = '<p class="au-note">Set your name in Settings on the log page first.</p>';
  if(controls) controls.classList.add('hide');
  if(text) text.textContent = 'No name set';
} else {
  initAuditView({ installers: null, fixedInstaller: name, loadDriveLegs: null });
}
