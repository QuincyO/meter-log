# Changelog

What shipped and why, newest first. `AGENTS.md` and `ARCHITECTURE.md` describe how the app
works *now*; this file records how it got that way — the reasoning behind a change, and the
bug that prompted it, which a diff alone doesn't carry.

**Dates, not version numbers.** There is no release process: GitHub Pages serves the repo
root and CI deploys `Code.gs`, both from `main`, so a merge to `main` *is* the release. Each
`##` section is one day's shipped work.

**Add your entry in the same commit as the change**, not as a later sweep — see `AGENTS.md`
§"Standing workflow rules". The automated `Nightly sheet export — <date>` commits are the
spine writing its own Sheet snapshot back to the repo; they are not listed here.

Viewable in Obsidian via `vault/Reference/changelog.md`.

---

## 2026-07-26

- **Fixed: the 🧭 Optimize button ate scroll attempts.** A `touchstart` `preventDefault()`
  added to stop iOS selecting the button's label also cancels panning, so the full-width
  56px button was a strip of the worklist the crew could not scroll through — the only way
  past it was to start the swipe above or below it. Worse, `pointerup` had no movement
  check, so a drag that began on the button counted as a tap and started a route
  optimization on an accidental brush. The tap/hold recognizer moved to a pure, unit-tested
  `js/press-hold.js` that aborts the press past 10px of travel; selection suppression is
  left to CSS, where it costs no scrolling. `f3f5044`
- **This file.** Backfilled across all 286 commits since 2026-06-18, and kept current by a
  standing rule in `AGENTS.md`. The repo's other docs say how the app works now; nothing
  said how it got that way, and a diff doesn't carry the reasoning. Surfaced in the local
  Obsidian vault through a `Reference/` wrapper note.

## 2026-07-25

- **Mid-day work joins today's route, sized by meters actually installed.** Day 1 used to
  shrink only as its *own* planned orders finished, so walk-up meters installed off-plan
  consumed none of the day's target and an order added mid-day sank to the bottom of the
  last day. Day 1 is now the target minus every meter installed today. `7431cf0`
- **The start-location question is a popup, not an inline list.** Optimize blocks on the
  answer, so the question belongs over the page the way the `confirm()` it replaced did.
  `e73ec60`

## 2026-07-24

- **Installer route tuning** — a four-part feature landed in sequence: an org-wide
  `ROUTE_DEPART_TIME` constant replacing dead per-order date/time fields; `commutePull` +
  `finishBy` dials persisted per installer in `WorklistPlans` and weighting the per-day home
  bias; a `#tuning` screen with a live stops/day readout; and the crew-start pin plus the
  faint drive-out line drawn on both the planner and phone maps. The crew start is
  **ETA-only** — it times, prices and draws the morning drive out, but never anchors where
  the route begins. `faae202` → `b7796e8`
- **Real route ETAs, so the phone fits a workday.** Google Routes and ORS now return real
  durations, and a matrix-less run estimates them from distance — the phone finally shows
  crew-start ETAs and workday-sized days offline, labelled "(est.)". `f924e04`
- **Drive mode grew a driving-stats HUD** (distance / average / idle / max, metric, with a
  moving-average and current-speed readout), a pinned "Driving to" card, and a real-data
  on-pace projection rendered as an instrument-cluster gauge. `a4ffc4b` → `4a53d27`
- **Today's set is frozen, and a work order can be reset.** `f88b800`
- **Fixed four field-reported bugs in one pass:** blank Start/End on the daily-log PDF (the
  bookends weren't posted at preview time), drive legs fragmenting into ~23 pieces a day
  when iOS killed the backgrounded PWA, a queue that wedged forever behind one
  permanently-rejected write, and GPS speed outliers inflating `maxSpeed` to 1207 km/h.
  `be30bed`
- **"Stuck uploads" review screen** for queue items parked after repeated definitive
  rejections — they stay in the durable queue and can be retried from the status pill.
  `3968f43`
- **The Obsidian knowledge vault is gitignored** as local-only, along with its already-applied
  bootstrap spec. `b919ae1`, `63a64b5`

## 2026-07-23

- **Two saved route variants** (road and straight-line), both priced on real road distances
  so the shorter number really is the shorter drive, plus route distance and set-aside
  orders. `938e9f4`
- **`AGENTS.md` became the single instruction set for every agent.** `CLAUDE.md` had been
  the canonical copy with `AGENTS.md` as a fork; the fork drifted several features out of
  date, so Codex was working from a description of an app that no longer existed. One file,
  read by everyone, is the fix. `7de260c`
- **Drive mode**: a single-card driving screen with silent GPS route recording, opt-in per
  phone per day, uploading only at end of day. Recording is app-wide, not tied to the Drive
  screen — but a web app gets no GPS in the background, so a Maps hand-off is bracketed as
  an anchored gap rather than faked as a straight line. `a25099c`, `0cdb353`, `ebc2047`
- **Settings ▸ ⟳ Force update from GitHub**, the crew's escape hatch for a stale service
  worker — Cache Storage only, so nobody re-enters their name or loses queued writes.
  `4c56ee3`, `6008177`
- **Worklist**: drag autoscroll (one drag can now cross a list longer than the screen),
  copy-on-navigate, an address fill-in walkthrough, and a block on duplicate WO# at add
  time. `d0ce953`, `b42dc2c`
- **Planner** can edit orders and saves OSRM road geometry for both routes. `e7ca99a`,
  `605dcf5`

## 2026-07-22

- **Per-installer metrics + a target-driven multi-day route split**, with the metrics split
  into boat / land / combined columns. `7ab61a5`, `6f5eb91`
- **Worklist Optimize turned on** for everyone on straight-line distances, with the
  road-matrix run kept behind a gesture — first a 5-tap secret, then a two-second hold.
  `efe0df0`, `ee1f0aa`, `8d8126f`
- **Mobile worklist route editor**, timed appointments and locked route slots, and optimized
  routes that can start from your current location. `bc5814e`, `ced5710`, `ecdb095`
- **Planner provider health provenance and status UI** — which matrix source actually
  answered, surfaced rather than guessed at. `7190574`, `a24f541`

## 2026-07-21

- **Routing moved to Google Maps Platform** (free-tier only), with a budget-guarded road
  matrix via the Routes API, navigation by address rather than pin, and **OpenRouteService
  as a backup** for both geocoding and the matrix. `9a47eba`, `96492df`, `96b0ce5`
- **A desktop route planner (`planner.html`)** with a local OSRM matrix source, later joined
  by optional local Nominatim geocoding and scripts to clone both onto another PC's SSD.
  `a6a9e4d`, `1c96776`, `7ef68a8`
- **Geo-restricted route geocoding + home-anchored routing**, and repair for colliding
  worklist `order` values. `2f5f29d`
- **Land-mode end-of-day refinements**, a no-GPS logging override, and downtime allowed on
  the first work order. `0bbe08e`, `21cdfd3`
- Quiet plan-mode "expected stops today" estimate on the capture page. `39ff533`
- iOS opens Google Maps directly (native Apple Maps fallback) — iOS has no OS setting to
  pick a default maps app. `7d70547`
- Capture form reordered: address first, conflict chooser last. `2fd4599`

## 2026-07-20

- **Land-mode worklist route optimization** — the first version, with Or-opt improvement.
  `3ededbe`, `82fde93`
- **Worklist sync across devices**, keyed on H number rather than installer name (same-name
  installers were colliding), plus a per-order Directions button and a nightly done-order
  cleanup. `774bdaf`, `546c0be`, `f995f3e`
- **A user guide (`USER-GUIDE.md`) and an offline in-app Help page.** `b51615a`
- **GPS + address capture became manual** (Refresh-only) — then GPS coordinates were made
  mandatory on every stop log. `b9f762a`, `28b25cf`
- **Background jobs surfaced in the top status pill.** `a58d98a`
- **Worklist drag reorder fixed twice**: queue position numbers, then binding release to
  `window` so the lift always registers (the "card stuck highlighted" bug). `db40f38`,
  `c886aa9`
- Offline robustness: stop wedging sync on a lying `navigator.onLine`, actually queue the
  End-of-Day close when the live close fails, and surface the real `loadDay` error instead
  of a generic "Offline". `fde44d0`, `0b35257`, `0f792ed`

## 2026-07-19

- **Sub-foreman in Settings + a per-sub Reports page** with quick close-out. `d45554e`
- Fixed land crews rendering as boats; the reports page is now sub-first. `635f974`

## 2026-07-18

- **Land-work mode**: a persisted Boat/Land toggle switching the capture page and teams
  admin between the two, a full-page worklist with plan mode, and a land-specific daily-log
  PDF template. `06b4110`
- **Removing a stop became a move, not a delete** — stops are archived to a `StopsArchive`
  tab, appended before the source is deleted, so a crash duplicates rather than loses.
  `b0afc3c`

## 2026-07-04 → 2026-07-17

Quiet fortnight — the automated nightly Sheet export ran, nothing else shipped.

## 2026-07-03

- **Performance pass for scale**: sheet reads memoized per request with a cross-request
  `CacheService` copy for the small roster tabs; `avgDispatchTime` moved off the write path
  to an hourly trigger; optional from/to date windows on the five viewer reads;
  `previewDailyLog` run outside the `doPost` write lock; Leaflet and Chart.js vendored
  instead of CDN-loaded; and the map opens on a 60-day window with full history on demand.
  `623c402` → `b0fcd46`

## 2026-06-30 → 2026-07-02

Nightly Sheet export only.

## 2026-06-29

- GPS samples until it hits an accuracy target rather than taking a fixed count. `dc15f9c`
- The end-of-day summary is prefetched during the travel review, so closing the day produces
  the PDF instantly. `dab7f40`

## 2026-06-28

- **Nightly Sheet→Markdown export to GitHub** — spec, markdown table formatters, a Git Data
  API commit helper, the orchestrator and its trigger installer. `dd03620` → `1ecedf7`
- **Killed UTC "Z time"**: Sheet Date cells are normalized to naive Toronto strings.
  `d6c4c4c`
- **Single-digit-hour timestamps tolerated everywhere.** Some rows store `9:13:44`, not
  `09:13:44`, which silently dropped every pre-10:00 stop from the gap/travel math and sorted
  morning cards to the end of the list. All parsers take `\d{1,2}` now, and card sorts parse
  the timestamp instead of comparing it as text. `2fd3c14`, `b0059f0`
- **The daily-log PDF is rendered on the phone**, offline-capable, with a vendored jsPDF —
  no Drive archive copy, no spine round-trip. `4e6e5bf`
- Travel time moved to a shared boat-timeline model. `466b246`

## 2026-06-27

- Dispatch downtime deduplicated, boat totals shared, and a loading UI added to end-of-day.
  `f1358fd`
- Ten GPS samples averaged for a more accurate fix. `5b4df23`

## 2026-06-26

- **The capture app was modularized into shared ES modules** in five phases: the module
  split, generic offline storage with retention and offline geocoding, client-computed
  dispatch downtime reconciled by the spine at end of day, the map/teams/edit pages migrated
  onto the same modules, and the docs updated to match. `5c8655b` → `bb7231a`
- Dispatch downtime matched and pre-filled at end of day rather than live — `addStop` stays
  a cheap append. `c326f53`

## 2026-06-25

- **The day log became storage-first**, backed by IndexedDB: a stop survives offline before
  it ever reaches the Sheet. `86ad138`
- **The end-of-day travel review works offline.** `77d2540`
- `avgDispatchTime()` pairs requested meters to completed installs and persists the average
  to a `Metrics` tab. `73b9ec4`, `7cbe69a`
- Boat-wide log→log metric and a daily boat-team record. `72c285a`

## 2026-06-24

- **Offline cache (IndexedDB), a nav dropdown, and the installer worklist.** `69bff69`
- **The offline queue was hardened**: no silent drops, no duplicate writes. `6178915`
- Teams: add crew by typing a name, any boat size. `15ed50f`
- Fixed a `SyntaxError` from curly quotes in a script block that broke every button.
  `94f9832`

## 2026-06-23

- **Travel time became per-installer**, computed from each installer's own consecutive
  meters rather than team-wide, with downtime subtracted at end of day. `ad5a8a8`,
  `9b2df41`, `c4ac706`
- **Dispatch downtime auto-calculated** from meter requests; "Requested?" became a toggle
  beside the Work order field. `39a277d`, `769187b`
- Edit page: manual day-close, PDF-only generate, per-log travel dropdowns, WO cards ordered
  chronologically with each arrival time on its row. `15330bd`, `84e29b6`, `3f0fc49`
- Daily log trimmed to installs/UTIs with install-to-install timing; a PDF-only toggle omits
  delays and travel. `f5c250f`, `68ea8e2`
- Analytics: average time between meters and a typed multi-installer filter. `e4a5046`

## 2026-06-22

- **Work-order dedup and J# conflict flagging.** `12d07e1`
- **Visited/Unaccounted log types + automated downtime tracking**, then capture statuses
  consolidated with delay and travel split on a 20-minute cutoff. `6304e2d`, `7e4e069`,
  `33d51ba`
- **A `Timing` audit tab** so the daily-log travel column reconciles. `193541f`, `ed41465`
- **`edit.html`** — the back-office stop editor and daily-log generator. `dfd3f7f`

## 2026-06-21

- **Teams**: per-boat member letter maps, captain/sub lists, collapsible cards, crew search,
  and header-safe writes. `f79deb0`, `6821ad4`, `514fa52`
- **CI auto-deploys `Code.gs` to Apps Script** via clasp on push to `main`. `9ba3a42`
- `ARCHITECTURE.md` and `CLAUDE.md` started here. `bd40e4b`, `597e851`

## 2026-06-20

- **The Apps Script spine, the teams UI, and the service worker.** `c171a03`
- `map.html` — the viewer. `20359bc`
- End-of-day processing and weather fetching. `98e5859`

## 2026-06-19

- Meter read input, address in the summary table, and the first rounds of capture-form
  shaping. `7464d7c`, `0a96d23`, `3a2b746`

## 2026-06-18

- Initial commit. `3156517`
