// ── Worklist screen + plan mode ──────────────────────────────────────────────
// The full-page planned-orders list on index.html (replaces the old popup
// sheet). Orders live in the IndexedDB `worklist` store (schema unchanged —
// items just gain an `order` number for manual sequencing; legacy items without
// one sort after ordered ones, by creation time). Drag the ⠿ handle to reorder.
//
// Plan mode (persisted as store key 'planMode') feeds the capture form: while
// it's on, the first pending order is filled into the form and each logged
// stop advances to the next one. The capture page hands us `fillCapture(item)`
// via initWorklist() — this module never touches the form fields directly, so
// the two stay decoupled.
import { $, enc, esc, toast, withActivity } from './dom.js';
import { idb } from './idb.js';
import { store, cfg } from './store.js';
import { stamp, localDate, clockOf, hhmmMin } from './time.js';
import { apiGet, apiPost } from './api.js';
import { optimizeRoute, coordsOf, isParked, geocodeOne, haversine, legMetersFor, homeLegMetersFor, encodePolyline, travelLookup, estimateTravelFromCoords, roadTravelFromCoords, savedRoadTravelFromCoords, localRoadGeometry } from './route.js';
import { installedPacks } from './roadpack.js';
// `lastFix` only. avgMovingSpeed used to price this module's remaining route and no
// longer prices anything here — see the on-pace projection header for why.
import { lastFix } from './drive-recorder.js';
import { cacheRecentDays } from './daycache.js';
import { PRINTABLE, countDay } from './compute/tally.js';
import { computeGapsLocal } from './compute/gaps.js';
import { observedOnSiteMin } from './compute/cadence.js';
import { projectDayReal } from './compute/estimate.js';
import { initWorklistRouteView, needsOrderWrite } from './worklist-route-view.js';
import { initWorklistTuning } from './worklist-tuning.js';
import { initDrive } from './drive.js';
import { createDragAutoScroll } from './drag-autoscroll.js';
import { createPressHold } from './press-hold.js';
// The address helpers (split/join/recent streets) live with the fill-in screen —
// it is the module that exists to put an address on an order.
import {
  addressQueue, hasNoAddress, initWorklistAddressFill, joinAddr, recentStreets,
  sinkAddressless, splitAddr,
} from './worklist-address-fill.js';
import { bulkAddPlan, dedupePlan, normalizeWo } from './worklist-dedup.js';
import { ROUTE_DAY_END, ROUTE_DEPART_TIME } from './config.js';
import { addWorkdays, currentRoutePlacement, scheduleRouteConstraints, dayDurationMin, MIN_ONSITE_MIN, NOMINAL_TRAVEL_MIN } from './route-constraints.js';
import { dwellLookup } from './route-dwell.js';
import {
  VARIANTS, VARIANT_FIELDS, VARIANT_LABELS, applyVariant, fmtKm, isIgnored, isPending,
  liveDayMeters, pendingOf, routeScopeText, routeTotalSummary, variantMatchesLive,
  variantSelectable, variantSummary,
} from './route-variants.js';
import {
  anchorDay1Ids, anchorTarget, day1Count, freshAnchorIds,
  insertByProximity, orderAnchorFirst, taggedDay1Ids,
} from './route-today.js';
import {
  isWorkday, nextWorkday, planDayLabel, resolvePlanDay, soonestAppointment, staleLockIds,
} from './route-planday.js';

let fillCapture = () => {};     // set by initWorklist (capture.js)
let _wlEditId = null;           // null = new order, string = id being edited
let routeView = null;           // initialized once the capture page DOM is ready
let addrFill = null;            // the address fill-in walkthrough (same)
let tuning = null;              // the #tuning route-dials screen (same)
let driveView = null;           // the #drive driving screen (same)

// Where is the crew standing when they hit Optimize? The answer changes the whole
// shape of the route, so it is asked every run rather than armed ahead of time (the
// old "Start from here" pill was a mode you had to remember, and nobody did).
// Resolves 'muster' | 'here' | null (cancelled).
//
// A `.sheet` popup rather than an inline list: Optimize blocks on the answer, so the
// question belongs over the page the way the confirm() it replaced did. It is not a
// native confirm() because three answers don't fit one, and an accidental Cancel has
// to abort the run rather than silently re-shape the route.
let _startAskCancel = null;   // resolver of an open sheet, so a re-tap can't orphan it
function askStartLocation(count, algorithm){
  // A second tap on Optimize while the sheet is open cancels the first run rather
  // than leaving its promise pending forever behind a rebound handler.
  if(_startAskCancel){ const c = _startAskCancel; _startAskCancel = null; c(null); }
  return new Promise(resolve => {
    const box = $('wlStartAsk');
    $('wlStartAskTitle').innerHTML =
      `Optimizing <b>${count} orders</b> — ${esc(algorithm)}.`;
    // capture.js closes ANY .sheet on a backdrop tap (and closeSheets() can fire from
    // elsewhere), which would hide this one with the promise still pending and hang
    // Optimize behind it. Treat that same click as a cancel.
    const onBackdrop = e => { if(e.target === box) done(null); };
    const done = v => {
      _startAskCancel = null;
      box.classList.add('hide');
      box.removeEventListener('click', onBackdrop);
      $('wlStartMuster').onclick = $('wlStartHereNow').onclick = $('wlStartCancel').onclick = null;
      resolve(v);
    };
    _startAskCancel = done;
    $('wlStartMuster').onclick  = () => done('muster');
    $('wlStartHereNow').onclick = () => done('here');
    $('wlStartCancel').onclick  = () => done(null);
    box.addEventListener('click', onBackdrop);
    box.classList.remove('hide');
  });
}

// ── the plan day (which day the route being built is FOR) ───────────────────
// This used to be `nextWeekday(localDate())` inlined into planShape — a name that
// reads like "tomorrow" but is only a weekend clamp, so on any weekday the route
// was always dated TODAY. See js/route-planday.js for the full story and the pure
// decision layer; this is the side-effecting half that reads the clock and store.
//
// resolvePlanDay needs the day's tally (an async IndexedDB read) but planShape()
// is called synchronously from a dozen places, so the answer is CACHED here and
// refreshed at the choke points that already await — applyTodayAnchor above all,
// which runs at boot and after every mutation. Before the first refresh the
// accessor answers conservatively, as if the day were under way, so it never
// rolls on incomplete information: a wrong "today" self-corrects on the next
// refresh, while a wrong "tomorrow" would silently move the installer's route.
let _planDay = null;

// dayClosed()/dayStarted() here are about TODAY — is the day the installer is
// standing in spent? — and never about the day being planned. Do not swap them
// for the plan-day tally that sizes capacity in applyTodayAnchor; they answer
// two different questions and reading one for the other is the easy mistake.
function planDayOpts(extra){
  return {
    today: localDate(),
    nowMin: hhmmMin(clockOf(stamp())),
    finishByMin: hhmmMin(ROUTE_DAY_END),
    dayClosed: dayClosed(),
    override: store.get('wlPlanDate') || '',
    ...extra,
  };
}
async function refreshPlanDay(){
  // The soonest live appointment holds the roll back: scheduleRouteConstraints
  // refuses an order dated before the route starts by THROWING, which costs the
  // whole route rather than that one order.
  const items = await allSorted();
  _planDay = resolvePlanDay(planDayOpts({
    dayStarted: await dayStarted(),
    soonestAppointment: soonestAppointment(items, localDate()),
  }));
  await expireStaleLocks(_planDay.date, items);
  releaseStaleDayLock(_planDay.date);
  return _planDay;
}

// A 🔒 is a statement about ONE day's work, so it does not survive that day. The
// date-equality in `dayLocked()` already makes a stale lock read as unlocked; this
// clears the leftovers so nothing downstream can find a lock date and a frozen set
// describing a day nobody is driving any more.
//
// Silent, like expireStaleLocks above it and for the same reason: this runs on every
// re-schedule, including the Drive screen's 3-minute timer, and the toggle sitting
// above Optimize saying "unlocked" is the signal. A toast here would fire on a timer.
function releaseStaleDayLock(planDay){
  const on = store.get('wlDayLock') || '';
  if(!on || on === planDay) return;
  store.set('wlDayLock', '');
  saveAnchor(null);
}

// Clear position locks pinned to a day that has now passed. `toggleOrderLock`
// stamps a lock with the order's scheduledDate, so every lock carries whatever
// the plan day was when it was set — move the plan day forward and they all go
// unsatisfiable at once. The solver does not skip them, it throws, and that
// throw lands in optimizeRouteHandler BEFORE the writes for order/day and for
// legGeometry: the day sizes freeze at their old values and the route map falls
// back to straight lines. One dead pin must never cost the entire route.
// Silent by design — the card's lock badge going out is the signal, and a toast
// on every boot would be noise.
async function expireStaleLocks(planDay, items){
  const stale = new Set(staleLockIds(items || await allSorted(), planDay));
  if(!stale.size) return 0;
  for(const item of (items || await allSorted())){
    if(!stale.has(String(item.id))) continue;
    await idb.put('worklist', Object.assign({}, item,
      { lockedDate:'', lockedSlot:'', updatedAt:stamp() }));
  }
  return stale.size;
}
function planDayInfo(){ return _planDay || resolvePlanDay(planDayOpts({ dayStarted:true })); }
function planDay(){ return planDayInfo().date; }

// Paint the "Planning for" control from the resolved answer. The hint says which
// day in words ("Tue · tomorrow") and, when the roll fired, WHY — a route that
// quietly moved itself to another day is worse than one that says it did.
// A parked constraint error (wlPlanIssue) takes the line over, because the route
// on screen is then stale and the reason is the only thing worth reading.
function paintPlanDate(){
  const input = $('wlPlanDate'), hint = $('wlPlanDateHint');
  if(!input || !hint) return;
  const info = planDayInfo();
  input.min = localDate();
  input.value = info.date;
  const issue = store.get('wlPlanIssue') || '';
  if(issue){
    hint.textContent = `⚠ ${issue}`;
    hint.classList.add('warn');
    return;
  }
  hint.classList.remove('warn');
  const label = planDayLabel(info.date, localDate());
  hint.textContent =
      info.source === 'rolled'      ? `${label} — today is done`
    : info.source === 'appointment' ? `${label} — held here by an appointment`
    : label;
}

// The installer picked a day by hand. A weekend is snapped forward rather than
// rejected (scheduleRouteConstraints refuses a weekend start outright), and a
// cleared field drops the override so the automatic answer takes back over.
async function planDateChanged(){
  // Locked means locked, and a date input ignores `readOnly` on most browsers — the
  // picker still opens — so this is where the lock is actually enforced. Changing the
  // day would release the lock by the date-equality rule, which is right when the day
  // rolls on its own and wrong when it happens under a finger.
  if(dayLocked()){
    $('wlPlanDate').value = planDay();
    toast('Work list is locked — unlock to plan another day');
    return;
  }
  const picked = String($('wlPlanDate').value || '');
  let next = '';
  if(picked){
    next = isWorkday(picked) ? picked : nextWorkday(picked);
    if(next !== picked) toast(`Weekends aren’t routed — planning for ${next}`);
  }
  store.set('wlPlanDate', next);
  store.set('wlPlanIssue', '');
  await refreshPlanDay();
  await applyTodayAnchor();
  await renderWorklist();
  await planAdvance();
}

// A commute-pull dial value clamped to the 0–100 integer range; blank/garbage
// falls back to the 70 default (the tuning screen is the only writer).
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}
function planShape(){
  return {
    routeStartDate:planDay(),
    firstStopTime:ROUTE_DEPART_TIME,
    paceMin:Math.max(1, Math.round(Number($('wlPace').value) || 30)),
    paceSource:store.get('wlPaceSource') || 'fallback',
    routeVariant:activeVariant(),
    straightDistanceSource:store.get('wlStraightDistanceSource') || '',
    commutePull:pullVal(store.get('wlCommutePull')),
    target:targetVal(),
    // The 🔒 date, so the office's planner can see that this day is settled. Always
    // present — '' is a REAL value here (unlocked) and Code.gs distinguishes an
    // explicit '' from an omitted field, so leaving it out on some paths would make
    // an unlock un-pushable.
    dayLockDate:store.get('wlDayLock') || ''
  };
}

// The clock DAY 1 departs on, as `scheduleRouteConstraints`' `day1FirstStopTime`
// — blank means "use ROUTE_DEPART_TIME like every other day", which is what every
// run that isn't happening right now wants.
//
// The rule is about the ANCHOR, not the hour: the muster point is a *morning*
// anchor, so a route staged there is the morning's route however late it is
// pressed, and it keeps 08:15. A route staged where the crew is actually standing
// — the Optimize "Start from here" choice, and every rolling re-schedule after a
// logged stop — is happening NOW, and pricing it from 08:15 makes every ETA on it
// a morning ETA. Only ever forward: a run before 08:15 keeps the constant rather
// than promising a 06:40 start nobody is driving.
//
// Days 2+ are untouched by construction (route-constraints.js firstMinFor), and
// nothing here reaches day SIZING — see the ETAs-only note over there.
function day1DepartTime(fromCurrent){
  if(!fromCurrent || planDay() !== localDate()) return '';
  const now = clockOf(stamp());
  return hhmmMin(now) > hhmmMin(ROUTE_DEPART_TIME) ? now : '';
}

// Which saved route is live. The office picks one and it rides down with the
// list, but the installer can flip it on the phone — a road route that looks
// wrong from the truck is worth nothing if only the office can change it.
function activeVariant(){
  return store.get('wlRouteVariant') === 'straight' ? 'straight' : 'road';
}
function savePlanLocal(){
  const p = planShape();
  store.set('wlPaceMin', String(p.paceMin));
  return p;
}
// The plan as an IMPLICIT push sends it: everything except the route's calendar
// date. The office owns that (planner.html's "Route starts" picker) and the phone
// owns tuning + target — the same split loadPlanFields describes below — so a
// post-log sync or the savePlan that rides Download must not silently re-date the
// planner's route. Code.gs saveWorklistPlan leaves an omitted field exactly as it
// was, so absent means "keep". Only the installer's explicit ⇪ Upload sends it.
function implicitPlan(){
  const { routeStartDate, ...rest } = savePlanLocal();
  return rest;
}
// Apply a downloaded plan's PLANNER-owned scheduling fields only (pace, variant).
// The installer's phone is the source of truth for tuning + target (commutePull /
// target), so a Download never overwrites those — wlDownload pushes the
// local ones UP instead (savePlan) so the office sees the installer's latest.
function loadPlanFields(plan){
  const p = plan || {};
  $('wlPace').value = String(Math.max(1, Number(p.paceMin || store.get('wlPaceMin')) || 30));
  store.set('wlPaceSource', p.paceSource || store.get('wlPaceSource') || 'fallback');
  if(p.routeVariant) store.set('wlRouteVariant', p.routeVariant === 'straight' ? 'straight' : 'road');
  if(p.straightDistanceSource) store.set('wlStraightDistanceSource', p.straightDistanceSource);
  // The lock is the ONE downloaded field this adopts, and it is worth saying why,
  // because `target` and `commutePull` sitting right beside it are deliberately
  // refused (the phone owns those and pushes them UP instead). A lock is not tuning:
  // it is a statement that somebody has settled a particular day, and the office
  // pressing 🔒 on a route it just built for this installer is exactly as real as the
  // installer pressing it. Adopted in ONE direction only — a sheet that says locked
  // can turn this phone's lock on, and a blank one never turns it off. Unlocking is a
  // press, on the device doing it; otherwise an old row would silently release a day
  // the installer had settled.
  const sheetLock = String(p.dayLockDate || '').slice(0, 10);
  if(sheetLock && !dayLocked() && sheetLock === planDay()) store.set('wlDayLock', sheetLock);
  savePlanLocal();
}

// ── ordering ────────────────────────────────────────────────────────────────
// Manual order wins; items from before the `order` field sort after any ordered
// ones, oldest first. Ties broken by createdAt so the sort is stable.
function sortItems(items){
  return (items || []).slice().sort((a, b) => {
    const ao = a.order == null ? Infinity : Number(a.order);
    const bo = b.order == null ? Infinity : Number(b.order);
    return ao === bo ? String(a.createdAt||'').localeCompare(String(b.createdAt||'')) : ao - bo;
  });
}
async function allSorted(){ return sortItems((await idb.all('worklist')) || []); }

// Done orders matter only for the day they're logged. On startup drop any done
// item completed before today (updatedAt is a Toronto-local "YYYY-MM-DD HH:MM:SS"
// stamp, so its date prefix is lexically comparable with localDate()). Today's
// done stay so the header completed count is meaningful during the day; the
// nightly Code.gs clearDoneWorklistJob clears the sheet copy.
async function pruneDoneWorklist(){
  const today = localDate();
  for(const x of (await idb.all('worklist')) || []){
    if(x && x.wlStatus === 'done' && String(x.updatedAt||'').slice(0,10) < today)
      await idb.del('worklist', x.id);
  }
}

// ── directions (per-card 🧭 button) ─────────────────────────────────────────
// Google Maps is the crew's preferred app. iOS has no OS setting to pick a
// default maps app, so we deep-link into the Google Maps app's URL scheme
// (comgooglemaps://) and fall back to native Apple Maps (maps://) if it isn't
// installed — detected by whether the page ever backgrounds (the app opened).
// Android/desktop keep the Google universal dir link, which Android hands to
// whichever maps app the user has set as default (a choice iOS doesn't offer).
// Navigation goes by the order's ADDRESS (+ ", ON" to stay in-province) — the
// text the installer typed is the source of truth, and a mis-geocoded pin must
// not steer the truck to the wrong spot. Coords are only the fallback for an
// addressless order (the button isn't even rendered without an address).
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function destOf(item){
  const addr = String(item.address || '').trim();
  const c = coordsOf(item);
  return addr ? enc(addr + ', ON') : (c ? enc(c.lat + ',' + c.lng) : '');
}
// The address line exactly as the card shows it — what lands on the clipboard.
function addressLabel(item){
  return [item && item.unit, item && item.address].filter(Boolean).join(' ').trim();
}
// Launch the maps app in its own context — never navigate the PWA itself away
// mid-shift. On iOS the custom schemes launch the app without navigating the
// page, so if Google Maps is absent we can still fall back to Apple Maps.
function openDirections(item){
  const dest = destOf(item);
  if(!dest) return;
  // Copy the address on the way out — the crew pastes it into the work app while
  // the maps route loads. Issued synchronously inside the tap handler (the
  // Clipboard API needs the user gesture) and BEFORE the iOS scheme hand-off,
  // which takes the page out from under us. A denied/unsupported clipboard is
  // swallowed: directions must never depend on the copy succeeding.
  const label = addressLabel(item);
  if(label && navigator.clipboard?.writeText){
    navigator.clipboard.writeText(label).catch(() => {});
    toast('Address copied ✓ — opening maps');
  }
  if(IS_IOS){
    let left = false;                 // set once the app grabs us (page hidden)
    const onLeave = () => { left = true; };
    document.addEventListener('visibilitychange', onLeave, { once:true });
    window.addEventListener('pagehide', onLeave, { once:true });
    setTimeout(() => {
      document.removeEventListener('visibilitychange', onLeave);
      window.removeEventListener('pagehide', onLeave);
      if(!left) window.location.href = `maps://?daddr=${dest}`;  // Apple Maps
    }, 1200);
    window.location.href = `comgooglemaps://?daddr=${dest}&directionsmode=driving`;
    return;
  }
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}`, '_blank');
}

// ── manual sheet sync (Upload / Download buttons) ───────────────────────────
// Deliberately direct API calls, never the offline queue: these are explicit
// user actions that should fail loudly with a toast when there's no signal —
// nothing is retried behind the installer's back. The sheet's Worklist tab is
// a transfer/backup copy keyed on the employee H number (unique, unlike names;
// the installer name only rides along as a readable label); IndexedDB stays
// the working copy. Both directions are whole-list replaces.
function wireShape(x){
  return { id:x.id, workOrderId:x.workOrderId||'', unit:x.unit||'',
    address:x.address||'', oldJNumber:x.oldJNumber||'',
    wlStatus:x.wlStatus||'pending', order:x.order,
    lat:x.lat, lng:x.lng,
    createdAt:x.createdAt||'', updatedAt:x.updatedAt||'',
    day:(x.day == null || x.day === '') ? '' : Number(x.day),
    appointmentDate:x.appointmentDate||'', appointmentTime:x.appointmentTime||'',
    lockedDate:x.lockedDate||'', lockedSlot:x.lockedSlot||'',
    scheduledDate:x.scheduledDate||'', scheduledEta:x.scheduledEta||'',
    scheduledSlot:x.scheduledSlot||'', scheduledWaitMin:x.scheduledWaitMin||'',
    ignored:isIgnored(x),
    orderRoad:blank(x.orderRoad), dayRoad:blank(x.dayRoad), legMetersRoad:blank(x.legMetersRoad),
    homeLegMetersRoad:blank(x.homeLegMetersRoad),
    orderStraight:blank(x.orderStraight), dayStraight:blank(x.dayStraight),
    legMetersStraight:blank(x.legMetersStraight), homeLegMetersStraight:blank(x.homeLegMetersStraight),
    // The phone never generates road geometry — carry the office's verbatim so an
    // upload from here can't blank it (same reason legMeters* round-trips).
    legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || ''),
    homeLegGeometryRoad:String(x.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(x.homeLegGeometryStraight || '') };
}
// Route-variant cells are numbers or genuinely absent; '' (not 0) is the absent
// form the sheet and the variant helpers both understand.
function blank(v){ return (v == null || v === '' || isNaN(Number(v))) ? '' : Number(v); }

async function wlUpload(){
  const c = cfg();
  if(!c.hNumber){ toast('Set your employee number in Settings first'); return; }
  if(!navigator.onLine){ toast('Offline — upload needs signal'); return; }
  const items = await allSorted();
  if(!items.length && !confirm('Your local worklist is empty — uploading will clear your saved copy on the sheet. Continue?')) return;
  try {
    const r = await withActivity('Uploading worklist…', () => apiPost({ action:'saveWorklist',
      installer:c.name, hNumber:c.hNumber, orders: items.map(wireShape), plan:savePlanLocal() }));
    toast(r && r.ok ? `Uploaded ${r.count} orders ✓`
                    : 'Upload failed — ' + ((r && r.error) || 'try again'));
  } catch { toast('Upload failed — check signal'); }
}

// Silent best-effort whole-list push after every log, so the sheet copy tracks
// the phone without the installer tapping ⇪ Upload. Online-only, no toast/confirm;
// offline it no-ops (the phone stays the working copy). Never rides the offline
// queue. Skips an empty list so installers who don't plan never clear their sheet
// copy on a log.
export async function syncWorklist(){
  const c = cfg();
  if(!c.hNumber || !navigator.onLine) return;
  const items = await allSorted();
  if(!items.length) return;
  try {
    await withActivity('Syncing worklist…', () => apiPost({ action:'saveWorklist',
      installer:c.name, hNumber:c.hNumber, orders: items.map(wireShape), plan:implicitPlan() }));
  } catch { /* best-effort — the manual ⇪ Upload is the loud fallback */ }
}

// Land a downloaded order list into the local store, replacing what is there.
// Shared by the manual ⇩ Download and the Drive screen's automatic refresh
// (autoSync), so the two can never normalize a sheet row differently — this is the
// ONLY place a Worklist row becomes a local record.
//
// `preserveDone` is the automatic path's single deviation, and it is load-bearing
// rather than defensive. `syncWorklist()` pushes this phone's list up only right
// after a log (js/pages/capture.js) and no-ops offline, and nothing re-runs it on
// reconnect — so a stop logged in a dead zone leaves the sheet's Worklist row
// saying `pending` long after the meter has reached the Stops tab. An unattended
// pull would then resurrect a finished order and the Drive card would send the
// driver back to a house they already did. A local `done` therefore wins over the
// sheet's copy. The manual Download keeps taking the sheet verbatim: the installer
// asked for it, was warned by the confirm, and can see what landed.
async function applyDownloadedList(list, opts){
  const preserveDone = Boolean(opts && opts.preserveDone);
  // Read BEFORE the store is wiped, or there is nothing left to preserve.
  const doneIds = new Set();
  if(preserveDone)
    for(const x of await allSorted()) if(x.wlStatus === 'done') doneIds.add(String(x.id));
  for(const k of (await idb.keys('worklist')) || []) await idb.del('worklist', k);
  // Normalize each sheet row back to the exact local record shape (drop the
  // sheet-only installer/hNumber columns, re-type wlStatus + lat/lng) so
  // sorting, plan mode, and markWorklistDone keep working after a round trip.
  // `order` is renumbered by array position: the spine returns rows sorted
  // (and renumbers on upload), and even against a stale spine the sheet's
  // physical row order is the last upload's display order — so a Download
  // always lands a clean 0,10,20… locally, healing any historical
  // duplicate/blank order values.
  for(let i = 0; i < list.length; i++){
    const o = list[i];
    await idb.put('worklist', {
      id:String(o.id), workOrderId:String(o.workOrderId||''), unit:String(o.unit||''),
      address:String(o.address||''), oldJNumber:String(o.oldJNumber||''),
      wlStatus: (o.wlStatus === 'done' || doneIds.has(String(o.id))) ? 'done' : 'pending',
      order: i * 10,
      lat: (o.lat === '' || o.lat == null) ? undefined : Number(o.lat),
      lng: (o.lng === '' || o.lng == null) ? undefined : Number(o.lng),
      createdAt:String(o.createdAt||''), updatedAt:String(o.updatedAt||''),
      day: (o.day === '' || o.day == null) ? '' : Number(o.day),
      appointmentDate:String(o.appointmentDate||''), appointmentTime:String(o.appointmentTime||''),
      lockedDate:String(o.lockedDate||''),
      lockedSlot:(o.lockedSlot === '' || o.lockedSlot == null) ? '' : Number(o.lockedSlot),
      scheduledDate:String(o.scheduledDate||''), scheduledEta:String(o.scheduledEta||''),
      scheduledSlot:(o.scheduledSlot === '' || o.scheduledSlot == null) ? '' : Number(o.scheduledSlot),
      scheduledWaitMin:(o.scheduledWaitMin === '' || o.scheduledWaitMin == null) ? '' : Number(o.scheduledWaitMin),
      ignored:isIgnored(o),
      orderRoad:blank(o.orderRoad), dayRoad:blank(o.dayRoad), legMetersRoad:blank(o.legMetersRoad),
      homeLegMetersRoad:blank(o.homeLegMetersRoad),
      orderStraight:blank(o.orderStraight), dayStraight:blank(o.dayStraight),
      legMetersStraight:blank(o.legMetersStraight), homeLegMetersStraight:blank(o.homeLegMetersStraight),
      legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || ''),
      homeLegGeometryRoad:String(o.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(o.homeLegGeometryStraight || '') });
  }
}

async function wlDownload(){
  const c = cfg();
  if(!c.hNumber){ toast('Set your employee number in Settings first'); return; }
  if(!navigator.onLine){ toast('Offline — download needs signal'); return; }
  const local = await allSorted();
  if(local.length && !confirm(`Replace the ${local.length} orders on this phone with your saved copy from the sheet?`)) return;
  try {
    // The phone owns tuning + target. Push the local plan UP first (plan-only, so it
    // never touches the ordering we're about to pull) so the office/planner sees the
    // installer's latest weights the next time a route is built for them.
    try { await apiPost({ action:'savePlan', hNumber: c.hNumber, plan: implicitPlan() }); } catch { /* best effort */ }
    const r = await withActivity('Downloading worklist…', () => apiGet('worklist', { hNumber: c.hNumber }));
    if(!r || !r.ok){ toast('Download failed — ' + ((r && r.error) || 'try again')); return; }
    await applyDownloadedList(r.orders || [], { preserveDone: false });
    if(r.plan) loadPlanFields(r.plan);
    // The "(est.)" marker is NOT cleared here. It used to be, on the reasoning that
    // a downloaded route was planned on the desktop against real OSRM durations —
    // but the applyTodayAnchor below re-times the whole day from where the crew is
    // now, so the marker belongs to the model that re-timed it and the write here
    // never survived to be read. It is set there, once, from that model.
    toast(`Downloaded ${(r.orders || []).length} orders ✓`);
    // A route the office optimized was day-chunked by target with no memory of what
    // this phone has already done, so a LOCKED day keeps its own set over whatever
    // `day` came down. Orders the office added to today are offered through the same
    // "where does this go?" sheet as a hand-typed one — the manual Download is the
    // one path where somebody is holding the phone and can answer.
    await adoptPlannerDay1(r.plan, { interactive: true });
    // Pull today's stops down before re-anchoring. On a SECOND device — the phone
    // the crew drives by, while the orders are logged on another — the dayCache is
    // only ever filled by cacheRecentDays at page load and on reconnect, so a phone
    // that has been open since morning believes nothing has been installed today.
    // The pace gauge's `done` then sits at 0 — which is why the Drive screen said
    // "0 of N" and could never report being behind. The Download is exactly the
    // moment the installer is asking "what has been done?", so answer it.
    await cacheRecentDays(1);
    await applyTodayAnchor();
    await renderWorklist();
    await planAdvance();   // the first pending order may have changed
  } catch { toast('Download failed — check signal'); }
}

// The Drive screen's automatic refresh: the same landing as ⇩ Download, minus
// everything that needs a human. js/drive.js owns the clock and the gate (see
// AUTO_SYNC_MS there — armed + stats opt-in + screen in front); this half only
// knows how to refresh without asking.
//
// Four things it deliberately does NOT do:
//   • no `confirm` — there is nobody to answer it at 80 km/h;
//   • no `toast` — a timer that pops "Download failed — check signal" every few
//     minutes through a dead zone is worse than the staleness it is fixing. Every
//     failure here leaves the last good copy in place and says nothing;
//   • no `savePlan` push — nothing changed locally, and this runs all day;
//   • no `planAdvance()` — it ends in fillCapture, and a background timer must
//     never overwrite a half-typed capture form. Plan mode re-advances on the
//     next logged stop, which is the moment it actually matters.
export async function autoSync(){
  const c = cfg();
  if(!c.hNumber || !navigator.onLine) return;
  // An un-drained queue means this phone is AHEAD of the sheet — logs that haven't
  // landed yet, so the Worklist rows up there describe a day that has moved on.
  // Skip the replace; the stops + re-anchor half below is always safe to run.
  const queued = ((await idb.all('queue')) || []).length;
  if(!queued){
    let r = null;
    try { r = await apiGet('worklist', { hNumber: c.hNumber }); } catch { r = null; }
    if(r && r.ok){
      await applyDownloadedList(r.orders || [], { preserveDone: true });
      if(r.plan) loadPlanFields(r.plan);
      // No "(est.)" write here either — see wlDownload. applyTodayAnchor below owns it.
      // No `interactive` — the add-to sheet must never pop over the Drive screen.
      // Office orders that would join a locked day stay out of it and wait for the
      // installer to open the worklist, where they are offered properly.
      await adoptPlannerDay1(r.plan);
    }
  }
  // Today's stops BEFORE the re-anchor: the pace projection reads the cache, so
  // anchoring first would re-time the day off the stale copy — the same ordering
  // wlDownload is pinned to.
  try { await cacheRecentDays(1); } catch { /* keep the last good cache */ }
  // The piece that actually makes the route and the ETAs accurate. Nothing in the
  // pull above rewrites order/day/scheduledEta — applyTodayAnchor does, by
  // re-running scheduleRouteConstraints from where the crew is now. It is why a
  // manual Download "fixes the times" and a plain day-cache refresh does not.
  await applyTodayAnchor();
  if(!$('worklistScreen').classList.contains('hide')) await renderWorklist();
}

// ── route optimization (land mode) ──────────────────────────────────────────
// Geocode every pending order (bounded to ~80 km of the crew — js/route.js),
// pull a road-distance matrix (straight-line fallback), solve the best open
// path on-device, then rewrite `order` so the list follows it. With a home pin (Settings) the route ends
// moving toward home; otherwise the first order stays the start. Done orders
// are excluded, so re-optimizing tomorrow just re-plans what's left.

// The installer's saved home pin (Settings). A home saved offline (or whose
// geocode failed then) carries text but no coords — retry the lookup here
// while we're online, and persist so the retry is one-time.
async function homePin(){
  const lat = Number(store.get('homeLat')), lng = Number(store.get('homeLng'));
  if(isFinite(lat) && isFinite(lng) && (lat || lng)) return { lat, lng };
  const addr = (store.get('homeAddress') || '').trim();
  if(!addr) return null;
  const hit = await geocodeOne(addr, null);   // home is never radius-gated
  if(hit && !hit.ambig){
    store.set('homeLat', String(hit.lat)); store.set('homeLng', String(hit.lng));
    store.set('homeLabel', hit.label || addr);
    return { lat: hit.lat, lng: hit.lng };
  }
  return null;
}

// The crew's shared morning muster point (Settings, read-only — the office sets it
// on the crew in Teams; loadSubInfo caches it as crewStartAddress). Geocoded lazily
// here, like the home pin, so the phone can time and draw the drive-out to the day's
// first stop. This is an ETA-only anchor: route.js treats a team start as a commute
// (never an ordering anchor), so the route still runs furthest-meter-first toward
// home. Re-geocodes when the office changes the address (crewStartFor guard).
// A cached {lat,lng} from two store keys, or null. Used to build the on-device
// estimate travel for matrix-less reschedules (drag with a lock, variant flip).
function cachedCoord(latKey, lngKey){
  const lat = Number(store.get(latKey)), lng = Number(store.get(lngKey));
  return (isFinite(lat) && isFinite(lng) && (lat || lng)) ? { lat, lng } : null;
}
// How old a GPS fix may be and still be read as "where I am now". Two minutes is
// ~3 km at highway speed, which sits inside the ±30% the crow-flies
// ROAD_DETOUR_FACTOR model already carries, so a fix this fresh cannot be the
// biggest error in the estimate. Five would be ~7 km and would be.
//
// **This constant is the feature's whole safety margin, not a tuning knob.** A web
// app gets no GPS in the background, so a Google-Maps hand-off freezes
// drive-recorder.js's newest point at the driveway the crew pulled out of — and it
// stays there, looking like a perfectly good fix, for the entire leg. Without an
// age bound the "current location" origin would be *most* wrong exactly when the
// driver is driving, which is the one moment it exists for. Widening this trades
// that guarantee for nothing: past the window livePin() simply returns null and
// the ladder falls back to lastDonePin, which is what shipped before.
const LIVE_FIX_MAX_AGE_MS = 2 * 60 * 1000;

// Where the truck is, from the drive recorder's live GPS stream — null unless this
// phone is the day's armed recorder AND the fix is fresh enough to mean anything.
// The age check also disposes of a leftover fix from a previous day for free.
function livePin(){
  const fix = lastFix();
  if(!fix) return null;
  const age = Date.now() - Number(fix.t || 0);
  if(!(age >= 0 && age <= LIVE_FIX_MAX_AGE_MS)) return null;
  return coordsOf(fix);
}

// Where the crew actually is, when there is no live fix: the pin of the most
// recently completed order. The muster point is only the right origin before the
// day's FIRST stop — after that the drive to the next order starts from the
// driveway they are standing in, and pricing it from the depot inflates every
// remaining ETA for the rest of the day.
// `updatedAt` is the completion stamp (markWorklistDone writes it), and done
// orders are pruned to the day they were logged, so the latest one is today's.
//
// It used to be the *only* answer, on the reasoning that it is free, needs no
// permission and works with the radio off. All three are still true and are why it
// remains the fallback — but they argue for it being second, not only: a phone that
// has armed drive tracking is already streaming fixes at no extra cost or
// permission, and between two houses the last completed driveway is kilometres
// behind the truck. It is also the wrong answer after a walk-up or any stop that
// never matched a worklist order, which markWorklistDone never sees.
function lastDonePin(items){
  const done = (items || []).filter(x => x && x.wlStatus === 'done' && coordsOf(x));
  if(!done.length) return null;
  return coordsOf(done.reduce((a, b) =>
    String(b.updatedAt || '') > String(a.updatedAt || '') ? b : a));
}

// Which saved column holds ROAD metres for the live sequence, or '' when there is
// no column worth trusting. Both gates matter:
//
//   * the saved sequence must still BE the live one, or its per-leg metres describe
//     drives between stops that are no longer neighbours — a leg measured for an
//     order that has since been dragged three places up the list is not a shorter
//     leg, it is a different one;
//   * the straight variant's legs are road metres only when the run that saved them
//     pulled a road matrix (`wlStraightDistanceSource`, set beside the variants at
//     optimizeRoute time). Otherwise they are crow-flies, and pricing them here
//     would be tier C wearing a road label.
function savedLegMetersField(items){
  const v = activeVariant();
  if(!VARIANT_FIELDS[v] || !variantMatchesLive(items, v)) return '';
  if(v === 'straight' && store.get('wlStraightDistanceSource') !== 'road') return '';
  return VARIANT_FIELDS[v].legMeters;
}

// The on-device travel lookup for a set of orders — the ladder every ETA on this
// phone is built from, best measurement first and all three offline:
//
//   A  the downloaded district's ROAD GRAPH. Real road distance and real road time,
//      the same measurement Optimize makes. This rung is the point of the ladder:
//      the ETAs used to be road-accurate for as long as it took to log one stop,
//      and then this function — which runs after every logged stop, on the Drive
//      screen's 3-minute refresh, on Download and at boot — replaced them with
//      rung C. On a phone that Optimizes on a pack, every re-anchor was a downgrade.
//   B  the road metres the last solve SAVED on each order, for a day the pack does
//      not cover. Road lengths at a nominal speed: better than crow-flies, still an
//      estimate, and only the between-stop legs (see savedRoadTravelFromCoords).
//   C  crow-flies × detour factor. Needs nothing but the pins, so it always answers.
//
// `.measured` is true only on A, and only when nothing in the day had to be
// repaired — it is what clears the "~" on the Drive card. `all` (optional) is the
// full list including DONE orders, so the day's origin can follow the crew — see
// lastDonePin. Omitted ⇒ the muster point, as before.
async function estimateTravel(items, all){
  // Only for the day the crew is STANDING in. An evening plan for tomorrow starts
  // at the depot like any morning does, so today's last driveway — or the couch the
  // phone is sitting on — is the wrong origin for it. Same today-vs-plan-day split
  // day1DepartTime makes, and it covers both rungs of the ladder below.
  //
  // The ladder: the truck's live GPS fix, else the last completed driveway, else the
  // muster point. Each rung is a worse answer to the same question ("where does the
  // next drive start?") and each is reached only when the one above has nothing to
  // say, so a phone that is not the day's recorder behaves exactly as it did before
  // — silently, with no location prompt and no GPS wakeup of its own.
  const here = planDay() === localDate() ? (livePin() || lastDonePin(all)) : null;
  const start = here || cachedCoord('crewStartLat', 'crewStartLng');
  const home = cachedCoord('homeLat', 'homeLng');
  const road = await roadTravelFromCoords(items, start, home);
  if(road) return road;
  const saved = savedRoadTravelFromCoords(items, start, home, savedLegMetersField(all || items));
  if(saved) return saved;
  return estimateTravelFromCoords(items, start, home);
}

async function crewStartPin(){
  const addr = (store.get('crewStartAddress') || '').trim();
  if(!addr){ store.set('crewStartFor', ''); return null; }
  const lat = Number(store.get('crewStartLat')), lng = Number(store.get('crewStartLng'));
  if(isFinite(lat) && isFinite(lng) && (lat || lng) && store.get('crewStartFor') === addr)
    return { lat, lng };
  const hit = await geocodeOne(addr, null);   // crew start is never radius-gated
  if(hit && !hit.ambig){
    store.set('crewStartLat', String(hit.lat)); store.set('crewStartLng', String(hit.lng));
    store.set('crewStartFor', addr);
    return { lat: hit.lat, lng: hit.lng };
  }
  return null;
}

// useNetwork: which press this is, and therefore which ladder runs.
//   false (a tap)  → the district pack on this phone, else straight-line. Free,
//                    works with the radio off, never touches a paid matrix.
//   true (a hold)  → the pack is SKIPPED on purpose (opts.noLocalGraph) and the
//                    run goes Google Routes → OpenRouteService → straight-line.
// The hold is the deliberate second opinion: the pack carries no turn
// restrictions, so when its answer looks wrong there has to be a way to ask a
// router that has them. That is the only thing the gesture decides.
async function optimizeRouteHandler(useNetwork){
  // Settle the plan day (and expire any lock pinned to a day now past) before
  // anything reads planShape() — scheduleRouteConstraints throws on a stale pin,
  // and that throw lands before this handler writes order/day or legGeometry,
  // which is how one dead lock froze the day sizes AND emptied the road map.
  await refreshPlanDay();
  const pending = pendingOf(await allSorted());
  if(pending.length < 2){ toast('Need at least 2 pending orders to optimize'); return; }
  // What the ROUTER will actually try, not what the settings pointer happens to say.
  // This was `!!activePackId()` — a single localStorage id — while loadGraph scores
  // every district in installedPacks() and picks whichever covers this run, setting
  // the active id as a side effect. A phone holding a district with no active id
  // (never set, or left pointing at one that was deleted) therefore routed on the
  // road graph while the sheet announced "straight-line algorithm" — and, worse,
  // the offline gate below refused the run outright for want of a map it had.
  const havePack = ((await installedPacks()) || []).length > 0;
  // The phone's Optimize measures real roads or it does not run. A tap with no
  // district downloaded used to fall back to straight-line distances silently —
  // a route that looks solved and is blind to every river, dead end and bridge,
  // with nothing on screen saying so. The district is a precondition now, and
  // paintOptimizeGate says so on the button before anyone presses it.
  // The HOLD is deliberately still allowed: it skips the pack by design
  // (opts.noLocalGraph) and asks the network, and it is the only way to get a
  // second opinion from a router that has the turn restrictions the pack lacks.
  // The desktop planner is not gated at all — it routes against a local OSRM.
  if(!useNetwork && !havePack){
    toast('Download your district first — Settings ▸ Offline road map');
    return;
  }
  // Offline is no longer a flat refusal. With a district downloaded, everything
  // that matters runs on the phone — the only thing that still needs signal is
  // geocoding an address we've never pinned, and those just park. So the gate
  // asks the real question: can this run actually measure anything?
  // A HOLD skips the pack by definition, so offline it can measure nothing at
  // all — it is refused, pointing at the tap that would have worked (or, with no
  // district on the phone, at the download that would make that tap work).
  const alreadyPinned = pending.filter(x => coordsOf(x)).length;
  if(!navigator.onLine && (useNetwork || !(havePack && alreadyPinned >= 2))){
    toast(useNetwork
      ? (havePack
        ? 'Offline — holding needs signal; tap Optimize to use the offline map'
        : 'Offline — road distances need signal; download your district on wifi first')
      : 'Offline — needs at least 2 orders with pins');
    return;
  }
  const algorithm = useNetwork
    ? 'Google road distances (then OpenRouteService, then straight-line)'
    : 'offline road map on this phone';
  // One gate, and it carries the decision that matters: a mid-day re-optimize from
  // out in the field must not re-plan as if the crew were back at the muster point.
  const startChoice = await askStartLocation(pending.length, algorithm);
  if(!startChoice) return;
  const startFromCurrent = startChoice === 'here';

  const target = targetVal();
  const btn = $('wlOptimize'), prog = $('wlRouteProgress');
  btn.disabled = true; prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try {
    const home = await homePin();
    const crewStart = await crewStartPin();   // ETA-only anchor + drive-out to draw
    // compareVariants is asked for on BOTH presses and costs nothing on the one
    // that can't use it: route.js only consults the flag inside `if(onRoad)`, so
    // a tap with no pack still does exactly one solve and this can never be the
    // thing that causes a matrix call. A pack-routed tap IS a road run, so it
    // now gets the comparable straight-line variant the toggle switches to.
    // One dwell model for the whole run, used by the ETA simulation (planOpts.dwell).
    // It used to be handed to optimizeRoute as `onSiteMin` too, for the day sizing
    // that a finish-by clock did; nothing sizes days but the target now, so the
    // router no longer takes it.
    const dwell = dwellShape();
    const base = await optimizeRoute(pending, updateRouteProgress, home, {
      straightLine: !useNetwork, noLocalGraph: useNetwork,
      startFromCurrent, start: crewStart, compareVariants: true,
      target, departMin: hhmmMin(ROUTE_DEPART_TIME),
      paceMin: planShape().paceMin, commutePull: planShape().commutePull
    });
    const { parkedIds, usedFallback, fallbackReason, mode, startFallback, geoReason, note } = base;
    const refreshed = await allSorted();
    const refreshedById = {}; refreshed.forEach(x => { refreshedById[x.id] = x; });
    const blocked = parkedIds.map(id => refreshedById[id]).filter(x =>
      x && (x.appointmentDate || x.lockedDate));
    if(blocked.length) throw new Error('Fix the address before routing constrained ' +
      blocked.map(x => `WO ${x.workOrderId || x.id}`).join(', '));
    // Drive-time lookup for the ETAs: real durations from the road matrix (Google/
    // ORS/OSRM), or the estimate route.js derived from distances — either way the
    // first stop's ETA now includes the crew-start drive and the day fits the clock.
    const travel = travelLookup(base.measure);
    // "Start from here" moves the route's origin to where the crew is standing;
    // it has to move the route's CLOCK too, or a run pressed at 11:40 arrives
    // everywhere at breakfast. Starting from the muster point deliberately keeps
    // 08:15 — that press means "show me the day as planned from the depot".
    const planOpts = { ...planShape(), target: base.dayTarget || target, travel, dwell,
      day1FirstStopTime: day1DepartTime(startFromCurrent) };
    // Schedule and price EACH route this run produced. Constraint placement can
    // move stops, so the legs must be measured after it — and both variants are
    // measured against the same matrix, which is what makes their totals
    // comparable rather than road-km-versus-crow-flies.
    const computed = {};
    try {
      for(const v of VARIANTS){
        const variant = base.variants[v];
        if(!variant) continue;
        const routedItems = variant.orderedIds.map(id => refreshedById[id]).filter(Boolean);
        const s = scheduleRouteConstraints(routedItems, variant.orderedIds, planOpts);
        computed[v] = { ...s, legMeters: legMetersFor(base.measure, s.orderedIds, s.dayOf),
          homeLegMeters: homeLegMetersFor(base.measure, s.orderedIds, s.dayOf) };
      }
    } catch(e) {
      // The solver refused this route, and the throw lands before every write —
      // so the stored schedule now describes a route nothing agrees with. Park it
      // where applyTodayAnchor parks its own failures, so the plan-date hint AND
      // the route view's ETAs both learn about it from one place instead of a
      // toast that scrolls away. Rethrown so the toast still fires.
      store.set('wlPlanIssue', String((e && e.message) || 'Route constraints cannot be met'));
      paintPlanDate();
      throw e;
    }
    const primaryVariant = base.variants.road ? 'road' : 'straight';
    const prim = computed[primaryVariant];
    const orderedIds = prim.orderedIds, dayOf = prim.dayOf;
    // Rewrite order = index × 10 across ALL orders (persistOrder's convention):
    // the optimized pending sequence, then parked ones, then done, then the
    // set-aside ones trailing. Done orders must be renumbered too — otherwise a
    // done stop keeps its old order (e.g. 0) and collides with the new first
    // pending stop. `day` rides along (parked/done/ignored unassigned) so the
    // dividers render + sync on upload.
    const all = refreshed;
    const doneIds = all.filter(x => x.wlStatus === 'done').map(x => x.id);
    const ignoredIds = all.filter(x => x.wlStatus !== 'done' && isIgnored(x)).map(x => x.id);
    const byId = {}; all.forEach(x => { byId[x.id] = x; });
    // Each computed variant's own positions over the pending set (routed first,
    // then parked) — saved as its own columns, never renumbered by anything else.
    const variantPos = {};
    // The decoded district this run routed on, when it had one. It is what lets
    // the phone draw REAL roads: until offline packs existed only the desktop
    // planner could produce legGeometry, because only it could reach an OSRM
    // `route` service.
    const graph = base.roadGraph || null;
    for(const v of Object.keys(computed)){
      const c = computed[v], pos = {};
      [...c.orderedIds, ...parkedIds].forEach((id, n) => {
        pos[id] = { order:n * 10, day:c.dayOf[id] || '',
          legMeters:c.legMeters[id] == null ? '' : c.legMeters[id],
          homeLegMeters:c.homeLegMeters[id] == null ? '' : c.homeLegMeters[id],
          geometry:'', homeLegGeometry:'' };
      });
      // Second pass over the ROUTED sequence only (parked orders are not on the
      // route and get no geometry), tracking the previous stop per day so a
      // day's first stop takes the crew-start drive-out instead of a between-
      // stops leg — the same split the planner's fetchVariantGeometry makes.
      const prevByDay = {};
      for(const id of c.orderedIds){
        const fc = coordsOf(byId[id]);
        if(!fc) continue;
        const day = c.dayOf[id] || 0;
        const prev = prevByDay[day];
        if(prev){
          pos[id].geometry = localRoadGeometry(graph, prev, fc);
        } else if(crewStart){
          // Road path when the offline map can draw it, else the straight
          // two-point line that has always been drawn here, so the start pin and
          // its faint dashed line show either way.
          pos[id].homeLegGeometry = localRoadGeometry(graph, crewStart, fc)
            || encodePolyline([[crewStart.lat, crewStart.lng], [fc.lat, fc.lng]]);
        }
        prevByDay[day] = fc;
      }
      variantPos[v] = pos;
    }
    let i = 0;
    for(const id of [...orderedIds, ...parkedIds, ...doneIds, ...ignoredIds]){
      const item = byId[id];
      if(!item) continue;
      const order = (i++) * 10;
      const day = (dayOf && dayOf[id]) ? dayOf[id] : '';
      const s = prim.scheduleById[id] || {};
      const patch = {
        order, day, scheduledDate:s.date||'', scheduledEta:s.eta||'',
        scheduledSlot:s.slot||'', scheduledWaitMin:s.waitMin||'',
        scheduledLateMin:s.lateMin||'',
        // Local-only: wireShape() is an explicit allow-list, so this rides in
        // IndexedDB for the route view to show and never reaches the Worklist tab.
        // That is the whole reason no sheet column was added for it.
        scheduledOnSiteMin:s.onSiteMin||'', updatedAt:stamp()
      };
      // Only the variants this run recomputed are touched: a straight-line tap
      // leaves an earlier road route exactly where it was (it stays offerable
      // while it still covers the same orders) instead of quietly deleting it.
      for(const v of Object.keys(variantPos)){
        const f = VARIANT_FIELDS[v], p = variantPos[v][id];
        patch[f.order] = p ? p.order : '';
        patch[f.day] = p ? p.day : '';
        patch[f.legMeters] = p ? p.legMeters : '';
        patch[f.homeLegMeters] = p ? p.homeLegMeters : '';
        // Sequence changed → saved BETWEEN-stops road geometry is keyed to the OLD
        // order and must never outlive it. With an offline map the phone can now
        // regenerate it for the new sequence in the same pass (pos.geometry); with
        // no map that value is '' and the route map draws straight legs, exactly as
        // before. The crew-start drive-out is likewise redrawn every run.
        patch[f.geometry] = p ? p.geometry : '';
        patch[f.homeLegGeometry] = p ? p.homeLegGeometry : '';
      }
      await idb.put('worklist', Object.assign({}, item, patch));
    }
    store.set('wlRouteVariant', primaryVariant);
    if(base.variants.straight) store.set('wlStraightDistanceSource', base.straightDistanceSource);
    // Display hint only: were these ETAs from real road durations or the distance
    // estimate? Drives the "(est.)" label on the route view. Local, never synced —
    // a downloaded planner route is always real OSRM.
    store.set('wlTimesEstimated', base.estimatedTimes ? '1' : '');
    // Re-time the route, and — while the list is LOCKED — put the frozen set back on
    // top of the plain target-chunk days just written, so re-optimizing after
    // finishing a few orders cannot pull tomorrow's up. Unlocked it holds the tags
    // stamped moments ago in the loop above, which ARE this run's fresh split at the
    // current target, so no `rechunk` is needed here (the meters/day box is the only
    // caller that has to ask for one — it moved the number without re-solving).
    // `travel` is what separates this call from every other: only Optimize has a real
    // matrix to hand, so only its ETAs are exact. Everything else falls back to
    // `estimateTravel` and gets the "(est.)" marker.
    await applyTodayAnchor({ travel });
    await renderWorklist();
    await planAdvance();
    // Parked = wouldn't map (may still carry its last good pin); ambiguous =
    // matched several towns and needs a pick in Edit. Counted separately so
    // the toast says what to fix; the flags partition the parked set, so the
    // subtraction is exact.
    const short = s => String(s || '').length > 70 ? String(s).slice(0, 70) + '…' : String(s || '');
    const ambig = pending.filter(x => x.geoAmbig && x.geoAmbig.length).length;
    const failed = parkedIds.length - ambig;
    const days = Object.keys(dayOf || {}).reduce((m, id) => Math.max(m, dayOf[id]), 0);
    const totalM = Object.values(prim.legMeters).reduce((a, b) => a + b, 0);
    // `base.dayTarget` is still the source of truth for how big the days got rather
    // than the requested `target` — they are the same number now that nothing shrinks
    // a day behind the installer's back, and reading the echo keeps it that way if
    // anything ever sizes days again.
    const effective = Math.max(1, Math.floor(Number(base.dayTarget) || target));
    const extra = ` · ${fmtKm(totalM)}`
      + (days > 1 ? ` · ${days} days of ${effective}` : '')
      + (usedFallback ? ` — straight-line (${short(fallbackReason)})` : '')
      + (failed > 0 ? ` · ${failed} parked (fix address)` : '')
      + (ambig > 0 ? ` · ${ambig} need a town picked (Edit)` : '')
      + (geoReason && parkedIds.length ? ` · lookups failed: ${short(geoReason)}` : '')
      + (note ? ` · ${short(note)}` : '');
    const modeText = mode === 'here-home' ? 'Route optimized — starts here and ends near home ✓'
      : mode === 'here' ? 'Route optimized — starts here ✓'
      : mode === 'start-home' ? 'Route optimized — ends near home · ETA from crew start ✓'
      : mode === 'start' ? 'Route optimized — ETA from crew start ✓'
      : mode === 'home' ? 'Route optimized — ends near home ✓'
      : 'Route optimized — starts at your first order ✓';
    toast((startFallback ? 'Current location unavailable — used normal routing · ' : '') + modeText + extra);
  } catch (err) {
    toast((err && err.message) || 'Route optimization failed — try again');
  } finally {
    btn.disabled = false; prog.classList.add('hide'); prog.textContent = '';
  }
}

// ── Optimize press gesture: the on-device run vs. the network secret ────────
// A normal tap measures on this phone — the district pack when one covers the
// run, straight-line otherwise. Holding for two seconds skips the pack and asks
// the network instead (Google → ORS → straight-line). The recognizer itself is
// js/press-hold.js (pure, and unit-tested); this is only the DOM wiring for it.
// The binder is generic tap-vs-hold wiring despite the name, and is bound twice:
// #wlOptimize (above), and #wlAddBtn — tap opens the single-order form, hold
// opens the #wlBulkAdd bulk-paste sheet. Don't rename it: tests pin the source.
// Three details are load-bearing:
//
// **Never preventDefault() `touchstart` here.** It was added once to stop iOS
// selecting the button's label, and it does — but it cancels every other native
// default for that touch too, panning included. Optimize is a full-width 56px
// button, so that made a strip of the worklist you could not scroll through: the
// only way past it was to start the swipe above or below it. Suppressing the
// selection is the CSS's job (the #wlOptimize rule in css/capture.css);
// `selectstart` below is the harmless belt to its braces. A press that travels
// instead aborts itself, so a swipe that starts on the button just scrolls.
//
// Pointer capture is taken on the press because the hold fires while the finger
// is still down, and it opens a sheet (#wlStartAsk; #wlBulkAdd on the Add hold)
// under that finger — without capture, the release would hit-test into a freshly
// drawn sheet button and answer the question for the installer.
//
// move/up/cancel are on `window`, not the button, for the same reason as
// wireDrag: capture can be lost, and a finger that leaves the button still has to
// abort the press. They are bound once (this runs once, at wire time) and are
// inert while no press is active, so there is nothing to remove.
function bindOptimizeGesture(btn, onLocal, onNetwork, holdMs=2000){
  const press = createPressHold({ holdMs, onTap: onLocal, onHold: onNetwork });
  const release = id => { try { btn.releasePointerCapture(id); } catch { /* already released */ } };

  btn.addEventListener('selectstart', e => e.preventDefault());

  btn.addEventListener('pointerdown', e => {
    if(!press.down(e)) return;
    try { btn.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
  });
  window.addEventListener('pointermove', e => {
    if(press.move(e)) release(e.pointerId);   // it was a scroll — hand the touch back
  });
  window.addEventListener('pointerup', e => {
    if(press.up(e)) release(e.pointerId);
  });
  window.addEventListener('pointercancel', e => {
    if(press.cancel(e)) release(e.pointerId);
  });

  btn.addEventListener('click', e => {
    // true = the synthetic click after a gesture that already ran its command.
    // false = a real click-only activation (keyboard, assistive tech), which the
    // recognizer has just handled as a tap.
    if(press.click()) e.preventDefault();
  });
  btn.addEventListener('contextmenu', e => {
    if(press.active) e.preventDefault();
  });
}

// Live progress line for the long optimize run (locate → geocode → matrix → solve).
function updateRouteProgress(p){
  const prog = $('wlRouteProgress');
  if(!prog) return;
  if(p.phase === 'locate') prog.textContent = 'Getting your location…';
  else if(p.phase === 'geocode') prog.textContent = `Looking up addresses ${p.done}/${p.total}…`;
  else if(p.phase === 'matrix') prog.textContent = p.total ? `Getting road distances ${p.done}/${p.total}…` : 'Getting road distances…';
  else if(p.phase === 'solve') prog.textContent = 'Finding the best order…';
}

// ── screen open/close (pushState so hardware/browser back works) ────────────
export async function openWorklist(){
  _wlEditId = null;
  $('wlForm').classList.add('hide');
  $('wlBulkAdd').classList.add('hide');
  $('wlAddBtn').textContent = '＋ Add order';
  hideAddTo();   // an undecided add from a previous visit reverts to "leave for later"
  $('captureMain').classList.add('hide');
  if(routeView) routeView.close();
  if(addrFill) await addrFill.close();
  $('worklistScreen').classList.remove('hide');
  if(location.hash !== '#worklist') history.pushState({ wl:1 }, '', '#worklist');
  paintPlanToggle();
  await applyTodayAnchor();   // commit today's set on first view; keep it frozen thereafter
  await renderWorklist();
  refreshAvgDay();   // best-effort avg/day hint beside the target field
  window.scrollTo(0, 0);
}
export function openTuning(){
  if(location.hash !== '#tuning') history.pushState({ tuning:1 }, '', '#tuning');
  return tuning.open();
}
function hideScreen(){
  $('worklistScreen').classList.add('hide');
  if(routeView) routeView.close();
  $('captureMain').classList.remove('hide');
}
function closeWorklist(){
  if(location.hash === '#worklist') history.back();   // popstate hides the screen
  else hideScreen();
}

async function openWorklistRoute(){
  $('captureMain').classList.add('hide');
  $('worklistScreen').classList.add('hide');
  if(location.hash !== '#worklist-route') history.pushState({ wlRoute:1 }, '', '#worklist-route');
  await routeView.open();
}

// The Drive screen — its own history entry, so hardware Back leaves it back to
// the worklist. Leaving the screen no longer stops GPS: the app-level recorder
// keeps running until end of day (see js/drive-recorder.js).
async function openDriveScreen(){
  $('captureMain').classList.add('hide');
  $('worklistScreen').classList.add('hide');
  if(location.hash !== '#drive') history.pushState({ drive:1 }, '', '#drive');
  await driveView.open();
}

// The address walkthrough. Its own history entry, like the route map, so the
// phone's hardware Back leaves it the same way the ‹ Worklist button does.
async function openAddressFill(){
  $('captureMain').classList.add('hide');
  $('worklistScreen').classList.add('hide');
  if(!(await addrFill.open())){       // nothing to fix — stay on the list
    $('worklistScreen').classList.remove('hide');
    return;
  }
  if(location.hash !== '#worklist-address') history.pushState({ wlAddr:1 }, '', '#worklist-address');
}

async function showHashScreen(){
  // The route-tuning screen is a leaf opened from the capture nav — handle it
  // first, and close it on any other hash (including Back out of it) so the
  // existing chain below can restore the right screen.
  if(location.hash === '#tuning'){
    routeView.close();
    await addrFill.close();
    return tuning.open();
  }
  tuning.close();
  // Leaving the Drive screen just hides it — GPS recording is app-level now and
  // keeps running (js/drive-recorder.js). Close it before opening the next screen.
  if(driveView && driveView.isOpen() && location.hash !== '#drive') await driveView.close();
  if(location.hash === '#drive'){
    $('captureMain').classList.add('hide');
    $('worklistScreen').classList.add('hide');
    routeView.close();
    await addrFill.close();
    await driveView.open();
  } else if(location.hash === '#worklist-route'){
    $('captureMain').classList.add('hide');
    $('worklistScreen').classList.add('hide');
    await addrFill.close();
    await routeView.open();
  } else if(location.hash === '#worklist-address'){
    $('captureMain').classList.add('hide');
    $('worklistScreen').classList.add('hide');
    routeView.close();
    if(!addrFill.isOpen()) await addrFill.open();
  } else if(location.hash === '#worklist'){
    routeView.close();
    await addrFill.close();       // fires the sink when Back left the walkthrough
    $('captureMain').classList.add('hide');
    $('worklistScreen').classList.remove('hide');
    paintPlanToggle();
    await renderWorklist();
    refreshAvgDay();
    window.scrollTo(0, 0);
    $('wlViewRoute').focus();
  } else {
    await addrFill.close();
    hideScreen();
    $('navBtn').focus();
  }
}
window.addEventListener('popstate', showHashScreen);

// ── list rendering ──────────────────────────────────────────────────────────
export async function renderWorklist(){
  const items = await allSorted();
  const pending = pendingOf(items);
  const done    = items.filter(x => x.wlStatus === 'done');
  const ignored = items.filter(x => x.wlStatus !== 'done' && isIgnored(x));
  const counts = $('wlCounts');
  if(counts) counts.textContent = items.length
    ? [`${pending.length} remaining`,
       ignored.length ? `${ignored.length} set aside` : '',
       `${done.length} completed`, routeTotalText(items)].filter(Boolean).join(' · ') : '';
  paintPlanDate();
  paintTargetHint();
  paintDayLock(pending);
  await paintOptimizeGate();
  paintVariantSwitch(items);
  paintFillAddr(items);
  paintDedup(items);
  if(routeView && routeView.isOpen()) await routeView.refresh();
  const list = $('wlList'); list.innerHTML = '';
  if(!items.length){ list.innerHTML = '<p class="muted">No orders yet — tap ＋ Add order to plan your day.</p>'; return; }
  // Day dividers (only when the office/optimize assigned days) — a header before
  // the first pending card of each day. Done cards trail, ungrouped, and the
  // set-aside ones sit under their own header at the very bottom.
  const variant = activeVariant();
  let curDay = null;
  let noAddrHead = false;   // the "needs address" divider is emitted at most once
  [...pending, ...done].forEach(item => {
    if(isPending(item) && hasNoAddress(item) && !noAddrHead){
      noAddrHead = true;
      const n = pending.filter(hasNoAddress).length;
      const div = document.createElement('div');
      div.className = 'wl-day wl-noaddr-head';
      div.innerHTML = `<span class="wl-day-dot"></span>Needs address · ${n} order${n === 1 ? '' : 's'}`
        + '<span class="wl-day-eta">can’t be routed until filled in</span>';
      list.appendChild(div);
    }
    // Everything from the needs-address divider down is unroutable, so no day
    // header follows it — those orders belong to no day.
    const d = (isPending(item) && !noAddrHead) ? (item.day || null) : null;
    if(d && d !== curDay){
      curDay = d;
      const dayItems = pending.filter(p => (p.day || null) === d);
      const count = dayItems.length;
      const date = (dayItems[0] || {}).scheduledDate || '';
      const km = liveDayMeters(items, variant, d);
      const eta = wlDayEta(dayItems, count, d);
      const div = document.createElement('div');
      div.className = 'wl-day';
      div.title = eta.title;
      div.innerHTML = `<span class="wl-day-dot"></span>Day ${d}${date ? ` · ${esc(date)}` : ''} · ${count} meter${count === 1 ? '' : 's'}`
        + (km == null ? '' : ` · ${esc(fmtKm(km))}`)
        + `<span class="wl-day-eta">${esc(eta.text)}</span>`;
      list.appendChild(div);
    }
    list.appendChild(makeWlCard(item));
  });
  if(ignored.length){
    const div = document.createElement('div');
    div.className = 'wl-day wl-ignored-head';
    div.innerHTML = `Set aside · ${ignored.length} order${ignored.length === 1 ? '' : 's'}`
      + '<span class="wl-day-eta">not routed — still saved</span>';
    list.appendChild(div);
    ignored.forEach(item => list.appendChild(makeWlCard(item)));
  }
  renumberCards(list);
}

// The day every distance on this screen describes. Day 1 is the group the crew
// is standing in — the same convention `todayPending` uses, and Day 1 strictly
// rather than "the lowest day number present" for the same reason it gives.
//
// It is deliberately labelled "day 1" and never "today": the phone can plan a
// day that is not today (see AGENTS.md §"The plan day"), and a route built on
// Thursday evening for Friday would be lying under the other word.
const HEADLINE_DAY = 1;

function routeTotalText(items){
  return routeTotalSummary(items, activeVariant(), store.get('wlStraightDistanceSource') || '',
    { day: HEADLINE_DAY });
}

// The walkthrough entry point, shown only when there is something to fix. The
// count is the whole queue (blank addresses AND ones that wouldn't map), which
// is more than the "needs address" divider covers — the divider is about what
// can't be routed, this button is about what can be fixed in one pass.
function paintFillAddr(items){
  const btn = $('wlFillAddr');
  if(!btn) return;
  const n = addressQueue(items).length;
  btn.classList.toggle('hide', !n);
  btn.textContent = `📝 Fill in missing addresses (${n})`;
}

// The duplicate-cleanup entry point, shown only when the same WO# is on the list
// more than once. The count is the number of copies that would be removed, so the
// button's presence is itself the answer to "are there duplicates?".
function paintDedup(items){
  const btn = $('wlDedup');
  if(!btn) return;
  const n = dedupePlan(items).dupCount;
  btn.classList.toggle('hide', !n);
  btn.textContent = `🔍 Check for duplicate orders (${n})`;
}

// Scan every order, and for each WO# that appears more than once keep one copy
// (the winner rule in worklist-dedup.js) and delete the rest from IndexedDB.
// No confirmation — it does it and reports the count. Fixes THIS phone's list;
// re-Upload to push the cleanup to the shared sheet.
async function runDuplicateScan(){
  await withActivity('Checking for duplicates…', async () => {
    const { groups, removeIds } = dedupePlan(await allSorted());
    if(!removeIds.length){ toast('No duplicate work orders ✓'); return; }
    for(const id of removeIds) await idb.del('worklist', id);
    await renderWorklist();
    await planAdvance();   // a removed copy may have been the planned next order
    toast(`${groups.length} duplicate WO#${groups.length === 1 ? '' : 's'} cleaned · `
      + `${removeIds.length} cop${removeIds.length === 1 ? 'y' : 'ies'} removed`);
  });
}

// Persist one address from the walkthrough. Mirrors wlSave's edit branch: a
// changed address invalidates the cached pin and the parked flags, so the next
// Optimize looks the new text up instead of trusting the old coords.
async function saveWorklistAddress(id, address){
  const existing = await idb.get('worklist', id);
  if(!existing) return;
  const patch = { address, updatedAt: stamp() };
  if(existing.address !== address)
    Object.assign(patch, { lat: undefined, lng: undefined, geoFail: undefined, geoAmbig: undefined });
  await idb.put('worklist', Object.assign({}, existing, patch));
}

// Leaving the walkthrough (finished, exited, or backed out of) parks whatever is
// still addressless at the bottom of the pending group — the same place Optimize
// leaves a stop it couldn't route.
async function afterAddressFill(){
  const before = await allSorted();
  const blanks = pendingOf(before).filter(hasNoAddress).length;
  const wasLast = pendingOf(before).slice(-blanks).every(hasNoAddress);
  await persistOrderIds(sinkAddressless(before));
  await renderWorklist();
  await planAdvance();
  if(blanks && !wasLast)
    toast(`${blanks} order${blanks === 1 ? '' : 's'} without an address moved to the bottom`);
}

// Optimize needs a downloaded district (optimizeRouteHandler refuses the tap
// without one). Say so on the button rather than only at press time, so nobody
// stands in a driveway discovering it.
//
// Two things are load-bearing:
//  1. **`btn.disabled` is never touched here.** A disabled button fires no
//     pointer events at all, which would kill the two-second HOLD — the one
//     press that legitimately still works with no district — along with the
//     tap's own explanatory toast. `disabled` on this button belongs to the run
//     (optimizeRouteHandler sets it while a route is being worked out); a paint
//     that also wrote it would fight that, and could re-enable a button
//     mid-solve. Greying is CSS (`#wlOptimize.gated`) plus `aria-disabled`.
//  2. It reads `installedPacks()`, like every other "do we have a map" test —
//     never `activePackId()`, which can point at nothing on a phone that holds
//     a perfectly good district. See AGENTS.md.
// Exported because Settings can be opened OVER the worklist screen (the ☰ nav
// lives outside captureMain), so a district downloaded there must clear the
// notice on a list that is never re-rendered. paintRoadPacks() calls it.
export async function paintOptimizeGate(){
  const btn = $('wlOptimize'), line = $('wlOptimizeGate');
  if(!btn) return;
  const have = ((await installedPacks()) || []).length > 0;
  btn.classList.toggle('gated', !have);
  btn.setAttribute('aria-disabled', have ? 'false' : 'true');
  btn.title = have ? 'Put the pending orders in the best driving order'
    : 'Download your district in Settings ▸ Offline road map to optimize';
  if(line){
    line.textContent = have ? ''
      : 'Download your district in Settings ▸ Offline road map to optimize.';
    line.classList.toggle('hide', have);
  }
}

// The road / straight-line switch. A variant with no saved sequence — or one
// whose sequence no longer covers the orders on hand — is disabled rather than
// hidden, so it is obvious that a second route exists to be had.
function paintVariantSwitch(items){
  const box = $('wlVariant');
  if(!box) return;
  const active = activeVariant();
  const src = store.get('wlStraightDistanceSource') || '';
  let any = false;
  for(const v of VARIANTS){
    const btn = $(v === 'road' ? 'wlVariantRoad' : 'wlVariantStraight');
    if(!btn) continue;
    const s = variantSummary(items, v, { active:v === active, straightDistanceSource:src,
      day: HEADLINE_DAY });
    const on = s.selectable && v === active;
    btn.disabled = !s.selectable;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = s.stale ? 'Saved, but the orders have changed since — optimize again to use it'
      : s.selectable ? 'Use this route'
      : 'Not worked out yet — optimize with an offline map, or hold Optimize for road distances';
    btn.innerHTML = `<span class="wl-variant-name">${esc(s.label)}</span>`
      + `<span class="wl-variant-km">${esc(s.text)}</span>`;
    if(s.selectable) any = true;
  }
  box.classList.toggle('hide', !any);
  // Both tiles price day 1 only, so say which day and what the rest of the plan
  // comes to. On a phone there is nothing to hover, so the number the tiles no
  // longer show has to be on screen or it is simply gone.
  const scope = $('wlVariantScope');
  if(scope){
    const text = any ? routeScopeText(items, active, HEADLINE_DAY) : '';
    scope.textContent = text;
    scope.classList.toggle('hide', !text);
  }
}

async function switchVariant(v){
  if(v === activeVariant()) return;
  const items = await allSorted();
  if(!variantSelectable(items, v)) return;
  // Measured outside the try: the catch is for applyVariant's "can't meet the fixed
  // appointments", and the ladder answers or degrades — it never throws that.
  const travel = await estimateTravel(pendingOf(items), items);
  let next;
  try { next = applyVariant(items, v, { ...planShape(), target:targetVal(),
    day1Count: currentDay1Count(pendingOf(items)),
    travel, day1FirstStopTime: day1DepartTime(true) }); }
  catch(err){ toast((err && err.message) || 'That route can’t meet the fixed appointments'); return; }
  const now = stamp();
  for(const item of next) await idb.put('worklist', Object.assign({}, item, { updatedAt:now }));
  store.set('wlRouteVariant', v);
  toast(`${VARIANT_LABELS[v]} route in use ✓`);
  await renderWorklist();
  await planAdvance();
}

// Set an order aside (or bring it back). It leaves the route, the day counts and
// plan mode, but stays on the list and on the sheet — the nightly sweep only
// clears completed orders, so nothing is lost by setting one aside.
async function toggleIgnored(item){
  const stored = (await idb.get('worklist', item.id)) || item;
  const next = !isIgnored(stored);
  await idb.put('worklist', Object.assign({}, stored, { ignored:next, updatedAt:stamp() }));
  toast(next ? 'Set aside — left out of the route' : 'Back in the route');
  await renderWorklist();
  await planAdvance();
}

// Meters/day target (persisted per device), at least 1, default 24.
function targetVal(){ return Math.max(1, Math.floor(Number($('wlTarget').value) || 24)); }

// This installer's cadence for the avg/day hint + day ETA. Set by refreshAvgDay.
let wlAvgLogMin = null;
let wlAvgPerDay = null;

// The hint beside the meters/day box: the installer's recent average, and nothing
// else. It briefly also carried a "about N fit before 14:00" ceiling, which existed
// only because a finish-by clock could silently shrink a day below the target. That
// clock no longer sizes anything, so the target is now the whole answer and there is
// no second number to reconcile.
function paintTargetHint(){
  const el = $('wlAvgDay');
  if(!el) return;
  el.textContent = wlAvgPerDay ? `your avg ${wlAvgPerDay}/day` : '';
}

// The 🔓/🔒 toggle, and the two controls it takes away. Both states say what they
// MEAN for the next Optimize rather than just naming themselves, because "locked"
// on its own is exactly the question the installer was already asking.
//
// While locked, the meters/day box and the "Planning for" date go read-only. That
// is not decoration: the lock is a statement about a target on a day, so a target
// typed under it would either be ignored (which is how the old asymmetry was
// reported) or would quietly re-size a settled day. Making them inert is the honest
// third answer, and unlocking is one tap away.
//
// Distinct from the per-order 🔒 on each card (toggleOrderLock — a position lock
// pinning one stop to a date and slot). That one is an icon-only button INSIDE a
// card; this is a full-width labelled bar above Optimize, and the always-present
// text label is what keeps them apart.
function paintDayLock(pending){
  const btn = $('wlDayLock'), hint = $('wlDayLockHint');
  if(!btn) return;
  const on = dayLocked();
  const n = on ? day1Count(anchorDay1Ids(loadAnchor(), pending || [])) : 0;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on
    ? `🔒 Work list locked · today’s ${n} order${n === 1 ? '' : 's'} are set`
    : '🔓 Work list unlocked · Optimize will re-plan every day';
  const target = on ? (anchorTarget(loadAnchor()) || targetVal()) : targetVal();
  // Show the number the day was settled ON, not whatever the box last held — the
  // two are the same at the press, and this is what keeps them the same afterwards.
  if(on && $('wlTarget')) $('wlTarget').value = String(target);
  if(hint){
    hint.textContent = on
      ? `Locked at ${target}/day. Unlock to change the target or the day.`
      : 'Set your target, optimize, then lock it in for the day.';
  }
  for(const id of ['wlTarget', 'wlPlanDate']){
    const el = $(id);
    if(!el) continue;
    // readOnly, not disabled: a disabled input is skipped by the tab order and
    // reads as broken rather than settled, and on the date control it also hides
    // the value the crew wants to SEE while locked.
    el.readOnly = on;
    el.setAttribute('aria-readonly', on ? 'true' : 'false');
    el.classList.toggle('locked', on);
  }
}
// "~6h 40m" / "~40m". The old figure was a count times a cadence plus an hour of
// lunch, so it could never land under an hour and always printed the hours; a
// simulated day of one stop can, and "~0h 25m" reads like a bug.
function hoursText(mins){
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if(!h) return `~${m}m`;
  return `~${h}h${m ? ' ' + m + 'm' : ''}`;
}
// The day divider's duration. Read back from the day's OWN schedule
// (`dayDurationMin`) so it tells the same story as the ETA badges under it: the
// drive out, this route's real road time between stops, and each stop's measured
// on-site minutes. It carried `count × avgLogMin + 60` for every day — the
// installer's historical log-to-log cadence plus an hour for lunch, which ignored
// both the distance printed beside it and the dwell model, so a tight day and a
// scattered one of the same length read identically.
//
// That old figure survives as the FALLBACK, for a list that has never been
// routed (no ETAs to read). It is the only path that still adds the lunch hour:
// a simulated span must not, or the header would announce a finish the last ETA
// badge contradicts — one model, or the two disagree again.
// Say what the km beside it actually is. It claimed the drive out was included;
// legMetersFor charges every day's first stop 0, so it never has been. The drive
// out is measured separately into homeLegMeters* and shown as the route view's
// "start" reference — a wrong tooltip on the one number it describes is how an
// audit of these distances starts in the wrong place, which is exactly what
// happened. The planner's equivalent (js/pages/planner.js) already said this.
const DAY_KM_TIP = 'Distance is the driving between this day’s stops — not the drive '
  + 'out to the first one, and not the drive home.';
// `day` is the divider's day number. Day 1 must be measured from the same clock
// its ETAs were built on (day1DepartTime) — read an afternoon's remaining route
// off an 08:15 start and the header announces ~8h over what the badges under it
// clearly show as four. Days 2+ take the constant, as they always did.
function wlDayEta(dayItems, count, day){
  const shape = planShape();
  const start = (day === 1 && day1DepartTime(true)) || shape.firstStopTime;
  const mins = dayDurationMin(dayItems, start, dwellShape().base);
  if(mins != null) return { text:` · ${hoursText(mins)}`,
    title:`${DAY_KM_TIP} Time is this day's route: the drive out, the driving between stops and the time on site — no lunch or breaks.` };
  if(!wlAvgLogMin || !count) return { text:'', title:DAY_KM_TIP };
  return { text:` · ${hoursText(count * wlAvgLogMin + 60)}`,   // + lunch + break
    title:`${DAY_KM_TIP} Time is your average per meter plus an hour for lunch and breaks — optimize the route for a timed estimate.` };
}
// Pull the installer's avg/day + cadence (installerMetrics) into the hint beside
// the target field. Online best-effort — silent offline; keeps the last value.
async function refreshAvgDay(){
  const c = cfg();
  // Offline keeps the last value, but the clock ceiling is computed on-device and
  // must still be painted — it is the half that answers "why is my target ignored".
  paintTargetHint();
  if(!c.hNumber || !navigator.onLine) return;
  try{
    // Worklist routing is a land workflow, so use land stops even when the
    // capture screen was last left in boat mode.
    const r = await apiGet('installerMetrics', { hNumber: c.hNumber, workType:'land' });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
      wlAvgLogMin = (m.recent30AvgLogMin === '' || m.recent30AvgLogMin == null)
        ? ((m.avgLogMin === '' || m.avgLogMin == null) ? null : Number(m.avgLogMin))
        : Number(m.recent30AvgLogMin);
      const perDay = (m.avgPerDay === '' || m.avgPerDay == null) ? null : Number(m.avgPerDay);
      if(store.get('wlPaceSource') !== 'override' && wlAvgLogMin){
        $('wlPace').value = String(wlAvgLogMin); store.set('wlPaceMin', String(wlAvgLogMin));
        store.set('wlPaceSource', 'recent30');
      }
      wlAvgPerDay = perDay;
      paintTargetHint();
      $('wlPaceHint').textContent = wlAvgLogMin
        ? `Recent 30-workday pace: ${wlAvgLogMin} min/stop`
        : 'No pace history yet — using the editable 30 min/stop fallback.';
      // The measured dwell model rides the same read. Persisted rather than kept in
      // a module variable because the Optimize that needs it often runs offline in
      // a truck; a blank value simply falls back to the pace guess.
      storeNum('wlOnSiteMin', m.onSiteMin);
      storeNum('wlExtraMeterMin', m.extraMeterMin);
      store.set('wlOnSiteSource', String(m.onSiteSource || ''));
      paintOnSiteHint();
    }
  } catch {}
  await refreshSiteFactors();
}

function storeNum(key, v){
  const n = Number(v);
  if(v === '' || v == null || !isFinite(n) || n <= 0) store.set(key, '');
  else store.set(key, String(n));
}
function readNum(key){
  const n = Number(store.get(key));
  return isFinite(n) && n > 0 ? n : null;
}

// Crew-wide per-site dwell history. Best-effort and cached, like the metrics above.
// Deliberately crew-wide, not per-installer: one installer's history at one address
// is far too thin to say anything (see Code.gs crewSiteDwell).
async function refreshSiteFactors(){
  if(!navigator.onLine) return;
  try{
    const r = await apiGet('siteDwell', {});
    if(!r || !r.ok || !Array.isArray(r.sites)) return;
    const map = {};
    r.sites.forEach(s => { if(s && s.key) map[s.key] = Number(s.factor); });
    store.set('wlSiteFactors', JSON.stringify(map));
  } catch {}
}
function siteFactors(){
  try{
    const parsed = JSON.parse(store.get('wlSiteFactors') || '{}');
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

// The run's on-site model, assembled the same way planShape() assembles the rest.
// A tuning-screen override wins over the measurement, and is kept in its OWN key so
// setting one never destroys the measured value underneath it — clearing the field
// has to be able to hand the installer their measurement back.
export function dwellShape(){
  return dwellLookup({
    paceMin: planShape().paceMin,
    onSiteMin: readNum('wlOnSiteOverride') != null ? readNum('wlOnSiteOverride') : readNum('wlOnSiteMin'),
    extraMeterMin: readNum('wlExtraMeterMin'),
    siteFactors: siteFactors(),
  });
}

// How the on-site number was arrived at, for the readouts. Kept in one place so
// the worklist hint and the tuning screen can never describe it differently.
export function onSiteSourceLabel(){
  if(readNum('wlOnSiteOverride') != null) return 'set by you';
  const src = store.get('wlOnSiteSource') || '';
  if(src === 'gps') return 'measured from GPS drive tracks';
  if(src === 'fit') return 'measured from 30 workdays';
  return 'estimated from your pace';
}
// The measurement alone, ignoring any override — what the tuning field shows as its
// placeholder so clearing the box has a visible meaning.
export function measuredOnSiteMin(){ return readNum('wlOnSiteMin'); }
function paintOnSiteHint(){
  const el = $('wlOnSiteHint');
  if(!el) return;
  const d = dwellShape();
  const extra = readNum('wlExtraMeterMin');
  el.textContent = `On site: ${Math.round(d.base)} min/stop (${onSiteSourceLabel()})`
    + (extra ? ` · ${Math.round(extra)} min for another meter at the same address` : '');
}

function appointmentBadge(item){
  if(!item.appointmentDate || !item.appointmentTime) return '';
  return `<span class="wl-badge appt">🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)}</span>`;
}
// Is the stored schedule still one the solver stands behind? A parked constraint
// error means the last solve failed and every scheduled* field on every card is
// left over from the run before it. Nothing used to say so, which is how the map
// could show "ETA 09:55" while two warnings on the worklist screen quoted times
// an hour later — three numbers from three different solves, only one of them
// ever written to a card. The ETAs stay visible (a stale guide beats none) but
// they read as stale.
export function planStale(){ return Boolean(store.get('wlPlanIssue')); }

function scheduleBadge(item){
  // ETAs are only meaningful when they came from real road durations (the road
  // variant); a straight-line route has no travel times, so hide them there.
  if(activeVariant() !== 'road' || !item.scheduledDate || !item.scheduledEta) return '';
  const wait = Number(item.scheduledWaitMin) > 0 ? ` · wait ${Number(item.scheduledWaitMin)}m` : '';
  const stale = planStale() ? ' stale' : '';
  const eta = `<span class="wl-badge${stale}"${stale ? ' title="From an earlier route — re-optimize"' : ''}>ETA ${esc(item.scheduledEta)}${wait}</span>`;
  // Late is never chosen over waiting; it only ever means the drive cannot get
  // there in time from anywhere in the day, and that is the crew's call to make,
  // so it has to be on the card rather than buried in a toast.
  const late = Number(item.scheduledLateMin);
  return eta + ((isFinite(late) && late > 0)
    ? `<span class="wl-badge late" title="Cannot reach this appointment on time from any slot today">⚠ ${Math.round(late)}m late</span>` : '');
}
async function toggleOrderLock(item){
  const stored = (await idb.get('worklist', item.id)) || item;
  if(stored.lockedDate){
    await idb.put('worklist', Object.assign({}, stored, { lockedDate:'', lockedSlot:'', updatedAt:stamp() }));
    toast('Position unlocked');
  } else {
    const pending = pendingOf(await allSorted());
    const { day, slot } = currentRoutePlacement(pending, stored.id, targetVal());
    const date = stored.scheduledDate || stored.appointmentDate || addWorkdays(planShape().routeStartDate, day - 1);
    await idb.put('worklist', Object.assign({}, stored, { lockedDate:date, lockedSlot:slot, updatedAt:stamp() }));
    toast(`Locked to ${date} · slot ${slot}`);
  }
  await renderWorklist();
}

function makeWlCard(item){
  const ignored = item.wlStatus !== 'done' && isIgnored(item);
  // A set-aside order is not part of the route, so it gets no drag handle, no
  // position number, and no Use → — only the way back into the route.
  // `wl-routable` is what the numbering and drag-target queries select on: done
  // and set-aside cards must be neither numbered nor a drop target.
  const routable = item.wlStatus !== 'done' && !ignored;
  const card = document.createElement('div');
  card.className = 'wl-card' + (item.wlStatus==='done' ? ' wl-done-card' : '')
    + (ignored ? ' wl-ignored-card' : '') + (routable ? ' wl-routable' : '')
    + (item.lockedDate ? ' locked' : '');
  card.dataset.id = item.id;
  const title = item.workOrderId ? `WO ${esc(item.workOrderId)}` : '(no WO#)';
  const addr  = [item.unit && esc(item.unit), item.address && esc(item.address)].filter(Boolean).join(' ');
  // The routing-state pill lives in the TITLE row, never at the tail of the
  // address line — the address wraps to full length, and a pill at the end of
  // a long line was invisible in practice. States: 📍 fix address (geocode
  // missed — parked), ⚠ pick a town (matched several places — parked, chips
  // below), muted "no pin" (no coords and no flags — never geocoded, or the
  // flags were shed by a ⇩ Download; the next optimize will look it up).
  const cands = (item.geoAmbig && item.geoAmbig.length) ? item.geoAmbig : null;
  const pill = item.wlStatus === 'done' ? ''
    : item.geoFail ? ' <span class="wl-flag" title="Address didn’t map — fix it to route">📍 fix address</span>'
    : cands ? ` <span class="wl-flag" title="Matches ${cands.length} places — tap a town below">⚠ pick a town</span>`
    : isParked(item) ? ' <span class="wl-flag wl-flag-mute" title="Not looked up yet — optimize will pin it">no pin</span>'
    : '';
  const doneTag = item.wlStatus==='done' ? ' <span style="color:var(--install);font-size:13px">✓ done</span>' : '';
  const asideTag = ignored ? ' <span class="wl-flag wl-flag-mute" title="Left out of the route — still saved">set aside</span>' : '';
  // Cards deliberately show only WO# + address (+ the routing pill/chips) —
  // glanceable while driving a route.
  card.innerHTML = `
    ${routable ? (item.lockedDate
      ? '<span class="wl-pos" aria-hidden="true"></span>'
      : '<button class="wl-handle" type="button" aria-label="Drag to reorder">⠿</button><span class="wl-pos" aria-hidden="true"></span>') : ''}
    <div class="wl-main">
      <strong>${title}</strong>${doneTag}${asideTag}${ignored ? '' : pill}
      ${addr ? `<div class="wl-body">${addr}</div>` : ''}
      <div class="wl-badges">${appointmentBadge(item)}${scheduleBadge(item)}${item.lockedDate ? `<span class="wl-badge">🔒 ${esc(item.lockedDate)} · slot ${Number(item.lockedSlot)}</span>` : ''}</div>
      ${cands ? `<div class="wl-chips wl-towns">${cands.map(c =>
        `<button class="chip" type="button">${esc(c.label)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="wl-actions">
      ${routable ? '<button class="wl-use" data-act="use">Use →</button>' : ''}
      ${routable ? `<button class="wl-lock${item.lockedDate ? ' on' : ''}" data-act="lock" type="button" aria-label="${item.lockedDate ? 'Unlock position' : 'Lock current position'}">${item.lockedDate ? '🔒' : '🔓'}</button>` : ''}
      ${item.wlStatus !== 'done' ? `<button class="wl-aside${ignored ? ' on' : ''}" data-act="aside" type="button" aria-label="${ignored ? 'Put back in the route' : 'Set aside — leave out of the route'}">${ignored ? '↩' : '🚫'}</button>` : ''}
      ${item.address ? '<button class="wl-map" data-act="map" type="button" aria-label="Directions — copies the address">🧭</button>' : ''}
      <button class="wl-edit" data-act="edit">Edit</button>
      <button class="wl-del" data-act="del">✕</button>
    </div>`;
  // Town chips right on the card (same one-tap pick as the Edit form).
  if(cands) [...card.querySelectorAll('.wl-towns .chip')].forEach((b, i) =>
    b.onclick = () => pickTown(item, cands[i]));
  // Directions hands the address to the OS maps app in a new context — never
  // navigate the PWA itself away mid-shift. Shown on done cards too (revisits).
  const mapBtn = card.querySelector('[data-act="map"]');
  if(mapBtn) mapBtn.onclick = () => openDirections(item);
  card.querySelector('[data-act="edit"]').onclick = () => wlOpenForm(item);
  const lockBtn = card.querySelector('[data-act="lock"]');
  if(lockBtn) lockBtn.onclick = () => toggleOrderLock(item);
  const asideBtn = card.querySelector('[data-act="aside"]');
  if(asideBtn) asideBtn.onclick = () => toggleIgnored(item);
  card.querySelector('[data-act="del"]').onclick = async () => {
    await idb.del('worklist', item.id);
    toast('Order removed');
    await renderWorklist();
    await planAdvance();     // the removed order may have been the planned one
  };
  if(routable){
    card.querySelector('[data-act="use"]').onclick = () => {
      fillCapture(item);
      closeWorklist();
      window.scrollTo({ top:0, behavior:'smooth' });
      toast('Prefilled from worklist ✓');
    };
    const handle = card.querySelector('.wl-handle');
    if(handle) wireDrag(handle, card);
  }
  return card;
}

// ── drag-to-reorder (pointer events on the ⠿ handle; no library) ────────────
// The card tracks the finger via a translateY transform; its slot is chosen by
// comparing the pointer against each pending sibling's vertical midpoint, so the
// swap only flips once the finger crosses a neighbour's centre (natural
// hysteresis — no thrash). Each DOM move is FLIP-corrected (re-anchor startY by
// the layout shift) so the card stays glued to the finger while the rest reflow.
// Holding the finger near the top or bottom edge scrolls the page under it
// (js/drag-autoscroll.js), so one drag can cross a list longer than the screen.
// On release the DOM order is persisted as order = index × 10. Done cards sit
// below and are never drop targets.
function wireDrag(handle, card){
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const list = card.parentNode;
    const pointerId = e.pointerId;
    try { handle.setPointerCapture(pointerId); } catch { /* capture is best-effort */ }
    card.classList.add('dragging');
    let startY = e.clientY;   // pointer Y that maps to the card's current slot
    let lastY = e.clientY;    // latest pointer Y, replayed while the page autoscrolls
    let moved = false;
    let ended = false;

    // Hold the finger near the top/bottom edge and the page scrolls under it, so
    // a card can travel the whole list in one drag. The page moving under a
    // stationary finger is the same thing as the finger moving over a still
    // page, so each scrolled pixel is folded into startY and the slot re-picked.
    const scroller = createDragAutoScroll({ onScroll: delta => {
      if(ended) return;
      startY -= delta;
      applyMove(lastY);
    } });

    const applyMove = clientY => {
      if(ended) return;
      lastY = clientY;
      card.style.zIndex = 5;
      card.style.transform = `translateY(${clientY - startY}px)`;
      // Pick the slot: insert before the first pending sibling whose midpoint is
      // below the finger (null → drop at the end).
      let ref = null;
      for(const sib of list.querySelectorAll('.wl-card.wl-routable')){
        if(sib === card) continue;
        const r = sib.getBoundingClientRect();
        if(clientY < r.top + r.height / 2){ ref = sib; break; }
      }
      if(ref !== card && ref !== card.nextElementSibling){
        // FLIP: the same transform is applied for both reads, so the delta is
        // pure layout shift — fold it into startY to keep the card under the
        // finger across the reorder.
        const before = card.getBoundingClientRect().top;
        list.insertBefore(card, ref);
        startY += card.getBoundingClientRect().top - before;
        card.style.transform = `translateY(${clientY - startY}px)`;
        // insertBefore re-parents the card, which fires lostpointercapture and
        // drops the capture — re-acquire so touch move events keep reaching us.
        try { handle.setPointerCapture(pointerId); } catch { /* best-effort */ }
        renumberCards(list);
      }
    };

    const onMove = ev => {
      if(ended) return;
      moved = true;
      applyMove(ev.clientY);
      scroller.track(ev.clientY);
    };
    // Bound to window, not the handle: the reorder above releases pointer
    // capture, after which up/move no longer reliably target the handle — but
    // they always bubble to window, so release is never missed (the "card stuck
    // highlighted on lift" bug). Idempotent via `ended`.
    const endDrag = async () => {
      if(ended) return;
      ended = true;
      scroller.stop();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      card.classList.remove('dragging');
      card.style.transform = ''; card.style.zIndex = '';
      if(moved) await persistOrder();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  });
}

// Re-label the pending cards 1..N by their current DOM order (called on render
// and live on each drag swap). Done cards have no handle and no number.
function renumberCards(list){
  let n = 1;
  for(const c of list.querySelectorAll('.wl-card.wl-routable')){
    const pos = c.querySelector('.wl-pos');
    if(pos) pos.textContent = n++;
  }
}

// Persist the on-screen order of the PENDING cards (done cards keep their spot
// at the bottom of the sort by getting trailing order values).
async function persistOrder(){
  await persistOrderIds([...$('wlList').querySelectorAll('.wl-card')].map(c => c.dataset.id));
}

// Write one whole-list sequence as order = index × 10, honouring locks and
// appointments on the way (a drag through a locked stop is refused, not
// half-applied). Shared by the drag handler and the address walkthrough's
// bottom-parking of addressless orders, so both obey the same rules.
async function persistOrderIds(ordered){
  let ids = ordered.slice();
  const items = (await idb.all('worklist')) || [];
  const byId = {}; items.forEach(x => { byId[x.id] = x; });
  const pending = pendingOf(items);
  let schedule = null;
  if(pending.some(x => x.lockedDate)){
    // Outside the try for the same reason switchVariant measures outside its own:
    // the catch belongs to the constraint solver, not to the measurement.
    const travel = await estimateTravel(pending, items);
    try{
      const pendingIds = ids.filter(id => byId[id] && isPending(byId[id]));
      schedule = scheduleRouteConstraints(pending, pendingIds,
        { ...planShape(), target:targetVal(), day1Count: currentDay1Count(pending),
          travel,
          dwell: dwellShape(), day1FirstStopTime: day1DepartTime(true) });
      ids = schedule.orderedIds.concat(ids.filter(id => byId[id] && !isPending(byId[id])));
    } catch(err){ toast(err.message || 'Unlock the fixed stop before moving through it'); await renderWorklist(); return; }
  }
  let i = 0;
  for(const id of ids){
    const item = byId[id];
    if(!item) continue;
    const order = (i++) * 10;
    const s = schedule && schedule.scheduleById[id];
    if(item.order !== order || s) await idb.put('worklist', Object.assign({}, item, {
      order, day:s ? schedule.dayOf[id] : item.day,
      scheduledDate:s ? s.date : item.scheduledDate, scheduledEta:s ? s.eta : item.scheduledEta,
      scheduledSlot:s ? s.slot : item.scheduledSlot, scheduledWaitMin:s ? s.waitMin : item.scheduledWaitMin,
      scheduledLateMin:s ? s.lateMin : item.scheduledLateMin,
      scheduledOnSiteMin:s ? s.onSiteMin : item.scheduledOnSiteMin,
      updatedAt: stamp()
    }));
  }
  await renderWorklist();
  await planAdvance();   // the first pending order may have changed
}

// ── add / edit form ─────────────────────────────────────────────────────────
function paintTimedFields(){
  $('wlAppointmentFields').classList.toggle('hide', !$('wlTimed').checked);
}
function wlOpenForm(item){
  _wlEditId = item ? item.id : null;
  const a = splitAddr(item ? item.address : '');
  $('wlWo').value     = item ? (item.workOrderId||'') : '';
  $('wlNum').value    = a.num;
  $('wlStreet').value = a.street;
  $('wlOldJ').value   = item ? (item.oldJNumber||'') : '';
  $('wlTimed').checked = Boolean(item && item.appointmentDate && item.appointmentTime);
  $('wlAppointmentDate').value = item ? (item.appointmentDate||'') : '';
  $('wlAppointmentTime').value = item ? (item.appointmentTime||'') : '';
  paintTimedFields();
  $('wlForm').classList.remove('hide');
  $('wlAddBtn').textContent = '✕ Cancel';
  renderChips();
  renderAmbig(item);
  $('wlWo').focus();
  $('wlForm').scrollIntoView({ behavior:'smooth', block:'start' });
}

// Lock an ambiguous order to one town: full label into the address, pin coords
// onto the order, flags cleared — so the next optimize routes it. The single
// pick path behind BOTH chip rows (the card's and the Edit form's), so the two
// can't drift. Typing a better address instead also works (wlSave clears the
// flag with the coords).
async function pickTown(item, c){
  const stored = (await idb.get('worklist', item.id)) || item;
  await idb.put('worklist', Object.assign({}, stored, {
    address: c.label, lat: c.lat, lng: c.lng,
    geoAmbig: undefined, geoFail: false, updatedAt: stamp() }));
  toast('Pinned ✓ — ' + c.label);
  await renderWorklist();
  await planAdvance();
}

// The which-town chips inside the Edit form (the card shows the same chips
// inline — this copy stays for whoever reaches the order through Edit).
function renderAmbig(item){
  const hint = $('wlAmbigHint'), box = $('wlAmbig');
  const cands = (item && item.geoAmbig) || [];
  if(!cands.length){ hint.classList.add('hide'); box.classList.add('hide'); box.innerHTML=''; return; }
  hint.classList.remove('hide'); box.classList.remove('hide');
  box.innerHTML = cands.map(c => `<button class="chip" type="button">${esc(c.label)}</button>`).join('');
  [...box.children].forEach((b, i) => b.onclick = async () => {
    _wlEditId = null;
    $('wlForm').classList.add('hide'); $('wlAddBtn').textContent = '＋ Add order';
    await pickTown(item, cands[i]);
  });
}

// Recent-street chips: the distinct streets already on the list, most recent
// first — tap to fill the street and jump to the house number.
async function renderChips(){
  const streets = recentStreets(await allSorted());
  const box = $('wlChips');
  if(!streets.length){ box.classList.add('hide'); box.innerHTML=''; return; }
  box.classList.remove('hide');
  box.innerHTML = streets.map(st => `<button class="chip" type="button">${esc(st)}</button>`).join('');
  [...box.children].forEach((b, i) => b.onclick = () => {
    $('wlStreet').value = streets[i];
    $('wlNum').focus();
  });
}

async function wlSave(){
  const wo = $('wlWo').value.trim();
  const address = joinAddr($('wlNum').value, $('wlStreet').value);
  if(!wo && !address){ toast('Enter a work order # or address'); return; }
  const timed = $('wlTimed').checked;
  const appointmentDate = timed ? $('wlAppointmentDate').value : '';
  const appointmentTime = timed ? $('wlAppointmentTime').value : '';
  if(timed && (!appointmentDate || !appointmentTime)){
    toast('Choose both an appointment date and time'); return;
  }
  const now = stamp();
  let item;
  if(_wlEditId){
    const existing = (await idb.get('worklist', _wlEditId)) || {};
    item = Object.assign({}, existing, {
      id:_wlEditId, workOrderId:wo, address, oldJNumber:$('wlOldJ').value.trim(),
      appointmentDate, appointmentTime, updatedAt:now
    });
    if(existing.appointmentDate !== appointmentDate || existing.appointmentTime !== appointmentTime){
      item.scheduledDate = ''; item.scheduledEta = '';
      item.scheduledSlot = ''; item.scheduledWaitMin = '';
    }
    // Address changed → the cached coords are stale; drop them (and the parked/
    // ambiguous flags) so the next optimize re-geocodes the new address.
    if(existing.address !== address){ item.lat = undefined; item.lng = undefined; item.geoFail = undefined; item.geoAmbig = undefined; }
  } else {
    const items = await allSorted();
    // Prevent a duplicate WO# at the source — the way the existing duplicates got
    // made. A blank WO# never collides (address-only orders are legitimate); a
    // done copy is skipped so re-adding a completed WO# for a genuine revisit is
    // still allowed (it gets swept nightly anyway).
    if(wo && items.some(x => x.wlStatus !== 'done' && normalizeWo(x.workOrderId) === normalizeWo(wo))){
      toast(`WO# ${wo} is already on your list`);
      return;
    }
    const last = items.filter(x => x.order != null).pop();
    item = {
      id: now + '-' + Math.random().toString(36).slice(2,6),
      workOrderId:wo, address, oldJNumber:$('wlOldJ').value.trim(),
      appointmentDate, appointmentTime,
      wlStatus:'pending', order:(last ? Number(last.order) : -10) + 10,
      createdAt:now, updatedAt:now
    };
  }
  await idb.put('worklist', item);
  toast(_wlEditId ? 'Order updated ✓' : 'Order saved ✓');
  // A brand-new order (never an edit of one already placed) may want to join
  // today's frozen set — queue it for the chooser below.
  if(!_wlEditId) addToQueue.push(String(item.id));
  if(_wlEditId){
    _wlEditId = null;
    $('wlForm').classList.add('hide'); $('wlAddBtn').textContent = '＋ Add order';
  } else {
    // Copy-street-forward: same street, next house — clear WO/number/old J,
    // keep the street, and put the cursor on the house number.
    $('wlWo').value=''; $('wlNum').value=''; $('wlOldJ').value='';
    $('wlTimed').checked=false; $('wlAppointmentDate').value=''; $('wlAppointmentTime').value=''; paintTimedFields();
    renderChips();
    $('wlWo').focus();
  }
  await renderWorklist();
  await planAdvance();
  await offerAddTo();
}

// ── Bulk paste: hold ＋ Add order → the #wlBulkAdd sheet ─────────────────────
// A worklist is built from WO#s first — the office hands over a list of numbers
// and the addresses are filled in afterwards (📝, worklist-address-fill.js). The
// sheet takes one number per line; parse + dedupe is bulkAddPlan (pure, in
// worklist-dedup.js, tested in tests/worklist-bulk-add.test.mjs).

function openBulkAdd(){
  // The single-order form and the sheet fight over the same button; close the
  // form (it may be sitting in its "✕ Cancel" state) before opening the sheet.
  if(!$('wlForm').classList.contains('hide')){
    $('wlForm').classList.add('hide'); $('wlAddBtn').textContent = '＋ Add order'; _wlEditId = null;
  }
  $('wlBulkAdd').classList.remove('hide');
  $('wlBulkText').focus();
}

async function wlBulkAdd(){
  const items = await allSorted();
  const { add, skipped } = bulkAddPlan($('wlBulkText').value, items);
  if(!add.length){
    // Leave the sheet (and the paste) up — "all duplicates" usually means the
    // wrong list was pasted, and the text is the evidence.
    toast(skipped ? 'Nothing added — all already on the list' : 'Nothing to add');
    return;
  }
  const now = stamp();
  const last = items.filter(x => x.order != null).pop();
  const base = last ? Number(last.order) : -10;
  for(let i = 0; i < add.length; i++){
    const item = {
      // wlSave's id shape + the index: a loop mints many per millisecond.
      id: now + '-' + i + '-' + Math.random().toString(36).slice(2,6),
      workOrderId: add[i], address:'', oldJNumber:'',
      appointmentDate:'', appointmentTime:'',
      wlStatus:'pending', order: base + (i + 1) * 10,
      createdAt: now, updatedAt: now
    };
    await idb.put('worklist', item);
    addToQueue.push(String(item.id));   // same day-lock funnel as a single add
  }
  $('wlBulkText').value = '';
  $('wlBulkAdd').classList.add('hide');
  toast(`Added ${add.length} order${add.length === 1 ? '' : 's'}`
    + (skipped ? ` · skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''));
  await renderWorklist();
  await planAdvance();
  await offerAddTo();
}

// ── "where does this new order go?" — the add-to-today chooser ──────────────
// Today's set is frozen (route-today.js), so an order added after the day's route
// is established used to sink to the bottom of the LAST day — the thing installers
// actually complained about. Rather than guess, ask. TWO answers now: join today
// (the day runs longer), or stay out of today entirely. There was a third — join at
// the day's capacity, rolling the tail to tomorrow — and it went with the capacity
// clamp itself: *"I don't want to shuffle the tail down to the next day"* is the
// whole point, and an option whose job is to shuffle it is the same behaviour behind
// a tap. Ids accumulate while the installer keeps adding — the form's
// copy-street-forward flow makes a burst of adds the normal case — so one answer
// covers the whole burst. THIS SHEET IS THE ONLY WAY WORK JOINS A DAY ALREADY UNDER
// WAY, apart from an explicit Optimize; nothing folds it in automatically.
let addToQueue = [];

function hideAddTo(){ addToQueue = []; $('wlAddTo').classList.add('hide'); }

// Slot the queued orders into today's sequence at their cheapest position (pure
// insertByProximity over saved pins — no matrix, no network) and return the
// resulting today sequence. Straight-line, like every other matrix-less path here.
async function todayWithQueued(anchor, pending, byId){
  const dist = (p, q) => {
    const a = coordsOf(byId[p]), b = coordsOf(byId[q]);
    return (a && b) ? haversine(a, b) : null;
  };
  let day1 = anchorDay1Ids(anchor, pending);
  for(const id of addToQueue) day1 = insertByProximity(day1, id, dist);
  return day1;
}

// Offer the choice — but only when it is a real one: the list must be LOCKED for the
// day being planned. Unlocked there is nothing to join and nothing to protect, so the
// order simply takes its place and the next Optimize routes it; asking would be a
// question with no consequence attached to either answer.
//
// A FINISHED locked day still gets the sheet, and that is deliberate. It used to bail
// on `!day1.length` because an exhausted anchor re-committed itself on the next call
// and swept the new order into today anyway. Nothing re-commits now, so bailing would
// send a hand-typed order silently to tomorrow — and "add more to today by hand" is
// the one way work is supposed to join a day that is already spent.
//
// `title` lets the office's Download say who added the work; the two answers, and
// what they do, are identical either way.
async function offerAddTo(title){
  if(!addToQueue.length) return;
  const anchor = loadAnchor();
  const items = await allSorted();
  const pending = pendingOf(items);
  const byId = {}; items.forEach(x => { byId[x.id] = x; });
  if(!dayLocked() || !anchor){ hideAddTo(); return; }

  const next = await todayWithQueued(anchor, pending, byId);
  const n = addToQueue.length;
  const extraMin = n * Math.max(1, Math.round(Number($('wlPace').value) || 30));

  $('wlAddToTitle').innerHTML = title || (
    `<b>${n === 1 ? 'Order added' : n + ' orders added'}</b> — today’s list is locked. Where does `
    + `${n === 1 ? 'it' : 'this work'} go?`);
  $('wlAddToExtend').innerHTML = `Add to today`
    + `<span class="wl-addto-sub">Day runs about ${extraMin} min longer · ${next.length} `
    + `stop${next.length === 1 ? '' : 's'} left today</span>`;
  $('wlAddToLater').innerHTML = `Leave for later`
    + `<span class="wl-addto-sub">Stays on the list, after today’s work</span>`;
  $('wlAddTo').classList.remove('hide');
}

// Fold the queued orders into today's committed set: the day grows, and nothing is
// pushed out to make room for them — the "keep the day's size" option that used to
// roll the tail is gone, because a stop leaving today is never a side effect now.
// Then re-sequence: the new orders land beside their nearest neighbours rather than
// at the end of the day.
async function acceptAddTo(){
  const anchor = loadAnchor();
  const queued = addToQueue.slice();
  if(!anchor || !queued.length){ hideAddTo(); return; }
  const items = await allSorted();
  const pending = pendingOf(items);
  const byId = {}; items.forEach(x => { byId[x.id] = x; });

  const have = new Set(anchor.ids.map(String));
  const added = queued.filter(id => !have.has(String(id)));
  const day1 = await todayWithQueued(anchor, pending, byId);
  saveAnchor({
    date: anchor.date,
    ids: [...anchor.ids.map(String), ...added],
    target: anchorTarget(anchor) || targetVal(),
  });
  hideAddTo();

  // Write the whole sequence back through the same choke point the drag uses, so
  // locks and appointments still get their say; it re-renders and re-anchors.
  const inDay1 = new Set(day1);
  const rest = pending.map(p => String(p.id)).filter(id => !inDay1.has(id));
  const notPending = items.filter(x => !isPending(x)).map(x => String(x.id));
  await persistOrderIds([...day1, ...rest, ...notPending]);
  toast('Added to today — the day runs longer');
}

// ── completing a planned order when its WO is actually logged ───────────────
// Matches the first pending card by WO# (case-insensitive); a blank WO# never
// matches. Runs entirely against IndexedDB so it works with no signal.
// A SET-ASIDE order still matches: if the crew actually logged the meter, the
// order is done — being set aside was a routing decision, not a refusal — so the
// flag clears with it and the card moves to the completed group.
export async function markWorklistDone(workOrderId){
  const wo = String(workOrderId || '').trim().toUpperCase();
  if(!wo) return;
  const items = await allSorted();
  const match = items.find(x => x.wlStatus !== 'done'
    && String(x.workOrderId || '').trim().toUpperCase() === wo);
  if(!match) return;
  await idb.put('worklist', Object.assign({}, match, { wlStatus:'done', ignored:false, updatedAt:stamp() }));
  // Re-times the remaining route. Finishing the LAST of today's committed set no
  // longer rolls the anchor to the next chunk — the day is simply done (needsCommit).
  await applyTodayAnchor();
  if(!$('worklistScreen').classList.contains('hide')) await renderWorklist();
}

// Start a work order over from the Today's-orders sheet: the inverse of
// markWorklistDone. Flip the matching order back to pending — KEEPING its typed
// WO#/address/unit/old J#/pin — and clear the done-only derived state (set-aside,
// lock, scheduled slot). The bad meter itself is removed separately by the caller
// (capture.js archives the stop). Prefers a done match, so a reset while a second
// copy is still pending revives the one that was actually logged. Re-applies the
// today anchor so an order that belonged to today returns to Day 1.
export async function resetWorklistOrder(workOrderId){
  const wo = String(workOrderId || '').trim().toUpperCase();
  if(!wo) return;
  const items = await allSorted();
  const matches = items.filter(x => String(x.workOrderId || '').trim().toUpperCase() === wo);
  const match = matches.find(x => x.wlStatus === 'done') || matches[0];
  if(!match) return;
  await idb.put('worklist', Object.assign({}, match, {
    wlStatus:'pending', ignored:false,
    lockedDate:'', lockedSlot:'',
    scheduledDate:'', scheduledEta:'', scheduledSlot:'', scheduledWaitMin:'',
    updatedAt:stamp(),
  }));
  await applyTodayAnchor();
  if(!$('worklistScreen').classList.contains('hide')) await renderWorklist();
  await planAdvance();   // the revived order may now be the plan's next stop
}

// ── the 🔓/🔒 work-list lock ────────────────────────────────────────────────
// The lock is ONE DATE, and the whole of its semantics is one equality: the list is
// locked iff `wlDayLock` names the day being planned. Nothing expires it, nothing
// sweeps it, and a new plan day releases it for free — a lock is a statement about
// a particular day's work, so a lock left over from Tuesday means nothing on
// Wednesday. Blank is unlocked.
//
// The frozen SET is the anchor next door (`wlTodayAnchor`), written once at the
// press and never again except by "Add to today". Both live in localStorage like
// the meters/day target; the lock DATE also rides the sync to WorklistPlans so the
// office's planner and the phone can see each other's, while the set itself stays
// local (on the sheet it is just the rows tagged day 1).
function dayLocked(){
  const on = store.get('wlDayLock') || '';
  return Boolean(on) && on === planDay();
}

// How big Day 1 is right now, for any caller that re-schedules the pending list:
// the locked set entire, or — unlocked — the day as currently tagged, or null for a
// list nothing has ever routed. `null` is "unset" and makes route-constraints.js
// size day 1 by the target like any other day; 0 is a REAL count (a locked day whose
// work is finished) and must never be tested for truthiness.
//
// Every re-scheduling path has to use this, not just applyTodayAnchor. The variant
// switch and the drag write-back both call scheduleRouteConstraints on their own, and
// while they omitted it the lock leaked: flipping road↔straight, or dragging one
// card, silently re-chunked Day 1 back to a full target.
function currentDay1Count(pending){
  const tagged = taggedDay1Ids(pending);
  const fallback = tagged.length ? tagged.length : null;
  if(!dayLocked()) return fallback;
  const a = loadAnchor();
  // A lock whose SET has not landed yet — the office's lock arrives as a bare date on
  // the WorklistPlans row, so between adopting it and the next applyTodayAnchor there
  // is a lock with nothing behind it. Reading the anchor blind would return 0 here,
  // and 0 is a real count: Day 1 would collapse to nothing.
  if(!a || a.date !== planDay()) return fallback;
  return day1Count(anchorDay1Ids(a, pending));
}
function loadAnchor(){
  try { const a = JSON.parse(store.get('wlTodayAnchor') || 'null'); return (a && a.date) ? a : null; }
  catch { return null; }
}
function saveAnchor(a){ store.set('wlTodayAnchor', a ? JSON.stringify(a) : ''); }

// One-shot, for the phones that are MID-DAY when this ships. Before the toggle
// existed, a committed anchor for the day being planned WAS the frozen day — so a
// crew that downloaded and started driving this morning would come back from the
// deploy reading as unlocked, and their settled day would go soft under them. Carry
// the old implicit freeze across as an explicit lock.
//
// Keyed on a separate one-shot marker, never on "wlDayLock is blank": blank is the
// real unlocked state, so migrating off it would silently re-lock the day every time
// the installer unlocked and reloaded. Runs after refreshPlanDay, because it compares
// against the plan day.
function migrateLegacyLock(){
  if(store.get('wlDayLockMigrated')) return;
  store.set('wlDayLockMigrated', '1');
  const a = loadAnchor();
  if(a && a.date === planDay() && !(store.get('wlDayLock') || '')) store.set('wlDayLock', a.date);
}

// Flip the lock. Locking SNAPSHOTS the day that is on screen right now — whatever
// sized it, the last Optimize, the office's chunking or an appointment day — which
// is the one moment the installer has actually looked at the day and said "this
// one". That snapshot is the only commit there is; nothing recomputes it afterwards.
// Unlocking drops both the flag and the set, so the next re-schedule chunks purely
// by target.
async function setDayLocked(on){
  const day = planDay();
  if(!on){
    store.set('wlDayLock', '');
    saveAnchor(null);
    return;
  }
  const pending = pendingOf(await allSorted());
  const target = targetVal();
  saveAnchor({ date: day, ids: freshAnchorIds(pending, target), target });
  store.set('wlDayLock', day);
}

// The 🔓/🔒 press. Locking snapshots the day and says how big it came out; unlocking
// re-splits every day by the target immediately, because that IS what unlocked
// means — the installer can then change the target and re-optimize, and both will
// actually do something. Pushed to the sheet so the office's planner sees it, on the
// same implicit channel the meters/day target rides.
async function toggleDayLock(){
  await refreshPlanDay();
  const next = !dayLocked();
  // Locking an empty list freezes an empty day, which then reads as "today is done"
  // for as long as the lock stands. There is nothing to settle, so say so instead.
  if(next && !pendingOf(await allSorted()).length){
    toast('Nothing to lock — the list has no pending orders');
    return;
  }
  await setDayLocked(next);
  await applyTodayAnchor();
  await renderWorklist();
  await planAdvance();
  if(next){
    const n = day1Count(anchorDay1Ids(loadAnchor(), pendingOf(await allSorted())));
    toast(`🔒 Locked — ${n} order${n === 1 ? '' : 's'} for ${planDay()}`);
  } else {
    toast('🔓 Unlocked — set your target and optimize');
  }
  syncWorklist().catch(() => {});
}

// Today's real stops, tallied — from ANY source, planned orders and the walk-ups a crew
// finds in the field alike. Read from the same storage-first dayCache the pace projection
// uses (paceContext), so it is exact offline and correct the instant a stop is logged:
// applyOptimisticCache writes the cache before the queue ever drains. countDay is the
// shared tally behind the Today sheet and the daily log, so these numbers always match
// what the crew sees. One read serves both callers below.
// Takes the DATE to tally, because the day being planned is not always today: a
// route built this evening is for tomorrow, which has no stops yet, so the cache
// miss correctly reports a full day's room. Defaults to today for the callers
// that really do mean "the day the installer is standing in".
async function tallyOn(date){
  const c = cfg();
  if(!c.name) return countDay([], []);
  const cached = await idb.get('dayCache', `${c.name}|${date || localDate()}`);
  return countDay((cached && cached.stops) || [], []);
}
async function todayTally(){ return tallyOn(localDate()); }

// Has today's work actually begun? Installs OR UTIs — a UTI spends no meter slot
// (installedToday deliberately ignores it) but it is still a stop the crew drove to,
// so a day holding one is under way and its route must not be freely reshuffled.
async function dayStarted(){
  const t = await todayTally();
  return Boolean(t.installed || t.uti);
}

// The day has been closed out (finishDay stamped it). The plan being built now is for
// the next working day, so it may reshuffle freely — same key paceContext reads.
function dayClosed(){ return store.get('dayClosedDate') === localDate(); }

// What a downloaded plan is allowed to do to a LOCKED day. Only fires when the
// downloaded plan starts on the day THIS PHONE is planning; a plan for any other day
// leaves the lock alone and its orders queue behind. (That comparison was against
// localDate() when the phone could only ever plan today; it must follow the plan day,
// or an evening download of tomorrow's route — the normal case now — would stop being
// adopted.)
//
// It used to fold the office's whole day 1 into the committed set without asking —
// "the planner decides, the phone obeys". The lock reverses that, deliberately: the
// installer pressed 🔒 on a day they had looked at, and an office re-plan landing
// during it is exactly the case the toggle exists to survive. So the office's extra
// orders go through the SAME "where does this go?" sheet a hand-typed order raises.
//
// `interactive` is not decoration. This also runs on the Drive screen's 3-minute
// autoSync, whose whole contract is that it never speaks — there is nobody to answer
// a prompt at 80 km/h. On that path the extras simply stay out of today and wait for
// the installer to open the worklist, which is the honest quiet outcome.
//
// Unlocked there is nothing to adopt: no frozen set exists, and the downloaded `day`
// tags are already the day.
async function adoptPlannerDay1(plan, opts){
  await refreshPlanDay();
  const today = planDay();
  if(String((plan && plan.routeStartDate) || '') !== today) return;
  if(!dayLocked()) return;
  const anchor = loadAnchor();
  if(!anchor) return;
  const pending = pendingOf(await allSorted());
  const officeDay1 = pending.filter(p => Number(p.day) === 1).map(p => String(p.id));
  if(!officeDay1.length) return;
  const have = new Set(anchor.ids.map(String));
  const added = officeDay1.filter(id => !have.has(id));
  if(!added.length) return;
  if(!(opts && opts.interactive)) return;
  const n = added.length;
  addToQueue = [...new Set([...addToQueue, ...added])];
  await offerAddTo(`<b>The office put ${n === 1 ? 'another order' : n + ' more orders'} on today</b>`
    + ` — your list is locked. Where does ${n === 1 ? 'it' : 'this work'} go?`);
}

// The single choke point that re-times the route and, while the list is LOCKED,
// keeps Day 1 frozen. It reassigns the live order/day so the locked orders lead and
// later work fills days 2+ by target, overriding the plain target-chunking that
// optimize/download stamp. Unlocked it does neither: the target chunks every day and
// this is purely the re-schedule.
//
// It runs after every logged stop (planAdvance is that call site), and there to
// re-TIME the day rather than re-size it — the re-schedule is what keeps the
// remaining ETAs honest, and it is what the Drive screen's 3-minute refresh is
// really after. Writes only when a pending order's order/day/date/ETA actually
// changes, so a real downloaded route's exact ETAs survive an unchanged day.
//
// It takes ONE option now. `opts.travel` is the run's real road-duration lookup —
// Optimize passes it so its ETAs stay exact; every other caller omits it and gets
// the on-device estimate plus the "(est.)" marker. `opts.replan`/`opts.resize` are
// gone with the inference they drove: which orders are today is the toggle's answer,
// not something to work out from who called and whether the target moved.
async function applyTodayAnchor(opts){
  // The day being planned, which is usually but NOT always today — an evening plan
  // is for tomorrow. Everything below keys on it: the lock's date, the anchor's, and
  // the route's start date via planShape(). Keying on localDate() instead would lock
  // tomorrow's plan under today's date and release it at midnight, throwing away
  // exactly the evening's work this feature exists to allow.
  // Resolved BEFORE the items are read: it expires locks left pinned to a day that
  // has passed, so `items` must be the list from after that sweep.
  await refreshPlanDay();
  migrateLegacyLock();
  const items = await allSorted();
  const pending = pendingOf(items);
  if(!pending.length) return;
  const target = targetVal();
  const pendingSeq = pending.map(p => String(p.id));

  // 🔓 or 🔒 — the installer's own answer to "is this day settled?". There used to be
  // a `needsCommit` here trying to INFER it from a target change, an Optimize press, a
  // day roll and an exhausted set, plus a `dayCapacity` bound and a `fromTags` flag to
  // make the inference behave. See js/route-today.js for why all of it is gone.
  const locked = dayLocked();
  let anchor = locked ? loadAnchor() : null;
  // Locked, but with no set behind it. Two ways in: the lock was adopted from the
  // sheet (the office's 🔒 travels as a bare date — the membership up there is just
  // the rows tagged day 1), or a legacy record was migrated. Snapshot the day as
  // tagged, which is what was pressed on at the other end. This is the ONLY commit
  // besides the press itself, and it is a repair rather than a decision.
  if(locked && (!anchor || anchor.date !== planDay())){
    anchor = { date: planDay(), ids: freshAnchorIds(pending, target), target };
    saveAnchor(anchor);
  }
  const day1 = locked ? anchorDay1Ids(anchor, pending) : [];
  const seq = locked ? orderAnchorFirst(pendingSeq, day1) : pendingSeq;

  // How big Day 1 is. THREE answers, and the middle one is the one that is easy to
  // miss — it is why "unlocked" cannot simply mean "no day1Count".
  //
  //   LOCKED            → the frozen set, entire. Zero is a real answer (a locked day
  //                       whose work is done, which stays done), so this must reach
  //                       route-constraints.js as 0 and never as a falsy "unset".
  //   UNLOCKED, RE-CHUNK→ null: size every day by the meters/day target. This is the
  //                       whole point of being unlocked, and exactly ONE caller asks
  //                       for it — the meters/day box, which changed the number but
  //                       has not re-solved the route. (Optimize does not need to ask:
  //                       it rewrites every `day` tag at the new target moments before
  //                       calling here, so holding the tags below IS the fresh split.)
  //   UNLOCKED, PASSIVE → hold the day as currently tagged.
  //
  // That last one is load-bearing. This function also runs after EVERY logged stop
  // (planAdvance), on the Drive screen's 3-minute autoSync, on Download and at boot —
  // and if those re-chunked from the front of `pending`, an installer who simply had
  // not pressed 🔒 would watch tomorrow's orders climb into today as they worked,
  // which is the single most expensive bug this codebase has had (see the field
  // report in js/route-today.js). Unlocked means "a deliberate act may re-plan the
  // week", never "the week re-plans itself between deliberate acts".
  const fits = (!locked && opts && opts.rechunk) ? null : currentDay1Count(pending);

  const travel = (opts && opts.travel) || await estimateTravel(pending, items);
  let schedule;
  try {
    // This runs after every logged stop, so it is the re-schedule that keeps the
    // remaining ETAs honest as the day is worked — and it is by definition
    // happening from where the crew is now, never from the muster point at 08:15.
    schedule = scheduleRouteConstraints(pending, seq,
      { ...planShape(), target, day1Count: fits, travel, dwell: dwellShape(),
        day1FirstStopTime: day1DepartTime(true) });
    store.set('wlPlanIssue', '');
  } catch(e) {
    // Locks/appointments make this impossible — leave the days exactly as they are.
    // Bare-swallowing it was nearly harmless while the start date was always today;
    // now that the installer can pick the day, it is one tap away (choose Thursday
    // with a Wednesday appointment ⇒ "…is dated before the route starts") and a
    // silently frozen route is the worst way to say so. Park the message for the
    // plan-date hint to paint.
    store.set('wlPlanIssue', String((e && e.message) || 'Route constraints cannot be met'));
    paintPlanDate();
    return;
  }

  const byId = {}; items.forEach(x => { byId[x.id] = x; });
  let i = 0;
  for(const id of schedule.orderedIds){
    const item = byId[id]; if(!item) continue;
    const order = (i++) * 10;
    const day = schedule.dayOf[id] || '';
    const s = schedule.scheduleById[id] || {};
    // Keep the exact ETA only when the stop has not moved AND still belongs to the
    // same calendar day. Position alone was enough while the plan day was always
    // today; now that it rolls, an order sitting still keeps a scheduledDate for a
    // day that has passed — which is how a Day 1 ends up holding two different
    // dates and its divider showing yesterday.
    // The ETA is part of that comparison now. It was keyed on position + date
    // alone, which was safe only while the day's clock was the constant 08:15:
    // with a clock that moves, a stop can sit at the same position on the same
    // date and still be due at a different time, and the skip threw exactly the
    // update the installer asked for ("every time I complete an order the ETA
    // should update"). It fires on the paths where nothing shifts — a walk-up
    // logged off-list, a Download landing the same sequence.
    if(item.order === order && item.day === day
       && String(item.scheduledDate || '') === String(s.date || '')
       && String(item.scheduledEta || '') === String(s.eta || '')) continue;
    await idb.put('worklist', Object.assign({}, item, {
      order, day,
      scheduledDate:s.date || '', scheduledEta:s.eta || '',
      scheduledSlot:s.slot || '', scheduledWaitMin:s.waitMin || '',
      scheduledLateMin:s.lateMin || '',
      // The on-site half rides with the ETA it belongs to. Left behind, it kept
      // the last Optimize's value through every re-anchor — and the day divider
      // and the route view both read it.
      scheduledOnSiteMin:s.onSiteMin || '',
      updatedAt:stamp(),
    }));
  }
  // The flag describes the MODEL that produced these times, not which function
  // called. It used to mean "somebody re-anchored, therefore estimated", which was
  // true only while a re-anchor could not measure anything — now rung A of the
  // ladder measures the same road graph Optimize does, and a "~" on those numbers
  // would be a lie in the opposite direction.
  //
  // The `wrote` gate is gone with it. A run that changed no ETA still re-derived
  // them from a model, and it is precisely when the MODEL moved without the numbers
  // moving much — a pack finishing its download mid-day — that the label has to
  // follow. Optimize (opts.travel) still owns the flag through `base.estimatedTimes`.
  if(!(opts && opts.travel)) store.set('wlTimesEstimated', travel && travel.measured ? '' : '1');
}

// ── on-pace projection (drive mode + tuning what-if) ────────────────────────
// Real-data inputs for projectDayReal (js/compute/estimate.js), all offline, and
// every minute of drive in them priced by ONE model:
//   done + on-site pace    ← today's logged stops (dayCache), each WO→WO gap net of
//                            the drive the ETA ladder measures for that very leg
//   remaining route travel ← that same ladder walked along today's pending chain
//
// This is the travel/on-site split the installer asked for, and the split is only
// honest while both halves are priced the same way. A morning netted with one
// number and an afternoon priced with another is two models of one day, and the
// gauge reads the difference between them as pace.
//
// **It used to be two models, and this is the account of what that cost.** The
// remaining route was pending legMetres ÷ `liveMetrics().avgMovingSpeed`, while the
// morning had a flat ten minutes a leg taken off it. avgMovingSpeed is distance ÷
// (elapsed − idle) over the whole day, and "idle" is anything at or under
// drive-track.js IDLE_SPEED_MS — 0.5 m/s, i.e. 1.8 km/h. The recorder runs whenever
// the PWA is open, INCLUDING while the crew is on foot at a meter, so dooryard
// minutes and GPS jitter land in the numerator as "moving" and drag the average
// down without bound. A rural day driving 60–80 on the concessions reported 18, and
// a `speed > 1` m/s guard let it straight through; a 25 km/h floor was added to
// catch that, and did not, because the number it had to catch was 28.
//
// A day on the 2026-07-31 route made the failure exact. Between two readings 27
// minutes apart the crew logged an off-plan walk-up, so `done` rose while the route
// ahead did not change by one metre — a controlled experiment nobody meant to run.
// Remaining travel went 196 → 241 minutes on an unchanged 110.8 km, purely because
// the tile drifted 34 → 28 km/h; the crew had covered 0.2 km in ~21.6 "moving"
// minutes, standing at a property. The card fell from "~15 by 3:45" to "~13" — to
// projecting ZERO of the eight stops in front of it, over three and a quarter hours
// — while the stop card directly beneath it read "Arrive 12:36 · in 5 min". The
// feedback loop ran backwards: the longer the crew spent installing, the slower they
// looked, the longer the drive home looked, and the fewer installs the gauge
// promised. Meanwhile the route's own scheduledEta chain landed the last stop at
// 14:45, 51 minutes earlier than the card's "Route done ~5:36 pm".
//
// So no day-average speed prices this route, raised floor or otherwise. Effective
// door-to-door speed climbs steeply with leg length — that same morning averaged
// 2.2 km a leg around a village, the afternoon 13.9 with a 58.7 km highway haul in
// it — and one number cannot be right at both ends. The ladder already answers per
// leg, on road classes, and it is what every other ETA on the screen is built from.
//
// `avgMovingSpeed` itself is deliberately left alone: it is also the office-side leg
// summary uploaded to DriveTracks, read by the map viewer and by
// installerOnSiteFromTracks, so redefining it would reach well past this projection.
// It simply no longer prices anything here.

// Today's pending stops = the DAY-1 group of the live route; a multi-day route only
// counts day 1 toward today's landing. Blank day sorts as day 1.
//
// Day 1 strictly, not "the lowest day number present". A finished day — every order
// in today's committed set logged — leaves Day 1 empty with days 2+ still full, and
// a min-day read would quietly hand the pace gauge tomorrow's chunk: today's installs
// captioned against a route nobody is driving today, and a "Route done ~" clock for
// it. Empty is the honest answer — drivePace returns null and the card hides, because
// today's work is done.
//
// Meeting the meters/day target no longer empties Day 1: the target sizes the day when
// it is planned and then lets go, so installing past it leaves the remaining orders
// exactly where they were and shows up on the gauge as being ahead (`targetOver` in
// js/compute/estimate.js). It used to zero `dayCapacity`, zero `day1Count`, and stamp
// every remaining order day 2+ — which took the card off the screen mid-afternoon
// with work still in front of the crew. See js/route-today.js.
function todayPending(pending){
  if(!pending.length) return pending;
  const dayOf = p => Number(p.day) || 1;
  return pending.filter(p => dayOf(p) === 1);
}

// Today's day-1 route, worked and unworked alike, in live order — the frame the
// day's single travel lookup is built over.
//
// It has to carry the DONE orders and not just the pending ones. The remaining
// route only ever asks about the chain still in front of the crew, but netting the
// observed cadence asks for the drive between stops that are already BEHIND them,
// and a travelLookup answers only for ids that were in the frame it was built from.
// Two frames would mean two lookups, which is two models of one day again — the
// exact thing the header above is an account of. One frame, one ladder, one answer.
//
// Ignored orders are out (they are not on any route), and so is day 2+: `pending`
// arrives already filtered through todayPending, and done orders are pruned to the
// day they were logged (pruneDoneWorklist), so "done" here means done TODAY.
function paceRouteItems(items, pending){
  const inPending = new Set(pending.map(p => p.id));
  return (items || []).filter(x => x
    && (inPending.has(x.id) || (x.wlStatus === 'done' && !isIgnored(x))));
}

// One leg's drive in minutes, from the day's lookup, with NOMINAL_TRAVEL_MIN for a
// pair it cannot answer for. Unroutable pairs are already repaired crow-flies
// inside the ladder itself, so null here means an id that was never in the frame:
// an off-plan walk-up (no worklist row to be in the frame), or an order added since
// the lookup was built. One nominal leg is absorbed by the median on the on-site
// side, and is a rounding error against the route total on the other.
function legDriveMin(travel, fromId, toId){
  const v = (travel && fromId != null && toId != null) ? travel.between(fromId, toId) : null;
  return (v != null && isFinite(v)) ? v : NOMINAL_TRAVEL_MIN;
}

// The drive out to the next stop, from wherever the crew actually is. estimateTravel
// anchors the frame's origin on the live GPS fix, else the last completed driveway,
// else the muster point — so this is the same measurement the arrival badge on the
// stop card is built from, by construction rather than by agreeing on a good day.
function firstLegDriveMin(travel, toId){
  const v = (travel && toId != null) ? travel.fromStart(toId) : null;
  return (v != null && isFinite(v)) ? v : NOMINAL_TRAVEL_MIN;
}

// Real remaining route travel: the day's lookup walked along the pending chain, as
// a PER-LEG list plus its total and per-stop average. Pure — `travel` is built once
// by paceContext and shared with the on-site half, so the two cannot drift.
//
// `legMin` is the load-bearing one and the total is the convenience. A projection
// against a horizon has to know WHICH drive belongs to which stop: the day's last
// leg is routinely the long one home, and a model handed only the sum charges that
// drive against the stops before it — see js/compute/estimate.js paceFor.
function routeTravel(pending, travel){
  const legMin = pending.map((p, i) => i === 0
    ? firstLegDriveMin(travel, p.id)
    : legDriveMin(travel, pending[i - 1].id, p.id));
  const totalMin = legMin.reduce((a, m) => a + m, 0);
  return { legMin, totalMin,
    perStopMin: pending.length ? totalMin / pending.length : NOMINAL_TRAVEL_MIN };
}

// Real on-site minutes/stop: today's observed WO→WO cadence, net of logged delay
// and of the drive each gap actually contains, falling back to the measured dwell
// before there are two stops to measure.
//
// The arithmetic — netting the deductions out and taking the MEDIAN rather than the
// mean, which is what stops one hold-up wrecking the rest of the day — lives in
// js/compute/cadence.js observedOnSiteMin, with the full account of why.
//
// **The drive is netted per leg, not stripped from the median afterwards.** It used
// to be `onSiteMinutes(observed)`: subtract one flat NOMINAL_TRAVEL_MIN, then floor
// at MIN_ONSITE_MIN. On 2026-07-31 the median gap was 16.25 minutes over legs the
// crew really drove in two or three, so ten came off a drive that never happened,
// 6.25 came out the far side, and the floor put it back to 8 — an on-site figure
// arrived at by two mistakes cancelling. The true figure was near 14 (and the
// crew's own fitted InstallerMetrics.landOnSiteMin says 11), so the gauge was
// crediting each remaining stop with six minutes it did not have. That error points
// the OPPOSITE way to the travel bug it shipped beside, which is why the projection
// could be catastrophically wrong while looking merely optimistic.
//
// The floor survives as a floor and nothing more: a pathological median (two stops
// logged a minute apart) must not divide the afternoon into hundreds of installs.
// It should not bind on any real day now that the subtraction is honest.
//
// Today's own cadence still beats any historical average once there is some: it is
// the only thing that knows about today's weather, ferry, or bad access. Before the
// second stop of the day there is none, and the measured dwell is a far better
// stand-in than pace-minus-a-guess.
//
// `idByWO` maps workOrderId → worklist id, because a gap is keyed on the STOPS row
// the crew logged and the lookup is keyed on the worklist row it came from. A stop
// with no worklist row — a walk-up — resolves to neither end and takes the nominal.
function onsitePerStopReal(stops, downtime, pending, travel, idByWO){
  const printable = (stops || []).filter(s => PRINTABLE[s.status]);
  const gaps = computeGapsLocal(printable, downtime || [], pending, false)
    .map(g => ({ ...g, driveMin: legDriveMin(travel, idByWO[g.fromWO], idByWO[g.toWO]) }));
  const observed = observedOnSiteMin(gaps);
  if(observed == null) return dwellShape().base;
  return Math.max(MIN_ONSITE_MIN, observed);
}

// Assemble the real inputs. Async — reads the dayCache + worklist. `finishByMin`
// is the end of the working day (config.js ROUTE_DAY_END) — it answers "will the
// remaining route land before knock-off", which is a projection, NOT a day-sizing
// input; nothing here shrinks a route. It used to be the installer's Finish-by
// dial, and callers could override it for a what-if against a dragged value.
export async function paceContext(){
  const c = cfg();
  const cached = c.name ? await idb.get('dayCache', `${c.name}|${localDate()}`) : null;
  const stops = (cached && cached.stops) || [];
  const items = await allSorted();
  const pending = todayPending(pendingOf(items));
  // ONE lookup, built over the whole of today's route and shared by both halves
  // below. Steady-state this is about what re-measuring a single leg used to cost:
  // the stop×stop matrix is cached inside the ladder and a subset of a measured set
  // is a hit, so all that is re-run per repaint is the one Dijkstra for the node
  // that actually moved — the truck.
  const frame = paceRouteItems(items, pending);
  const travel = frame.length ? await estimateTravel(frame, items) : null;
  const legs = routeTravel(pending, travel);
  const idByWO = {};
  for(const x of frame)
    if(x.workOrderId != null && x.workOrderId !== '') idByWO[String(x.workOrderId)] = x.id;
  return {
    stops,
    pendingCount: pending.length,
    remainingTravelMin: legs.totalMin,
    // Per leg, in route order — what lets the projection stop charging the stops it
    // CAN reach for the drive out to the ones it cannot.
    legTravelMin: legs.legMin,
    avgLegTravelMin: legs.perStopMin,
    // The day's logged delays ride along so they aren't charged as install time.
    // Both already sit in the record opened above; `eodTravel` is the offline
    // review's not-yet-synced allocations and wins over the synced rows, exactly
    // as it does in capture.js's end-of-day editor.
    onsitePerStop: onsitePerStopReal(stops, (cached && cached.downtime) || [],
                                     (cached && cached.eodTravel) || null, travel, idByWO),
    finishByMin: hhmmMin(ROUTE_DAY_END),
    // What "on pace" is measured against. Read live from the box like everywhere
    // else — the same value that sized the day, so the gauge and the route agree.
    target: targetVal(),
    dayClosed: dayClosed(),
  };
}

// A second device logs nothing itself, so nothing on it ever invalidates the
// dayCache — and the whole pace projection is read off that cache. drive.js
// repaints every few seconds, which would just re-read the same stale copy, so
// the pull is throttled here on its own much slower clock. Best-effort and
// online-only inside cacheRecentDays; a failure leaves the last good copy.
//
// It matches drive.js's AUTO_SYNC_MS on purpose. This is the GPS-fix-driven pull —
// it fires as a side effect of a repaint, so it stalls whenever fixes stop (a Maps
// hand-off, GPS denied, a phone that isn't recording); autoSync is the one on a
// real clock. Two refresh paths with two different periods would just be two
// clocks disagreeing about how fresh "fresh" is, so there is one number.
const PACE_REFRESH_MS = 3 * 60 * 1000;
let paceCacheAt = 0;
async function refreshPaceCache(){
  const now = Date.now();
  if(now - paceCacheAt < PACE_REFRESH_MS) return;
  paceCacheAt = now;                       // stamped BEFORE the await, so a slow
  try { await cacheRecentDays(1); }        // call can't stack up behind itself
  catch { /* keep the last good cache */ }
}

// Drive-mode provider: the live two-pace projection, or null when there's no route
// left to project (nothing pending today). drive.js formats it.
async function drivePace(){
  await refreshPaceCache();
  const ctx = await paceContext();
  if(!ctx.pendingCount) return null;
  const est = projectDayReal(ctx);
  return est.ready ? est : null;
}

// ── plan mode ───────────────────────────────────────────────────────────────
export function planActive(){ return store.get('planMode') === '1'; }

// Turn plan mode off from outside this module (capture.js calls it when the day
// is closed out — the plan is spent, so the form should stop following the list).
export async function exitPlan(){ if(planActive()) await setPlan(false); }

function paintPlanToggle(){
  const on = planActive();
  $('wlPlanToggle').classList.toggle('toggle-on', on);
  $('wlPlanToggle').textContent = on
    ? 'Plan mode ✓ — capture form follows this list'
    : 'Plan mode: off';
}

async function setPlan(on){
  store.set('planMode', on ? '1' : '');
  paintPlanToggle();
  if(on){ await planAdvance(); toast('Plan mode on — form follows the worklist'); }
  else { fillCapture(null); $('planBanner').classList.add('hide'); }
}

// Load the next pending order into the capture form + refresh the banner.
// Called on page load, after every logged stop, and whenever the list changes.
// A no-op while plan mode is off.
export async function planAdvance(){
  // Every logged meter changes what is left of the day, including a walk-up that
  // matches no planned order (markWorklistDone returns early on those and never
  // anchors). capture.js calls planAdvance after EVERY stop, so this is the hook that
  // re-TIMES today; it sits above the plan-mode guard because the day's shape is just
  // as real when the installer is logging without plan mode on.
  //
  // It passes no opts, and must not start: `replan` is the only thing that re-sizes
  // the day, and a logged stop is not the installer asking for a different day. This
  // hook used to shrink Day 1 by the meters logged, which is how a committed list's
  // tail ended up on tomorrow (js/route-today.js).
  await applyTodayAnchor();
  if(!planActive()){ $('planBanner').classList.add('hide'); return; }
  const items = await allSorted();
  const pending = pendingOf(items);
  // Set-aside orders are out of the plan, so they must not inflate the "3 of 12"
  // count either — the installer is being told how far through the ROUTE they are.
  const inPlan = items.filter(x => x.wlStatus === 'done' || !isIgnored(x));
  const aside = items.length - inPlan.length;
  const asideNote = aside ? ` · ${aside} set aside` : '';
  const banner = $('planBanner'); banner.classList.remove('hide');
  await renderPlanEstimate();
  if(!items.length){
    $('planBannerText').textContent = 'Plan: worklist is empty';
    fillCapture(null);
    return;
  }
  if(!pending.length){
    $('planBannerText').textContent = inPlan.length
      ? `Plan: all ${inPlan.length} orders done ✓${asideNote}`
      : `Plan: nothing to do — every order is set aside`;
    fillCapture(null);
    return;
  }
  const item = pending[0];
  const pos = inPlan.length - pending.length + 1;
  $('planBannerText').textContent =
    `Plan: WO ${item.workOrderId || '—'} · ${pos} of ${inPlan.length}${asideNote}`;
  fillCapture(item);
}

// Quiet landing estimate beside the plan banner — the same real-data two-pace
// model the Drive-screen on-pace line uses (drivePace), compacted to one line:
// projected count for the installer's target finish and for working hours. Hidden
// when there's no route to project.
async function renderPlanEstimate(){
  const el = $('planEstimate'); if(!el) return;
  const est = await drivePace();
  const paces = est ? [est.paces.target, est.paces.work].filter(Boolean) : [];
  const txt = paces.map(p => `~${p.projected} by ${p.label}`).join(' · ');
  el.textContent = txt;
  el.classList.toggle('hide', !txt);
}

// Skip = send the current order to the back of the pending queue and load the
// next one (persistent, so the skipped house comes around again at the end).
async function planSkip(){
  const items = await allSorted();
  const pending = pendingOf(items);
  if(pending.length < 2){ toast('Nothing to skip to'); return; }
  const head = pending[0];
  const maxOrder = Math.max(...items.map(x => x.order == null ? 0 : Number(x.order)));
  await idb.put('worklist', Object.assign({}, head, { order: maxOrder + 10, updatedAt: stamp() }));
  await renderWorklist();
  await planAdvance();
}

// ── wiring ──────────────────────────────────────────────────────────────────
// capture.js calls this once with { fillCapture }. Also restores the screen if
// the page was reloaded on #worklist, and re-arms the plan banner.
export function initWorklist(opts){
  fillCapture = (opts && opts.fillCapture) || fillCapture;
  routeView = initWorklistRouteView({
    getItems: allSorted,
    routeVariant: activeVariant,
    // The installer's current tuning weights, shown on the route so they can see
    // what produced it (the phone owns these; they ride up on the next sync).
    weights: () => ({ commutePull:pullVal(store.get('wlCommutePull')), target:targetVal() }),
    timesEstimated: () => store.get('wlTimesEstimated') === '1',
    // One parked failure drives three surfaces — the plan-date hint, the route
    // view's header note, and every ETA on it — so they cannot disagree the way
    // the map's ETA and the worklist's warnings used to.
    planStale,
    planIssue: () => store.get('wlPlanIssue') || '',
    persistOrder: async ordered => {
      const current = (await idb.all('worklist')) || [];
      const byId = new Map(current.map(x => [String(x.id), x]));
      const now = stamp();
      for(const item of ordered){
        const before = byId.get(String(item.id));
        if(before && needsOrderWrite(before, item))
          await idb.put('worklist', Object.assign({}, item, { updatedAt:now }));
      }
      await planAdvance();
    },
    onClose: () => location.hash === '#worklist-route' ? history.back() : openWorklist(),
    onFix: () => location.hash === '#worklist-route' ? history.back() : openWorklist(),
  });
  addrFill = initWorklistAddressFill({
    getItems: allSorted,
    saveAddress: saveWorklistAddress,
    pickTown,
    onDone: afterAddressFill,
    onClose: () => location.hash === '#worklist-address' ? history.back() : openWorklist(),
  });
  driveView = initDrive({
    getPending: async () => pendingOf(await allSorted()),
    getPace: drivePace,
    // The same two flags the route view reads, for the same reason: the Drive card
    // now shows a `scheduled*` field, so it has to say when that field is estimated
    // and when the last solve left it stale. A surface that shows one of these
    // without consulting both is how "the map says 09:55 but the warning says 10:13"
    // happens (AGENTS.md §wlPlanIssue).
    getEtaMeta: () => ({
      estimated: store.get('wlTimesEstimated') === '1',
      stale: planStale(),
    }),
    autoSync,
    openDirections,
    onClose: () => location.hash === '#drive' ? history.back() : openWorklist(),
  });
  // Hand the dwell model down rather than letting the tuning screen re-derive it:
  // two copies of the "override beats measurement" precedence is exactly how the
  // readout and the route end up disagreeing. Same pattern as getPaceContext.
  tuning = initWorklistTuning({
    getPaceContext: paceContext,
    getDwell: dwellShape,
    getMeasuredOnSite: measuredOnSiteMin,
    getOnSiteSourceLabel: onSiteSourceLabel,
    onOnSiteChanged: paintOnSiteHint,
  });
  $('wlBack').onclick = closeWorklist;
  $('wlDrive').onclick = openDriveScreen;
  $('wlViewRoute').onclick = openWorklistRoute;
  $('wlFillAddr').onclick = openAddressFill;
  $('wlDedup').onclick = runDuplicateScan;
  $('wlUpload').onclick = wlUpload;
  $('wlDownload').onclick = wlDownload;
  bindOptimizeGesture($('wlOptimize'),
    () => optimizeRouteHandler(false),
    () => optimizeRouteHandler(true));
  $('wlDayLock').onclick = () => toggleDayLock();
  $('wlAddToExtend').onclick = () => acceptAddTo();
  $('wlAddToLater').onclick  = () => { hideAddTo(); toast('Left for later'); };
  $('wlVariantRoad').onclick = () => switchVariant('road');
  $('wlVariantStraight').onclick = () => switchVariant('straight');
  $('wlPlanDate').onchange = planDateChanged;
  paintPlanDate();
  // Meters/day target: restore the saved value (default 24) and persist edits.
  //
  // Persisted on INPUT as well as change. `change` fires only on blur, and
  // `targetVal()` reads the LIVE field — so an installer who typed a new number and
  // then backgrounded the app, or left the screen with the field still focused, got
  // a route built at the number they typed and a box that said the old one again on
  // the next open. Reported exactly that way: "I set it to 20 and it isn't saving",
  // with a route that was demonstrably built for 20.
  //
  // Clamping stays on `change` only: rewriting the field mid-keystroke fights the
  // typing. A partial number can therefore be stored if the app is abandoned
  // between keystrokes — but that leaves a visible wrong number in the box rather
  // than silently discarding the edit, which is the better of the two failures.
  const persistTarget = () => {
    if(dayLocked()) return;
    const n = Math.floor(Number($('wlTarget').value));
    if(isFinite(n) && n > 0) store.set('wlTarget', String(n));
  };
  $('wlTarget').value = String(Math.max(1, Math.floor(Number(store.get('wlTarget')) || 24)));
  $('wlTarget').oninput = persistTarget;
  // …and a settled target has to RE-SPLIT the days, not just get stored. While the
  // list is UNLOCKED that is all it takes: nothing is frozen, so the re-schedule
  // chunks every day by the new number. This used to have to fight a `needsCommit`
  // that could only be persuaded to re-freeze by a `replan` + `resize` pair, and a
  // typed target that failed to pass it moved nothing at all in either direction —
  // reported as "I can't even change the amount of orders that populate the list
  // with the target value. They get stuck on a different value and never got
  // updated." There is nothing left to persuade.
  //
  // While LOCKED the box is inert and the typed value is reverted. `readOnly` alone
  // is not enough — a number input's spinner and a date input's picker both ignore
  // it on some browsers — so the handler is the real guard and the attribute is the
  // affordance.
  $('wlTarget').onchange = async () => {
    if(dayLocked()){
      $('wlTarget').value = String(anchorTarget(loadAnchor()) || targetVal());
      toast('Work list is locked — unlock to change the target');
      return;
    }
    const v = targetVal();
    $('wlTarget').value = String(v);
    persistTarget();
    paintTargetHint();
    // The ONE caller that asks for a re-chunk. Nothing has re-solved the route, so
    // the `day` tags still describe the OLD number and holding them — which is what
    // every passive re-schedule does — would make a changed target do nothing at all
    // in either direction. Optimize does not need this: it rewrites every tag at the
    // new target before it calls, so holding them there is already the fresh split.
    await applyTodayAnchor({ rechunk: true });
    await renderWorklist();
    await planAdvance();
  };
  loadPlanFields();
  // Pace has the same lost-edit shape the target had, for the same reason:
  // planShape() and offerAddTo() read $('wlPace').value LIVE, but the store write
  // hung off `change`, which fires only on blur. A pace typed and then abandoned
  // (app backgrounded with the field still focused) shaped the route and was then
  // thrown away. Persist on input like wlTarget — guarded to a finite positive
  // number so a mid-clear blank writes nothing over a real value.
  // Read the RAW number before any clamp: Number('') is 0, so a blank box fails
  // `n > 0` and writes nothing. Clamping first would turn that 0 into a 1 and pin
  // a one-minute-per-stop override the moment the installer selects-all and types.
  const persistPace = () => {
    const n = Number($('wlPace').value);
    if(isFinite(n) && n > 0){
      store.set('wlPaceMin', String(Math.max(1, Math.round(n))));
      store.set('wlPaceSource', 'override');
    }
  };
  $('wlPace').oninput = persistPace;
  // …and a CLEARED box reverts to the measured pace instead of pinning one.
  // Blanking it used to land paceMin at the flat 30 fallback flagged as an
  // 'override', and refreshAvgDay refuses to overwrite an override — so the
  // installer's real 30-workday pace could never come back, on this device, ever.
  // This mirrors the on-site override box's documented "leave blank to use it".
  // It is also what makes persisting on INPUT safe: without a recovery path, a
  // half-typed number would pin an override that nothing ever heals.
  $('wlPace').onchange = () => {
    if(!String($('wlPace').value).trim()){
      store.set('wlPaceSource', wlAvgLogMin ? 'recent30' : 'fallback');
      $('wlPace').value = String(wlAvgLogMin || 30);
      savePlanLocal();
      // The same two strings refreshAvgDay paints, so the hint never claims an
      // override that is no longer there.
      $('wlPaceHint').textContent = wlAvgLogMin
        ? `Recent 30-workday pace: ${wlAvgLogMin} min/stop`
        : 'No pace history yet — using the editable 30 min/stop fallback.';
      return;
    }
    store.set('wlPaceSource', 'override');
    const p = savePlanLocal(); $('wlPace').value = String(p.paceMin);
    $('wlPaceHint').textContent = `Plan override: ${p.paceMin} min/stop`;
  };
  $('wlTimed').onchange = paintTimedFields;
  $('wlPlanToggle').onclick = () => setPlan(!planActive());
  $('planSkip').onclick = planSkip;
  $('planExit').onclick = () => setPlan(false);
  // Tap = the single-order form (the old onclick toggle, verbatim); a
  // two-second hold = the bulk-paste sheet. Same binder as Optimize, so the
  // pointer-capture / synthetic-click / contextmenu lessons carry over.
  bindOptimizeGesture($('wlAddBtn'),
    () => {
      if(!$('wlForm').classList.contains('hide')){
        $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; return;
      }
      wlOpenForm(null);
    },
    () => openBulkAdd());
  $('wlBulkSave').onclick = wlBulkAdd;
  $('wlBulkCancel').onclick = () => $('wlBulkAdd').classList.add('hide');
  $('wlFormCancel').onclick = () => { $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; };
  $('wlFormSave').onclick = wlSave;
  pruneDoneWorklist().then(applyTodayAnchor).then(() => {
    if(location.hash === '#worklist-route'){
      // A direct reload has no #worklist history entry. Seed it so the phone's
      // hardware Back button still returns through list, then capture.
      history.replaceState({}, '', location.pathname + location.search);
      history.pushState({ wl:1 }, '', '#worklist');
      history.pushState({ wlRoute:1 }, '', '#worklist-route');
      openWorklistRoute();
    } else if(location.hash === '#worklist-address'){
      // Same seeding as the route map: a direct reload has no #worklist entry
      // behind it, so Back would leave the app instead of returning to the list.
      history.replaceState({}, '', location.pathname + location.search);
      history.pushState({ wl:1 }, '', '#worklist');
      history.pushState({ wlAddr:1 }, '', '#worklist-address');
      openAddressFill();
    } else if(location.hash === '#drive'){
      // Same history seeding, so Back returns through the worklist, then capture.
      history.replaceState({}, '', location.pathname + location.search);
      history.pushState({ wl:1 }, '', '#worklist');
      history.pushState({ drive:1 }, '', '#drive');
      openDriveScreen();
    } else if(location.hash === '#worklist'){
      history.replaceState({}, '', location.pathname + location.search);
      history.pushState({ wl:1 }, '', '#worklist');
      openWorklist();
    }
    planAdvance();
  });
}
