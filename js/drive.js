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
import {
  startRecording, stopRecording, isRecording, wakePref, setWakePref, subscribe,
} from './drive-recorder.js';

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
  // Opening/closing the screen no longer starts/stops GPS — the app-level
  // recorder keeps running when you leave the screen. close()/teardown() just
  // hide the screen.
  async function open(){
    openState = true;
    idx = 0;
    screen.classList.remove('hide');
    if(!unsub) unsub = subscribe(paintIndicator);
    await refresh();
    paintIndicator();
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
    // Advance the display to the next order BEFORE handing off to Maps, so the
    // next card is already showing when the driver switches back. Navigation
    // still goes to the order that was pressed, not the newly shown one. Like
    // Advance/Back, this only moves the pointer — it changes no order's status.
    if(idx < pending.length - 1){ idx++; renderCard(); }
    opts.openDirections(item);
  };
  $('driveTrackBtn').onclick = async () => {
    if(isRecording()) await stopRecording();
    else startRecording();
    paintIndicator();
  };
  $('driveWakeToggle').onchange = e => { setWakePref(e.target.checked); };

  return { open, close, teardown, refresh, isOpen: () => openState };
}
