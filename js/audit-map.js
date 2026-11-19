// ── The audit's route map: the orders of one day, in the order they were logged ─
// Pins numbered by their place in the day's logs, joined in that order with
// straight lines. It is the order worked, not the roads driven, and the page says
// so. The office view can lay the day's drive log over it (setDriveLegs); this
// module is handed the legs and never fetches anything itself, because the phone
// loads it too and the drive log is behind the office password.
//
// Leaflet is the vendored global `L`, loaded by a classic deferred script. If it
// is not there the map says so and the rest of the day view carries on.
import { esc } from './dom.js';
import { decodeTrack } from './drive-track.js';

const ROUTE = '#1E8E5A', DRIVE = '#7C3AED';
const PIN = { INSTALLED: '#1E8E5A', UTI: '#D64500' };
const STATUS = { INSTALLED: 'Installed', UTI: 'Unable to install', VISITED: 'Visited', UNACCOUNTED: 'Unaccounted' };
// The same boundary js/pages/map.js draws by: a jump this long between two fixes
// means recording stopped and started again, so the line breaks there.
const GAP_JUMP_S = 45;

/** One drive-log leg → the runs to draw, each a list of [lat, lng]. */
export function driveRuns(leg){
  const pts = decodeTrack((leg && leg.encoded) || '', Number(leg && leg.startTime) || 0);
  const runs = [];
  let run = [];
  const flush = () => { if(run.length > 1) runs.push(run); run = []; };
  pts.forEach((p, i) => {
    if(i > 0 && (p.t - pts[i - 1].t) / 1000 > GAP_JUMP_S) flush();
    run.push([p.lat, p.lng]);
  });
  flush();
  return runs;
}

/** The logs that cannot be drawn, named by their place in the day; '' when all can. */
export function offMapHtml(day){
  const off = day.logs.map((l, i) => l.pin ? '' : `#${i + 1} ${esc(l.workOrderId || 'no order number')} (no pin)`).filter(Boolean);
  return off.length ? `<p class="au-cap">Not on the map: ${off.join(', ')}</p>` : '';
}

const pinFace = (n, color) => `<span style="display:flex;align-items:center;justify-content:center;`
  + `width:24px;height:24px;border-radius:50%;background:${color};color:#fff;border:2px solid #fff;`
  + `box-shadow:0 1px 4px rgba(0,0,0,.45);font:800 11px/1 system-ui,sans-serif">${n}</span>`;

/** el → { show(day), setDriveLegs(legs | null), destroy() }. */
export function createRouteMap(el){
  const L = globalThis.L;
  if(!el || !L){
    if(el) el.innerHTML = '<p class="au-empty">The map could not load.</p>';
    return { show(){}, setDriveLegs(){}, destroy(){} };
  }
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView([45.0, -79.3], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const routeLayer = L.layerGroup().addTo(map), driveLayer = L.layerGroup().addTo(map);
  const popup = L.popup({ minWidth: 180, maxWidth: 280 });      // one, shared by every pin
  let bounds = [];

  function fit(extra = []){
    const all = bounds.concat(extra);
    map.invalidateSize();
    if(all.length === 1) map.setView(all[0], 15);
    else if(all.length) map.fitBounds(all, { padding: [28, 28], maxZoom: 16 });
  }
  function show(day){
    routeLayer.clearLayers(); driveLayer.clearLayers(); map.closePopup();
    bounds = [];
    const line = [];
    day.logs.forEach((log, i) => {
      if(!log.pin) return;
      const at = [log.lat, log.lng];
      line.push(at); bounds.push(at);
      const marker = L.marker(at, { icon: L.divIcon({ className: 'au-pin', html: pinFace(i + 1, PIN[log.status] || '#5A636E'),
        iconSize: [24, 24], iconAnchor: [12, 12] }), keyboard: true, title: `#${i + 1}` }).addTo(routeLayer);
      marker.on('click', () => popup.setLatLng(at).setContent(
        `<b>#${i + 1} · ${esc(log.clock)}</b><br>${esc(log.workOrderId || 'no order number')} · ${esc(STATUS[log.status] || log.status)}`
        + (log.address ? `<br>${esc(log.address)}` : '')).openOn(map));
    });
    if(line.length > 1) L.polyline(line, { color: ROUTE, weight: 4, opacity: .78, interactive: false }).addTo(routeLayer);
    // The card was hidden while the period view was up: let it lay out first.
    setTimeout(() => fit(), 60);
  }
  function setDriveLegs(legs){
    driveLayer.clearLayers();
    if(!legs) return;
    const seen = [];
    for(const leg of legs){
      for(const run of driveRuns(leg)){
        L.polyline(run, { color: DRIVE, weight: 4, opacity: .8, interactive: false }).addTo(driveLayer);
        seen.push(run[0], run[run.length - 1]);
      }
      for(const g of Array.isArray(leg.gaps) ? leg.gaps : []){
        if(g.pauseLat == null || g.resumeLat == null) continue;
        L.polyline([[g.pauseLat, g.pauseLng], [g.resumeLat, g.resumeLng]],
          { color: DRIVE, weight: 3, opacity: .55, dashArray: '6 8', interactive: false }).addTo(driveLayer);
      }
    }
    fit(seen);
  }
  return { show, setDriveLegs, destroy(){ map.remove(); } };
}
