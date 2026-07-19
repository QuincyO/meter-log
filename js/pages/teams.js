// ── Crew & Boat Teams admin (teams.html) ────────────────────────────────────
// Manages the Employees / Teams / Captains / Subs tabs via the roster read and
// the save*/delete* writes. Read-mostly admin page — no offline queue.
import { $, enc, esc, attr, toast } from '../dom.js';
import { apiGet, apiPost } from '../api.js';
import { store } from '../store.js';

let state = { employees:[], teams:[], captains:[], subs:[] };

// ── work mode (boat teams | land crews) ────────────────────────────────────
// Same persisted switch as the capture page: flips the accent theme and which
// team cards show. A land crew is a Teams row with type='land' — crew number in
// boatNumber, sub foreman in subName, no captain/boat name.
const teamType = t => String((t && t.type) || '').trim().toLowerCase() === 'land' ? 'land' : 'boat';
function workMode(){ return store.get('workMode')==='land' ? 'land' : 'boat'; }
function setMode(m){
  store.set('workMode', m);
  document.documentElement.dataset.mode = m;
  $('modeBoat').classList.toggle('on', m==='boat');
  $('modeLand').classList.toggle('on', m==='land');
  const land = m==='land';
  $('teamsHead').textContent = land ? 'Land Crews' : 'Boat Teams';
  $('teamsSub').textContent = land
    ? 'One card per crew (number + sub foreman). Give each member a letter — people sharing a letter are partners, so Crew 3 with A and B pairs reads as 3A and 3B.'
    : 'One card per boat (number, name, captain, sub). Give each crew member a letter — people sharing a letter on a boat are partners, so Boat 11 with A and B pairs reads as 11A and 11B. These auto-fill the daily log when a member ends their day.';
  $('newTeam').textContent = land ? '+ New crew' : '+ New boat';
  renderTeams();
}
$('modeBoat').onclick = () => setMode('boat');
$('modeLand').onclick = () => setMode('land');

function setStatus(kind, text){
  const p=$('status'), t=$('statusText');
  p.classList.remove('wait','off');
  if(kind==='off') p.classList.add('off'); else if(kind==='wait') p.classList.add('wait');
  t.textContent=text;
}

const fullName = e => ((e.firstName||'')+' '+(e.lastName||'')).trim();
const empByH   = h => state.employees.find(e => e.hNumber===h) || null;
const labelH   = h => { const e=empByH(h); return e ? `${fullName(e)} (${e.hNumber})` : h; };

// ── server I/O ─────────────────────────────────────────────────────────────
function adoptRoster(d){
  state.employees = (d.employees||[]);
  state.teams     = (d.teams||[]);
  state.captains  = (d.captains||[]);
  state.subs      = (d.subs||[]);
}
async function load(){
  // Paint instantly from the last-fetched copy, then refresh from the Sheet.
  // sessionStorage on purpose (not IndexedDB): a per-tab convenience cache,
  // not durable offline state, so the IndexedDB storage policy in CLAUDE.md
  // doesn't apply to it.
  // Cached paint on the initial open only — the post-save reloads must never
  // flash the pre-save roster.
  const initial = !state.employees.length && !state.teams.length;
  let painted = false;
  if(initial) try{
    const cached = JSON.parse(sessionStorage.getItem('rosterCache') || 'null');
    if(cached && cached.ok){
      adoptRoster(cached);
      renderCrew(); renderCaptainsSubs(); renderTeams();
      painted = true; setStatus('wait','Refreshing…');
    }
  } catch {}
  if(!painted) setStatus('wait','Loading…');
  try{
    const d = await apiGet('roster');
    if(!d.ok) throw new Error(d.error||'load failed');
    try{ sessionStorage.setItem('rosterCache', JSON.stringify(d)); } catch {}
    adoptRoster(d);
    setStatus('ok','Synced');
    // Don't clobber a boat card someone already expanded (mid-edit) with the
    // background repaint — the fresh state still lands in `state` above.
    if(!(painted && document.querySelector('.cardbody:not(.hide)'))){
      renderCrew(); renderCaptainsSubs(); renderTeams();
    }
  } catch(e){
    if(painted){ setStatus('ok','Cached roster'); return; }
    setStatus('off','Offline — can’t load');
    toast('Couldn’t load crew — check the connection');
  }
}
async function post(payload){
  const d = await apiPost(payload);   // injects token; text/plain dodges CORS preflight
  if(!d.ok) throw new Error(d.error||'save failed');
  return d;
}

// ── Crew ───────────────────────────────────────────────────────────────────
function renderCrew(){
  const box = $('crewList');
  if(!state.employees.length){ box.innerHTML = '<div class="empty">No crew yet — add the first person below.</div>'; return; }
  const q = ($('crewSearch').value||'').trim().toLowerCase();
  if(!q){
    box.innerHTML = `<div class="empty">${state.employees.length} crew on file — type a name or H# above to edit someone.</div>`;
    return;
  }
  const sorted = state.employees.slice()
    .filter(e => (fullName(e)+' '+e.hNumber).toLowerCase().includes(q))
    .sort((a,b)=> (a.lastName+a.firstName).localeCompare(b.lastName+b.firstName));
  if(!sorted.length){ box.innerHTML = '<div class="empty">No crew match that search.</div>'; return; }
  box.innerHTML = sorted.map(e => `
    <div class="crewrow" data-h="${attr(e.hNumber)}">
      <div><label>First name</label><input data-f="firstName" value="${attr(e.firstName)}" autocapitalize="words"></div>
      <div><label>Last name</label><input data-f="lastName" value="${attr(e.lastName)}" autocapitalize="words"></div>
      <div><label>Employee # (H)</label><input class="mono" value="${attr(e.hNumber)}" disabled title="The H# is the key and can’t be changed — delete &amp; re-add to change it"></div>
      <button class="btn x" data-act="save" title="Save">✓</button>
      <button class="btn danger x" data-act="del" title="Remove">✕</button>
    </div>`).join('');

  box.querySelectorAll('.crewrow').forEach(row => {
    const h = row.dataset.h;
    row.querySelector('[data-act="save"]').onclick = async () => {
      const first = row.querySelector('[data-f="firstName"]').value.trim();
      const last  = row.querySelector('[data-f="lastName"]').value.trim();
      if(!first || !last){ toast('First and last name required'); return; }
      try{ await post({ action:'saveEmployee', hNumber:h, firstName:first, lastName:last });
           toast('Saved ✓'); await load(); }
      catch(err){ toast(err.message); }
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      if(!confirm(`Remove ${labelH(h)}? They’ll also be taken off any boat team.`)) return;
      try{ await post({ action:'deleteEmployee', hNumber:h }); toast('Removed ✓'); await load(); }
      catch(err){ toast(err.message); }
    };
  });
}

$('addEmp').onclick = async () => {
  const first = $('newFirst').value.trim(), last = $('newLast').value.trim(), h = $('newH').value.trim();
  if(!first || !last){ toast('First and last name required'); return; }
  if(!h){ toast('Employee # (H) required'); return; }
  if(empByH(h)){ toast('That H# already exists'); return; }
  try{
    await post({ action:'saveEmployee', hNumber:h, firstName:first, lastName:last });
    $('newFirst').value=''; $('newLast').value=''; $('newH').value='';
    toast('Added ✓'); await load();
  } catch(err){ toast(err.message); }
};

$('crewSearch').oninput = renderCrew;

// ── Captains & Subforemen (saved name lists) ───────────────────────────────
function renderCaptainsSubs(){
  renderNameList('captainList', state.captains, 'captain');
  renderNameList('subList',     state.subs,     'sub');
}
function renderNameList(boxId, names, role){
  const box = $(boxId);
  if(!names.length){ box.innerHTML = '<div class="empty" style="padding:6px 2px">None yet.</div>'; return; }
  box.innerHTML = names.slice().sort((a,b)=>a.localeCompare(b)).map(n =>
    `<div class="namerow"><span>${esc(n)}</span><button class="btn danger x" data-n="${attr(n)}" title="Remove">✕</button></div>`).join('');
  box.querySelectorAll('button[data-n]').forEach(b => b.onclick = async () => {
    if(!confirm(`Remove “${b.dataset.n}” from the ${role==='captain'?'captains':'subs'} list?`)) return;
    try{ await post({ action: role==='captain'?'deleteCaptain':'deleteSub', name:b.dataset.n }); toast('Removed ✓'); await load(); }
    catch(err){ toast(err.message); }
  });
}
async function addName(inputId, action){
  const n = $(inputId).value.trim();
  if(!n){ toast('Type a name first'); return; }
  try{ await post({ action, name:n }); $(inputId).value=''; toast('Added ✓'); await load(); }
  catch(err){ toast(err.message); }
}
$('addCaptain').onclick = () => addName('newCaptain', 'saveCaptain');
$('addSub').onclick     = () => addName('newSub', 'saveSub');

// ── Boats & teams ──────────────────────────────────────────────────────────
// One card per boat. Each member gets a team letter; people sharing a letter on
// a boat are partners, so member→"A" on boat 11 is team "11A". Crew are added by
// typing a name: an existing installer is linked by H number, a brand-new name
// is auto-created (a real Employees row, H number generated by the spine) on
// save. Letters are generated A..Z so crew size / distinct teams never cap.
const LETTERS = Array.from({length:26}, (_,i)=> String.fromCharCode(65+i)); // A..Z
const boatLabel = t => (teamType(t)==='land' ? 'Crew ' : 'Boat ')
  + ((t.boatNumber||'') || '—') + (t.boatName ? (' · ' + t.boatName) : '');

// Only the current mode's cards show — boat teams in boat mode, crews in land.
function renderTeams(){
  const box = $('teamList');
  const mine = state.teams.filter(t => teamType(t) === workMode());
  if(!mine.length){
    box.innerHTML = `<div class="empty" style="padding:4px 2px 10px">${
      workMode()==='land' ? 'No crews yet — tap “New crew”.' : 'No boats yet — tap “New boat”.'}</div>`;
    return;
  }
  box.innerHTML = '';
  mine.slice()
    .sort((a,b)=> String(a.boatNumber||'').localeCompare(String(b.boatNumber||''), undefined, {numeric:true}))
    .forEach(t => box.appendChild(teamCard(t)));
}

// A <select> of saved names (captains or subs) with an "add new…" escape hatch.
function nameSelect(role, current, names){
  const inList = names.some(n => n.toLowerCase() === (current||'').toLowerCase());
  const opts = ['<option value="">— none —</option>']
    .concat(names.slice().sort((a,b)=>a.localeCompare(b))
      .map(n => `<option value="${attr(n)}" ${n.toLowerCase()===(current||'').toLowerCase()?'selected':''}>${esc(n)}</option>`));
  if(current && !inList) opts.push(`<option value="${attr(current)}" selected>${esc(current)}</option>`);
  opts.push('<option value="__new__">➕ Add new…</option>');
  return `<select data-role="${role}Sel">${opts.join('')}</select>`
       + `<input data-role="${role}New" class="newname hide" placeholder="New ${role==='captain'?'captain':'sub'} name" autocapitalize="words">`;
}

const byName = (a,b) => ((a.lastName||'')+(a.firstName||'')).localeCompare((b.lastName||'')+(b.firstName||''));

// Group an {hNumber:letter} map into team-letter buckets, rendered "<bn><L>: a + b".
function teamGroupsHTML(bn, map, nameFn){
  const groups = {};
  Object.keys(map).forEach(h => { (groups[map[h]] = groups[map[h]] || []).push(h); });
  return Object.keys(groups).sort().map(L =>
    `<b>${esc(bn)}${esc(L)}</b>: ` + groups[L].map(h => esc(nameFn(h))).join(' + '));
}

// A boat card. Collapsed by default showing a summary; expand to edit.
// `t.id===''` marks an unsaved new boat (opens expanded).
function teamCard(t){
  const card = document.createElement('div');
  card.className = 'card';
  const land = teamType(t) === 'land';
  const title = t.id ? esc(boatLabel(t)) : (land ? 'New crew' : 'New boat');

  const cardUid = 'c' + Math.random().toString(36).slice(2, 8); // unique per card
  // working copy of {hNumber:letter}, only for crew that still exist…
  const assigned = {};
  Object.keys(t.memberLetters || {}).forEach(h => {
    if(empByH(h)) assigned[h] = String(t.memberLetters[h] || '').toUpperCase() || 'A';
  });
  // …plus typed-in names not yet in Employees — the spine auto-creates these on save
  const pending = []; // [{name, letter}]

  card.innerHTML = `
    <div class="head">
      <strong data-act="toggle">${title}</strong>
      <button class="btn x toggle" data-act="toggle" title="Expand">⌄</button>
    </div>
    <div class="cardsummary" data-role="cardsummary"></div>
    <div class="cardbody hide" data-role="body">
      <div class="grid3">
        <div><label>${land ? 'Crew number' : 'Boat number'}</label><input data-f="boatNumber" class="mono" value="${attr(t.boatNumber)}" placeholder="${land ? 'e.g. 3' : 'e.g. 11'}"></div>
        <div class="${land ? 'hide' : ''}"><label>Boat name <span style="font-weight:500;color:var(--ink-soft)">(optional)</span></label><input data-f="boatName" value="${attr(t.boatName)}" placeholder="e.g. Sea Ray"></div>
        <div></div>
      </div>
      <div class="grid2">
        <div class="${land ? 'hide' : ''}"><label>Captain</label>${nameSelect('captain', t.captainName, state.captains)}</div>
        <div><label>${land ? 'Sub foreman' : 'Sub / subforeman'}</label>${nameSelect('sub', t.subName, state.subs)}</div>
      </div>
      <label>Crew — assign a team letter <span style="font-weight:500;color:var(--ink-soft)">(same letter = partners)</span></label>
      <div class="assignlist" data-role="members"></div>
      <div class="addmember" data-role="addmember"></div>
      <div class="assignsummary" data-role="summary"></div>
      <div class="actions">
        <button class="btn primary" data-act="save">${land ? 'Save crew' : 'Save boat'}</button>
        <button class="btn danger" data-act="del">Delete</button>
      </div>
    </div>`;

  // ── collapse / expand ──────────────────────────────────────────────────────
  const body    = card.querySelector('[data-role="body"]');
  const sumLine = card.querySelector('[data-role="cardsummary"]');
  const toggleBtn = card.querySelector('button.toggle');
  function setOpen(open){
    body.classList.toggle('hide', !open);
    sumLine.classList.toggle('hide', open);
    toggleBtn.textContent = open ? '⌃' : '⌄';
    toggleBtn.title = open ? 'Collapse' : 'Expand';
  }
  card.querySelectorAll('[data-act="toggle"]').forEach(el =>
    el.onclick = () => setOpen(body.classList.contains('hide')));

  // collapsed summary reflects saved data (a save reloads the page state)
  function fillCardSummary(){
    const bits = [];
    if(t.captainName) bits.push(`<span class="muted">Capt</span> ${esc(t.captainName)}`);
    if(t.subName)     bits.push(`<span class="muted">Sub</span> ${esc(t.subName)}`);
    const teams = teamGroupsHTML(t.boatNumber||'', assigned, h => fullName(empByH(h)) || h);
    let html = bits.length ? bits.join(' &nbsp;·&nbsp; ') : '';
    if(teams.length) html += (html ? '<br>' : '') + teams.join(' &nbsp;·&nbsp; ');
    if(!html) html = '<span class="muted">No captain, sub, or crew set yet — tap to edit.</span>';
    sumLine.innerHTML = html;
  }
  fillCardSummary();

  // captain / sub dropdowns — reveal the text box when "Add new…" is chosen
  ['captain','sub'].forEach(role => {
    const sel = card.querySelector(`[data-role="${role}Sel"]`);
    const inp = card.querySelector(`[data-role="${role}New"]`);
    sel.onchange = () => {
      const isNew = sel.value === '__new__';
      inp.classList.toggle('hide', !isNew);
      if(isNew) inp.focus();
    };
  });
  const resolveName = role => {
    const sel = card.querySelector(`[data-role="${role}Sel"]`);
    const inp = card.querySelector(`[data-role="${role}New"]`);
    return (sel.value === '__new__' ? inp.value : sel.value).trim();
  };

  const membersBox = card.querySelector('[data-role="members"]');
  const addBox     = card.querySelector('[data-role="addmember"]');
  const summaryEl  = card.querySelector('[data-role="summary"]');

  // first team letter not already in use by an assigned or pending member
  function nextLetter(){
    const used = new Set([...Object.values(assigned), ...pending.map(p => p.letter)]);
    return LETTERS.find(L => !used.has(L)) || 'A';
  }

  // Add a typed name: link an existing installer by H number, else queue a new
  // crew member for the spine to auto-create on save.
  function addByName(raw){
    const name = String(raw || '').trim();
    if(!name) return;
    const match = state.employees.find(e => fullName(e).toLowerCase() === name.toLowerCase());
    if(match){
      if(match.hNumber in assigned){ toast(fullName(match) + ' is already on this boat'); return; }
      assigned[match.hNumber] = nextLetter();
    } else {
      if(pending.some(p => p.name.toLowerCase() === name.toLowerCase())){ toast(name + ' is already added'); return; }
      pending.push({ name, letter: nextLetter() });
    }
    renderMembers(); updateSummary();
  }

  function updateSummary(){
    const bn = card.querySelector('[data-f="boatNumber"]').value.trim();
    const groups = {};
    Object.keys(assigned).forEach(h => { (groups[assigned[h]] = groups[assigned[h]] || []).push(labelH(h)); });
    pending.forEach(p => { (groups[p.letter] = groups[p.letter] || []).push(p.name + ' (new)'); });
    const parts = Object.keys(groups).sort().map(L =>
      `<b>${esc(bn)}${esc(L)}</b>: ` + groups[L].map(n => esc(n)).join(' + '));
    summaryEl.innerHTML = parts.length ? parts.join(' &nbsp;·&nbsp; ')
      : '<span style="color:var(--ink-soft)">No one assigned yet — type a crew member’s name below.</span>';
  }

  const letterSel = sel => '<select>'
    + LETTERS.map(L => `<option value="${L}" ${L===sel?'selected':''}>${L}</option>`).join('') + '</select>';

  // assigned + pending crew rows, then a type-a-name add box (datalist of installers)
  function renderMembers(){
    const hs = Object.keys(assigned).sort((a,b)=>byName(empByH(a),empByH(b)));
    membersBox.innerHTML = '';
    if(!hs.length && !pending.length){
      membersBox.innerHTML = '<div class="empty" style="padding:4px 2px">No crew on this boat yet — type a name below.</div>';
    }
    hs.forEach(h => {
      const row = document.createElement('div');
      row.className = 'assignrow set';
      row.innerHTML = `<span class="who">${esc(fullName(empByH(h)))} <span style="color:var(--ink-soft)">(${esc(h)})</span></span>`
        + `<span class="right">` + letterSel(assigned[h])
        + `<button class="btn danger x" title="Remove from boat">✕</button></span>`;
      row.querySelector('select').onchange = e => { assigned[h] = e.target.value; updateSummary(); };
      row.querySelector('button').onclick   = () => { delete assigned[h]; renderMembers(); updateSummary(); };
      membersBox.appendChild(row);
    });
    pending.forEach(p => {
      const row = document.createElement('div');
      row.className = 'assignrow set';
      row.innerHTML = `<span class="who">${esc(p.name)} <span style="color:var(--ink-soft)">(new)</span></span>`
        + `<span class="right">` + letterSel(p.letter)
        + `<button class="btn danger x" title="Remove from boat">✕</button></span>`;
      row.querySelector('select').onchange = e => { p.letter = e.target.value; updateSummary(); };
      row.querySelector('button').onclick   = () => { pending.splice(pending.indexOf(p), 1); renderMembers(); updateSummary(); };
      membersBox.appendChild(row);
    });

    // type-to-add: free text, with a datalist of installers not already on this boat
    const avail  = state.employees.slice().sort(byName).filter(e => !(e.hNumber in assigned));
    const listId = 'crewopts-' + cardUid;
    addBox.innerHTML =
        `<input data-role="addname" list="${attr(listId)}" placeholder="Type a crew member’s name…" autocapitalize="words">`
      + `<datalist id="${attr(listId)}">` + avail.map(e => `<option value="${attr(fullName(e))}">`).join('') + `</datalist>`
      + `<button class="btn" data-role="addbtn">Add</button>`;
    const inp = addBox.querySelector('[data-role="addname"]');
    const go  = () => { addByName(inp.value); inp.value=''; inp.focus(); };
    addBox.querySelector('[data-role="addbtn"]').onclick = go;
    inp.onkeydown = e => { if(e.key === 'Enter'){ e.preventDefault(); go(); } };
  }
  renderMembers();
  card.querySelector('[data-f="boatNumber"]').addEventListener('input', updateSummary);
  updateSummary();

  card.querySelector('[data-act="save"]').onclick = async () => {
    const g = f => card.querySelector(`[data-f="${f}"]`).value.trim();
    if(!g('boatNumber')){ toast(land ? 'Crew number required' : 'Boat number required'); return; }
    try{
      await post({ action:'saveTeam', id:t.id||undefined, type:teamType(t),
        boatNumber:g('boatNumber'), boatName:land ? '' : g('boatName'),
        captainName:land ? '' : resolveName('captain'), subName:resolveName('sub'),
        memberLetters:Object.assign({}, assigned),
        newMembers:pending.map(p => ({ name:p.name, letter:p.letter })) });
      toast(land ? 'Crew saved ✓' : 'Boat saved ✓'); await load();
    } catch(err){ toast(err.message); }
  };

  card.querySelector('[data-act="del"]').onclick = async () => {
    if(!t.id){ card.remove(); return; }           // discard an unsaved card
    if(!confirm(`Delete ${boatLabel(t)}? This removes the ${land ? 'crew card' : 'boat'}, not the people.`)) return;
    try{ await post({ action:'deleteTeam', id:t.id }); toast(land ? 'Crew deleted ✓' : 'Boat deleted ✓'); await load(); }
    catch(err){ toast(err.message); }
  };

  setOpen(!t.id);   // new boats open for editing; saved boats start collapsed
  return card;
}

// top-bar navigation — Log / Map / Analytics live in the other two pages
$('navSel').onchange = e => {
  const v = e.target.value;
  if(v==='log')       window.location.href = 'index.html';
  else if(v==='map')  window.location.href = 'map.html';
  else if(v==='analytics') window.location.href = 'map.html#analytics';
  else if(v==='edit') window.location.href = 'edit.html';
  else if(v==='reports') window.location.href = 'reports.html';
};
// reset the dropdown if the page is restored from the back/forward cache
window.addEventListener('pageshow', () => { $('navSel').value = 'teams'; });

$('newTeam').onclick = () => {
  const blank = { id:'', boatNumber:'', boatName:'', captainName:'', subName:'',
                  memberLetters:{}, type:workMode() };
  const card = teamCard(blank);
  $('teamList').appendChild(card);
  card.scrollIntoView({ behavior:'smooth', block:'center' });
};

setMode(workMode());
load();
