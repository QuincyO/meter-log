// ── Desktop route planner (planner.html) ────────────────────────────────────
// The office-side half of the "plan on the PC, drive from the phone" flow:
// pick an installer, ⇩ Load their saved Worklist rows (or paste orders in),
// geocode + optimize against a LOCAL OSRM server (road distances, free — see
// DEPLOY.md §"Desktop planner + local OSRM"), review the numbered route on the
// map, then ⇪ Upload. saveWorklist stores the sequence + pins, so the phone's
// ⇩ Download lands the finished route with zero work (and zero spend) on the
// phone. This page is desktop-first, installable from Chrome/Edge as an app
// window, and is deliberately NOT linked from the capture page.
//
// Storage: the in-memory `items` array is the working copy; each mutation is
// mirrored into the PC's IndexedDB `worklist` store because route.js's
// geocodeAll persists coords there by id (the PC's store is scratch — loading
// an installer clears it). Nothing here touches the offline queue: like the
// phone's Upload/Download, planner sync is explicit and fails loudly.
import { $, esc, attr, toast } from '../dom.js';
import { apiGet, apiPost } from '../api.js';
import { idb } from '../idb.js';
import { store } from '../store.js';
import { stamp, localDate, hhmmMin } from '../time.js';
import { optimizeRoute, geocodeOne, coordsOf, isParked, legMetersFor, homeLegMetersFor, travelLookup, osrmLegGeometry, encodePolyline, decodePolyline } from '../route.js';
import { addWorkdays, currentRoutePlacement, scheduleRouteConstraints } from '../route-constraints.js';
import { dwellLookup } from '../route-dwell.js';
import { weekdayOnOrAfter } from '../route-planday.js';
import { orderAnchorFirst, taggedDay1Ids } from '../route-today.js';
import { unionBbox, isSparseUnion, unionWaste, normalizeBbox, clampBbox, wasClamped } from '../districts.js';
import { ROUTE_DEPART_TIME } from '../config.js';
import {
  VARIANTS, VARIANT_FIELDS, VARIANT_LABELS, applyVariant, dayHomeMeters, fmtKm, isIgnored, isPending,
  liveDayMeters, pendingOf, routeTotalSummary, variantMatchesLive, variantSelectable, variantSummary,
} from '../route-variants.js';
import {
  DEFAULT_NOMINATIM_URL, DEFAULT_OSRM_URL, DEFAULT_BUILDER_URL, buildOptimizeConfirmation,
  createLastRunRecord, createLatestProbeRunner, formatLastRunSummary, parsePlannerLastRunRecord,
  probeNominatim, probeOsrm, probeBuilder,
} from '../planner-services.js';

let roster = { employees: [] };
let items = [];              // the selected installer's orders, display order
let map = null, mapLayer = null;   // Leaflet instances (lazy)
// The offline-district rectangle lives on its OWN layer: renderMap() clears
// mapLayer on every repaint, and a drawn district must survive that.
let districtLayer = null, districtBox = null, drawHandlers = null, builderOnline = false;
// The last /status. Cached because updateDistrictButtons() is also called from
// the draw handlers and the id/name inputs, which have no status to hand it —
// without the cache, drawing a box re-enabled Build on a machine with no Docker
// and no extract.
let builderState = null;
// The district being GROWN, when Build is going to extend one rather than make
// a new one: `{id, name, bbox}` straight off the catalogue. A district is a
// single rectangle, so growing it means rebuilding the same id over the union
// of its old box and the newly drawn one — same pack file, same entry, more
// ground. Null for an ordinary new district.
let extendBase = null;
let serviceState = {
  osrm:{ provider:'osrm', online:false, reason:'not checked' },
  nominatim:{ provider:'nominatim', online:false, reason:'not checked' },
};

// Day-cluster colors (list headers + map pins/lines), cycled by (day-1).
const DAY_COLORS = ['#2b6cff','#1E8E5A','#C97E00','#8b5cf6','#d64500','#0891b2','#be185d','#4d7c0f'];
const dayColor = d => DAY_COLORS[((Number(d) || 1) - 1) % DAY_COLORS.length];
// The picked installer's cadence, from installerMetrics — sizes the day ETA and
// the avg/day hint. avgLogMin = minutes per meter; avgPerDay = meters/day.
let avgLogMin = null, avgPerDay = null;
// The same read's MEASURED dwell model (js/route-dwell.js): on-site minutes per
// stop and the shorter figure for a repeat meter at one address. Null until this
// installer has enough history, which the dwell lookup reads as "use the pace
// guess" — the planner then behaves exactly as it did before.
let onSiteMin = null, extraMeterMin = null;
// Crew-wide per-site dwell history, fetched once per page load.
let siteFactorMap = {};

// Day time window (minutes-of-day). The crew leaves the muster point at 08:00 (no
// later than 08:30) and aims to finish the daily target by 14:00 — two hours before
// the 16:00 shift end — so a slow/heavy day can still knock off by ~16:00.
const DEPART_MIN = 8 * 60;              // 08:00 earliest departure
const DEPART_LATEST_MIN = 8 * 60 + 30; // 08:30 hard latest
// 'HH:MM' → minutes-of-day, clamped to the [08:00, 08:30] leave window; DEPART_MIN
// on anything unparseable.
function departMinutes(hhmm){
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return DEPART_MIN;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Math.min(DEPART_LATEST_MIN, Math.max(DEPART_MIN, v));
}

// Commute-pull dial value (synced from the installer's phone), clamped to 0–100;
// blank/garbage ⇒ the 70 default. The office never edits this — it only reads it.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}

function planShape(){
  return {
    // Only a DEFAULT for the empty picker — the office's #plRouteDate is the real
    // answer here, so this stays the plain weekend clamp rather than the phone's
    // rolling plan day. (weekdayOnOrAfter was a local `nextWeekday` copy; the name
    // read like "tomorrow" while only skipping weekends, which is exactly how the
    // phone's routes ended up permanently dated today — see js/route-planday.js.)
    routeStartDate:$('plRouteDate').value || weekdayOnOrAfter(localDate()),
    firstStopTime:ROUTE_DEPART_TIME,
    paceMin:Math.max(1, Math.round(Number($('plPace').value) || 30)),
    paceSource:store.get('plannerPaceSource:' + hNumber()) || 'fallback',
    routeVariant:activeVariant(),
    straightDistanceSource:store.get('plannerStraightSource:' + hNumber()) || '',
    commutePull:pullVal(store.get('plannerCommutePull:' + hNumber())),
    target:targetVal(),
    dayLockDate:plLockDate()
  };
}

// ── the work-list lock, office side ────────────────────────────────────────
// Same control the installer has on their phone, and the same one date behind it:
// locked iff the stored date is the day this route starts on. It rides the sync on
// the WorklistPlans row, so a day the office settles reaches the phone on its next
// ⇩ Download and a day the installer settles shows up here on ⇩ Load.
//
// The office needs no separate record of WHICH orders are locked: up here the frozen
// set is exactly the rows tagged `day === 1`, which is the same fact the sheet
// carries. (The phone keeps an id list only because it re-schedules locally all day
// as orders are completed.)
//
// Not to be confused with togglePlannerLock further down — that is the per-order
// position lock, one stop pinned to a date and slot.
function plLockDate(){ return store.get('plannerDayLock:' + hNumber()) || ''; }
function plDayLocked(){
  const d = plLockDate();
  return Boolean(d) && d === $('plRouteDate').value;
}
function plLockedDay1Ids(){ return plDayLocked() ? taggedDay1Ids(pendingItems()) : []; }
// `null` unless locked — route-constraints.js reads null as "size day 1 by the
// target like any other day", and 0 as a real, empty day.
function plDay1Count(){
  const ids = plLockedDay1Ids();
  return plDayLocked() ? ids.length : null;
}
// Which saved route is live for this installer. Uploaded with the list, so the
// phone opens on the route the office chose — and the installer can still flip it.
function activeVariant(){
  return store.get('plannerVariant:' + hNumber()) === 'straight' ? 'straight' : 'road';
}
function loadPlan(plan){
  const p = plan || {};
  $('plRouteDate').value = p.routeStartDate || weekdayOnOrAfter(localDate());
  $('plPace').value = String(Math.max(1, Number(p.paceMin) || 30));
  store.set('plannerPaceSource:' + hNumber(), p.paceSource || store.get('plannerPaceSource:' + hNumber()) || 'fallback');
  if(p.routeVariant) store.set('plannerVariant:' + hNumber(), p.routeVariant === 'straight' ? 'straight' : 'road');
  if(p.straightDistanceSource) store.set('plannerStraightSource:' + hNumber(), p.straightDistanceSource);
  if(p.commutePull !== '' && p.commutePull != null) store.set('plannerCommutePull:' + hNumber(), String(p.commutePull));
  // The installer owns their target — a Download of their plan drives the planner's
  // day target so the office plans to the same number the installer set.
  if(p.target !== '' && p.target != null) $('plTarget').value = String(Math.max(1, Math.floor(Number(p.target) || 24)));
  // The lock travels both ways — whoever settled the day, settled it. Taken
  // verbatim (including a blank, which is the real unlocked state) because ⇩ Load is
  // an explicit act: the office asked for this installer's current plan.
  store.set('plannerDayLock:' + hNumber(), String(p.dayLockDate || '').slice(0, 10));
}

function setStatus(kind, text){
  const p = $('status'), t = $('statusText');
  p.classList.remove('wait','off');
  if(kind==='off') p.classList.add('off'); else if(kind==='wait') p.classList.add('wait');
  t.textContent = text;
}

const providerBadge = provider => $(provider === 'osrm' ? 'plOsrmStatus' : 'plGeoStatus');
function paintProviderStatus(provider, state){
  const badge = providerBadge(provider);
  badge.classList.remove('checking','online','using','offline');
  badge.classList.add(state);
  badge.querySelector('.provider-text').textContent = state[0].toUpperCase() + state.slice(1);
}
function restoreProviderStatus(provider){
  paintProviderStatus(provider, serviceState[provider].online ? 'online' : 'offline');
}
const providerUrls = () => ({
  osrm:String($('plOsrm').value || '').trim() || DEFAULT_OSRM_URL,
  nominatim:String($('plGeo').value || '').trim() || DEFAULT_NOMINATIM_URL,
});

const runLatestServiceCheck = createLatestProbeRunner(async () => {
  const urls = providerUrls();
  paintProviderStatus('osrm','checking');
  paintProviderStatus('nominatim','checking');
  const run = navigator.onLine === false
    ? Promise.resolve([
        { provider:'osrm', online:false, reason:'browser offline' },
        { provider:'nominatim', online:false, reason:'browser offline' },
      ])
    : Promise.all([probeOsrm({ url:urls.osrm }), probeNominatim({ url:urls.nominatim })]);
  const results = await run;
  const nextState = { ...serviceState };
  for(const result of results) nextState[result.provider] = result;
  return nextState;
});

// A burst of focus/change/timer calls is coalesced behind one active probe
// round. All callers wait through any superseding round and receive one state.
async function checkServices(){
  serviceState = await runLatestServiceCheck();
  restoreProviderStatus('osrm');
  restoreProviderStatus('nominatim');
  return serviceState;
}

// ── offline map districts ────────────────────────────────────────────────────
// Draw the area a crew works, build a road+address pack from the Ontario
// extract, and publish it so their phones can download it. The whole panel is
// hidden unless tools/roadpack-server.mjs is running: it is needed to MAKE a
// district, never to plan a route, so its absence is normal and not a fault.

const DISTRICT_FILL = { color:'#2563eb', weight:2, dashArray:'6,4', fillOpacity:0.08 };
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 32);

async function checkBuilder(){
  const health = await probeBuilder({ url: DEFAULT_BUILDER_URL });
  builderOnline = health.online;
  $('plDistricts').classList.toggle('hide', !builderOnline);
  if(builderOnline) refreshDistrictList();
}

async function builderStatus(){
  const res = await fetch(`${DEFAULT_BUILDER_URL}/status`);
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshDistrictList(){
  const el = $('plDistrictList');
  let status;
  try { status = await builderStatus(); }
  catch { el.textContent = ''; builderState = null; return; }
  builderState = status;
  const list = status.districts || [];
  el.innerHTML = list.length
    ? '<p class="sub">Built so far:</p><ul class="pldistricts">' + list.map(d =>
        `<li><strong>${esc(d.name)}</strong> <span class="sub">${(d.bytes / 1048576).toFixed(1)} MB`
        + `${d.addresses ? ` · ${d.addresses.toLocaleString()} addresses` : ' · roads only'}`
        + ` · built ${esc(d.builtAt || '')}</span>`
        + `<span class="pldistrict-do">`
        + `<button type="button" class="plmini" data-extend="${attr(d.id)}"`
        + ` title="Draw more ground onto this district and rebuild it">⊕ Extend</button>`
        + `<button type="button" class="plmini plmini-danger" data-remove="${attr(d.id)}"`
        + ` title="Delete this district from maps/ — publish to unlist it for phones">✕</button>`
        + `</span></li>`).join('') + '</ul>'
    : '<p class="sub">No districts built yet.</p>';
  // NOT `!list.length` — removing the last district leaves maps/ with a deletion
  // that still has to be published, and gating on the list emptied the button
  // that does it. The service answers "Nothing new to publish" when there is
  // genuinely nothing staged, which is the honest place for that check.
  $('plDistrictPublish').disabled = !status.git;
  updateDistrictButtons();
  // Spelled out in the panel as well as on the button: a disabled button's
  // title tooltip never fires in Chrome, which is where this runs.
  const blocked = builderBlocker();
  if(blocked) el.innerHTML += `<p class="sub plwarn">⚠ ${esc(blocked)}</p>`;
}

// Two things have to be true before a build can even start, and both are the
// service's environment rather than anything on this page: Docker is what runs
// osmium, and --data has to actually hold the province extract to clip. Say
// which one is missing on the button — a wrong --data used to look like a
// working Build that died minutes later in the job log.
function builderBlocker(){
  if(!builderState) return '';
  if(builderState.docker === false) return builderState.dockerReason || 'Docker is not running';
  if(!builderState.pbf) return `No .osm.pbf in ${builderState.data || 'the data folder'}`
    + ' — restart the builder with --data pointing at your Ontario extract';
  return '';
}

function updateDistrictButtons(){
  const ready = !!districtBox && !!$('plDistrictId').value.trim() && !!$('plDistrictName').value.trim();
  const blocked = builderBlocker();
  $('plDistrictBuild').title = blocked;
  $('plDistrictBuild').disabled = !ready || !builderOnline || !!blocked;
}

function ensureDistrictLayer(){
  if(!map || districtLayer) return;
  districtLayer = L.layerGroup().addTo(map);
}

const boundsOf = b => [[b.minLat, b.minLng], [b.maxLat, b.maxLng]];

// What Build will actually clip out of the province: the rectangle just drawn,
// or — while extending — the bounding box of the old district and the new
// rectangle together, because a district is one rectangle and growing it means
// covering both.
function buildBbox(){
  const wanted = !districtBox
    ? (extendBase ? extendBase.bbox : null)
    : (extendBase ? unionBbox(extendBase.bbox, districtBox) : districtBox);
  if(!wanted) return null;
  // Trimmed to where the extract actually holds data. There is nothing on the
  // map showing where the province's data stops, so drawing past the edge is
  // the normal mistake — and clipping empty ground doesn't fail at the clip, it
  // fails a minute later in the pack build with "No drivable segments found".
  const limit = builderState && builderState.pbfBbox;
  return limit ? clampBbox(wanted, limit) : wanted;
}

function kmSize(b){
  const wide = Math.round((b.maxLng - b.minLng) * 111.32 * Math.cos(b.minLat * Math.PI / 180));
  const tall = Math.round((b.maxLat - b.minLat) * 111.32);
  return `${wide} × ${tall} km`;
}

// The district as it stands today, under the area being added to it. Muted and
// solid so the dashed rectangle — what a Build would produce — reads as the
// change rather than as another district.
const DISTRICT_BASE = { color:'#0f766e', weight:2, fillOpacity:0.05 };

function paintDistrictShapes(){
  ensureDistrictLayer();
  if(!districtLayer) return;
  districtLayer.clearLayers();
  if(extendBase) L.rectangle(boundsOf(extendBase.bbox), DISTRICT_BASE).addTo(districtLayer);
  const target = buildBbox();
  // With nothing new drawn yet the target IS the base — don't stack two
  // rectangles on the same four corners.
  if(target && (!extendBase || districtBox))
    L.rectangle(boundsOf(target), DISTRICT_FILL).addTo(districtLayer);
}

function describeDistrictTarget(){
  const el = $('plDistrictBox');
  const target = buildBbox();
  if(!target){
    el.textContent = districtBox
      ? 'That rectangle is outside the map data — draw it over the province.'
      : extendBase
        ? `Extending ${extendBase.name} — drag the area to add.`
        : 'No area drawn yet.';
    return;
  }
  // Said out loud, because a silently smaller district would just look wrong.
  const trimmed = districtBox && wasClamped(
    extendBase ? unionBbox(extendBase.bbox, districtBox) : districtBox, target)
    ? ' Trimmed to the edge of the map data.' : '';
  if(!extendBase){ el.textContent = `Area drawn: roughly ${kmSize(target)}.${trimmed}`; return; }
  el.textContent = `Extending ${extendBase.name}: the rebuild covers roughly ${kmSize(target)}`
    + ` (was ${kmSize(extendBase.bbox)}).${trimmed}`;
  // A district is one rectangle, so two areas at opposite corners are joined by
  // clipping everything between them — minutes of build and megabytes of pack
  // for ground nobody drives. Two districts is the better shape for that, and
  // the phone now picks between them per run on its own.
  if(districtBox && isSparseUnion(extendBase.bbox, districtBox))
    el.textContent += ` ⚠ That is ${unionWaste(extendBase.bbox, districtBox).toFixed(1)}× the ground`
      + ' of the two areas themselves — consider a separate district instead.';
}

function setDistrictBox(box){
  districtBox = box;
  paintDistrictShapes();
  describeDistrictTarget();
  updateDistrictButtons();
}

// Growing an existing district: prefill it, lock the id (a changed id would
// build a NEW district rather than extend this one), show its current area, and
// wait for the rectangle to add.
function beginExtend(d){
  if(!d || !d.bbox){ toast('That district has no saved area — rebuild it instead'); return; }
  extendBase = { id: d.id, name: d.name || d.id, bbox: d.bbox };
  districtBox = null;
  $('plDistrictId').value = d.id;
  $('plDistrictId').readOnly = true;
  $('plDistrictName').value = d.name || d.id;
  $('plDistrictBuild').textContent = '🗺 Extend district';
  if(map) map.fitBounds(boundsOf(d.bbox), { padding:[24, 24] });
  paintDistrictShapes();
  describeDistrictTarget();
  updateDistrictButtons();
  startDrawing();
}

function clearExtend(){
  if(!extendBase) return;
  extendBase = null;
  $('plDistrictId').readOnly = false;
  $('plDistrictBuild').textContent = '🗺 Build district';
}

async function removeDistrict(id, name){
  if(!confirm(`Delete the ${name || id} district?\n\n`
    + 'It is removed from maps/ here; phones stop being offered it once you Publish. '
    + 'A phone that already downloaded it keeps working with the copy it has.')) return;
  try {
    await postBuilder('/remove', { id });
    if(extendBase && extendBase.id === id){ clearExtend(); districtBox = null; paintDistrictShapes(); describeDistrictTarget(); }
    toast(`${name || id} removed — publish to unlist it`);
  } catch(e){
    toast('Remove failed — ' + e.message);
  }
  await refreshDistrictList();
}

function stopDrawing(){
  if(!drawHandlers || !map) return;
  map.off('mousedown', drawHandlers.down);
  map.off('mousemove', drawHandlers.move);
  map.off('mouseup', drawHandlers.up);
  map.dragging.enable(); map.doubleClickZoom.enable();
  map.getContainer().style.cursor = '';
  drawHandlers = null;
  $('plDrawCancel').hidden = true;
  $('plDrawDistrict').disabled = false;
}

function startDrawing(){
  if(!map){ toast('The map is still loading'); return; }
  ensureDistrictLayer();
  // Panning must be off while drawing, or the drag that draws the rectangle
  // moves the map underneath it instead.
  map.dragging.disable(); map.doubleClickZoom.disable();
  map.getContainer().style.cursor = 'crosshair';
  $('plDrawCancel').hidden = false;
  $('plDrawDistrict').disabled = true;
  let start = null, rect = null;
  const down = e => {
    start = e.latlng;
    districtLayer.clearLayers();
    // Keep the district being extended on screen underneath the drag — it is
    // the thing the new rectangle is being drawn relative to.
    if(extendBase) L.rectangle(boundsOf(extendBase.bbox), DISTRICT_BASE).addTo(districtLayer);
    rect = L.rectangle([start, start], DISTRICT_FILL).addTo(districtLayer);
  };
  const move = e => { if(rect && start) rect.setBounds(L.latLngBounds(start, e.latlng)); };
  const up = e => {
    if(!rect || !start){ stopDrawing(); return; }
    const b = L.latLngBounds(start, e.latlng);
    // A stray click is a zero-size box, not a district.
    if(b.getNorth() - b.getSouth() < 0.01 || b.getEast() - b.getWest() < 0.01){
      paintDistrictShapes();
      $('plDistrictBox').textContent = 'That area was too small — drag a rectangle.';
      stopDrawing();
      return;
    }
    // Leaflet reports UNWRAPPED longitudes: pan the map sideways onto the next
    // world copy and the same rectangle comes back at −439 rather than −79.
    // osmium rejects that outright, and the build failed with the clipping
    // step's name on it — which read as "outside the province" and only
    // happened after a sideways pan. Wrap at the point the box is made, so
    // nothing downstream ever sees a second copy of the world.
    const drawn = normalizeBbox({
      minLat: b.getSouth(), minLng: b.getWest(),
      maxLat: b.getNorth(), maxLng: b.getEast(),
    });
    if(!drawn){
      // Only reachable by dragging a rectangle across the date line.
      paintDistrictShapes();
      $('plDistrictBox').textContent = 'That rectangle wraps the world — draw it again in one piece.';
      stopDrawing();
      return;
    }
    setDistrictBox(drawn);
    stopDrawing();
  };
  drawHandlers = { down, move, up };
  map.on('mousedown', down); map.on('mousemove', move); map.on('mouseup', up);
  $('plDistrictBox').textContent = 'Drag a rectangle over the crew’s work area.';
}

const mmss = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// The bar only ever moves forwards. A poll that fails mid-build leaves the last
// good reading on screen rather than snapping back to zero, which would read as
// the build restarting itself.
function paintBuildProgress(job){
  const wrap = $('plDistrictProg'), fill = $('plDistrictFill'), label = $('plDistrictPhase');
  if(!wrap) return;
  wrap.classList.remove('hide');
  const steps = Number(job && job.steps) || 0;
  const step = Math.min(Number(job && job.step) || 0, steps);
  // `pct` is weighted by the service — the first step scans the whole province
  // and is most of the wait, so step/steps would leave the bar looking stuck on
  // 1/9 for the bulk of the build.
  const pct = job && job.done && !job.error ? 100
    : Math.max(0, Math.min(100, Number(job && job.pct) || 0));
  fill.style.width = pct + '%';
  $('plDistrictBar').setAttribute('aria-valuenow', String(pct));
  wrap.classList.toggle('is-error', !!(job && job.error));
  // The reported number stays honest — it is work BEHIND you, so it really is 0
  // through the twenty-odd seconds of the clip. A barber-pole on the TRACK (not
  // the fill) is what shows the build is alive at 0%, without a bar that claims
  // progress it hasn't made.
  wrap.classList.toggle('is-running', !!(job && !job.done));
  const elapsed = job && job.startedAt ? ` · ${mmss(Date.now() - job.startedAt)}` : '';
  const count = steps ? ` (${step}/${steps})` : '';
  // The clip reads the entire province extract however small the district is,
  // so it is the one step worth warning about rather than leaving someone
  // watching a bar that has not moved in twenty seconds.
  const slow = job && /^Clipping/.test(job.phase || '') ? ' — the long one' : '';
  label.textContent = job && job.error
    ? `Failed: ${job.error}`
    : job && job.done
      ? `Done${elapsed}`
      : `${job && job.phase ? job.phase : 'Starting'}${slow}…${count}${elapsed}`;
}

function hideBuildProgress(){
  const wrap = $('plDistrictProg');
  if(wrap) wrap.classList.add('hide');
}

// A build takes minutes — far longer than a fetch should hang — so the service
// hands back a job id and we poll it for the log and its phase.
async function pollBuildJob(jobId, log){
  let last = null;
  for(;;){
    await new Promise(r => setTimeout(r, 900));
    let job;
    try {
      const res = await fetch(`${DEFAULT_BUILDER_URL}/job?id=${encodeURIComponent(jobId)}`);
      job = await res.json();
    } catch {
      // A blip mid-build isn't fatal — but keep the clock moving, or a dropped
      // poll looks like a stalled build.
      if(last) paintBuildProgress(last);
      continue;
    }
    last = job;
    if(Array.isArray(job.log)){
      log.textContent = job.log.join('\n');
      log.scrollTop = log.scrollHeight;
    }
    paintBuildProgress(job);
    if(job.done){
      if(job.error) throw new Error(job.error);
      return job;
    }
  }
}

async function postBuilder(path, body){
  const res = await fetch(DEFAULT_BUILDER_URL + path, {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function buildDistrict(){
  const id = slugify($('plDistrictId').value);
  const name = String($('plDistrictName').value || '').trim();
  const bbox = buildBbox();
  if(!districtBox || !bbox || !id || !name) return;
  const growing = !!extendBase;
  const log = $('plDistrictLog');
  log.classList.remove('hide');
  log.textContent = 'Starting…';
  $('plDistrictBuild').disabled = true;
  const startedAt = Date.now();
  paintBuildProgress({ startedAt, step:0, steps:0, phase:'Starting' });
  try {
    // Same id as the district being grown, which is the whole mechanism:
    // buildPack overwrites maps/<id>.pack and replaces its catalogue entry, so
    // an extend is just a build over more ground.
    const { job } = await postBuilder('/build', { id, name, bbox });
    await pollBuildJob(job, log);
    toast(growing
      ? `${name} extended — publish it, then phones re-download it`
      : `${name} built — publish it to reach phones`);
    clearExtend();
    await refreshDistrictList();
  } catch(e){
    log.textContent += `\n✗ ${e.message}`;
    paintBuildProgress({ startedAt, done:true, error:e.message });
    toast('Build failed');
  } finally {
    updateDistrictButtons();
  }
}

async function publishDistricts(){
  // Publishing pushes to main, which redeploys the whole app — so it is a
  // deliberate, separate action from building, and it asks first.
  if(!confirm('Publish the built districts?\n\nThis commits maps/ and pushes to main, '
    + 'which deploys the app. Installers can then download the map on their phones.')) return;
  const log = $('plDistrictLog');
  log.classList.remove('hide');
  log.textContent = 'Publishing…';
  // Publishing is three git commands, not nine build phases — the log says
  // everything a bar could, and a bar stuck at 0/9 would only mislead.
  hideBuildProgress();
  $('plDistrictPublish').disabled = true;
  try {
    const { job } = await postBuilder('/publish', {});
    await pollBuildJob(job, log);
    toast('Published — phones can download it now');
  } catch(e){
    log.textContent += `\n✗ ${e.message}`;
    toast('Publish failed');
  } finally {
    refreshDistrictList();
  }
}

function renderLastOptimization(record){
  const card = $('plLastOptimize');
  if(!record){ card.classList.add('hide'); return; }
  const g = record.geocoding, route = record.routing;
  const providers = { osrm:'OSRM', 'google-routes':'Google Routes', ors:'ORS', haversine:'Haversine' };
  $('plLastInstaller').textContent = `${record.installer || 'Unknown'}${record.hNumber ? ` (${record.hNumber})` : ''} · ${record.pendingCount} pending`;
  const at = new Date(record.at);
  $('plLastAt').textContent = isNaN(at.getTime()) ? record.at : at.toLocaleString();
  $('plLastGeo').textContent = `${g.cached} cached · Nominatim ${g.nominatim.resolved}/${g.nominatim.attempted} · Google ${g.google.resolved}/${g.google.attempted} · ORS ${g.ors.resolved}/${g.ors.attempted}`;
  $('plLastParked').textContent = String(g.parked);
  $('plLastRouting').textContent = `${route.method === 'matrix' ? 'Matrix' : 'Straight-line'} via ${providers[route.provider] || route.provider}`;
  card.setAttribute('aria-label', `Last optimization. ${formatLastRunSummary(record)}`);
  card.classList.remove('hide');
}

function confirmOptimize(copy){
  $('plConfirmPending').textContent = String(copy.pendingCount);
  $('plConfirmGeo').textContent = copy.geocoding;
  $('plConfirmRouting').textContent = copy.routing;
  const dialog = $('plOptimizeDialog'), cancel = $('plOptimizeCancel'), confirm = $('plOptimizeConfirm');
  return new Promise(resolve => {
    const done = answer => {
      cancel.onclick = null; confirm.onclick = null; dialog.oncancel = null;
      if(dialog.open) dialog.close();
      resolve(answer);
    };
    cancel.onclick = () => done(false);
    confirm.onclick = () => done(true);
    dialog.oncancel = event => { event.preventDefault(); done(false); };
    dialog.showModal();
  });
}

const fullName = e => ((e.firstName||'')+' '+(e.lastName||'')).trim();
const hNumber  = () => $('plWho').value;
const pendingItems = () => pendingOf(items);
const ignoredItems = () => items.filter(x => x.wlStatus !== 'done' && isIgnored(x));
// Meters/day target — at least 1, default 24.
const targetVal = () => Math.max(1, Math.floor(Number($('plTarget').value) || 24));

// A day's rough clock length: meters × avg log time + 30 lunch + 30 break.
// Blank until this installer has a cadence on file (installerMetrics).
function dayEta(count){
  if(!avgLogMin || !count) return '';
  const mins = count * avgLogMin + 60;             // + lunch + break
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return ` · ~${h}h${m ? ' ' + m + 'm' : ''} incl. lunch + break`;
}

// The day's real clock window — first departure to last install — from the saved
// road-time ETAs. Only meaningful on the road variant (straight-line carries no
// durations, so the caller shows the rough dayEta instead). '' when a day has no
// ETAs yet. ETAs are zero-padded 24h 'HH:MM', so a lexical sort orders them.
function dayWindow(pending, d){
  const etas = pending.filter(p => (p.day || null) === d && p.scheduledEta)
    .map(p => p.scheduledEta).sort();
  if(!etas.length) return '';
  return etas.length === 1 ? ` · ${etas[0]}` : ` · ${etas[0]}–${etas[etas.length - 1]}`;
}

function numOrNull(v){
  const n = Number(v);
  return (v === '' || v == null || !isFinite(n) || n <= 0) ? null : n;
}
// Crew-wide site history. Best-effort: the planner is an office desktop, but a
// failed fetch must only cost the site tier, never the whole route.
async function loadSiteFactors(){
  try{
    const r = await apiGet('siteDwell', {});
    if(!r || !r.ok || !Array.isArray(r.sites)) return;
    const map = {};
    r.sites.forEach(s => { if(s && s.key) map[s.key] = Number(s.factor); });
    siteFactorMap = map;
  } catch {}
}
// The run's on-site model. Same assembly as the phone's dwellShape(), so a route
// built here and a route built on the phone price a stop identically.
function dwellShape(){
  return dwellLookup({ paceMin: planShape().paceMin, onSiteMin, extraMeterMin,
                       siteFactors: siteFactorMap });
}

// The picked installer's cadence: fills the avg/day hint beside the target field.
async function showAvgDay(){
  const el = $('plAvgDay');
  avgLogMin = null; avgPerDay = null; onSiteMin = null; extraMeterMin = null;
  if(el) el.textContent = '';
  const h = hNumber();
  if(!h) return;
  loadSiteFactors();
  try{
    const r = await apiGet('installerMetrics', { hNumber: h, workType:'land' });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
      onSiteMin = numOrNull(m.onSiteMin);
      extraMeterMin = numOrNull(m.extraMeterMin);
      avgPerDay = (m.avgPerDay === '' || m.avgPerDay == null) ? null : Number(m.avgPerDay);
      avgLogMin = (m.recent30AvgLogMin === '' || m.recent30AvgLogMin == null)
        ? ((m.avgLogMin === '' || m.avgLogMin == null) ? null : Number(m.avgLogMin))
        : Number(m.recent30AvgLogMin);
      if(store.get('plannerPaceSource:' + h) !== 'override' && avgLogMin){
        $('plPace').value = String(avgLogMin); store.set('plannerPaceSource:' + h, 'recent30');
      }
    }
    if(el) el.textContent = avgPerDay
      ? `their avg ${avgPerDay}/day${avgLogMin ? ` · ~${avgLogMin} min/meter` : ''}`
      : 'no history yet';
    $('plPaceHint').textContent = avgLogMin
      ? `Recent 30-workday pace: ${avgLogMin} min/stop`
      : 'No pace history yet — using the editable 30 min/stop fallback.';
  } catch { if(el) el.textContent = ''; }
}

// ── roster / installer picker ───────────────────────────────────────────────
async function loadRoster(){
  // Paint-from-cache-then-refresh, same rosterCache key as teams/edit/reports.
  try{
    const cached = JSON.parse(sessionStorage.getItem('rosterCache') || 'null');
    if(cached && cached.ok) roster = cached;
  } catch {}
  try{
    const d = await apiGet('roster');
    if(d.ok){
      try{ sessionStorage.setItem('rosterCache', JSON.stringify(d)); } catch {}
      roster = d;
    }
    setStatus('ok','Synced');
  } catch { setStatus('off','Offline — can’t load roster'); }
}

function paintWhoSelect(){
  const emps = (roster.employees || [])
    .filter(e => e.active !== false && String(e.hNumber||'').trim())
    .sort((a,b) => fullName(a).localeCompare(fullName(b)));
  const cur = hNumber();
  $('plWho').innerHTML = '<option value="">— pick an installer —</option>'
    + emps.map(e => `<option value="${attr(e.hNumber)}">${esc(fullName(e))} (${esc(e.hNumber)})</option>`).join('');
  if(cur && emps.some(e => String(e.hNumber) === cur)) $('plWho').value = cur;
}

// ── the scratch worklist copy ───────────────────────────────────────────────
async function clearScratch(){
  const keys = await idb.keys('worklist') || [];
  for(const k of keys) await idb.del('worklist', k);
}
async function setItems(next){
  items = next;
  await clearScratch();
  for(const x of items) await idb.put('worklist', x);
  render();
}

// Same field set the phone uploads (worklist.js wireShape — keep in sync).
// geoFail/geoAmbig deliberately never leave this machine.
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
    scheduledLateMin:x.scheduledLateMin||'',
    ignored:isIgnored(x),
    orderRoad:blank(x.orderRoad), dayRoad:blank(x.dayRoad), legMetersRoad:blank(x.legMetersRoad),
    homeLegMetersRoad:blank(x.homeLegMetersRoad),
    orderStraight:blank(x.orderStraight), dayStraight:blank(x.dayStraight),
    legMetersStraight:blank(x.legMetersStraight), homeLegMetersStraight:blank(x.homeLegMetersStraight),
    legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || ''),
    homeLegGeometryRoad:String(x.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(x.homeLegGeometryStraight || '') };
}
// Route-variant cells are numbers or genuinely absent; '' (not 0) is the absent
// form the sheet and the variant helpers both understand.
function blank(v){ return (v == null || v === '' || isNaN(Number(v))) ? '' : Number(v); }

async function loadList(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  setStatus('wait','Loading…');
  try{
    const r = await apiGet('worklist', { hNumber: h });
    if(!r.ok) throw new Error(r.error || 'load failed');
    // Plan settings BEFORE the orders: setItems renders, and the render reads the
    // active variant and distance source from the plan. Loading it afterwards
    // painted the first frame from the previous installer's settings — which
    // mislabelled a road-priced total as a straight-line estimate.
    loadPlan(r.plan);
    // Mirror the phone's wlDownload normalization: order by row position,
    // blank coords → undefined, status coerced.
    await setItems((r.orders || []).map((o,i) => ({
      id:String(o.id), workOrderId:String(o.workOrderId||''), unit:String(o.unit||''),
      address:String(o.address||''), oldJNumber:String(o.oldJNumber||''),
      wlStatus: o.wlStatus === 'done' ? 'done' : 'pending',
      order: i * 10,
      lat: (o.lat === '' || o.lat == null) ? undefined : Number(o.lat),
      lng: (o.lng === '' || o.lng == null) ? undefined : Number(o.lng),
      createdAt:String(o.createdAt||''), updatedAt:String(o.updatedAt||''),
      day: (o.day === '' || o.day == null) ? '' : Number(o.day),
      appointmentDate:String(o.appointmentDate||''), appointmentTime:String(o.appointmentTime||''),
      lockedDate:String(o.lockedDate||''), lockedSlot:(o.lockedSlot===''||o.lockedSlot==null)?'':Number(o.lockedSlot),
      scheduledDate:String(o.scheduledDate||''), scheduledEta:String(o.scheduledEta||''),
      scheduledSlot:(o.scheduledSlot===''||o.scheduledSlot==null)?'':Number(o.scheduledSlot),
      scheduledWaitMin:(o.scheduledWaitMin===''||o.scheduledWaitMin==null)?'':Number(o.scheduledWaitMin),
      scheduledLateMin:(o.scheduledLateMin===''||o.scheduledLateMin==null)?'':Number(o.scheduledLateMin),
      ignored:isIgnored(o),
      orderRoad:blank(o.orderRoad), dayRoad:blank(o.dayRoad), legMetersRoad:blank(o.legMetersRoad),
      homeLegMetersRoad:blank(o.homeLegMetersRoad),
      orderStraight:blank(o.orderStraight), dayStraight:blank(o.dayStraight),
      legMetersStraight:blank(o.legMetersStraight), homeLegMetersStraight:blank(o.homeLegMetersStraight),
      legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || ''),
      homeLegGeometryRoad:String(o.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(o.homeLegGeometryStraight || '') })));
    setStatus('ok','Synced');
    toast(`Loaded ${items.length} orders ✓`);
  } catch { setStatus('off','Error'); toast('Load failed — check signal'); }
}

// Paste-import: one order per line, "WO#, address" (first comma/tab splits) or
// a bare address. Appended after whatever is already loaded.
async function importPaste(){
  const lines = String($('plPaste').value || '').split('\n').map(s => s.trim()).filter(Boolean);
  if(!lines.length){ toast('Nothing to add'); return; }
  const now = Date.now();
  const added = lines.map((line, i) => {
    const m = line.match(/^([^,\t]{1,20})[,\t]\s*(.+)$/);
    const wo = m ? m[1].trim() : '', address = m ? m[2].trim() : line;
    return { id: (now + i) + '-' + Math.random().toString(36).slice(2,6),
      workOrderId: wo, unit:'', address, oldJNumber:'', wlStatus:'pending',
      order: (items.length + i) * 10, createdAt: stamp(), updatedAt: stamp() };
  });
  await setItems(items.concat(added));
  $('plPaste').value = '';
  $('plImport').classList.add('hide');
  toast(`Added ${added.length} orders ✓`);
}

// ── the "ends near" home anchor ─────────────────────────────────────────────
// The installer's real home pin lives on their phone, so the planner keeps its
// own per-installer anchor: geocoded once (center-less, like the phone's
// Settings home) and remembered in localStorage so re-plans don't re-bill.
async function homePin(geoUrl){
  const addr = String($('plHome').value || '').trim();
  const h = hNumber();
  if(!addr) return null;
  try{
    const saved = JSON.parse(store.get('plannerHome:' + h) || 'null');
    if(saved && saved.addr === addr && isFinite(saved.lat)) return { lat:saved.lat, lng:saved.lng };
  } catch {}
  const hit = await geocodeOne(addr, null, geoUrl, null, progress);
  if(hit && !hit.ambig){
    store.set('plannerHome:' + h, JSON.stringify({ addr, lat:hit.lat, lng:hit.lng }));
    return { lat: hit.lat, lng: hit.lng };
  }
  toast('End-near address didn’t pin — routing without it');
  return null;
}

// The picked installer's team (the row whose memberLetters map carries their H#).
function pickedTeam(){
  const h = hNumber();
  return (roster.teams || []).find(t => t.memberLetters && (h in t.memberLetters)) || null;
}

// A stored crew location → coords: use the saved lat/lng when present, else geocode
// the address (cached in addrCache, so re-plans don't re-bill). null when there is
// no address to resolve.
async function anchorFrom(addr, lat, lng, geoUrl){
  const a = String(addr || '').trim();
  const nlat = Number(lat), nlng = Number(lng);
  if(isFinite(nlat) && isFinite(nlng) && (nlat || nlng)) return { lat:nlat, lng:nlng };
  if(!a) return null;
  const hit = await geocodeOne(a, null, geoUrl, null, progress);
  return (hit && !hit.ambig) ? { lat:hit.lat, lng:hit.lng } : null;
}

// The two route anchors for the picked installer:
//   start = the crew's shared morning muster point (Teams tab) — departed each day;
//   home  = the installer's own home (Employees tab) — the end-of-day bias.
// Home falls back to the manual plHome pin when the sheet has no home on file.
async function planAnchors(geoUrl){
  const h = hNumber();
  const emp = (roster.employees || []).find(e => String(e.hNumber) === h) || null;
  const team = pickedTeam();
  const home = (await anchorFrom(emp && emp.homeAddress, emp && emp.homeLat, emp && emp.homeLng, geoUrl))
    || await homePin(geoUrl);
  const start = await anchorFrom(team && team.startAddress, team && team.startLat, team && team.startLng, geoUrl);
  return { home, start };
}

// ── optimize ────────────────────────────────────────────────────────────────
function progress(p){
  const el = $('plProg');
  if(p.phase === 'provider' && (p.provider === 'nominatim' || p.provider === 'osrm')){
    if(p.status === 'attempted') paintProviderStatus(p.provider, 'using');
    else restoreProviderStatus(p.provider);
  } else if(p.phase === 'locate') el.textContent = 'Getting a reference location…';
  else if(p.phase === 'geocode') el.textContent = `Looking up addresses ${p.done}/${p.total}…`;
  else if(p.phase === 'matrix') el.textContent = 'Getting road distances from OSRM…';
  else if(p.phase === 'solve') el.textContent = 'Finding the best order…';
}

async function requestOptimize(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  const pending = pendingItems();
  if(pending.length < 2){ toast('Need at least 2 pending orders'); return; }
  const btn = $('plOptimize'), osrmInput = $('plOsrm'), geoInput = $('plGeo');
  btn.disabled = true;
  osrmInput.disabled = true; geoInput.disabled = true;
  try {
    const health = await checkServices();
    const copy = buildOptimizeConfirmation({
      pendingCount:pending.length,
      lookupCount:pending.filter(item => !coordsOf(item)).length,
      nominatimOnline:health.nominatim.online,
      osrmOnline:health.osrm.online,
    });
    if(await confirmOptimize(copy)) await optimize(pending, health);
  } catch (err) {
    toast((err && err.message) || 'Couldn’t prepare optimization');
  } finally {
    btn.disabled = false; osrmInput.disabled = false; geoInput.disabled = false;
  }
}

async function optimize(pending, health){
  const h = hNumber();
  const osrmUrl = String($('plOsrm').value || '').trim() || DEFAULT_OSRM_URL;
  store.set('plannerOsrm', osrmUrl);
  const nominatimUrl = String($('plGeo').value || '').trim() || DEFAULT_NOMINATIM_URL;
  store.set('plannerGeocode', nominatimUrl);
  const geocodeUrl = health.nominatim.online ? nominatimUrl : '';
  const target = targetVal();
  // Captured BEFORE the solve, because the solve is about to rewrite every `day`
  // tag and the locked set is defined by the tags as they stand now.
  const lockedDay1 = plLockedDay1Ids();
  const prog = $('plProg');
  prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try{
    const { home, start } = await planAnchors(geocodeUrl);
    // The planner is the road-matrix path, so it always asks for the second,
    // straight-line ordering too — one extra local solve, no extra lookup. `start`
    // (team muster point) + `home` (installer's home) anchor the two ends; the
    // The meters/day target alone sizes a day now — no finish-by clock shrinks it
    // behind the planner's back. `dwell` still has to be the run's one model, so the
    // ETA simulation (planOpts.dwell) and anything reading onSiteMin agree.
    const dwell = dwellShape();
    const base = await optimizeRoute(pending, progress, home,
      { osrmUrl, geocodeUrl, osrmReady:health.osrm.online, compareVariants:true,
        start, target,
        departMin:departMinutes(planShape().firstStopTime), paceMin:planShape().paceMin,
        commutePull:planShape().commutePull });
    const { parkedIds, usedFallback, fallbackReason, mode, geoReason, note } = base;
    const byId = {}; items.forEach(x => { byId[x.id] = x; });
    const blocked = parkedIds.map(id => byId[id]).filter(x => x && (x.appointmentDate || x.lockedDate));
    if(blocked.length) throw new Error('Fix the address before routing constrained ' +
      blocked.map(x => `WO ${x.workOrderId || x.id}`).join(', '));
    // Real road-travel lookup — non-null only on a road run that got durations. It
    // feeds the ROAD variant's schedule so its ETAs reflect actual drive times; the
    // straight variant stays flat-pace and its times are hidden in the UI. The
    // effective per-day count (dayTarget, time-shrunk) keeps day boundaries aligned.
    const roadTravel = travelLookup(base.measure);
    const planOpts = { ...planShape(), target: base.dayTarget || target,
      day1Count: lockedDay1.length ? lockedDay1.length : null };
    const computed = {};
    for(const v of VARIANTS){
      const variant = base.variants[v];
      if(!variant) continue;
      // A locked day 1 keeps its members through the re-solve: the geography is
      // worked out fresh, then the locked orders are pulled back to the front and
      // day 1 is sized to hold exactly them. Applied PER VARIANT — do it once
      // outside the loop and flipping road↔straight quietly unlocks the day.
      const seq = lockedDay1.length ? orderAnchorFirst(variant.orderedIds, lockedDay1)
        : variant.orderedIds;
      const routedItems = seq.map(id => byId[id]).filter(Boolean);
      const travel = v === 'road' ? roadTravel : null;
      const s = scheduleRouteConstraints(routedItems, seq, { ...planOpts, travel, dwell });
      computed[v] = { ...s, legMeters: legMetersFor(base.measure, s.orderedIds, s.dayOf),
        homeLegMeters: homeLegMetersFor(base.measure, s.orderedIds, s.dayOf) };
    }
    const primaryVariant = base.variants.road ? 'road' : 'straight';
    const prim = computed[primaryVariant];
    const orderedIds = prim.orderedIds, dayOf = prim.dayOf;
    const doneIds = items.filter(x => x.wlStatus === 'done').map(x => x.id);
    const ignoredIds = ignoredItems().map(x => x.id);
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
    const seq = [...orderedIds, ...parkedIds, ...doneIds, ...ignoredIds]
      .map(id => byId[id]).filter(Boolean);
    seq.forEach((x, i) => {
      x.order = i * 10; x.updatedAt = stamp();
      x.day = (dayOf && dayOf[x.id]) ? dayOf[x.id] : '';   // parked/done/aside unassigned
      const s = prim.scheduleById[x.id] || {};
      x.scheduledDate=s.date||''; x.scheduledEta=s.eta||'';
      x.scheduledSlot=s.slot||''; x.scheduledWaitMin=s.waitMin||'';
      // Minutes past a promised appointment the day cannot reach in time. The
      // solver reports it now rather than throwing, so the office sees the same
      // number the installer's phone will.
      x.scheduledLateMin=s.lateMin||'';
      // Only the routes recomputed this run are touched — an earlier one is left
      // exactly as it was rather than quietly deleted.
      for(const v of Object.keys(variantPos)){
        const f = VARIANT_FIELDS[v], p = variantPos[v][x.id];
        x[f.order] = p ? p.order : '';
        x[f.day] = p ? p.day : '';
        x[f.legMeters] = p ? p.legMeters : '';
        x[f.homeLegMeters] = p ? p.homeLegMeters : '';
        // The sequence just changed, so any saved geometry is keyed to the OLD
        // order and would draw wrong legs. Clear BOTH the between-stops path and the
        // crew-start drive-out (which stop is a day's first can change on reorder);
        // fetchVariantGeometry below always refills the drive-out (straight if OSRM
        // is down) and the road legs when OSRM is up.
        x[f.geometry] = '';
        x[f.homeLegGeometry] = '';
      }
    });
    items = seq;
    for(const x of items) await idb.put('worklist', x);
    store.set('plannerVariant:' + h, primaryVariant);
    if(base.variants.straight) store.set('plannerStraightSource:' + h, base.straightDistanceSource);
    // Fetch the real road path for every leg of both variants while OSRM is up —
    // usedFallback means the matrix already fell back off OSRM, so /route would
    // fail too; skip it then rather than hammer a down server.
    await fetchVariantGeometry(osrmUrl, start, health.osrm.online && !usedFallback);
    render();
    const who = roster.employees.find(e => String(e.hNumber) === h);
    const runRecord = {
      ...createLastRunRecord({ at:new Date().toISOString(), provenance:base.provenance }),
      installer:who ? fullName(who) : '', hNumber:h, pendingCount:pending.length,
    };
    store.set('plannerLastOptimize', JSON.stringify(runRecord));
    renderLastOptimization(runRecord);
    const short = s => String(s || '').length > 70 ? String(s).slice(0, 70) + '…' : String(s || '');
    const ambig = pending.filter(x => x.geoAmbig && x.geoAmbig.length).length;
    const failed = parkedIds.length - ambig;
    const days = Object.keys(dayOf || {}).reduce((m, id) => Math.max(m, dayOf[id]), 0);
    const totalM = Object.values(prim.legMeters).reduce((a, b) => a + b, 0);
    toast((mode === 'start-home' ? 'Route ends near home · ETA timed from the crew start ✓'
        : mode === 'start' ? 'Route ETA timed from the crew start ✓'
        : mode === 'home' ? 'Route ends near the anchor ✓'
        : 'Route starts at the first order ✓')
      + ` · ${fmtKm(totalM)}`
      + (days > 1 ? ` · ${days} days of ${target}` : '')
      + (usedFallback ? ` — straight-line (${short(fallbackReason)})` : '')
      + (failed > 0 ? ` · ${failed} parked (fix address)` : '')
      + (ambig > 0 ? ` · ${ambig} need a town picked below` : '')
      + (geoReason && parkedIds.length ? ` · lookups failed: ${short(geoReason)}` : '')
      + (note ? ` · ${short(note)}` : ''));
  } catch (err) {
    toast((err && err.message) || 'Optimize failed — try again');
  } finally {
    prog.classList.add('hide'); prog.textContent = '';
  }
}

// ── directions geometry ──────────────────────────────────────────────────────
// Walk each variant's saved sequence and store each leg's drawn path on the
// ARRIVING order (matching how legMetersFor charges each leg). Between-stops legs
// get the real OSRM /route road path when the server is up (`osrmOnline`), else
// blank (the map draws a clean straight leg). A day's FIRST stop stores the
// crew-start drive-out instead: the OSRM road path when up, else a straight
// two-point line — drawn even with OSRM offline so the faint drive-out line + the
// start pin always show when a crew start exists. One local OSRM GET per road leg.
async function fetchVariantGeometry(osrmUrl, start, osrmOnline){
  const prog = $('plProg');
  let fetched = 0, missed = 0, total = 0;
  for(const v of VARIANTS){
    const f = VARIANT_FIELDS[v];
    const routed = pendingItems()
      .filter(x => !isParked(x) && coordsOf(x) && x[f.order] !== '' && x[f.order] != null)
      .sort((a, b) => Number(a[f.order]) - Number(b[f.order]));
    const prevByDay = {};
    for(const x of routed){
      const day = x[f.day] || 0;
      const prev = prevByDay[day] ? coordsOf(prevByDay[day]) : null;  // no prev → first stop of the day (drive-out)
      if(prev){
        if(osrmOnline){
          total++;
          if(prog) prog.textContent = `Fetching directions… ${total}`;
          const g = await osrmLegGeometry(prev, coordsOf(x), osrmUrl);
          if(g){ x[f.geometry] = g; fetched++; } else { x[f.geometry] = ''; missed++; }
        } else {
          x[f.geometry] = '';   // OSRM down → straight leg
        }
      } else {
        x[f.geometry] = '';   // a day's first stop has no incoming between-stops leg
        // Draw the drive out from the crew start: OSRM road path when up, else a
        // straight two-point line, else nothing (no crew start).
        const sc = coordsOf(start), fc = coordsOf(x);
        if(sc && fc){
          const road = osrmOnline ? await osrmLegGeometry(start, x, osrmUrl) : '';
          x[f.homeLegGeometry] = road || encodePolyline([[sc.lat, sc.lng], [fc.lat, fc.lng]]);
        } else {
          x[f.homeLegGeometry] = '';
        }
      }
      prevByDay[day] = x;
      await idb.put('worklist', x);
    }
  }
  return { fetched, missed };
}

// On-demand refresh: fetch road geometry for the CURRENT sequences without
// re-solving. Useful after a manual drag or an address fix, or on a list loaded
// from the sheet that was optimized on another machine.
async function requestDirections(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  if(!pendingItems().length){ toast('No orders to route'); return; }
  const btn = $('plDirections'); btn.disabled = true;
  const prog = $('plProg'); prog.classList.remove('hide'); prog.textContent = 'Checking OSRM…';
  try{
    const health = await checkServices();
    if(!health.osrm.online){ toast('OSRM offline — start the local server (DEPLOY.md)'); return; }
    const urls = providerUrls();
    const { start } = await planAnchors(urls.geocode);
    const { fetched, missed } = await fetchVariantGeometry(urls.osrm, start, true);
    render();
    toast(fetched
      ? `Directions saved ✓ · ${fetched} legs${missed ? ` · ${missed} missed` : ''} — ⇪ Upload to send`
      : 'No routed legs yet — Optimize first');
  } catch(err){
    toast((err && err.message) || 'Directions failed');
  } finally {
    btn.disabled = false; prog.classList.add('hide'); prog.textContent = '';
  }
}

// ── upload ──────────────────────────────────────────────────────────────────
async function upload(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  if(!items.length && !confirm('The list is empty — uploading clears their saved copy. Continue?')) return;
  const who = roster.employees.find(e => String(e.hNumber) === h);
  if(items.length && !confirm(`Upload ${items.length} orders as ${who ? fullName(who) : h}'s list? This replaces their saved copy on the sheet — they get it with ⇩ Download.`)) return;
  setStatus('wait','Uploading…');
  try{
    const r = await apiPost({ action:'saveWorklist', hNumber: h,
      installer: who ? fullName(who) : '', orders: items.map(wireShape), plan:planShape() });
    if(!r.ok) throw new Error(r.error || 'upload failed');
    setStatus('ok','Synced');
    toast('Uploaded ✓ — ready for the phone’s ⇩ Download');
  } catch { setStatus('off','Error'); toast('Upload failed — check signal'); }
}

// ── render (list + map) ─────────────────────────────────────────────────────
function plannerPlacement(item){
  const pending = pendingItems();
  const { day, slot } = currentRoutePlacement(pending, item.id, targetVal());
  return {
    date:item.scheduledDate || item.appointmentDate || addWorkdays(planShape().routeStartDate, day - 1),
    slot
  };
}
// Set an order aside (or bring it back). It leaves the route and the day counts
// but stays on the list and still uploads — the nightly sweep only clears
// completed orders, so nothing is lost by parking one for a week.
async function togglePlannerIgnored(item){
  item.ignored = !isIgnored(item);
  item.updatedAt = stamp();
  await idb.put('worklist', item);
  toast(item.ignored ? 'Set aside — left out of the route' : 'Back in the route');
  render();
}

// The office plans the WEEK, so this stays the whole multi-day plan while the
// phone's headline is day 1 alone (js/worklist.js HEADLINE_DAY). That difference
// is deliberate and therefore has to be visible: `days:true` makes the figure
// name its own span, so a number that spans four days can never be read as one
// day's driving — which is precisely how 241 km ended up on a screen whose day
// headers read 2.2 km. Phone/planner drift is called out by name in AGENTS.md;
// a label is what keeps this a decision instead of the same bug from the other
// end.
function routeTotalText(){
  return routeTotalSummary(items, activeVariant(),
    store.get('plannerStraightSource:' + hNumber()) || '', { days: true });
}

// The road / straight-line switch. A route that hasn't been worked out — or one
// whose sequence no longer covers the orders on hand — is disabled rather than
// hidden, so it stays visible that a second route is available to be had.
function paintVariantSwitch(){
  const box = $('plVariant');
  if(!box) return;
  const active = activeVariant();
  const src = store.get('plannerStraightSource:' + hNumber()) || '';
  let any = false;
  for(const v of VARIANTS){
    const btn = $(v === 'road' ? 'plVariantRoad' : 'plVariantStraight');
    if(!btn) continue;
    const s = variantSummary(items, v, { active:v === active, straightDistanceSource:src,
      days: true });
    const on = s.selectable && v === active;
    btn.disabled = !s.selectable;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = s.stale ? 'Saved, but the orders have changed since — optimize again to use it'
      : s.selectable ? 'Make this the route the installer gets'
      : 'Not worked out yet — Optimize to compare both routes';
    btn.innerHTML = `<span class="plvariant-name">${esc(s.label)}</span>`
      + `<span class="plvariant-km">${esc(s.text)}</span>`;
    if(s.selectable) any = true;
  }
  box.classList.toggle('hide', !any);
}

async function switchVariant(v){
  if(v === activeVariant()) return;
  if(!variantSelectable(items, v)) return;
  let next;
  try { next = applyVariant(items, v, { ...planShape(), target:targetVal(),
    day1Count: plDay1Count() }); }
  catch(err){ toast((err && err.message) || 'That route can’t meet the fixed appointments'); return; }
  const now = stamp();
  items = next.map(x => Object.assign({}, x, { updatedAt:now }));
  for(const x of items) await idb.put('worklist', x);
  store.set('plannerVariant:' + hNumber(), v);
  toast(`${VARIANT_LABELS[v]} route in use ✓ — ⇪ Upload to send it`);
  render();
}

// The office's 🔓/🔒. Locking simply records the date this route starts on — the
// membership is already on the rows as `day === 1`, so there is nothing else to
// freeze. Uploading sends it, and the installer's phone adopts it on ⇩ Download.
async function toggleDayLock(){
  const date = $('plRouteDate').value || '';
  if(!date){ toast('Pick the route start date first'); return; }
  if(plDayLocked()){
    store.set('plannerDayLock:' + hNumber(), '');
    toast('🔓 Unlocked — Optimize will re-plan every day');
  } else if(!plLockedDay1Ids().length && !taggedDay1Ids(pendingItems()).length){
    toast('Optimize first — there is no day 1 to lock yet');
    return;
  } else {
    store.set('plannerDayLock:' + hNumber(), date);
    const n = taggedDay1Ids(pendingItems()).length;
    toast(`🔒 Locked — ${n} order${n === 1 ? '' : 's'} on day 1 · ⇪ Upload to send it`);
  }
  render();
}

function paintDayLock(){
  const btn = $('plDayLock'), sub = $('plDayLockSub');
  if(!btn) return;
  const on = plDayLocked();
  const n = on ? plLockedDay1Ids().length : 0;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? `🔒 Day 1 locked — ${n} order${n === 1 ? '' : 's'}` : '🔓 Day 1 is open';
  if(sub) sub.textContent = on
    ? 'Optimize keeps exactly these orders on day 1'
    : 'Optimize sizes every day by the meters/day target';
  const t = $('plTarget');
  if(t){
    t.readOnly = on;
    t.setAttribute('aria-readonly', on ? 'true' : 'false');
    t.classList.toggle('locked', on);
  }
}

async function togglePlannerLock(item){
  if(item.lockedDate){ item.lockedDate=''; item.lockedSlot=''; toast('Position unlocked'); }
  else {
    const p = plannerPlacement(item); item.lockedDate=p.date; item.lockedSlot=p.slot;
    toast(`Locked to ${p.date} · slot ${p.slot}`);
  }
  item.updatedAt=stamp(); await idb.put('worklist', item); render();
}

function render(){
  const pending = pendingItems(), done = items.filter(x => x.wlStatus === 'done');
  const aside = ignoredItems();
  $('plCounts').textContent = items.length
    ? [`${pending.length} pending`, aside.length ? `${aside.length} set aside` : '',
       `${done.length} completed`, routeTotalText()].filter(Boolean).join(' · ') : '';
  paintVariantSwitch();
  paintDayLock();
  const list = $('plList'); list.innerHTML = '';
  if(!items.length){
    list.innerHTML = '<div class="card"><div class="empty">No orders — ⇩ Load the installer’s saved list or paste orders in.</div></div>';
    renderMap();
    return;
  }
  const variant = activeVariant();
  // Times (per-stop ETA + the day clock window) come from real road durations, so
  // they show only on the road variant. A straight-line route has no durations, so
  // it shows distances only — never a time it can't actually estimate.
  const showTimes = variant === 'road';
  const card = document.createElement('div');
  card.className = 'card';
  let curDay = null;
  [...pending, ...done, ...aside].forEach((item, i) => {
    const setAside = item.wlStatus !== 'done' && isIgnored(item);
    if(setAside && curDay !== 'aside'){
      curDay = 'aside';
      const hdr = document.createElement('div');
      hdr.className = 'plday plaside-head';
      hdr.innerHTML = `Set aside · ${aside.length} order${aside.length === 1 ? '' : 's'}`
        + '<span class="plday-eta">not routed — still saved &amp; uploaded</span>';
      card.appendChild(hdr);
    }
    // Day-group header before the first order of each day (pending only).
    const d = isPending(item) ? (item.day || null) : null;
    if(d && d !== curDay){
      curDay = d;
      const count = pending.filter(p => (p.day || null) === d).length;
      const date = (pending.find(p => (p.day || null) === d) || {}).scheduledDate || '';
      const km = liveDayMeters(items, variant, d);
      const startKm = dayHomeMeters(items, variant, d);
      const hdr = document.createElement('div');
      hdr.className = 'plday';
      hdr.title = 'Distance is the drive between stops. "start" is the saved drive out '
        + 'from the crew start location to the first stop — measured for reference, not in the total.';
      hdr.innerHTML = `<span class="plday-dot" style="background:${dayColor(d)}"></span>`
        + `Day ${d}${date ? ` · ${esc(date)}` : ''} · ${count} meter${count === 1 ? '' : 's'}`
        + (km == null ? '' : ` · ${esc(fmtKm(km))}`)
        + (startKm == null ? '' : ` · start ${esc(fmtKm(startKm))}`)
        + ` — ends near home<span class="plday-eta">${esc(showTimes
            ? (dayWindow(pending, d) || dayEta(count)) : dayEta(count))}</span>`;
      card.appendChild(hdr);
    }
    const row = document.createElement('div');
    row.className = 'plrow' + (item.wlStatus === 'done' ? ' pldone' : '')
      + (setAside ? ' plaside' : '') + (item.lockedDate ? ' locked' : '');
    const located = !!coordsOf(item);
    // Flag badges BEFORE the located check — a parked order keeps its last
    // good pin, so coords-present must not hide its warning state.
    const tag = item.geoFail ? ' <span class="pltag" title="Address didn’t map">📍?</span>'
      : (item.geoAmbig && item.geoAmbig.length) ? ' <span class="pltag">⚠ which town?</span>'
      : (located ? '' : ' <span class="pltag pltag-mute" title="Not geocoded yet">·</span>');
    row.innerHTML = `
      <span class="plpos">${item.wlStatus === 'done' ? '✓' : setAside ? '–' : (i + 1)}</span>
      <div class="plmain">
        <strong>${item.workOrderId ? 'WO ' + esc(item.workOrderId) : '(no WO#)'}</strong>${
          setAside ? ' <span class="pltag pltag-mute" title="Left out of the route — still saved">set aside</span>' : ''}
        <div class="pladdr">${esc(item.address || '')}${setAside ? '' : tag}</div>
        <div class="plmeta">${item.appointmentTime ? `🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)}` : ''}${(showTimes && item.scheduledEta) ? `<span>ETA ${esc(item.scheduledEta)}${Number(item.scheduledWaitMin)>0 ? ` · wait ${Number(item.scheduledWaitMin)}m` : ''}</span>` : ''}${Number(item.scheduledLateMin)>0 ? `<span class="pllate" title="No slot in the day reaches this appointment on time">⚠ ${Math.round(Number(item.scheduledLateMin))}m late</span>` : ''}${item.lockedDate ? `<span>🔒 ${esc(item.lockedDate)} · slot ${Number(item.lockedSlot)}</span>` : ''}</div>
        ${isPending(item) ? `<div class="plappt">
          <label>🔔 Date<input data-appt="date" type="date" value="${esc(item.appointmentDate||'')}"></label>
          <label>Time<input data-appt="time" type="time" value="${esc(item.appointmentTime||'')}"></label>
          <button class="pllock${item.lockedDate ? ' on' : ''}" type="button" aria-label="${item.lockedDate ? 'Unlock position' : 'Lock current position'}">${item.lockedDate ? '🔒' : '🔓'}</button>
        </div>` : ''}
        ${(!setAside && item.geoAmbig && item.geoAmbig.length) ? `<div class="plchips">${
          item.geoAmbig.map((c, ci) => `<button class="chip" data-ci="${ci}" type="button">${esc(c.label)}</button>`).join('')
        }</div>` : ''}
        ${item.wlStatus !== 'done' ? `<div class="pledit hide">
          <label>WO#<input data-edit="wo" value="${attr(item.workOrderId||'')}"></label>
          <label>Address<input data-edit="addr" value="${attr(item.address||'')}"></label>
          <label>Old J#<input data-edit="oldj" value="${attr(item.oldJNumber||'')}"></label>
          <div class="pledit-actions">
            <button class="pledit-save" type="button">Save</button>
            <button class="pledit-cancel" type="button">Cancel</button>
          </div>
        </div>` : ''}
      </div>
      ${item.wlStatus !== 'done' ? `<button class="pledit-btn" type="button" aria-label="Edit order">✏️</button>` : ''}
      ${item.wlStatus !== 'done' ? `<button class="plaside-btn${setAside ? ' on' : ''}" type="button" aria-label="${setAside ? 'Put back in the route' : 'Set aside — leave out of the route'}">${setAside ? '↩' : '🚫'}</button>` : ''}
      <button class="pldel" type="button" aria-label="Remove">✕</button>`;
    const asideBtn = row.querySelector('.plaside-btn');
    if(asideBtn) asideBtn.onclick = () => togglePlannerIgnored(item);
    const lock = row.querySelector('.pllock'); if(lock) lock.onclick = () => togglePlannerLock(item);
    const dateInput = row.querySelector('[data-appt="date"]');
    const timeInput = row.querySelector('[data-appt="time"]');
    const saveAppointment = async () => {
      const date = dateInput.value, time = timeInput.value;
      if(Boolean(date) !== Boolean(time)) return;
      item.appointmentDate=date; item.appointmentTime=time; item.updatedAt=stamp();
      item.scheduledDate=''; item.scheduledEta=''; item.scheduledSlot=''; item.scheduledWaitMin='';
      item.scheduledLateMin='';   // a changed appointment time invalidates the verdict too
      await idb.put('worklist', item); render();
    };
    if(dateInput) dateInput.onchange = saveAppointment;
    if(timeInput) timeInput.onchange = saveAppointment;
    row.querySelectorAll('.chip').forEach(chip => { chip.onclick = async () => {
      const c = item.geoAmbig[Number(chip.dataset.ci)];
      if(!c) return;
      item.lat = c.lat; item.lng = c.lng; item.geoFail = false; item.geoAmbig = undefined; item.updatedAt = stamp();
      await idb.put('worklist', item);
      toast('Town pinned ✓ — optimize again to route it');
      render();
    }; });
    const editBtn = row.querySelector('.pledit-btn');
    const editForm = row.querySelector('.pledit');
    if(editBtn && editForm){
      editBtn.onclick = () => {
        editForm.classList.toggle('hide');
        if(!editForm.classList.contains('hide')) editForm.querySelector('[data-edit="wo"]').focus();
      };
      editForm.querySelector('.pledit-cancel').onclick = () => editForm.classList.add('hide');
      editForm.querySelector('.pledit-save').onclick = async () => {
        const wo = editForm.querySelector('[data-edit="wo"]').value.trim();
        const addr = editForm.querySelector('[data-edit="addr"]').value.trim();
        const oldj = editForm.querySelector('[data-edit="oldj"]').value.trim();
        const addrChanged = addr !== String(item.address || '');
        item.workOrderId = wo; item.oldJNumber = oldj; item.updatedAt = stamp();
        if(addrChanged){
          // Hand-edited address invalidates the pin (like the phone) AND the saved
          // road geometry — the stop has moved, so both must be re-derived.
          item.address = addr;
          item.lat = undefined; item.lng = undefined;
          item.geoFail = false; item.geoAmbig = undefined;
          item.legGeometryRoad = ''; item.legGeometryStraight = '';
          item.homeLegGeometryRoad = ''; item.homeLegGeometryStraight = '';
        }
        await idb.put('worklist', item);
        toast(addrChanged ? 'Saved ✓ — Optimize to re-locate the new address' : 'Saved ✓');
        render();
      };
    }
    row.querySelector('.pldel').onclick = async () => {
      await idb.del('worklist', item.id);
      items = items.filter(x => x.id !== item.id);
      toast('Order removed');
      render();
    };
    card.appendChild(row);
  });
  list.appendChild(card);
  renderMap();
}

// Numbered pins in route order + the connecting line, so a wrong-town pin or a
// zig-zag is obvious before it reaches the phone. A parked order that still
// carries a pin (kept, never blanked) shows as a muted "!" marker OFF the
// line — visible (catching bad pins before upload is this map's job, and a
// far pin zooming the map out is the feature) but never read as a route stop.
function renderMap(){
  if(typeof L === 'undefined') return;         // vendored Leaflet not loaded yet
  if(!map){
    map = L.map('plMap', { zoomControl: true }).setView([45.0, -79.3], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }
  mapLayer.clearLayers();
  const all = [];
  // Polyline points grouped by day (each day drawn in its own color). Ungrouped
  // when there's no day split — one neutral line. When the active variant carries
  // saved OSRM road geometry, each leg is drawn along its real path; a leg with no
  // geometry falls back to a straight segment between the two pins. A day's FIRST
  // stop has no incoming leg — the drive out to it (from the crew start) is not
  // drawn (only measured, see homeLegMetersFor), so the route starts at the first pin.
  const segs = {};
  const showTimes = activeVariant() === 'road';   // ETAs only on the road variant
  // Only draw saved road geometry while the live order still matches the order it
  // was fetched against — after a manual edit the geometry is stale, so fall back
  // to straight legs rather than draw the previous route's roads.
  const geomField = variantMatchesLive(items, activeVariant())
    ? VARIANT_FIELDS[activeVariant()].geometry : null;
  const homeGeomField = variantMatchesLive(items, activeVariant())
    ? VARIANT_FIELDS[activeVariant()].homeLegGeometry : null;
  const prevByDay = {};      // last routed coord seen per day (nothing before the first)
  const driveOuts = [];      // faint crew-start → first-stop segments + start point
  pendingItems().forEach((item, i) => {
    const c = coordsOf(item);
    if(!c) return;
    const parked = isParked(item);
    const day = item.day || 0;
    const color = day ? dayColor(day) : '#2b6cff';
    if(!parked){                                  // polyline + numbering: routed only
      const prev = prevByDay[day];
      if(!prev && homeGeomField){                 // day's first stop → faint drive-out
        const home = decodePolyline(item[homeGeomField]);
        if(home.length) driveOuts.push(home);
      }
      const leg = decodePolyline(item[geomField]);
      const pts = leg.length ? leg
        : (prev ? [[prev.lat, prev.lng], [c.lat, c.lng]] : [[c.lat, c.lng]]);
      (segs[day] = segs[day] || []).push(...pts);
      prevByDay[day] = c;
    }
    all.push([c.lat, c.lng]);
    const marker = L.marker([c.lat, c.lng], { icon: L.divIcon({
      className: 'plpin' + (parked ? ' plpin-parked' : ''),
      html:`<span>${parked ? '!' : i + 1}</span>`,
      iconSize:[26,26], iconAnchor:[13,13] }) })
      .bindTooltip(`${parked ? '⚠ parked — ' : (day ? 'Day ' + day + ' · ' : '') + (i + 1) + '. '}${item.workOrderId ? 'WO ' + item.workOrderId + ' — ' : ''}${item.address || ''}${(showTimes && item.scheduledEta) ? ' · ETA ' + item.scheduledEta : ''}${item.appointmentTime ? ' · appointment ' + item.appointmentTime : ''}`)
      .addTo(mapLayer);
    // Tint the routed pin by day (parked keeps the muted grey from CSS).
    if(!parked && day){ const el = marker.getElement(); if(el) el.style.background = color; }
  });
  Object.keys(segs).forEach(day => {
    const pts = segs[day];
    if(pts.length > 1) L.polyline(pts, { weight: 3, opacity: .75,
      color: Number(day) ? dayColor(day) : '#2b6cff' }).addTo(mapLayer);
  });
  // Faint dashed drive-out(s) from the crew start + one start pin.
  driveOuts.forEach(seg => {
    if(seg.length > 1) L.polyline(seg, { weight:3, opacity:.35, dashArray:'6 6', color:'#64748b' }).addTo(mapLayer);
  });
  if(driveOuts.length){
    const s = driveOuts[0][0];
    L.marker(s, { icon: L.divIcon({ className:'plpin plpin-start', html:'<span>▶</span>',
      iconSize:[24,24], iconAnchor:[12,12] }) }).bindTooltip('Crew start').addTo(mapLayer);
    all.push(s);
  }
  if(all.length) map.fitBounds(L.latLngBounds(all).pad(0.2));
}

// ── wiring ──────────────────────────────────────────────────────────────────
$('plWho').onchange = async () => {
  const h = hNumber();
  // Recall this installer's remembered end-near anchor.
  let addr = '';
  try{ addr = (JSON.parse(store.get('plannerHome:' + h) || 'null') || {}).addr || ''; } catch {}
  $('plHome').value = addr;
  loadPlan(null);
  showAvgDay();            // pull their avg/day reference for the target field
  await setItems([]);      // don't mix installers — load or paste fresh
};
$('plLoad').onclick = loadList;
$('plImportBtn').onclick = () => $('plImport').classList.toggle('hide');
$('plPasteAdd').onclick = importPaste;
$('plOptimize').onclick = requestOptimize;
$('plDirections').onclick = requestDirections;
$('plUpload').onclick = upload;
$('plVariantRoad').onclick = () => switchVariant('road');
$('plVariantStraight').onclick = () => switchVariant('straight');
$('plDayLock').onclick = toggleDayLock;
// The lock is keyed on the date the route starts, so moving that date releases it —
// the same rule the phone follows. Repaint so the band says so rather than leaving a
// stale 🔒 over a day nobody locked.
$('plRouteDate').onchange = () => render();
$('plPace').onchange = () => {
  const p = planShape(); $('plPace').value = String(p.paceMin);
  store.set('plannerPaceSource:' + hNumber(), 'override');
  $('plPaceHint').textContent = `Plan override: ${p.paceMin} min/stop`;
};

// Offline map districts (panel stays hidden unless the build service is up).
// ✏️ Draw is always a NEW district — leaving an extend armed here is how you
// would silently rebuild somebody else's district over a fresh rectangle.
$('plDrawDistrict').onclick   = () => {
  clearExtend();
  districtBox = null;
  paintDistrictShapes();
  startDrawing();
};
$('plDrawCancel').onclick     = stopDrawing;
$('plDistrictBuild').onclick  = buildDistrict;
$('plDistrictPublish').onclick = publishDistricts;
// The rows are re-rendered on every refresh, so the buttons are delegated
// rather than bound per row.
$('plDistrictList').onclick = e => {
  const btn = e.target.closest('button[data-extend], button[data-remove]');
  if(!btn) return;
  const known = (builderState && builderState.districts) || [];
  const id = btn.dataset.extend || btn.dataset.remove;
  const d = known.find(x => x && x.id === id);
  if(btn.dataset.extend) beginExtend(d || { id });
  else removeDistrict(id, d && d.name);
};
$('plDistrictName').oninput = () => {
  // Fill the id from the name until someone types their own.
  const idEl = $('plDistrictId');
  if(!idEl.dataset.touched) idEl.value = slugify($('plDistrictName').value);
  updateDistrictButtons();
};
$('plDistrictId').oninput = e => { e.target.dataset.touched = '1'; updateDistrictButtons(); };
checkBuilder();

$('navSel').onchange = e => {
  const v = e.target.value;
  if(v==='log')            window.location.href = 'index.html';
  else if(v==='map')       window.location.href = 'map.html';
  else if(v==='analytics') window.location.href = 'map.html#analytics';
  else if(v==='teams')     window.location.href = 'teams.html';
  else if(v==='edit')      window.location.href = 'edit.html';
  else if(v==='reports')   window.location.href = 'reports.html';
  else if(v==='help')      window.location.href = 'help.html';
};
window.addEventListener('pageshow', () => { $('navSel').value = 'planner'; });

$('plOsrm').value = store.get('plannerOsrm') || DEFAULT_OSRM_URL;
$('plGeo').value = store.get('plannerGeocode') || DEFAULT_NOMINATIM_URL;
$('plOsrm').onchange = () => {
  $('plOsrm').value = providerUrls().osrm;
  store.set('plannerOsrm', $('plOsrm').value);
  checkServices();
};
$('plGeo').onchange = () => {
  $('plGeo').value = providerUrls().nominatim;
  store.set('plannerGeocode', $('plGeo').value);
  checkServices();
};
window.addEventListener('focus', checkServices);
window.addEventListener('online', checkServices);
window.addEventListener('offline', checkServices);
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') checkServices();
});
setInterval(() => {
  if(document.visibilityState === 'visible') checkServices();
}, 30000);
renderLastOptimization(parsePlannerLastRunRecord(store.get('plannerLastOptimize')));
loadPlan(null);
render();
loadRoster().then(paintWhoSelect);
checkServices();
