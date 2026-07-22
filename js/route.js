// ── Route optimization (land mode) ───────────────────────────────────────────
// Turns a worklist of pending orders into the most efficient open driving path.
// One entry point, optimizeRoute(), runs the whole pipeline ON THE PHONE:
//
//   1. geocode every order's text address → coords (Google Geocoding API),
//      biased AND hard-bounded to GEO_RADIUS_KM around the crew (wrong-town
//      matches park instead), re-geocoding previously stored pins that fall
//      outside the circle — a stored pin is only ever REPLACED by a successful
//      new match (or an explicit which-town pick), never blanked: a miss or an
//      ambiguity keeps the last good pin and parks the order by flag, so the
//      pin survives to the Worklist sheet for future runs; results cached ON
//      the order;
//   2. pull a road-distance matrix from the Google Routes API (tiled in
//      625-element requests), falling back to straight-line (haversine)
//      distances when the call fails OR the monthly element budget is spent —
//      Google bills the matrix per stop-PAIR (a 25-stop day ≈ 676 elements
//      against 10k free/month), so MATRIX_FREE_ELEMENTS below is the
//      per-device guard that keeps the key from billing past the free tier;
//   3. solve the open-path TSP locally (nearest-neighbour + 2-opt + Or-opt),
//      pinned so the route can start at the phone, end toward home, or retain
//      the list's first order as its start — milliseconds even for ~200 stops;
//      the network time above dominates.
//
// Google is hit with bare fetch() — NEVER apiGet/apiPost, which inject the Apps
// Script token + URL. This module deliberately does not import api.js: the
// Apps Script backend is not in this path (see CLAUDE.md — the whole point is
// to keep the heavy work off the Apps Script cloud). The key is API-restricted
// + quota-capped so it can't bill past the free tier (see DEPLOY.md — no
// referrer restriction: the Geocoding web service rejects those keys).
import { GMAPS_API_KEY, ORS_API_KEY } from './config.js';
import { idb } from './idb.js';
import { store } from './store.js';
import { stamp, localDate } from './time.js';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const MATRIX_URL  = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

// OpenRouteService — the free hosted BACKUP for both lookups (config.js
// ORS_API_KEY). Geocoding is Pelias (GeoJSON, lng/lat); the matrix is a single
// POST capped at ORS_MATRIX_MAX location-PAIRS (the free plan's 3,500 ≈ 59
// stops) — a bigger list skips ORS and solves straight-line. Only ever reached
// when the Google/OSRM primary returns nothing; see optimizeRoute.
const ORS_GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const ORS_MATRIX_URL  = 'https://api.openrouteservice.org/v2/matrix/driving-car';
const ORS_MATRIX_MAX  = 3500;

// Google allows ~50 geocodes/sec; the small gap just keeps a 189-address run
// polite and the progress line readable.
const GEOCODE_MS    = 120;

// Matrix guardrails. One computeRouteMatrix request caps at 625 elements
// (origins × destinations), so an N×N matrix is tiled from BLOCK×BLOCK chunks.
// MATRIX_FREE_ELEMENTS is THIS DEVICE's share of the 10k-elements/month free
// tier — spent elements are tracked in localStorage and a run that would blow
// the remainder solves on straight-line instead (see matrixBudget below).
// Several devices optimizing daily share one billing account: lower this (or
// rely on the DEPLOY.md budget alert) if that's your fleet.
const BLOCK                = 25;
const MATRIX_MS            = 200;
const MATRIX_FREE_ELEMENTS = 9000;
const GEO_RADIUS_KM = 240;    // only match addresses this close to the crew — a
                             // same-named street one region over must park, not
                             // match. Single tune knob; optimizing far from the
                             // route area gates on the list's own median instead
                             // (see optimizeRoute).
const AMBIG_KM      = 2;     // rival matches count as "different places" only in
                             // different localities AND farther apart than this
const LOCATE_MS     = 8000;  // GPS wait cap for the gate center (coarse is fine)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A worklist item counts as "located" only with two real numbers for coords.
// The null/'' guards matter: Number(null) and Number('') are both 0, so a
// missing item or blank cell would otherwise "locate" at 0,0 in the Atlantic.
// Exported: worklist.js uses it for the directions handoff and parked checks.
export function coordsOf(item){
  const lat = item && item.lat, lng = item && item.lng;
  if(lat == null || lat === '' || lng == null || lng === '') return null;
  return (isFinite(Number(lat)) && isFinite(Number(lng)))
    ? { lat: Number(lat), lng: Number(lng) } : null;
}

// Parked = excluded from routing: the address didn't map (geoFail), matched
// several towns (geoAmbig), or has no pin at all. A parked order can still
// CARRY coords — a stale pin whose re-geocode missed keeps its last good pin
// (never blanked) but must not be routed on it. Exported: planner.js keys the
// map's warning markers on it.
export function isParked(item){
  return !!(item && (item.geoFail || (item.geoAmbig && item.geoAmbig.length))) || !coordsOf(item);
}

// One position fix for the geocode gate and, when requested, the route start.
// An explicit start asks for a fresh high-accuracy fix; the normal geocode-only
// path accepts a recent coarse fix. Never rejects: denied/unanswered location
// prompts resolve null so optimization can fall back instead of hanging.
function currentPosition(maxMs, fresh=false){
  if(!('geolocation' in navigator)) return Promise.resolve(null);
  const fix = new Promise(res => navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => res(null),
    { enableHighAccuracy:fresh, timeout:maxMs, maximumAge:fresh ? 0 : 120000 }));
  const cap = new Promise(res => setTimeout(() => res(null), maxMs + 2000));
  return Promise.race([fix, cap]);
}

// Independent medians of lat/lng over the located items — median, not mean, so
// the wrong-region outliers this run is about to heal can't drag the center.
function medianCenter(items){
  const pts = (items || []).map(coordsOf).filter(Boolean);
  if(!pts.length) return null;
  const mid = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map(p => p.lat)), lng: mid(pts.map(p => p.lng)) };
}

// ── forward geocoding ────────────────────────────────────────────────────────
// Fill lat/lng on every pending order that lacks them — and REVALIDATE the ones
// that have them: a stored pin farther than GEO_RADIUS_KM from the gate center
// is stale (the wrong-town matches this circle exists to prevent), so the
// address is re-geocoded inside the circle. A stored pin is NEVER blanked:
// only a successful new match replaces it — a miss (geoFail) or an ambiguity
// (geoAmbig) keeps the last good pin and parks the order by flag (isParked),
// so the pin still rides the next Worklist upload. Each result (or flag) is
// persisted to IndexedDB immediately — that persisted copy IS the cache, so a
// cancelled or retried run only re-hits the addresses still unresolved, and
// in-radius items cost zero network. An ambiguous match (same address in
// several places) deliberately gets no NEW coords — the route must not
// silently pick a town; the card shows the choices instead (worklist.js).
// The ", ON, Canada" text bias stays: the crew ranges province-wide, and the
// circle (not the text) is what pins the region.
async function geocodeAll(items, onProgress, center, geoUrl){
  let done = 0;
  for(const item of items){
    const c = coordsOf(item);
    const stale = !!(c && center && haversine(c, center) > GEO_RADIUS_KM * 1000);
    if(c && !stale && (item.geoFail || item.geoAmbig)){
      // In-radius pin with leftover parked flags (a previous run's miss, gate
      // has since moved into range) — heal, or the order stays parked forever:
      // only the !c || stale branch below ever re-processes an item.
      item.geoFail = false; item.geoAmbig = undefined;
      const stored = (await idb.get('worklist', item.id)) || item;
      await idb.put('worklist', Object.assign({}, stored, {
        geoFail: false, geoAmbig: undefined, updatedAt: stamp() }));
    }
    if(!c || stale){
      const hit = await geocodeOne(item.address, center, geoUrl);
      if(hit && !hit.ambig){
        item.lat = hit.lat; item.lng = hit.lng; item.geoFail = false; item.geoAmbig = undefined;
      } else if(hit){
        item.geoFail = false; item.geoAmbig = hit.ambig;
      } else {
        item.geoFail = true; item.geoAmbig = undefined;
      }
      // Persist coords (or the flags) back onto the stored order.
      const stored = (await idb.get('worklist', item.id)) || item;
      await idb.put('worklist', Object.assign({}, stored, {
        lat: item.lat, lng: item.lng, geoFail: item.geoFail, geoAmbig: item.geoAmbig,
        updatedAt: stamp() }));
      await sleep(GEOCODE_MS);
    }
    onProgress && onProgress({ phase:'geocode', done: ++done, total: items.length });
  }
}

// One address → {lat, lng, label} — plus an `ambig` candidate list when it
// matches several distinct places — or null. Never throws: a network/parse
// failure is just a miss, and the caller parks the order for manual fixing.
// PROVIDERS: an optional self-hosted Nominatim FIRST when `geoUrl` is passed
// (the desktop planner's local, zero-API path), then Google, then
// OpenRouteService (config.js ORS_API_KEY, blank = disabled) — so a local miss
// or a rejected/over-quota Google key still resolves instead of parking every
// order. Phone-side callers pass no geoUrl, so they stay Google→ORS exactly as
// before. With a center the search is biased to a
// GEO_RADIUS_KM box around it, but the provider bounds are a SOFT bias only
// (never a hard filter), so the local haversine gate in pickBest() is what
// actually gates: an out-of-circle result can only park an order, never keep a
// far-away wrong pin. Exported: capture.js pins the Settings home address and
// worklist.js retries it with this same call.

// The last KEY-level Google rejection seen (REQUEST_DENIED etc.), and whether
// the ORS backup produced any returned hit — both reset per optimizeRoute run.
// geoKeyError surfaces as geoReason ("the key is broken" ≠ "no match"), but is
// suppressed when orsGeoUsed carried the run — without route.js touching UI.
let geoKeyError = null;
let orsGeoUsed = false;
// Whether a local (Nominatim) URL was in play and a lookup still had to fall
// through to Google/ORS because the local geocoder came up empty — surfaced as
// a reassuring `note` so a thin local map is visible without alarming.
let geoFellBack = false;

export async function geocodeOne(address, center, geoUrl){
  const text = String(address || '').trim();
  if(!text) return null;
  // Provider 0 (planner only): a self-hosted Nominatim, tried FIRST when its URL
  // is passed, so a normal planning run makes no external geocoding call.
  if(geoUrl){
    const n = await nominatimGeocode(text, center, geoUrl);
    if(n) return n;
  }
  const g = await googleGeocode(text, center);
  if(g){ if(geoUrl) geoFellBack = true; return g; }
  if(ORS_API_KEY){
    const o = await orsGeocode(text, center);
    if(o){ orsGeoUsed = true; if(geoUrl) geoFellBack = true; return o; }
  }
  return null;
}

// Rank normalized hits [{lat,lng,label,place}] into the geocodeOne result:
// hard-gate to GEO_RADIUS_KM around center, then detect ambiguity (the same
// address in distinct places — different `place` AND > AMBIG_KM apart, so
// same-town rivals like an address point vs its street centroid don't count).
// Surfaced, never auto-picked. Shared by all providers so the gate/ambiguity
// behavior can't drift between them.
function pickBest(hits, center){
  const inCircle = (hits || []).filter(h =>
    h && isFinite(h.lat) && isFinite(h.lng) &&
    !(center && haversine(h, center) > GEO_RADIUS_KM * 1000));
  if(!inCircle.length) return null;
  const best = inCircle[0];
  const rivals = inCircle.filter(hh =>
    hh.place !== best.place && haversine(hh, best) > AMBIG_KM * 1000);
  if(rivals.length){
    const seen = {}; const cands = [];
    for(const hh of [best, ...rivals]){
      if(seen[hh.place]) continue;
      seen[hh.place] = 1;
      cands.push({ label: hh.label, lat: hh.lat, lng: hh.lng });
    }
    return { lat: best.lat, lng: best.lng, label: best.label, ambig: cands.slice(0, 3) };
  }
  return { lat: best.lat, lng: best.lng, label: best.label };
}

// Provider 1 — Google Geocoding. Records geoKeyError on a key-level status so
// the toast can name a broken key vs a plain no-match. Null on any failure.
async function googleGeocode(text, center){
  let url = `${GEOCODE_URL}?address=${encodeURIComponent(text + ', ON, Canada')}`
    + `&components=country:CA&region=ca`
    + `&key=${encodeURIComponent(GMAPS_API_KEY)}`;
  if(center){
    const dLat = GEO_RADIUS_KM / 111.32;
    const dLng = GEO_RADIUS_KM / (111.32 * Math.cos(center.lat * Math.PI / 180));
    url += `&bounds=${encodeURIComponent(
      `${center.lat - dLat},${center.lng - dLng}|${center.lat + dLat},${center.lng + dLng}`)}`;
  }
  try {
    const res = await fetch(url);
    if(!res.ok){ console.warn('Geocode failed: HTTP', res.status); return null; }
    const data = await res.json();
    // status covers ZERO_RESULTS, OVER_QUERY_LIMIT (the daily quota cap that
    // guarantees $0 — see DEPLOY.md), REQUEST_DENIED (bad/missing key) — all
    // just a miss here; the order parks (or falls to ORS) and can be retried.
    if(!data || data.status !== 'OK'){
      if(data && data.status && data.status !== 'ZERO_RESULTS'){
        console.warn('Geocode failed:', data.status, data.error_message || '');
        if(/^(REQUEST_DENIED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT)$/.test(data.status))
          geoKeyError = data.status;
      }
      return null;
    }
    const hits = (data.results || []).map(r => {
      const loc = r && r.geometry && r.geometry.location;
      if(!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return null;
      return { lat: loc.lat, lng: loc.lng, label: r.formatted_address || text, place: placeOf(r) };
    }).filter(Boolean);
    return pickBest(hits, center);
  } catch { return null; }
}

// Provider 2 — OpenRouteService geocoding (Pelias). GeoJSON, coordinates in
// [lng, lat] order (the one conversion point). focus.point biases, boundary.*
// bounds; pickBest re-gates locally regardless. Null on any failure.
async function orsGeocode(text, center){
  let url = `${ORS_GEOCODE_URL}?api_key=${encodeURIComponent(ORS_API_KEY)}`
    + `&text=${encodeURIComponent(text)}&boundary.country=CA&size=5`;
  if(center){
    url += `&focus.point.lon=${center.lng}&focus.point.lat=${center.lat}`
      + `&boundary.circle.lon=${center.lng}&boundary.circle.lat=${center.lat}`
      + `&boundary.circle.radius=${GEO_RADIUS_KM}`;   // km
  }
  try {
    const res = await fetch(url);
    if(!res.ok){ console.warn('ORS geocode failed: HTTP', res.status); return null; }
    const data = await res.json().catch(() => null);
    const hits = ((data && data.features) || []).map(f => {
      const c = f && f.geometry && f.geometry.coordinates;   // [lng, lat]
      const p = (f && f.properties) || {};
      if(!c || !isFinite(c[0]) || !isFinite(c[1])) return null;
      const place = String(p.locality || p.localadmin || p.county || p.region || '').toLowerCase();
      return { lat: c[1], lng: c[0], label: p.label || text, place };
    }).filter(Boolean);
    return pickBest(hits, center);
  } catch { return null; }
}

// Provider 0 (planner only) — a self-hosted Nominatim geocoder (OpenStreetMap),
// same OSM data as the local OSRM. Reached first when the planner passes its URL
// so a normal run makes NO external geocoding call. `/search` returns a JSON
// array [{lat, lon, display_name, address:{…}}]; the town for the ambiguity
// check comes from addressdetails, and pickBest re-gates locally like the other
// providers. viewbox is a SOFT bias (bounded=0). Null on any failure → Google.
async function nominatimGeocode(text, center, base){
  let url = `${String(base).replace(/\/+$/, '')}/search`
    + `?q=${encodeURIComponent(text + ', ON, Canada')}`
    + `&format=json&addressdetails=1&countrycodes=ca&limit=5`;
  if(center){
    const dLat = GEO_RADIUS_KM / 111.32;
    const dLng = GEO_RADIUS_KM / (111.32 * Math.cos(center.lat * Math.PI / 180));
    // viewbox is lon,lat,lon,lat (top-left, bottom-right); bounded=0 = soft bias.
    url += `&viewbox=${center.lng - dLng},${center.lat + dLat},`
      + `${center.lng + dLng},${center.lat - dLat}&bounded=0`;
  }
  try {
    const res = await fetch(url);
    if(!res.ok){ console.warn('Nominatim geocode failed: HTTP', res.status); return null; }
    const data = await res.json().catch(() => null);
    const hits = (Array.isArray(data) ? data : []).map(r => {
      const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
      if(!isFinite(lat) || !isFinite(lng)) return null;
      const a = r.address || {};
      const place = String(a.town || a.city || a.village || a.hamlet
        || a.municipality || a.county || '').toLowerCase();
      return { lat, lng, label: r.display_name || text, place };
    }).filter(Boolean);
    return pickBest(hits, center);
  } catch { return null; }
}

// The "place" a Google result belongs to, for the ambiguity check — the town
// (or, rural, the township/county) from Google's address_components.
function placeOf(result){
  const comps = (result && result.address_components) || [];
  for(const type of ['locality', 'administrative_area_level_3', 'administrative_area_level_2'])
    for(const c of comps)
      if((c.types || []).includes(type)) return String(c.long_name || '').toLowerCase();
  return '';
}

// ── road-distance matrix (Google Routes API, tiled) ──────────────────────────
// Returns { D } — an N×N array of driving distances in metres — or { error }
// (a short human-readable reason) when the run must solve on straight-line
// instead: any chunk failing after a retry (offline, quota, bad key) or the
// monthly element budget not covering N². The reason rides optimizeRoute's
// fallbackReason into the toast, so "the key is rejected" stops looking like
// "offline". Road distance is asymmetric (one-way streets); solve()
// symmetrizes so the 2-opt segment-reversal math stays valid — the asymmetry
// is minor here.

// This device's spent-elements ledger, reset each calendar month. Spend is
// recorded per successful chunk — Google bills each request even if a later
// chunk fails — so a half-failed run still counts what it cost.
function matrixBudgetLeft(){
  const month = localDate().slice(0, 7);
  if(store.get('matrixMonth') !== month){
    store.set('matrixMonth', month);
    store.set('matrixUsed', '0');
  }
  return MATRIX_FREE_ELEMENTS - (Number(store.get('matrixUsed')) || 0);
}
function matrixBudgetSpend(elements){
  store.set('matrixUsed', String((Number(store.get('matrixUsed')) || 0) + elements));
}

async function buildMatrix(coords, onProgress){
  const n = coords.length;
  if(n * n > matrixBudgetLeft())                   // budget spent → straight-line
    return { error: 'monthly road-data budget spent' };
  const D = Array.from({ length: n }, () => new Float64Array(n));
  const blocks = [];
  for(let s = 0; s < n; s += BLOCK) blocks.push([s, Math.min(s + BLOCK, n)]);
  const totalCalls = blocks.length * blocks.length;
  let done = 0;
  for(const [si, se] of blocks){
    for(const [di, de] of blocks){
      const r = await matrixCall(coords.slice(si, se), coords.slice(di, de));
      if(r.error) return { error: r.error };       // abort → haversine fallback
      matrixBudgetSpend((se - si) * (de - di));
      for(const el of r.els){
        if(el == null || el.originIndex == null || el.destinationIndex == null) continue;
        D[si + el.originIndex][di + el.destinationIndex] =
          el.condition === 'ROUTE_EXISTS' ? Number(el.distanceMeters || 0) : Infinity;
      }
      onProgress && onProgress({ phase:'matrix', done: ++done, total: totalCalls });
      await sleep(MATRIX_MS);
    }
  }
  for(let i = 0; i < n; i++) D[i][i] = 0;
  return { D };
}

// ── road-distance matrix (self-hosted OSRM — the desktop planner's source) ───
// One GET against a local/self-hosted OSRM `table` service: free, unmetered,
// and big enough that the whole day fits in a single call (no tiling, no
// budget). Returns { D } — the N×N metres array — or { error } (caller falls
// back to straight-line — deliberately NEVER into the billable Google path: a
// planner run with OSRM down should degrade free and visibly, not quietly
// spend). GOTCHA: OSRM speaks GeoJSON coordinate order — lng,lat — the reverse
// of the {lat,lng} we store; the join below is the one conversion point.
async function osrmMatrix(coords, osrmUrl){
  const pts = coords.map(c => `${c.lng},${c.lat}`).join(';');
  const url = `${String(osrmUrl).replace(/\/+$/, '')}/table/v1/driving/${pts}?annotations=distance`;
  let reason = 'no response';
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      const res = await fetch(url);
      const data = res.ok ? await res.json().catch(() => null) : null;
      if(data && data.code === 'Ok' && Array.isArray(data.distances))
        return { D: data.distances.map(row => row.map(v => v == null ? Infinity : Number(v))) };
      reason = res.ok ? ((data && data.code) || 'bad response') : `HTTP ${res.status}`;
      console.warn('OSRM table failed:', reason);
    } catch(e){
      reason = navigator.onLine ? 'network error' : 'offline';
      console.warn('OSRM table failed:', e);
    }
    if(attempt === 0) await sleep(MATRIX_MS);
  }
  return { error: 'OSRM ' + reason };
}

// ── road-distance matrix (OpenRouteService — the BACKUP source) ──────────────
// One POST to ORS's hosted matrix (config.js ORS_API_KEY): free, no tiling, but
// capped at ORS_MATRIX_MAX location-PAIRS — a list over the cap skips ORS so the
// run solves straight-line rather than erroring. Returns { D } (N×N metres) or
// { error } (caller then falls to straight-line). Reached only when the primary
// (Google Routes / OSRM) failed. GOTCHA: ORS speaks GeoJSON order — lng,lat —
// the reverse of the {lat,lng} we store; the map below is the one conversion.
async function orsMatrix(coords){
  const n = coords.length;
  if(n * n > ORS_MATRIX_MAX) return { error: `ORS matrix too big (${n} stops)` };
  const body = JSON.stringify({
    locations: coords.map(c => [c.lng, c.lat]), metrics: ['distance'], units: 'm' });
  let reason = 'no response';
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      const res = await fetch(ORS_MATRIX_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': ORS_API_KEY },
        body });
      const data = await res.json().catch(() => null);
      if(res.ok && data && Array.isArray(data.distances))
        return { D: data.distances.map(row => row.map(v => v == null ? Infinity : Number(v))) };
      const err = data && data.error;
      reason = (err && (err.message || err)) || `HTTP ${res.status}`;
      console.warn('ORS matrix failed:', res.status, data);
    } catch(e){
      reason = navigator.onLine ? 'network error' : 'offline';
      console.warn('ORS matrix failed:', e);
    }
    if(attempt === 0) await sleep(MATRIX_MS);
  }
  return { error: 'ORS ' + reason };
}

// One matrix chunk, with a single retry. Returns { els } (each element
// {originIndex, destinationIndex, distanceMeters, condition}) or { error } —
// the reason built from Google's error body ({error:{code,message,status}},
// or [{error:{…}}] on the streamed array form) so a rejected key reads as
// REQUEST_DENIED/PERMISSION_DENIED in the toast, not as generic "unavailable".
// The FieldMask header is mandatory — Google rejects the request without it.
async function matrixCall(origins, destinations){
  const wp = c => ({ waypoint: { location: { latLng: { latitude: c.lat, longitude: c.lng } } } });
  const body = JSON.stringify({
    origins: origins.map(wp), destinations: destinations.map(wp),
    travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' });
  let reason = 'no response';
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      const res = await fetch(MATRIX_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GMAPS_API_KEY,
          'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,condition' },
        body });
      const data = await res.json().catch(() => null);
      if(res.ok && Array.isArray(data)) return { els: data };
      const err = data && (Array.isArray(data) ? (data[0] && data[0].error) : data.error);
      reason = err ? `${err.status || ('HTTP ' + res.status)}${err.message ? ' — ' + err.message : ''}`
                   : `HTTP ${res.status}`;
      console.warn('Routes matrix chunk failed:', res.status, data);
    } catch(e){
      reason = navigator.onLine ? 'network error' : 'offline';
      console.warn('Routes matrix chunk failed:', e);
    }
    if(attempt === 0) await sleep(MATRIX_MS);
  }
  return { error: reason };
}

// Straight-line fallback matrix (metres). Symmetric by construction. A uniform
// road-detour factor wouldn't change which order is shortest, so none is applied.
function haversineMatrix(coords){
  const n = coords.length;
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for(let i = 0; i < n; i++)
    for(let j = i + 1; j < n; j++){
      const d = haversine(coords[i], coords[j]);
      D[i][j] = d; D[j][i] = d;
    }
  return D;
}
function haversine(a, b){
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ── open-path TSP solve (pinned start, or free-endpoint multi-start) ─────────
// D is symmetrized first so a 2-opt segment reversal (and an Or-opt relocation)
// only changes its boundary edges — interior edge costs are direction-independent
// — which is what makes the O(1) deltas below exact. The far end always floats
// free (open path — boundary term dropped at the tour ends).
//
// pinned=true keeps node 0 first through the whole solve (iMin/jMin = 1 in the
// passes below): NN from a fixed start is deterministic, so the multi-start
// seeds are meaningless and one construction + polish suffices. The caller pins
// the home node (then reads the tour backwards — on a symmetric matrix that IS
// the pinned-END path toward home) or the list's first order.
//
// pinned=false is the legacy free path: multi-start nearest-neighbour + 2-opt
// finds a good basin cheaply, then one 2-opt + Or-opt polish on the winner.
// Or-opt (relocating a run of 1–3 stops) is what kills the "drive out to #2,
// then backtrack to #3" detours that 2-opt alone — which can only reverse
// segments, never move a stranded stop — leaves behind. The polish runs once so
// the O(n²)-per-pass Or-opt stays fast even at ~200 stops.
function solve(D, pinned){
  const n = D.length;
  if(n <= 2) return range(0, n);
  if(pinned) return solveAnchoredPath(D);
  const S = symmetrize(D);
  const starts = spreadStarts(n, Math.min(12, n));
  let best = null, bestLen = Infinity;
  for(const s of starts){
    const tour = twoOptLoop(nearestNeighbour(S, s), S);
    const len = pathLength(tour, S);
    if(len < bestLen){ bestLen = len; best = tour; }
  }
  return polish(best, S);
}

// Solve an open path with node 0 fixed at the start. When pinEnd is true the
// final matrix node is also fixed, leaving only the middle nodes movable.
// Exported so the endpoint contract can be tested without browser/network IO.
export function solveAnchoredPath(D, { pinEnd=false }={}){
  const n = D.length;
  if(n <= 2) return range(0, n);
  const S = symmetrize(D);
  const kMax = pinEnd ? n - 2 : n - 1;
  const tour = nearestNeighbour(S, 0, pinEnd ? n - 1 : -1);
  return polish(twoOptLoop(tour, S, 1, kMax), S, true, pinEnd);
}

// Convert a matrix containing optional synthetic start/home anchors back into
// zero-based indices for the located work orders only.
export function routeOrderFromMatrix(D, locatedCount, { hasStart=false, hasHome=false }={}){
  if(hasStart){
    const tour = solveAnchoredPath(D, { pinEnd:hasHome });
    return tour.slice(1, hasHome ? -1 : undefined).map(i => i - 1);
  }
  if(hasHome)
    return solveAnchoredPath(D).slice().reverse().slice(0, -1).map(i => i - 1);
  return solveAnchoredPath(D).slice(0, locatedCount);
}

function symmetrize(D){
  const n = D.length;
  const S = Array.from({ length: n }, () => new Float64Array(n));
  for(let i = 0; i < n; i++)
    for(let j = i + 1; j < n; j++){
      const v = (D[i][j] + D[j][i]) / 2;
      S[i][j] = v; S[j][i] = v;
    }
  return S;
}

function nearestNeighbour(D, start, end=-1){
  const n = D.length;
  const seen = new Uint8Array(n);
  const tour = [start]; seen[start] = 1;
  let cur = start;
  for(let step = 1; step < n; step++){
    if(end >= 0 && step === n - 1){ tour.push(end); seen[end] = 1; break; }
    let next = -1, dist = Infinity;
    for(let j = 0; j < n; j++)
      if(j !== end && !seen[j] && D[cur][j] < dist){ dist = D[cur][j]; next = j; }
    if(next === -1) break;
    seen[next] = 1; tour.push(next); cur = next;
  }
  // A row of Infinities (an unroutable point in the road matrix) strands the
  // walk above. The tour must still be a full permutation — a dropped node
  // would silently keep its stale `order` downstream — so append whatever's
  // left.
  if(tour.length < n) for(let j = 0; j < n; j++) if(!seen[j]) tour.push(j);
  return tour;
}

// One 2-opt pass (reverse the segment [i..k] when it shortens the path); returns
// whether it improved. Boundary-edge-only delta, valid on a symmetric matrix.
// iMin=1 pins tour[0]: a reversal of [i..k] moves exactly positions i..k, so
// starting i at 1 never touches the anchor — and at i=1 the `a` sentinel is the
// anchor itself, charging the real anchor edge. The d=-1 sentinel still frees
// the far end.
function twoOptPass(tour, D, iMin = 0, kMax = tour.length - 1){
  const n = tour.length, eps = 1e-6;
  let improved = false;
  for(let i = iMin; i < kMax; i++){
    const a = i > 0 ? tour[i - 1] : -1;
    for(let k = i + 1; k <= kMax; k++){
      const b = tour[i], c = tour[k], d = k < n - 1 ? tour[k + 1] : -1;
      const removed = (a >= 0 ? D[a][b] : 0) + (d >= 0 ? D[c][d] : 0);
      const added   = (a >= 0 ? D[a][c] : 0) + (d >= 0 ? D[b][d] : 0);
      if(removed - added > eps){ reverse(tour, i, k); improved = true; }
    }
  }
  return improved;
}
function twoOptLoop(tour, D, iMin = 0, kMax = tour.length - 1){
  for(let pass = 0; pass < 60 && twoOptPass(tour, D, iMin, kMax); pass++);
  return tour;
}

// One Or-opt pass: try relocating each run of 1–3 consecutive stops to its best
// position (either orientation). A relocation is scored by rebuilding the
// candidate path and comparing total length — simple and obviously correct; the
// pass is O(n²·L) and runs only in the single polish, so it's cheap in practice.
// iMin/jMin=1 pin tour[0]: the lifted segment never contains the anchor
// (i ≥ 1 ⇒ rest[0] === tour[0]) and is never re-inserted ahead of it (j ≥ 1),
// so every candidate keeps the anchor first in either orientation.
// Returns whether anything moved.
function orOptPass(tour, D, iMin = 0, jMin = 0, pinEnd = false){
  const n = tour.length, eps = 1e-6;
  const movableEnd = pinEnd ? n - 1 : n;
  let improved = false;
  for(let L = 1; L <= 3; L++){
    for(let i = iMin; i + L <= movableEnd; i++){
      const seg  = tour.slice(i, i + L);
      const rest = tour.slice(0, i).concat(tour.slice(i + L));
      const base = pathLength(tour, D);
      let bestLen = base, best = null;
      const jMax = pinEnd ? rest.length - 1 : rest.length;
      for(let j = jMin; j <= jMax; j++){
        for(const s of [seg, seg.slice().reverse()]){
          const cand = rest.slice(0, j).concat(s, rest.slice(j));
          const len  = pathLength(cand, D);
          if(len < bestLen - eps){ bestLen = len; best = cand; }
        }
      }
      if(best){ for(let x = 0; x < n; x++) tour[x] = best[x]; improved = true; }
    }
  }
  return improved;
}
// Alternate 2-opt and Or-opt until neither improves (a local optimum for both).
function polish(tour, D, pinned = false, pinEnd = false){
  const iMin = pinned ? 1 : 0;
  const kMax = pinEnd ? tour.length - 2 : tour.length - 1;
  let go = true;
  while(go){
    go = false;
    if(twoOptPass(tour, D, iMin, kMax)) go = true;
    if(orOptPass(tour, D, iMin, iMin, pinEnd)) go = true;
  }
  return tour;
}

function reverse(arr, i, k){
  while(i < k){ const t = arr[i]; arr[i] = arr[k]; arr[k] = t; i++; k--; }
}
function pathLength(tour, D){
  let sum = 0;
  for(let i = 1; i < tour.length; i++) sum += D[tour[i - 1]][tour[i]];
  return sum;
}
// A handful of evenly spread start nodes for the multi-start construction.
function spreadStarts(n, count){
  const starts = [];
  const step = Math.max(1, Math.floor(n / count));
  for(let i = 0; i < n && starts.length < count; i += step) starts.push(i);
  return starts;
}
function range(a, b){ const r = []; for(let i = a; i < b; i++) r.push(i); return r; }

// ── multi-day clustering (target/day, each day ends near home) ───────────────
// The full matrix D is over [home, ...located] (node 0 = home). A day-cluster is
// a set of located-indices; to order it so it ENDS near home we re-solve it as
// its own home-pinned open path over the sub-matrix [home, ...chunk] (same trick
// optimizeRoute uses for the whole route: pin home, read the tour backwards).
function subMatrix(D, nodes){
  const m = nodes.length;
  const S = [];
  for(let i = 0; i < m; i++){
    const row = new Float64Array(m);
    for(let j = 0; j < m; j++) row[j] = D[nodes[i]][nodes[j]];
    S.push(row);
  }
  return S;
}
// Order one day-cluster (an array of located-indices) so it ends at its
// home-ward edge. Returns the cluster's located-indices, re-ordered.
function orderChunkHome(D, locIdxChunk){
  if(locIdxChunk.length <= 1) return locIdxChunk.slice();
  const nodes = [0, ...locIdxChunk.map(k => k + 1)];   // home + each order's D node
  const t = solve(subMatrix(D, nodes), true);          // pinned AT home
  // reverse + drop the home node → sub-positions 1..m, mapped back to the chunk.
  return t.slice().reverse().slice(0, -1).map(p => locIdxChunk[p - 1]);
}

// ── entry point ──────────────────────────────────────────────────────────────
// pendingItems: the pending worklist orders in display order (each mutated in
// place with coords). onProgress({phase, done, total}): optional UI callback.
// home: {lat,lng} of the installer's saved home pin, or null.
// opts.osrmUrl: a self-hosted OSRM base URL (the desktop planner passes its
// local Docker instance) — the matrix primary is then OSRM instead of Google;
// omitted = the phone path (budget-guarded Google matrix). Both paths back up
// through OpenRouteService (config.js ORS_API_KEY) before straight-line, and
// geocoding backs up Google → ORS → park.
// opts.straightLine: skip the road-distance matrix entirely and solve on
// straight-line (haversine) distances — the phone's default Optimize button, so
// a normal tap costs nothing beyond geocoding. Not a fallback (usedFallback
// stays false); the five-tap secret leaves it off to get the real road matrix.
// opts.startFromCurrent: request a fresh phone fix as a one-run route start.
// With home it fixes both ends; without home the route end remains open. A
// missing/denied fix falls back to the legacy anchor and sets startFallback.
// opts.target: meters/day. When > 0 the route is split into day-clusters of that
// size, each re-solved home-pinned so the day ENDS near home (the master route is
// cut into contiguous farthest→nearest chunks; a lone near-home order lands in a
// late day, not an early far one). Returns dayOf {id: dayNumber}. With no home
// pin the split falls back to plain count-chunks (dayFallback:true) since "near
// home" is undefined.
// Returns { orderedIds, parkedIds, usedFallback, fallbackReason, mode,
// startFallback, geoReason, note } — orderedIds is the optimized sequence;
// parkedIds are the ones flagged geoFail (wouldn't geocode) or geoAmbig
// (matched several towns) — they may still carry their last good pin — or
// with no coords at all; usedFallback means the solve ran on straight-line
// distances, and fallbackReason says why ('' otherwise); geoReason is a
// key-level geocoding failure note (bad/over-quota key with no ORS rescue) or
// null; note is a short "…via OpenRouteService backup" string when ORS carried
// geocoding and/or the matrix (else null); mode is 'here-home' (phone start,
// Home end), 'here' (phone start, open end), 'home' (path ends moving toward
// Home), or 'first' (the list's first order stays the start, end open).
export async function optimizeRoute(pendingItems, onProgress, home, opts = {}){
  geoKeyError = null; orsGeoUsed = false; geoFellBack = false;
  // The gate center for address MATCHING: the phone's own position — unless the
  // crew is optimizing far from the route area (planning from home for a
  // distant list), where the list's median gates instead so a far GPS fix
  // can't invalidate every good pin and re-match lookalike streets nearby.
  // The matching gate can differ from the requested phone route anchor.
  onProgress && onProgress({ phase:'locate' });
  const wantsCurrentStart = !!opts.startFromCurrent;
  const gps = await currentPosition(LOCATE_MS, wantsCurrentStart);
  const med = medianCenter(pendingItems);
  let gate = gps || med || home || null;
  if(gps && med && haversine(gps, med) > GEO_RADIUS_KM * 1000) gate = med;

  await geocodeAll(pendingItems, onProgress, gate, opts.geocodeUrl);

  // Post-geocodeAll invariant: every pending item is either located (coords,
  // no flags) or parked with exactly one of geoFail/geoAmbig set (geocodeAll
  // processes every coord-less item and heals stale flags on in-radius ones) —
  // which is what keeps the callers' failed/ambig toast arithmetic exact.
  const located = pendingItems.filter(x => !isParked(x));
  const parkedIds = pendingItems.filter(isParked).map(x => x.id);
  // A Google key rejection only alarms the user when ORS didn't rescue the run;
  // if the backup carried it, that's reassuring `note` territory, not geoReason.
  const geoReason = (geoKeyError && !orsGeoUsed)
    ? geoKeyError + ' — check the Google API key setup (DEPLOY.md)' : null;
  const notes = [];
  if(orsGeoUsed) notes.push('addresses');
  // Local geocoder was set but couldn't cover every address (thin OSM map) — a
  // reassuring note, not an error: Google/ORS quietly caught the rest.
  const geoNote = geoFellBack ? 'some addresses used a fallback geocoder (local missed)' : null;
  const homeC = coordsOf(home);
  const startC = wantsCurrentStart ? gps : null;
  const startFallback = wantsCurrentStart && !startC;
  const mode = startC ? (homeC ? 'here-home' : 'here') : (homeC ? 'home' : 'first');

  // Nothing to reorder — keep the located items in their current order.
  if(located.length < 2)
    return { orderedIds: located.map(x => x.id), parkedIds, usedFallback:false,
      fallbackReason:'', mode, startFallback, geoReason, note: combineNotes(orsNote(notes), geoNote),
      dayOf: located.length ? { [located[0].id]: 1 } : {}, dayFallback:false };

  // Route anchors: an available requested phone fix pins the start and Home,
  // when present, pins the end. Otherwise legacy mode ends toward Home or pins
  // the first display-sorted pending order with an open end.
  const coords = startC
    ? [startC, ...located.map(coordsOf), ...(homeC ? [homeC] : [])]
    : homeC ? [homeC, ...located.map(coordsOf)] : located.map(coordsOf);

  // Matrix source. straightLine (the phone's default Optimize button) solves on
  // straight-line distances up front — no road-matrix/ORS call at all, so no API
  // cost beyond geocoding. Otherwise: primary (OSRM on the planner, else
  // budget-guarded Google) → OpenRouteService backup → straight-line fallback.
  // ORS is only reached when the primary returns nothing; a fallback straight-line
  // solve then means BOTH failed.
  let D, usedFallback = false, fallbackReason = '';
  if(opts.straightLine){
    // Deliberate choice, NOT a degraded fallback: leave usedFallback false so the
    // toast doesn't warn "straight-line (…)".
    D = haversineMatrix(coords);
  } else {
    onProgress && onProgress({ phase:'matrix', done:0, total:0 });
    let res = opts.osrmUrl ? await osrmMatrix(coords, opts.osrmUrl)
                           : await buildMatrix(coords, onProgress);
    if(!res.D && ORS_API_KEY){
      const ors = await orsMatrix(coords);
      if(ors.D){ notes.push('roads'); res = ors; }
      else res = { error: (res.error || 'road data unavailable') + ' · ' + ors.error };
    }
    D = res.D;
    if(!D){
      D = haversineMatrix(coords);
      usedFallback = true;
      fallbackReason = res.error || 'road data unavailable';
    }
  }

  onProgress && onProgress({ phase:'solve' });
  const masterSeq = routeOrderFromMatrix(D, located.length, {
    hasStart:!!startC, hasHome:!!homeC
  });

  // Optional day-split. target > 0 cuts the master route into contiguous chunks
  // of `target`; with a home pin each chunk is re-solved to end near home.
  const target = Math.max(0, Math.floor(Number(opts.target) || 0));
  let orderedSeq = masterSeq;
  const dayOf = {};
  let dayFallback = false;
  if(target > 0){
    if(homeC && !startC){
      orderedSeq = [];
      for(let s = 0; s < masterSeq.length; s += target){
        const day = Math.floor(s / target) + 1;
        const ordered = orderChunkHome(D, masterSeq.slice(s, s + target));
        ordered.forEach(k => { dayOf[located[k].id] = day; });
        orderedSeq.push(...ordered);
      }
    } else {
      // No home pin — keep the master order, just cut it into count-sized days.
      dayFallback = true;
      masterSeq.forEach((k, r) => { dayOf[located[k].id] = Math.floor(r / target) + 1; });
    }
  }

  const orderedIds = orderedSeq.map(k => located[k].id);
  return { orderedIds, parkedIds, usedFallback, fallbackReason, mode, startFallback, geoReason,
    note: combineNotes(orsNote(notes), geoNote), dayOf, dayFallback };
}

// "addresses"/"roads" → the reassuring toast line naming what the ORS backup
// carried this run (null when it didn't engage).
function orsNote(parts){
  return parts.length ? parts.join(' + ') + ' via OpenRouteService backup' : null;
}

// Join the non-null note fragments (ORS backup + local-geocoder fallback) into
// one toast line, or null when there's nothing to say.
function combineNotes(...parts){
  const p = parts.filter(Boolean);
  return p.length ? p.join(' · ') : null;
}
