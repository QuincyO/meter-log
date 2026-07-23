// Desktop planner provider health and last-run helpers. This module is kept
// browser-safe and free of UI/storage side effects so the planner can decide
// when to probe and persist its own selected record.

export const DEFAULT_OSRM_URL = 'http://localhost:5000';
export const DEFAULT_NOMINATIM_URL = 'http://localhost:8080';
export const PROVIDER_TIMEOUT_MS = 4000;

const trimBase = url => String(url || '').replace(/\/+$/, '');
const offline = (provider, reason) => ({ provider, online:false, reason });

async function probe(provider, url, accepts, {
  fetch: fetchImpl=globalThis.fetch,
  timeoutMs=PROVIDER_TIMEOUT_MS,
  setTimeout: setTimer=globalThis.setTimeout,
  clearTimeout: clearTimer=globalThis.clearTimeout,
}={}){
  if(typeof fetchImpl !== 'function') return offline(provider, 'fetch unavailable');
  let timerId;
  const timeout = new Promise(resolve => {
    timerId = setTimer(() => resolve({ timeout:true }), timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => fetchImpl(url))
        .then(async response => ({ response, data:await response.json().catch(() => null) }))
        .catch(() => ({ error:true })),
      timeout,
    ]);
    if(result.timeout) return offline(provider, 'timeout');
    if(result.error) return offline(provider, 'network error');
    return result.response.ok && accepts(result.data)
      ? { provider, online:true, reason:'' }
      : offline(provider, 'bad response');
  } finally {
    if(timerId != null && typeof clearTimer === 'function') clearTimer(timerId);
  }
}

export function probeOsrm({ url=DEFAULT_OSRM_URL, ...deps }={}){
  const endpoint = `${trimBase(url)}/table/v1/driving/-79.38,43.65;-79.37,43.66?annotations=distance`;
  return probe('osrm', endpoint, data => !!(data && data.code === 'Ok' && Array.isArray(data.distances)), deps);
}

export function probeNominatim({ url=DEFAULT_NOMINATIM_URL, ...deps }={}){
  return probe('nominatim', `${trimBase(url)}/status?format=json`, data => !!(data && data.status === 0), deps);
}

// Cached pins are already valid planner data, regardless of the local service
// health. Only fresh address lookups move local-first after a successful probe.
export function selectGeocodingProviders({ nominatimOnline=false }={}){
  return { providers:nominatimOnline ? ['nominatim', 'google', 'ors'] : ['google', 'ors'], cached:'retain' };
}

// A desktop run must never turn a failed local OSRM probe into billable Google
// Routes traffic. Its only fallbacks are the free ORS tier and straight-line.
export function selectDesktopRoutingProviders({ osrmOnline=false }={}){
  return osrmOnline ? ['osrm', 'ors', 'haversine'] : ['ors', 'haversine'];
}

const counts = value => ({ attempted:Number(value && value.attempted) || 0, resolved:Number(value && value.resolved) || 0 });

// This is deliberately a pure, JSON-safe projection. Callers may store it in
// localStorage/IndexedDB later, but URLs, API keys, and arbitrary run options
// never enter the record.
export function createLastRunRecord({ at='', provenance={} }={}){
  const geo = provenance.geocoding || {};
  const route = provenance.routing || {};
  return {
    at:String(at || ''),
    geocoding:{
      cached:Number(geo.cached) || 0,
      nominatim:counts(geo.nominatim), google:counts(geo.google), ors:counts(geo.ors),
      parked:Number(geo.parked) || 0,
    },
    routing:{
      method:route.method === 'matrix' ? 'matrix' : 'straight-line',
      provider:['osrm', 'google-routes', 'ors', 'haversine'].includes(route.provider)
        ? route.provider : 'haversine',
      fallbackReason:String(route.fallbackReason || ''),
    },
  };
}

export function formatLastRunSummary(record){
  const r = record && record.geocoding && record.routing
    ? createLastRunRecord({ at:record.at, provenance:{ geocoding:record.geocoding, routing:record.routing } })
    : createLastRunRecord(record);
  const g = r.geocoding, route = r.routing;
  const name = { nominatim:'Nominatim', google:'Google', ors:'ORS', osrm:'OSRM', 'google-routes':'Google Routes', haversine:'Haversine' };
  return `Geocoding: ${g.cached} cached; Nominatim ${g.nominatim.resolved}/${g.nominatim.attempted}; Google ${g.google.resolved}/${g.google.attempted}; ORS ${g.ors.resolved}/${g.ors.attempted}; ${g.parked} parked. Routing: ${route.method} via ${name[route.provider]}${route.fallbackReason ? ` (${route.fallbackReason})` : ''}.`;
}
