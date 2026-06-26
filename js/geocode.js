// ── Offline-capable reverse geocoding ───────────────────────────────────────
// True fully-offline geocoding needs bundled map data (impractical), so this is
// a cache + backfill design:
//   • Every resolved coord→address is cached in IndexedDB ('addrCache'), keyed
//     by the coordinate rounded to ~11 m. A crew works the same islands daily,
//     so after the first online visit a spot resolves INSTANTLY and OFFLINE.
//   • Brand-new coords with no signal resolve to null — the stop still stores
//     its GPS, and backfillAddresses() fills the address in once back online.
import { idb } from './idb.js';
import { cfg } from './store.js';
import { apiGet } from './api.js';
import { stamp, localDateOffset } from './time.js';

// ~11 m resolution — enough to share a cache entry across one meter location.
const keyOf = (lat, lng) => `${(+lat).toFixed(4)},${(+lng).toFixed(4)}`;
const valid = (lat, lng) => lat != null && lng != null && !isNaN(+lat) && !isNaN(+lng);

export async function cacheAddress(lat, lng, address){
  if(!valid(lat, lng) || !address) return;
  await idb.put('addrCache', { address, ts: stamp() }, keyOf(lat, lng));
}

// Resolve a coordinate to an address.
//   cache hit + !force → return it instantly (no network; works offline)
//   else online        → spine geocode, cache the result, return it
//   else               → cached value if any, otherwise null
// Returns a string or null; never throws.
export async function resolveAddress(lat, lng, opts = {}){
  if(!valid(lat, lng)) return null;
  const key = keyOf(lat, lng);
  const hit = await idb.get('addrCache', key);
  if(hit && hit.address && !opts.force) return hit.address;
  if(navigator.onLine){
    try{
      const d = await apiGet('geocode', { lat, lng });
      if(d && d.ok && d.address){ await cacheAddress(lat, lng, d.address); return d.address; }
    } catch {}
  }
  return hit && hit.address ? hit.address : null;
}

// After reconnecting, fill in addresses for stops captured offline (coords but
// no address) across the cached days. Each fix is an updateStop through the
// offline queue (so it's itself resilient) plus a cache patch. Capped per run to
// avoid a burst; remaining stops are picked up on the next online tick.
export async function backfillAddresses(enqueue, days = 7, cap = 12){
  const c = cfg(); if(!c.name || !navigator.onLine) return;
  let done = 0;
  for(let i=0;i<days && done<cap;i++){
    const key = `${c.name}|${localDateOffset(-i)}`;
    const cached = await idb.get('dayCache', key);
    if(!cached || !Array.isArray(cached.stops)) continue;
    let changed = false;
    for(const s of cached.stops){
      if(done>=cap) break;
      const hasAddr = String(s.address||'').trim();
      if(hasAddr || !valid(s.lat, s.lng) || !s.id) continue;
      const addr = await resolveAddress(s.lat, s.lng);
      if(!addr) continue;
      s.address = addr; changed = true; done++;
      // Persist to the Sheet (address-only correction), idempotent via the stop id.
      enqueue({ token:c.token, action:'updateStop', id:s.id, address:addr });
    }
    if(changed) await idb.put('dayCache', cached, key);
  }
}
