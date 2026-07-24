// Drive mode — the single-card driving screen (#drive), reachable only from the
// worklist. It shows the current pending order and hands off to Google Maps. The
// GPS leg is no longer recorded by this screen: the recorder is app-level now
// (js/drive-recorder.js) and runs whenever the capture PWA is open. This screen
// just owns the driver-facing card + the "Start/Stop drive tracking" button that
// arms this phone as the day's recorder (see js/drive-recorder.js for why that
// opt-in gate is per-device — it prevents two phones double-recording a drive).
//
// worklist.js owns the worklist data and calls initDrive() once, handing in a
// pending-orders accessor and the shared openDirections() — this module never
// imports worklist.js back (that would be circular), exactly like the route view.
import { $, esc } from './dom.js';
import { store } from './store.js';
import {
  startRecording, stopRecording, isRecording, wakePref, setWakePref, subscribe,
  liveMetrics, showMetricsPref,
} from './drive-recorder.js';

// The locked "Driving to" destination — the last order Navigate was pressed on.
// Persisted (trivial replaceable config, not durable data) so the top card
// survives a reload or a trip back to the worklist and back.
const DEST_KEY = 'driveDest';
const saveDest = item => store.set(DEST_KEY, JSON.stringify(item));
const clearDest = () => store.set(DEST_KEY, '');
const loadDest = () => {
  try { const raw = store.get(DEST_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
};
// Address string shown on both cards + copied by the Maps hand-off — unit + street.
const addrOf = item => [item.unit, item.address].filter(Boolean).join(' ').trim();
// Match a saved dest to a pending order: WO# when present, else the address.
const destKey = item => item.workOrderId || addrOf(item);

// Driver-facing units: metric (km / km/h), matching the office map. Metres→km
// and m/s→km/h.
const KM_PER_M = 1 / 1000;
const KMH_PER_MS = 3.6;
// Idle time with unit labels — "34m 12s", or "1h 05m 30s" once it passes an hour.
const fmtIdle = min => {
  const total = Math.max(0, Math.round(min * 60)); // seconds
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if(h) parts.push(h + 'h');
  parts.push((h ? String(m).padStart(2, '0') : m) + 'm');
  parts.push(String(s).padStart(2, '0') + 's');
  return parts.join(' ');
};

export function initDrive(opts){
  let openState = false;
  let pending = [];
  let idx = 0;                 // local DISPLAY pointer — never touches order status
  let unsub = null;

  const screen = $('driveScreen');

  // ── recording indicator + controls ──
  function paintIndicator(){
    const on = isRecording();
    const el = $('driveIndicator');
    if(el){
      el.textContent = on ? '🛰 Recording' : 'Location off';
      el.classList.toggle('off', !on);
    }
    const btn = $('driveTrackBtn');
    if(btn){
      btn.textContent = on ? '■ Stop drive tracking' : '▶ Start drive tracking';
      btn.classList.toggle('recording', on);
    }
    const w = $('driveWakeToggle');
    if(w) w.checked = wakePref();
  }

  // ── optional driving-stats HUD (off unless the #tuning toggle is on) ──
  // Shown only while this phone is actively recording; the numbers are
  // foreground-tracked, so they undercount whenever the app was backgrounded
  // (Google-Maps hand-off) — the card carries a note saying so.
  function paintMetrics(){
    const el = $('driveMetrics');
    if(!el) return;
    const show = showMetricsPref() && isRecording();
    el.classList.toggle('hide', !show);
    if(!show) return;
    const m = liveMetrics();
    $('dmNow').textContent = Math.round(m.currentSpeed * KMH_PER_MS);
    $('dmDistance').textContent = (m.distanceM * KM_PER_M).toFixed(1);
    $('dmAvg').textContent = Math.round(m.avgMovingSpeed * KMH_PER_MS);
    $('dmIdle').textContent = fmtIdle(m.idleMin);
    $('dmMax').textContent = Math.round(m.maxSpeed * KMH_PER_MS);
  }

  // ── locked "Driving to" card (top of screen) ──
  // Shows the destination the driver last pressed Navigate on, so they always
  // know where they're headed even after the stepper has advanced or they've
  // stepped back to the worklist. Hidden until the first Navigate.
  function renderDest(){
    const el = $('driveDest');
    if(!el) return;
    const d = loadDest();
    if(!d){ el.classList.add('hide'); return; }
    $('driveDestWo').textContent = d.workOrderId ? d.workOrderId : '(no WO#)';
    $('driveDestAddr').textContent = addrOf(d) || 'No address';
    el.classList.remove('hide');
  }

  // One repaint entry point for the recorder's subscribe() — indicator + HUD + dest.
  function paintAll(){ paintIndicator(); paintMetrics(); renderDest(); }

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
    const addr = addrOf(item);
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
    // Clear the locked destination once its order is no longer pending (logged or
    // archived) — don't keep telling the driver to drive somewhere they finished.
    const d = loadDest();
    if(d && !pending.some(p => destKey(p) === destKey(d))) clearDest();
    renderCard();
    renderDest();
  }

  // ── open / close / teardown ──
  // Opening/closing the screen no longer starts/stops GPS — the app-level
  // recorder keeps running when you leave the screen. close()/teardown() just
  // hide the screen.
  async function open(){
    openState = true;
    idx = 0;
    screen.classList.remove('hide');
    if(!unsub) unsub = subscribe(paintAll);
    await refresh();
    paintAll();
    window.scrollTo(0, 0);
    $('driveBack').focus();
  }
  async function close(){
    openState = false;
    screen.classList.add('hide');
  }
  async function teardown(){
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
    // Lock this order into the top "Driving to" card before we advance — that
    // card holds the destination now, so it's safe for the stepper to move on.
    saveDest(item);
    renderDest();
    // Advance the display to the next order BEFORE handing off to Maps, so the
    // next card is already showing when the driver switches back. Navigation
    // still goes to the order that was pressed, not the newly shown one. Like
    // Advance/Back, this only moves the pointer — it changes no order's status.
    if(idx < pending.length - 1){ idx++; renderCard(); }
    opts.openDirections(item);
  };
  // Tap the locked card to re-open Maps to that same destination.
  $('driveDest').onclick = () => { const d = loadDest(); if(d) opts.openDirections(d); };
  $('driveTrackBtn').onclick = async () => {
    if(isRecording()) await stopRecording();
    else startRecording();
    paintAll();
  };
  $('driveWakeToggle').onchange = e => { setWakePref(e.target.checked); };

  return { open, close, teardown, refresh, isOpen: () => openState };
}
