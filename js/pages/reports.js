// ── Reports back-office (reports.html) ──────────────────────────────────────
// Pick a date and see every installer who logged that day grouped under their
// sub foreman, with the day's core tallies and a closed/open badge. Closed
// days read the authoritative Tracker row; open days are tallied live from
// that day's stops + delay downtime. An open day can be quick-closed here
// (plain endOfDay — no travel review; edit.html still does the full review
// and re-closing there overwrites this, since endOfDay is idempotent).
import { $, esc, attr, toast } from '../dom.js';
import { apiGet, apiPost } from '../api.js';
import { PRINTABLE } from '../compute/tally.js';
import { BREAK_CATS, TRAVEL_ADJ_CATS } from '../compute/categories.js';

let roster = { employees: [], teams: [] };
let rows = [];        // the loaded date's report lines
let loadedDate = '';

function setStatus(kind, text){
  const p=$('status'), t=$('statusText');
  p.classList.remove('wait','off');
  if(kind==='off') p.classList.add('off'); else if(kind==='wait') p.classList.add('wait');
  t.textContent=text;
}

const fullName = e => ((e.firstName||'')+' '+(e.lastName||'')).trim();

// Same delay-only bucketing as the spine's downtimeTotalMin: breaks, misc
// travel and legacy TRAVEL_TIME rows subtract from gaps but are NOT delays.
function isDelayCat(c){
  return BREAK_CATS.indexOf(c) < 0 && TRAVEL_ADJ_CATS.indexOf(c) < 0 && c !== 'TRAVEL_TIME';
}

// Sub foreman for an installer display name: their team's sub wins, else the
// installer's own Settings pick (Employees.subName), else unassigned. Stops/
// Tracker key on display name, so the join is name → employee → team (same
// accepted quirk as everywhere else; first match wins on duplicate names).
function subOf(name){
  const emp = roster.employees.find(e => fullName(e) === name) || null;
  if (!emp) return { sub: '', emp: null };
  const team = roster.teams.find(t => t.memberLetters && (emp.hNumber in t.memberLetters)) || null;
  return { sub: ((team && team.subName) || emp.subName || '').trim(), emp };
}

// ── server I/O ──────────────────────────────────────────────────────────────
async function loadRoster(){
  // Paint-from-cache-then-refresh, sharing the same per-tab sessionStorage
  // cache as teams.html/edit.html (a convenience cache, not durable state).
  try{
    const cached = JSON.parse(sessionStorage.getItem('rosterCache') || 'null');
    if(cached && cached.ok) roster = cached;
  } catch {}
  try{
    const d = await apiGet('roster');
    if(d.ok){
      try{ sessionStorage.setItem('rosterCache', JSON.stringify(d)); } catch {}
      roster = d;
    }
  } catch {}
}

async function loadDate(){
  const date = $('day').value;
  if(!date){ toast('Pick a date'); return; }
  loadedDate = date;
  setStatus('wait','Loading…');
  try{
    // All three reads are windowed server-side to the one date, so every
    // returned row belongs to it — no client-side date parsing needed. The
    // downtime read degrades gracefully (open-day delays show 0) if the spine
    // hasn't been redeployed with it yet.
    const [p, t, dtR] = await Promise.all([
      apiGet('pins',     { from: date, to: date }),
      apiGet('tracker',  { from: date, to: date }),
      apiGet('downtime', { from: date, to: date }).catch(() => ({ downtime: [] })),
    ]);
    if(!p.ok || !t.ok) throw new Error('load failed');
    if(date !== $('day').value) return;   // a newer pick superseded this load

    // Tally the day's printable stops + delay minutes per installer name.
    const tally = {};
    const rowFor = name => tally[name] || (tally[name] = { installed:0, uti:0, dtMin:0 });
    (p.pins||[]).forEach(s => {
      if(!(s.status in PRINTABLE)) return;   // DONE markers don't earn a row
      const r = rowFor(s.installer);
      if(s.status === 'INSTALLED') r.installed++;
      else if(s.status === 'UTI')  r.uti++;
    });
    (dtR.downtime||[]).forEach(d => {
      if(!tally[d.installer]) return;        // downtime only, no stops → skip
      if(isDelayCat(d.category)) rowFor(d.installer).dtMin += Number(d.minutes)||0;
    });

    // Closed days: the Tracker row is authoritative — overwrite the live tally
    // (it already includes reviewed gap deductions) and add any closed-out
    // installer whose stops were since removed.
    const closed = {};
    (t.tracker||[]).forEach(r => { closed[r.installer] = r; });

    rows = Object.keys(tally).concat(Object.keys(closed).filter(n => !tally[n]))
      .map(name => {
        const tr = closed[name];
        const live = tally[name] || { installed:0, uti:0, dtMin:0 };
        const s = subOf(name);
        return {
          name,
          hNumber: s.emp ? s.emp.hNumber : '',
          sub: s.sub,
          closed: !!tr,
          installed: tr ? (Number(tr.installed)||0) : live.installed,
          uti:       tr ? (Number(tr.uti)||0)       : live.uti,
          dtMin:     tr ? (Number(tr.downtimeTotalMin)||0) : live.dtMin,
        };
      });
    render();
    setStatus('ok','Synced');
  } catch(e){
    setStatus('off','Offline — can’t load');
    toast('Couldn’t load the day — check the connection');
  }
}

// ── render ──────────────────────────────────────────────────────────────────
function render(){
  const box = $('report');
  if(!rows.length){
    box.innerHTML = `<div class="card"><div class="empty">Nothing logged on ${esc(loadedDate)}.</div></div>`;
    return;
  }
  // Group by sub — alphabetical, unassigned last.
  const groups = {};
  rows.forEach(r => { const k = r.sub || ''; (groups[k] = groups[k] || []).push(r); });
  const keys = Object.keys(groups).sort((a,b)=>{
    if(!a) return 1; if(!b) return -1;
    return a.localeCompare(b);
  });
  box.innerHTML = keys.map(k => {
    const lines = groups[k].slice().sort((a,b)=>a.name.localeCompare(b.name)).map(r => `
      <div class="rrow">
        <div class="rwho">
          <span class="rname">${esc(r.name)}</span>
          <span class="rnums">Installed ${r.installed} · UTI ${r.uti} · Downtime ${r.dtMin} min</span>
        </div>
        <span class="badge${r.closed?'':' open'}">${r.closed?'Closed':'Open'}</span>
        ${r.closed ? '' : `<button class="btn closebtn" data-name="${attr(r.name)}">Close day</button>`}
      </div>`).join('');
    return `<h1>${k ? esc(k) : 'No sub foreman'}</h1><div class="card">${lines}</div>`;
  }).join('');

  box.querySelectorAll('.closebtn').forEach(btn => { btn.onclick = () => closeDay(btn); });
}

// Quick close: minimal idempotent endOfDay. Bookends fall back to any persisted
// Days row and travel deductions stay as-is — the full review lives in edit.html.
async function closeDay(btn){
  const name = btn.dataset.name;
  const r = rows.find(x => x.name === name);
  if(!r) return;
  if(!confirm(`Close out ${name}'s ${loadedDate}? This writes their day to the Tracker without the travel review (it can still be re-reviewed and re-closed in Edit & Daily Log).`)) return;
  btn.disabled = true; btn.textContent = 'Closing…';
  setStatus('wait','Closing…');
  try{
    const body = { action:'endOfDay', installer: r.name, date: loadedDate };
    if(r.hNumber) body.installerId = r.hNumber;
    const d = await apiPost(body);
    if(!d.ok) throw new Error(d.error||'close failed');
    r.closed = true;
    if(d.summary){
      r.installed = Number(d.summary.installed)||0;
      r.uti       = Number(d.summary.uti)||0;
      r.dtMin     = Number(d.summary.downtimeTotalMin)||0;
    }
    render();
    setStatus('ok','Synced');
    toast(`${name}'s day closed ✓`);
  } catch(err){
    btn.disabled = false; btn.textContent = 'Close day';
    setStatus('off','Error');
    toast(err.message || 'Could not close');
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
$('day').onchange = loadDate;

// top-bar navigation
$('navSel').onchange = e => {
  const v = e.target.value;
  if(v==='log')            window.location.href = 'index.html';
  else if(v==='map')       window.location.href = 'map.html';
  else if(v==='analytics') window.location.href = 'map.html#analytics';
  else if(v==='teams')     window.location.href = 'teams.html';
  else if(v==='edit')      window.location.href = 'edit.html';
};
window.addEventListener('pageshow', () => { $('navSel').value = 'reports'; });

// default the date to today (local), load the roster, then the day
(function(){ const n=new Date(); const p=x=>('0'+x).slice(-2);
  $('day').value = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}`; })();
loadRoster().then(loadDate);
