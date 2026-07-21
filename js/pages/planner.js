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
import { stamp } from '../time.js';
import { optimizeRoute, geocodeOne, coordsOf, isParked } from '../route.js';

let roster = { employees: [] };
let items = [];              // the selected installer's orders, display order
let map = null, mapLayer = null;   // Leaflet instances (lazy)

const OSRM_DEFAULT = 'http://localhost:5000';

function setStatus(kind, text){
  const p = $('status'), t = $('statusText');
  p.classList.remove('wait','off');
  if(kind==='off') p.classList.add('off'); else if(kind==='wait') p.classList.add('wait');
  t.textContent = text;
}

const fullName = e => ((e.firstName||'')+' '+(e.lastName||'')).trim();
const hNumber  = () => $('plWho').value;
const pendingItems = () => items.filter(x => x.wlStatus !== 'done');

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
    createdAt:x.createdAt||'', updatedAt:x.updatedAt||'' };
}

async function loadList(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  setStatus('wait','Loading…');
  try{
    const r = await apiGet('worklist', { hNumber: h });
    if(!r.ok) throw new Error(r.error || 'load failed');
    // Mirror the phone's wlDownload normalization: order by row position,
    // blank coords → undefined, status coerced.
    await setItems((r.orders || []).map((o,i) => ({
      id:String(o.id), workOrderId:String(o.workOrderId||''), unit:String(o.unit||''),
      address:String(o.address||''), oldJNumber:String(o.oldJNumber||''),
      wlStatus: o.wlStatus === 'done' ? 'done' : 'pending',
      order: i * 10,
      lat: (o.lat === '' || o.lat == null) ? undefined : Number(o.lat),
      lng: (o.lng === '' || o.lng == null) ? undefined : Number(o.lng),
      createdAt:String(o.createdAt||''), updatedAt:String(o.updatedAt||'') })));
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
async function homePin(){
  const addr = String($('plHome').value || '').trim();
  const h = hNumber();
  if(!addr) return null;
  try{
    const saved = JSON.parse(store.get('plannerHome:' + h) || 'null');
    if(saved && saved.addr === addr && isFinite(saved.lat)) return { lat:saved.lat, lng:saved.lng };
  } catch {}
  const hit = await geocodeOne(addr, null);
  if(hit && !hit.ambig){
    store.set('plannerHome:' + h, JSON.stringify({ addr, lat:hit.lat, lng:hit.lng }));
    return { lat: hit.lat, lng: hit.lng };
  }
  toast('End-near address didn’t pin — routing without it');
  return null;
}

// ── optimize ────────────────────────────────────────────────────────────────
function progress(p){
  const el = $('plProg');
  if(p.phase === 'locate') el.textContent = 'Getting a reference location…';
  else if(p.phase === 'geocode') el.textContent = `Looking up addresses ${p.done}/${p.total}…`;
  else if(p.phase === 'matrix') el.textContent = 'Getting road distances from OSRM…';
  else if(p.phase === 'solve') el.textContent = 'Finding the best order…';
}

async function optimize(){
  const h = hNumber();
  if(!h){ toast('Pick an installer first'); return; }
  const pending = pendingItems();
  if(pending.length < 2){ toast('Need at least 2 pending orders'); return; }
  const osrmUrl = String($('plOsrm').value || '').trim() || OSRM_DEFAULT;
  store.set('plannerOsrm', osrmUrl);
  const btn = $('plOptimize'), prog = $('plProg');
  btn.disabled = true; prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try{
    const home = await homePin();
    const { orderedIds, parkedIds, usedFallback, fallbackReason, mode, geoReason } =
      await optimizeRoute(pending, progress, home, { osrmUrl });
    const doneIds = items.filter(x => x.wlStatus === 'done').map(x => x.id);
    const byId = {}; items.forEach(x => { byId[x.id] = x; });
    const seq = [...orderedIds, ...parkedIds, ...doneIds].map(id => byId[id]).filter(Boolean);
    seq.forEach((x, i) => { x.order = i * 10; x.updatedAt = stamp(); });
    items = seq;
    for(const x of items) await idb.put('worklist', x);
    render();
    const short = s => String(s || '').length > 70 ? String(s).slice(0, 70) + '…' : String(s || '');
    const ambig = pending.filter(x => x.geoAmbig && x.geoAmbig.length).length;
    const failed = parkedIds.length - ambig;
    toast((mode === 'home' ? 'Route ends near the anchor ✓' : 'Route starts at the first order ✓')
      + (usedFallback ? ` — straight-line (${short(fallbackReason)})` : '')
      + (failed > 0 ? ` · ${failed} parked (fix address)` : '')
      + (ambig > 0 ? ` · ${ambig} need a town picked below` : '')
      + (geoReason && parkedIds.length ? ` · lookups failed: ${short(geoReason)}` : ''));
  } catch {
    toast('Optimize failed — try again');
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
      installer: who ? fullName(who) : '', orders: items.map(wireShape) });
    if(!r.ok) throw new Error(r.error || 'upload failed');
    setStatus('ok','Synced');
    toast('Uploaded ✓ — ready for the phone’s ⇩ Download');
  } catch { setStatus('off','Error'); toast('Upload failed — check signal'); }
}

// ── render (list + map) ─────────────────────────────────────────────────────
function render(){
  const pending = pendingItems(), done = items.filter(x => x.wlStatus === 'done');
  $('plCounts').textContent = items.length
    ? `${pending.length} pending · ${done.length} completed` : '';
  const list = $('plList'); list.innerHTML = '';
  if(!items.length){
    list.innerHTML = '<div class="card"><div class="empty">No orders — ⇩ Load the installer’s saved list or paste orders in.</div></div>';
    renderMap();
    return;
  }
  const card = document.createElement('div');
  card.className = 'card';
  [...pending, ...done].forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'plrow' + (item.wlStatus === 'done' ? ' pldone' : '');
    const located = !!coordsOf(item);
    // Flag badges BEFORE the located check — a parked order keeps its last
    // good pin, so coords-present must not hide its warning state.
    const tag = item.geoFail ? ' <span class="pltag" title="Address didn’t map">📍?</span>'
      : (item.geoAmbig && item.geoAmbig.length) ? ' <span class="pltag">⚠ which town?</span>'
      : (located ? '' : ' <span class="pltag pltag-mute" title="Not geocoded yet">·</span>');
    row.innerHTML = `
      <span class="plpos">${item.wlStatus === 'done' ? '✓' : (i + 1)}</span>
      <div class="plmain">
        <strong>${item.workOrderId ? 'WO ' + esc(item.workOrderId) : '(no WO#)'}</strong>
        <div class="pladdr">${esc(item.address || '')}${tag}</div>
        ${(item.geoAmbig && item.geoAmbig.length) ? `<div class="plchips">${
          item.geoAmbig.map((c, ci) => `<button class="chip" data-ci="${ci}" type="button">${esc(c.label)}</button>`).join('')
        }</div>` : ''}
      </div>
      <button class="pldel" type="button" aria-label="Remove">✕</button>`;
    row.querySelectorAll('.chip').forEach(chip => { chip.onclick = async () => {
      const c = item.geoAmbig[Number(chip.dataset.ci)];
      if(!c) return;
      item.lat = c.lat; item.lng = c.lng; item.geoFail = false; item.geoAmbig = undefined; item.updatedAt = stamp();
      await idb.put('worklist', item);
      toast('Town pinned ✓ — optimize again to route it');
      render();
    }; });
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
  const pts = [], all = [];
  pendingItems().forEach((item, i) => {
    const c = coordsOf(item);
    if(!c) return;
    const parked = isParked(item);
    if(!parked) pts.push([c.lat, c.lng]);       // polyline + numbering: routed only
    all.push([c.lat, c.lng]);
    L.marker([c.lat, c.lng], { icon: L.divIcon({
      className: 'plpin' + (parked ? ' plpin-parked' : ''),
      html:`<span>${parked ? '!' : i + 1}</span>`, iconSize:[26,26], iconAnchor:[13,13] }) })
      .bindTooltip(`${parked ? '⚠ parked — ' : (i + 1) + '. '}${item.workOrderId ? 'WO ' + item.workOrderId + ' — ' : ''}${item.address || ''}`)
      .addTo(mapLayer);
  });
  if(pts.length > 1) L.polyline(pts, { weight: 3, opacity: .7 }).addTo(mapLayer);
  if(all.length) map.fitBounds(L.latLngBounds(all).pad(0.2));
}

// ── wiring ──────────────────────────────────────────────────────────────────
$('plWho').onchange = async () => {
  const h = hNumber();
  // Recall this installer's remembered end-near anchor.
  let addr = '';
  try{ addr = (JSON.parse(store.get('plannerHome:' + h) || 'null') || {}).addr || ''; } catch {}
  $('plHome').value = addr;
  await setItems([]);      // don't mix installers — load or paste fresh
};
$('plLoad').onclick = loadList;
$('plImportBtn').onclick = () => $('plImport').classList.toggle('hide');
$('plPasteAdd').onclick = importPaste;
$('plOptimize').onclick = optimize;
$('plUpload').onclick = upload;

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

$('plOsrm').value = store.get('plannerOsrm') || OSRM_DEFAULT;
render();
loadRoster().then(paintWhoSelect);
