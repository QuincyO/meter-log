// Drive mode — the single-card driving screen (#drive), reachable only from the
// worklist. It shows the current pending order and hands off to Google Maps. The
// GPS leg is no longer recorded by this screen: the recorder is app-level now
// (js/drive-recorder.js) and runs whenever the capture PWA is open. This screen
// just owns the driver-facing card + the "Start/Stop drive tracking" button that
// arms this phone as the day's recorder (see js/drive-recorder.js for why that
// opt-in gate is per-device — it prevents two phones double-recording a drive).
//
// worklist.js owns the worklist data and calls initDrive() once, handing in a
// pending-orders accessor, the pace projection, the automatic sheet refresh
// (opts.autoSync) and the shared openDirections() — this module never imports
// worklist.js back (that would be circular), exactly like the route view. The
// clock and the gate for the refresh live here (AUTO_SYNC_MS); knowing HOW to
// refresh stays with the module that owns the data.
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

  // ── on-pace line (one card: regular working hours + the route-finish clock) ──
  // Real-data landing projection sourced by worklist.js (opts.getPace) — see
  // js/compute/estimate.js projectDayReal. Recomputed on open/refresh and, while
  // the recorder ticks, at most every few seconds (it changes slowly and reads
  // the dayCache). Visible whenever there's a route to project, tracking or not.
  //
  // There were two cards, and the second one measured against ROUTE_DAY_END (4:00)
  // — fifteen minutes from the 3:45 working-hours horizon, so it read as the same
  // card twice in the truck. The model still returns `paces.target`; the plan-mode
  // banner and the #tuning what-if use it. This screen shows one horizon and the
  // one thing the horizon can't say: what time the route itself is done.
  let paceAt = 0, paceBusy = false;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Ease the "~N" install count from its last value to n (easeOutCubic, ~420ms).
  // Tabular-nums keeps it from jittering. Jumps straight to n when reduced motion
  // is asked for, the value is unchanged, or the node is hidden (offsetParent null).
  const countTimers = {};
  function setCount(id, n){
    const node = $(id);
    if(!node) return;
    const prev = parseInt(node.dataset.n || '0', 10);
    node.dataset.n = String(n);
    if(reduceMotion() || prev === n || !node.offsetParent){ node.textContent = `~${n}`; return; }
    if(countTimers[id]) cancelAnimationFrame(countTimers[id]);
    let start = 0;
    const step = t => {
      if(!start) start = t;
      const p = Math.min(1, (t - start) / 420);
      const e = 1 - Math.pow(1 - p, 3);
      node.textContent = `~${Math.round(prev + (n - prev) * e)}`;
      if(p < 1) countTimers[id] = requestAnimationFrame(step);
    };
    countTimers[id] = requestAnimationFrame(step);
  }

  // Paint the gauge card.
  //
  // The bar is the ROUTE: done | will-fit | won't-fit, as a share of today's day-1
  // stops. That is the question the driver is actually asking, and the meters/day
  // target has already done its job upstream by deciding how many orders were put on
  // the route when the day was planned (js/route-today.js). The target survives as the
  // caption's quiet second half — the one thing the route cannot say: "I'll finish
  // this route and still land under 24", or, on a day that ran ahead, "over 24".
  //
  // It was briefly the other way round; js/compute/estimate.js paceFor carries the
  // full account of why, including why the "the route re-sizes underneath you"
  // worry doesn't hold up.
  function fillPaceRow(id, pace, prefix, est){
    const row = $(id);
    if(!row) return;
    if(!pace){ row.classList.add('hide'); return; }
    row.classList.remove('hide');
    const done = est.done || 0;
    // est.target is the meters/day number; est.paces.target is the finish-by
    // horizon. Different things, and the only place they meet is right here.
    const target = est.target || 0;
    const total = done + (est.pendingCount || 0);
    const willDo = Math.max(0, pace.projected - done);
    const short = Math.max(0, pace.routeShort || 0);
    const under = Math.max(0, pace.targetShort || 0);
    // …and the same reading the other way, for the day that lands PAST the target.
    // The target no longer trims the route, so installing extra is meant to read as
    // being ahead — before this the footnote just disappeared once `under` hit 0.
    // At most one of the two can be non-zero (js/compute/estimate.js paceFor).
    const over = Math.max(0, pace.targetOver || 0);
    // Walk-ups can carry `done` past the stops the route ever held. That is a good
    // day, and the bar clamps at 100% rather than running off the end of the track.
    const pct = v => total > 0 ? Math.min(100, (v / total) * 100) : 0;
    $(id + 'Lab').textContent = `${prefix} · ${pace.label}`;
    $(id + 'State').textContent = pace.onPace ? 'on pace'
      : `${short} stop${short === 1 ? '' : 's'} short`;
    $(id + 'Unit').textContent = `installs by ${pace.label}`;
    $(id + 'Cap').textContent = `${done} of ${total} stops`
      + (target && under ? ` · ${under} under your ${target}` : '')
      + (target && over ? ` · ${over} over your ${target}` : '');
    $(id + 'Done').style.width = pct(done) + '%';
    $(id + 'More').style.width = pct(willDo) + '%';
    $(id + 'Short').style.width = pct(short) + '%';
    row.classList.toggle('on', pace.onPace);
    row.classList.toggle('behind', !pace.onPace);
    setCount(id + 'Val', pace.projected);
    // What time the route itself is done, on this pace. Measured against THIS
    // card's own horizon rather than a wall clock — the row is the only horizon on
    // screen, so "late" has to mean late for it. It always shows the real clock,
    // amber or not: landing at 5:40 is exactly the thing worth knowing.
    //
    // The label carries am/pm (js/compute/estimate.js finishLabel) because this
    // clock is unbounded — a bare 12-hour "11:29" for a real 23:29 read as a finish
    // seven hours in the past on a card the crew opened at 11:36 in the morning.
    const eta = $(id + 'Eta');
    if(eta){
      const label = est.routeFinishLabel;
      eta.textContent = label ? `Route done ~${label}` : '';
      eta.classList.toggle('hide', !label);
      eta.classList.toggle('late', !!label && est.routeFinishMin > pace.horizonMin);
    }
  }
  async function paintPace(force){
    const el = $('drivePace');
    if(!el || !opts.getPace) return;
    const now = Date.now();
    if(!force && (paceBusy || now - paceAt < 4000)) return;
    paceBusy = true;
    try{
      const est = await opts.getPace();
      paceAt = Date.now();
      if(!openState) return;
      if(!est){ el.classList.add('hide'); return; }
      fillPaceRow('dpWork', est.paces.work, 'Day', est);
      el.classList.remove('hide');
    } finally { paceBusy = false; }
  }

  // ── automatic refresh from the sheet (every 5 minutes, while driving) ───────
  // Nothing on this screen was ever on a clock: the only repaint driver is the
  // recorder's subscribe(), which fires per GPS fix — so the moment fixes stop
  // (a Google-Maps hand-off backgrounds the PWA, GPS is denied) the card and the
  // ETAs freeze at whatever they last said, and the driver has to go back to the
  // worklist and tap ⇩ Download to unfreeze them.
  //
  // The gate is the whole feature, and all three parts were asked for explicitly:
  //   • isRecording()     — the driver tapped ▶ Start drive tracking. They are
  //                         driving, and this phone is the day's recorder;
  //   • showMetricsPref() — the #tuning "Show driving stats" opt-in. It already
  //                         gates the stats HUD; consenting to see live driving
  //                         numbers is what consents to fetching them;
  //   • openState         — the Drive screen is actually in front.
  // Plus the two the network demands: not backgrounded (an OS-suspended tab's
  // timers are unreliable and the fetch is wasted), and online.
  const AUTO_SYNC_MS = 5 * 60 * 1000;
  // Tick often, throttle on the timestamp. The 30s cadence is NOT the period — the
  // five minutes live in AUTO_SYNC_MS — it is the retry granularity, so a tick that
  // lands while the driver is in Maps costs 30 seconds of staleness rather than a
  // whole further period. Same throttle-by-timestamp shape as paintPace below and
  // worklist.js refreshPaceCache, rather than making an interval load-bearing.
  const AUTO_SYNC_TICK_MS = 30 * 1000;
  // syncAt = 0 means "never synced", so the FIRST tick after the screen opens
  // refreshes right away rather than making the driver wait out a period — opening
  // Drive is exactly the moment they are asking what the route looks like. It is
  // deliberately module-scoped, not reset by open(): the crew hops between the
  // worklist and this screen constantly, and re-entering inside the window must
  // not re-fetch. Re-entering after five idle minutes does, on the first tick.
  let syncAt = 0, syncBusy = false, syncTimer = null;

  const autoSyncOn = () =>
    openState && isRecording() && showMetricsPref()
    && document.visibilityState === 'visible' && navigator.onLine;

  async function tickAutoSync(){
    if(!opts.autoSync || !autoSyncOn()) return;
    const now = Date.now();
    if(syncBusy || now - syncAt < AUTO_SYNC_MS) return;
    syncBusy = true;
    syncAt = now;                  // stamped BEFORE the await, so a slow refresh
    try {                          // on a weak signal can't stack up behind itself
      await opts.autoSync();
      if(openState) await refresh();
    } catch { /* stale beats a toast in a truck — try again next tick */ }
    finally { syncBusy = false; }
  }
  function startAutoSync(){
    if(!syncTimer) syncTimer = setInterval(tickAutoSync, AUTO_SYNC_TICK_MS);
  }
  function stopAutoSync(){
    if(syncTimer){ clearInterval(syncTimer); syncTimer = null; }
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

  // One repaint entry point for the recorder's subscribe() — indicator + HUD +
  // dest + on-pace line (the pace is throttled inside paintPace).
  function paintAll(){ paintIndicator(); paintMetrics(); renderDest(); paintPace(); }

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
    // Hold the card the driver is looking at. The list can be re-ordered under us
    // — a background auto-refresh re-anchors the route, and a logged stop shifts
    // everything up — and `idx` is a bare position, so without this the card
    // silently becomes a different house mid-drive. Match the same order back by
    // destKey and only fall back to the positional clamp when it is gone (logged
    // or archived), which is what the post-log refresh wants anyway.
    const was = pending[idx];
    pending = await opts.getPending();
    const again = was ? pending.findIndex(p => destKey(p) === destKey(was)) : -1;
    if(again >= 0) idx = again;
    if(idx >= pending.length) idx = Math.max(0, pending.length - 1);
    // Clear the locked destination once its order is no longer pending (logged or
    // archived) — don't keep telling the driver to drive somewhere they finished.
    const d = loadDest();
    if(d && !pending.some(p => destKey(p) === destKey(d))) clearDest();
    renderCard();
    renderDest();
    paintPace(true);   // the pending route changed — reproject now
  }

  // ── open / close / teardown ──
  // Opening/closing the screen no longer starts/stops GPS — the app-level
  // recorder keeps running when you leave the screen. close()/teardown() just
  // hide the screen.
  async function open(){
    openState = true;
    idx = 0;
    // Opening is a fresh start at the top of the route, so drop the previous
    // session's snapshot too — refresh() holds the card by matching against it,
    // and left in place it would restore the last-viewed order over the `idx = 0`
    // this line just set.
    pending = [];
    screen.classList.remove('hide');
    if(!unsub) unsub = subscribe(paintAll);
    await refresh();
    paintAll();
    // The interval only runs while the screen is open; the gate is re-checked on
    // every tick, so arming/disarming tracking mid-drive needs no wiring of its own.
    // syncAt survives the close, so re-entering the screen after five idle minutes
    // refreshes on the first tick rather than waiting out a fresh period.
    startAutoSync();
    window.scrollTo(0, 0);
    $('driveBack').focus();
  }
  async function close(){
    openState = false;
    stopAutoSync();
    screen.classList.add('hide');
  }
  async function teardown(){
    if(openState){ openState = false; screen.classList.add('hide'); }
    stopAutoSync();
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
