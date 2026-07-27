// Mobile worklist route editor. The worklist module owns IndexedDB and hands
// this view a sorted snapshot plus one persistence callback; this module owns
// only the selected-day UI, Leaflet layers, and within-day drag interaction.
import { $, esc } from './dom.js';
import { coordsOf, decodePolyline, isParked } from './route.js';
import { VARIANT_FIELDS, dayHomeMeters, fmtKm, isPending, liveDayMeters, variantMatchesLive } from './route-variants.js';
import { createDragAutoScroll } from './drag-autoscroll.js';

function routeKey(item){
  const day = Number(item && item.day);
  return Number.isInteger(day) && day > 0 ? `day:${day}` : 'other';
}

export function groupPendingRoutes(items){
  const byDay = new Map();
  const other = [];
  for(const item of items || []){
    // Set-aside orders are out of the route, so they are out of the route map
    // and its day groups too — same rule as the list.
    if(!isPending(item)) continue;
    const key = routeKey(item);
    if(key === 'other') other.push(item);
    else {
      const day = Number(key.slice(4));
      if(!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    }
  }
  const groups = [...byDay.keys()].sort((a, b) => a - b)
    .map(day => ({ key:`day:${day}`, label:`Day ${day}`, day, items:byDay.get(day) }));
  if(other.length) groups.push({ key:'other', label:groups.length ? 'Other' : 'Route', day:null, items:other });
  return groups;
}

export function defaultRouteGroup(groups){
  return groups && groups.length ? groups[0].key : null;
}

export function reorderRouteGroup(items, key, orderedIds){
  const source = (items || []).slice();
  const slots = [];
  const members = [];
  source.forEach((item, index) => {
    if(isPending(item) && routeKey(item) === key){
      slots.push(index); members.push(item);
    }
  });
  const ids = (orderedIds || []).map(String);
  const expected = members.map(x => String(x.id));
  if(ids.length !== expected.length || new Set(ids).size !== ids.length
    || ids.some(id => !expected.includes(id))){
    throw new Error('Reorder ids must contain the same route group');
  }
  const byId = new Map(members.map(x => [String(x.id), x]));
  const arranged = Array(members.length).fill(null);
  const lockedIds = new Set();
  members.forEach(x => {
    if(!x.lockedDate) return;
    const at = Number(x.lockedSlot) - 1;
    if(at < 0 || at >= arranged.length || arranged[at]) throw new Error('Locked route slot is invalid');
    arranged[at] = x; lockedIds.add(String(x.id));
  });
  const free = ids.filter(id => !lockedIds.has(id)).map(id => byId.get(id));
  let freeAt = 0;
  for(let i = 0; i < arranged.length; i++) if(!arranged[i]) arranged[i] = free[freeAt++];
  slots.forEach((slot, index) => { source[slot] = arranged[index]; });
  return source.map((item, index) => Object.assign({}, item, { order:index * 10 }));
}

// `geomField` (VARIANT_FIELDS[...].geometry) is optional: when given, `path`
// follows each between-stops leg's saved OSRM road polyline (decoded on-device —
// no network), falling back to a straight segment for any leg with no saved
// geometry (an edited/quick-change leg, or a list the desktop never routed). The
// first routed stop starts `path` at its own pin — the phone has no home anchor,
// so there is no incoming home leg to draw. `line` is the straight pin-to-pin
// route kept as-is (used when no geometry field is passed).
export function buildRouteMapModel(items, geomField, homeGeomField){
  const markers = [];
  const line = [];
  const path = [];
  let driveOut = [];    // crew-start → first-stop path, drawn faintly & separately
  let missing = 0;
  let parked = 0;
  let prev = null;
  (items || []).forEach((item, index) => {
    const c = coordsOf(item);
    if(!c){ missing++; return; }
    const stopped = isParked(item);
    if(stopped){ parked++; }
    else {
      line.push([c.lat, c.lng]);
      if(prev == null){
        path.push([c.lat, c.lng]);
        // The day's first stop may carry a saved drive-out from the crew start —
        // decode it as its own faint segment (its first point is the start pin).
        const home = homeGeomField ? decodePolyline(item[homeGeomField]) : [];
        if(home.length) driveOut = home;
      } else {
        const leg = geomField ? decodePolyline(item[geomField]) : [];
        if(leg.length) path.push(...leg);
        else path.push([prev.lat, prev.lng], [c.lat, c.lng]);
      }
      prev = c;
    }
    markers.push({ item, position:index + 1, parked:stopped, point:[c.lat, c.lng] });
  });
  const start = driveOut.length ? driveOut[0] : null;
  return { markers, line, path, missing, parked, driveOut, start };
}

export function routeCardState(item){
  if(!coordsOf(item)) return 'no pin';
  return isParked(item) ? 'parked' : '';
}

export function needsOrderWrite(before, after){
  return typeof (before && before.order) !== 'number' || before.order !== after.order;
}

function dayColor(day){
  const colors = ['#2563EB', '#D97706', '#7C3AED', '#0F766E', '#BE123C', '#4D7C0F'];
  return colors[(Math.max(1, Number(day) || 1) - 1) % colors.length];
}

export function initWorklistRouteView(opts){
  let map = null;
  let layer = null;
  let tileFailed = false;
  let selected = null;
  let openState = false;
  let snapshot = [];

  const screen = $('worklistRouteScreen');
  const mapEl = $('wlRouteMap');
  const listEl = $('wlRouteList');
  const daysEl = $('wlRouteDays');
  const noticeEl = $('wlRouteNotice');
  const offlineEl = $('wlRouteOffline');
  const fixEl = $('wlRouteFix');
  const weightsEl = $('wlRouteWeights');

  // Show the installer's current tuning weights on the route so they can see what
  // produced it. The phone owns these; they ride up on the next sync and drive the
  // next route built for them (phone or planner).
  function renderWeights(){
    if(!weightsEl) return;
    const w = (opts.weights && opts.weights()) || null;
    if(!w){ weightsEl.classList.add('hide'); weightsEl.textContent = ''; return; }
    const pull = Number(w.commutePull);
    weightsEl.classList.remove('hide');
    weightsEl.textContent = `Tuning · commute pull ${isFinite(pull) ? pull : 70}%`
      + ` · finish by ${w.finishBy || '14:00'}`
      + ` · target ${Math.max(1, Math.floor(Number(w.target) || 24))}/day`
      + (timesEstimated() ? ' · ~ETAs estimated (road Optimize for exact)' : '');
  }

  function updateOfflineNote(){
    const offline = !navigator.onLine;
    offlineEl.classList.toggle('hide', !offline && !tileFailed);
    offlineEl.textContent = offline
      ? 'Map background needs signal. Your saved pins and route still work offline.'
      : 'Some map tiles did not load. Your saved pins and route are still available.';
  }

  function ensureMap(){
    const L = globalThis.L;
    if(map || !L) return Boolean(map);
    map = L.map(mapEl, { zoomControl:true, attributionControl:true }).setView([45.0, -79.3], 7);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19, attribution:'© OpenStreetMap',
    });
    tiles.on('tileerror', () => { tileFailed = true; updateOfflineNote(); });
    tiles.on('tileload', () => { if(tileFailed){ tileFailed = false; updateOfflineNote(); } });
    tiles.addTo(map);
    layer = L.layerGroup().addTo(map);
    return true;
  }

  function renderDays(groups){
    daysEl.innerHTML = '';
    const variant = (opts.routeVariant && opts.routeVariant()) || 'road';
    for(const group of groups){
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wl-route-day' + (group.key === selected ? ' on' : '');
      b.setAttribute('aria-pressed', group.key === selected ? 'true' : 'false');
      // The day's driving distance (between stops), when the route has been
      // optimized — the number that says whether "24 meters" is a short day or a
      // long one. "start" is the saved drive out from the crew's starting location
      // to the first stop, measured for reference and deliberately kept out of that
      // driving total (empty when the crew has no start location on file).
      const km = group.day == null ? null : liveDayMeters(snapshot, variant, group.day);
      const startKm = group.day == null ? null : dayHomeMeters(snapshot, variant, group.day);
      const win = showTimes() ? dayWindow(group.items) : '';
      b.textContent = `${group.label} · ${group.items.length}`
        + (win ? ` · ${win}` : '')
        + (km == null ? '' : ` · ${fmtKm(km)}`)
        + (startKm == null ? '' : ` · start ${fmtKm(startKm)}`);
      b.onclick = async () => { selected = group.key; await render(); };
      daysEl.appendChild(b);
    }
  }

  // The day's arrival window (first–last ETA), so an over-long day is visible at a
  // glance — the aggregate the phone view was missing.
  function dayWindow(items){
    const etas = (items || []).filter(x => x.scheduledEta).map(x => x.scheduledEta).sort();
    if(!etas.length) return '';
    return etas.length === 1 ? etas[0] : `${etas[0]}–${etas[etas.length - 1]}`;
  }

  // ETAs now exist on every optimized route: real road durations (OSRM/Google/ORS)
  // or the distance estimate route.js derives when no road matrix is pulled (labeled
  // "~/est." via timesEstimated). Shown whenever an order carries one.
  function showTimes(){ return true; }
  function timesEstimated(){ return Boolean(opts.timesEstimated && opts.timesEstimated()); }
  function etaText(item){ return `ETA ${timesEstimated() ? '~' : ''}${esc(item.scheduledEta)}`; }

  function markerTooltip(item, position, parked){
    const prefix = parked ? '⚠ Parked — ' : `${position}. `;
    const wo = item.workOrderId ? `WO ${esc(item.workOrderId)} — ` : '';
    const eta = (showTimes() && item.scheduledEta) ? ` · ${etaText(item)}` : '';
    const appt = item.appointmentTime ? ` · appointment ${esc(item.appointmentTime)}` : '';
    return `${prefix}${wo}${esc(item.address || 'No address')}${eta}${appt}`;
  }

  function renderMap(group){
    updateOfflineNote();
    if(!ensureMap()){
      mapEl.innerHTML = '<div class="wl-route-map-empty">Map unavailable. The route list can still be reordered.</div>';
      return;
    }
    layer.clearLayers();
    const L = globalThis.L;
    const variant = (opts.routeVariant && opts.routeVariant()) || 'road';
    // Only trust the saved road geometry while the live order still matches the
    // order it was fetched against. After a manual drag (live order changes, the
    // variant's saved order doesn't) the geometry is stale, so drop it and draw
    // clean straight legs instead of the previous route's roads.
    const geomField = variantMatchesLive(snapshot, variant)
      ? (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).geometry : null;
    const homeGeomField = variantMatchesLive(snapshot, variant)
      ? (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).homeLegGeometry : null;
    const model = buildRouteMapModel(group ? group.items : [], geomField, homeGeomField);
    const bounds = [];
    const color = group && group.day ? dayColor(group.day) : '#2563EB';
    model.markers.forEach(({ item, position, parked, point }) => {
      bounds.push(point);
      const marker = L.marker(point, { icon:L.divIcon({
        className:'wl-route-pin' + (parked ? ' parked' : ''),
        html:`<span>${parked ? '!' : position}</span>`,
        iconSize:[30,30], iconAnchor:[15,15],
      }) }).bindTooltip(markerTooltip(item, position, parked)).addTo(layer);
      if(!parked){
        const el = marker.getElement();
        if(el) el.style.background = color;
      }
    });
    // Draw the road-following path (decoded saved geometry, straight fallback per
    // leg) when there is one; otherwise the straight pin-to-pin route.
    const route = model.path.length > 1 ? model.path : model.line;
    if(route.length > 1) L.polyline(route, { color, weight:4, opacity:.78 }).addTo(layer);
    // The drive out from the crew start to the day's first stop — a faint dashed
    // line (road path when saved, straight otherwise), with a distinct start pin.
    if(model.driveOut.length > 1)
      L.polyline(model.driveOut, { color, weight:3, opacity:.35, dashArray:'6 6' }).addTo(layer);
    if(model.start){
      bounds.push(model.start);
      L.marker(model.start, { icon:L.divIcon({ className:'wl-route-pin wl-route-start',
        html:'<span>▶</span>', iconSize:[26,26], iconAnchor:[13,13] }) })
        .bindTooltip('Start — drive out to the first stop').addTo(layer);
    }
    setTimeout(() => {
      map.invalidateSize();
      if(bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(.18));
      else if(bounds.length === 1) map.setView(bounds[0], 15);
      else map.setView([45.0, -79.3], 7);
    }, 0);
  }

  function routeCard(item, index){
    const card = document.createElement('div');
    card.className = 'wl-route-card' + (item.lockedDate ? ' locked' : '');
    card.dataset.id = item.id;
    const cardState = routeCardState(item);
    const state = cardState ? `<span class="wl-route-state">${cardState}</span>` : '';
    card.innerHTML = `
      ${item.lockedDate ? '<span aria-label="Locked position">🔒</span>' : '<button class="wl-route-handle" type="button" aria-label="Drag to reorder">⠿</button>'}
      <span class="wl-route-pos">${index + 1}</span>
      <div class="wl-route-main">
        <strong>${item.workOrderId ? `WO ${esc(item.workOrderId)}` : '(no WO#)'}</strong>${state}
        <div>${esc(item.address || 'No address')}</div>
        <div class="wl-route-meta">${item.appointmentTime ? `🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)} · ` : ''}${(showTimes() && item.scheduledEta) ? etaText(item) : ''}${(showTimes() && Number(item.scheduledWaitMin)>0) ? ` · wait ${Number(item.scheduledWaitMin)}m` : ''}${item.lockedDate ? ` · locked slot ${Number(item.lockedSlot)}` : ''}</div>
      </div>`;
    const handle = card.querySelector('.wl-route-handle');
    if(handle) wireDrag(handle, card);
    return card;
  }

  function renumberCards(){
    [...listEl.querySelectorAll('.wl-route-card')].forEach((card, index) => {
      card.querySelector('.wl-route-pos').textContent = index + 1;
    });
  }

  async function persistCardOrder(focusId){
    const ids = [...listEl.querySelectorAll('.wl-route-card')].map(x => x.dataset.id);
    const reordered = reorderRouteGroup(snapshot, selected, ids);
    await opts.persistOrder(reordered);
    await refresh();
    const next = [...listEl.querySelectorAll('.wl-route-card')]
      .find(x => x.dataset.id === String(focusId));
    const nextHandle = next && next.querySelector('.wl-route-handle');
    if(nextHandle) nextHandle.focus();
  }

  function wireDrag(handle, card){
    handle.addEventListener('keydown', async e => {
      if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const cards = [...listEl.querySelectorAll('.wl-route-card')];
      const index = cards.indexOf(card);
      if(e.key === 'ArrowUp' && index > 0) listEl.insertBefore(card, cards[index - 1]);
      else if(e.key === 'ArrowDown' && index < cards.length - 1) listEl.insertBefore(cards[index + 1], card);
      else return;
      renumberCards();
      await persistCardOrder(card.dataset.id);
    });
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const pointerId = e.pointerId;
      try{ handle.setPointerCapture(pointerId); } catch{}
      card.classList.add('dragging');
      let startY = e.clientY;
      let lastY = e.clientY;
      let changed = false;
      let ended = false;
      // Same drag-to-the-edge scrolling as the worklist screen: the page moves
      // under a held finger, and each scrolled pixel is folded back into startY.
      const scroller = createDragAutoScroll({ onScroll: delta => {
        if(ended) return;
        startY -= delta;
        applyMove(lastY);
      } });
      const applyMove = clientY => {
        if(ended) return;
        lastY = clientY;
        card.style.transform = `translateY(${clientY - startY}px)`;
        let ref = null;
        for(const sibling of listEl.querySelectorAll('.wl-route-card')){
          if(sibling === card) continue;
          const r = sibling.getBoundingClientRect();
          if(clientY < r.top + r.height / 2){ ref = sibling; break; }
        }
        if(ref !== card && ref !== card.nextElementSibling){
          const before = card.getBoundingClientRect().top;
          listEl.insertBefore(card, ref);
          changed = true;
          startY += card.getBoundingClientRect().top - before;
          card.style.transform = `translateY(${clientY - startY}px)`;
          try{ handle.setPointerCapture(pointerId); } catch{}
          renumberCards();
        }
      };
      const onMove = ev => {
        if(ended) return;
        applyMove(ev.clientY);
        scroller.track(ev.clientY);
      };
      const finish = async () => {
        if(ended) return;
        ended = true;
        scroller.stop();
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        try{ handle.releasePointerCapture(pointerId); } catch{}
        card.classList.remove('dragging');
        card.style.transform = '';
        if(!changed) return;
        await persistCardOrder(card.dataset.id);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
  }

  async function render(){
    const groups = groupPendingRoutes(snapshot);
    if(!groups.some(g => g.key === selected)) selected = defaultRouteGroup(groups);
    const group = groups.find(g => g.key === selected) || null;
    renderWeights();
    renderDays(groups);
    listEl.innerHTML = '';
    (group ? group.items : []).forEach((item, index) => listEl.appendChild(routeCard(item, index)));
    if(!group){
      listEl.innerHTML = '<p class="muted">No pending orders. Add or download orders from the worklist.</p>';
    }
    const mapModel = buildRouteMapModel(group ? group.items : []);
    const missing = mapModel.missing;
    const parked = mapModel.parked;
    const parts = [];
    if(missing) parts.push(`${missing} without a pin`);
    if(parked) parts.push(`${parked} parked`);
    noticeEl.classList.toggle('hide', !parts.length);
    fixEl.classList.toggle('hide', !parts.length);
    noticeEl.textContent = parts.length
      ? `${parts.join(' · ')} — fix addresses or Optimize from the worklist.` : '';
    renderMap(group);
  }

  async function refresh(){
    snapshot = await opts.getItems();
    await render();
  }

  async function open(){
    openState = true;
    selected = null;
    screen.classList.remove('hide');
    await refresh();
    window.scrollTo(0, 0);
    $('wlRouteBack').focus();
  }

  function close(){
    openState = false;
    screen.classList.add('hide');
  }

  $('wlRouteBack').onclick = () => opts.onClose();
  $('wlRouteFix').onclick = () => opts.onFix();
  window.addEventListener('online', updateOfflineNote);
  window.addEventListener('offline', updateOfflineNote);

  return { open, close, refresh, isOpen:() => openState };
}
