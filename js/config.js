// ── Frontend config — the single source of truth for the web app ────────────
// Paste your deployed Web App /exec URL here once. SHARED_TOKEN must match
// Code.gs. This module is imported by every page, so the URL + token live in
// ONE place on the frontend (Code.gs keeps its own copy — two places total,
// down from the previous five). After this, the only thing each person sets is
// their name.
export const WEB_APP_URL  = 'https://script.google.com/macros/s/AKfycbwlqHwVha6ztYRXHfy9peYHOvwQPnYhHnqqZTQZGvpwctkWOPNADwLxTsCoir47Kkff/exec';
export const SHARED_TOKEN = 'Bko1PP6sPFJMabph7ZF7TtZDLFqXuFOr';

// OpenRouteService API key (land-mode route optimization — js/route.js). Get a
// free key at openrouteservice.org ▸ Dashboard ▸ create token, and paste it here.
// Same documented tradeoff as SHARED_TOKEN: it sits in client source on a
// public-capable GitHub Pages site, mitigated by keeping the repo private.
export const ORS_API_KEY  = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImYxNDdkYzE3ZmFjYzQ5Yzk5ZGVhNjI1OTA4ZjUzZTc3IiwiaCI6Im11cm11cjY0In0=';
