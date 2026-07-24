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
import { stamp, localDate } from '../time.js';
import { optimizeRoute, geocodeOne, coordsOf, isParked, legMetersFor, osrmLegGeometry, decodePolyline } from '../route.js';
import { addWorkdays, currentRoutePlacement, scheduleRouteConstraints } from '../route-constraints.js';
import {
  VARIANTS, VARIANT_FIELDS, VARIANT_LABELS, applyVariant, fmtKm, isIgnored, isPending,
  liveDayMeters, pendingOf, routeTotalSummary, variantSelectable, variantSummary,
} from '../route-variants.js';
import {
  DEFAULT_NOMINATIM_URL, DEFAULT_OSRM_URL, buildOptimizeConfirmation,
  createLastRunRecord, createLatestProbeRunner, formatLastRunSummary, parsePlannerLastRunRecord,
  probeNominatim, probeOsrm,
} from '../planner-services.js';

let roster = { employees: [] };
let items = [];              // the selected installer's orders, display order
let map = null, mapLayer = null;   // Leaflet instances (lazy)
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

function nextWeekday(date){
  const d = new Date(`${date}T12:00:00`);
  while(d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function planShape(){
  return {
    routeStartDate:$('plRouteDate').value || nextWeekday(localDate()),
    firstStopTime:$('plRouteTime').value || '08:00',
    paceMin:Math.max(1, Math.round(Number($('plPace').value) || 30)),
    paceSource:store.get('plannerPaceSource:' + hNumber()) || 'fallback',
    routeVariant:activeVariant(),
    straightDistanceSource:store.get('plannerStraightSource:' + hNumber()) || ''
  };
}
// Which saved route is live for this installer. Uploaded with the list, so the
// phone opens on the route the office chose — and the installer can still flip it.
function activeVariant(){
  return store.get('plannerVariant:' + hNumber()) === 'straight' ? 'straight' : 'road';
}
function loadPlan(plan){
  const p = plan || {};
  $('plRouteDate').value = p.routeStartDate || nextWeekday(localDate());
  $('plRouteTime').value = p.firstStopTime || '08:00';
  $('plPace').value = String(Math.max(1, Number(p.paceMin) || 30));
  store.set('plannerPaceSource:' + hNumber(), p.paceSource || store.get('plannerPaceSource:' + hNumber()) || 'fallback');
  if(p.routeVariant) store.set('plannerVariant:' + hNumber(), p.routeVariant === 'straight' ? 'straight' : 'road');
  if(p.straightDistanceSource) store.set('plannerStraightSource:' + hNumber(), p.straightDistanceSource);
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

// The picked installer's cadence: fills the avg/day hint beside the target field.
async function showAvgDay(){
  const el = $('plAvgDay');
  avgLogMin = null; avgPerDay = null;
  if(el) el.textContent = '';
  const h = hNumber();
  if(!h) return;
  try{
    const r = await apiGet('installerMetrics', { hNumber: h, workType:'land' });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
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
    ignored:isIgnored(x),
    orderRoad:blank(x.orderRoad), dayRoad:blank(x.dayRoad), legMetersRoad:blank(x.legMetersRoad),
    orderStraight:blank(x.orderStraight), dayStraight:blank(x.dayStraight),
    legMetersStraight:blank(x.legMetersStraight),
    legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || '') };
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
      ignored:isIgnored(o),
      orderRoad:blank(o.orderRoad), dayRoad:blank(o.dayRoad), legMetersRoad:blank(o.legMetersRoad),
      orderStraight:blank(o.orderStraight), dayStraight:blank(o.dayStraight),
      legMetersStraight:blank(o.legMetersStraight),
      legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || '') })));
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
// The already-geocoded end-near anchor, read straight from cache (no lookup) —
// used by the on-demand directions fetch, where re-geocoding would be wasteful.
function cachedHomeAnchor(){
  try{
    const s = JSON.parse(store.get('plannerHome:' + hNumber()) || 'null');
    if(s && isFinite(s.lat) && isFinite(s.lng)) return { lat:s.lat, lng:s.lng };
  } catch {}
  return null;
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
  const prog = $('plProg');
  prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try{
    const home = await homePin(geocodeUrl);
    // The planner is the road-matrix path, so it always asks for the second,
    // straight-line ordering too — one extra local solve, no extra lookup.
    const base = await optimizeRoute(pending, progress, home,
      { osrmUrl, geocodeUrl, osrmReady:health.osrm.online, compareVariants:true });
    const { parkedIds, usedFallback, fallbackReason, mode, geoReason, note } = base;
    const byId = {}; items.forEach(x => { byId[x.id] = x; });
    const blocked = parkedIds.map(id => byId[id]).filter(x => x && (x.appointmentDate || x.lockedDate));
    if(blocked.length) throw new Error('Fix the address before routing constrained ' +
      blocked.map(x => `WO ${x.workOrderId || x.id}`).join(', '));
    const planOpts = { ...planShape(), target };
    // Schedule and price each route this run produced. Appointments and locks can
    // move stops, so the legs are measured after that — and both routes against
    // the same matrix, which is what makes their totals comparable.
    const computed = {};
    for(const v of VARIANTS){
      const variant = base.variants[v];
      if(!variant) continue;
      const routedItems = variant.orderedIds.map(id => byId[id]).filter(Boolean);
      const s = scheduleRouteConstraints(routedItems, variant.orderedIds, planOpts);
      computed[v] = { ...s, legMeters: legMetersFor(base.measure, s.orderedIds, s.dayOf) };
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
          legMeters:c.legMeters[id] == null ? '' : c.legMeters[id] };
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
      // Only the routes recomputed this run are touched — an earlier one is left
      // exactly as it was rather than quietly deleted.
      for(const v of Object.keys(variantPos)){
        const f = VARIANT_FIELDS[v], p = variantPos[v][x.id];
        x[f.order] = p ? p.order : '';
        x[f.day] = p ? p.day : '';
        x[f.legMeters] = p ? p.legMeters : '';
      }
    });
    items = seq;
    for(const x of items) await idb.put('worklist', x);
    store.set('plannerVariant:' + h, primaryVariant);
    if(base.variants.straight) store.set('plannerStraightSource:' + h, base.straightDistanceSource);
    // Fetch the real road path for every leg of both variants while OSRM is up —
    // usedFallback means the matrix already fell back off OSRM, so /route would
    // fail too; skip it then rather than hammer a down server.
    if(health.osrm.online && !usedFallback) await fetchVariantGeometry(osrmUrl, home);
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
    toast((mode === 'home' ? 'Route ends near the anchor ✓' : 'Route starts at the first order ✓')
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
// Walk each variant's saved sequence and ask OSRM /route for the actual road path
// of every leg, storing the encoded polyline on the ARRIVING order (matching how
// legMetersFor charges each leg). A day's first stop is measured from the home
// anchor. Runs both during Optimize (home passed in) and from the on-demand
// button (home read from cache). One local OSRM GET per leg — free and fast.
async function fetchVariantGeometry(osrmUrl, home){
  const anchor = home || cachedHomeAnchor();
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
      const prev = prevByDay[day] ? coordsOf(prevByDay[day]) : anchor;  // day's first leg starts at home
      if(prev){
        total++;
        if(prog) prog.textContent = `Fetching directions… ${total}`;
        const g = await osrmLegGeometry(prev, coordsOf(x), osrmUrl);
        if(g){ x[f.geometry] = g; fetched++; } else { x[f.geometry] = ''; missed++; }
      } else {
        x[f.geometry] = '';   // no home anchor → nothing to draw for a day's first stop
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
    const { fetched, missed } = await fetchVariantGeometry(providerUrls().osrm, null);
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

function routeTotalText(){
  return routeTotalSummary(items, activeVariant(),
    store.get('plannerStraightSource:' + hNumber()) || '');
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
    const s = variantSummary(items, v, { active:v === active, straightDistanceSource:src });
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
  try { next = applyVariant(items, v, { ...planShape(), target:targetVal() }); }
  catch(err){ toast((err && err.message) || 'That route can’t meet the fixed appointments'); return; }
  const now = stamp();
  items = next.map(x => Object.assign({}, x, { updatedAt:now }));
  for(const x of items) await idb.put('worklist', x);
  store.set('plannerVariant:' + hNumber(), v);
  toast(`${VARIANT_LABELS[v]} route in use ✓ — ⇪ Upload to send it`);
  render();
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
  const list = $('plList'); list.innerHTML = '';
  if(!items.length){
    list.innerHTML = '<div class="card"><div class="empty">No orders — ⇩ Load the installer’s saved list or paste orders in.</div></div>';
    renderMap();
    return;
  }
  const variant = activeVariant();
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
      const hdr = document.createElement('div');
      hdr.className = 'plday';
      hdr.title = 'Distance covers the drive out and between stops, not the drive home.';
      hdr.innerHTML = `<span class="plday-dot" style="background:${dayColor(d)}"></span>`
        + `Day ${d}${date ? ` · ${esc(date)}` : ''} · ${count} meter${count === 1 ? '' : 's'}`
        + (km == null ? '' : ` · ${esc(fmtKm(km))}`)
        + ` — ends near home<span class="plday-eta">${esc(dayEta(count))}</span>`;
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
        <div class="plmeta">${item.appointmentTime ? `🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)}` : ''}${item.scheduledEta ? `<span>ETA ${esc(item.scheduledEta)}${Number(item.scheduledWaitMin)>0 ? ` · wait ${Number(item.scheduledWaitMin)}m` : ''}</span>` : ''}${item.lockedDate ? `<span>🔒 ${esc(item.lockedDate)} · slot ${Number(item.lockedSlot)}</span>` : ''}</div>
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
  // Polyline points grouped by day (each day drawn in its own color so the
  // office can see every day finish back toward home). Ungrouped when there's
  // no day split — one neutral line. When the active variant carries saved OSRM
  // road geometry, each leg is drawn along its real path; a leg with no geometry
  // falls back to a straight segment between the two pins.
  const segs = {};
  const geomField = VARIANT_FIELDS[activeVariant()].geometry;
  const anchor = cachedHomeAnchor();
  const prevByDay = {};      // last routed coord seen per day (home anchor before the first)
  pendingItems().forEach((item, i) => {
    const c = coordsOf(item);
    if(!c) return;
    const parked = isParked(item);
    const day = item.day || 0;
    const color = day ? dayColor(day) : '#2b6cff';
    if(!parked){                                  // polyline + numbering: routed only
      const prev = prevByDay[day] || anchor;      // day's first leg starts at home
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
      .bindTooltip(`${parked ? '⚠ parked — ' : (day ? 'Day ' + day + ' · ' : '') + (i + 1) + '. '}${item.workOrderId ? 'WO ' + item.workOrderId + ' — ' : ''}${item.address || ''}${item.scheduledEta ? ' · ETA ' + item.scheduledEta : ''}${item.appointmentTime ? ' · appointment ' + item.appointmentTime : ''}`)
      .addTo(mapLayer);
    // Tint the routed pin by day (parked keeps the muted grey from CSS).
    if(!parked && day){ const el = marker.getElement(); if(el) el.style.background = color; }
  });
  Object.keys(segs).forEach(day => {
    const pts = segs[day];
    if(pts.length > 1) L.polyline(pts, { weight: 3, opacity: .75,
      color: Number(day) ? dayColor(day) : '#2b6cff' }).addTo(mapLayer);
  });
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
$('plPace').onchange = () => {
  const p = planShape(); $('plPace').value = String(p.paceMin);
  store.set('plannerPaceSource:' + hNumber(), 'override');
  $('plPaceHint').textContent = `Plan override: ${p.paceMin} min/stop`;
};

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
