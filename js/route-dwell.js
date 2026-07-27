// Per-stop ON-SITE (dwell) minutes for the route ETA model — the counterpart to
// js/route.js `travelLookup`. `simulateDay` builds each ETA as
//   arrival = previous departure + drive,   departure = arrival + dwell
// travelLookup answers the drive half; this module answers the dwell half.
//
// Until this existed the dwell half was one flat number for every stop on every
// route: `onSiteMinutes(pace)` = the installer's 30-day log-to-log pace minus a
// HARDCODED ten-minute guess at "the typical drive between stops", which had to be
// subtracted because that pace already bundles the drive the scheduler is about to
// add back for real. Both halves of that are now measurable from data the crew
// already produces (Code.gs `installerOnSiteFit`/`crewSiteDwell`), so the guess is
// only the last resort.
//
// THREE TIERS, most specific first, and every one of them falls through to the tier
// below when its input is missing. A caller that passes nothing but `paceMin` gets
// exactly the old flat number — that is the point, and `tests/route-dwell.test.mjs`
// pins it. Nothing here reads the DOM or the network; it is pure like
// `route-constraints.js` and `route-variants.js`.

import { splitAddress, normalizeStreet, houseNumber } from './roadgraph.js';

export const MIN_ONSITE_MIN = 8;
export const NOMINAL_TRAVEL_MIN = 10;

// The pace-derived fallback. Kept byte-for-byte as it was in route-constraints.js
// (which now re-exports it from here) so a route with no measurements schedules
// identically to before this module landed.
export function onSiteMinutes(paceMin){
  return Math.max(MIN_ONSITE_MIN, (Number(paceMin) || 0) - NOMINAL_TRAVEL_MIN);
}

// A site's identity, stable across a worklist address TYPED by the office and a
// Stops address LOGGED in the field months earlier. Civic number + normalized
// street and deliberately nothing else:
//   - the unit is a separate field, and two meters in one building ARE one site —
//     that sameness is exactly what the repeat-meter tier below is for;
//   - it must NOT be keyed on coordinates. A Stops pin is a GPS fix taken on the
//     phone and jitters tens of metres between visits to the same property, while
//     a worklist pin is geocoder output. Only the address text is stable across
//     both, which is why the crew-wide site history is address-keyed too.
// Built from roadgraph.js's normalizers rather than a second copy, so a suffix
// this recognizes is a suffix the offline address index recognizes.
//
// THE LOCALITY TAIL IS DROPPED, and that is load-bearing rather than tidying. A
// logged Stops address is usually a full geocoder string — "10 Island 19c, Carling,
// ON P0G 1G0, Canada" — while a worklist order carries what the office typed, "10
// Island 19c". 396 of 457 logged stops look like the former, so keeping the tail
// meant the two sides could never agree on a key and this would have silently never
// matched once.
//
// Take the first comma-segment that STARTS WITH A CIVIC NUMBER, not simply the
// first one. Some logged addresses are label-prefixed — "Town of, 14 Maple Heights
// Dr, Huntsville, …" — and blindly taking segment zero collapsed 34 distinct
// Huntsville houses onto the single key "town of", which is worse than not matching
// at all: it invents a busy site out of unrelated stops.
export function siteKey(address){
  const parts = String(address == null ? '' : address).split(',');
  const head = parts.find(p => /^\s*\d/.test(p)) || parts[0];
  const { num, street } = splitAddress(head);
  const road = normalizeStreet(street);
  if(!road) return '';
  const n = houseNumber(num);
  return n ? `${n} ${road}` : road;
}

// A site factor is a ratio against the crew median, so it is already unitless and
// already filtered spine-side to sites with repeat visits. Clamped anyway: this is
// the one input derived from as few as two historical stops, and an unclamped
// outlier would move a whole day's ETAs.
export const SITE_FACTOR_MIN = 0.4;
export const SITE_FACTOR_MAX = 2.5;

// opts:
//   paceMin        the installer's pace — the fallback basis, always supplied
//   onSiteMin      MEASURED on-site minutes (InstallerMetrics), when we have them
//   extraMeterMin  MEASURED minutes for a 2nd/3rd meter at an address already
//                  parked at — deliberately NOT floored at MIN_ONSITE_MIN, because
//                  the real number is genuinely small (the logs show consecutive
//                  meters at one site a minute apart)
//   siteFactors    { siteKey: ratio-vs-crew-median } for sites with a track record
export function dwellLookup(opts = {}){
  const paceMin = Number(opts.paceMin) || 0;
  const measured = Number(opts.onSiteMin);
  const base = (isFinite(measured) && measured > 0) ? measured : onSiteMinutes(paceMin);
  const rawExtra = Number(opts.extraMeterMin);
  // Capped at `base`: a "quick second meter" that scores slower than a fresh site
  // is a bad fit, not a discovery.
  const extra = (isFinite(rawExtra) && rawExtra > 0) ? Math.min(rawExtra, base) : null;
  const factors = opts.siteFactors || null;

  // `prevItem` is the stop scheduled immediately before this one ON THE SAME DAY.
  // Both arguments can be undefined: simulateDay pads short days with `__free_k`
  // placeholder ids that have no item behind them, and those must price at `base`
  // rather than throw or silently cost nothing.
  function forItem(item, prevItem){
    if(!item) return base;
    const key = siteKey(item.address);
    if(extra != null && prevItem && key && key === siteKey(prevItem.address)) return extra;
    const raw = (factors && key) ? Number(factors[key]) : NaN;
    if(!(isFinite(raw) && raw > 0)) return base;
    const factor = Math.min(SITE_FACTOR_MAX, Math.max(SITE_FACTOR_MIN, raw));
    return Math.max(MIN_ONSITE_MIN, base * factor);
  }

  // The route's mean dwell — a single per-stop average for callers that want one
  // number rather than a per-day simulation (the day-landing projection). Walks the
  // list in order so repeat-meter clusters are priced the way the schedule will
  // price them. It once fed `timeCapacity`, which sized days from a finish-by clock;
  // that is gone and the meters/day target alone decides how many stops a day holds.
  function average(items){
    const list = (items || []).filter(Boolean);
    if(!list.length) return base;
    let sum = 0;
    list.forEach((x, i) => { sum += forItem(x, i ? list[i - 1] : null); });
    return sum / list.length;
  }

  return { base, forItem, average };
}
