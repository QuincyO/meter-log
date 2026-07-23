// Mobile worklist route editor. The worklist module owns IndexedDB and hands
// this view a sorted snapshot plus one persistence callback; this module owns
// only the selected-day UI, Leaflet layers, and within-day drag interaction.
import { $, esc } from './dom.js';
import { coordsOf, isParked } from './route.js';
import { fmtKm, isPending, liveDayMeters } from './route-variants.js';
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

export function buildRouteMapModel(items){
  const markers = [];
  const line = [];
  let missing = 0;
  let parked = 0;
  (items || []).forEach((item, index) => {
    const c = coordsOf(item);
    if(!c){ missing++; return; }
    const stopped = isParked(item);
    if(stopped) parked++;
    else line.push([c.lat, c.lng]);
    markers.push({ item, position:index + 1, parked:stopped, point:[c.lat, c.lng] });
  });
  return { markers, line, missing, parked };
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
      // The day's driving distance, when the route has been optimized — the
      // number that says whether "24 meters" is a short day or a long one.
      const km = group.day == null ? null : liveDayMeters(snapshot, variant, group.day);
      b.textContent = `${group.label} · ${group.items.length}`
        + (km == null ? '' : ` · ${fmtKm(km)}`);
      b.onclick = async () => { selected = group.key; await render(); };
      daysEl.appendChild(b);
    }
  }

  function markerTooltip(item, position, parked){
    const prefix = parked ? '⚠ Parked — ' : `${position}. `;
    const wo = item.workOrderId ? `WO ${esc(item.workOrderId)} — ` : '';
    const eta = item.scheduledEta ? ` · ETA ${esc(item.scheduledEta)}` : '';
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
    const model = buildRouteMapModel(group ? group.items : []);
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
    if(model.line.length > 1) L.polyline(model.line, { color, weight:4, opacity:.78 }).addTo(layer);
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
        <div class="wl-route-meta">${item.appointmentTime ? `🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)} · ` : ''}${item.scheduledEta ? `ETA ${esc(item.scheduledEta)}` : ''}${Number(item.scheduledWaitMin)>0 ? ` · wait ${Number(item.scheduledWaitMin)}m` : ''}${item.lockedDate ? ` · locked slot ${Number(item.lockedSlot)}` : ''}</div>
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
