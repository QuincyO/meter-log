// ── Capture page (index.html) ───────────────────────────────────────────────
// Wires the offline-first capture form: status toggle, location/address,
// logging a stop, downtime, lookup, the end-of-day travel review, Today's
// orders, and the local worklist. Durable state lives in IndexedDB (queue /
// dayCache / worklist); see the imported modules.
import { cfg, store } from '../store.js';
import { $, enc, esc, attr, toast } from '../dom.js';
import { stamp, localDate, clockOf, hhmmMin, ordinal } from '../time.js';
import { idb } from '../idb.js';
import { apiGet, apiPost } from '../api.js';
import { enqueue, flush, paint, migrateLegacyQueue, setQueueHooks } from '../queue.js';
import { pruneDayCache, cacheRecentDays, loadRecentDays } from '../daycache.js';
import { resolveAddress, cacheAddress, backfillAddresses } from '../geocode.js';
import { computeGapsLocal } from '../compute/gaps.js';
import { PRINTABLE, countDay, tallyText } from '../compute/tally.js';

// ── duplicate / J# conflict notice ──────────────────────────────────────────
// The queue calls this hook once the server acks a write, so a duplicate /
// conflict surfaces even for a stop that synced long after it was logged.
setQueueHooks({ onResult: (body, item) => {
  if (!body.duplicate && !body.flagged) return;
  const wo = item.workOrderId || '?';
  const newJ = item.newJNumber || '';
  if (body.duplicate) {
    showNotice('dup',
      `Duplicate — WO# ${wo} with J# ${newJ} was already logged. Entry discarded.`,
      body.history || []);
  } else if (body.flagged) {
    showNotice('flag',
      `J# conflict — WO# ${wo} was previously logged with a different J#. New entry saved.`,
      body.history || []);
  }
}});

let noticeTimer;
function showNotice(type, msg, history) {
  const el = $('notice');
  el.className = 'notice show ' + type;
  $('noticeMsg').textContent = msg;
  $('noticeRows').innerHTML = history.map(r =>
    `<div class="notice-row">WO# ${esc(r.workOrderId)||'?'} · J# ${esc(r.newJNumber)||'—'} · ${esc(r.status)} · ${esc(r.installer)} · ${esc(r.timestamp)}</div>`
  ).join('');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 15000);
}
$('noticeDismiss').onclick = () => { clearTimeout(noticeTimer); $('notice').classList.remove('show'); };

// ── status toggle ────────────────────────────────────────────────────────
let status = 'INSTALLED';
$('btnInstall').onclick = () => setStatus('INSTALLED');
$('btnUti').onclick     = () => setStatus('UTI');
$('btnOther').onclick   = () => setStatus('OTHER');
function setStatus(s){
  status = s;
  $('btnInstall').className = s==='INSTALLED' ? 'on-install' : '';
  $('btnUti').className     = s==='UTI'       ? 'on-uti'     : '';
  // OTHER keeps its full-width modifier whether or not it's selected.
  $('btnOther').className   = 'seg-wide' + (s==='OTHER' ? ' on-other' : '');
  $('installFields').classList.toggle('hide', s!=='INSTALLED');
  $('utiFields').classList.toggle('hide', s!=='UTI');
  $('otherFields').classList.toggle('hide', s!=='OTHER');
  $('requestedMeter').classList.toggle('hide', !(s==='INSTALLED'||s==='UTI'));
  setNoRead(false); setSolar(false); setRequested(false);
}
$('utiReason').onchange = e => {
  const other = e.target.value === 'Other';
  $('utiOther').classList.toggle('hide', !other);
  $('utiOtherLabel').classList.toggle('hide', !other);
};

// ── meter unreadable → save the old J# instead of a read ───────────────────
// Primary case: the display has missing segments, so the consumption can't be
// read, but the J# nameplate is fine. We skip the read, capture the old J#
// (scan or type), and tag why. It still counts as an install.
let noRead = false;
$('noReadToggle').onclick = () => setNoRead(!noRead);
function setNoRead(on){
  noRead = on;
  $('noReadToggle').classList.toggle('toggle-on', on);
  $('noReadToggle').textContent = on
    ? 'Meter unreadable ✓ — read skipped, old J# saved'
    : 'Meter unreadable? Save old J# instead';
  $('readWrap').classList.toggle('hide', on);
  $('noReadFields').classList.toggle('hide', !on);
  if(on) $('read').value='';
}
$('nrReason').onchange = e => {
  const other = e.target.value === 'Other';
  $('nrOther').classList.toggle('hide', !other);
  $('nrOtherLabel').classList.toggle('hide', !other);
};

// ── requested-meter toggle (flags the WO; dispatch wait is pre-filled at EOD) ──
let requested = false;
$('requestedMeter').onclick = () => setRequested(!requested);
function setRequested(on){
  requested = on;
  $('requestedMeter').classList.toggle('toggle-on', on);
  $('requestedMeter').textContent = on ? 'Requested ✓' : 'Requested?';
}

// ── solar meter → two reads (delivered + received) ─────────────────────────
let solar = false;
$('solarToggle').onclick = () => setSolar(!solar);
function setSolar(on){
  solar = on;
  $('solarToggle').classList.toggle('toggle-on', on);
  $('solarToggle').textContent = on ? 'Solar ✓ — delivered + received' : 'Solar meter — add a second read';
  $('readLabel').textContent = on ? 'Delivered read' : 'Meter read';
  $('receivedWrap').classList.toggle('hide', !on);
  if(!on) $('readRecv').value='';
}

// ── location + auto address ───────────────────────────────────────────────
let coords = { lat:null, lng:null };

// force = true when the Refresh button is tapped: re-read GPS and overwrite the
// address even if one is already there. Auto calls (on load / after a stop)
// pass nothing, so they only fill the address when it's still empty.
function getLocation(force){
  if(!navigator.geolocation){ $('locText').textContent = 'Location: no GPS on this device'; return; }
  const btn = $('refreshLoc'); if(btn) btn.disabled = true;
  $('locText').textContent = 'Location: getting…';
  navigator.geolocation.getCurrentPosition(
    async p => {
      coords = { lat:+p.coords.latitude.toFixed(6), lng:+p.coords.longitude.toFixed(6) };
      $('locText').textContent = `Location: ${coords.lat}, ${coords.lng}`;
      if(force) await fetchAddress(coords.lat, coords.lng, true);
      if(btn) btn.disabled = false;
    },
    () => { $('locText').textContent = 'Location: unavailable (saved without coords)'; if(btn) btn.disabled = false; },
    { enableHighAccuracy:true, timeout:8000 });
}
// Reverse geocode via resolveAddress (geocode.js): a cached coord resolves
// instantly and OFFLINE; a new coord with signal hits the spine and is cached for
// next time; offline + uncached → leave it for manual entry. In auto mode it
// fills the address only when it's still empty (never clobbers what you typed);
// with force it always replaces it. The field stays editable either way.
async function fetchAddress(lat, lng, force){
  if(!force && $('addr').value.trim()) return;
  const addr = await resolveAddress(lat, lng, { force });
  if(addr && (force || !$('addr').value.trim())){
    $('addr').value = addr;
    $('locText').textContent = `Location: ${lat}, ${lng} · address filled — edit to override`;
  } else if(force){
    $('locText').textContent = navigator.onLine
      ? `Location: ${lat}, ${lng} · no address found — enter manually`
      : `Location: ${lat}, ${lng} · offline — enter address manually`;
  }
}

$('refreshLoc').onclick = () => getLocation(true);
getLocation();

// ── log a stop ────────────────────────────────────────────────────────────
$('logStop').onclick = () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  // WO# is required for the two outcomes that finish a work order; the "we were
  // here" outcomes (Visited / Unaccounted) can be logged without one.
  if((status==='INSTALLED' || status==='UTI') && !$('wo').value.trim()){ toast('Work order # is required'); return; }
  if(status==='INSTALLED' && noRead && !$('nrOldJ').value.trim()){ toast('Scan or type the old J#'); return; }

  const num = v => v.trim()==='' ? null : Number(v.trim());
  // OTHER is one button: an Old J# means we saw a meter (VISITED); blank means we
  // couldn't find/confirm one (UNACCOUNTED). Other statuses pass through as-is.
  const otherJ = $('otherOldJ').value.trim();
  const outStatus = status==='OTHER' ? (otherJ ? 'VISITED' : 'UNACCOUNTED') : status;
  const base = {
    token:c.token, action:'addStop', installer:c.name,
    timestamp:stamp(),
    workOrderId:$('wo').value.trim(), unit:$('unit').value.trim(),
    address:$('addr').value.trim(), lat:coords.lat, lng:coords.lng, status:outStatus,
    notes:$('stopNotes').value.trim(),
    requestedMeter: (status==='INSTALLED'||status==='UTI') && requested
  };
  if(status==='INSTALLED' && noRead){
    const r = $('nrReason').value;
    Object.assign(base, {
      meterRead:null, meterReadReceived:null, newJNumber:$('newJ').value.trim(),
      oldJNumber:$('nrOldJ').value.trim(),
      noReadReason: r==='Other' ? ('Other: '+$('nrOther').value.trim()) : r,
      utiReason:null });
  } else if(status==='INSTALLED'){
    Object.assign(base, {
      meterRead: num($('read').value),
      meterReadReceived: solar ? num($('readRecv').value) : null,
      newJNumber: $('newJ').value.trim(), oldJNumber:$('installOldJ').value.trim()||null, noReadReason:null, utiReason:null });
  } else if(status==='UTI'){
    const reason = $('utiReason').value;
    Object.assign(base, {
      meterRead:null, meterReadReceived:null, newJNumber:null, oldJNumber:$('oldJ').value.trim(), noReadReason:null,
      utiReason: reason==='Other' ? ('Other: '+$('utiOther').value.trim()) : reason });
  } else { // OTHER — VISITED (has an old J#) or UNACCOUNTED (blank); coords + note
    Object.assign(base, {
      meterRead:null, meterReadReceived:null, newJNumber:null,
      oldJNumber: otherJ || null, noReadReason:null, utiReason:null });
  }
  enqueue(base);
  // Remember this coord→address (even a hand-typed one) so the same spot resolves
  // offline next time and feeds the backfill cache.
  if(base.lat!=null && base.lng!=null && base.address) cacheAddress(base.lat, base.lng, base.address);
  // Dispatch downtime isn't written live — "Requested meter?" only sets the
  // requestedMeter flag on the stop. The spine matches the request to this install
  // at end of day and pre-fills the wait as an editable DISPATCH travel deduction
  // (?action=idle), so logging stays a cheap append.
  markWorklistDone(base.workOrderId);   // complete the matching planned order, if any
  toast(
    status==='INSTALLED'  ? (noRead ? 'Install logged · no read ✓' : 'Install logged ✓') :
    status==='UTI'        ? 'UTI logged ✓' :
    outStatus==='VISITED' ? 'Visited logged ✓' :
                            'Unaccounted logged ✓');
  ['read','readRecv','newJ','installOldJ','wo','unit','addr','oldJ','utiOther','nrOldJ','nrOther','otherOldJ','stopNotes'].forEach(id => $(id).value='');
  setNoRead(false); setSolar(false); setRequested(false);
  getLocation();
};

// ── mark spot done (GPS only) ───────────────────────────────────────────
// One tap: capture coordinates and log a "meter's already installed here by
// someone else" marker. No work order / read / J#. Status DONE keeps it out of
// the install + UTI counts (it isn't your work), and it feeds the map's
// "already done?" check. Goes through the same offline queue, so no signal is
// fine.
$('markDone').onclick = () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  if(!navigator.geolocation){ toast('No GPS on this device'); return; }
  toast('Getting location…');
  navigator.geolocation.getCurrentPosition(
    p => { enqueue({ token:c.token, action:'addStop', installer:c.name,
                     timestamp:stamp(),
                     lat:+p.coords.latitude.toFixed(6), lng:+p.coords.longitude.toFixed(6),
                     status:'DONE' });
           toast('Marked — already installed ✓'); },
    () => toast("Couldn't get GPS — try again"),
    { enableHighAccuracy:true, timeout:8000 });
};

// ── downtime ────────────────────────────────────────────────────────────
$('openDowntime').onclick = () => openSheet('downtimeSheet');
$('dtCat').onchange = e => {
  const other = e.target.value==='OTHER';
  $('dtNote').classList.toggle('hide', !other);
  $('dtNoteLabel').classList.toggle('hide', !other);
};
$('saveDowntime').onclick = () => {
  const c = cfg();
  if(!$('dtMin').value.trim()){ toast('Minutes required'); return; }
  if($('dtCat').value==='OTHER' && !$('dtNote').value.trim()){ toast('Describe what happened'); return; }
  enqueue({ token:c.token, action:'addDowntime', installer:c.name,
            timestamp:stamp(), category:$('dtCat').value,
            minutes:Number($('dtMin').value.trim()), workOrderId:$('dtWo').value.trim(),
            note:$('dtNote').value.trim() });
  toast('Downtime logged ✓');
  $('dtMin').value=''; $('dtWo').value=''; $('dtNote').value='';
  closeSheets();
};

// Location label for tables/summaries: the address, with the unit folded in
// front when both exist (e.g. "14-1 Long Rd"). Per the rule, a unit only shows
// when it's paired with an address.
function locLabel(s){
  const unit = String(s.unit==null?'':s.unit).trim();
  const addr = String(s.address==null?'':s.address).trim();
  if(!addr) return '';
  return unit ? (unit + ' ' + addr) : addr;
}

// ── editable stop card (shared by Look up + End of day) ────────────────────
const statusTagClass = st =>
  st==='UTI' ? 'tag-uti' : st==='VISITED' ? 'tag-visit' : st==='UNACCOUNTED' ? 'tag-unacc' : 'tag-ok';
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
function makeStopCard(s, onSaved, opts){
  const pos = opts && opts.pos;
  const card = document.createElement('div');
  card.className = 'stopcard';
  card.innerHTML = `
    <div class="sc-head">
      <div class="sc-sum">${summaryHTML(s, pos)}</div>
      <button class="mini" data-act="toggle">Edit</button>
    </div>
    ${opts && opts.travel ? '<div class="sc-travel" style="margin-top:6px"></div>' : ''}
    <div class="sc-edit hide">
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
      <button class="primary sc-save" data-act="save">Save changes</button>
    </div>`;

  if(opts && opts.travel) renderStopTravel(card.querySelector('.sc-travel'), s, pos);

  const editBlock = card.querySelector('.sc-edit');
  const toggleBtn = card.querySelector('[data-act="toggle"]');
  toggleBtn.onclick = () => {
    editBlock.classList.toggle('hide');
    toggleBtn.textContent = editBlock.classList.contains('hide') ? 'Edit' : 'Close';
  };

  card.querySelector('[data-act="save"]').onclick = () => {
    const c = cfg();
    if(!c.url || !c.token){ toast('Add your URL first'); return; }
    // A still-pending stop (logged offline, not yet acked) is editable: the
    // queue is FIFO so its addStop reaches the server before this updateStop,
    // and both carry the same client id, so the edit applies to the right row.
    const g = f => card.querySelector(`[data-f="${f}"]`).value.trim();
    const payload = {
      token:c.token, action:'updateStop', id:s.id,
      workOrderId:g('wo'), unit:g('unit'), address:g('addr'),
      status:g('status'), newJNumber:g('newJ'), oldJNumber:g('oldJ'),
      meterRead: g('read')===''? null : Number(g('read')),
      meterReadReceived: g('readRecv')===''? null : Number(g('readRecv')),
      utiReason:g('utiReason'), notes:g('notes')
    };
    // Optimistic DOM update — matches what the server will persist
    Object.assign(s, payload);
    card.querySelector('.sc-sum').innerHTML = summaryHTML(s, pos);
    editBlock.classList.add('hide'); toggleBtn.textContent = 'Edit';
    // Route through the offline queue so edits survive with no signal
    enqueue(payload);
    toast(navigator.onLine ? 'Saving…' : 'Saved — will sync when online');
    if(typeof onSaved === 'function') onSaved();
  };
  return card;
}

// ── look up ────────────────────────────────────────────────────────────────
$('openLookup').onclick = () => { $('lookupQ').value=''; $('lookupResults').innerHTML=''; openSheet('lookupSheet'); };
$('doLookup').onclick = async () => {
  const c = cfg();
  if(!c.url || !c.token){ openSheet('settingsSheet'); toast('Add your URL first'); return; }
  const q = $('lookupQ').value.trim();
  if(!q){ toast('Enter a WO# or J#'); return; }
  $('lookupResults').innerHTML = '<p class="muted">Searching…</p>';
  try{
    // send the query as both — the spine matches WO# OR J#, so either kind finds it
    const d = await apiGet('lookup', { wo:q, j:q });
    const box = $('lookupResults'); box.innerHTML='';
    const matches = d.matches || [];
    if(!matches.length){ box.innerHTML = '<p class="muted">No match found.</p>'; return; }
    matches.forEach(s => box.appendChild(makeStopCard(s)));
  } catch { $('lookupResults').innerHTML = "<p class=\"muted\">Couldn't search — check the connection.</p>"; }
};

// ── end of day: review, edit, then finish ──────────────────────────────────
// Re-draw the 1st WO's launch leg as the Departure time is typed.
$('eodDeparture').addEventListener('input', () => { if(updateLaunch) updateLaunch(); schedulePersistEod(); });
$('eodReturned').addEventListener('input', schedulePersistEod);

$('endDay').onclick = async () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  await flush();
  $('eodNotes').value=''; $('eodTally').textContent='Loading…'; $('eodList').innerHTML='';
  $('eodDeparture').value=''; $('eodReturned').value=''; $('eodIdle').innerHTML=''; eodGaps=[];
  openSheet('eodSheet');
  await loadDay('eod');
};

// Every WO→WO gap → an editable card. The installer subtracts any downtime, lunch
// or break that happened during the drive; whatever's left is the travel time. The
// allocations are stashed in `eodGaps` and saved (saveTravel) at Finish, so the
// math is idempotent and editable up to the last moment.
let eodGaps = [];

// gapByToId maps a gap to its arriving stop (g.toId === stop.id), so each gap shows
// as an inline "Travel in" dropdown on its work-order card.
let gapByToId = {};
function setGapData(gaps){
  eodGaps = (gaps||[]).map(g => ({
    start:g.start, end:g.end, idleMin:g.idleMin, toWO:g.toWO||'', toId:g.toId,
    allocations:(g.allocations||[]).map(a => ({ category:a.category, minutes:Number(a.minutes)||0 })),
    _views:[]   // every rendered editor for this gap, so edits stay in sync
  }));
  gapByToId = {};
  eodGaps.forEach(g => { if(g.toId!=null && g.toId!=='') gapByToId[g.toId]=g; });
}

// Net travel = gap minutes − subtracted minutes.
function gapNet(g){
  const used = (g.allocations||[]).reduce((s,a)=>s+(Number(a.minutes)||0),0);
  const net = g.idleMin - used;
  return { used, net, over: used > g.idleMin,
           text: used > g.idleMin ? `⚠ ${used} over ${g.idleMin}` : `Travel ${net} min` };
}
// Re-sync every place a gap is shown. syncNet on minutes typing (keeps focus);
// syncDraw rebuilds rows on add/delete.
function syncNet(g){ (g._views||[]).forEach(v => v.onNet && v.onNet()); schedulePersistEod(); }
function syncDraw(g){ (g._views||[]).forEach(v => { v.drawRows && v.drawRows(); v.onNet && v.onNet(); }); schedulePersistEod(); }

// Shared subtract-downtime editor (rows + "add"), bound to gap `g`. `onNet` lets the
// host update its own net display; registers itself in g._views.
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
        const dep = $('eodDeparture').value, arr = clockOf(s.timestamp);
        const dm = hhmmMin(dep), am = hhmmMin(arr);
        box.innerHTML = (dm == null || am == null)
          ? '<div class="sc-meta">Travel in: — (set Departure time)</div>'
          : `<div class="sc-meta">Travel in: <b style="color:var(--install)">${Math.max(0, am-dm)} min</b> · from Departure</div>`;
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
    toggle.innerHTML = `${arrow()} Travel in: <b style="color:${n.over?'#c0392b':'var(--install)'}">${n.over ? esc(n.text) : (n.net+' min')}</b>`; };
  toggle.onclick = () => { body.classList.toggle('hide'); onNet(); };
  const meta = document.createElement('div'); meta.className = 'sc-meta'; meta.style.marginBottom = '4px';
  meta.textContent = `${g.start}–${g.end} · ${g.idleMin} min gap`;
  body.appendChild(meta);
  body.appendChild(allocEditor(g, onNet));
  box.appendChild(toggle); box.appendChild(body);
  onNet();
}

// Flattens the per-gap allocation state into the saveTravel payload (positive only).
function collectGapAllocations(gaps){
  const out = [];
  (gaps||[]).forEach(g => (g.allocations||[]).forEach(a => {
    if((parseInt(a.minutes,10)||0) > 0)
      out.push({ fromTime:g.start, toTime:g.end, workOrderId:g.toWO||'', category:a.category, minutes:parseInt(a.minutes,10) });
  }));
  return out;
}

// Storage-first end-of-day review: stash the current travel deductions and the
// Departure/Returned bookends into dayCache so an offline review survives a
// reload and re-renders via computeGapsLocal. Cleared once saveTravel syncs
// (reconcileCache). Debounced so live typing doesn't thrash IndexedDB.
async function persistEodReview(){
  const c = cfg(); if(!c.name) return;
  const key = `${c.name}|${localDate()}`;
  const cached = (await idb.get('dayCache', key))
    || { stops:[], downtime:[], day:{}, closed:false, cachedAt:stamp() };
  cached.eodTravel = collectGapAllocations(eodGaps);
  cached.day = Object.assign({}, cached.day,
    { departure:$('eodDeparture').value, returned:$('eodReturned').value });
  await idb.put('dayCache', cached, key);
}
let _eodPersistTimer;
function schedulePersistEod(){ clearTimeout(_eodPersistTimer); _eodPersistTimer = setTimeout(persistEodReview, 700); }

// ── cached day loader (stale-while-revalidate) ─────────────────────────────
// Merge a fresh server list with locally-pending entries. The server is
// authoritative for anything it already knows about (matched by id); any cached
// row still flagged _tempId (logged on the phone, not yet acked) is overlaid so
// a refresh never drops un-synced work. Once a row syncs, reconcileCache clears
// its _tempId and the server copy naturally wins.
function mergePending(serverArr, cachedArr){
  const out = (serverArr || []).slice();
  const ids = new Set(out.map(r => String(r.id)));
  (cachedArr || []).forEach(r => { if(r._tempId && !ids.has(String(r.id))) out.push(r); });
  return out;
}

// Opens Today or EOD: renders from IDB cache immediately (instant), then
// re-fetches from Sheets in the background and re-renders with fresh data.
// Offline → shows cached data (or a "nothing cached" message).
async function loadDay(mode){
  const c = cfg(); if(!c.name) return;
  const key = `${c.name}|${localDate()}`;
  const cached = await idb.get('dayCache', key);
  let renderedFromCache = false;

  if(cached){
    const localGaps = mode==='eod' ? computeGapsLocal(cached.stops||[], cached.downtime||[], cached.eodTravel) : [];
    renderDayData(mode, cached.stops||[], cached.downtime||[], cached.day||{}, localGaps);
    renderedFromCache = true;
  }

  if(!navigator.onLine || !c.url || !c.token){
    if(!renderedFromCache){
      const msg = '<p class="muted">Offline — nothing cached yet for today.</p>';
      if(mode==='today'){ $('todayTally').textContent=''; $('todayTable').innerHTML=msg; }
      else              { $('eodTally').textContent='';   $('eodList').innerHTML=msg; }
    } else {
      // Show a subtle offline banner above the cached content
      const note = document.createElement('p');
      note.className='muted'; note.style.cssText='text-align:center;font-size:13px;margin:0 0 8px';
      note.textContent='Offline — showing last saved data';
      if(mode==='today') $('todayTable').prepend(note);
      else               $('eodList').prepend(note);
    }
    return;
  }

  try{
    const d = await apiGet('day', { installer:c.name });
    // Re-read the cache (an enqueue may have run since the top of this fn) and
    // merge, so locally-pending stops/downtime survive the server pull.
    const local = await idb.get('dayCache', key);
    const stops    = mergePending(d.stops,    local && local.stops);
    const downtime = mergePending(d.downtime, local && local.downtime);
    const pendingTravel = local && local.eodTravel;   // offline review not yet synced
    await idb.put('dayCache', {
      stops, downtime,
      day:d.day||{}, closed:!!d.closed, cachedAt:stamp(),
      eodTravel: pendingTravel   // preserved so a brief reconnect can't wipe an un-synced review
    }, key);
    // Local gaps render instantly; the authoritative `idle` overrides them when it lands.
    let gaps = mode==='eod' ? computeGapsLocal(stops, downtime, pendingTravel) : [];
    if(mode==='eod'){
      try{
        const idata = await apiGet('idle', { installerId:c.hNumber, installer:c.name });
        if(idata.gaps) gaps = idata.gaps;
      } catch {}
    }
    renderDayData(mode, stops, downtime, d.day||{}, gaps);
  } catch {
    if(!renderedFromCache){
      const msg = '<p class="muted">Couldn\'t load — check the connection.</p>';
      if(mode==='today'){ $('todayTally').textContent=''; $('todayTable').innerHTML=msg; }
      else              { $('eodTally').textContent='';   $('eodList').innerHTML=msg; }
    }
    // If cached render is already showing, just leave it — no error shown
  }
}

function renderDayData(mode, stops, downtime, day, gaps){
  if(mode==='today'){
    renderToday(stops, downtime);
  } else {
    setGapData(gaps);
    renderEod(stops, downtime);
    if(day.departure) $('eodDeparture').value = day.departure;
    if(day.returned)  $('eodReturned').value  = day.returned;
  }
}

function renderEod(stops, downtime){
  eodData = { stops, downtime };
  const editable = stops.filter(s => PRINTABLE[s.status]);
  $('eodTally').textContent = tallyText(countDay(stops, downtime));

  const list = $('eodList'); list.innerHTML='';
  updateLaunch = null;   // cleared each render; the 1st WO re-arms it if it has a launch leg
  if(!editable.length){ list.innerHTML = '<p class="muted">Nothing logged today yet.</p>'; return; }
  // Position = order by arrival time across all logged WOs shown (1st, 2nd, …).
  const ordered = editable.slice().sort((a,b)=> String(a.timestamp).localeCompare(String(b.timestamp)));
  const posById = {}; ordered.forEach((s,i)=> posById[s.id]=i+1);
  ordered.forEach(s => list.appendChild(makeStopCard(s, null, { pos: posById[s.id], travel: true })));
}

let eodData = { stops:[], downtime:[] };   // stash for weather + PDF

$('finishDay').onclick = async () => {
  const c = cfg();
  // Storage-first: never lose the travel/downtime review or the bookend times.
  await persistEodReview();

  // No signal → the PDF/close can't be built (the spine does that). Queue the
  // review (travel deductions + bookends) so it syncs, and tell the installer to
  // tap Finish again once online to generate the PDF.
  if(!navigator.onLine){
    enqueue({ token:c.token, action:'saveTravel', installer:c.name, installerId:c.hNumber,
              allocations: collectGapAllocations(eodGaps) });
    if($('eodDeparture').value || $('eodReturned').value)
      enqueue({ token:c.token, action:'saveDay', installer:c.name,
                departure:$('eodDeparture').value, returned:$('eodReturned').value });
    closeSheets();
    toast('Saved offline — reconnect and tap Finish to get the PDF');
    return;
  }

  let weather = '';
  const withCoord = (eodData.stops||[]).find(s =>
    s.lat!=null && s.lng!=null && !isNaN(Number(s.lat)) && !isNaN(Number(s.lng)));
  if (withCoord) weather = await fetchWeather(Number(withCoord.lat), Number(withCoord.lng));
  // Flush first so any queued stops / manual downtime are written before the spine
  // tallies the day.
  await flush();
  try{
    // Persist the per-gap travel deductions first (replaces this day's prior set), so
    // the daily log the spine builds next already reflects the subtracted travel times.
    await apiPost({ action:'saveTravel', installer:c.name, installerId:c.hNumber,
                    allocations: collectGapAllocations(eodGaps) });
    const d = await apiPost({ action:'endOfDay', installer:c.name, installerId:c.hNumber,
                    notes:$('eodNotes').value.trim(), weather,
                    includeDelays:$('eodIncludeDelays').checked,
                    departure:$('eodDeparture').value, returned:$('eodReturned').value });
    // The review reached the Sheet — drop any local pending copy so the next
    // load reads the authoritative gap rows back.
    const key = `${c.name}|${localDate()}`;
    const cc = await idb.get('dayCache', key);
    if(cc && cc.eodTravel){ delete cc.eodTravel; await idb.put('dayCache', cc, key); }
    closeSheets();
    if (d.pdf && d.pdf.base64) {
      downloadBase64Pdf(d.pdf.base64, d.pdf.name);
      toast('Day closed ✓ · PDF downloaded');
    } else {
      toast(d.pdf && d.pdf.error ? ('Day closed · PDF failed') : 'Day closed ✓');
    }
  } catch { toast('Could not reach the sheet'); }
};

// weather (Open-Meteo, keyless) ------------------------------------------------
const WMO = {0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Rime fog',
  51:'Light drizzle',53:'Drizzle',55:'Heavy drizzle',56:'Freezing drizzle',57:'Freezing drizzle',
  61:'Light rain',63:'Rain',65:'Heavy rain',66:'Freezing rain',67:'Freezing rain',
  71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',80:'Light showers',81:'Showers',
  82:'Heavy showers',85:'Snow showers',86:'Snow showers',95:'Thunderstorm',96:'Thunderstorm w/ hail',99:'Thunderstorm w/ hail'};
function wmoText(c){ return WMO[c] || 'Weather'; }
function compass(d){ if(d==null||isNaN(d)) return ''; return ['N','NE','E','SE','S','SW','W','NW'][Math.round(((d%360)/45))%8]; }
async function fetchWeather(lat,lng){
  try{
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
            + `&current=weather_code,wind_speed_10m,wind_direction_10m,temperature_2m`
            + `&wind_speed_unit=kmh&timezone=America%2FToronto`;
    const c = (await (await fetch(u)).json()).current; if(!c) return '';
    const parts = [ wmoText(c.weather_code) ];
    if (c.wind_speed_10m!=null) parts.push((compass(c.wind_direction_10m)+' ').trimStart() + Math.round(c.wind_speed_10m) + ' km/h');
    if (c.temperature_2m!=null) parts.push(Math.round(c.temperature_2m) + '°C');
    return parts.join(' · ');
  } catch { return ''; }
}
// download the PDF the spine returns
function downloadBase64Pdf(b64, name){
  try{
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'}));
    const a = document.createElement('a'); a.href=url; a.download=name||'DailyLog.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 5000);
  } catch { toast("PDF ready, but download was blocked — it's also in Drive"); }
}

// ── generate a draft daily log WITHOUT closing the day ─────────────────────
// Builds + downloads the PDF from today's stops only. Writes nothing (no Tracker
// row); departure / return / weather stay blank — the real End of day fills them.
$('genLog').onclick = async () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  toast('Building daily log…');
  await flush();
  try{
    const d = await apiPost({ action:'previewDailyLog',
                              installer:c.name, installerId:c.hNumber,
                              includeDelays:$('eodIncludeDelays').checked });
    if (d.pdf && d.pdf.base64) {
      downloadBase64Pdf(d.pdf.base64, d.pdf.name);
      toast('Daily log downloaded — draft (day not closed)');
    } else {
      toast(d.pdf && d.pdf.error ? 'Daily log failed to build' : 'No stops logged today yet');
    }
  } catch { toast('Could not reach the sheet'); }
};

// ── today's orders: a quick table of what's logged today ───────────────────
$('openToday').onclick = async () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  await flush();
  $('todayTally').textContent = 'Loading…'; $('todayTable').innerHTML=''; $('todayEdit').innerHTML='';
  openSheet('todaySheet');
  await loadDay('today');
};

const CAT_LABEL = {
  NEXT_GEN:'Next Gen', CELL_SIGNAL:'Cell Signal', BAD_WEATHER:'Bad Weather',
  WAREHOUSE:'Warehouse', TOOLS_MATERIAL:'Tools/Material', DISPATCH:'Dispatch',
  TRUCK_ISSUES:'Truck Issues', ASSIST:'Assist', URGENT_EER:'Urgent/EER',
  LUNCH:'Lunch', BREAK:'Break', MISC_TRAVEL:'Misc Travel',
  TRAVEL_TIME:'Travel Time', OTHER:'Other'
};
// Reasons offered for subtracting from a WO→WO gap. No "Travel Time" — whatever's
// left after subtractions IS the travel time, so it never needs picking.
const ALLOC_CATS = ['NEXT_GEN','CELL_SIGNAL','BAD_WEATHER','WAREHOUSE','TOOLS_MATERIAL',
  'DISPATCH','TRUCK_ISSUES','ASSIST','URGENT_EER','LUNCH','BREAK','MISC_TRAVEL','OTHER'];
const catLabel = c => CAT_LABEL[c] || c || 'Other';

// Meter-read cell: the read (+ received for solar) for an install; the reason
// for a UTI (coloured so UTIs stand out); "no read" for an unreadable install.
function readCell(s){
  if(s.status==='UTI') return `<span class="tag-uti">${esc(s.utiReason)||'UTI'}</span>`;
  if(s.status==='VISITED') return `<span class="tag-visit">Visited</span>`;
  if(s.status==='UNACCOUNTED') return `<span class="tag-unacc">Unaccounted</span>`;
  if(s.meterRead || s.meterRead===0){
    return esc(s.meterRead) + ((s.meterReadReceived||s.meterReadReceived===0) ? (' / '+esc(s.meterReadReceived)) : '');
  }
  return s.noReadReason ? '<span style="color:var(--ink-soft)">no read</span>' : '—';
}

// Downtime booked against this WO#, summed per category: "20 Tools/Material".
// (Downtime logged without a work order isn't attributed to a row, but still
// counts in the day total shown above.)
function dtForWO(wo, downtime){
  const w = String(wo==null?'':wo).trim();
  if(!w) return '';
  const byCat = {};
  (downtime||[]).forEach(d => {
    if(String(d.workOrderId==null?'':d.workOrderId).trim() === w){
      const cat = d.category || 'OTHER';
      byCat[cat] = (byCat[cat]||0) + (Number(d.minutes)||0);
    }
  });
  return Object.keys(byCat).map(cat => `${byCat[cat]} ${catLabel(cat)}`).join(', ');
}

function renderToday(stops, downtime){
  const editable = stops.filter(s => PRINTABLE[s.status]);
  $('todayTally').textContent = tallyText(countDay(stops, downtime));

  $('todayEdit').innerHTML='';
  if(!editable.length){ $('todayTable').innerHTML = '<p class="muted">Nothing logged today yet.</p>'; return; }

  let html = '<div class="tblwrap"><table class="tbl"><thead><tr>'
           + '<th>WO#</th><th>Address</th><th>New J#</th><th>Meter read</th><th>Downtime (min)</th>'
           + '</tr></thead><tbody>';
  editable.forEach((s, i) => {
    const dt = dtForWO(s.workOrderId, downtime);
    html += `<tr data-i="${i}">`
          + `<td class="mono nowrap">${esc(s.workOrderId)||'—'}</td>`
          + `<td>${esc(locLabel(s))||'—'}</td>`
          + `<td class="mono nowrap">${esc(s.newJNumber)||'—'}</td>`
          + `<td>${readCell(s)}</td>`
          + `<td>${dt || '—'}</td>`
          + `</tr>`;
  });
  html += '</tbody></table></div>';
  $('todayTable').innerHTML = html;

  $('todayTable').querySelectorAll('tr[data-i]').forEach(tr => {
    tr.onclick = () => {
      const s = editable[+tr.dataset.i];
      const box = $('todayEdit'); box.innerHTML='';
      box.appendChild(makeStopCard(s, () => renderToday(stops, downtime)));
      box.scrollIntoView({ behavior:'smooth', block:'start' });
    };
  });
}

// ── recent days (offline-viewable history) ─────────────────────────────────
// The installer's own last week, cached on the phone. Online open refreshes the
// cache (cacheRecentDays); offline it reads whatever's stored. Editing a stop
// from here routes through updateStop like Today/EOD do.
async function openRecent(){
  openSheet('recentSheet');
  $('recentList').innerHTML = '<p class="muted">Loading…</p>';
  $('recentDay').innerHTML = '';
  if(navigator.onLine) await cacheRecentDays(7);   // best-effort refresh
  await renderRecent();
}

async function renderRecent(){
  const days = await loadRecentDays(7);
  const list = $('recentList'); list.innerHTML='';
  if(!days.some(d => d.stops.length || d.downtime.length)){
    list.innerHTML = '<p class="muted">No recent days cached yet. Open this online once to download your week.</p>';
    return;
  }
  days.forEach(d => {
    const installed = d.stops.filter(s=>s.status==='INSTALLED').length;
    const uti       = d.stops.filter(s=>s.status==='UTI').length;
    const editable  = d.stops.filter(s=>PRINTABLE[s.status]).length;
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.style.cssText = 'width:100%;text-align:left;margin-top:8px;height:auto;padding:12px 14px';
    const label = d.date===localDate() ? `${d.date} · Today` : d.date;
    btn.innerHTML = `<strong>${esc(label)}</strong><br>`
      + `<span class="sc-meta">Installed ${installed} · UTI ${uti}`
      + `${d.closed?' · closed':''}${editable?'':' · nothing logged'}</span>`;
    btn.onclick = () => renderRecentDay(d);
    list.appendChild(btn);
  });
}

function renderRecentDay(d){
  const box = $('recentDay'); box.innerHTML='';
  const head = document.createElement('div');
  head.className='eod-tally'; head.style.marginTop='14px';
  head.textContent = `${d.date} — ` + tallyText(countDay(d.stops, d.downtime));
  box.appendChild(head);
  const editable = d.stops.filter(s=>PRINTABLE[s.status])
    .sort((a,b)=> String(a.timestamp).localeCompare(String(b.timestamp)));
  if(!editable.length){
    const p=document.createElement('p'); p.className='muted'; p.textContent='Nothing logged this day.';
    box.appendChild(p); return;
  }
  editable.forEach(s => box.appendChild(makeStopCard(s, () => renderRecentDay(d))));
  box.scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── settings + sheets plumbing ──────────────────────────────────────────────
function openSheet(id){
  if(id==='settingsSheet'){
    $('cfgFirst').value = store.get('firstName')||'';
    $('cfgLast').value  = store.get('lastName')||'';
    $('cfgH').value     = store.get('hNumber')||'';
  }
  $(id).classList.remove('hide');
}
function closeSheets(){ document.querySelectorAll('.sheet').forEach(s=>s.classList.add('hide')); }
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if(e.target===s) closeSheets(); }));

// ── nav dropdown ──────────────────────────────────────────────────────────────
$('navBtn').onclick = e => { e.stopPropagation(); $('navMenu').classList.toggle('hide'); };
document.addEventListener('click', () => { const m=$('navMenu'); if(m) m.classList.add('hide'); });
$('navWorklist').onclick = () => { $('navMenu').classList.add('hide'); openWorklist(); };
$('navRecent').onclick    = () => { $('navMenu').classList.add('hide'); openRecent(); };
$('navSettings').onclick  = () => { $('navMenu').classList.add('hide'); openSheet('settingsSheet'); };

// ── worklist ──────────────────────────────────────────────────────────────────
let _wlEditId = null;   // null = new order, string = id being edited

async function openWorklist(){
  _wlEditId = null;
  $('wlForm').classList.add('hide');
  $('wlAddBtn').textContent = '＋ Add order';
  openSheet('worklistSheet');
  await renderWorklist();
}

async function renderWorklist(){
  const items = (await idb.all('worklist')) || [];
  const pending = items.filter(x => x.wlStatus !== 'done');
  const done    = items.filter(x => x.wlStatus === 'done');
  const list = $('wlList'); list.innerHTML='';
  if(!items.length){ list.innerHTML='<p class="muted">No orders yet — tap ＋ Add order to plan your day.</p>'; return; }
  [...pending, ...done].forEach(item => list.appendChild(makeWlCard(item)));
}

function makeWlCard(item){
  const card = document.createElement('div');
  card.className = 'wl-card' + (item.wlStatus==='done' ? ' wl-done-card' : '');
  const title = item.workOrderId ? `WO ${esc(item.workOrderId)}` : '(no WO#)';
  const sub = [item.unit && esc(item.unit), item.address && esc(item.address)].filter(Boolean).join(' ');
  const jLine = [item.oldJNumber && `Old J# ${esc(item.oldJNumber)}`, item.newJNumber && `New J# ${esc(item.newJNumber)}`].filter(Boolean).join(' · ');
  const doneTag = item.wlStatus==='done' ? ' <span style="color:var(--install);font-size:13px">✓ done</span>' : '';
  card.innerHTML = `
    <div>
      <strong>${title}</strong>${doneTag}
      ${sub   ? `<div class="wl-body">${sub}</div>` : ''}
      ${jLine ? `<div class="wl-body mono" style="font-size:13px">${jLine}</div>` : ''}
      ${item.notes ? `<div class="wl-body" style="margin-top:2px">${esc(item.notes)}</div>` : ''}
    </div>
    <div class="wl-actions">
      ${item.wlStatus !== 'done' ? '<button class="wl-use" data-act="use">Use →</button>' : ''}
      <button class="wl-edit" data-act="edit">Edit</button>
      <button class="wl-del" data-act="del">✕</button>
    </div>`;
  card.querySelector('[data-act="edit"]').onclick = () => wlOpenForm(item);
  if(item.wlStatus !== 'done') card.querySelector('[data-act="use"]').onclick = () => wlUse(item);
  card.querySelector('[data-act="del"]').onclick = async () => {
    await idb.del('worklist', item.id);
    toast('Order removed');
    await renderWorklist();
  };
  return card;
}

function wlOpenForm(item){
  _wlEditId = item ? item.id : null;
  $('wlWo').value    = item ? (item.workOrderId||'') : '';
  $('wlUnit').value  = item ? (item.unit||'') : '';
  $('wlAddr').value  = item ? (item.address||'') : '';
  $('wlOldJ').value  = item ? (item.oldJNumber||'') : '';
  $('wlNewJ').value  = item ? (item.newJNumber||'') : '';
  $('wlNotes').value = item ? (item.notes||'') : '';
  $('wlForm').classList.remove('hide');
  $('wlAddBtn').textContent = '✕ Cancel';
  $('wlWo').focus();
  $('wlForm').scrollIntoView({behavior:'smooth', block:'start'});
}

$('wlAddBtn').onclick = () => {
  if(!$('wlForm').classList.contains('hide')){
    $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; return;
  }
  wlOpenForm(null);
};
$('wlFormCancel').onclick = () => { $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; };
$('wlFormSave').onclick = async () => {
  const wo = $('wlWo').value.trim();
  if(!wo && !$('wlAddr').value.trim()){ toast('Enter a work order # or address'); return; }
  const now = stamp();
  const isEdit = !!_wlEditId;
  let item;
  if(isEdit){
    const existing = (await idb.get('worklist', _wlEditId)) || {};
    item = Object.assign({}, existing, {
      id:_wlEditId, workOrderId:wo, unit:$('wlUnit').value.trim(),
      address:$('wlAddr').value.trim(), oldJNumber:$('wlOldJ').value.trim(),
      newJNumber:$('wlNewJ').value.trim(), notes:$('wlNotes').value.trim(), updatedAt:now
    });
  } else {
    item = {
      id: now + '-' + Math.random().toString(36).slice(2,6),
      workOrderId:wo, unit:$('wlUnit').value.trim(), address:$('wlAddr').value.trim(),
      oldJNumber:$('wlOldJ').value.trim(), newJNumber:$('wlNewJ').value.trim(),
      notes:$('wlNotes').value.trim(), wlStatus:'pending', createdAt:now, updatedAt:now
    };
  }
  await idb.put('worklist', item);
  $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null;
  toast(isEdit ? 'Order updated ✓' : 'Order saved ✓');
  await renderWorklist();
};

async function wlUse(item){
  // Prefill the capture form from this worklist order
  $('wo').value        = item.workOrderId || '';
  $('unit').value      = item.unit || '';
  $('addr').value      = item.address || '';
  $('newJ').value      = item.newJNumber || '';
  $('installOldJ').value = item.oldJNumber || '';
  $('oldJ').value      = item.oldJNumber || '';
  $('nrOldJ').value    = item.oldJNumber || '';
  $('otherOldJ').value = '';
  $('stopNotes').value = item.notes || '';
  setStatus('INSTALLED');  // default; installer changes if needed
  // Don't mark done here — completion is driven by an actual log (see
  // markWorklistDone), so an order only clears once the stop is captured.
  closeSheets();
  window.scrollTo({top:0, behavior:'smooth'});
  toast('Prefilled from worklist ✓');
}

// Completing a planned worklist order when its work order is actually logged.
// Matches the first pending card by WO# (case-insensitive); a blank WO# never
// matches. Runs entirely against IndexedDB so it works with no signal.
async function markWorklistDone(workOrderId){
  const wo = String(workOrderId || '').trim().toUpperCase();
  if(!wo) return;
  const items = (await idb.all('worklist')) || [];
  const match = items.find(x => x.wlStatus !== 'done'
    && String(x.workOrderId || '').trim().toUpperCase() === wo);
  if(!match) return;
  await idb.put('worklist', Object.assign({}, match, { wlStatus:'done', updatedAt:stamp() }));
  if(!$('worklistSheet').classList.contains('hide')) await renderWorklist();
}
$('saveSettings').onclick = () => {
  const c = cfg();
  const first = $('cfgFirst').value.trim();
  const last  = $('cfgLast').value.trim();
  const h     = $('cfgH').value.trim();
  if(!first || !last){ toast('Enter your first and last name'); return; }
  if(!h){ toast('Enter your employee # (H)'); return; }
  store.set('firstName', first); store.set('lastName', last);
  store.set('name', (first + ' ' + last).trim()); store.set('hNumber', h);
  // Register (or refresh) this person in the crew so an admin can add them to a
  // boat team. Routed through the offline queue, so a first run with no signal
  // still saves the identity locally now and registers when back online.
  enqueue({ token:c.token, action:'saveEmployee', hNumber:h, firstName:first, lastName:last });
  closeSheets(); toast('Saved ✓');
};

// When signal returns: flush the queue, backfill any addresses captured offline,
// and refresh the recent-days cache.
function onReconnect(){ flush(); backfillAddresses(enqueue); cacheRecentDays(7); }
window.addEventListener('online', onReconnect);
window.addEventListener('offline', paint);
// also try to sync whenever the app comes back to the foreground
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
window.addEventListener('focus', flush);
// Drain any pre-IDB localStorage queue into the durable store, then paint + sync,
// prune cache to ~a week, and (when online with a name set) backfill offline
// addresses + pre-cache the recent days so they're viewable with no signal.
migrateLegacyQueue().then(() => {
  paint(); flush(); pruneDayCache();
  if(store.get('name') && navigator.onLine){ backfillAddresses(enqueue); cacheRecentDays(7); }
});
if(!store.get('name')) setTimeout(()=>openSheet('settingsSheet'), 400);

// Register the service worker so the app opens even with no signal.
// This only takes effect once the page is served over HTTPS (GitHub Pages,
// Netlify, Cloudflare Pages, etc.). Opened as a local file or over plain
// http it simply does nothing — the offline save-and-sync queue still works
// as long as the app is already open.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
