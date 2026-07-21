// ── Capture page (index.html) ───────────────────────────────────────────────
// Wires the offline-first capture form: status toggle, location/address,
// logging a stop, downtime, lookup, the end-of-day travel review, Today's
// orders, and the local worklist. Durable state lives in IndexedDB (queue /
// dayCache / worklist); see the imported modules.
import { cfg, store } from '../store.js';
import { $, enc, esc, attr, toast, withActivity } from '../dom.js';
import { stamp, localDate, clockOf, hhmmMin, ordinal, parseLocalMs } from '../time.js';
import { idb } from '../idb.js';
import { apiGet, apiPost } from '../api.js';
import { enqueue, flush, paint, migrateLegacyQueue, setQueueHooks } from '../queue.js';
import { pruneDayCache, cacheRecentDays, loadRecentDays } from '../daycache.js';
import { resolveAddress, cacheAddress, backfillAddresses } from '../geocode.js';
import { computeGapsLocal } from '../compute/gaps.js';
import { PRINTABLE, countDay, tallyText } from '../compute/tally.js';
import { projectDay } from '../compute/estimate.js';
import { buildLocalSummary } from '../compute/summary.js';
import { downloadDailyLog } from '../dailylog.js';
import { initWorklist, openWorklist, markWorklistDone, planAdvance, syncWorklist } from '../worklist.js';
import { geocodeOne } from '../route.js';
import { UTI_REASONS, utiReasonOptionsHTML } from '../utiReasons.js';

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

// ── work mode (boat | land) ─────────────────────────────────────────────
// Persisted per device; flips the accent theme via <html data-mode> (the CSS
// tokens) and tags every write payload with workType. An inline <head> snippet
// already applied the attribute pre-paint; this keeps the switch UI in sync.
export function workMode(){ return store.get('workMode')==='land' ? 'land' : 'boat'; }
function setMode(m){
  store.set('workMode', m);
  document.documentElement.dataset.mode = m;
  $('modeBoat').classList.toggle('on', m==='boat');
  $('modeLand').classList.toggle('on', m==='land');
  applyModeUI();
}
// Mode-dependent chrome: the land daily log always prints the delay columns, so
// the "include delays" choice only exists in boat mode. Land has no dock, so its
// end-of-day bookends are a plain Start / End time rather than Departure / Returned.
function applyModeUI(){
  const land = workMode()==='land';
  $('eodIncludeDelaysWrap').classList.toggle('hide', land);
  if(land) $('eodIncludeDelays').checked = true;
  $('lblDeparture').innerHTML = land ? 'Start time' : 'Departure time <span style="font-weight:500">(left dock)</span>';
  $('lblReturned').textContent = land ? 'End time' : 'Returned to land';
}
$('modeBoat').onclick = () => setMode('boat');
$('modeLand').onclick = () => setMode('land');
setMode(workMode());

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
  setNoRead(false); setSolar(false); setRequested(false); setNoGps(false);
}
$('utiReason').innerHTML = utiReasonOptionsHTML('');
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

// ── no-GPS override ────────────────────────────────────────────────────────
// GPS is required on a normal log so a row never lands without coordinates. When
// there's no signal / GPS is denied, the installer can flip this to log the stop
// anyway with blank coords (the address stays whatever they typed). Deliberate
// opt-in so an accidental missing fix is still caught. Reset after every log.
let noGps = false;
$('noGpsToggle').onclick = () => setNoGps(!noGps);
function setNoGps(on){
  noGps = on;
  $('noGpsToggle').classList.toggle('toggle-on', on);
  $('noGpsToggle').textContent = on
    ? 'No GPS ✓ — will log without coordinates'
    : 'No GPS here? Log without coordinates';
  if(on && coords.lat==null) $('locText').textContent = 'Location: logging without GPS';
}

// Stream GPS fixes and stop as soon as the position is confidently tight —
// when a fix reports `accuracy <= targetAccuracy` metres (the API gives accuracy
// as a 68%-confidence radius) — rather than after a fixed count. Returns one
// 1/accuracy²-weighted average { lat, lng, accuracy }. The first fix a phone
// hands back is usually a coarse/cached one with a big accuracy radius; it only
// refines as the chip settles. watchPosition streams those refining fixes
// (back-to-back getCurrentPosition calls just re-return the cached one), and the
// 1/accuracy² weighting lets the tight late fixes dominate. In good signal this
// finishes in a couple of fixes; in poor signal the chip may never reach the
// target, so `maxMs` is a hard cap that resolves with the best average so far.
// `maxSamples` is just a memory ceiling for a very long fix. onProgress(count,
// currentAccuracy) reports the latest individual fix's accuracy. Resolves with
// whatever arrived before the cap (≥1 sample); rejects only if no GPS or no
// sample at all.
function sampleLocation({ targetAccuracy = 5, maxMs = 15000, maxSamples = 30, onProgress } = {}){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation){ reject(new Error('no-gps')); return; }
    const pts = [];
    let done = false;
    const finish = () => {
      if(done) return; done = true;
      clearTimeout(timer); navigator.geolocation.clearWatch(id);
      if(!pts.length){ reject(new Error('no-fix')); return; }
      let sw = 0, slat = 0, slng = 0, sacc = 0;
      for(const c of pts){
        const w = 1 / Math.pow(Math.max(c.accuracy || 0, 1), 2);
        sw += w; slat += c.latitude * w; slng += c.longitude * w; sacc += (c.accuracy || 0) * w;
      }
      resolve({ lat:+(slat/sw).toFixed(6), lng:+(slng/sw).toFixed(6), accuracy: Math.round(sacc/sw) });
    };
    const id = navigator.geolocation.watchPosition(
      p => {
        pts.push(p.coords);
        const acc = p.coords.accuracy;
        if(onProgress) onProgress(pts.length, acc);
        // Early exit once a fix is tight enough — but require ≥2 fixes so a
        // single coarse/cached first fix can't end it on its own. maxSamples is
        // just a safety ceiling; the real fallback is the maxMs timer.
        if((acc != null && acc <= targetAccuracy && pts.length >= 2) || pts.length >= maxSamples) finish();
      },
      err => { if(!pts.length){ done = true; clearTimeout(timer); navigator.geolocation.clearWatch(id); reject(err); } },
      { enableHighAccuracy:true, maximumAge:0, timeout:maxMs });
    const timer = setTimeout(finish, maxMs);
  });
}

// force = true when the Refresh button is tapped: re-read GPS and overwrite the
// address even if one is already there. Auto calls (on load / after a stop)
// pass nothing, so they only fill the address when it's still empty.
async function getLocation(force){
  if(!navigator.geolocation){ $('locText').textContent = 'Location: no GPS on this device'; return; }
  const btn = $('refreshLoc'); if(btn) btn.disabled = true;
  $('locText').textContent = 'Location: sampling…';
  try {
    const c = await sampleLocation({ onProgress: (n, acc) => {
      $('locText').textContent = acc != null
        ? `Location: sampling… ±${Math.round(acc)} m`
        : 'Location: sampling…';
    }});
    coords = { lat:c.lat, lng:c.lng };
    $('locText').textContent = `Location: ${coords.lat}, ${coords.lng} (±${c.accuracy} m)`;
    // Force (Refresh tap) overwrites the field; the auto call fills only when
    // empty — and, plan-filled, compares the GPS address against the plan.
    await fetchAddress(coords.lat, coords.lng, !!force);
  } catch {
    $('locText').textContent = 'Location: unavailable (saved without coords)';
  } finally {
    if(btn) btn.disabled = false;
  }
}
// ── plan-mode form fill + planned-vs-GPS address conflict ──────────────────
// worklist.js drives plan mode and hands us the order to load via fillCapture.
// planAddr remembers the planned address so fetchAddress can compare it against
// the GPS-resolved one and surface a chooser when they materially disagree.
let planAddr = null;          // address the plan filled (null = not plan-filled)
let lastPlanFill = null;      // the worklist item currently loaded by plan mode
let addrConflictPending = false;

const normAddr = a => String(a == null ? '' : a).toLowerCase().replace(/[^a-z0-9]+/g, '');

function hideAddrConflict(){ addrConflictPending = false; $('addrConflict').classList.add('hide'); }
function showAddrConflict(planned, gps){
  addrConflictPending = true;
  $('acPlanned').textContent = `Keep planned: ${planned}`;
  $('acGps').textContent     = `Use GPS: ${gps}`;
  $('acPlanned').onclick = () => { $('addr').value = planned; hideAddrConflict(); };
  $('acGps').onclick     = () => { $('addr').value = gps;     hideAddrConflict(); };
  $('addrConflict').classList.remove('hide');
}
// Hand-editing the field is itself a decision — drop the chooser.
$('addr').addEventListener('input', hideAddrConflict);

function fillCapture(item){
  if(!item){
    // Plan turned off / list emptied: clear only the fields the plan filled
    // that the installer hasn't since changed.
    if(lastPlanFill){
      const filled = {
        wo: lastPlanFill.workOrderId || '', unit: lastPlanFill.unit || '',
        addr: lastPlanFill.address || '', newJ: lastPlanFill.newJNumber || '',
        installOldJ: lastPlanFill.oldJNumber || '', oldJ: lastPlanFill.oldJNumber || '',
        stopNotes: lastPlanFill.notes || ''
      };
      Object.keys(filled).forEach(id => {
        if($(id).value.trim() === String(filled[id]).trim()) $(id).value = '';
      });
    }
    lastPlanFill = null; planAddr = null; hideAddrConflict();
    return;
  }
  $('wo').value          = item.workOrderId || '';
  $('unit').value        = item.unit || '';
  $('addr').value        = item.address || '';
  $('newJ').value        = item.newJNumber || '';
  $('installOldJ').value = item.oldJNumber || '';
  $('oldJ').value        = item.oldJNumber || '';
  $('stopNotes').value   = item.notes || '';
  planAddr = item.address || '';
  lastPlanFill = item;
  hideAddrConflict();
}
// Quiet plan-mode estimate: how many stops today's pace projects to by end of
// day. Reads only the local dayCache (works offline), returns '' when there's
// no pace yet. worklist.js renders it into the plan banner.
async function planEstimate(){
  const c = cfg(); if(!c.name) return '';
  const cached = await idb.get('dayCache', `${c.name}|${localDate()}`);
  if(!cached) return '';
  const est = projectDay(cached.stops || []);
  if(!est.ready) return '';
  return `~${est.projected} by ${est.label} · ${est.avgCadence} min/stop`;
}
initWorklist({ fillCapture, planEstimate });

// Reverse geocode via resolveAddress (geocode.js): a cached coord resolves
// instantly and OFFLINE; a new coord with signal hits the spine and is cached for
// next time; offline + uncached → leave it for manual entry. In auto mode it
// fills the address only when it's still empty (never clobbers what you typed) —
// except a plan-filled address, which is still compared against the GPS one so a
// wrong house surfaces the chooser. With force it always replaces the field.
async function fetchAddress(lat, lng, force){
  const cur = $('addr').value.trim();
  const planFilled = planAddr && cur && normAddr(cur) === normAddr(planAddr);
  if(!force && cur && !planFilled) return;
  // No force for a plan compare — a cached coord→address IS the GPS answer here.
  const addr = await resolveAddress(lat, lng, { force });
  const cur2 = $('addr').value.trim();
  if(addr && planFilled && cur2 && normAddr(cur2) === normAddr(planAddr)){
    const a = normAddr(addr), p = normAddr(cur2);
    if(a && p && a !== p && a.indexOf(p) === -1 && p.indexOf(a) === -1){
      showAddrConflict(cur2, addr);
      $('locText').textContent = `Location: ${lat}, ${lng} · GPS address differs from plan`;
      return;   // real conflict — let the installer choose which address is right
    }
    // agreement (or one containing the other): fall through so a forced Refresh
    // replaces the placeholder plan text with the real GPS address.
  }
  if(addr && (force || !cur2)){
    $('addr').value = addr;
    $('locText').textContent = `Location: ${lat}, ${lng} · address filled — edit to override`;
  } else if(force){
    $('locText').textContent = navigator.onLine
      ? `Location: ${lat}, ${lng} · no address found — enter manually`
      : `Location: ${lat}, ${lng} · offline — enter address manually`;
  }
}

// GPS + address are captured manually only — the installer taps ↻ Refresh once
// they've actually arrived at the stop. No auto-fetch on load or after a log, so
// a fix from the previous order can't ride onto the next one.
$('refreshLoc').onclick = () => getLocation(true);

// ── log a stop ────────────────────────────────────────────────────────────
$('logStop').onclick = () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  // WO# is required for the two outcomes that finish a work order; the "we were
  // here" outcomes (Visited / Unaccounted) can be logged without one.
  if((status==='INSTALLED' || status==='UTI') && !$('wo').value.trim()){ toast('Work order # is required'); return; }
  // Safety rails (both modes): an install always has the new meter's J#, and a
  // UTI always has a picked reason (the dropdown starts blank on purpose).
  if(status==='INSTALLED' && !$('newJ').value.trim()){ toast('New J# is required'); return; }
  if(status==='UTI' && !$('utiReason').value){ toast('Pick a UTI reason'); return; }
  if(status==='INSTALLED' && noRead && !$('installOldJ').value.trim()){ toast('Scan or type the old J#'); return; }
  // GPS is required on every log — capture the fix at the stop (↻ Refresh) so no
  // row lands without coordinates. The "No GPS" override lets the installer log
  // without a fix when there's no signal (blank coords stored).
  if(!noGps && (coords.lat==null || coords.lng==null)){ toast('GPS location is required — tap ↻ Refresh, or use “No GPS here?”'); return; }
  if(addrConflictPending){ toast('Choose which address is right first'); return; }

  const num = v => v.trim()==='' ? null : Number(v.trim());
  // OTHER is one button: an Old J# means we saw a meter (VISITED); blank means we
  // couldn't find/confirm one (UNACCOUNTED). Other statuses pass through as-is.
  const otherJ = $('otherOldJ').value.trim();
  const outStatus = status==='OTHER' ? (otherJ ? 'VISITED' : 'UNACCOUNTED') : status;
  const base = {
    token:c.token, action:'addStop', installer:c.name, installerId:c.hNumber,
    timestamp:stamp(), workType:workMode(),
    workOrderId:$('wo').value.trim(), unit:$('unit').value.trim(),
    address:$('addr').value.trim(), lat:coords.lat, lng:coords.lng, status:outStatus,
    notes:$('stopNotes').value.trim(),
    requestedMeter: (status==='INSTALLED'||status==='UTI') && requested
  };
  if(status==='INSTALLED' && noRead){
    const r = $('nrReason').value;
    Object.assign(base, {
      meterRead:null, meterReadReceived:null, newJNumber:$('newJ').value.trim(),
      oldJNumber:$('installOldJ').value.trim(),
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
  if(base.workOrderId) lastLoggedWO = base.workOrderId;   // downtime auto-link fallback
  // Complete the matching planned order, then let plan mode load the next one
  // (planAdvance no-ops when plan mode is off). Chained so the done-mark lands
  // before the next order is picked.
  // Mark the planned order done, advance plan mode, then silently push the whole
  // list so the sheet copy tracks this log (online-only; offline it no-ops).
  markWorklistDone(base.workOrderId).then(() => { planAdvance(); syncWorklist(); });
  toast(
    status==='INSTALLED'  ? (noRead ? 'Install logged · no read ✓' : 'Install logged ✓') :
    status==='UTI'        ? 'UTI logged ✓' :
    outStatus==='VISITED' ? 'Visited logged ✓' :
                            'Unaccounted logged ✓');
  ['read','readRecv','newJ','installOldJ','wo','unit','addr','oldJ','utiOther','nrOther','otherOldJ','stopNotes'].forEach(id => $(id).value='');
  $('utiReason').value=''; $('utiOther').classList.add('hide'); $('utiOtherLabel').classList.add('hide');
  setNoRead(false); setSolar(false); setRequested(false); setNoGps(false);
  // Manual GPS: don't auto-fetch for the next order. Clear the last fix so it
  // can't be silently attached to the next stop — the installer taps ↻ Refresh
  // once they're at the next location.
  coords = { lat:null, lng:null };
  $('locText').textContent = 'Location: not captured yet — tap ↻ Refresh at the stop';
};

// ── mark spot done (GPS only) ───────────────────────────────────────────
// One tap: capture coordinates and log a "meter's already installed here by
// someone else" marker. No work order / read / J#. Status DONE keeps it out of
// the install + UTI counts (it isn't your work), and it feeds the map's
// "already done?" check. Goes through the same offline queue, so no signal is
// fine.
$('markDone').onclick = async () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  if(!navigator.geolocation){ toast('No GPS on this device'); return; }
  toast('Getting location…');
  try {
    const loc = await sampleLocation();
    enqueue({ token:c.token, action:'addStop', installer:c.name,
              timestamp:stamp(), lat:loc.lat, lng:loc.lng, status:'DONE',
              workType:workMode() });
    toast('Marked — already installed ✓');
  } catch {
    toast("Couldn't get GPS — try again");
  }
};

// ── downtime ────────────────────────────────────────────────────────────
// Auto-link: prefill the WO# with the order being worked (the capture form's
// current WO — plan-filled or typed), else the day's most recently logged one.
// Still editable/clearable, and the EOD gap review remains the second pass.
let lastLoggedWO = '';
$('openDowntime').onclick = async () => {
  let wo = $('wo').value.trim() || lastLoggedWO;
  if(!wo){
    const c = cfg();
    if(c.name){
      const cached = await idb.get('dayCache', `${c.name}|${localDate()}`);
      const logged = ((cached && cached.stops) || [])
        .filter(s => String(s.workOrderId||'').trim())
        .sort((a,b) => (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
      if(logged.length) wo = String(logged[logged.length-1].workOrderId).trim();
    }
  }
  $('dtWo').value = wo;
  openSheet('downtimeSheet');
};
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
            timestamp:stamp(), category:$('dtCat').value, workType:workMode(),
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
  // A stored reason that isn't one of the known picks is an "Other" free-text
  // (usually "Other: …") — preselect Other and reveal its box with the text.
  const reasonVal = s.utiReason == null ? '' : String(s.utiReason);
  const reasonIsOther = reasonVal !== '' && !UTI_REASONS.includes(reasonVal);
  const otherText = reasonIsOther ? reasonVal.replace(/^Other:\s*/, '') : '';
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
      <label>UTI reason</label>
      <select class="mono" data-f="utiReason">${utiReasonOptionsHTML(s.utiReason)}</select>
      <label data-f="utiOtherLabel" class="${reasonIsOther?'':'hide'}">What happened?</label>
      <textarea data-f="utiOther" class="${reasonIsOther?'':'hide'}">${esc(otherText)}</textarea>
      <label>Notes</label><textarea data-f="notes">${esc(s.notes)}</textarea>
      <button class="primary sc-save" data-act="save">Save changes</button>
      ${opts && opts.removable ? '<button class="danger sc-remove" data-act="remove">Remove from log…</button>' : ''}
    </div>`;

  if(opts && opts.travel) renderStopTravel(card.querySelector('.sc-travel'), s, pos);

  const editBlock = card.querySelector('.sc-edit');
  const toggleBtn = card.querySelector('[data-act="toggle"]');
  toggleBtn.onclick = () => {
    editBlock.classList.toggle('hide');
    toggleBtn.textContent = editBlock.classList.contains('hide') ? 'Edit' : 'Close';
  };

  // A UTI never installs a new meter, so switching to UTI drops the New J#.
  const statusSel = card.querySelector('[data-f="status"]');
  const newJInput = card.querySelector('[data-f="newJ"]');
  statusSel.onchange = () => { if(statusSel.value === 'UTI') newJInput.value = ''; };

  // "Other" reveals a free-text box (mirrors the main capture form).
  const reasonSel = card.querySelector('[data-f="utiReason"]');
  const otherBox  = card.querySelector('[data-f="utiOther"]');
  const otherLbl  = card.querySelector('[data-f="utiOtherLabel"]');
  reasonSel.onchange = () => {
    const isOther = reasonSel.value === 'Other';
    otherBox.classList.toggle('hide', !isOther);
    otherLbl.classList.toggle('hide', !isOther);
  };

  card.querySelector('[data-act="save"]').onclick = () => {
    const c = cfg();
    if(!c.url || !c.token){ toast('Add your URL first'); return; }
    // A still-pending stop (logged offline, not yet acked) is editable: the
    // queue is FIFO so its addStop reaches the server before this updateStop,
    // and both carry the same client id, so the edit applies to the right row.
    const g = f => card.querySelector(`[data-f="${f}"]`).value.trim();
    const statusVal = g('status');
    // "Other" stores as "Other: <text>", matching the main capture form.
    const reasonPick = g('utiReason');
    const utiReason = reasonPick === 'Other' ? ('Other: ' + g('utiOther')) : reasonPick;
    const payload = {
      token:c.token, action:'updateStop', id:s.id,
      workOrderId:g('wo'), unit:g('unit'), address:g('addr'),
      // A UTI can't carry a New J# — enforce it even if the field wasn't cleared.
      status:statusVal, newJNumber: statusVal==='UTI' ? '' : g('newJ'), oldJNumber:g('oldJ'),
      meterRead: g('read')===''? null : Number(g('read')),
      meterReadReceived: g('readRecv')===''? null : Number(g('readRecv')),
      utiReason, notes:g('notes')
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

  // Remove = move the row to the Sheet's StopsArchive tab (never a hard delete;
  // the back office can restore it from edit.html). Offline-safe: the archive
  // rides the queue like any write, and applyOptimisticCache drops the stop from
  // dayCache + tombstones its id so a server pull can't resurrect it meanwhile.
  // A never-synced stop works too — its queued addStop flushes first (FIFO),
  // then the archive moves it.
  const removeBtn = card.querySelector('[data-act="remove"]');
  if(removeBtn) removeBtn.onclick = async () => {
    const c = cfg();
    if(!c.url || !c.token){ toast('Add your URL first'); return; }
    const label = `WO ${s.workOrderId || '—'} (${clockOf(s.timestamp) || '--:--'}) · ${s.status || ''}`;
    if(!confirm(`Remove this stop from the log?\n\n${label}\n\nIt moves to the archive (not deleted) — the office can restore it.`)) return;
    const reason = prompt('Reason for removal (optional — leave blank to skip):', '');
    if(reason === null) return;                     // Cancel on the prompt aborts too
    // Awaited so the dayCache drop + tombstone are in place before onRemoved re-renders.
    await enqueue({ token:c.token, action:'archiveStop', id:s.id,
                    installerId:c.hNumber, removedBy:c.name, reason:reason.trim() });
    toast(navigator.onLine ? 'Removing…' : 'Removed — will sync when online');
    if(opts && typeof opts.onRemoved === 'function') opts.onRemoved();
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
  // Fresh review → drop any prior day's prefetched high-fidelity summary.
  eodServerSummary = null; eodSummaryJob = null;
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
    start:g.start, end:g.end, idleMin:g.idleMin, toWO:g.toWO||'', toId:g.toId, lead:!!g.lead,
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
  // The land-mode lead gap has no travel to net against — it's just a slot to
  // attribute downtime to the first WO, so it shows the running total, not net.
  const onNet = g.lead
    ? () => { const used = (g.allocations||[]).reduce((s,a)=>s+(Number(a.minutes)||0),0);
        toggle.innerHTML = `${arrow()} Downtime: <b style="color:var(--install)">${used} min</b>`; }
    : () => { const n = gapNet(g);
        toggle.innerHTML = `${arrow()} Travel in: <b style="color:${n.over?'#c0392b':'var(--install)'}">${n.over ? esc(n.text) : (n.net+' min')}</b>`; };
  toggle.onclick = () => { body.classList.toggle('hide'); onNet(); };
  const meta = document.createElement('div'); meta.className = 'sc-meta'; meta.style.marginBottom = '4px';
  meta.textContent = g.lead ? 'First stop · downtime on this WO' : `${g.start}–${g.end} · ${g.idleMin} min gap`;
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
let _eodPersistTimer, _eodPrefetchTimer;
function schedulePersistEod(){
  // Two debounces on purpose: the local IndexedDB stash is cheap and
  // safety-critical (an offline review must survive a reload), so it fires
  // quickly; the server prefetch costs a saveTravel write (which takes the
  // spine's global lock) + a previewDailyLog round-trip, so it waits for a
  // longer lull — with the whole crew editing deductions at quitting time,
  // per-keystroke lock traffic is what melts the spine. Finish still awaits
  // the in-flight build (or falls back to the local summary), so the longer
  // debounce never loses an edit.
  clearTimeout(_eodPersistTimer);
  _eodPersistTimer = setTimeout(() => { persistEodReview(); }, 700);
  clearTimeout(_eodPrefetchTimer);
  _eodPrefetchTimer = setTimeout(() => { prefetchEodSummary(); }, 2000);
}

// ── high-fidelity summary prefetch (so the close PDF is instant) ────────────
// The online daily-log PDF is drawn from the spine's summary (merged-boat travel,
// which the local builder can't reproduce). Building it needs a saveTravel +
// previewDailyLog round-trip, so we run it in the background while the installer
// reviews — by the time they tap Finish it's usually ready. eodServerSummary holds
// the last good result; eodSummaryJob is the in-flight build (for the submit race).
let eodServerSummary = null;   // { key, summary }
let eodSummaryJob = null;      // { key, promise }

// Stable fingerprint of everything the summary depends on — lets us know whether a
// prefetched summary still matches the installer's current edits.
function eodStateKey(){
  return JSON.stringify(collectGapAllocations(eodGaps))
       + '|' + ($('eodDeparture').value||'') + '|' + ($('eodReturned').value||'')
       + '|' + ($('eodNotes').value||'') + '|' + (!!$('eodIncludeDelays').checked);
}

// Best-effort background build of the spine summary for the current edit state.
// Returns the in-flight Promise (or undefined when offline). Dedupes against an
// already-cached or already-running build for the same key. A failure is swallowed
// — the submit path just falls back to the local cache summary.
function prefetchEodSummary(){
  const c = cfg();
  if(!navigator.onLine || !c.name || !c.url || !c.token) return;
  const key = eodStateKey();
  if(eodServerSummary && eodServerSummary.key === key) return;       // already have it
  if(eodSummaryJob && eodSummaryJob.key === key) return eodSummaryJob.promise;  // already building
  const job = { key, promise: (async () => {
    try{
      await withActivity('Preparing daily log…', async () => {
      await flush();
      await apiPost({ action:'saveTravel', installer:c.name, installerId:c.hNumber,
                      allocations: collectGapAllocations(eodGaps) });
      const d = await apiPost({ action:'previewDailyLog', installer:c.name, installerId:c.hNumber,
                                includeDelays:$('eodIncludeDelays').checked, workType:workMode() });
      // Only adopt the result if a newer edit hasn't superseded this build, so a
      // slow stale job can't clobber a fresher summary.
      if(d && d.summary && eodSummaryJob === job) eodServerSummary = { key, summary:d.summary };
      });
    } catch {/* fall back to cache at submit */}
    finally { if(eodSummaryJob === job) eodSummaryJob = null; }  // only clear if still current
  })() };
  eodSummaryJob = job;
  return job.promise;
}

// Build the daily-log summary from the phone's cached day (stops + downtime +
// bookends + boatMeta) — the offline source the PDF renderer draws from. Online
// we prefer the spine's higher-fidelity summary (merged-boat travel); this is the
// no-signal fallback.
async function buildSummaryFromCache(includeDelays, weather){
  const c = cfg();
  const key = `${c.name}|${localDate()}`;
  const cached = (await idb.get('dayCache', key)) || { stops:[], downtime:[], day:{}, boatMeta:null };
  const cd = cached.day || {};
  return buildLocalSummary({
    installer:c.name, installerId:c.hNumber, date:localDate(),
    stops:cached.stops||[], downtime:cached.downtime||[],
    day:{ departure: $('eodDeparture').value || cd.departure || '',
          returned:  $('eodReturned').value  || cd.returned  || '' },
    boatMeta:cached.boatMeta,
    includeDelays, weather:weather||'', notes:$('eodNotes').value.trim(),
    workType:workMode(),
    pendingTravel: collectGapAllocations(eodGaps)
  });
}

// ── cached day loader (stale-while-revalidate) ─────────────────────────────
// Merge a fresh server list with locally-pending entries. The server is
// authoritative for anything it already knows about (matched by id); any cached
// row still flagged _tempId (logged on the phone, not yet acked) is overlaid so
// a refresh never drops un-synced work. Once a row syncs, reconcileCache clears
// its _tempId and the server copy naturally wins. Rows whose id is tombstoned
// (removed locally, archiveStop still queued) are dropped — the server hasn't
// heard about the removal yet, so its copy must not resurrect the stop.
// Mirrors mergePendingRows in daycache.js.
function mergePending(serverArr, cachedArr, removedIds){
  const dead = new Set((removedIds || []).map(String));
  const out = (serverArr || []).filter(r => !dead.has(String(r.id)));
  const ids = new Set(out.map(r => String(r.id)));
  (cachedArr || []).forEach(r => { if(r._tempId && !ids.has(String(r.id)) && !dead.has(String(r.id))) out.push(r); });
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
    const localGaps = mode==='eod' ? computeGapsLocal(cached.stops||[], cached.downtime||[], cached.eodTravel, workMode()==='land') : [];
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
    // Fire `idle` alongside `day` (not after it) — the EOD open used to pay the
    // two round-trips back to back. The day render lands first with local gaps;
    // the authoritative `idle` gaps re-render when they arrive.
    const idleP = mode==='eod'
      ? apiGet('idle', { installerId:c.hNumber, installer:c.name, workType:workMode() }).catch(() => null)
      : null;
    const d = await apiGet('day', { installer:c.name, installerId:c.hNumber });
    // Re-read the cache (an enqueue may have run since the top of this fn) and
    // merge, so locally-pending stops/downtime survive the server pull.
    const local = await idb.get('dayCache', key);
    const stops    = mergePending(d.stops,    local && local.stops, local && local.removedIds);
    const downtime = mergePending(d.downtime, local && local.downtime);
    const pendingTravel = local && local.eodTravel;   // offline review not yet synced
    await idb.put('dayCache', {
      stops, downtime,
      day:d.day||{}, boatMeta: d.boatMeta || (local && local.boatMeta) || null,
      closed:!!d.closed, cachedAt:stamp(),
      eodTravel: pendingTravel,  // preserved so a brief reconnect can't wipe an un-synced review
      removedIds: (local && local.removedIds) || []   // tombstones live until the archive syncs
    }, key);
    // Local gaps render instantly; the authoritative `idle` overrides them when it lands.
    let gaps = mode==='eod' ? computeGapsLocal(stops, downtime, pendingTravel, workMode()==='land') : [];
    if(mode==='eod'){
      const idata = await idleP;
      if(idata && idata.gaps) gaps = idata.gaps;
    }
    renderDayData(mode, stops, downtime, d.day||{}, gaps);
    // Gaps/bookends are now authoritative — start building the high-fidelity
    // close summary in the background so the Finish PDF is instant.
    if(mode==='eod') prefetchEodSummary();
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
  const ordered = editable.slice().sort((a,b)=> (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
  const posById = {}; ordered.forEach((s,i)=> posById[s.id]=i+1);
  ordered.forEach(s => list.appendChild(makeStopCard(s, null, { pos: posById[s.id], travel: true })));
}

let eodData = { stops:[], downtime:[] };   // stash for weather + PDF

// Hand the day's close writes (travel deductions + bookends + endOfDay) to the
// offline queue. All three are idempotent and the queue now drains via flush()
// regardless of navigator.onLine, so this is the safe fallback whenever an
// online close can't be confirmed — the Sheet catches up on the next trigger
// instead of the close being silently dropped. Used by the offline Finish path
// and by the online path when a live close throws or returns not-ok.
function queueClose(c, weather){
  enqueue({ token:c.token, action:'saveTravel', installer:c.name, installerId:c.hNumber,
            allocations: collectGapAllocations(eodGaps) });
  if($('eodDeparture').value || $('eodReturned').value)
    enqueue({ token:c.token, action:'saveDay', installer:c.name,
              departure:$('eodDeparture').value, returned:$('eodReturned').value });
  enqueue({ token:c.token, action:'endOfDay', installer:c.name, installerId:c.hNumber,
            notes:$('eodNotes').value.trim(), includeDelays:$('eodIncludeDelays').checked,
            workType:workMode(), weather:weather||'',
            departure:$('eodDeparture').value, returned:$('eodReturned').value });
}

$('finishDay').onclick = async () => {
  const c = cfg();
  const btn = $('finishDay');
  // Storage-first: never lose the travel/downtime review or the bookend times.
  await persistEodReview();

  // No signal → render the PDF on the phone from the cached day and queue the
  // close (travel deductions + bookends + endOfDay) so the Sheet catches up when
  // online. The PDF no longer needs a connection.
  if(!navigator.onLine){
    // Queue the close (idempotent on date+installer) so the Tracker/Timing rows
    // get written once the queue drains — weather backfills on the re-send.
    queueClose(c, '');
    try{ await withActivity('Generating PDF…',
      async () => downloadDailyLog(await buildSummaryFromCache($('eodIncludeDelays').checked, ''))); }catch{}
    closeSheets();
    toast('Day closed offline ✓ · PDF downloaded — will sync when online');
    return;
  }

  btn.classList.add('loading'); btn.disabled = true;
  let synced = false, weather = '';   // visible to the outer catch so it can fall back too
  try{
    // 1. Get the PDF out instantly. Prefer the high-fidelity summary the review
    // already prefetched (merged-boat travel); if it isn't ready for the current
    // edits yet, wait up to 5s; only then fall back to the local cache summary.
    const stateKey = eodStateKey();
    let summary = null;
    const fromServer = await withActivity('Generating PDF…', async () => {
      if(eodServerSummary && eodServerSummary.key === stateKey){
        summary = eodServerSummary.summary;
      } else {
        const job = prefetchEodSummary();
        if(job) await Promise.race([ job, new Promise(r => setTimeout(r, 5000)) ]);
        if(eodServerSummary && eodServerSummary.key === stateKey) summary = eodServerSummary.summary;
      }
      const server = !!summary;
      if(!summary) summary = await buildSummaryFromCache($('eodIncludeDelays').checked, '');
      await downloadDailyLog(summary);
      return server;
    });
    closeSheets();
    toast('Day closed ✓ · PDF downloaded');

    // 2. Finalize the close on the Sheet (the PDF is already delivered). Weather is
    // recorded on the Sheet but intentionally left off the instant PDF.
    const withCoord = (eodData.stops||[]).find(s =>
      s.lat!=null && s.lng!=null && !isNaN(Number(s.lat)) && !isNaN(Number(s.lng)));
    if (withCoord) weather = await fetchWeather(Number(withCoord.lat), Number(withCoord.lng));
    await flush();
    // Attempt the close live (instant confirmation + weather); on ANY failure — a
    // thrown non-JSON/timeout response OR a server {ok:false} — hand the exact
    // writes to the offline queue, which now drains regardless of navigator.onLine.
    // The old bare toast promised a retry it never queued, so a flaky phone
    // response could silently drop the close.
    try{
      // The prefetch already saved these allocations when its summary matched;
      // otherwise write them now so endOfDay tallies the subtracted travel.
      if(!fromServer){
        const rt = await apiPost({ action:'saveTravel', installer:c.name, installerId:c.hNumber,
                                   allocations: collectGapAllocations(eodGaps) });
        if(!rt || !rt.ok) throw new Error('saveTravel not ok');
      }
      const re = await apiPost({ action:'endOfDay', installer:c.name, installerId:c.hNumber,
                                 notes:$('eodNotes').value.trim(), weather,
                                 includeDelays:$('eodIncludeDelays').checked, workType:workMode(),
                                 departure:$('eodDeparture').value, returned:$('eodReturned').value });
      if(!re || !re.ok) throw new Error('endOfDay not ok');
      synced = true;
    } catch { queueClose(c, weather); }
    if(synced){
      // The review reached the Sheet — drop the local pending copy so the next load
      // reads the authoritative gap rows back. If it didn't sync, keep it: the
      // queued endOfDay still carries the review and a re-open can re-check.
      const key = `${c.name}|${localDate()}`;
      const cc = await idb.get('dayCache', key);
      if(cc && cc.eodTravel){ delete cc.eodTravel; await idb.put('dayCache', cc, key); }
    }
    if(!synced) toast('Day closed · finishing sync in background');
  } catch {
    if(!synced){ queueClose(c, weather); toast('Day closed · finishing sync in background'); }
  }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
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
// ── generate a draft daily log WITHOUT closing the day ─────────────────────
// Renders + downloads the PDF on the phone from today's stops only. Writes nothing
// (no Tracker row); weather stays blank — the real End of day fills it. Online we
// use the spine's summary (merged-boat travel); offline we build it from cache.
$('genLog').onclick = async () => {
  const c = cfg();
  if(!c.name){ openSheet('settingsSheet'); toast('Add your name first'); return; }
  const btn = $('genLog');
  toast('Building daily log…');
  btn.classList.add('loading'); btn.disabled = true;
  try{
    await withActivity('Generating daily log…', async () => {
      let summary = null;
      if(navigator.onLine){
        await flush();
        try{
          const d = await apiPost({ action:'previewDailyLog', installer:c.name, installerId:c.hNumber,
                                    includeDelays:$('eodIncludeDelays').checked, workType:workMode() });
          summary = d.summary || null;
        } catch {}
      }
      if(!summary) summary = await buildSummaryFromCache($('eodIncludeDelays').checked, '');
      if(summary && (summary.stops||[]).some(s => s.status==='INSTALLED' || s.status==='UTI')){
        await downloadDailyLog(summary);
        toast('Daily log downloaded — draft (day not closed)');
      } else {
        toast('No stops logged today yet');
      }
    });
  } catch { toast('Could not build the daily log'); }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
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
      box.appendChild(makeStopCard(s, () => renderToday(stops, downtime), {
        removable:true,
        // Re-render from the (already updated) dayCache so the row vanishes
        // immediately, online or offline.
        onRemoved: () => { box.innerHTML=''; loadDay('today'); }
      }));
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
  // Cache-first: paint whatever's stored immediately, then refresh from the
  // Sheet in the background and repaint — opening the sheet never waits on the
  // `range` round-trip.
  await renderRecent();
  if(navigator.onLine) cacheRecentDays(7).then(renderRecent).catch(()=>{});
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
    .sort((a,b)=> (parseLocalMs(a.timestamp)||0) - (parseLocalMs(b.timestamp)||0));
  if(!editable.length){
    const p=document.createElement('p'); p.className='muted'; p.textContent='Nothing logged this day.';
    box.appendChild(p); return;
  }
  editable.forEach(s => box.appendChild(makeStopCard(s, () => renderRecentDay(d))));
  box.scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── settings + sheets plumbing ──────────────────────────────────────────────
// Sub foreman in Settings: a team's subName is authoritative (shown locked);
// an un-teamed installer picks their own, saved to their Employees row via the
// same queued saveEmployee. Last-known state cached in localStorage (subName /
// subLocked / subsList) so the sheet paints offline; roster refetched every
// online open so a later team assignment re-locks it.
let subEditable = false;
function paintSubField(){
  const sel = $('cfgSub'), hint = $('cfgSubHint');
  const sub = store.get('subName')||'', locked = store.get('subLocked')==='1';
  let subs = [];
  try { subs = JSON.parse(store.get('subsList')||'[]'); } catch(e){}
  if (sub && subs.indexOf(sub) < 0) subs.unshift(sub);
  sel.innerHTML = '<option value="">— pick your sub —</option>' +
    subs.map(s => `<option value="${attr(s)}"${s===sub?' selected':''}>${esc(s)}</option>`).join('');
  if (locked) {
    sel.disabled = true; subEditable = false;
    hint.textContent = 'Assigned with your crew — change it in Crew & Teams.';
  } else if (!subs.length && !navigator.onLine) {
    sel.disabled = true; subEditable = false;
    hint.textContent = 'Connect once to load the sub list.';
  } else {
    sel.disabled = false; subEditable = true;
    hint.textContent = '';
  }
}
async function loadSubInfo(){
  paintSubField();                       // last-known state, works offline
  if (!navigator.onLine) return;
  try {
    const d = await apiGet('roster');
    if (!d || !d.ok) return;
    const h = String(store.get('hNumber')||'').trim();
    const team = h ? (d.teams||[]).find(t => t.memberLetters && (h in t.memberLetters)) : null;
    const emp  = h ? (d.employees||[]).find(e => e.hNumber === h) : null;
    if (team && team.subName) {
      store.set('subName', team.subName); store.set('subLocked', '1');
    } else {
      store.set('subLocked', '');
      // Prefer the server's copy so a pick made on another device shows here.
      if (emp && emp.subName != null && emp.subName !== '') store.set('subName', emp.subName);
    }
    store.set('subsList', JSON.stringify(d.subs||[]));
    paintSubField();
  } catch(e){ /* offline blip — cached paint stands */ }
}
function openSheet(id){
  if(id==='settingsSheet'){
    $('cfgFirst').value = store.get('firstName')||'';
    $('cfgLast').value  = store.get('lastName')||'';
    $('cfgH').value     = store.get('hNumber')||'';
    $('cfgHome').value  = store.get('homeAddress')||'';
    paintHomeHint();
    loadSubInfo();
  }
  $(id).classList.remove('hide');
}

// The home-address hint doubles as pin feedback: it shows the geocoder's
// matched label so a wrong-town home is visible right in Settings.
function paintHomeHint(){
  const el = $('cfgHomeHint'); if(!el) return;
  const addr = store.get('homeAddress'), lbl = store.get('homeLabel');
  el.textContent = addr && lbl ? 'Home pin set ✓ — ' + lbl
    : addr ? 'Home not pinned yet — it’ll be looked up when you’re online'
    : 'With a home set, Optimize route ends your day heading toward home.';
}
function closeSheets(){ document.querySelectorAll('.sheet').forEach(s=>s.classList.add('hide')); }
document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if(e.target===s) closeSheets(); }));

// ── nav dropdown ──────────────────────────────────────────────────────────────
$('navBtn').onclick = e => { e.stopPropagation(); $('navMenu').classList.toggle('hide'); };
document.addEventListener('click', () => { const m=$('navMenu'); if(m) m.classList.add('hide'); });
$('navWorklist').onclick = () => { $('navMenu').classList.add('hide'); openWorklist(); };
$('navRecent').onclick    = () => { $('navMenu').classList.add('hide'); openRecent(); };
$('navSettings').onclick  = () => { $('navMenu').classList.add('hide'); openSheet('settingsSheet'); };
$('navHelp').onclick      = () => { window.location.href = 'help.html'; };

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
  const payload = { token:c.token, action:'saveEmployee', hNumber:h, firstName:first, lastName:last };
  // Only ride subName when the pick was actually editable — a locked (team) or
  // never-loaded select must not clobber the server's copy.
  if (subEditable) {
    const sub = $('cfgSub').value.trim();
    store.set('subName', sub);
    payload.subName = sub;
    // In land mode, picking a sub also joins that sub's crew server-side
    // (joinLandCrewBySub). workType tells the spine which mode this save is for.
    payload.workType = workMode();
  }
  // Home address (optional, this device only) — pin it now so Optimize route
  // can end the day heading toward home. Saved offline (or a miss): the text
  // is kept and the worklist screen re-tries the lookup at optimize time.
  const homeAddr = $('cfgHome').value.trim();
  if (homeAddr !== (store.get('homeAddress') || '')) {
    store.set('homeAddress', homeAddr);
    store.set('homeLat', ''); store.set('homeLng', ''); store.set('homeLabel', '');
    if (homeAddr && navigator.onLine) {
      geocodeOne(homeAddr, null).then(hit => {
        if (hit && !hit.ambig) {
          store.set('homeLat', String(hit.lat)); store.set('homeLng', String(hit.lng));
          store.set('homeLabel', hit.label || homeAddr);
          toast('Home pin set ✓');
        } else {
          toast(hit ? 'Home matches several places — add the town to the address'
                    : 'Couldn’t place home — routes will start at your first order');
        }
        paintHomeHint();
      });
    }
  }
  enqueue(payload);
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
