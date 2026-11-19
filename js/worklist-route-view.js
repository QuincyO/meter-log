// Mobile worklist route editor. The worklist module owns IndexedDB and hands
// this view a sorted snapshot plus one persistence callback; this module owns
// only the selected-day UI, Leaflet layers, and within-day drag interaction.
import { $, esc, toast } from './dom.js';
import * as addressText from './worklist-address-fill.js';
import { coordsOf, decodePolyline, haversine, isParked, offlineRoutePaths } from './route.js';
// Reached through the namespace for names newer than the list above: a phone can
// hold an older cached route.js until somebody presses ⟳ Force update, and a missing
// NAMED import there is a link error that takes the whole route map with it.
import * as routeLib from './route.js';
// The day-end and flat-out read-outs, by namespace for the same reason: a phone with
// an older cached route-constraints.js keeps the old first-to-last window instead.
import * as sched from './route-constraints.js';
import { VARIANT_FIELDS, dayHomeMeters, fmtKm, isPending, liveDayMeters, variantMatchesLive } from './route-variants.js';
import { createDragAutoScroll } from './drag-autoscroll.js';
import { siteKey } from './route-dwell.js';

const addressLabel = item => addressText.formatOrderAddress
  ? addressText.formatOrderAddress(item) : [item.unit, item.address].filter(Boolean).join(' ');

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

/** The key a leg's road path is looked up under. Exported so the caller that
 *  BUILDS the leg list and the model that CONSUMES it can't drift apart. */
export function legKey(fromId, toId){
  return `${fromId == null ? '' : fromId}>${toId == null ? '' : toId}`;
}

/** The drive-out leg's origin is the crew start, which is not an order and has no
 *  id of its own. */
export const START_ID = 'start';

// Three sources for a drawn leg, in order of trust:
//
//   1. `computed` — paths measured from the on-device pack for THESE legs, keyed
//      by legKey(). Always describes the sequence on screen, so it needs no
//      staleness check; a leg the pack couldn't carry is simply absent.
//   2. `geomField` (VARIANT_FIELDS[...].geometry) — the saved polyline, which is
//      the desktop planner's real OSRM path on a phone with no district of its
//      own. Keyed to the order it was fetched for, so the caller passes null
//      once that order no longer matches (variantMatchesLive).
//   3. a straight segment between the two pins.
//
// The first routed stop starts `path` at its own pin — the phone has no home
// anchor, so there is no incoming between-stops leg to draw. `line` is the
// straight pin-to-pin route kept as-is (used when neither geometry source is
// passed).
//
// `startOverride` ([lat,lng]) is a one-run GPS start, kept on this phone. It replaces
// the saved drive-out as the place the route starts, so the first stop's saved
// polyline (always the morning meet, because it syncs) is not read at all. See
// liveStartFix for when it applies.
export function buildRouteMapModel(items, geomField, homeGeomField, computed, startOverride){
  const at = key => (computed && computed.get) ? (computed.get(key) || []) : [];
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
        // A freshly measured one wins, but the saved polyline is still what says
        // WHERE the start is, so it is read either way.
        const saved = startOverride ? [startOverride, [c.lat, c.lng]]
          : homeGeomField ? decodePolyline(item[homeGeomField]) : [];
        const fresh = at(legKey(START_ID, item.id));
        driveOut = fresh.length ? fresh : saved;
      } else {
        const fresh = at(legKey(prev.item.id, item.id));
        const leg = fresh.length ? fresh
          : (geomField ? decodePolyline(item[geomField]) : []);
        if(leg.length) path.push(...leg);
        else path.push([prev.c.lat, prev.c.lng], [c.lat, c.lng]);
      }
      prev = { item, c };
    }
    markers.push({ item, position:index + 1, parked:stopped, point:[c.lat, c.lng] });
  });
  const start = driveOut.length ? driveOut[0] : null;
  return { markers, line, path, missing, parked, driveOut, start };
}

/** The legs `renderMap` is about to draw, as offlineRoutePaths() wants them.
 *  `startPoint` is the crew start ([lat,lng]) when the group's first stop carries
 *  a saved drive-out — the only thing that says where the morning drive begins,
 *  since the crew start itself is not an order on the list. A `startOverride`
 *  ([lat,lng]) wins over it, so the pack measures the road from the GPS start.
 *  Pure, so the leg list the map draws is testable without a pack or a Leaflet
 *  canvas. */
export function routeLegs(items, homeGeomField, startOverride){
  const legs = [];
  let prev = null;
  let first = null;
  for(const item of items || []){
    const c = coordsOf(item);
    if(!c || isParked(item)) continue;
    if(prev) legs.push({ key:legKey(prev.id, item.id), from:prev, to:item });
    else first = item;
    prev = item;
  }
  const saved = (first && homeGeomField) ? decodePolyline(first[homeGeomField]) : [];
  const startPoint = (first && startOverride) || (saved.length ? saved[0] : null);
  if(startPoint && first)
    legs.push({ key:legKey(START_ID, first.id),
      from:{ lat:startPoint[0], lng:startPoint[1] }, to:first });
  return { legs, startPoint };
}

/** How far apart two units of one street address can be and still share a pin.
 *  siteKey drops the town, so this is what keeps "12 Main St" in two towns apart. */
export const PIN_MERGE_METERS = 50;
/** A pin can carry this many numbered sections before it shows a count instead. */
export const MAX_PIN_SECTIONS = 4;

function sharesPin(a, b){
  if(a.parked || b.parked) return false;     // out of the route: never a route section
  if(a.point[0] === b.point[0] && a.point[1] === b.point[1]) return true;
  // siteKey falls back to the road alone when there is no civic number, and a
  // whole street is not one location.
  const key = siteKey(a.item.address);
  if(!/^\d/.test(key) || key !== siteKey(b.item.address)) return false;
  const at = m => ({ lat:m.point[0], lng:m.point[1] });
  return haversine(at(a), at(b)) <= PIN_MERGE_METERS;
}

/** One entry per place on the map: `{ point, stops }`, stops in route order, drawn
 *  at the first stop's point. Grouping is by location only and never by zoom, so a
 *  pin means the same thing at every scale. The route line ignores this entirely
 *  and keeps running through each stop's own coordinates. */
export function groupRoutePins(markers){
  const pins = [];
  for(const marker of markers || []){
    const pin = pins.find(p => p.stops.some(s => sharesPin(s, marker)));
    if(pin) pin.stops.push(marker);
    else pins.push({ point:marker.point, stops:[marker] });
  }
  return pins;
}

/** What a pin looks like: its class, its inner HTML, and its size in pixels. */
export function pinFace(stops){
  if(stops.length === 1){
    const { parked, position } = stops[0];
    return { className:'wl-route-pin' + (parked ? ' parked' : ''),
      html:`<span>${parked ? '!' : position}</span>`, size:30 };
  }
  if(stops.length > MAX_PIN_SECTIONS)
    return { className:'wl-route-pin split count', html:`<span>×${stops.length}</span>`, size:38 };
  return { className:`wl-route-pin split n${stops.length}`,
    html:stops.map(s => `<span>${s.position}</span>`).join(''),
    size:stops.length > 2 ? 44 : 38 };
}

/** The day's ids with `id` swapped into the next slot among the pin's unlocked
 *  stops, or null when it has nowhere to go. Only those two slots change, so a pin
 *  holding stops 3 and 9 trades them and leaves 4 to 8 where they are. */
export function reorderWithinPin(items, pinIds, id, delta){
  const list = items || [];
  const ids = list.map(x => String(x.id));
  const atPin = new Set((pinIds || []).map(String));
  const movable = list.filter(x => atPin.has(String(x.id)) && !x.lockedDate).map(x => String(x.id));
  const from = movable.indexOf(String(id));
  const other = from < 0 ? undefined : movable[from + delta];
  if(other === undefined) return null;
  const a = ids.indexOf(String(id)), b = ids.indexOf(other);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  return ids;
}

/** The phone-only "started from here" point as [lat,lng], or null. It is good for
 *  the day it was planned for and only until a stop is logged: after that the crew
 *  has moved on, the same way the saved drive-out goes with the first stop. */
export function liveStartFix(saved, planDate, pendingCount){
  const c = coordsOf(saved);
  if(!c || saved.date !== planDate || Number(pendingCount) < Number(saved.left)) return null;
  return [c.lat, c.lng];
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

// ── the All tab ──────────────────────────────────────────────────────────────
// Every pending order's pin on one map, so a wrong pin shows without opening the
// day it happens to be on. Field request, 2026-11-18: nine addresses had landed on
// one point, and it only showed on Day 5's tab. Read-only on purpose — no route
// line, no reorder. The order is edited on a day's own tab.

/** The All tab's key. Never a day key, which are `day:N` and `other`. */
export const ALL_ROUTES = 'all';
/** A pin holding orders from more than one day, and an order with no day yet. */
const MIXED_DAY_COLOR = '#334155';
const NO_DAY_COLOR = '#64748B';

/** Every pending order that has a pin, as `{ item, position, parked, point, day }`.
 *  `position` is the stop's number on its own day's tab. `total` counts the
 *  pending orders, pinned or not, and `missing` the ones with no pin. */
export function overviewMarkers(items){
  const markers = [];
  let missing = 0, parked = 0, total = 0;
  for(const group of groupPendingRoutes(items)){
    const model = buildRouteMapModel(group.items);
    missing += model.missing; parked += model.parked; total += group.items.length;
    for(const m of model.markers) markers.push({ ...m, day:group.day });
  }
  return { markers, missing, parked, total };
}

/** What an All-tab pin looks like. One order shows its day number in that day's
 *  colour. Several on one spot show the count — coloured by day when they share
 *  one, dark when they don't. */
export function overviewPinFace(stops){
  const days = [...new Set(stops.map(s => s.day == null ? null : Number(s.day)))];
  const color = days.length > 1 ? MIXED_DAY_COLOR
    : days[0] == null ? NO_DAY_COLOR : dayColor(days[0]);
  if(stops.length > 1)
    return { className:'wl-route-pin split count', html:`<span>×${stops.length}</span>`, size:38, color };
  const { parked, day } = stops[0];
  return { className:'wl-route-pin' + (parked ? ' parked' : ''),
    html:`<span>${parked ? '!' : day == null ? '•' : Number(day)}</span>`, size:30, color };
}

// ── the day's end time and the flat-out number ──────────────────────────────
// Display only. Neither number feeds the target, day sizing or the Optimize solve:
// the meters/day target alone sizes a day. `plan` is opts.dayPlan() — the installer's
// own usual start, delay per stop and break allowance — and carries the constants, so
// this module never reads config.js.

function planMin(text){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function planClock(min){
  const n = Math.max(0, Math.round(min));
  return String(Math.floor(n / 60) % 24).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

// The scheduler this view needs is the one that adds `breakMin`. The first
// dayEndEstimate/flatOutPerDay to ship ignored it, so a phone pairing this file with
// that cached route-constraints.js would drop the 60 break minutes without a word.
// breakMinutesLeft shipped in the same change as the break support, so its presence
// is the version check; without it both read-outs say nothing.

/** A day row's times, as the parts the card lays out on two lines:
 *  `{ times: '09:45 → about 15:55', includes: 'includes 60 min of breaks and 50 min of
 *  delays' }`, with `includes` '' when there are neither; null when there is nothing
 *  to say (no plan, no ETAs, an older cached scheduler). It was one run joined by
 *  ` · `, which wrapped onto two or three bold lines on a phone and was hard to read.
 *  Only Day 1 of a plan for today has begun, so only it takes the breaks still to
 *  come and, once a stop is logged, the real start. */
export function dayEndText(group, plan){
  if(!plan || !group) return null;
  if(typeof sched.dayEndEstimate !== 'function' || typeof sched.breakMinutesLeft !== 'function') return null;
  const today = group.day === 1 && Boolean(plan.planIsToday);
  const started = today ? planMin(plan.todayFirstLog) : null;
  const e = sched.dayEndEstimate(group.items, {
    fallbackOnSiteMin: plan.fallbackOnSiteMin,
    delayPerStopMin: plan.delayPerStopMin,
    breakMin: today ? plan.day1BreakMin : plan.breakMin,
    startedMin: started == null ? undefined : started,
  });
  if(!e) return null;
  const parts = [
    e.breakMin > 0 ? `${Math.round(e.breakMin)} min of breaks` : '',
    e.delayMin > 0 ? `${e.delayMin} min of delays` : '',
  ].filter(Boolean);
  return {
    times: `${started == null ? '' : 'started '}${planClock(e.startMin)} → about ${planClock(e.endMin)}`,
    includes: parts.length ? `includes ${parts.join(' and ')}` : '',
  };
}

/** The All tab's flat-out line: how many a day could hold from the usual start to
 *  the cut-off, at the work per stop the optimized days show, with the full break
 *  allowance and the delays. '' when the list has never been optimized, there is no
 *  day to measure, no plan, or no room. `target` is the meters/day target, quoted
 *  for comparison only. */
export function flatOutText(groups, plan, target){
  if(!plan) return '';
  if(typeof sched.flatOutPerDay !== 'function' || typeof sched.breakMinutesLeft !== 'function') return '';
  // A missing clock must not reach flatOutPerDay as null: Number(null) is midnight.
  const startMin = planMin(plan.usualStart), endMin = planMin(plan.flatOutEnd);
  if(startMin == null || endMin == null) return '';
  const list = groups || [];
  // Only a list optimized at least once. ETAs are no sign of it: the worklist times
  // every pending order as it opens, so an unoptimized list would quote a figure
  // off the order the orders were entered in. An Optimize saves each variant's
  // order on every order it routes, so one saved order says the list was solved.
  // (The day rows' end times stay: they describe the days as ordered now.)
  const saved = x => isPending(x) && [VARIANT_FIELDS.road.order, VARIANT_FIELDS.straight.order]
    .some(f => x[f] !== '' && x[f] != null && isFinite(Number(x[f])));
  if(!list.some(g => (g.items || []).some(saved))) return '';
  const r = sched.flatOutPerDay(list.map(g => g.items), {
    startMin, endMin,
    delayPerStopMin: plan.delayPerStopMin,
    breakMin: plan.breakMin,
    fallbackOnSiteMin: plan.fallbackOnSiteMin,
  });
  if(!r || !(r.perDay > 0)) return '';
  const total = list.reduce((n, g) => n + (g.items || []).length, 0);
  const days = Math.ceil(total / r.perDay);
  const goal = Math.floor(Number(target));
  return `Flat out: about ${r.perDay} a day by ${plan.flatOutEnd} — all ${total} in ${days} day${days === 1 ? '' : 's'}.`
    + (goal > 0 ? ` Planned at ${goal} a day.` : '');
}

export function initWorklistRouteView(opts){
  let map = null;
  let layer = null;
  let tileFailed = false;
  let selected = null;
  let openState = false;
  let snapshot = [];
  // The map fits only when something asks it to. Fitting is opt-in rather than
  // something a reorder opts out of, because a reorder reaches refresh() twice: once
  // here, and again through persistOrder → planAdvance → renderWorklist.
  let needsFit = false;
  let mapRun = 0;          // newest renderMap; an older one still awaiting paths stops
  // One popup for every pin, living on the map rather than on a marker. Markers are
  // rebuilt on each redraw, and a popup bound to one closes and reopens with it, which
  // left two lists on screen when the timing overlapped. This one just gets new content.
  let pinPopup = null;
  let openPinId = null;    // a stop on the pin whose list is open, kept across redraws
  let moving = false;      // one pin move at a time, so taps can't race the save

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
    // The stale note outranks the tuning readout: when the times on this screen
    // are from a route that no longer solves, that is the only thing worth
    // reading, and it must say so HERE rather than only on the worklist screen
    // the installer just navigated away from.
    const stale = planStale() ? (opts.planIssue && opts.planIssue()) || '' : '';
    weightsEl.classList.toggle('stale', Boolean(stale));
    if(stale){
      weightsEl.classList.remove('hide');
      weightsEl.textContent = `⚠ Times below are from an earlier route — re-optimize. ${stale}`;
      return;
    }
    if(!w){ weightsEl.classList.add('hide'); weightsEl.textContent = ''; return; }
    const pull = Number(w.commutePull);
    weightsEl.classList.remove('hide');
    weightsEl.textContent = `Tuning · commute pull ${isFinite(pull) ? pull : 70}%`
      + ` · target ${Math.max(1, Math.floor(Number(w.target) || 24))}/day`
      // Not "road Optimize for exact" any more: the re-anchor measures on the
      // downloaded district too, so what is missing when this shows is the MAP,
      // not a press. Pointing at Optimize sent the crew to re-solve a route that
      // was already fine and would come back estimated all over again.
      + (timesEstimated() ? ' · ~ETAs estimated (no offline map for these stops)' : '');
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
    pinPopup = L.popup({ minWidth:220, maxWidth:300 });
    pinPopup.on('remove', () => { openPinId = null; });
    return true;
  }

  function renderDays(groups){
    daysEl.innerHTML = '';
    const variant = (opts.routeVariant && opts.routeVariant()) || 'road';
    // With one group that group's own tab already shows every order.
    if(groups.length > 1){
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'wl-route-day' + (selected === ALL_ROUTES ? ' on' : '');
      all.setAttribute('aria-pressed', selected === ALL_ROUTES ? 'true' : 'false');
      all.textContent = `All · ${groups.reduce((n, g) => n + g.items.length, 0)}`;
      all.onclick = async () => { selected = ALL_ROUTES; needsFit = true; await render(); };
      daysEl.appendChild(all);
    }
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
      b.onclick = async () => { selected = group.key; needsFit = true; await render(); };
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
  // The last constraint solve failed, so every scheduled* field on this screen is
  // left over from the run before it. This was the whole complaint: the map showed
  // an ETA that said "on time" while the worklist screen carried two warnings
  // saying the opposite, because the ETA belonged to a route the solver had since
  // rejected and nothing marked it. Kept visible but greyed — a stale guide is
  // still worth something, a stale guide presented as current is not.
  function planStale(){ return Boolean(opts.planStale && opts.planStale()); }
  function etaText(item){ return `ETA ${timesEstimated() ? '~' : ''}${esc(item.scheduledEta)}`; }
  // Minutes past a promised appointment time, when the day cannot reach it from
  // any slot. Never a scheduling preference — waiting always wins over lateness —
  // so it only ever means "this one is not physically possible; make the call".
  function lateText(item){
    const n = Number(item.scheduledLateMin);
    return (isFinite(n) && n > 0) ? `⚠ ${Math.round(n)}m late` : '';
  }
  // The on-site half of the ETA, which used to be invisible: a stop's ETA is the
  // one before it plus the drive PLUS this. Shown per stop because it is no longer
  // the same everywhere — a repeat meter at an address the crew is already parked
  // at costs a fraction of a fresh site, and that is most of what changed.
  function onSiteText(item){
    const n = Number(item.scheduledOnSiteMin);
    return (isFinite(n) && n > 0) ? `${Math.round(n)}m on site` : '';
  }

  // One stop's row in a pin's list. Every stop on a merged pin shares the street, so
  // the row leads with what tells them apart: the unit.
  function pinRowHtml({ item, position, parked }, merged){
    const unit = String(item.unit || '').trim();
    const where = merged && unit ? `Unit ${esc(unit)}` : esc(addressLabel(item) || 'No address');
    const meta = [
      (showTimes() && item.scheduledEta) ? `${etaText(item)}${planStale() ? ' (stale)' : ''}` : '',
      item.appointmentTime ? `🔔 ${esc(item.appointmentTime)}` : '',
      lateText(item) ? `<span class="wl-route-late">${lateText(item)}</span>` : '',
    ].filter(Boolean).join(' · ');
    return `<span class="wl-route-pos">${parked ? '!' : position}</span>
      <div class="wl-route-pop-main">
        <strong>${parked ? '⚠ Parked — ' : ''}${item.workOrderId ? `WO ${esc(item.workOrderId)}` : '(no WO#)'}</strong>
        <div>${where}</div>
        ${meta ? `<div class="wl-route-meta${planStale() ? ' stale' : ''}">${meta}</div>` : ''}
      </div>`;
  }

  function pinList(pin, group){
    const merged = pin.stops.length > 1;
    const pinIds = pin.stops.map(s => s.item.id);
    const root = document.createElement('div');
    root.className = 'wl-route-pop';
    if(merged){
      const head = document.createElement('div');
      head.className = 'wl-route-pop-head';
      head.innerHTML = `<strong>${pin.stops.length} stops here</strong>`
        + `<div>${esc(pin.stops[0].item.address || 'No address')}</div>`;
      root.appendChild(head);
    }
    const rows = document.createElement('div');
    rows.className = 'wl-route-pop-rows';
    for(const stop of pin.stops){
      const row = document.createElement('div');
      row.className = 'wl-route-pop-row';
      row.innerHTML = pinRowHtml(stop, merged);
      if(merged) row.appendChild(pinRowControls(stop, pinIds, group, root));
      rows.appendChild(row);
    }
    root.appendChild(rows);
    return root;
  }

  function pinRowControls({ item }, pinIds, group, root){
    const box = document.createElement('div');
    box.className = 'wl-route-pop-move';
    if(item.lockedDate){
      box.innerHTML = '<span aria-label="Locked position">🔒</span>';
      return box;
    }
    const wo = item.workOrderId ? `WO ${item.workOrderId}` : 'this stop';
    for(const [delta, glyph, word] of [[-1, '▲', 'earlier'], [1, '▼', 'later']]){
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.setAttribute('aria-label', `Move ${wo} ${word}`);
      const ids = reorderWithinPin(group.items, pinIds, item.id, delta);
      b.disabled = !ids;
      b.onclick = () => movePinStop(ids, root);
      box.appendChild(b);
    }
    return box;
  }

  const pinRows = () => {
    const el = pinPopup.getElement();
    return el ? el.querySelector('.wl-route-pop-rows') : null;
  };

  // Open a pin's list, or refresh the one already open. The offset lifts the popup's
  // tip to the top of the pin (7 is Leaflet's default), so it doesn't cover the numbers.
  function showPinList(pin, group, size, keepScroll){
    const rows = keepScroll ? pinRows() : null;
    const top = rows ? rows.scrollTop : 0;
    pinPopup.options.offset = globalThis.L.point(0, 7 - size / 2);
    pinPopup.setLatLng(pin.point).setContent(group ? pinList(pin, group) : overviewPinList(pin));
    if(!map.hasLayer(pinPopup)) pinPopup.openOn(map);
    const next = pinRows();
    if(next) next.scrollTop = top;
  }

  // The same save as a dragged card, so the card list renumbers and locks and
  // appointments behave as they do for a drag.
  async function movePinStop(ids, root){
    if(moving) return;
    moving = true;
    root.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await opts.persistOrder(reorderRouteGroup(snapshot, selected, ids));
      await refresh();
    } catch(e){
      toast(e.message || 'Could not move that stop');
      await refresh();
    } finally { moving = false; }
  }

  // A pin's list on the All tab: which orders are here and which day each is on.
  // No move buttons — a pin here can hold orders from several days.
  function overviewPinList(pin){
    const root = document.createElement('div');
    root.className = 'wl-route-pop';
    const spots = new Set(pin.stops.map(s => String(s.item.address || '').trim().toLowerCase()));
    if(pin.stops.length > 1){
      const head = document.createElement('div');
      head.className = 'wl-route-pop-head';
      head.innerHTML = `<strong>${pin.stops.length} orders on this pin</strong>`
        + (spots.size > 1 ? '<div>⚠ Different addresses — at most one of them is really here.</div>' : '');
      root.appendChild(head);
    }
    const rows = document.createElement('div');
    rows.className = 'wl-route-pop-rows';
    for(const { item, position, parked, day } of pin.stops){
      const row = document.createElement('div');
      row.className = 'wl-route-pop-row';
      const meta = [day == null ? 'No day yet' : `Day ${day} · stop ${position}`,
        (showTimes() && item.scheduledEta) ? etaText(item) : ''].filter(Boolean).join(' · ');
      row.innerHTML = `<div class="wl-route-pop-main">
          <strong>${parked ? '⚠ Parked — ' : ''}${item.workOrderId ? `WO ${esc(item.workOrderId)}` : '(no WO#)'}</strong>
          <div>${esc(addressLabel(item) || 'No address')}</div>
          <div class="wl-route-meta">${meta}</div>
        </div>`;
      rows.appendChild(row);
    }
    root.appendChild(rows);
    return root;
  }

  // The All tab's map: every pending pin, no line. The same redraw rules as
  // renderMap — the newest run wins, the one shared popup, the opt-in fit.
  function renderOverviewMap(){
    updateOfflineNote();
    if(!ensureMap()){
      mapEl.innerHTML = '<div class="wl-route-map-empty">Map unavailable.</div>';
      return;
    }
    ++mapRun;                       // a day's render still waiting on road paths stops
    const L = globalThis.L;
    layer.clearLayers();
    const bounds = [];
    let listOpen = false;
    groupRoutePins(overviewMarkers(snapshot).markers).forEach(pin => {
      bounds.push(...pin.stops.map(s => s.point));
      const face = overviewPinFace(pin.stops);
      const half = face.size / 2;
      const marker = L.marker(pin.point, { icon:L.divIcon({
        className:face.className, html:face.html,
        iconSize:[face.size, face.size], iconAnchor:[half, half],
      }) }).addTo(layer);
      const ids = pin.stops.map(s => String(s.item.id));
      const open = () => { openPinId = ids[0]; showPinList(pin, null, face.size, false); };
      marker.on('click', open);
      marker.on('keypress', e => { if(e.originalEvent.key === 'Enter') open(); });
      if(ids.includes(openPinId)){
        listOpen = true;
        showPinList(pin, null, face.size, true);
      }
      if(!pin.stops[0].parked || pin.stops.length > 1){
        const el = marker.getElement();
        if(el) el.style.background = face.color;
      }
    });
    if(!listOpen) map.closePopup(pinPopup);
    const fit = needsFit;
    needsFit = false;
    setTimeout(() => {
      map.invalidateSize();
      if(!fit) return;
      if(bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(.12));
      else if(bounds.length === 1) map.setView(bounds[0], 15);
      else map.setView([45.0, -79.3], 7);
    }, 0);
  }

  // The day plan for this render, or null on a caller that does not pass one —
  // then the rows keep the first-to-last window and no flat-out line shows.
  // Takes Day 1's pending count because the breaks still to come on a day already
  // begun are shared out over the stops left, and this snapshot is what is on screen.
  function currentDayPlan(groups){
    if(typeof opts.dayPlan !== 'function') return null;
    const day1 = groups.find(g => g.day === 1);
    return opts.dayPlan(day1 ? day1.items.length : 0) || null;
  }

  // One row per day under the All map: the colour key for the pins, and the way
  // into that day's own tab. Leads with when the day should end, the route's own
  // work plus breaks plus this installer's usual delay per stop; the arrival window
  // is the fallback when that cannot be worked out.
  // Three short lines: the day, its times in plain text a size above the meta line,
  // and a small muted "includes …" line. Inline styles only, and the meta class the
  // stylesheet already has: a phone can run this file against an older capture.css,
  // and a new class would be unstyled there. A › at the right edge says it opens.
  function dayRow(group, plan){
    const row = document.createElement('div');
    row.className = 'wl-route-card';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const est = showTimes() ? dayEndText(group, plan) : null;
    const pins = group.items.filter(x => coordsOf(x)).length;
    const unpinned = pins === group.items.length ? '' : `${group.items.length - pins} without a pin`;
    const head = `<strong>${esc(group.label)} · ${group.items.length} order${group.items.length === 1 ? '' : 's'}</strong>`;
    const pos = `<span class="wl-route-pos" style="background:${group.day == null ? NO_DAY_COLOR : dayColor(group.day)};color:#fff">${group.day == null ? '•' : group.day}</span>`;
    if(est){
      const note = [est.includes, unpinned].filter(Boolean).join(' · ');
      row.innerHTML = `
        ${pos}
        <div class="wl-route-main">
          ${head}
          <div style="margin-top:3px;font-size:13px">${esc(est.times)}</div>
          ${note ? `<div class="wl-route-meta" style="font-weight:400">${esc(note)}</div>` : ''}
        </div>
        <span aria-hidden="true" style="flex:none;padding:0 2px 0 4px;font-size:22px;line-height:1;color:var(--ink-soft)">›</span>`;
    } else {
      // No estimate (no ETAs, no day plan, an older cached scheduler): the card as it
      // was before the end times, the arrival window and "tap to open".
      const win = showTimes() ? dayWindow(group.items) : '';
      row.innerHTML = `
        ${pos}
        <div class="wl-route-main">
          ${head}
          <div class="wl-route-meta">${[win, unpinned, 'tap to open'].filter(Boolean).join(' · ')}</div>
        </div>`;
    }
    const go = async () => { selected = group.key; needsFit = true; await render(); };
    row.onclick = go;
    row.onkeydown = e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); go(); } };
    return row;
  }

  // Orders on screen that share an exact pin with a DIFFERENT address. At most one
  // of them is right, and this count is the thing the 2026-11-18 report was missing:
  // the map looked plausible and nothing said nine addresses were on one point.
  function sharedPinCount(shown){
    if(typeof routeLib.sharedPinIds !== 'function') return 0;
    const ids = routeLib.sharedPinIds(snapshot.filter(isPending));
    return shown.filter(x => ids.has(x.id)).length;
  }

  // This phone's "started from here" point, for the group on screen. Day 1 only:
  // the crew starts every later day from the morning meet again.
  function routeStartFix(group){
    if(!group || group.day > 1 || !opts.savedStartFix || !opts.planDay) return null;
    return liveStartFix(opts.savedStartFix(), opts.planDay(), snapshot.filter(isPending).length);
  }

  async function renderMap(group){
    updateOfflineNote();
    if(!ensureMap()){
      mapEl.innerHTML = '<div class="wl-route-map-empty">Map unavailable. The route list can still be reordered.</div>';
      return;
    }
    const run = ++mapRun;
    const L = globalThis.L;
    const variant = (opts.routeVariant && opts.routeVariant()) || 'road';
    // Only trust the SAVED road geometry while the live order still matches the
    // order it was fetched against — it is keyed to that sequence, so after a
    // reorder it would trace the previous route's roads. This gate stays exactly
    // as strict as it was; the pack-measured paths below simply arrive first and
    // don't need it, being measured for the sequence on screen.
    const geomField = variantMatchesLive(snapshot, variant)
      ? (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).geometry : null;
    // The drive-out's SAVED polyline is read even when the order no longer matches:
    // its first point is the only record of where the crew start is, and that pin
    // doesn't move when the list is reordered. Only its shape is re-measured below.
    const homeGeomField = (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).homeLegGeometry;
    const items = group ? group.items : [];
    // Measure the legs actually on screen against the district pack. This is what
    // makes the roads survive a reorder: the today anchor re-leads the pending list
    // after every logged stop, which leaves the SAVED geometry keyed to a sequence
    // that no longer exists (variantMatchesLive goes false and drops it). A pack the
    // crew already downloaded can just answer for the current sequence instead.
    // No pack, or a leg it can't carry, leaves the key absent — saved geometry then
    // straight, exactly as before.
    const startFix = routeStartFix(group);
    const { legs } = routeLegs(items, homeGeomField, startFix);
    let computed = null;
    try { computed = await offlineRoutePaths(legs); }
    catch(e){ console.warn('route map: on-device paths unavailable:', e); }
    // Two refreshes can overlap, and both would otherwise add a full set of pins.
    // Clearing after the wait, and only for the newest run, keeps it to one set.
    if(run !== mapRun) return;
    layer.clearLayers();
    const model = buildRouteMapModel(items, geomField, homeGeomField, computed, startFix);
    const bounds = [];
    const color = group && group.day ? dayColor(group.day) : '#2563EB';
    let listOpen = false;
    groupRoutePins(model.markers).forEach(pin => {
      bounds.push(...pin.stops.map(s => s.point));
      const face = pinFace(pin.stops);
      const half = face.size / 2;
      const marker = L.marker(pin.point, { icon:L.divIcon({
        className:face.className, html:face.html,
        iconSize:[face.size, face.size], iconAnchor:[half, half],
      }) }).addTo(layer);
      const ids = pin.stops.map(s => String(s.item.id));
      const open = () => { openPinId = ids[0]; showPinList(pin, group, face.size, false); };
      marker.on('click', open);
      marker.on('keypress', e => { if(e.originalEvent.key === 'Enter') open(); });
      if(ids.includes(openPinId)){
        listOpen = true;
        showPinList(pin, group, face.size, true);
      }
      if(!pin.stops[0].parked){
        const el = marker.getElement();
        if(el) el.style.background = color;
      }
    });
    // Draw the road-following path (pack-measured, else saved geometry, else a
    // straight fallback per leg); otherwise the straight pin-to-pin route.
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
        .bindTooltip(startFix ? 'Start — where you optimized from'
          : 'Start — drive out to the first stop').addTo(layer);
    }
    if(!listOpen) map.closePopup(pinPopup);    // its stops left this view
    const fit = needsFit;
    needsFit = false;
    setTimeout(() => {
      map.invalidateSize();
      if(!fit) return;
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
        <div>${esc(addressLabel(item) || 'No address')}</div>
        <div class="wl-route-meta${planStale() ? ' stale' : ''}">${item.appointmentTime ? `🔔 ${esc(item.appointmentDate)} · ${esc(item.appointmentTime)} · ` : ''}${(showTimes() && item.scheduledEta) ? etaText(item) : ''}${(showTimes() && onSiteText(item)) ? ` · ${onSiteText(item)}` : ''}${(showTimes() && Number(item.scheduledWaitMin)>0) ? ` · wait ${Number(item.scheduledWaitMin)}m` : ''}${lateText(item) ? ` · <span class="wl-route-late">${lateText(item)}</span>` : ''}${item.lockedDate ? ` · locked slot ${Number(item.lockedSlot)}` : ''}</div>
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
    const all = selected === ALL_ROUTES && groups.length > 1;
    if(!all && !groups.some(g => g.key === selected)) selected = defaultRouteGroup(groups);
    const group = all ? null : (groups.find(g => g.key === selected) || null);
    renderWeights();
    renderDays(groups);
    // The line under "Your route" is markup with no id of its own, so it is found
    // by shape and left alone when an older index.html has something else there.
    const hint = screen.querySelector('.wl-route-head p');
    if(hint) hint.textContent = all
      ? 'Every order still to do. Tap a pin to see what is there.'
      : 'Drag the stops below to change their order.';
    listEl.innerHTML = '';
    if(all){
      const plan = currentDayPlan(groups);
      groups.forEach(g => listEl.appendChild(dayRow(g, plan)));
      const w = (opts.weights && opts.weights()) || {};
      const flat = flatOutText(groups, plan, w.target);
      if(flat){
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = flat;
        listEl.appendChild(p);
      }
    } else (group ? group.items : []).forEach((item, index) => listEl.appendChild(routeCard(item, index)));
    if(!all && !group){
      listEl.innerHTML = '<p class="muted">No pending orders. Add or download orders from the worklist.</p>';
    }
    const shown = all ? groups.flatMap(g => g.items) : (group ? group.items : []);
    const mapModel = buildRouteMapModel(shown);
    const missing = mapModel.missing;
    const parked = mapModel.parked;
    const shared = sharedPinCount(shown);
    const parts = [];
    if(missing) parts.push(`${missing} without a pin`);
    if(parked) parts.push(`${parked} parked`);
    if(shared) parts.push(`${shared} sharing a pin with a different address`);
    noticeEl.classList.toggle('hide', !parts.length);
    fixEl.classList.toggle('hide', !parts.length);
    noticeEl.textContent = parts.length
      ? `${parts.join(' · ')} — fix addresses or Optimize from the worklist.` : '';
    if(all) renderOverviewMap(); else await renderMap(group);
  }

  async function refresh(){
    snapshot = await opts.getItems();
    await render();
  }

  async function open(){
    openState = true;
    selected = null;
    needsFit = true;
    if(map) map.closePopup(pinPopup);
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
