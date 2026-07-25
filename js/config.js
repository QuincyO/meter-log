// ── Frontend config — the single source of truth for the web app ────────────
// TENANT-SPECIFIC. This file is committed (GitHub Pages serves the repo root,
// so the deployed site needs it in git) and therefore differs permanently
// between tenants — never carry it across in a patch. `js/config.example.js` is
// the credential-free template a second developer starts from; keep the two in
// sync when adding a constant (tests/config-template.test.mjs enforces that).
// See ONBOARDING.md and AGENTS.md §"Working with a second tenant".
//
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

// When the crew leaves the start location each morning ('HH:MM', 24h). Global,
// not per-installer: the ETA model anchors the first stop to this clock plus the
// real drive out to it. Change it with a commit — GitHub Pages ships it. The
// desktop planner still clamps it into its [08:00, 08:30] muster window.
export const ROUTE_DEPART_TIME = '08:15';

// ── Preflight guard ─────────────────────────────────────────────────────────
// False while the two required values above are still the placeholders carried
// by js/config.example.js (or blank). js/api.js refuses to call the spine and
// js/queue.js refuses to flush while this is false — so a copy of this repo
// that was never pointed at its own deployment fails loudly instead of quietly
// writing into someone else's Sheet. Queued writes are KEPT, not dropped: an
// unconfigured device is a transient state, and the queue's durability contract
// (AGENTS.md §"Offline queue mechanics") says a write is never lost.
const filled = v => !!v && !/^PASTE_YOUR_/.test(v);
export const CONFIG_READY = filled(WEB_APP_URL) && filled(SHARED_TOKEN);
