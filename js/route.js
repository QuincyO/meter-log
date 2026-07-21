// ── Route optimization (land mode) ───────────────────────────────────────────
// Turns a worklist of pending orders into the most efficient open driving path.
// One entry point, optimizeRoute(), runs the whole pipeline ON THE PHONE:
//
//   1. geocode every order's text address → coords (OpenRouteService / Pelias),
//      focused AND hard-bounded to GEO_RADIUS_KM around the crew (wrong-town
//      matches park instead), revalidating previously stored pins against the
//      same circle so old bad coords self-heal; results cached ON the order;
//   2. pull a road-distance matrix from ORS (chunked for big lists), falling back
//      to straight-line (haversine) distances only if the matrix call fails;
//   3. solve the open-path TSP locally (nearest-neighbour + 2-opt + Or-opt),
//      pinned so the day either ends moving toward the installer's home pin or
//      starts at the list's first order — milliseconds even for ~200 stops; the
//      network time above dominates 1000×.
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
const GEO_RADIUS_KM = 80;    // only match addresses this close to the crew — a
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

// One coarse position fix for the geocode gate (NOT the route anchor — that's
// the home pin / first order). Never rejects: no GPS, a denied prompt, or an
// unanswered permission dialog all resolve null. The extra hard race matters
// because geolocation's own timeout doesn't tick while its permission prompt
// is open — optimize must degrade, not hang.
function currentPosition(maxMs){
  if(!('geolocation' in navigator)) return Promise.resolve(null);
  const fix = new Promise(res => navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => res(null),
    { enableHighAccuracy:false, timeout:maxMs, maximumAge:120000 }));
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
// The one place [lat,lng] → GeoJSON [lng,lat] happens.
const toLngLat = c => [c.lng, c.lat];

// ── forward geocoding ────────────────────────────────────────────────────────
// Fill lat/lng on every pending order that lacks them — and REVALIDATE the ones
// that have them: a stored pin farther than GEO_RADIUS_KM from the gate center
// is stale (the wrong-town matches this circle exists to prevent), so its
// coords are cleared and the address re-geocoded inside the circle. Each result
// (or the geoFail/geoAmbig flag) is persisted to IndexedDB immediately — that
// persisted copy IS the cache, so a cancelled or retried run only re-hits the
// addresses still unresolved, and in-radius items cost zero network. An
// ambiguous match (same address in several places) deliberately gets NO coords
// — the route must not silently pick a town; the card shows the choices instead
// (worklist.js). The ", ON, Canada" text bias stays: the crew ranges
// province-wide, and the circle (not the text) is what pins the region.
async function geocodeAll(items, onProgress, center){
  let done = 0;
  for(const item of items){
    const c = coordsOf(item);
    const stale = !!(c && center && haversine(c, center) > GEO_RADIUS_KM * 1000);
    if(!c || stale){
      if(stale){ item.lat = undefined; item.lng = undefined; }
      const hit = await geocodeOne(item.address, center);
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
// With a center the search is focused AND hard-bounded to GEO_RADIUS_KM around
// it (Pelias boundary.circle, radius in km); the local haversine check is the
// belt — a boundary-param regression can only park an order, never keep a
// far-away wrong pin. Exported: capture.js pins the Settings home address and
// worklist.js retries it with this same call.
export async function geocodeOne(address, center){
  const text = String(address || '').trim();
  if(!text) return null;
  let url = `${ORS}/geocode/search?api_key=${encodeURIComponent(ORS_API_KEY)}`
    + `&text=${encodeURIComponent(text + ', ON, Canada')}`
    + `&boundary.country=CA&size=3`;
  if(center){
    url += `&focus.point.lat=${center.lat}&focus.point.lon=${center.lng}`
      + `&boundary.circle.lat=${center.lat}&boundary.circle.lon=${center.lng}`
      + `&boundary.circle.radius=${GEO_RADIUS_KM}`;
  }
  try {
    const res = await fetch(url);
    if(!res.ok) return null;
    const data = await res.json();
    const hits = ((data && data.features) || []).map(f => {
      if(!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) return null;
      const conf = f.properties && f.properties.confidence;
      if(conf != null && conf < MIN_CONF) return null;
      const [lng, lat] = f.geometry.coordinates;   // GeoJSON order
      if(!isFinite(lat) || !isFinite(lng)) return null;
      if(center && haversine({ lat, lng }, center) > GEO_RADIUS_KM * 1000) return null;
      const p = f.properties || {};
      return { lat, lng, label: p.label || text, place: (p.locality || p.county || '').toLowerCase() };
    }).filter(Boolean);
    if(!hits.length) return null;
    const best = hits[0];
    // Ambiguity: the same address in distinct places (different locality AND
    // > AMBIG_KM apart — same-town rivals like an address point vs its street
    // centroid don't count). Surfaced, never auto-picked.
    const rivals = hits.filter(hh =>
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
  const S = symmetrize(D);
  if(pinned) return polish(twoOptLoop(nearestNeighbour(S, 0), S, 1), S, true);
  const starts = spreadStarts(n, Math.min(12, n));
  let best = null, bestLen = Infinity;
  for(const s of starts){
    const tour = twoOptLoop(nearestNeighbour(S, s), S);
    const len = pathLength(tour, S);
    if(len < bestLen){ bestLen = len; best = tour; }
  }
  return polish(best, S);
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
function twoOptPass(tour, D, iMin = 0){
  const n = tour.length, eps = 1e-6;
  let improved = false;
  for(let i = iMin; i < n - 1; i++){
    const a = i > 0 ? tour[i - 1] : -1;
    for(let k = i + 1; k < n; k++){
      const b = tour[i], c = tour[k], d = k < n - 1 ? tour[k + 1] : -1;
      const removed = (a >= 0 ? D[a][b] : 0) + (d >= 0 ? D[c][d] : 0);
      const added   = (a >= 0 ? D[a][c] : 0) + (d >= 0 ? D[b][d] : 0);
      if(removed - added > eps){ reverse(tour, i, k); improved = true; }
    }
  }
  return improved;
}
function twoOptLoop(tour, D, iMin = 0){
  for(let pass = 0; pass < 60 && twoOptPass(tour, D, iMin); pass++);
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
function orOptPass(tour, D, iMin = 0, jMin = 0){
  const n = tour.length, eps = 1e-6;
  let improved = false;
  for(let L = 1; L <= 3; L++){
    for(let i = iMin; i + L <= n; i++){
      const seg  = tour.slice(i, i + L);
      const rest = tour.slice(0, i).concat(tour.slice(i + L));
      const base = pathLength(tour, D);
      let bestLen = base, best = null;
      for(let j = jMin; j <= rest.length; j++){
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
function polish(tour, D, pinned = false){
  const iMin = pinned ? 1 : 0;
  let go = true;
  while(go){ go = false; if(twoOptPass(tour, D, iMin)) go = true; if(orOptPass(tour, D, iMin, iMin)) go = true; }
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
// pendingItems: the pending worklist orders in display order (each mutated in
// place with coords). onProgress({phase, done, total}): optional UI callback.
// home: {lat,lng} of the installer's saved home pin, or null.
// Returns { orderedIds, parkedIds, usedFallback, mode } — orderedIds is the
// optimized sequence of located orders; parkedIds are the ones that wouldn't
// geocode (geoFail) or matched several towns (geoAmbig); mode is 'home' (path
// ends moving toward home — the start naturally lands at the far side of the
// day's cluster, "furthest away, working back") or 'first' (no home pin: the
// list's first order stays the start, end open).
export async function optimizeRoute(pendingItems, onProgress, home){
  // The gate center for address MATCHING: the phone's own position — unless the
  // crew is optimizing far from the route area (planning from home for a
  // distant list), where the list's median gates instead so a far GPS fix
  // can't invalidate every good pin and re-match lookalike streets nearby.
  // Matching gate ≠ route anchor: the route is anchored on home / first order.
  onProgress && onProgress({ phase:'locate' });
  const gps = await currentPosition(LOCATE_MS);
  const med = medianCenter(pendingItems);
  let gate = gps || med || home || null;
  if(gps && med && haversine(gps, med) > GEO_RADIUS_KM * 1000) gate = med;

  await geocodeAll(pendingItems, onProgress, gate);

  const located = pendingItems.filter(coordsOf);
  const parkedIds = pendingItems.filter(x => !coordsOf(x)).map(x => x.id);

  // Nothing to reorder — keep the located items in their current order.
  if(located.length < 2)
    return { orderedIds: located.map(x => x.id), parkedIds, usedFallback:false, mode:'first' };

  // Route anchor: with a home pin the solve is pinned AT home and the tour is
  // read backwards — on the symmetrized matrix that IS the pinned-END path, so
  // the day finishes moving toward home. Without one, the first located pending
  // order (located[0] — pendingItems arrive display-sorted) is pinned as the
  // start and the end floats free.
  const homeC = coordsOf(home);
  const mode = homeC ? 'home' : 'first';
  const coords = homeC ? [homeC, ...located.map(coordsOf)] : located.map(coordsOf);

  onProgress && onProgress({ phase:'matrix', done:0, total:0 });
  let D = await buildMatrix(coords, onProgress);
  let usedFallback = false;
  if(!D){ D = haversineMatrix(coords); usedFallback = true; }

  onProgress && onProgress({ phase:'solve' });
  const tour = solve(D, true);
  const orderedIds = homeC
    ? tour.slice().reverse().slice(0, -1).map(i => located[i - 1].id)  // home node (0) dropped off the end
    : tour.map(i => located[i].id);
  return { orderedIds, parkedIds, usedFallback, mode };
}
