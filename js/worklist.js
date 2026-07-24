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
import { stamp, localDate, hhmmMin } from './time.js';
import { apiGet, apiPost } from './api.js';
import { optimizeRoute, coordsOf, isParked, geocodeOne, legMetersFor, homeLegMetersFor } from './route.js';
import { initWorklistRouteView, needsOrderWrite } from './worklist-route-view.js';
import { initDrive } from './drive.js';
import { createDragAutoScroll } from './drag-autoscroll.js';
// The address helpers (split/join/recent streets) live with the fill-in screen —
// it is the module that exists to put an address on an order.
import {
  addressQueue, hasNoAddress, initWorklistAddressFill, joinAddr, recentStreets,
  sinkAddressless, splitAddr,
} from './worklist-address-fill.js';
import { dedupePlan, normalizeWo } from './worklist-dedup.js';
import { ROUTE_DEPART_TIME } from './config.js';
import { addWorkdays, currentRoutePlacement, scheduleRouteConstraints } from './route-constraints.js';
import {
  VARIANTS, VARIANT_FIELDS, VARIANT_LABELS, applyVariant, fmtKm, isIgnored, isPending,
  liveDayMeters, pendingOf, routeTotalSummary, variantSelectable, variantSummary,
} from './route-variants.js';

let fillCapture = () => {};     // set by initWorklist (capture.js)
let planEstimate = null;        // set by initWorklist (capture.js): async () => string
let _wlEditId = null;           // null = new order, string = id being edited
let routeView = null;           // initialized once the capture page DOM is ready
let addrFill = null;            // the address fill-in walkthrough (same)
let driveView = null;           // the #drive driving screen (same)

function startHereArmed(){ return $('wlStartHere').getAttribute('aria-pressed') === 'true'; }
function setStartHere(on){ $('wlStartHere').setAttribute('aria-pressed', on ? 'true' : 'false'); }

function nextWeekday(date){
  const d = new Date(`${date}T12:00:00`);
  while(d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// A commute-pull dial value clamped to the 0–100 integer range; blank/garbage
// falls back to the 70 default (the tuning screen is the only writer).
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}
function planShape(){
  return {
    routeStartDate:nextWeekday(localDate()),
    firstStopTime:ROUTE_DEPART_TIME,
    paceMin:Math.max(1, Math.round(Number($('wlPace').value) || 30)),
    paceSource:store.get('wlPaceSource') || 'fallback',
    routeVariant:activeVariant(),
    straightDistanceSource:store.get('wlStraightDistanceSource') || '',
    commutePull:pullVal(store.get('wlCommutePull')),
    finishBy:store.get('wlFinishBy') || '14:00'
  };
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
function loadPlanFields(plan){
  const p = plan || {};
  $('wlPace').value = String(Math.max(1, Number(p.paceMin || store.get('wlPaceMin')) || 30));
  store.set('wlPaceSource', p.paceSource || store.get('wlPaceSource') || 'fallback');
  if(p.routeVariant) store.set('wlRouteVariant', p.routeVariant === 'straight' ? 'straight' : 'road');
  if(p.straightDistanceSource) store.set('wlStraightDistanceSource', p.straightDistanceSource);
  if(p.commutePull !== '' && p.commutePull != null) store.set('wlCommutePull', String(p.commutePull));
  if(p.finishBy) store.set('wlFinishBy', p.finishBy);
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
    legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || '') };
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
      installer:c.name, hNumber:c.hNumber, orders: items.map(wireShape), plan:savePlanLocal() }));
  } catch { /* best-effort — the manual ⇪ Upload is the loud fallback */ }
}

async function wlDownload(){
  const c = cfg();
  if(!c.hNumber){ toast('Set your employee number in Settings first'); return; }
  if(!navigator.onLine){ toast('Offline — download needs signal'); return; }
  const local = await allSorted();
  if(local.length && !confirm(`Replace the ${local.length} orders on this phone with your saved copy from the sheet?`)) return;
  try {
    const r = await withActivity('Downloading worklist…', () => apiGet('worklist', { hNumber: c.hNumber }));
    if(!r || !r.ok){ toast('Download failed — ' + ((r && r.error) || 'try again')); return; }
    for(const k of (await idb.keys('worklist')) || []) await idb.del('worklist', k);
    // Normalize each sheet row back to the exact local record shape (drop the
    // sheet-only installer/hNumber columns, re-type wlStatus + lat/lng) so
    // sorting, plan mode, and markWorklistDone keep working after a round trip.
    // `order` is renumbered by array position: the spine returns rows sorted
    // (and renumbers on upload), and even against a stale spine the sheet's
    // physical row order is the last upload's display order — so a Download
    // always lands a clean 0,10,20… locally, healing any historical
    // duplicate/blank order values.
    const list = r.orders || [];
    for(let i = 0; i < list.length; i++){
      const o = list[i];
      await idb.put('worklist', {
        id:String(o.id), workOrderId:String(o.workOrderId||''), unit:String(o.unit||''),
        address:String(o.address||''), oldJNumber:String(o.oldJNumber||''),
        wlStatus: o.wlStatus === 'done' ? 'done' : 'pending',
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
        legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || '') });
    }
    if(r.plan) loadPlanFields(r.plan);
    toast(`Downloaded ${(r.orders || []).length} orders ✓`);
    await renderWorklist();
    await planAdvance();   // the first pending order may have changed
  } catch { toast('Download failed — check signal'); }
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

async function optimizeRouteHandler(straightLine){
  if(!navigator.onLine){ toast('Offline — route optimization needs signal'); return; }
  const pending = pendingOf(await allSorted());
  if(pending.length < 2){ toast('Need at least 2 pending orders to optimize'); return; }
  const algorithm = straightLine
    ? 'straight-line algorithm'
    : 'road-matrix algorithm (with straight-line fallback if road distances are unavailable)';
  const startFromCurrent = startHereArmed();
  const startNote = startFromCurrent ? ' The route will start from your phone location.' : '';
  if(!confirm(`Optimize the route for ${pending.length} pending orders using the ${algorithm}?${startNote} This looks up each address and may take a minute the first time.`)) return;

  const target = targetVal();
  const btn = $('wlOptimize'), prog = $('wlRouteProgress');
  btn.disabled = true; prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try {
    const home = await homePin();
    // compareVariants only ever rides the road-matrix press. On a straight-line
    // tap route.js ignores it outright — there is no road matrix to compare
    // against, and this must never be the thing that causes one.
    const base = await optimizeRoute(pending, updateRouteProgress, home, {
      straightLine, startFromCurrent, compareVariants: !straightLine,
      target, dayFinishBy: hhmmMin(planShape().finishBy), departMin: hhmmMin(ROUTE_DEPART_TIME),
      paceMin: planShape().paceMin, commutePull: planShape().commutePull
    });
    const { parkedIds, usedFallback, fallbackReason, mode, startFallback, geoReason, note } = base;
    const refreshed = await allSorted();
    const refreshedById = {}; refreshed.forEach(x => { refreshedById[x.id] = x; });
    const blocked = parkedIds.map(id => refreshedById[id]).filter(x =>
      x && (x.appointmentDate || x.lockedDate));
    if(blocked.length) throw new Error('Fix the address before routing constrained ' +
      blocked.map(x => `WO ${x.workOrderId || x.id}`).join(', '));
    const planOpts = { ...planShape(), target: base.dayTarget || target };
    // Schedule and price EACH route this run produced. Constraint placement can
    // move stops, so the legs must be measured after it — and both variants are
    // measured against the same matrix, which is what makes their totals
    // comparable rather than road-km-versus-crow-flies.
    const computed = {};
    for(const v of VARIANTS){
      const variant = base.variants[v];
      if(!variant) continue;
      const routedItems = variant.orderedIds.map(id => refreshedById[id]).filter(Boolean);
      const s = scheduleRouteConstraints(routedItems, variant.orderedIds, planOpts);
      computed[v] = { ...s, legMeters: legMetersFor(base.measure, s.orderedIds, s.dayOf),
        homeLegMeters: homeLegMetersFor(base.measure, s.orderedIds, s.dayOf) };
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
    for(const v of Object.keys(computed)){
      const c = computed[v], pos = {};
      [...c.orderedIds, ...parkedIds].forEach((id, n) => {
        pos[id] = { order:n * 10, day:c.dayOf[id] || '',
          legMeters:c.legMeters[id] == null ? '' : c.legMeters[id],
          homeLegMeters:c.homeLegMeters[id] == null ? '' : c.homeLegMeters[id] };
      });
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
        scheduledSlot:s.slot||'', scheduledWaitMin:s.waitMin||'', updatedAt:stamp()
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
        // Sequence changed → saved road geometry is keyed to the old order. The
        // phone never re-fetches geometry (only the desktop does), so clear it and
        // let the route map fall back to straight legs until a desktop re-optimize.
        patch[f.geometry] = '';
      }
      await idb.put('worklist', Object.assign({}, item, patch));
    }
    store.set('wlRouteVariant', primaryVariant);
    if(base.variants.straight) store.set('wlStraightDistanceSource', base.straightDistanceSource);
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
    const extra = ` · ${fmtKm(totalM)}`
      + (days > 1 ? ` · ${days} days of ${target}` : '')
      + (usedFallback ? ` — straight-line (${short(fallbackReason)})` : '')
      + (failed > 0 ? ` · ${failed} parked (fix address)` : '')
      + (ambig > 0 ? ` · ${ambig} need a town picked (Edit)` : '')
      + (geoReason && parkedIds.length ? ` · lookups failed: ${short(geoReason)}` : '')
      + (note ? ` · ${short(note)}` : '');
    const modeText = mode === 'here-home' ? 'Route optimized — starts here and ends near home ✓'
      : mode === 'here' ? 'Route optimized — starts here ✓'
      : mode === 'home' ? 'Route optimized — ends near home ✓'
      : 'Route optimized — starts at your first order ✓';
    toast((startFallback ? 'Current location unavailable — used normal routing · ' : '') + modeText + extra);
  } catch (err) {
    toast((err && err.message) || 'Route optimization failed — try again');
  } finally {
    setStartHere(false);
    btn.disabled = false; prog.classList.add('hide'); prog.textContent = '';
  }
}

// ── Optimize press gesture: normal tap vs. the road-matrix secret ────────────
// A normal tap uses straight-line distances. Holding for two seconds selects
// the real road-distance matrix. Pointer release generates a click in browsers,
// so consume that click after either path to avoid opening a second confirm.
function bindOptimizeGesture(btn, onStraightLine, onRoadMatrix, holdMs=2000){
  let pointerId = null, holdTimer = null, held = false, suppressPointerClick = false;

  const clearPress = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    pointerId = null;
  };

  // iOS can show its selection loupe even with user-select/touch-callout CSS.
  // Cancel the native touch default before it can steal the two-second hold.
  btn.addEventListener('touchstart', e => e.preventDefault(), { passive:false });
  btn.addEventListener('selectstart', e => e.preventDefault());

  btn.addEventListener('pointerdown', e => {
    if(e.isPrimary === false || e.button !== 0) return;
    clearPress();
    pointerId = e.pointerId;
    held = false;
    suppressPointerClick = false;
    try { btn.setPointerCapture(pointerId); } catch { /* best-effort */ }
    holdTimer = setTimeout(() => {
      holdTimer = null;
      held = true;
      suppressPointerClick = true;
      onRoadMatrix();
    }, holdMs);
  });

  btn.addEventListener('pointerup', e => {
    if(e.pointerId !== pointerId) return;
    const shortTap = !held;
    clearPress();
    held = false;
    try { btn.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    suppressPointerClick = true;
    if(shortTap) onStraightLine();
  });

  btn.addEventListener('pointercancel', e => {
    if(e.pointerId !== pointerId) return;
    clearPress();
    held = false;
    suppressPointerClick = false;
  });

  btn.addEventListener('click', e => {
    if(suppressPointerClick){ e.preventDefault(); suppressPointerClick = false; return; }
    onStraightLine(); // keyboard, assistive-tech, or click-only activation
  });
  btn.addEventListener('contextmenu', e => {
    if(pointerId !== null || held) e.preventDefault();
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
  $('wlAddBtn').textContent = '＋ Add order';
  $('captureMain').classList.add('hide');
  if(routeView) routeView.close();
  if(addrFill) await addrFill.close();
  $('worklistScreen').classList.remove('hide');
  if(location.hash !== '#worklist') history.pushState({ wl:1 }, '', '#worklist');
  paintPlanToggle();
  await renderWorklist();
  refreshAvgDay();   // best-effort avg/day hint beside the target field
  window.scrollTo(0, 0);
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
      const count = pending.filter(p => (p.day || null) === d).length;
      const date = (pending.find(p => (p.day || null) === d) || {}).scheduledDate || '';
      const km = liveDayMeters(items, variant, d);
      const div = document.createElement('div');
      div.className = 'wl-day';
      div.title = 'Distance covers the drive out and between stops, not the drive home.';
      div.innerHTML = `<span class="wl-day-dot"></span>Day ${d}${date ? ` · ${esc(date)}` : ''} · ${count} meter${count === 1 ? '' : 's'}`
        + (km == null ? '' : ` · ${esc(fmtKm(km))}`)
        + `<span class="wl-day-eta">${esc(wlDayEta(count))}</span>`;
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

function routeTotalText(items){
  return routeTotalSummary(items, activeVariant(), store.get('wlStraightDistanceSource') || '');
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
    const s = variantSummary(items, v, { active:v === active, straightDistanceSource:src });
    const on = s.selectable && v === active;
    btn.disabled = !s.selectable;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = s.stale ? 'Saved, but the orders have changed since — optimize again to use it'
      : s.selectable ? 'Use this route'
      : 'Not worked out yet — hold Optimize to get road distances';
    btn.innerHTML = `<span class="wl-variant-name">${esc(s.label)}</span>`
      + `<span class="wl-variant-km">${esc(s.text)}</span>`;
    if(s.selectable) any = true;
  }
  box.classList.toggle('hide', !any);
}

async function switchVariant(v){
  if(v === activeVariant()) return;
  const items = await allSorted();
  if(!variantSelectable(items, v)) return;
  let next;
  try { next = applyVariant(items, v, { ...planShape(), target:targetVal() }); }
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
function wlDayEta(count){
  if(!wlAvgLogMin || !count) return '';
  const mins = count * wlAvgLogMin + 60;   // + lunch + break
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return ` · ~${h}h${m ? ' ' + m + 'm' : ''}`;
}
// Pull the installer's avg/day + cadence (installerMetrics) into the hint beside
// the target field. Online best-effort — silent offline; keeps the last value.
async function refreshAvgDay(){
  const el = $('wlAvgDay');
  const c = cfg();
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
      if(el) el.textContent = perDay ? `your avg ${perDay}/day` : '';
      $('wlPaceHint').textContent = wlAvgLogMin
        ? `Recent 30-workday pace: ${wlAvgLogMin} min/stop`
        : 'No pace history yet — using the editable 30 min/stop fallback.';
    }
  } catch {}
}

function appointmentBadge(item){
  if(!item.appointmentDate || !item.appointmentTime) return '';
  return `<span class="wl-badge appt">🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)}</span>`;
}
function scheduleBadge(item){
  // ETAs are only meaningful when they came from real road durations (the road
  // variant); a straight-line route has no travel times, so hide them there.
  if(activeVariant() !== 'road' || !item.scheduledDate || !item.scheduledEta) return '';
  const wait = Number(item.scheduledWaitMin) > 0 ? ` · wait ${Number(item.scheduledWaitMin)}m` : '';
  return `<span class="wl-badge">ETA ${esc(item.scheduledEta)}${wait}</span>`;
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
    try{
      const pendingIds = ids.filter(id => byId[id] && isPending(byId[id]));
      schedule = scheduleRouteConstraints(pending, pendingIds, { ...planShape(), target:targetVal() });
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
  if(!$('worklistScreen').classList.contains('hide')) await renderWorklist();
}

// ── plan mode ───────────────────────────────────────────────────────────────
export function planActive(){ return store.get('planMode') === '1'; }

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

// Quiet pace estimate beside the plan banner. capture.js supplies the string
// (it owns the dayCache); we just paint it and hide the span when empty.
async function renderPlanEstimate(){
  const el = $('planEstimate'); if(!el) return;
  const txt = planEstimate ? (await planEstimate()) : '';
  el.textContent = txt || '';
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
  planEstimate = (opts && opts.planEstimate) || planEstimate;
  routeView = initWorklistRouteView({
    getItems: allSorted,
    routeVariant: activeVariant,
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
    openDirections,
    onClose: () => location.hash === '#drive' ? history.back() : openWorklist(),
  });
  $('wlBack').onclick = closeWorklist;
  $('wlDrive').onclick = openDriveScreen;
  $('wlViewRoute').onclick = openWorklistRoute;
  $('wlFillAddr').onclick = openAddressFill;
  $('wlDedup').onclick = runDuplicateScan;
  $('wlUpload').onclick = wlUpload;
  $('wlDownload').onclick = wlDownload;
  bindOptimizeGesture($('wlOptimize'),
    () => optimizeRouteHandler(true),
    () => optimizeRouteHandler(false));
  $('wlStartHere').onclick = () => setStartHere(!startHereArmed());
  $('wlVariantRoad').onclick = () => switchVariant('road');
  $('wlVariantStraight').onclick = () => switchVariant('straight');
  // Meters/day target: restore the saved value (default 24) and persist edits.
  $('wlTarget').value = String(Math.max(1, Math.floor(Number(store.get('wlTarget')) || 24)));
  $('wlTarget').onchange = () => {
    const v = Math.max(1, Math.floor(Number($('wlTarget').value) || 24));
    $('wlTarget').value = String(v); store.set('wlTarget', String(v));
  };
  loadPlanFields();
  $('wlPace').onchange = () => {
    store.set('wlPaceSource', 'override');
    const p = savePlanLocal(); $('wlPace').value = String(p.paceMin);
    $('wlPaceHint').textContent = `Plan override: ${p.paceMin} min/stop`;
  };
  $('wlTimed').onchange = paintTimedFields;
  $('wlPlanToggle').onclick = () => setPlan(!planActive());
  $('planSkip').onclick = planSkip;
  $('planExit').onclick = () => setPlan(false);
  $('wlAddBtn').onclick = () => {
    if(!$('wlForm').classList.contains('hide')){
      $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; return;
    }
    wlOpenForm(null);
  };
  $('wlFormCancel').onclick = () => { $('wlForm').classList.add('hide'); $('wlAddBtn').textContent='＋ Add order'; _wlEditId=null; };
  $('wlFormSave').onclick = wlSave;
  pruneDoneWorklist().then(() => {
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
