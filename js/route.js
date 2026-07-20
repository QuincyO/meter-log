// ── Route optimization (land mode) ───────────────────────────────────────────
// Turns a worklist of pending orders into the most efficient open driving path.
// One entry point, optimizeRoute(), runs the whole pipeline ON THE PHONE:
//
//   1. geocode every order's text address → coords (OpenRouteService / Pelias),
//      caching the coords ON the order object so it's a one-time cost;
//   2. pull a road-distance matrix from ORS (chunked for big lists), falling back
//      to straight-line (haversine) distances only if the matrix call fails;
//   3. solve the open-path TSP locally (multi-start nearest-neighbour + 2-opt) —
//      milliseconds even for ~200 stops; the network time above dominates 1000×.
//
// ORS is hit with bare fetch() — NEVER apiGet/apiPost, which inject the Apps
// Script token + URL. This module deliberately does not import api.js: the
// Google backend is not in this path (see CLAUDE.md — the whole point is to keep
// the heavy work off the Apps Script cloud).
//
// GOTCHA: ORS speaks GeoJSON, so coordinates are [lng, lat] — the reverse of the
// [lat, lng] we store. All conversion goes through toLngLat()/one place so a swap
// can't silently produce a garbage route.
import { ORS_API_KEY } from './config.js';
import { idb } from './idb.js';
import { stamp } from './time.js';

const ORS = 'https://api.openrouteservice.org';

// Free-tier guardrails. The matrix endpoint caps at ~50 locations/call, so we
// tile an N×N matrix from blocks of BLOCK points (sources + destinations of two
// blocks together stay ≤ 2·BLOCK ≤ MAX_LOCS). The throttles keep us under the
// per-minute rate limits (geocode ~100/min, matrix ~40/min) so the key doesn't
// start returning HTTP 429 partway through a 189-address run.
const MAX_LOCS      = 50;
const BLOCK         = 25;
const GEOCODE_MS    = 650;
const MATRIX_MS     = 1600;
const MIN_CONF      = 0.3;   // Pelias confidence below this → treat as no match

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A worklist item counts as "located" only with two real numbers for coords.
function coordsOf(item){
  const lat = Number(item && item.lat), lng = Number(item && item.lng);
  return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
}
// The one place [lat,lng] → GeoJSON [lng,lat] happens.
const toLngLat = c => [c.lng, c.lat];

// ── forward geocoding ────────────────────────────────────────────────────────
// Fill lat/lng on every pending order that lacks them, persisting each success
// to IndexedDB immediately — that persisted copy IS the cache, so a cancelled or
// retried run only re-hits the addresses still missing coords. The ", ON, Canada"
// bias mirrors directionsUrl() in worklist.js (the crew ranges province-wide, so
// no city bias — just keep terse street/landmark names resolving in-province).
async function geocodeAll(items, onProgress){
  let done = 0;
  for(const item of items){
    if(!coordsOf(item)){
      const hit = await geocodeOne(item.address);
      if(hit){
        item.lat = hit.lat; item.lng = hit.lng; item.geoFail = false;
      } else {
        item.geoFail = true;
      }
      // Persist coords (or the fail flag) back onto the stored order.
      const stored = (await idb.get('worklist', item.id)) || item;
      await idb.put('worklist', Object.assign({}, stored, {
        lat: item.lat, lng: item.lng, geoFail: item.geoFail, updatedAt: stamp() }));
      await sleep(GEOCODE_MS);
    }
    onProgress && onProgress({ phase:'geocode', done: ++done, total: items.length });
  }
}

// One address → {lat,lng} or null. Never throws — a network/parse failure is
// just a miss, and the caller parks the order for manual fixing.
async function geocodeOne(address){
  const text = String(address || '').trim();
  if(!text) return null;
  const url = `${ORS}/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}`
    + `&text=${encodeURIComponent(text + ', ON, Canada')}`
    + `&boundary.country=CA&size=1`;
  try {
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const f = data && data.features && data.features[0];
    if(!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
    const conf = f.properties && f.properties.confidence;
    if(conf != null && conf < MIN_CONF) return null;
    const [lng, lat] = f.geometry.coordinates;   // GeoJSON order
    return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
  } catch { return null; }
}

// ── road-distance matrix (chunked) ───────────────────────────────────────────
// Returns an N×N array of driving distances in metres, or null if any chunk
// fails after a retry (caller then uses the haversine fallback). Distance is
// asymmetric on a road network (one-way streets); we symmetrize at solve time so
// the 2-opt segment-reversal math stays valid — the asymmetry is minor here.
async function buildMatrix(coords, onProgress){
  const n = coords.length;
  const D = Array.from({ length: n }, () => new Float64Array(n));
  const blocks = [];
  for(let s = 0; s < n; s += BLOCK) blocks.push([s, Math.min(s + BLOCK, n)]);
  const totalCalls = blocks.length * blocks.length;
  let done = 0;
  for(const [si, se] of blocks){
    for(const [di, de] of blocks){
      const sameBlock = si === di;
      const locs = sameBlock
        ? coords.slice(si, se)
        : coords.slice(si, se).concat(coords.slice(di, de));
      const srcCount = se - si;
      const sources      = range(0, srcCount);
      const destinations = sameBlock ? range(0, srcCount)
                                     : range(srcCount, srcCount + (de - di));
      const block = await matrixCall(locs, sources, destinations);
      if(!block) return null;                         // abort → haversine fallback
      for(let r = 0; r < block.length; r++)
        for(let c = 0; c < block[r].length; c++)
          D[si + r][di + c] = block[r][c] == null ? Infinity : block[r][c];
      onProgress && onProgress({ phase:'matrix', done: ++done, total: totalCalls });
      await sleep(MATRIX_MS);
    }
  }
  for(let i = 0; i < n; i++) D[i][i] = 0;
  return D;
}

// One matrix chunk, with a single retry. Returns the distances sub-block (rows =
// sources, cols = destinations) or null.
async function matrixCall(locs, sources, destinations){
  const body = JSON.stringify({
    locations: locs.map(toLngLat), metrics:['distance'], units:'m', sources, destinations });
  for(let attempt = 0; attempt < 2; attempt++){
    try {
      const res = await fetch(`${ORS}/v2/matrix/driving-car`, {
        method:'POST',
        headers:{ 'Authorization': ORS_API_KEY, 'Content-Type':'application/json' },
        body });
      if(res.ok){
        const data = await res.json();
        if(data && Array.isArray(data.distances)) return data.distances;
      }
    } catch { /* fall through to retry / null */ }
    if(attempt === 0) await sleep(MATRIX_MS);
  }
  return null;
}

// Straight-line fallback matrix (metres). Symmetric by construction.
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

// ── open-path TSP solve (multi-start nearest-neighbour + 2-opt) ──────────────
// D is symmetrized first so a 2-opt segment reversal only changes its two
// boundary edges (interior edge costs are direction-independent), which is what
// makes the O(1) delta below exact. Endpoints float free (open path), so the
// boundary term is simply dropped at the ends of the tour.
function solve(D){
  const n = D.length;
  if(n <= 2) return range(0, n);
  const S = symmetrize(D);
  const starts = spreadStarts(n, 6);
  let best = null, bestLen = Infinity;
  for(const s of starts){
    const tour = twoOpt(nearestNeighbour(S, s), S);
    const len = pathLength(tour, S);
    if(len < bestLen){ bestLen = len; best = tour; }
  }
  return best;
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

function nearestNeighbour(D, start){
  const n = D.length;
  const seen = new Uint8Array(n);
  const tour = [start]; seen[start] = 1;
  let cur = start;
  for(let step = 1; step < n; step++){
    let next = -1, dist = Infinity;
    for(let j = 0; j < n; j++)
      if(!seen[j] && D[cur][j] < dist){ dist = D[cur][j]; next = j; }
    if(next === -1) break;
    seen[next] = 1; tour.push(next); cur = next;
  }
  return tour;
}

function twoOpt(tour, D){
  const n = tour.length, eps = 1e-6, maxPasses = 60;
  for(let pass = 0; pass < maxPasses; pass++){
    let improved = false;
    for(let i = 0; i < n - 1; i++){
      const a = i > 0 ? tour[i - 1] : -1;
      for(let k = i + 1; k < n; k++){
        const b = tour[i], c = tour[k], d = k < n - 1 ? tour[k + 1] : -1;
        const removed = (a >= 0 ? D[a][b] : 0) + (d >= 0 ? D[c][d] : 0);
        const added   = (a >= 0 ? D[a][c] : 0) + (d >= 0 ? D[b][d] : 0);
        if(removed - added > eps){ reverse(tour, i, k); improved = true; }
      }
    }
    if(!improved) break;
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

// ── entry point ──────────────────────────────────────────────────────────────
// pendingItems: the pending worklist orders (each mutated in place with coords).
// onProgress({phase, done, total}): optional UI callback.
// Returns { orderedIds, parkedIds, usedFallback } — orderedIds is the optimized
// sequence of located orders; parkedIds are the ones that wouldn't geocode.
export async function optimizeRoute(pendingItems, onProgress){
  await geocodeAll(pendingItems, onProgress);

  const located = pendingItems.filter(coordsOf);
  const parkedIds = pendingItems.filter(x => !coordsOf(x)).map(x => x.id);

  // Nothing to reorder — keep the located items in their current order.
  if(located.length < 2)
    return { orderedIds: located.map(x => x.id), parkedIds, usedFallback:false };

  const coords = located.map(coordsOf);
  onProgress && onProgress({ phase:'matrix', done:0, total:0 });
  let D = await buildMatrix(coords, onProgress);
  let usedFallback = false;
  if(!D){ D = haversineMatrix(coords); usedFallback = true; }

  onProgress && onProgress({ phase:'solve' });
  const tour = solve(D);
  const orderedIds = tour.map(i => located[i].id);
  return { orderedIds, parkedIds, usedFallback };
}
