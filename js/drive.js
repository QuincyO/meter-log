// Drive mode — the single-card driving screen (#drive), reachable only from the
// worklist. It shows the current pending order and hands off to Google Maps. The
// GPS leg is no longer recorded by this screen: the recorder is app-level now
// (js/drive-recorder.js) and runs whenever the capture PWA is open. This screen
// just owns the driver-facing card + the "Start/Stop drive tracking" button that
// arms this phone as the day's recorder (see js/drive-recorder.js for why that
// opt-in gate is per-device — it prevents two phones double-recording a drive).
//
// worklist.js owns the worklist data and calls initDrive() once, handing in a
// pending-orders accessor, the pace projection, the ETA staleness/estimate flags
// (opts.getEtaMeta), the automatic sheet refresh (opts.autoSync) and the shared
// openDirections() — this module never imports worklist.js back (that would be
// circular), exactly like the route view. The clock and the gate for the refresh
// live here (AUTO_SYNC_MS); knowing HOW to refresh stays with the module that owns
// the data.
import { $, esc } from './dom.js';
import { store, cfg } from './store.js';
import * as addressText from './worklist-address-fill.js';
import { localDate, hhmmMin, clockOf, stamp } from './time.js';
import { enqueue } from './queue.js';
import { workMode } from './work-mode.js';
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
// Optional helper so an older cached address module still allows the app to open.
const addrOf = item => addressText.formatOrderAddress
  ? addressText.formatOrderAddress(item) : [item.unit, item.address].filter(Boolean).join(' ').trim();
// Match a saved dest to a pending order: WO# when present, else the address.
const destKey = item => item.workOrderId || addrOf(item);

// ── arrival line ────────────────────────────────────────────────────────────
// The one number the driver was going back to the worklist to read. It is the
// order's OWN persisted `scheduledEta` — the field applyTodayAnchor writes and the
// worklist badges and route view already render — never a drive time computed here.
// That is deliberate: worklist.js estimateTravel now anchors those ETAs on the
// truck's live GPS fix, so the stored number already IS "from where I am", and
// re-deriving it on this screen would be a second model of the day that can
// disagree with the first (see AGENTS.md §"never model the day twice"). The only
// arithmetic below is `eta − now`, which is the same number read two ways.
//
// `in N min` is shown only when the ETA is on today's date and still ahead. A
// scheduledEta already in the past means the re-time has not caught up (it clocks
// day 1 from `now`), so the bare arrival time is the honest thing to show — and an
// overdue count would read as lateness, which `scheduledLateMin` already means
// something specific and different by.
const MAX_AHEAD_MIN = 12 * 60;
function etaLine(item, meta){
  if(!item || !item.scheduledEta) return '';
  const tilde = meta.estimated ? '~' : '';
  const when = `Arrive ${tilde}${esc(item.scheduledEta)}`;
  const onToday = !item.scheduledDate || String(item.scheduledDate) === localDate();
  const eta = hhmmMin(item.scheduledEta);
  // Toronto-pinned, via the same `hhmmMin(clockOf(stamp()))` day1DepartTime uses.
  // `scheduledEta` is a Toronto clock string (route-constraints.js builds it from
  // Toronto-local minutes), so a bare `new Date().getHours()` compares two
  // different zones — correct only on a phone that happens to be set to Toronto,
  // and silently off by the offset on any that is not. It read as the relative
  // half simply never appearing.
  const nowMin = hhmmMin(clockOf(stamp()));
  const delta = (eta == null || nowMin == null) ? null : eta - nowMin;
  const rel = (onToday && delta != null && delta > 0 && delta <= MAX_AHEAD_MIN)
    ? ` · in ${delta} min` : '';
  // Greyed, and labelled, when the last constraint solve failed: every scheduled*
  // field is then left over from the run before it. This is the screen the crew
  // actually navigates by, so it is the last place a stale time may look current.
  // A span (block-styled in CSS), not a div: the "Driving to" card is a <button>,
  // and a div inside one is invalid markup that browsers reparse out of it.
  return `<span class="drive-eta${meta.stale ? ' stale' : ''}">${when}${rel}${meta.stale ? ' (stale)' : ''}</span>`;
}

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
    // The house-timer row lifts "km/h now" out of this card to sit between its two
    // buttons (buildVisitRow), so that one tile no longer hides with its old parent.
    if(visitUi && visitUi.nowEl) visitUi.nowEl.style.display = show ? '' : 'none';
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

  // ── automatic refresh from the sheet (every 3 minutes, while driving) ───────
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
  // Three minutes, not five. The driver asked for it shorter: on a route being
  // worked by a second phone, five minutes is a long time to be looking at a card
  // and an arrival clock that describe a day which has already moved on. The cost
  // is one extra `worklist` + `range` GET per hour, and only while all three gates
  // below hold. Whatever this number is, worklist.js PACE_REFRESH_MS must equal it.
  const AUTO_SYNC_MS = 3 * 60 * 1000;
  // Tick often, throttle on the timestamp. The 30s cadence is NOT the period — the
  // three minutes live in AUTO_SYNC_MS — it is the retry granularity, so a tick that
  // lands while the driver is in Maps costs 30 seconds of staleness rather than a
  // whole further period. Same throttle-by-timestamp shape as paintPace below and
  // worklist.js refreshPaceCache, rather than making an interval load-bearing.
  const AUTO_SYNC_TICK_MS = 30 * 1000;
  // syncAt = 0 means "never synced", so the FIRST tick after the screen opens
  // refreshes right away rather than making the driver wait out a period — opening
  // Drive is exactly the moment they are asking what the route looks like. It is
  // deliberately module-scoped, not reset by open(): the crew hops between the
  // worklist and this screen constantly, and re-entering inside the window must
  // not re-fetch. Re-entering after three idle minutes does, on the first tick.
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

  // Staleness/estimate markers for the arrival lines. They come down through opts
  // like everything else this screen knows about the route — worklist.js owns both
  // flags, and importing it back here would be circular (see the module header).
  const etaMeta = () => (opts.getEtaMeta && opts.getEtaMeta()) || { estimated:false, stale:false };

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
    // The arrival time comes off the LIVE order, matched back out of `pending` by
    // destKey — `d` is a snapshot saved at the Navigate press, so its own copy of
    // scheduledEta would be frozen at whatever the route said then and would sit
    // there un-refreshed for the whole drive. This is the card the driver reads on
    // the way, so it is the one that most needs the number to move.
    const live = pending.find(p => destKey(p) === destKey(d));
    const eta = $('driveDestEta');
    if(eta) eta.innerHTML = etaLine(live, etaMeta());
    el.classList.remove('hide');
  }

  // ── house timer: Parked (left) starts it, Leaving (right) ends it ───────────
  // How long the truck is at an order, one `SiteVisits` row per pair. Collection
  // only — nothing reads the rows yet (owner, 2026-11-27). The rules live in
  // js/site-visit.js, which is pure; this half is the two buttons, the storage and
  // the upload. Five things here look optional and are not:
  //   • the module arrives by dynamic import() and is NOT in sw.js SHELL (the
  //     activity-log rule). Until it loads — or if it never does — no row is built
  //     and this screen is exactly what it was;
  //   • the row is BUILT HERE, with inline styles, and index.html / drive.css gained
  //     nothing. A phone runs this file against an older page and stylesheet for as
  //     long as its installer leaves Force update alone, so markup or a CSS rule
  //     would be a second and third file that all have to arrive together;
  //   • a finished visit rides the offline QUEUE at the press, not the 3-minute
  //     refresh below. That refresh runs only while tracking is armed, driving stats
  //     are on and this screen is in front, so on a day without tracking it never
  //     runs at all;
  //   • the running timer is one store key, so it survives a reload and iOS killing
  //     the app while Maps is in front. `siteVisitClosing` covers the seconds
  //     between a press and the row reaching the queue, while the drive is priced;
  //   • state changes at the PRESS, before any await: a second tap during the drive
  //     lookup must find the new state, or one house is saved twice.
  const VISIT_KEY = 'siteVisitOpen';         // the running timer
  const VISIT_LAST_KEY = 'siteVisitLast';    // { order, text, date } of the last one
  const VISIT_CLOSING_KEY = 'siteVisitClosing';
  const VISIT_TICK_MS = 15 * 1000;           // display only — the row counts minutes
  const LEG_WAIT_MS = 4000;
  let visitMod = null, visitUi = null, visitTimer = null;

  const readJson = key => {
    try { const raw = store.get(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  };
  const writeJson = (key, v) => store.set(key, v ? JSON.stringify(v) : '');
  const openVisit = () => readJson(VISIT_KEY);
  const lastVisit = () => {
    const last = readJson(VISIT_LAST_KEY);
    return last && last.date === localDate() ? last : null;
  };
  const setLastVisit = (order, text) =>
    writeJson(VISIT_LAST_KEY, { order: order || null, text, date: localDate() });
  const visitNow = () => ({ ms: Date.now(), stamp: stamp(), date: localDate() });
  const snapOrder = item => item ? visitMod.orderOf(item, addrOf(item)) : null;

  // Which order a Parked press means — site-visit.js pickOrder has the reasoning.
  // The Driving-to card is read off the LIVE order where it still exists, so the
  // snapshot carries the pin the last refresh gave it.
  function visitOrder(){
    const d = loadDest();
    const dest = d ? (pending.find(p => destKey(p) === destKey(d)) || d) : null;
    const open = openVisit(), last = lastVisit();
    return visitMod.pickOrder(snapOrder(dest), snapOrder(pending[idx]),
      open ? open.order : (last && last.order));
  }

  async function sendVisit(row){
    const c = cfg();
    try {
      await enqueue({ token: c.token, action: 'saveSiteVisit', installer: c.name,
        hNumber: c.hNumber, workType: workMode(), ...row });
    } catch(e){ console.error('House timer: could not queue the visit', e); }
  }

  // The drive between two orders, from the same travel ladder every ETA on this
  // phone is built from (worklist.js legMinutes). Capped, because a row must not
  // wait on a road graph that is slow to load; no answer means nothing is taken off.
  async function visitLeg(from, to){
    if(!opts.legMinutes) return null;
    try {
      return await Promise.race([
        opts.legMinutes(from, to),
        new Promise(resolve => setTimeout(() => resolve(null), LEG_WAIT_MS)),
      ]);
    } catch { return null; }
  }

  // Turn an ended timer into its row and queue it. `job` is everything the row needs
  // and is parked under VISIT_CLOSING_KEY until the queue has it. One at a time, in
  // press order: two presses a second apart must not race each other's drive lookup,
  // and a sweep must not re-send a job that is merely still running.
  let visitChain = Promise.resolve(), visitInFlight = 0;
  const closingJobs = () => {
    const jobs = readJson(VISIT_CLOSING_KEY);
    return Array.isArray(jobs) ? jobs.filter(j => j && j.open) : [];
  };
  const withoutJob = id => closingJobs().filter(j => j.open.id !== id);
  function settleVisit(job){
    writeJson(VISIT_CLOSING_KEY, [...withoutJob(job.open.id), job]);
    visitInFlight++;
    visitChain = visitChain.then(() => finishVisit(job))
      .catch(e => console.error('House timer: could not save the visit', e))
      .finally(() => { visitInFlight--; });
    return visitChain;
  }
  async function finishVisit(job){
    const { open, endedBy, endOrder, now } = job;
    const end = visitMod.endOrderOf(open, endOrder);
    const moved = !!open.order && !!end && !visitMod.sameOrder(open.order, end);
    const leg = moved ? await visitLeg(open.order, end) : null;
    const { row, discarded } = visitMod.endVisit(open, { endOrder, endedBy, now, leg });
    if(discarded){
      const last = lastVisit();
      setLastVisit(last && last.order, `Cancelled (under ${visitMod.MIN_VISIT_SEC} seconds)`);
    } else {
      await sendVisit(row);
      setLastVisit(end, visitMod.savedText(row));
    }
    writeJson(VISIT_CLOSING_KEY, withoutJob(open.id));
    paintVisit();
  }

  // What a reload or a new day left behind: a row that never reached the queue, and
  // a timer still running from a previous day (saved with no end time).
  function sweepVisits(){
    if(!visitMod) return;
    if(!visitInFlight) for(const job of closingJobs()) settleVisit(job);
    const stale = visitMod.closeStale(openVisit(), localDate());
    if(stale){
      writeJson(VISIT_KEY, null);
      sendVisit(stale);
      setLastVisit(null, visitMod.savedText(stale));
    }
  }

  function onParked(){
    sweepVisits();
    const open = openVisit();
    const order = visitOrder();
    // Nothing else on screen to be parked at: the timer is already on this house.
    if(open && (visitMod.sameOrder(open.order, order) || (!open.order && !order))) return;
    // A double tap. (typeof: this file can run beside an older cached site-visit.js.)
    if(open && typeof visitMod.isFresh === 'function' && visitMod.isFresh(open, Date.now())) return;
    const now = visitNow();
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    writeJson(VISIT_KEY, visitMod.startVisit({ id, order, now }));
    paintVisit();
    // The old timer was never ended. It ends here, on the order this press is for.
    if(open) settleVisit({ open, endedBy: 'nextStart', endOrder: order, now });
  }
  function onLeaving(){
    sweepVisits();
    const open = openVisit();
    if(!open) return;
    writeJson(VISIT_KEY, null);
    paintVisit();
    settleVisit({ open, endedBy: 'leave', endOrder: null, now: visitNow() });
  }
  // Navigate on another order while the timer runs: the truck is leaving.
  function noteVisitNavigate(item){
    if(!visitMod) return;
    const open = openVisit();
    if(!open) return;
    writeJson(VISIT_KEY, visitMod.noteNavigate(open, snapOrder(item), stamp()));
    paintVisit();
  }

  function paintVisit(){
    if(!visitUi || !visitMod) return;
    const { park, leave, line } = visitUi;
    const open = openVisit();
    const running = !!open && open.date === localDate();
    park.textContent = running ? `⏱ ${visitMod.elapsedMin(open, Date.now())} min` : 'Parked';
    park.style.borderColor = running ? 'var(--accent)' : '';
    park.style.color = running ? 'var(--accent)' : '';
    leave.disabled = !running;
    leave.style.opacity = running ? '1' : '.45';
    leave.style.background = running ? 'var(--accent)' : '';
    leave.style.borderColor = running ? 'var(--accent)' : '';
    leave.style.color = running ? 'var(--accent-ink)' : '';
    const last = lastVisit();
    line.textContent = running ? visitMod.runningText(open, Date.now()) : (last ? last.text : '');
  }

  // [ Parked ]  2 of 14 / km/h now  [ Leaving ] — the row the owner drew. Built
  // around the existing #drivePos, which keeps its id and its text.
  function buildVisitRow(){
    const pos = $('drivePos');
    if(visitUi || !pos || !pos.parentNode) return;
    const make = (tag, css) => { const n = document.createElement(tag); n.style.cssText = css; return n; };
    const button = (id, label) => {
      const b = make('button',
        'height:auto;min-height:64px;width:100%;margin:0;padding:6px 8px;font-size:17px;font-weight:700;');
      b.type = 'button'; b.className = 'ghost'; b.id = id; b.textContent = label;
      return b;
    };
    const row = make('div',
      'display:grid;grid-template-columns:1fr auto 1fr;align-items:stretch;gap:10px;margin:12px 0 4px;');
    const mid = make('div',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:84px;');
    const line = make('div', 'text-align:center;font-size:14px;min-height:20px;margin:4px 0 8px;');
    line.className = 'muted';
    line.setAttribute('aria-live', 'polite');
    const park = button('driveVisitPark', 'Parked');
    const leave = button('driveVisitLeave', 'Leaving');
    row.id = 'driveVisit';
    const parent = pos.parentNode;
    parent.insertBefore(row, pos);
    parent.insertBefore(line, pos);
    row.append(park, mid, leave);
    pos.style.margin = '0';
    mid.appendChild(pos);
    const nowEl = document.querySelector('#driveMetrics .dm-now');
    if(nowEl){ nowEl.style.margin = '4px 0 0'; mid.appendChild(nowEl); }
    park.onclick = onParked;
    leave.onclick = onLeaving;
    visitUi = { park, leave, line, nowEl };
  }

  function startVisitTick(){ if(!visitTimer) visitTimer = setInterval(paintVisit, VISIT_TICK_MS); }
  function stopVisitTick(){ if(visitTimer){ clearInterval(visitTimer); visitTimer = null; } }

  import('./site-visit.js').then(m => {
    if(!m || typeof m.startVisit !== 'function' || typeof m.pickOrder !== 'function') return;
    visitMod = m;
    buildVisitRow();
    sweepVisits();
    paintMetrics();
    paintVisit();
  }).catch(e => console.error('House timer unavailable', e));

  // One repaint entry point for the recorder's subscribe() — indicator + HUD +
  // dest + on-pace line (the pace is throttled inside paintPace).
  function paintAll(){ paintIndicator(); paintMetrics(); renderDest(); paintPace(); paintVisit(); }

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
      ${etaLine(item, etaMeta())}
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
    // syncAt survives the close, so re-entering the screen after three idle minutes
    // refreshes on the first tick rather than waiting out a fresh period.
    startAutoSync();
    // The live minutes on the Parked button. Like the refresh, it must not outlive
    // the screen — both close() and teardown() clear it.
    sweepVisits();
    startVisitTick();
    window.scrollTo(0, 0);
    $('driveBack').focus();
  }
  async function close(){
    openState = false;
    stopAutoSync();
    stopVisitTick();
    screen.classList.add('hide');
  }
  async function teardown(){
    if(openState){ openState = false; screen.classList.add('hide'); }
    stopAutoSync();
    stopVisitTick();
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
    noteVisitNavigate(item);
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
