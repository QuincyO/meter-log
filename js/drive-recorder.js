// Drive recorder — the app-level GPS leg recorder. Lifted out of the Drive
// screen (js/drive.js) so it records the driving leg **whenever the capture PWA
// is open**, on any screen, not just while #drive is in front. It is an
// app-level singleton: capture.js calls initDriveRecorder() once on load, the
// Drive screen's Start/Stop button arms/disarms it, and finishDay uploads the
// day's legs.
//
// Recording is **opt-in per day, per device**: OFF every morning until the
// driver taps "Start drive tracking" in Drive mode. Only the phone that taps
// Start becomes that day's recorder, so a crew running the app on two phones
// (work phone for capture — which uses plan mode — and a personal phone for
// planning + CarPlay navigation) never double-records the same drive.
//
// Uploads are deferred to end of day: legs accumulate in the IndexedDB
// `driveTracks` store all day (each carrying `queued:false`) and are enqueued
// only by finishAndUpload(). The one exception is the safety net in
// recoverStale(): a leftover leg from a *previous* un-closed day ships on the
// next app open so the office never loses it.
//
// The pure track model (segment state machine + polyline encode) lives in
// js/drive-track.js and is unchanged.
import { store, cfg } from './store.js';
import { localDate, localDateOffset } from './time.js';
import { idb } from './idb.js';
import { enqueue } from './queue.js';
import {
  createSegment, addFix, markPause, markResume, finalizeSegment,
  isWorthUploading, MAX_POINTS,
} from './drive-track.js';

const segId = () => Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// ── per-day arm state (opt-IN; absent/stale date reads as OFF) ───────────────
function recordState(){
  let s = null;
  try { s = JSON.parse(store.get('driveRecord') || 'null'); } catch { s = null; }
  if(!s || s.date !== localDate()) return { armed: false, on: false };
  return { armed: true, on: s.on === true };
}
function setRecord(on){ store.set('driveRecord', JSON.stringify({ on, date: localDate() })); }

// Keep-screen-awake is a device preference (persists across days), default off.
export function wakePref(){ return store.get('driveWake') === '1'; }

// ── module singleton state ──────────────────────────────────────────────────
let started = false;        // initDriveRecorder() ran once
let seg = null;             // the active leg, or null when not tracking
let watchId = null;
let wakeLock = null;
let resumePending = false;   // the next fix closes a background gap
const listeners = new Set();

function notify(){ for(const cb of listeners) { try { cb(); } catch {} } }
export function subscribe(cb){ listeners.add(cb); return () => listeners.delete(cb); }

// Public state readers for the chip + Drive-screen button.
export function armedToday(){ return recordState().armed; }
export function isRecording(){ return recordState().on; }

// ── wake lock ──
async function requestWake(){
  if(!wakePref() || wakeLock || !navigator.wakeLock || !seg) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
function releaseWake(){ try { wakeLock?.release(); } catch {} wakeLock = null; }
export function setWakePref(on){
  store.set('driveWake', on ? '1' : '0');
  if(on) requestWake(); else releaseWake();
}

// ── leg persistence ──
function startSegment(){
  const c = cfg();
  seg = createSegment({
    id: segId(), installer: c.name || '', date: localDate(),
    workType: store.get('workMode') === 'land' ? 'land' : '',
  });
}

function checkpoint(){
  // Persist progress so a reload/crash mid-leg isn't lost — recoverStale()
  // finalizes any leg left `active` on the next open, then either ships it (a
  // previous day) or holds it for finishAndUpload() (today).
  if(!seg) return;
  idb.put('driveTracks', { ...finalizeSegment(seg), active: true, queued: false });
}

// Finalize a leg to the local store WITHOUT enqueueing — uploads are deferred
// to end of day (finishAndUpload) or the next-open safety net (recoverStale).
async function finalizeLocal(s){
  if(!isWorthUploading(s)){ await idb.del('driveTracks', s.id); return; }
  await idb.put('driveTracks', { ...finalizeSegment(s), active: false, queued: false });
}

// ── GPS runtime ──
function onFix(p){
  if(!seg) return;
  const fix = {
    lat: p.coords.latitude, lng: p.coords.longitude,
    t: p.timestamp || Date.now(),
    spd: (typeof p.coords.speed === 'number' && p.coords.speed >= 0) ? p.coords.speed : undefined,
  };
  // Roll to a fresh leg before a single row could approach the Sheet cell limit.
  if(seg.points.length >= MAX_POINTS){ const done = seg; startSegment(); finalizeLocal(done); }
  if(resumePending){ markResume(seg, fix); resumePending = false; }
  else addFix(seg, fix);
  checkpoint();
}
function onErr(){ /* a denied/timed-out fix just means no point this tick */ }

function startWatch(){
  if(seg) return;
  startSegment();
  if(navigator.geolocation){
    watchId = navigator.geolocation.watchPosition(onFix, onErr,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  requestWake();
}

async function stopWatch(){
  if(watchId != null && navigator.geolocation){ navigator.geolocation.clearWatch(watchId); watchId = null; }
  releaseWake();
  if(seg){ const done = seg; seg = null; await finalizeLocal(done); }
}

// The page went to the background (screen lock, or a Google-Maps hand-off): the
// OS suspends GPS anyway, so bracket the gap on the last known point and mark
// the next fix a resume. This turns a tracking gap into two anchors the desktop
// planner can road-route between, and the map viewer draws dashed.
function onVisibility(){
  if(!seg) return;
  if(document.visibilityState === 'hidden'){ markPause(seg); releaseWake(); checkpoint(); }
  else { resumePending = true; requestWake(); }
}

// Recover any leg a prior session left un-finalized, ship legs from a previous
// un-closed day (today's stay local until Finish), and prune old local legs.
async function recoverStale(){
  const all = (await idb.all('driveTracks')) || [];
  const today = localDate();
  const cutoff = localDateOffset(-8);
  for(const r of all){
    let row = r;
    if(r.active){ row = { ...r, active: false }; await idb.put('driveTracks', row); }
    if(row.date && row.date < today && !row.queued && (row.pointCount || 0) >= 2){
      const c = cfg();
      const { active, queued, ...leg } = row;
      await enqueue({ token: c.token, action: 'saveDriveTrack', ...leg });
      await idb.put('driveTracks', { ...row, active: false, queued: true });
    } else if(row.date && row.date < cutoff){
      await idb.del('driveTracks', row.id);
    }
  }
}

// ── public API ──
export async function initDriveRecorder(){
  if(started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibility);
  // A real unload can't finalize/upload (that's deferred anyway); the last fix
  // already checkpointed the leg, so recoverStale() picks it up next open.
  window.addEventListener('pagehide', () => { checkpoint(); });
  await recoverStale();
  if(recordState().on) startWatch();
  notify();
}

export function startRecording(){
  setRecord(true);
  startWatch();
  notify();
}

export async function stopRecording(){
  setRecord(false);
  await stopWatch();
  notify();
}

// End of day: stop the watch, finalize the active leg, disarm, and enqueue every
// un-queued leg dated today. Called from finishDay on both the online and
// offline paths (enqueue works offline and flushes when signal returns).
export async function finishAndUpload(){
  await stopWatch();
  setRecord(false);
  const all = (await idb.all('driveTracks')) || [];
  const today = localDate();
  const c = cfg();
  for(const r of all){
    if(r.date === today && !r.queued && (r.pointCount || 0) >= 2){
      const { active, queued, ...leg } = r;
      await enqueue({ token: c.token, action: 'saveDriveTrack', ...leg });
      await idb.put('driveTracks', { ...r, active: false, queued: true });
    }
  }
  notify();
}
