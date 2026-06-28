// ── Edit & Daily Log back-office (edit.html) ────────────────────────────────
// Pick an installer + date, correct any logged workorder, set the day's
// Departure/Returned bookends + travel deductions, then generate the PDF
// (previewDailyLog) or close the day (endOfDay). Read-mostly — no offline queue.
import { $, esc, attr, toast } from '../dom.js';
import { apiGet, apiPost } from '../api.js';
import { clockOf, hhmmMin, ordinal, parseLocalMs } from '../time.js';
import { buildLocalSummary } from '../compute/summary.js';
import { downloadDailyLog } from '../dailylog.js';

let state = { employees:[], installer:'', installerId:'', date:'', stops:[], downtime:[], boatMeta:null };

const CAT_LABEL = {
  NEXT_GEN:'Next Gen', CELL_SIGNAL:'Cell Signal', BAD_WEATHER:'Bad Weather',
  WAREHOUSE:'Warehouse', TOOLS_MATERIAL:'Tools/Material', DISPATCH:'Dispatch',
  TRUCK_ISSUES:'Truck Issues', ASSIST:'Assist', URGENT_EER:'Urgent/EER',
  LUNCH:'Lunch', BREAK:'Break', MISC_TRAVEL:'Misc Travel', OTHER:'Other'
};
// Reasons offered for subtracting from a WO→WO gap. No "Travel Time" — whatever's
// left after subtractions IS the travel time.
const ALLOC_CATS = ['NEXT_GEN','CELL_SIGNAL','BAD_WEATHER','WAREHOUSE','TOOLS_MATERIAL',
  'DISPATCH','TRUCK_ISSUES','ASSIST','URGENT_EER','LUNCH','BREAK','MISC_TRAVEL','OTHER'];
let gapData = [];   // [{start,end,idleMin,toWO,toId, allocations:[{category,minutes}]}]

function setStatus(kind, text){
  const p=$('status'), t=$('statusText');
  p.classList.remove('wait','off');
  if(kind==='off') p.classList.add('off'); else if(kind==='wait') p.classList.add('wait');
  t.textContent=text;
}

const fullName = e => ((e.firstName||'')+' '+(e.lastName||'')).trim();
const empByH   = h => state.employees.find(e => e.hNumber===h) || null;

// Statuses that earn a row on the daily log (DONE markers are excluded).
function statusTagClass(st){
  return st==='UTI' ? 'tag-uti' : st==='VISITED' ? 'tag-visit' : st==='UNACCOUNTED' ? 'tag-unacc' : 'tag-ok';
}
function locLabel(s){
  const unit = (s.unit||'').trim(), addr = (s.address||'').trim();
  return unit ? (unit + ' ' + addr).trim() : addr;
}

// ── server I/O ─────────────────────────────────────────────────────────────
async function loadRoster(){
  setStatus('wait','Loading…');
  try{
    const d = await apiGet('roster');
    if(!d.ok) throw new Error(d.error||'load failed');
    state.employees = (d.employees||[]).filter(e => e.active !== false);
    const sel = $('who');
    state.employees.slice()
      .sort((a,b)=> (a.lastName+a.firstName).localeCompare(b.lastName+b.firstName))
      .forEach(e => { const o=document.createElement('option');
        o.value=e.hNumber; o.textContent=`${fullName(e)} (${e.hNumber})`; sel.appendChild(o); });
    setStatus('ok','Synced');
  } catch(e){ setStatus('off','Offline — can’t load'); toast('Couldn’t load crew — check the connection'); }
}
async function post(payload){
  const d = await apiPost(payload);   // injects token; text/plain dodges CORS preflight
  if(!d.ok) throw new Error(d.error||'save failed');
  return d;
}

// ── load a day ─────────────────────────────────────────────────────────────
$('loadBtn').onclick = async () => {
  const h = $('who').value, date = $('day').value;
  const emp = empByH(h);
  if(!emp){ toast('Pick an installer'); return; }
  if(!date){ toast('Pick a date'); return; }
  state.installer = fullName(emp); state.installerId = h; state.date = date;
  setStatus('wait','Loading…');
  try{
    const d = await apiGet('day', { installer:state.installer, installerId:state.installerId, date });
    if(!d.ok) throw new Error(d.error||'load failed');
    setStatus('ok','Synced');
    // DONE markers are coordinates-only and never print on the log — leave them out.
    state.stops = (d.stops||[]).filter(s => s.status !== 'DONE');
    state.downtime = d.downtime || [];        // for the offline daily-log fallback
    state.boatMeta = d.boatMeta || null;       // team header + whole-boat dispatch
    $('departure').value = (d.day && d.day.departure) || '';
    $('returned').value  = (d.day && d.day.returned)  || '';
    renderClosed(d.closed);
    // Travel review: every WO→WO gap (team-aware) plus any deductions already saved.
    // Fetch BEFORE rendering stops so each work-order card can show its incoming
    // travel. Non-blocking — the day still loads/generates if this call fails.
    let gaps = [];
    try{
      const idata = await apiGet('idle', { installerId:state.installerId, installer:state.installer, date });
      gaps = idata.gaps || [];
    } catch {}
    setGapData(gaps);
    renderStops();
    $('daySection').classList.remove('hide');
  } catch(e){ setStatus('off','Offline'); toast('Couldn’t load that day'); }
};

function renderClosed(closed){
  $('closedBadge').innerHTML = closed
    ? '<span class="badge">Day closed ✓</span>'
    : '<span class="badge open">Not closed yet</span>';
  const cb = $('closeDay'); if(cb) cb.textContent = closed ? 'Re-close day' : 'Close day';
}

function renderStops(){
  const box = $('stopList');
  $('stopsHead').textContent = `Workorders — ${state.installer} · ${state.date}`;
  if(!state.stops.length){ box.innerHTML = '<div class="empty">No workorders logged for that installer on that date.</div>'; return; }
  box.innerHTML = '';
  updateLaunch = null;   // cleared each render; the 1st WO re-arms it if it has a launch leg
  // Position = order by arrival time across all logged WOs shown (1st, 2nd, …).
  // Sort by parsed time, not the raw string: a lexicographic compare puts an
  // unpadded-hour stamp ("…8:52") after "…11:11" because '8' > '1'.
  const ordered = state.stops.slice().sort((a,b)=> (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
  const posById = {}; ordered.forEach((s,i)=> posById[s.id]=i+1);
  ordered.forEach(s => box.appendChild(stopCard(s, posById[s.id])));
}

// ── travel review: every WO→WO gap, subtract downtime/breaks ─────────────────
// Each gap is shown as an inline "Travel in" dropdown on the work-order card it
// arrives at. gapByToId maps a gap to its arriving stop (g.toId === stop.id).
let gapByToId = {};
function setGapData(gaps){
  gapData = (gaps||[]).map(g => ({
    start:g.start, end:g.end, idleMin:g.idleMin, toWO:g.toWO||'', toId:g.toId,
    allocations:(g.allocations||[]).map(a => ({ category:a.category, minutes:Number(a.minutes)||0 })),
    _views:[]   // every rendered editor for this gap, so edits stay in sync
  }));
  gapByToId = {};
  gapData.forEach(g => { if(g.toId!=null && g.toId!=='') gapByToId[g.toId]=g; });
}

// Net travel = gap minutes − subtracted minutes.
function gapNet(g){
  const used = (g.allocations||[]).reduce((s,a)=>s+(Number(a.minutes)||0),0);
  const net = g.idleMin - used;
  return { used, net, over: used > g.idleMin,
           text: used > g.idleMin ? `⚠ ${used} over ${g.idleMin}` : `Travel ${net} min` };
}
// Re-sync every place this gap is shown. syncNet on minutes typing (keeps focus);
// syncDraw rebuilds the rows on add/delete.
function syncNet(g){ (g._views||[]).forEach(v => v.onNet && v.onNet()); }
function syncDraw(g){ (g._views||[]).forEach(v => { v.drawRows && v.drawRows(); v.onNet && v.onNet(); }); }

// The shared subtract-downtime editor (rows + "add" button) bound to gap `g`.
// `onNet` lets the host update its own net display; registers itself in g._views.
function allocEditor(g, onNet){
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div data-f="allocs"></div>
    <button class="mini" data-act="add" style="margin-top:8px">+ Subtract downtime / break</button>`;
  const allocBox = wrap.querySelector('[data-f="allocs"]');
  const opts = sel => ALLOC_CATS.map(k => `<option value="${k}"${k===sel?' selected':''}>${CAT_LABEL[k]}</option>`).join('');
  const drawRows = () => {
    allocBox.innerHTML = '';
    g.allocations.forEach((a, ai) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:6px 0';
      row.innerHTML = `
        <input class="mono" inputmode="numeric" data-f="min" value="${a.minutes||''}" placeholder="min" style="width:72px">
        <select class="mono" data-f="cat" style="flex:1">${opts(a.category)}</select>
        <button class="mini" data-act="del" style="min-width:44px">✕</button>`;
      row.querySelector('[data-f="min"]').oninput = e => { a.minutes = parseInt(e.target.value,10)||0; syncNet(g); };
      row.querySelector('[data-f="cat"]').onchange = e => { a.category = e.target.value; };
      row.querySelector('[data-act="del"]').onclick = () => { g.allocations.splice(ai,1); syncDraw(g); };
      allocBox.appendChild(row);
    });
  };
  wrap.querySelector('[data-act="add"]').onclick = () => { g.allocations.push({ category:'BREAK', minutes:0 }); syncDraw(g); };
  g._views.push({ drawRows, onNet });
  drawRows();
  return wrap;
}

// Set while rendering the 1st WO so the Departure input can refresh its launch leg live.
let updateLaunch = null;

// Inline "Travel in" dropdown shown on a work-order card. `box` is the card's
// .sc-travel slot; binds to the gap that arrives at this stop (if any). The
// chronologically-first WO (pos 1) has no WO→WO gap — its travel is the launch
// leg from the Departure bookend, shown read-only and refreshed live.
function renderStopTravel(box, s, pos){
  const g = gapByToId[s.id];
  if(!g){
    if(pos === 1){
      const render = () => {
        const dep = $('departure').value, arr = clockOf(s.timestamp);
        const dm = hhmmMin(dep), am = hhmmMin(arr);
        box.innerHTML = (dm == null || am == null)
          ? '<div class="sc-meta">Travel in: — (set Departure time)</div>'
          : `<div class="sc-meta">Travel in: <b style="color:#1a7f37">${Math.max(0, am-dm)} min</b> · from Departure</div>`;
      };
      updateLaunch = render; render();
    } else {
      box.innerHTML = '<div class="sc-meta">Travel in: —</div>';
    }
    return;
  }
  box.innerHTML = '';
  const toggle = document.createElement('button'); toggle.className = 'mini'; toggle.type = 'button';
  const body = document.createElement('div'); body.className = 'hide'; body.style.marginTop = '6px';
  const arrow = () => body.classList.contains('hide') ? '▸' : '▾';
  const onNet = () => { const n = gapNet(g);
    toggle.innerHTML = `${arrow()} Travel in: <b style="color:${n.over?'#c0392b':'#1a7f37'}">${n.over ? esc(n.text) : (n.net+' min')}</b>`; };
  toggle.onclick = () => { body.classList.toggle('hide'); onNet(); };
  const meta = document.createElement('div'); meta.className = 'sc-meta'; meta.style.marginBottom = '4px';
  meta.textContent = `${g.start}–${g.end} · ${g.idleMin} min gap`;
  body.appendChild(meta);
  body.appendChild(allocEditor(g, onNet));
  box.appendChild(toggle); box.appendChild(body);
  onNet();
}

function collectGapAllocations(gaps){
  const out = [];
  (gaps||[]).forEach(g => (g.allocations||[]).forEach(a => {
    if((parseInt(a.minutes,10)||0) > 0)
      out.push({ fromTime:g.start, toTime:g.end, workOrderId:g.toWO||'', category:a.category, minutes:parseInt(a.minutes,10) });
  }));
  return out;
}

function summaryHTML(s, pos){
  const t = esc(clockOf(s.timestamp)) || '--:--';
  return (pos ? `<strong>${ordinal(pos)}</strong> · ` : '')
       + `<strong>WO ${esc(s.workOrderId)||'—'}</strong> `
       + `<span class="sc-meta">(${t}) · ${esc(locLabel(s))||'no address'} · `
       + `<b class="${statusTagClass(s.status)}">${esc(s.status)||'—'}</b>`
       + `${s.newJNumber?(' · '+esc(s.newJNumber)):''}`
       + `${(s.meterRead||s.meterRead===0)?(' · read '+esc(s.meterRead)):''}`
       + `${(s.meterReadReceived||s.meterReadReceived===0)?(' / '+esc(s.meterReadReceived)):''}</span>`;
}

function stopCard(s, pos){
  const card = document.createElement('div');
  card.className = 'stopcard';
  card.innerHTML = `
    <div class="sc-head">
      <div class="sc-sum">${summaryHTML(s, pos)}</div>
      <button class="mini" data-act="toggle">Edit</button>
    </div>
    <div class="sc-travel" style="margin-top:6px"></div>
    <div class="sc-edit hide">
      <label>Arrival time <span style="font-weight:500">(drives Travel min)</span></label><input type="time" data-f="arr" value="${attr(clockOf(s.timestamp))}">
      <label>Work order #</label><input class="mono" data-f="wo" value="${attr(s.workOrderId)}">
      <label>Unit</label><input class="mono" data-f="unit" value="${attr(s.unit)}">
      <label>Address</label><input data-f="addr" value="${attr(s.address)}">
      <label>Status</label>
      <select class="mono" data-f="status">
        <option ${s.status==='INSTALLED'?'selected':''}>INSTALLED</option>
        <option ${s.status==='UTI'?'selected':''}>UTI</option>
        <option ${s.status==='VISITED'?'selected':''}>VISITED</option>
        <option ${s.status==='UNACCOUNTED'?'selected':''}>UNACCOUNTED</option>
      </select>
      <label>New J#</label><input class="mono" data-f="newJ" value="${attr(s.newJNumber)}">
      <label>Old J#</label><input class="mono" data-f="oldJ" value="${attr(s.oldJNumber)}">
      <label>Meter read</label><input class="mono" inputmode="numeric" data-f="read" value="${attr(s.meterRead)}">
      <label>Received read (solar)</label><input class="mono" inputmode="numeric" data-f="readRecv" value="${attr(s.meterReadReceived)}">
      <label>UTI reason</label><input data-f="utiReason" value="${attr(s.utiReason)}">
      <label>Notes</label><textarea data-f="notes">${esc(s.notes)}</textarea>
      <button class="primary" data-act="save">Save changes</button>
    </div>`;

  renderStopTravel(card.querySelector('.sc-travel'), s, pos);

  const editBlock = card.querySelector('.sc-edit');
  const toggleBtn = card.querySelector('[data-act="toggle"]');
  toggleBtn.onclick = () => {
    editBlock.classList.toggle('hide');
    toggleBtn.textContent = editBlock.classList.contains('hide') ? 'Edit' : 'Close';
  };

  card.querySelector('[data-act="save"]').onclick = async () => {
    const g = f => card.querySelector(`[data-f="${f}"]`).value.trim();
    const payload = {
      action:'updateStop', id:s.id, date:state.date,
      arrivalTime: g('arr'),
      workOrderId:g('wo'), unit:g('unit'), address:g('addr'),
      status:g('status'), newJNumber:g('newJ'), oldJNumber:g('oldJ'),
      meterRead: g('read')===''? null : Number(g('read')),
      meterReadReceived: g('readRecv')===''? null : Number(g('readRecv')),
      utiReason:g('utiReason'), notes:g('notes')
    };
    try{
      await post(payload);
      // Reflect the edit locally: rebuild the stamp's clock so the summary updates.
      if(payload.arrivalTime) s.timestamp = state.date + ' ' + payload.arrivalTime + ':00';
      Object.assign(s, payload);
      card.querySelector('.sc-sum').innerHTML = summaryHTML(s, pos);
      editBlock.classList.add('hide'); toggleBtn.textContent = 'Edit';
      toast('Saved ✓');
    } catch(err){ toast(err.message || 'Could not save'); }
  };
  return card;
}

// ── bookend times + daily log ──────────────────────────────────────────────
async function saveTimes(){
  await post({ action:'saveDay', date:state.date, installer:state.installer,
               departure:$('departure').value, returned:$('returned').value });
}
$('saveTimes').onclick = async () => {
  try{ await saveTimes(); toast('Times saved ✓'); } catch(err){ toast(err.message); }
};
// Re-draw the 1st WO's launch leg as the Departure time is typed.
$('departure').addEventListener('input', () => { if(updateLaunch) updateLaunch(); });

// Build the daily-log summary from the loaded day for the offline render path —
// uses the on-screen bookends + travel deductions + the cached team/boat meta.
function localSummary(){
  return buildLocalSummary({
    installer:state.installer, installerId:state.installerId, date:state.date,
    stops:state.stops, downtime:state.downtime,
    day:{ departure:$('departure').value, returned:$('returned').value },
    boatMeta:state.boatMeta, includeDelays:$('includeDelays').checked,
    pendingTravel: collectGapAllocations(gapData)
  });
}

// Save the on-screen bookends + travel deductions (so the PDF / close reflect them)
// without writing the Tracker row. Shared by Generate and Close.
async function persistEdits(){
  await saveTimes();   // persist the bookends first so the log always has them
  await post({ action:'saveTravel', installer:state.installer, installerId:state.installerId,
               date:state.date, allocations: collectGapAllocations(gapData) });
}

// Generate = PDF only, rendered on the device. previewDailyLog returns the summary
// (no Tracker / Timing rows) which we draw; falls back to a local summary if the
// save/preview can't reach the Sheet. Use "Close day" to finalize.
$('genLog').onclick = async () => {
  if(!state.installer){ toast('Load a day first'); return; }
  setStatus('wait','Generating…');
  try{
    let summary = null;
    try{
      await persistEdits();
      const d = await post({ action:'previewDailyLog', installer:state.installer, installerId:state.installerId,
                             date:state.date, departure:$('departure').value, returned:$('returned').value,
                             includeDelays:$('includeDelays').checked });
      summary = d.summary || null;
      setStatus('ok','Synced');
    } catch { summary = localSummary(); setStatus('off','Offline — local draft'); }
    if(!summary) summary = localSummary();
    downloadDailyLog(summary);
    toast('Daily log ready ✓ · day not closed');
  } catch(err){ setStatus('off','Error'); toast(err.message || 'Could not generate'); }
};

// Close day = finalize only. endOfDay upserts the Tracker + Timing rows (idempotent
// on date+installer, so re-closing just updates). No PDF download here.
$('closeDay').onclick = async () => {
  if(!state.installer){ toast('Load a day first'); return; }
  setStatus('wait','Closing…');
  try{
    await persistEdits();
    await post({ action:'endOfDay', installer:state.installer, installerId:state.installerId,
                 date:state.date, departure:$('departure').value, returned:$('returned').value,
                 includeDelays:$('includeDelays').checked });
    setStatus('ok','Synced');
    renderClosed(true);
    toast('Day closed ✓');
  } catch(err){ setStatus('off','Error'); toast(err.message || 'Could not close'); }
};

// top-bar navigation
$('navSel').onchange = e => {
  const v = e.target.value;
  if(v==='log')            window.location.href = 'index.html';
  else if(v==='map')       window.location.href = 'map.html';
  else if(v==='analytics') window.location.href = 'map.html#analytics';
  else if(v==='teams')     window.location.href = 'teams.html';
};
window.addEventListener('pageshow', () => { $('navSel').value = 'edit'; });

// default the date to today (local) and load the crew picker
(function(){ const n=new Date(); const p=x=>('0'+x).slice(-2);
  $('day').value = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}`; })();
loadRoster();
