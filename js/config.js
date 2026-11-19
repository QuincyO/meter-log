// ── Frontend config — the single source of truth for the web app ────────────
// Paste your deployed Web App /exec URL here once. SHARED_TOKEN must match
// Code.gs. This module is imported by every page, so the URL + token live in
// ONE place on the frontend (Code.gs keeps its own copy — two places total,
// down from the previous five). After this, the only thing each person sets is
// their name.
export const WEB_APP_URL  = 'https://script.google.com/macros/s/AKfycbwlqHwVha6ztYRXHfy9peYHOvwQPnYhHnqqZTQZGvpwctkWOPNADwLxTsCoir47Kkff/exec';
export const SHARED_TOKEN = 'Bko1PP6sPFJMabph7ZF7TtZDLFqXuFOr';

// Google Maps Platform API key (land-mode route optimization — js/route.js:
// forward geocoding + the Routes API road-distance matrix; nothing else).
// Create it per DEPLOY.md §"Google Maps Platform key": NO application
// restriction (the Geocoding web service rejects referrer-restricted keys
// outright — see DEPLOY.md), API-restricted to the Geocoding + Routes APIs,
// geocoding quota-capped at 300 requests/day, and the matrix guarded by the
// per-device element budget in js/route.js — so it can't bill past the free
// tiers. Same documented tradeoff as SHARED_TOKEN: it sits in client source
// on a public-capable GitHub Pages site, mitigated by keeping the repo
// private + the quota caps above.
export const GMAPS_API_KEY = 'AIzaSyCwS3fECtqyJnoIL2ZbSMVRRHzdQst8ei0';

// OpenRouteService API token — the free, hosted BACKUP for both land-mode
// lookups in js/route.js: forward geocoding (when Google is rejected or misses)
// and the road-distance matrix (when Google Routes / the local OSRM is down).
// Never the primary — the optimizer only falls to ORS when the primary returns
// nothing, then to straight-line. Free key from openrouteservice.org (see
// DEPLOY.md §"OpenRouteService backup"); leave '' to disable the fallback
// entirely. Same public-client-key tradeoff as GMAPS_API_KEY above.
export const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImYxNDdkYzE3ZmFjYzQ5Yzk5ZGVhNjI1OTA4ZjUzZTc3IiwiaCI6Im11cm11cjY0In0=';

// When the crew leaves the start location each morning ('HH:MM', 24h). It no longer
// schedules anything: the phone and the desktop planner both start their ETAs from
// each installer's usual first-stop ARRIVAL (ROUTE_USUAL_START below and
// usualStartClock in js/route-constraints.js). Kept because optimizeRoute's
// `departMin` still names it, which the solver does not schedule on; the desktop
// planner clamps it into its [08:00, 08:30] muster window there.
export const ROUTE_DEPART_TIME = '08:15';

// When the working day is over ('HH:MM', 24h). Used for exactly ONE decision: is
// today spent, so a route being planned now is for the next working day
// (js/route-planday.js `resolvePlanDay`). It is deliberately NOT a day-sizing
// input — the meters/day target alone decides how many stops a day holds. An
// earlier per-installer "Finish by" dial did both jobs, and the sizing half made
// the target silently inert above whatever the clock allowed: 16, 24 and 40 all
// produced the same day. A constant, because nobody needs to tune when 4pm is.
export const ROUTE_DAY_END = '16:00';

// What the End-of-day bookend boxes (Start / End, Departure / Returned) open at
// when the day has none saved yet — the crew's normal shift, typed over on a day
// that ran differently. Prefill only: a time already on the day's Days row (or in
// the phone's cached copy) still wins, and edit.html deliberately does NOT use
// these, so a reprint of an old day with no recorded times stays blank rather than
// gaining an invented 07:30–16:00.
//
// Deliberately NOT ROUTE_DEPART_TIME / ROUTE_DAY_END, whatever the coincidence of
// the 16:00: those two are route-planning inputs, each documented as answering
// exactly one question, and giving either a second job is how the finish-by dial
// came back last time. These describe hours actually worked; those describe a plan.
export const DAY_START_DEFAULT = '07:30';
export const DAY_END_DEFAULT   = '16:00';

// The estimated end time on the route map is built from these three. They never
// size a day: the meters/day target alone decides how many stops a day holds.
// ROUTE_USUAL_START is the first-arrival clock used until an installer has enough
// measured days; ROUTE_BREAK_MIN is the day's whole break allowance in minutes, taken whenever and
// mostly not logged, so it is a total and never set times; and
// ROUTE_FLAT_OUT_END is the cut-off the "flat out" stop count is measured against.
export const ROUTE_USUAL_START = '09:30';
export const ROUTE_BREAK_MIN = 60;
export const ROUTE_FLAT_OUT_END = '15:30';
