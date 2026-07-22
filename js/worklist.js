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
import { stamp, localDate } from './time.js';
import { apiGet, apiPost } from './api.js';
import { optimizeRoute, coordsOf, isParked, geocodeOne } from './route.js';

let fillCapture = () => {};     // set by initWorklist (capture.js)
let planEstimate = null;        // set by initWorklist (capture.js): async () => string
let _wlEditId = null;           // null = new order, string = id being edited

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

// ── address split (copy-street + chips) ─────────────────────────────────────
// "6740 Svorn River Shore" → { num:'6740', street:'Svorn River Shore' }.
// Anything that doesn't start with a number is all street (islands, landmarks).
function splitAddr(address){
  const m = String(address || '').trim().match(/^(\d[\w-]*)\s+(.+)$/);
  return m ? { num: m[1], street: m[2] } : { num: '', street: String(address || '').trim() };
}
function joinAddr(num, street){
  return [String(num||'').trim(), String(street||'').trim()].filter(Boolean).join(' ');
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
// Launch the maps app in its own context — never navigate the PWA itself away
// mid-shift. On iOS the custom schemes launch the app without navigating the
// page, so if Google Maps is absent we can still fall back to Apple Maps.
function openDirections(item){
  const dest = destOf(item);
  if(!dest) return;
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
    day:(x.day == null || x.day === '') ? '' : Number(x.day) };
}

async function wlUpload(){
  const c = cfg();
  if(!c.hNumber){ toast('Set your employee number in Settings first'); return; }
  if(!navigator.onLine){ toast('Offline — upload needs signal'); return; }
  const items = await allSorted();
  if(!items.length && !confirm('Your local worklist is empty — uploading will clear your saved copy on the sheet. Continue?')) return;
  try {
    const r = await withActivity('Uploading worklist…', () => apiPost({ action:'saveWorklist',
      installer:c.name, hNumber:c.hNumber, orders: items.map(wireShape) }));
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
      installer:c.name, hNumber:c.hNumber, orders: items.map(wireShape) }));
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
        day: (o.day === '' || o.day == null) ? '' : Number(o.day) });
    }
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

async function optimizeRouteHandler(){
  if(!navigator.onLine){ toast('Offline — route optimization needs signal'); return; }
  const pending = (await allSorted()).filter(x => x.wlStatus !== 'done');
  if(pending.length < 2){ toast('Need at least 2 pending orders to optimize'); return; }
  if(!confirm(`Optimize the route for ${pending.length} pending orders? This looks up each address and may take a minute the first time.`)) return;

  const target = targetVal();
  const btn = $('wlOptimize'), prog = $('wlRouteProgress');
  btn.disabled = true; prog.classList.remove('hide'); prog.textContent = 'Starting…';
  try {
    const home = await homePin();
    const { orderedIds, parkedIds, usedFallback, fallbackReason, mode, geoReason, note,
            dayOf, dayFallback } =
      await optimizeRoute(pending, updateRouteProgress, home, { target });
    // Rewrite order = index × 10 across ALL orders (persistOrder's convention):
    // the optimized pending sequence, then parked ones, then done ones trailing.
    // Done orders must be renumbered too — otherwise a done stop keeps its old
    // order (e.g. 0) and collides with the new first pending stop. `day` rides
    // along (parked/done unassigned) so the dividers render + sync on upload.
    const all = await allSorted();
    const doneIds = all.filter(x => x.wlStatus === 'done').map(x => x.id);
    const byId = {}; all.forEach(x => { byId[x.id] = x; });
    let i = 0;
    for(const id of [...orderedIds, ...parkedIds, ...doneIds]){
      const item = byId[id];
      if(!item) continue;
      const order = (i++) * 10;
      const day = (dayOf && dayOf[id]) ? dayOf[id] : '';
      if(item.order !== order || item.day !== day)
        await idb.put('worklist', Object.assign({}, item, { order, day, updatedAt: stamp() }));
    }
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
    const extra = (days > 1 ? ` · ${days} days of ${target}` : '')
      + (dayFallback ? ' — set a Home pin in Settings to end each day near home' : '')
      + (usedFallback ? ` — straight-line (${short(fallbackReason)})` : '')
      + (failed > 0 ? ` · ${failed} parked (fix address)` : '')
      + (ambig > 0 ? ` · ${ambig} need a town picked (Edit)` : '')
      + (geoReason && parkedIds.length ? ` · lookups failed: ${short(geoReason)}` : '')
      + (note ? ` · ${short(note)}` : '');
    toast((mode === 'home' ? 'Route optimized — ends near home ✓' : 'Route optimized — starts at your first order ✓') + extra);
  } catch {
    toast('Route optimization failed — try again');
  } finally {
    btn.disabled = false; prog.classList.add('hide'); prog.textContent = '';
  }
}

// ── secret: Optimize is "coming soon" ───────────────────────────────────────
// A normal tap does nothing (the button reads "(coming soon)" and looks greyed
// out) — this keeps installers from burning geocoding/road-matrix API budget on
// needless re-optimizes. Five *quick* taps (≤600 ms apart) still run the real
// optimizer for whoever knows the trick. Intentionally undiscoverable; the streak
// resets the moment the taps slow down.
let _optTaps = 0, _optTapTimer = null;
function optimizeSecretTap(){
  _optTaps++;
  clearTimeout(_optTapTimer);
  if(_optTaps >= 5){ _optTaps = 0; optimizeRouteHandler(); return; }
  _optTapTimer = setTimeout(() => { _optTaps = 0; }, 600);
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
  $('worklistScreen').classList.remove('hide');
  if(location.hash !== '#worklist') history.pushState({ wl:1 }, '', '#worklist');
  paintPlanToggle();
  await renderWorklist();
  refreshAvgDay();   // best-effort avg/day hint beside the target field
  window.scrollTo(0, 0);
}
function hideScreen(){
  $('worklistScreen').classList.add('hide');
  $('captureMain').classList.remove('hide');
}
function closeWorklist(){
  if(location.hash === '#worklist') history.back();   // popstate hides the screen
  else hideScreen();
}
window.addEventListener('popstate', () => { if(location.hash !== '#worklist') hideScreen(); });

// ── list rendering ──────────────────────────────────────────────────────────
export async function renderWorklist(){
  const items = await allSorted();
  const pending = items.filter(x => x.wlStatus !== 'done');
  const done    = items.filter(x => x.wlStatus === 'done');
  const counts = $('wlCounts');
  if(counts) counts.textContent = items.length
    ? `${pending.length} remaining · ${done.length} completed` : '';
  const list = $('wlList'); list.innerHTML = '';
  if(!items.length){ list.innerHTML = '<p class="muted">No orders yet — tap ＋ Add order to plan your day.</p>'; return; }
  // Day dividers (only when the office/optimize assigned days) — a header before
  // the first pending card of each day. Done cards trail, ungrouped.
  let curDay = null;
  [...pending, ...done].forEach(item => {
    const d = item.wlStatus !== 'done' ? (item.day || null) : null;
    if(d && d !== curDay){
      curDay = d;
      const count = pending.filter(p => (p.day || null) === d).length;
      const div = document.createElement('div');
      div.className = 'wl-day';
      div.innerHTML = `<span class="wl-day-dot"></span>Day ${d} · ${count} meter${count === 1 ? '' : 's'}`
        + `<span class="wl-day-eta">${esc(wlDayEta(count))}</span>`;
      list.appendChild(div);
    }
    list.appendChild(makeWlCard(item));
  });
  renumberCards(list);
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
    const r = await apiGet('installerMetrics', { hNumber: c.hNumber });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
      wlAvgLogMin = (m.avgLogMin === '' || m.avgLogMin == null) ? null : Number(m.avgLogMin);
      const perDay = (m.avgPerDay === '' || m.avgPerDay == null) ? null : Number(m.avgPerDay);
      if(el) el.textContent = perDay ? `your avg ${perDay}/day` : '';
    }
  } catch {}
}

function makeWlCard(item){
  const card = document.createElement('div');
  card.className = 'wl-card' + (item.wlStatus==='done' ? ' wl-done-card' : '');
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
  // Cards deliberately show only WO# + address (+ the routing pill/chips) —
  // glanceable while driving a route.
  card.innerHTML = `
    ${item.wlStatus !== 'done' ? '<button class="wl-handle" type="button" aria-label="Drag to reorder">⠿</button><span class="wl-pos" aria-hidden="true"></span>' : ''}
    <div class="wl-main">
      <strong>${title}</strong>${doneTag}${pill}
      ${addr ? `<div class="wl-body">${addr}</div>` : ''}
      ${cands ? `<div class="wl-chips wl-towns">${cands.map(c =>
        `<button class="chip" type="button">${esc(c.label)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="wl-actions">
      ${item.wlStatus !== 'done' ? '<button class="wl-use" data-act="use">Use →</button>' : ''}
      ${item.address ? '<button class="wl-map" data-act="map" type="button" aria-label="Directions">🧭</button>' : ''}
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
  card.querySelector('[data-act="del"]').onclick = async () => {
    await idb.del('worklist', item.id);
    toast('Order removed');
    await renderWorklist();
    await planAdvance();     // the removed order may have been the planned one
  };
  if(item.wlStatus !== 'done'){
    card.querySelector('[data-act="use"]').onclick = () => {
      fillCapture(item);
      closeWorklist();
      window.scrollTo({ top:0, behavior:'smooth' });
      toast('Prefilled from worklist ✓');
    };
    wireDrag(card.querySelector('.wl-handle'), card);
  }
  return card;
}

// ── drag-to-reorder (pointer events on the ⠿ handle; no library) ────────────
// The card tracks the finger via a translateY transform; its slot is chosen by
// comparing the pointer against each pending sibling's vertical midpoint, so the
// swap only flips once the finger crosses a neighbour's centre (natural
// hysteresis — no thrash). Each DOM move is FLIP-corrected (re-anchor startY by
// the layout shift) so the card stays glued to the finger while the rest reflow.
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
    let moved = false;
    let ended = false;

    const onMove = ev => {
      if(ended) return;
      moved = true;
      card.style.zIndex = 5;
      card.style.transform = `translateY(${ev.clientY - startY}px)`;
      // Pick the slot: insert before the first pending sibling whose midpoint is
      // below the finger (null → drop at the end).
      let ref = null;
      for(const sib of list.querySelectorAll('.wl-card:not(.wl-done-card)')){
        if(sib === card) continue;
        const r = sib.getBoundingClientRect();
        if(ev.clientY < r.top + r.height / 2){ ref = sib; break; }
      }
      if(ref !== card && ref !== card.nextElementSibling){
        // FLIP: the same transform is applied for both reads, so the delta is
        // pure layout shift — fold it into startY to keep the card under the
        // finger across the reorder.
        const before = card.getBoundingClientRect().top;
        list.insertBefore(card, ref);
        startY += card.getBoundingClientRect().top - before;
        card.style.transform = `translateY(${ev.clientY - startY}px)`;
        // insertBefore re-parents the card, which fires lostpointercapture and
        // drops the capture — re-acquire so touch move events keep reaching us.
        try { handle.setPointerCapture(pointerId); } catch { /* best-effort */ }
        renumberCards(list);
      }
    };
    // Bound to window, not the handle: the reorder above releases pointer
    // capture, after which up/move no longer reliably target the handle — but
    // they always bubble to window, so release is never missed (the "card stuck
    // highlighted on lift" bug). Idempotent via `ended`.
    const endDrag = async () => {
      if(ended) return;
      ended = true;
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
  for(const c of list.querySelectorAll('.wl-card:not(.wl-done-card)')){
    const pos = c.querySelector('.wl-pos');
    if(pos) pos.textContent = n++;
  }
}

// Persist the on-screen order of the PENDING cards (done cards keep their spot
// at the bottom of the sort by getting trailing order values).
async function persistOrder(){
  const ids = [...$('wlList').querySelectorAll('.wl-card')].map(c => c.dataset.id);
  const items = (await idb.all('worklist')) || [];
  const byId = {}; items.forEach(x => { byId[x.id] = x; });
  let i = 0;
  for(const id of ids){
    const item = byId[id];
    if(!item) continue;
    const order = (i++) * 10;
    if(item.order !== order) await idb.put('worklist', Object.assign({}, item, { order, updatedAt: stamp() }));
  }
  await planAdvance();   // the first pending order may have changed
}

// ── add / edit form ─────────────────────────────────────────────────────────
function wlOpenForm(item){
  _wlEditId = item ? item.id : null;
  const a = splitAddr(item ? item.address : '');
  $('wlWo').value     = item ? (item.workOrderId||'') : '';
  $('wlNum').value    = a.num;
  $('wlStreet').value = a.street;
  $('wlOldJ').value   = item ? (item.oldJNumber||'') : '';
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
  const items = await allSorted();
  const seen = {}; const streets = [];
  items.slice().reverse().forEach(x => {
    const st = splitAddr(x.address).street;
    if(st && !seen[st.toLowerCase()]){ seen[st.toLowerCase()] = 1; streets.push(st); }
  });
  const box = $('wlChips');
  if(!streets.length){ box.classList.add('hide'); box.innerHTML=''; return; }
  box.classList.remove('hide');
  box.innerHTML = streets.slice(0, 6).map(st => `<button class="chip" type="button">${esc(st)}</button>`).join('');
  [...box.children].forEach((b, i) => b.onclick = () => {
    $('wlStreet').value = streets[i];
    $('wlNum').focus();
  });
}

async function wlSave(){
  const wo = $('wlWo').value.trim();
  const address = joinAddr($('wlNum').value, $('wlStreet').value);
  if(!wo && !address){ toast('Enter a work order # or address'); return; }
  const now = stamp();
  let item;
  if(_wlEditId){
    const existing = (await idb.get('worklist', _wlEditId)) || {};
    item = Object.assign({}, existing, {
      id:_wlEditId, workOrderId:wo, address, oldJNumber:$('wlOldJ').value.trim(), updatedAt:now
    });
    // Address changed → the cached coords are stale; drop them (and the parked/
    // ambiguous flags) so the next optimize re-geocodes the new address.
    if(existing.address !== address){ item.lat = undefined; item.lng = undefined; item.geoFail = undefined; item.geoAmbig = undefined; }
  } else {
    const items = await allSorted();
    const last = items.filter(x => x.order != null).pop();
    item = {
      id: now + '-' + Math.random().toString(36).slice(2,6),
      workOrderId:wo, address, oldJNumber:$('wlOldJ').value.trim(),
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
    renderChips();
    $('wlWo').focus();
  }
  await renderWorklist();
  await planAdvance();
}

// ── completing a planned order when its WO is actually logged ───────────────
// Matches the first pending card by WO# (case-insensitive); a blank WO# never
// matches. Runs entirely against IndexedDB so it works with no signal.
export async function markWorklistDone(workOrderId){
  const wo = String(workOrderId || '').trim().toUpperCase();
  if(!wo) return;
  const items = await allSorted();
  const match = items.find(x => x.wlStatus !== 'done'
    && String(x.workOrderId || '').trim().toUpperCase() === wo);
  if(!match) return;
  await idb.put('worklist', Object.assign({}, match, { wlStatus:'done', updatedAt:stamp() }));
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
  const pending = items.filter(x => x.wlStatus !== 'done');
  const banner = $('planBanner'); banner.classList.remove('hide');
  await renderPlanEstimate();
  if(!items.length){
    $('planBannerText').textContent = 'Plan: worklist is empty';
    fillCapture(null);
    return;
  }
  if(!pending.length){
    $('planBannerText').textContent = `Plan: all ${items.length} orders done ✓`;
    fillCapture(null);
    return;
  }
  const item = pending[0];
  const pos = items.length - pending.length + 1;
  $('planBannerText').textContent = `Plan: WO ${item.workOrderId || '—'} · ${pos} of ${items.length}`;
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
  const pending = items.filter(x => x.wlStatus !== 'done');
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
  $('wlBack').onclick = closeWorklist;
  $('wlUpload').onclick = wlUpload;
  $('wlDownload').onclick = wlDownload;
  $('wlOptimize').onclick = optimizeSecretTap;
  // Meters/day target: restore the saved value (default 24) and persist edits.
  $('wlTarget').value = String(Math.max(1, Math.floor(Number(store.get('wlTarget')) || 24)));
  $('wlTarget').onchange = () => {
    const v = Math.max(1, Math.floor(Number($('wlTarget').value) || 24));
    $('wlTarget').value = String(v); store.set('wlTarget', String(v));
  };
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
    if(location.hash === '#worklist') openWorklist();
    planAdvance();
  });
}
