// Drive mode — the single-card driving screen (#drive), reachable only from the
// worklist. It shows the current pending order and hands off to Google Maps; in
// the background it silently records the driving leg (see js/drive-track.js) and
// uploads it via the offline queue for the office to replay. The driver is shown
// none of the tracking numbers — only a "location on/off" chip, which the per-day
// toggle here controls (the driver can opt out; it re-arms every new day).
//
// worklist.js owns the worklist data and calls initDrive() once, handing in a
// pending-orders accessor and the shared openDirections() — this module never
// imports worklist.js back (that would be circular), exactly like the route view.
import { $, esc, toast } from './dom.js';
import { cfg, store } from './store.js';
import { localDate, localDateOffset } from './time.js';
import { idb } from './idb.js';
import { enqueue } from './queue.js';
import {
  createSegment, addFix, markPause, markResume, finalizeSegment,
  isWorthUploading, MAX_POINTS,
} from './drive-track.js';

const segId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// ── per-day tracking opt-out ────────────────────────────────────────────────
// Stored stamped with the day it was set; a stamp from an earlier day reads as
// ON, so opting out is a per-day choice that re-arms every morning.
function trackingOn(){
  let s = null;
  try { s = JSON.parse(store.get('driveTrack') || 'null'); } catch { s = null; }
  if(!s || s.date !== localDate()) return true;
  return s.on !== false;
}
function setTracking(on){ store.set('driveTrack', JSON.stringify({ on, date: localDate() })); }
// Keep-screen-awake is a device preference (persists across days), default off.
function wakeOn(){ return store.get('driveWake') === '1'; }

export function initDrive(opts){
  let openState = false;
  let pending = [];
  let idx = 0;                 // local DISPLAY pointer — never touches order status
  let seg = null;             // the active leg, or null when not tracking
  let watchId = null;
  let wakeLock = null;
  let resumePending = false;  // the next fix closes a background gap

  const screen = $('driveScreen');

  // ── wake lock ──
  async function requestWake(){
    if(!wakeOn() || wakeLock || !navigator.wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  function releaseWake(){ try { wakeLock?.release(); } catch {} wakeLock = null; }

  // ── tracking runtime ──
  function checkpoint(){
    // Persist progress so a reload/crash mid-leg isn't lost — recoverStale()
    // ships any leg left `active` on the next open. saveDriveTrack is idempotent
    // on the segment id, so a recovered-then-also-finalized leg can't double.
    if(!seg) return;
    idb.put('driveTracks', { ...finalizeSegment(seg), active: true });
  }

  async function finalizeAndEnqueue(s){
    if(!isWorthUploading(s)){ await idb.del('driveTracks', s.id); return; }
    const row = finalizeSegment(s);
    await idb.put('driveTracks', { ...row, active: false });
    const c = cfg();
    await enqueue({ token: c.token, action: 'saveDriveTrack', ...row });
  }

  function startSegment(){
    const c = cfg();
    seg = createSegment({
      id: segId(), installer: c.name || '', date: localDate(),
      workType: store.get('workMode') === 'land' ? 'land' : '',
    });
  }

  function onFix(p){
    if(!seg) return;
    const fix = {
      lat: p.coords.latitude, lng: p.coords.longitude,
      t: p.timestamp || Date.now(),
      spd: (typeof p.coords.speed === 'number' && p.coords.speed >= 0) ? p.coords.speed : undefined,
    };
    // Roll to a fresh leg before a single row could approach the Sheet cell limit.
    if(seg.points.length >= MAX_POINTS){ const done = seg; startSegment(); finalizeAndEnqueue(done); }
    if(resumePending){ markResume(seg, fix); resumePending = false; }
    else addFix(seg, fix);
    checkpoint();
  }
  function onErr(){ /* a denied/timed-out fix just means no point this tick */ }

  function startTracking(){
    if(seg || !trackingOn()){ paintIndicator(); return; }
    startSegment();
    if(navigator.geolocation){
      watchId = navigator.geolocation.watchPosition(onFix, onErr,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
    requestWake();
    paintIndicator();
  }

  async function stopTracking(){
    if(watchId != null && navigator.geolocation){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    releaseWake();
    if(seg){ const done = seg; seg = null; await finalizeAndEnqueue(done); }
    paintIndicator();
  }

  // The page went to the background (screen lock, or a Google-Maps hand-off): the
  // OS suspends GPS anyway, so bracket the gap on the last known point and mark
  // the next fix a resume. This is what turns a tracking gap into two anchors the
  // desktop planner can road-route between.
  function onVisibility(){
    if(!seg) return;
    if(document.visibilityState === 'hidden'){ markPause(seg); releaseWake(); checkpoint(); }
    else { resumePending = true; requestWake(); }
  }

  // Recover any leg a prior session left un-finalized, and prune old local legs.
  async function recoverStale(){
    const all = (await idb.all('driveTracks')) || [];
    const cutoff = localDateOffset(-8);
    for(const r of all){
      if(r.active){
        const { active, ...row } = r;
        if((row.pointCount || 0) >= 2){
          const c = cfg();
          await enqueue({ token: c.token, action: 'saveDriveTrack', ...row });
        }
        await idb.put('driveTracks', { ...r, active: false });
      } else if(r.date && r.date < cutoff){
        await idb.del('driveTracks', r.id);
      }
    }
  }

  // ── card + display pointer ──
  function paintIndicator(){
    const el = $('driveIndicator');
    if(!el) return;
    const on = trackingOn();
    el.textContent = on ? '🛰 Location on' : 'Location off';
    el.classList.toggle('off', !on);
    const t = $('driveTrackToggle');
    if(t) t.checked = on;
    const w = $('driveWakeToggle');
    if(w) w.checked = wakeOn();
  }

  function renderCard(){
    const card = $('driveCard');
    const empty = $('driveEmpty');
    const pos = $('drivePos');
    if(!pending.length){
      card.classList.add('hide');
      empty.classList.remove('hide');
      pos.textContent = '';
      $('driveNav').disabled = true;
      $('drivePrev').disabled = $('driveNext').disabled = true;
      return;
    }
    empty.classList.add('hide');
    card.classList.remove('hide');
    const item = pending[idx];
    pos.textContent = `${idx + 1} of ${pending.length}`;
    const addr = [item.unit, item.address].filter(Boolean).join(' ').trim();
    card.innerHTML = `
      <div class="drive-wo mono">${item.workOrderId ? esc(item.workOrderId) : '(no WO#)'}</div>
      <div class="drive-addr">${addr ? esc(addr) : 'No address'}</div>
      ${item.oldJNumber ? `<div class="drive-oldj mono">Old J# ${esc(item.oldJNumber)}</div>` : ''}
      ${item.appointmentTime ? `<div class="drive-appt">🔔 ${esc(item.appointmentDate || '')} ${esc(item.appointmentTime)}</div>` : ''}`;
    $('driveNav').disabled = !addr && !(item.lat && item.lng);
    $('drivePrev').disabled = idx <= 0;
    $('driveNext').disabled = idx >= pending.length - 1;
  }

  async function refresh(){
    pending = await opts.getPending();
    if(idx >= pending.length) idx = Math.max(0, pending.length - 1);
    renderCard();
  }

  // ── open / close / teardown ──
  async function open(){
    openState = true;
    idx = 0;
    screen.classList.remove('hide');
    await recoverStale();
    await refresh();
    startTracking();
    window.scrollTo(0, 0);
    $('driveBack').focus();
  }
  async function close(){
    openState = false;
    screen.classList.add('hide');
    await stopTracking();
  }
  // The end-of-day safety net (called from capture.js): stop GPS and leave the
  // screen no matter what — "close and end your day → tracking off".
  async function teardown(){
    await stopTracking();
    if(openState){ openState = false; screen.classList.add('hide'); }
    if(location.hash === '#drive') history.back();
  }

  // ── wiring ──
  $('driveBack').onclick = () => opts.onClose();
  $('drivePrev').onclick = () => { if(idx > 0){ idx--; renderCard(); } };
  $('driveNext').onclick = () => { if(idx < pending.length - 1){ idx++; renderCard(); } };
  $('driveNav').onclick = () => {
    const item = pending[idx];
    if(!item) return;
    // Advance the display to the next order BEFORE handing off to Maps, so the
    // next card is already showing when the driver switches back. Navigation
    // still goes to the order that was pressed, not the newly shown one. Like
    // Advance/Back, this only moves the pointer — it changes no order's status.
    if(idx < pending.length - 1){ idx++; renderCard(); }
    opts.openDirections(item);
  };
  $('driveTrackToggle').onchange = async e => {
    setTracking(e.target.checked);
    if(!openState){ paintIndicator(); return; }
    if(e.target.checked) startTracking(); else await stopTracking();
    paintIndicator();
  };
  $('driveWakeToggle').onchange = e => {
    store.set('driveWake', e.target.checked ? '1' : '0');
    if(e.target.checked) requestWake(); else releaseWake();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Best-effort finalize on a real unload; a checkpoint has already persisted the
  // leg, so recoverStale() ships it next open even if this can't finish.
  window.addEventListener('pagehide', () => { stopTracking(); });

  return { open, close, teardown, refresh, isOpen: () => openState };
}
