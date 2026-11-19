// ── The audit's road distances ───────────────────────────────────────────────
// When this device holds an offline road map (the log page's Settings ▸ Offline
// road map), the audit measures the distance between two orders by road instead of
// in a straight line, and draws the route along the roads. This file is the only
// place the audit touches that map: it hands js/audit-view.js a small object,
//   { name, km(a, b), path(a, b) }
// and the view passes `km` on to compute/audit.js, which stays pure.
//
// Easy to get wrong:
//   • The map lives in THIS browser's IndexedDB. A phone that downloaded a district
//     has it; an office PC usually does not. So the same day can be measured by road
//     on one device and by straight line on another, and the page has to say which
//     it did (prep.distance, worded in js/audit-render.js). Never hide that.
//   • Nothing here may fetch the pack. It is tens of megabytes; downloading it is the
//     person's choice, made on the log page. No pack means null, and straight lines.
//   • roadpack.js and roadgraph.js are in the service worker's shell while this file
//     is not, so an older copy of either can sit beside a new copy of this. They are
//     imported at call time and checked before use, and any failure is "no road map".
//   • `switchActive: false`: reading the audit must not re-point the crew's district.
//   • The answer is the SHORTEST drive on the map, not the drive that was taken.

/** {lat, lng} for every stop with a usable pin. */
function pinsOf(stops){
  const out = [];
  for(const s of stops || []){
    if(!s || s.lat === '' || s.lat == null || s.lng === '' || s.lng == null) continue;
    const lat = Number(s.lat), lng = Number(s.lng);
    if(isFinite(lat) && isFinite(lng) && (lat || lng)) out.push({ lat, lng });
  }
  return out;
}

/** The road map as the audit uses it, over an already-decoded graph. `rg` is
 *  js/roadgraph.js (or a stand-in with matrixRow and path). Both answers are
 *  remembered: the period and every day ask about the same pairs. */
export function roadsFrom(graph, rg, name){
  const kms = new Map(), paths = new Map();
  const key = (a, b) => a.lat + ',' + a.lng + '|' + b.lat + ',' + b.lng;
  const at = p => ({ lat: Number(p.lat), lng: Number(p.lng) });
  return {
    name: String(name || 'offline road map'),
    /** Kilometres to drive from a to b, or null where the map cannot say. */
    km(a, b){
      const k = key(a, b);
      if(!kms.has(k)){
        let v = null;
        try {
          const row = rg.matrixRow(graph, at(a), [at(b)]);
          const m = row && row.D ? row.D[0] : null;
          if(typeof m === 'number' && isFinite(m) && m >= 0) v = m / 1000;
        } catch { v = null; }
        kms.set(k, v);
      }
      return kms.get(k);
    },
    /** The drive from a to b as [[lat, lng], …]; empty where the map cannot say. */
    path(a, b){
      const k = key(a, b);
      if(!paths.has(k)){
        let pts = [];
        try { const got = rg.path(graph, at(a), at(b)); if(Array.isArray(got)) pts = got; } catch { pts = []; }
        paths.set(k, pts);
      }
      return paths.get(k);
    },
  };
}

/** The road map covering these stops, or null: none on this device, none that
 *  covers them, an unreadable one, or a browser without IndexedDB. Never throws. */
export async function loadAuditRoads(stops){
  try {
    const coords = pinsOf(stops);
    if(!coords.length) return null;
    const [pack, rg, districts] = await Promise.all([import('./roadpack.js'), import('./roadgraph.js'), import('./districts.js')]);
    if(typeof pack.loadGraph !== 'function' || typeof rg.matrixRow !== 'function' || typeof rg.path !== 'function') return null;
    const graph = await pack.loadGraph(coords, { switchActive: false });
    if(!graph) return null;
    let name = '';
    try {
      const installed = await pack.installedPacks();
      const id = typeof districts.pickPack === 'function' ? districts.pickPack(installed, coords, pack.activePackId()) : '';
      const row = installed.find(p => p.id === id) || installed[0];
      name = row ? (row.name || row.id) : '';
    } catch { name = ''; }
    return roadsFrom(graph, rg, name);
  } catch {
    return null;
  }
}
