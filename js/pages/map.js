// ── Map & Analytics viewer (map.html) ───────────────────────────────────────
// Read-only window over the data: plots stops by GPS (Leaflet), filters, WO#/J#
// search, and Tracker/Timing/Dispatch trend charts (Chart.js). Leaflet (`L`) and
// Chart (`Chart`) come from the vendored classic <script>s loaded before this
// module (js/vendor/leaflet.js, js/vendor/chart.umd.min.js).
import { $, esc, toast } from '../dom.js';
import { apiGet } from '../api.js';

const COLORS = { INSTALLED:'#1E8E5A', UTI:'#D64500', VISITED:'#2563EB', UNACCOUNTED:'#64748B', DONE:'#8A94A6' };
const CATCOLS = [['nextGen','Next Gen'],['cellSignal','Cell Signal'],['badWeather','Bad Weather'],
  ['warehouse','Warehouse'],['toolsMaterial','Tools/Material'],['dispatch','Dispatch'],
  ['truckIssues','Truck Issues'],['assist','Assist'],['urgentEer','Urgent/EER'],['other','Other']];

let ALL = [], TRK = [], TIM = [], DISP = [], BOATDAYS = [], INSTALLER_NAMES = [];
let state = { installers:[], from:'', to:'', statuses:{ INSTALLED:true, UTI:true, VISITED:true, UNACCOUNTED:true, DONE:true } };
let map, markersLayer, highlightLayer, chDay, chDown, chReason;

// ── helpers shared with the form's logic ──────────────────────────────────
function locLabel(s){
  const unit=(s.unit==null?'':String(s.unit)).trim();
  const addr=(s.address==null?'':String(s.address)).trim();
  if(!addr) return '';
  return unit ? (unit+' '+addr) : addr;
}
function dateKey(ts){   // → Toronto calendar date, matching the spine
  const s = String(ts);
  if(/T.*(Z|[+\-]\d\d:?\d\d)$/.test(s)){
    const d = new Date(s);
    if(!isNaN(d)) return fmtTO(d);
  }
  return s.slice(0,10);
}
function fmtTO(d){
  const p={}; new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(d).forEach(x=>p[x.type]=x.value);
  return `${p.year}-${p.month}-${p.day}`;
}
function torontoToday(){ return fmtTO(new Date()); }
function daysAgo(n){ const d=new Date(); d.setDate(d.getDate()-n); return fmtTO(d); }
const norm = v => String(v==null?'':v).trim().toUpperCase();
const hasCoords = s => s.lat!=null && s.lng!=null && !isNaN(s.lat) && !isNaN(s.lng);
const trkNum = v => Number(v)||0;
const inRange = k => (!state.from || k>=state.from) && (!state.to || k<=state.to);
const instMatch = name => !state.installers.length || state.installers.includes(String(name||'').trim());

// ── load ────────────────────────────────────────────────────────────────────
async function load(){
  $('pillstat').textContent = 'Loading…';
  try{
    const [pd, td, md, dd, bd] = await Promise.all([
      apiGet('pins'), apiGet('tracker'), apiGet('timing'), apiGet('dispatch'), apiGet('boatdays')
    ]);
    ALL = (pd.pins||[]).map(s => ({ ...s,
      lat:(s.lat===''||s.lat==null)?null:Number(s.lat),
      lng:(s.lng===''||s.lng==null)?null:Number(s.lng) }));
    TRK = td.tracker || [];
    TIM = md.timing || [];
    DISP = dd.dispatch || [];
    BOATDAYS = bd.boatDays || [];
    _boatMemIdx = null;   // BOATDAYS replaced — rebuild the membership index lazily
    buildInstallerList();
    drawMarkers(true);
    renderAnalytics();
    updatePill();
  } catch { $('pillstat').textContent=''; toast('Couldn’t reach the sheet — check WEB_APP_URL and that the deployment is current.'); }
}
function updatePill(){
  const located = ALL.filter(hasCoords).length;
  $('pillstat').textContent = `${ALL.length} stops · ${located} mapped`;
}

// ── filtering ──────────────────────────────────────────────────────────────
function forMap(){
  return ALL.filter(s => hasCoords(s) && instMatch(s.installer)
    && state.statuses[s.status] && inRange(dateKey(s.timestamp)));
}
function pinsInScope(){ return ALL.filter(s => instMatch(s.installer) && inRange(dateKey(s.timestamp))); }
function trkInScope(){ return TRK.filter(r => instMatch(r.installer) && inRange(dateKey(r.date))); }
// WO→WO gaps (Travel / Flagged) in scope — Launch/Return dock legs excluded. This is
// the any-log-to-any-log lens for "avg time between meters"; filter by fromStatus/
// toStatus on top for the install-to-install lens.
function gapsInScope(){
  return TIM.filter(r => instMatch(r.installer) && inRange(dateKey(r.date))
    && (r.type==='Travel' || r.type==='Flagged'));
}
// Each installer's OWN consecutive-stop gaps (the partner's logs are NOT merged in),
// pooled across the range: sum of gap-minutes ÷ number of gaps. Chains are built per
// (installer, day) so they never cross installers or midnight, even under "all". This
// is the "between MY meters" lens — e.g. installs at 9:00 & 9:30 with a partner visit
// at 9:15 between them is still a 30-min install→install gap. Returns null if no gaps.
function avgOwnGap(statusSet){
  const byKey = {};                       // `${installer}|${day}` -> [ms,…]
  pinsInScope().forEach(s => {
    if(!statusSet.has(s.status)) return;
    const t = +new Date(s.timestamp); if(isNaN(t)) return;
    (byKey[s.installer+'|'+dateKey(s.timestamp)] ||= []).push(t);
  });
  let sum=0, n=0;
  Object.values(byKey).forEach(ts => { ts.sort((a,b)=>a-b);
    for(let i=1;i<ts.length;i++){ const m=(ts[i]-ts[i-1])/60000; if(m>0){ sum+=m; n++; } } });
  return n ? Math.round(sum/n) : null;
}
// `date|installerName` → boatNumber, from the BoatDays daily snapshot — so each day's
// stops can be grouped by the boat that installer actually crewed THAT day.
// Memoized — it's called twice per renderAnalytics and JSON.parses every
// BoatDays row, so rebuild only when a load() replaces BOATDAYS.
let _boatMemIdx = null;
function boatMembership(){
  if(_boatMemIdx) return _boatMemIdx;
  const idx = {};
  BOATDAYS.forEach(r => {
    const day = dateKey(r.date), boat = String(r.boatNumber||'').trim();
    if(!day || !boat) return;
    let names = []; try { names = JSON.parse(r.memberNames||'[]'); } catch { names = []; }
    names.forEach(n => { const nm=String(n||'').trim(); if(nm) idx[day+'|'+nm]=boat; });
  });
  return (_boatMemIdx = idx);
}
// Boat-wide twin of avgOwnGap: the gap between consecutive logs by ANYONE sharing the
// boat that day (any letter), pooled across the range. Stops are grouped by `boat|day`
// using that day's BoatDays snapshot — so a boatmate's log between two of yours shortens
// the gap. An installer with no boat that day falls back to a solo `installer|day` chain.
function avgBoatGap(statusSet){
  const mem = boatMembership();
  const byKey = {};                       // `${boat|installer}|${day}` -> [ms,…]
  pinsInScope().forEach(s => {
    if(!statusSet.has(s.status)) return;
    const t = +new Date(s.timestamp); if(isNaN(t)) return;
    const day = dateKey(s.timestamp);
    const name = String(s.installer||'').trim();
    const grp = mem[day+'|'+name] || ('@'+name);   // boatNumber, else solo by name
    (byKey[grp+'|'+day] ||= []).push(t);
  });
  let sum=0, n=0;
  Object.values(byKey).forEach(ts => { ts.sort((a,b)=>a-b);
    for(let i=1;i<ts.length;i++){ const m=(ts[i]-ts[i-1])/60000; if(m>0){ sum+=m; n++; } } });
  return n ? Math.round(sum/n) : null;
}

// ── map ─────────────────────────────────────────────────────────────────────
function initMap(){
  // preferCanvas: one <canvas> instead of an SVG node per circleMarker — keeps
  // pan/zoom smooth with thousands of stops plotted.
  map = L.map('map', { zoomControl:true, preferCanvas:true }).setView([44.5,-79.5], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}
function popupHTML(s){
  const color = COLORS[s.status] || COLORS.DONE, loc = locLabel(s);
  let read = '';
  if(s.status==='UTI') read = s.utiReason ? `<div class="pop-row"><span class="lab">Reason:</span> ${esc(s.utiReason)}</div>` : '';
  else if(s.status==='VISITED' || s.status==='UNACCOUNTED') read = s.notes ? `<div class="pop-row"><span class="lab">Note:</span> ${esc(s.notes)}</div>` : '';
  else if(s.meterRead || s.meterRead===0) read = `<div class="pop-row"><span class="lab">Read:</span> ${esc(s.meterRead)}</div>`;
  else if(s.status==='INSTALLED') read = `<div class="pop-row"><span class="lab">Read:</span> no read</div>`;
  const j = s.newJNumber ? `<div class="pop-row"><span class="lab">J#:</span> <span class="mono">${esc(s.newJNumber)}</span></div>` : '';
  return `<div class="pop-wo">WO ${esc(s.workOrderId)||'—'}<span class="pop-badge" style="background:${color}">${esc(s.status)}</span></div>`
       + (loc ? `<div class="pop-row">${esc(loc)}</div>` : '') + j + read
       + `<div class="pop-row"><span class="lab">By:</span> ${esc(s.installer)||'—'} · ${esc(dateKey(s.timestamp))}</div>`;
}
function drawMarkers(fit){
  if(!map) initMap();
  markersLayer.clearLayers();
  if(highlightLayer){ map.removeLayer(highlightLayer); highlightLayer=null; }
  const pts = [];
  forMap().forEach(s => {
    L.circleMarker([s.lat, s.lng], { radius:8, color:'#fff', weight:2, fillColor:(COLORS[s.status]||COLORS.DONE), fillOpacity:.95 })
      .bindPopup(popupHTML(s)).addTo(markersLayer);
    pts.push([s.lat, s.lng]);
  });
  if(fit && pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25));
}

// ── search ───────────────────────────────────────────────────────────────────
function doSearch(){
  const q = norm($('search').value);
  if(!q){ toast('Type a WO# or J#'); return; }
  const matches = ALL.filter(s => norm(s.workOrderId)===q || norm(s.newJNumber)===q || norm(s.oldJNumber)===q);
  if(!matches.length){ toast('No match for that WO# or J#'); return; }

  // clear every filter so a match is never hidden, then locate it
  state.statuses = { INSTALLED:true, UTI:true, VISITED:true, UNACCOUNTED:true, DONE:true };
  state.installers = []; state.from=''; state.to='';
  syncControls(); drawMarkers(false); renderAnalytics();

  const located = matches.filter(hasCoords);
  if(!located.length){ toast('Found it, but no GPS location was saved for that stop'); return; }
  const pts = located.map(s => [s.lat, s.lng]);
  if(highlightLayer) map.removeLayer(highlightLayer);
  highlightLayer = L.layerGroup(located.map(s => L.circleMarker([s.lat,s.lng], { radius:16, color:'#F59E0B', weight:3, fill:false }))).addTo(map);
  if(pts.length===1) map.setView(pts[0], 16); else map.fitBounds(L.latLngBounds(pts).pad(0.3));
  const f = located[0];
  L.popup().setLatLng([f.lat, f.lng]).setContent(popupHTML(f)).openOn(map);
  toast(located.length===1 ? 'Found it' : `${located.length} matches highlighted`);
}

// ── analytics (Tracker for trends/downtime, stops for UTI reasons) ─────────────
function renderAnalytics(){
  const trk = trkInScope(), pins = pinsInScope();

  $('trkNote').innerHTML = trk.length ? '' :
    '<div class="note">Trends come from your end-of-day totals — none in this range yet. Finish a day in the form to fill them in.</div>';

  const installed   = trk.reduce((a,r)=>a+trkNum(r.installed),0);
  const uti         = trk.reduce((a,r)=>a+trkNum(r.uti),0);
  const down        = trk.reduce((a,r)=>a+trkNum(r.downtimeTotalMin),0);
  const visited     = trk.reduce((a,r)=>a+trkNum(r.visited),0);
  const unaccounted = trk.reduce((a,r)=>a+trkNum(r.unaccounted),0);
  const autoIdle    = trk.reduce((a,r)=>a+trkNum(r.autoIdleMin),0);
  const rate        = (installed+uti) ? Math.round(installed/(installed+uti)*100) : 0;

  // Log→Log (factoring partner): mean of every merged-team WO→WO gap from the Timing
  // tab — your logs + your partner's that day, interleaved — so a partner's stop
  // between two of yours shortens the gap. Each day uses that day's real partner.
  const gaps = gapsInScope();
  const gapSum = gaps.reduce((a,r)=>a+trkNum(r.minutes),0);
  const avgLog = gaps.length ? Math.round(gapSum/gaps.length) : null;
  // Cadence of MY own work only — partner logs not merged in (see avgOwnGap).
  const avgInst      = avgOwnGap(new Set(['INSTALLED']));            // install → install
  const avgCompleted = avgOwnGap(new Set(['INSTALLED','UTI']));      // completed WO → completed WO
  // Boat-wide log→log: gap between consecutive logs by anyone sharing the boat that day.
  const avgBoat = avgBoatGap(new Set(['INSTALLED','UTI','VISITED','UNACCOUNTED','DONE']));

  // Measured dispatch downtimes (Dispatch tab, matched='Y'), dated by completion.
  const disp = DISP.filter(r => String(r.matched).trim().toUpperCase()==='Y'
    && instMatch(r.installer) && inRange(dateKey(r.completedTime)));
  const avgDispatch = disp.length
    ? Math.round(disp.reduce((a,r)=>a+(trkNum(r.minutes)||0),0)/disp.length) : null;

  // Dispatch downtime from each installer's own end-of-day total (Tracker `dispatch`
  // column = their edited DISPATCH deductions). Total = every installer's summed.
  const totalDispatch = trk.reduce((a,r)=>a+trkNum(r.dispatch),0);
  // Avg boat dispatch downtime: pool each boat-day's members (BoatDays membership,
  // solo fallback like avgBoatGap), sum their dispatch, then average across boat-days.
  const memD = boatMembership();
  const boatDisp = {};
  trk.forEach(r => {
    const day = dateKey(r.date), name = String(r.installer||'').trim();
    const grp = memD[day+'|'+name] || ('@'+name);
    boatDisp[grp+'|'+day] = (boatDisp[grp+'|'+day]||0) + trkNum(r.dispatch);
  });
  const boatDispVals = Object.values(boatDisp);
  const avgBoatDispatch = boatDispVals.length
    ? Math.round(boatDispVals.reduce((a,v)=>a+v,0)/boatDispVals.length) : null;

  const mins = v => v==null ? '—' : (v+' min');
  $('tiles').innerHTML =
      tile(installed,'Installed','t-install') + tile(uti,'UTI','t-uti')
    + tile(rate+'%','Install rate','') + tile(down,'Downtime min','')
    + tile(mins(avgInst),     'Avg install→install','')
    + tile(mins(avgCompleted),'Avg between completed WOs','')
    + tile(mins(avgLog),      'Avg log→log (w/ partner)','')
    + tile(mins(avgBoat),     'Avg log→log (boat)','')
    + tile(mins(avgDispatch), 'Avg dispatch downtime','')
    + tile(mins(avgBoatDispatch), 'Avg boat dispatch downtime','')
    + tile(totalDispatch+' min', 'Total dispatch downtime','')
    + tile(visited,'Visited','') + tile(unaccounted,'Unaccounted','')
    + tile(autoIdle,'Auto-idle min','');

  // installs vs UTI by day
  const byDay = {};
  trk.forEach(r => { const k=dateKey(r.date); (byDay[k]=byDay[k]||{i:0,u:0}); byDay[k].i+=trkNum(r.installed); byDay[k].u+=trkNum(r.uti); });
  const dayKeys = Object.keys(byDay).sort();
  blank('blankDay', dayKeys.length ? '' : 'No finalized days in this range.');
  chDay = remake(chDay, $('chDay'), dayKeys.length && {
    type:'bar',
    data:{ labels:dayKeys, datasets:[
      { label:'Installed', data:dayKeys.map(k=>byDay[k].i), backgroundColor:COLORS.INSTALLED },
      { label:'UTI',       data:dayKeys.map(k=>byDay[k].u), backgroundColor:COLORS.UTI } ]},
    options:{ responsive:true, maintainAspectRatio:false,
      scales:{ x:{stacked:true, grid:{display:false}}, y:{stacked:true, beginAtZero:true, ticks:{precision:0}} },
      plugins:{ legend:{ position:'bottom' } } }
  });

  // downtime by category
  const catSum = {}; CATCOLS.forEach(([k])=>catSum[k]=0);
  trk.forEach(r => CATCOLS.forEach(([k])=> catSum[k]+=trkNum(r[k])));
  const catPairs = CATCOLS.map(([k,lab])=>[lab,catSum[k]]).filter(p=>p[1]>0).sort((a,b)=>b[1]-a[1]);
  blank('blankDown', catPairs.length ? '' : 'No downtime logged in this range.');
  chDown = remake(chDown, $('chDown'), catPairs.length && {
    type:'bar',
    data:{ labels:catPairs.map(p=>p[0]), datasets:[{ data:catPairs.map(p=>p[1]), backgroundColor:'#3C7DD9' }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      scales:{ x:{ beginAtZero:true, ticks:{precision:0}, grid:{display:false} } }, plugins:{ legend:{ display:false } } }
  });

  // UTI reasons (from the stops — Tracker doesn't carry reasons)
  const reasons = {};
  pins.filter(s=>s.status==='UTI').forEach(s => { const r=s.utiReason||'—'; reasons[r]=(reasons[r]||0)+1; });
  const rPairs = Object.entries(reasons).sort((a,b)=>b[1]-a[1]);
  blank('blankReason', rPairs.length ? '' : 'No UTIs in this range.');
  chReason = remake(chReason, $('chReason'), rPairs.length && {
    type:'bar',
    data:{ labels:rPairs.map(p=>p[0]), datasets:[{ data:rPairs.map(p=>p[1]), backgroundColor:COLORS.UTI }] },
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      scales:{ x:{ beginAtZero:true, ticks:{precision:0}, grid:{display:false} } }, plugins:{ legend:{ display:false } } }
  });

  // by installer
  const byI = {};
  trk.forEach(r => { const n=(r.installer||'—');
    (byI[n]=byI[n]||{i:0,u:0,d:0,v:0,n:0,idle:0});
    byI[n].i+=trkNum(r.installed); byI[n].u+=trkNum(r.uti); byI[n].d+=trkNum(r.downtimeTotalMin);
    byI[n].v+=trkNum(r.visited); byI[n].n+=trkNum(r.unaccounted); byI[n].idle+=trkNum(r.autoIdleMin); });
  // Per-installer avg gap, from the same WO→WO gaps as the tile.
  const gapByI = {};
  gaps.forEach(r => { const n=(r.installer||'—'); (gapByI[n]=gapByI[n]||{sum:0,cnt:0});
    gapByI[n].sum+=trkNum(r.minutes); gapByI[n].cnt++; });
  const avgGapFor = n => (gapByI[n] && gapByI[n].cnt) ? Math.round(gapByI[n].sum/gapByI[n].cnt)+'m' : '—';
  const names = Object.keys(byI).sort();
  if(!names.length){ $('byInst').innerHTML = '<div class="empty">No end-of-day totals in this range.</div>'; }
  else{
    let h = '<table class="byinst"><thead><tr><th>Installer</th><th class="num">Installed</th><th class="num">UTI</th>'
          + '<th class="num">Visited</th><th class="num">Unacc.</th><th class="num">Downtime</th><th class="num">Avg gap</th><th class="num">Auto-idle</th></tr></thead><tbody>';
    names.forEach(n => h += `<tr><td>${esc(n)}</td><td class="num">${byI[n].i}</td><td class="num">${byI[n].u}</td>`
      + `<td class="num">${byI[n].v}</td><td class="num">${byI[n].n}</td><td class="num">${byI[n].d}</td><td class="num">${avgGapFor(n)}</td><td class="num">${byI[n].idle}</td></tr>`);
    $('byInst').innerHTML = h + '</tbody></table>';
  }
}
function tile(n,k,cls){ return `<div class="tile ${cls}"><div class="n">${n}</div><div class="k">${k}</div></div>`; }
function blank(id,msg){ const el=$(id); el.textContent=msg; el.style.display = msg ? 'flex' : 'none'; }
// Update an existing chart in place (each canvas keeps one type, so swapping
// `data` + update() is safe) instead of destroy+recreate — no flicker and no
// re-layout on every filter change. Destroy only when the chart empties out.
function remake(inst, canvas, conf){
  if(!conf){ if(inst) inst.destroy(); return null; }
  if(inst){ inst.data = conf.data; inst.update(); return inst; }
  return new Chart(canvas, conf);
}

// ── controls ────────────────────────────────────────────────────────────────
function buildInstallerList(){
  const set = new Set();
  ALL.forEach(s=>{ const n=String(s.installer||'').trim(); if(n) set.add(n); });
  TRK.forEach(r=>{ const n=String(r.installer||'').trim(); if(n) set.add(n); });
  INSTALLER_NAMES = [...set].sort();
  renderInstChips();
}
// Selected installers render as removable chips; the datalist offers the rest by name.
function renderInstChips(){
  $('instChips').innerHTML = state.installers.map(n =>
    `<span class="instchip">${esc(n)}<button type="button" data-name="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></span>`).join('');
  $('instChips').querySelectorAll('button').forEach(b =>
    b.onclick = () => removeInstaller(b.dataset.name));
  $('instList').innerHTML = INSTALLER_NAMES
    .filter(n => !state.installers.includes(n))
    .map(n => `<option value="${esc(n)}"></option>`).join('');
  $('instInput').placeholder = state.installers.length ? 'Add another…' : 'All installers — type a name…';
}
// Installer chips redraw without re-fitting the viewport — a filter tweak
// shouldn't yank the map away from where the user is looking.
function addInstaller(typed){
  const t = String(typed||'').trim(); if(!t) return;
  const match = INSTALLER_NAMES.find(n => n.toLowerCase() === t.toLowerCase());
  if(!match || state.installers.includes(match)) return;
  state.installers.push(match);
  syncControls(); drawMarkers(false); renderAnalytics();
}
function removeInstaller(name){
  state.installers = state.installers.filter(n => n !== name);
  syncControls(); drawMarkers(false); renderAnalytics();
}
function syncControls(){
  renderInstChips();
  $('fromDate').value = state.from; $('toDate').value = state.to;
  document.querySelectorAll('#statusChips .chip').forEach(ch => {
    const on = state.statuses[ch.dataset.st];
    ch.classList.toggle('on', on); ch.classList.toggle('off', !on);
  });
  document.querySelectorAll('.preset').forEach(p => p.classList.toggle('on', presetMatches(p)));
}
function presetMatches(p){
  if(p.dataset.days==='all') return !state.from && !state.to;
  return state.to===torontoToday() && state.from===daysAgo(Number(p.dataset.days));
}

// Datalist pick fires 'change'; Enter commits a typed name. Either way add + clear.
$('instInput').addEventListener('change', e => { addInstaller(e.target.value); e.target.value=''; });
$('instInput').addEventListener('keydown', e => {
  if(e.key==='Enter'){ e.preventDefault(); addInstaller(e.target.value); e.target.value=''; }
  else if(e.key==='Backspace' && !e.target.value && state.installers.length){ removeInstaller(state.installers[state.installers.length-1]); }
});
$('instWrap').onclick = e => { if(e.target===$('instWrap')||e.target===$('instChips')) $('instInput').focus(); };
document.querySelectorAll('#statusChips .chip').forEach(ch => {
  ch.onclick = () => { state.statuses[ch.dataset.st] = !state.statuses[ch.dataset.st]; syncControls(); drawMarkers(false); };
});
document.querySelectorAll('.preset').forEach(b => b.onclick = () => {
  if(b.dataset.days==='all'){ state.from=''; state.to=''; }
  else { state.to=torontoToday(); state.from=daysAgo(Number(b.dataset.days)); }
  syncControls(); drawMarkers(true); renderAnalytics();
});
$('fromDate').onchange = e => { state.from=e.target.value; syncControls(); drawMarkers(true); renderAnalytics(); };
$('toDate').onchange   = e => { state.to=e.target.value;   syncControls(); drawMarkers(true); renderAnalytics(); };
$('searchBtn').onclick = doSearch;
$('search').addEventListener('keydown', e => { if(e.key==='Enter') doSearch(); });

$('viewSel').onchange = e => {
  if(e.target.value==='teams'){ window.location.href = 'teams.html'; return; }
  if(e.target.value==='edit'){ window.location.href = 'edit.html'; return; }
  const mapOn = e.target.value==='map';
  $('mapView').classList.toggle('on', mapOn);
  $('analytics').classList.toggle('on', !mapOn);
  if(mapOn && map) setTimeout(()=>map.invalidateSize(), 60);
  else renderAnalytics();
};
// If the browser restores this page from its back/forward cache, the dropdown
// can be stuck on "Crew & Teams" — snap it back to whichever view is showing.
window.addEventListener('pageshow', () => {
  $('viewSel').value = $('analytics').classList.contains('on') ? 'analytics' : 'map';
});

// go
initMap();
load();

// deep-link: map.html#analytics opens the analytics view (used by the teams nav)
if(location.hash === '#analytics'){
  $('viewSel').value = 'analytics';
  $('viewSel').dispatchEvent(new Event('change'));
}
