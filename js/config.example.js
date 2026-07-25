// ── Frontend config TEMPLATE — copy to js/config.js and fill in ─────────────
// This file is the sanitized copy that ships in a handoff bundle. It carries no
// credentials. To stand up your own tenant:
//
//     cp js/config.example.js js/config.js
//
// then fill in the two required values below. Full runbook: ONBOARDING.md.
//
// js/config.js is COMMITTED, not gitignored — GitHub Pages serves the repo root
// as-is, so each tenant's deployed site needs its own copy in git. That makes it
// the one file that is permanently different between tenants; never include it
// in a patch sent to another tenant's repo (see AGENTS.md §"Working with a
// second tenant").

// ── Required ────────────────────────────────────────────────────────────────
// Paste your deployed Web App /exec URL here once. SHARED_TOKEN must match
// Code.gs. This module is imported by every page, so the URL + token live in
// ONE place on the frontend (Code.gs keeps its own copy — two places total).
// After this, the only thing each person sets is their name.
//
// SHARED_TOKEN: generate a fresh random string for your own deployment — do not
// reuse another tenant's. Any 32-ish random characters will do, e.g.
//     node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
// It must byte-match the value at Code.gs:42 in YOUR Apps Script project.
export const WEB_APP_URL  = 'PASTE_YOUR_EXEC_URL_HERE';
export const SHARED_TOKEN = 'PASTE_YOUR_SHARED_TOKEN_HERE';

// ── Optional — routing providers. Blank is a supported, working state ───────
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
//
// Leave '' to skip it: Optimize then falls back to straight-line distances,
// which is fine for development.
export const GMAPS_API_KEY = '';

// OpenRouteService API token — the free, hosted BACKUP for both land-mode
// lookups in js/route.js: forward geocoding (when Google is rejected or misses)
// and the road-distance matrix (when Google Routes / the local OSRM is down).
// Never the primary — the optimizer only falls to ORS when the primary returns
// nothing, then to straight-line. Free key from openrouteservice.org (see
// DEPLOY.md §"OpenRouteService backup"); leave '' to disable the fallback
// entirely. Same public-client-key tradeoff as GMAPS_API_KEY above.
export const ORS_API_KEY = '';

// ── Org policy, not a credential — safe to keep as-is ───────────────────────
// When the crew leaves the start location each morning ('HH:MM', 24h). Global,
// not per-installer: the ETA model anchors the first stop to this clock plus the
// real drive out to it. Change it with a commit — GitHub Pages ships it. The
// desktop planner still clamps it into its [08:00, 08:30] muster window.
export const ROUTE_DEPART_TIME = '08:15';

// ── Preflight guard ─────────────────────────────────────────────────────────
// False while the two required values above are still placeholders (or blank).
// js/api.js refuses to call the spine and js/queue.js refuses to flush while
// this is false — so an unconfigured copy fails loudly instead of quietly
// writing into whichever deployment happened to be pasted in here. Queued
// writes are KEPT, not dropped: an unconfigured device is a transient state.
const filled = v => !!v && !/^PASTE_YOUR_/.test(v);
export const CONFIG_READY = filled(WEB_APP_URL) && filled(SHARED_TOKEN);
