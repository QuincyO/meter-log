# AGENTS.md

Instructions for **any** coding agent working in this repository — Claude Code, Codex,
or anything else. This file is the single source of truth. `CLAUDE.md` is a short
pointer to it and contains no instructions of its own, so there is exactly one place to
read and exactly one place to edit.

## Working in this repo — read this first

Several different LLM agents work on this codebase, picked per session by whatever
token budget suits. **The work is expected to be interchangeable between them**, so a
change made by one agent should be indistinguishable from the same change made by
another. Two consequences that matter more than they sound:

- **Durable instructions belong in the repo, not in an agent's private memory.** Any
  agent-specific memory store, skill file, or settings file is invisible to the next
  agent that picks up the work. If you learn something that should outlive the session
  — a workflow rule, a landmine in the data, a decision and its reasoning — write it
  into this file, `ARCHITECTURE.md`, or `VERIFY.md`. Do not leave it somewhere only
  your own tool can see. (This file exists because that happened: `AGENTS.md` was a
  fork of `CLAUDE.md` that silently drifted several features out of date, and three
  standing rules lived only in one agent's private memory.)
- **Don't fork this file.** If you need a tool-specific note, keep it to a clearly
  labelled line in §"Tool-specific notes" rather than starting a parallel document.

### Standing workflow rules

- **Commit and push when work is complete — don't ask.** This repo's deploy model *is*
  git: GitHub Pages serves the repo root, and `.github/workflows/deploy-appsscript.yml`
  deploys `Code.gs`, both from `main`. An unpushed commit is work that has not shipped.
  Commit directly to `main` unless told otherwise; on a feature branch, push that
  branch. **Run the tests before pushing** — a push to `main` here is a production
  deploy, so "evidence before assertions" matters more, not less.
- **Write the changelog entry in the same commit as the change.** Not as a later sweep —
  reconstructing *why* a change was made from a diff, weeks on, is exactly the work it exists
  to prevent. Two files, both required:
  1. **`changelog/YYYY-MM-DD.md`** — the day's page. Create it if today has none (copy the
     shape of any existing one: frontmatter, `#` heading, a `##` per change, and the
     `[← all days]` footer). Append a `##` section if the page exists. Say what shipped, the
     problem it solves, and the trap worth remembering; cite the commit and the files.
     **Day pages carry no `previous:`/`next:` links** — the index is the only navigation, so
     adding a day never means editing another one. A link to another day belongs in the prose
     only when it earns it (a change that superseded or caused that one).
  2. **`CHANGELOG.md`** — one row in the month table, newest first: the date linking to the
     page, and a short phrase for the whole day.
  No version numbers — a merge to `main` is the release. Skip both for a pure docs edit or a
  nightly-export commit. The day pages are Obsidian notes (the vault root is the repo root),
  so keep links as relative markdown — they resolve on GitHub *and* in Obsidian.
- **Never proceed on defaults when a question goes unanswered.** If you ask the user
  something and get no reply, stop and wait. Do not pick the recommended option and
  carry on. Restate the open question in plain text and end the turn.
- **Verify before claiming something works.** `node --test "tests/*.test.mjs"` runs the
  suite; `VERIFY.md` has the recipe for driving the real pages in a headless browser,
  including how to exercise write paths **without writing to the production Sheet**.
- **When a field report needs a guess, ask for the data instead.** The crew reports
  symptoms from a phone whose state you cannot see, and this codebase makes almost all
  of that state *exportable* — the `Worklist` tab as CSV, and the phone's own
  localStorage/IndexedDB via the dump in `VERIFY.md` §6. Reasoning from source about
  which of several plausible causes is live has cost this project real time: a
  "why is my day 20 stops" report burned three rounds of code-reading and two wrong
  fixes, and one `Worklist` export then settled it in minutes — the pending count and
  the `day`/`dayRoad` columns said "this route was built for a target of 20", which
  turned the question into "why does the box say 24" and named the actual bug (a
  `change`-only store write). Two rules follow:
  1. **One hypothesis, then ask.** Forming a theory from the code is fine and cheap.
     *Shipping* a fix for it without evidence that it is the live cause is not — a
     wrong fix costs a deploy, muddies the next report, and can look like a new bug.
     If the state that would confirm it is observable, ask for it and wait.
  2. **Ask for the smallest thing that discriminates**, and say what each answer would
     mean. "How many orders does the header say are remaining?" beats "send me
     everything"; `VERIFY.md` §6 has the ready-made dump for the phone-local half.
  Reproduce against the *shipped* commit before changing anything, so you know you are
  looking at the reported bug and not a different one — `git stash` is enough.

## What this is

A field data-capture app for a hydro meter installer crew working out of boats **and on
land routes** — a persisted Boat/Land mode toggle (blue/green accents) switches the
capture page + teams admin between the two; see ARCHITECTURE.md §"Work modes (boat /
land)". There is **no build step, no package manager, and no framework** — it is a set
of static files served as-is plus one Google Apps Script. There *is* a test suite, and
it needs no install: plain `node --test "tests/*.test.mjs"` over the pure modules
(`js/route*.js`, `js/compute/*`) plus assertions about doc, CSS and `Code.gs` schema
content. The frontend is split into native ES modules under `js/` and plain stylesheets
under `css/`; each HTML page is markup + `<link>`s + one `<script type="module">`.
Browsers load the modules natively, so there is still **nothing to compile** — deploy is
commit + push. Read `ARCHITECTURE.md` first; it is the authoritative design doc and is
kept current.

## Running locally

The pages are static HTML. Serve the repo root over HTTP (a `file://` open breaks the
service worker, the ES-module imports, and fetches).

**`python` on this machine is the Windows Store stub and never serves anything** — the
`python -m http.server 8731` line these docs used to carry does not work here. Use node,
and set `Content-Type` explicitly, because browsers refuse ES modules served as
`application/octet-stream`:

```js
// serve.mjs — run: node serve.mjs <repo-root>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = process.argv[2];
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png', '.md':'text/markdown' };
createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^[\\/]+/, '');
  try {
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8731);
```

Then open `http://localhost:8731/index.html` (the capture form), `/map.html` (read-only
map + analytics), `/teams.html` (crew/boat admin), `/edit.html` (back-office editor),
`/reports.html` (pick a sub foreman + date → their crew's daily totals + quick close),
`/planner.html` (the desktop route planner — load/paste an installer's worklist,
optimize against a local OSRM server, upload the ordered list; see DEPLOY.md §"Desktop
planner + local OSRM"), or `/help.html` (the in-app user guide — renders `USER-GUIDE.md`
via `js/pages/help.js`'s markdown-subset renderer; keep the guide inside that subset and
in sync with UI changes). Seven pages in total.

The production deploy is **GitHub Pages serving the repo root** — pushing to `main`
publishes. There is nothing to compile, so "deploy" = commit + push.

`Code.gs` runs in the Google Apps Script editor bound to the Sheet, deployed as a Web
App (Execute as: Me ▸ Anyone). **Pushing `Code.gs` to `main` auto-deploys it** via
`.github/workflows/deploy-appsscript.yml` (`clasp push` + redeploy the *existing*
deployment in place, so the `/exec` URL never changes) — see `DEPLOY.md` for the
one-time secret setup. You can still deploy by hand (paste into the editor ▸ redeploy)
if CI is unavailable. The Action only ships code: when tabs/columns change you may still
need to re-run `setupSheets()` once from the editor (it is additive and leaves existing
tabs/data alone — except a schema-changed `Teams` tab, which must be deleted first).
Tabs whose writers call `ensureTab()` on every write — `Worklist`, `WorklistPlans` —
fill new header cells themselves on the next upload, so those two migrate without it.
The manifest is `appsscript.json`; `.claspignore` keeps clasp from pushing the HTML
frontend into the script project.

## Architecture in one paragraph

Three layers (see `ARCHITECTURE.md` §"The three layers"). **Store:** one Google Sheet, seventeen tabs (`Stops`, `StopsArchive`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`, `Timing`, `Days`, `BoatDays`, `Dispatch`, `Metrics`, `InstallerMetrics`, `Worklist`, `WorklistPlans`, `DriveTracks`) — the system of record. (`DriveTracks` is one row per Drive-mode driving leg — an encoded GPS+speed polyline plus JSON gap anchors, uploaded by `saveDriveTrack` and replayed on the map viewer; see ARCHITECTURE.md §"Drive mode".) (`StopsArchive` is the "remove from the log" archive — a Stops row moved there (never hard-deleted) by `archiveStop`, restorable via `restoreStop`; see ARCHITECTURE.md §"Removing a stop". `Timing` is the per-gap audit trail written at end-of-day; see ARCHITECTURE.md §"Travel vs delay". `Days` is one row per installer/day holding the persisted Departure/Returned bookend times. `BoatDays` is one row per boat/day — a snapshot of who crewed which boat, taken at end-of-day (the only historical record of daily boat membership, since `Teams` is current-state only); it backs the viewer's boat-wide "avg log→log (boat)" metric. `Dispatch` is one row per Apple-Shortcut meter request, completed in place when the matching stop is logged; see ARCHITECTURE.md §"Dispatch downtime". `Metrics` is a key/value summary tab (currently the `avgDispatchTime` average), refreshed by `avgDispatchTime()` — adding it means re-running `setupSheets()` once. `InstallerMetrics` is one row per installer keyed on the employee **H number** — lifetime analytics (days/hours worked, logs, installs, utis, avg/day, avg/hr, avg log time) rolled up from the installer's `Tracker`/`Days` rows (+ a lifetime `Stops` gap scan for `avgLogMin`) by `refreshInstallerMetrics()`; **every metric is stored three ways in its own column group** — combined (unprefixed), boat-only (`boat*`), land-only (`land*`) — with boat/land attribution from the `workType` column on `Tracker`/`Stops`/`Downtime` (a `Days`/hours row inherits its date's `Tracker` workType); refreshed **incrementally at end-of-day** (re-summed, so a re-close never double-counts) and in bulk via the editor-run `backfillInstallerMetrics()`; `avgPerDay`/`avgLogMin` feed the route planner's meters/day target. A further appended block — `onSiteMin`/`extraMeterMin`/`travelMinPerKm`/`onSiteSource`, again ×3 modes — holds the **measured on-site dwell model** behind route ETAs (`installerOnSiteFit` regresses consecutive-stop gaps, net of gap-tagged Downtime, against distance: intercept = on-site work, slope = real travel rate; `installerOnSiteFromTracks` beats it from GPS leg boundaries when there are enough). Blank = no evidence, which the phone reads as "keep the old pace guess", so **nothing changes until `backfillInstallerMetrics()` runs**. Reshaping it means re-running `setupSheets()` once (delete an old-schema copy first). `Worklist` is one row per planned order, keyed per installer on the employee **H number** (names can collide) — the manual multi-device sync copy of the phone's IndexedDB worklist, written only by the planning screen's explicit Upload (`saveWorklist`, a whole-list replace) and read only by Download (`?action=worklist&hNumber=…`); the phone stays the working copy. Its `day` column is the route planner's multi-day cluster number, synced so the phone worklist shows Day 1 / Day 2 dividers. An `ignored` column marks an order **set aside** — out of the route, day counts, meters/day target and plan mode, but still on the list and still synced (deliberately not a third `wlStatus` value, since `clearDoneWorklistJob` sweeps `'done'` rows nightly). Two further column groups — `orderRoad`/`dayRoad`/`legMetersRoad` and `orderStraight`/`dayStraight`/`legMetersStraight` — hold the **two saved route variants**: a road-matrix run solves the same stops twice (road and straight-line) and prices both against the same matrix, so their km totals are directly comparable (the driving **between stops** only — the drive out from the **crew start** to each day's first stop is measured per day into `homeLegMeters*` and kept **out of** the total, a `start` reference readout on the day headers; home is the end-of-day bias **only** and never a drive-out anchor, so a crew with no start location shows no drive-out — the `homeLegMeters*` field name is legacy); `order`/`day`/`scheduled*` remain the live sequence and switching variants just copies one in. Two more columns — `legGeometryRoad`/`legGeometryStraight` — hold each variant's per-leg **road directions polyline** (the desktop planner fetches it from the local OSRM's `route` service — distinct from the `table` matrix service — automatically after a road-matrix Optimize and on demand via its **Get directions** button; opaque text pinned to `@`, drawn as real roads on the planner map **and on the phone route view** (`worklist-route-view.js` decodes it on-device, no network — the phone never fetches geometry over the network, but it does *measure* its own from the district pack, both when optimizing and again at draw time; see §"Road lines survive a reorder"), rides the sync verbatim like `legMeters*`). The drive out from the crew start to a day's first stop **is** drawn, as a faint dashed line with a distinct start pin, on both the planner map and the phone route view — a per-variant `homeLegGeometryRoad`/`homeLegGeometryStraight` polyline stored on the day's first stop (the OSRM road path when the local server is up, else a straight two-point line `encodePolyline`'d from the crew start, else empty when the crew has no start on file). It rides the sync verbatim like `legGeometry*`, is blanked on any reorder, and is drawn only while `variantMatchesLive` holds. It is still kept **out of** every distance total (`homeLegMeters*` remains the reference-only number). A between-stops leg without saved geometry (an edit/quick change) still draws straight. **`legGeometry*` must never outlive the order it was fetched for:** every Optimize blanks it on the stops it reorders (the OSRM re-fetch refills it only when OSRM is up, so an OSRM-offline/ORS run leaves straight legs, not a stale home-ward line), and both maps only draw it while `variantMatchesLive` holds (a manual drag drops it). See ARCHITECTURE.md §"Route variants". `WorklistPlans` is one row per installer holding the route-plan settings (start date, first-stop time, pace, `routeVariant`/`straightDistanceSource`, plus the installer-owned tuning `commutePull`/`finishBy` and the meters/day `target`) so they don't repeat on every order row; the phone owns the tuning/target and pushes them up on Download via `savePlan`.) **Spine:** `Code.gs`, an Apps Script Web App that does all deterministic writes/reads via `doPost`/`doGet`. **Capture/view:** the static pages (`index.html` capture, `map.html` viewer, `teams.html` crew admin, `edit.html` back-office stop-editor + daily-log generator, `reports.html` sub-first crew daily totals + quick close-out, `planner.html` desktop route planner (office plans + uploads an installer's optimized worklist; road matrix from a local OSRM via `optimizeRoute`'s `opts.osrmUrl`), `help.html` user guide — the back-office ones are nav-only, not linked from the capture page), each a thin `js/pages/<page>.js` entry module over the shared modules in `js/` (see §"Frontend module layout" below). An LLM with a Drive connector (outside this repo, driven by the user) only *generates* the formatted daily-log deliverable and summaries; it never stores data and is not in the write path.

## Frontend module layout

No bundler — native ES modules + plain CSS, loaded as-is by the browser. Shared modules in `js/` (imported by the page entry points in `js/pages/`):
- `config.js` — `WEB_APP_URL` + `SHARED_TOKEN` (the single frontend copy).
- `dom.js` — `$`, `enc`, `esc`, `attr`, `toast`. `time.js` — `stamp`, `localDate`, `localDateOffset`, `clockOf`, `hhmmMin`, `ordinal`, `parseLocalMs`.
- `store.js` — `store` (localStorage) + `cfg()`. `idb.js` — the IndexedDB wrapper + `DB_VERSION`. `api.js` — `apiGet(action, params)` / `apiPost(body)` (inject token + URL).
- `queue.js` — offline queue (`enqueue`/`flush`/`paint`/`migrateLegacyQueue`; page UI side-effects via `setQueueHooks`). `daycache.js` — optimistic/reconcile/merge + retention + recent-days. `geocode.js` — addrCache + `resolveAddress` + `backfillAddresses`.
- `compute/` — `gaps.js` (WO→WO gaps), `tally.js` (`PRINTABLE`/`countDay`/`tallyText`), `summary.js` (the offline daily-log summary), `categories.js`, `estimate.js`.
- `drive.js` — the `#drive` driving screen only (a hash-routed sibling screen like `worklist-route-view.js`, wired by `initWorklist`; shows the current order card + the ▶ Start/■ Stop drive-tracking button; no GPS code). `drive-recorder.js` — the **app-level** GPS-tracking runtime, initialized once by `capture.js` and running whenever the PWA is open (any screen); records the leg silently, holds it on the phone, and enqueues `saveDriveTrack` only at end of day (`finishAndUpload`). `drive-track.js` — the pure, DOM-free track model (segment state machine + `encodeTrack`/`decodeTrack` polyline + `segmentSummary`), unit-tested in `tests/drive-track.test.mjs`. See ARCHITECTURE.md §"Drive mode".
- `worklist.js` — the full-page worklist screen + plan mode on `index.html` (orders in the IndexedDB `worklist` store with a manual `order` field, ⠿ drag-to-reorder, recent-street chips, copy-street-forward; plan mode pre-fills the capture form from the next pending order via the `fillCapture` callback capture.js hands to `initWorklist`). The old popup sheet is gone. `worklist-route-view.js` — the phone's selected-day Leaflet route editor. `worklist-address-fill.js` — the `#worklist-address` walkthrough that fills in the addresses one order at a time (queue = blank / `geoFail` / `geoAmbig`, snapshotted on open so Back reaches an order already saved), plus the address text helpers (`splitAddr`/`joinAddr`/`recentStreets`) and the **sink**: on exit, orders still without any address are renumbered to the bottom of the pending group through the same `persistOrderIds` the drag uses. `drag-autoscroll.js` — drag-to-the-edge page scrolling shared by both touch-drag lists; each scrolled pixel is folded back into the drag anchor, or the card slides out from under the finger. `route.js` — the 🧭 Optimize pipeline (Google Geocoding API forward geocoding **biased + hard-bounded to `GEO_RADIUS_KM` of the crew** with stored pins revalidated each run — a stored pin is never blanked, only replaced by a fresh match — ambiguous matches parked with a "⚠ pick a town" pick-list, a **Google Routes API road-distance matrix** guarded by a per-device monthly element budget (`MATRIX_FREE_ELEMENTS`, tracked in localStorage) with a straight-line fallback when the call fails or the budget is spent — the key is quota-capped so neither API can bill past the free tier, see DEPLOY.md — and a pinned open-path TSP that ends toward the installer's Settings home pin or starts at the first order. **OpenRouteService (`config.js` `ORS_API_KEY`, blank = off) is a strict backup for both lookups** — geocoding Google→ORS→park, matrix Google→ORS→straight-line — reached only when the primary returns nothing; `optimizeRoute` surfaces a `note` when ORS carried the run. `optimizeRoute(..., {osrmUrl})` swaps the matrix primary to a self-hosted OSRM `table` call (free; then ORS, then straight-line, never Google) — the desktop planner's path; see ARCHITECTURE.md §"Work modes" ▸ "Route optimization"). `route-constraints.js` — pure appointment/lock → calendar-slot scheduling, shared by phone and planner (its `opts.day1Count` sizes Day 1 to the frozen today set — see `route-today.js`; its `opts.dwell` prices each stop's on-site time — see `route-dwell.js`). `route-dwell.js` — the pure **on-site (dwell) model**: `siteKey` (a site's identity across a typed worklist address and a logged geocoder string) + `dwellLookup` returning `{base, forItem, average}`. The other half of every ETA, measured spine-side rather than guessed at `pace − 10`; see ARCHITECTURE.md §"On-site time (dwell)". `route-today.js` — the pure **today anchor** helpers (`freshAnchorIds`/`needsCommit`/`anchorDay1Ids`/`day1Count`/`orderAnchorFirst`) that freeze Day 1 so nothing but an explicit re-plan moves work between days; orchestrated by `worklist.js applyTodayAnchor()`, persisted phone-only in `localStorage['wlTodayAnchor']` (see ARCHITECTURE.md §"Multi-day split" ▸ "The today anchor"). `route-variants.js` — the pure road/straight-line variant + distance helpers shared by the worklist screen and the planner (`applyVariant`, `variantMeters`, `routeTotalSummary`, `isPending`/`isIgnored`); `optimizeRoute(..., {compareVariants:true})` returns the second candidate route and `legMetersFor` prices any sequence against the run's matrix. **`compareVariants` is honoured only on a run that actually pulled a road matrix** — a straight-line optimize still does exactly one solve and makes no extra call.
- `roadgraph.js` — the **on-device road router** (pure, DOM-free, unit-tested like `drive-track.js`): decode a district pack, snap coordinates to the drivable network, one-to-many Dijkstra for the `{D, T}` matrix, path reconstruction for real drawn roads. `roadpack.js` — the side-effect half: download from `maps/index.json`, store in the IndexedDB `roadPacks` store, district selection, coverage checks, and the memoized decoded graph. Packs are built by `tools/build-roadpack.mjs` from an `osmium` export of the Ontario `.pbf` and committed under `maps/`. See ARCHITECTURE.md §"Offline road maps".
- `pages/` — `capture.js`, `map.js`, `teams.js`, `edit.js`, `reports.js`, `planner.js`, `help.js`. CSS: `css/tokens.css` + `css/base.css` are shared by the capture page; `css/{capture,map,teams,edit,reports,planner,help}.css` are per-page. `map.js` uses the Leaflet (`L`) + Chart globals loaded by classic `<script>`s before the module — both **vendored** (`js/vendor/leaflet.js`, `js/vendor/chart.umd.min.js`, `css/vendor/leaflet.css`), no CDN.

## Work modes in one paragraph

`localStorage['workMode']` (`'boat'` default / `'land'`) drives an accent-token theme via `data-mode` on `<html>` (inline `<head>` snippet pre-paint; blue = boat, green = land) and rides every write as a `workType` field → the appended-last `workType` columns on `Stops`/`Downtime`/`Tracker` (blank = boat, `normWorkType`). `buildDaySummary` returns `workType` (caller's value, else inferred from the day's stops) and `js/dailylog.js` branches on it: land renders the flat per-WO **DELAYS (MIN)** sheet (no travel column — travel is still reviewed at EOD and written to Timing/Tracker, it just doesn't print; delay minutes land on the row whose `workOrderId` matches, plus per-category totals). Land crews are `Teams` rows with `type='land'` (crew # in `boatNumber`, sub foreman in `subName`); a land `endOfDay` skips BoatDays/boat-dispatch bookkeeping. Validation in both modes: Install requires New J#, UTI requires a picked reason (dropdown starts blank). The downtime form pre-fills the current/last WO# so land downtime lands on its PDF row.

## The contract that ties it all together

The frontends and the spine communicate over a single JSON-over-HTTP protocol, and **changing one side requires changing the other**:

- Every request carries `token` which must equal `SHARED_TOKEN`. This lives in **two places** that must stay in sync: `Code.gs:42` and `js/config.js` (imported by every page). Same for `WEB_APP_URL` (the `/exec` URL) — the HTML files no longer carry their own copies.
- **Writes** go through `doPost` → a `switch` on `body.action`: `addStop`, `addDowntime`, `dispatchRequest`, `updateStop`, `archiveStop`, `restoreStop`, `endOfDay`, `previewDailyLog`, `saveTravel`, `saveDay`, `saveWorklist`, `savePlan`, `saveDriveTrack`, `saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`, `saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`. (`saveDriveTrack` appends one Drive-mode driving leg — a client-generated id makes a queue retry idempotent, like `addStop`; see ARCHITECTURE.md §"Drive mode". `archiveStop` moves a Stops row to `StopsArchive` (+ `removedAt`/`removedBy`/`reason`) — the "remove from the log" action on edit.html, the phone's Today list (offline, via the queue), and the map popup; archive-before-delete, idempotent on id, **every outcome terminal** (`{ok, alreadyArchived}` / `{ok, missing}`) so a queued retry always drains; a **closed** day auto-rebuilds its Tracker/Timing via `regenerateDayRows`. `restoreStop` is the reverse (edit.html's "Removed stops" list). See ARCHITECTURE.md §"Removing a stop". `previewDailyLog` returns the day `summary` on demand without writing a Tracker row — it shares `buildDaySummary` with `endOfDay`; the phone renders the PDF from that summary (see §"Daily-log PDF"). `addStop` also returns `boatMeta` (team header + whole-boat dispatch) when the payload carries `installerId`, so the phone's offline daily-log cache stays fresh as the crew logs. `endOfDay` is **idempotent** on (date, installer): it upserts the Tracker row and replaces that day's Timing rows, so regenerating from `edit.html` never duplicates. `saveTravel` **replaces** that day's per-gap travel deductions — the WO→WO travel-time subtractions, stored as gap-tagged `Downtime` rows only; idempotent, so re-reviewing never duplicates (see ARCHITECTURE.md §"Travel vs delay"). `saveDay` upserts the `Days` bookend-times row. `saveWorklist` is the planning screen's manual **Upload**: a batched whole-list replace of one installer's `Worklist` rows keyed on H number (the `installer` column is a roster-filled label, never a match key; idempotent; an empty `orders` array clears the saved copy) — called directly, never via the offline queue; it **renumbers the live `order` 0,10,20… by sorted position** on every upload (never written verbatim — old clients' duplicate/blank order values stop round-tripping) while writing each saved route variant's own positions verbatim, and the nightly `clearDoneWorklistJob` runs the same `normalizeWorklistOrders()` repair across all installers. `savePlan` is a **plan-only** write — it upserts one installer's `WorklistPlans` row (route tuning + `target`) via `saveWorklistPlan` **without touching their order rows**. The phone posts it on Download so the installer's latest tuning/target reaches the office without the whole-list replace `saveWorklist` would do (which would clobber the ordering the phone is about to pull). **The installer's phone is the source of truth for tuning + target** (`commutePull`/`finishBy`/`target`): Download pushes the local ones up and never overwrites them with the sheet's copy, so the next route built for that installer — on the phone or the planner — uses their latest weights. `dispatchRequest` is the Apple Shortcut endpoint that logs a pending `Dispatch` request (time + oldJ). **Dispatch downtime is matched & pre-filled at end of day, not live.** Ticking "Requested meter?" only sets the persisted `requestedMeter` flag on the stop — `addStop` is a cheap append with no dispatch work. When the EOD travel review opens, `?action=idle` (`dispatchSuggestMin`) computes the wait for each gap's arriving install from today's `Dispatch` rows and injects it as an editable, pre-filled `DISPATCH` travel deduction: same-day oldJ match → measured (install − request); cross-day → `avg × 1.25` (skip the overnight hours); flagged-but-no-request → the running average. Saved via `saveTravel` like any gap allocation, so it subtracts from that gap's travel time. `avgDispatchTime()` — which fills the matched `Dispatch` rows + refreshes the `Metrics` average (mean from same-day pairs only; cross-day pairs recorded at `avg × 1.25` and excluded from the mean) — runs from an **hourly time trigger** (`avgDispatchTimeJob`; install once via `createAvgDispatchTrigger()`, see DEPLOY.md), not inside `endOfDay`, so the O(Stops × Dispatch) match never holds the write lock during the quitting-time burst — see ARCHITECTURE.md §"Dispatch downtime". `updateStop` can also correct a stop's clock via `arrivalTime` — it keeps the row's calendar date. `saveTeam` accepts crew two ways: `memberLetters` (`{hNumber: letter}` for installers already in `Employees`) and `newMembers` (`[{name, letter}]` typed onto the boat card) — each new name is auto-created/linked via `ensureEmployeeByName` and folded into `memberLetters` by H number, so a boat can hold any number of crew without pre-adding them in the crew manager.)
- **Reads** go through `doGet` on `?action=`: `day`, `range`, `lookup`, `geocode`, `nearby`, `pins`, `tracker`, `downtime` (all installers' Downtime rows, windowed on the row `timestamp` — backs reports.html's open-day delay tallies), `timing`, `boatdays`, `dispatch`, `driveTracks` (Drive-mode legs, optional installer + `from`/`to` window on the leg date — backs the map viewer's route replay), `avgDispatchTime`, `installerMetrics` (per-installer lifetime analytics from the `InstallerMetrics` tab; optional `hNumber` filters to one row, else all; optional `workType=boat|land` projects that mode's `boat*`/`land*` columns down to canonical field names, `all`/omitted returns the wide combined row — read by the planner (combined) + phone worklist (its current work mode) to show the installer's avg/day beside the meters/day target, **and to carry the measured on-site dwell block** `onSiteMin`/`extraMeterMin`/`travelMinPerKm`/`onSiteSource` into the route ETA model), `siteDwell` (crew-wide per-site dwell history — `{crewMedianMin, sites:[{key, factor, n}]}`, keyed by `siteKey`; the ETA model's site tier, gated hard on evidence so it ships almost nothing today), `roster`, `idle`, `archived` (one installer's removed stops for a date — edit.html's "Removed stops"/Restore list), `worklist` (one installer's saved `Worklist` planned orders, matched on `hNumber` and returned **sorted**, plus their `WorklistPlans` row — the planning screen's manual **Download**, which replaces the phone's local list, renumbering `order` by array position as it lands; carries the `day` cluster number for the phone's Day dividers). (`day` also returns `day` = the persisted Departure/Returned bookends, `closed` = whether a Tracker row exists for that installer/date, and — when `installerId` is passed — `boatMeta` (team header + whole-boat dispatch) to seed the offline daily-log cache; `range` attaches the same `boatMeta` per day. `range` returns one installer's stops+downtime over a `from`/`to` date window grouped by day, in one call — it backs the phone's offline "recent days" cache (≤ ~a week). `idle` returns every WO→WO gap for an installer+date plus any saved deductions — and a pre-filled `DISPATCH` deduction on a requested install's gap (`dispatchSuggestMin`) — feeding the end-of-day travel-subtraction UI on both `index.html` and `edit.html`. The five viewer reads — `pins`, `tracker`, `timing`, `boatdays`, `dispatch` — accept an **optional `from`/`to`** date window (`yyyy-MM-dd`, Toronto, inclusive; omitted = the whole tab, so old callers keep working): `pins` windows on the stop `timestamp`, `tracker`/`timing`/`boatdays` on their `date` column, `dispatch` on `completedTime` (falling back to `requestTime` for still-pending rows — the same way `map.html` dates them). `timing` returns `Timing` rows; `map.html` averages the WO→WO gaps for the analytics "avg time between meters" metric. `boatdays` returns `BoatDays` rows; `js/pages/map.js` uses the daily crew snapshot to group stops by boat and compute the "avg log→log (boat)" tile (the boat-wide cadence — consecutive logs by anyone sharing the boat that day). `dispatch` returns `Dispatch` rows; `map.html` averages the matched ones for the "avg dispatch downtime" tile, and `?action=idle` reads them to compute a requested stop's measured wait. `avgDispatchTime` is a **pure read** of the stored `Metrics` avg dispatch time; the value is kept fresh by the hourly `avgDispatchTimeJob` trigger running `avgDispatchTime()` — the single source of truth for the global match — which pairs every requested meter to its completed install in `Stops`, fills the matched `Dispatch` rows, and writes the average to `Metrics`.)
- The exact field shapes per action live in `ARCHITECTURE.md` §"Data structures". If you add a column to a tab, update the corresponding `*_HEADERS` array in `Code.gs` and the read/write functions that build that row by positional order. **Append new columns at the end, never insert one in the middle** — `ensureTab()` only fills header cells that are *blank* at a given position, so a name slotted into the middle renames nothing on an existing sheet and duplicates the tail instead. **Exception:** `saveEmployee`/`saveTeam` write through `upsertByHeader()`, which maps `{header: value}` onto the sheet's *actual* column order — so reordered `Employees`/`Teams` columns can't scramble those writes (reads via `rows()` were already header-keyed). Other tabs' writes (`addStop`, `endOfDay`/Tracker, `saveWorklist`) are still positional appends; `tests/worklist-sheet-schema.test.mjs` guards the Worklist one against drift.

## Things that are easy to get wrong

- **A duplicate is a WARNING. It must never be a rejection.** `addStop` used to
  `return { ok:false, duplicate:true, history }` on an exact WO#+New J# match —
  *before* `sh.appendRow(row)` — and the phone rendered "Duplicate — … Entry
  discarded." That is a real stop destroyed, at the moment the crew is least able
  to notice it happened. The row is appended first now, always, and the warning
  rides back on an ordinary `{ok:true}` ack as `res.jConflicts`; the phone's
  pre-submit chooser blocks the tap but keeps every field and always offers
  **Log it anyway**. `tests/stop-never-discarded.test.mjs` fails the build if an
  early return reappears in `addStop` before the append. Three things that look
  optional and are not:
  (1) **same-field only, and a blank J# never matches** — a meter installed at
  one house and legitimately pulled from another later carries that serial in
  *both* the New and Old columns by design, and most rows have a blank Old J#
  while every UTI has a blank New J#. Cross-matching flags every ordinary swap;
  blank-vs-blank flags the whole week. Either one trains the crew to dismiss the
  warning, which costs more than not having it;
  (2) **an Old J# repeated on the SAME work order is deliberately not a
  conflict** — the UTI-then-revisit is the crew's most ordinary day, and without
  the carve-out every one of them would block the log. Nothing is lost: two real
  installs on one order still surface via the New J# rule or the WO#-keyed flag;
  (3) **`$('logStop').onclick` must stay synchronous.** The plan-mode WO#
  clipboard copy depends on being inside the user gesture, so the duplicate check
  reads a preloaded `recentJStops` index rather than `await`ing
  `loadRecentDays(7)` in the handler. An `await` before `enqueue` breaks the copy
  silently.
  The rule lives in `js/jdup.js` **and** as a hand copy in `Code.gs` (Apps Script
  can't import an ES module), held together only by
  `tests/jdup-parity.test.mjs` — change one, change the other, or the feature
  starts behaving at random. See ARCHITECTURE.md §"Duplicate J numbers".
- **"Today" and "the day being planned" are two different dates.** The phone can
  plan a route for a day that isn't today (`js/route-planday.js`, the `#wlPlanDate`
  "Planning for" control), and `worklist.js` keys the whole planning path on that
  **plan day** rather than `localDate()`. Four traps:
  (1) **`weekdayOnOrAfter` is a weekend CLAMP, not a "tomorrow"** — it returns a
  weekday unchanged. It was called `nextWeekday`, and that misreading is the entire
  original bug: every phone route was permanently dated today, so an appointment for
  tomorrow landed on Day 2 forever. `nextWorkday` is the one that actually advances;
  (2) **`anchor.date` must be the plan day** — freeze an evening-built plan under
  today's date and `needsCommit`'s `anchor.date !== today` re-plans it at midnight,
  destroying exactly the work this allows;
  (3) **the roll decision reads TODAY's state, the capacity tally reads the PLAN
  day's** — `dayClosed()`/`dayStarted()` answer "is the day I'm standing in spent?",
  while `tallyOn(planDay)` answers "how much room does the day I'm planning have?".
  Swapping either way is silent and wrong;
  (4) **the office owns `routeStartDate` on the sheet** — the phone's implicit pushes
  (`syncWorklist`, the `savePlan` on Download) omit it, and `Code.gs saveWorklistPlan`
  writes the column only when the payload carries one, because `upsertByHeader` leaves
  an unlisted header alone. Default it back to `|| ''` and every logged stop silently
  blanks the planner's date picker.
  Note `applyTodayAnchor` swallows a `scheduleRouteConstraints` throw by design; with
  a user-pickable date that is now reachable (pick Thursday, appointment on Wednesday),
  so the message is parked in `wlPlanIssue` and painted — don't restore the bare catch.
  See ARCHITECTURE.md §"The plan day".
- **The meters/day target is the ONLY thing that sizes a day. Don't add a second one.**
  There used to be a per-installer "Finish by" dial, and `js/route.js` sized a day as
  `min(target, timeCapacity(...))` — how many stops fit before that clock. It was
  reported as "I set the target and nothing changes", and it was right: above the
  ceiling the clock implied, 16, 24 and 40 all produced the same day, with nothing on
  screen saying so. `timeCapacity`, `dayFinishBy`, `breakMin`, `opts.onSiteMin`, the
  `wlFinishBy`/`plannerFinishBy` keys and the tuning dial are all gone. **One clock
  survives and it is a constant** — `config.js ROUTE_DAY_END` — answering exactly one
  question: is today over, so the plan day rolls (`js/route-planday.js`). It must never
  become a routing input again; if a day is too long, the number to change is the
  target. `WorklistPlans.finishBy` stays as a **blank column** because `ensureTab` only
  appends and removing a header would shift every one after it.
- **A field the route reads live must be persisted live — and storing it is only half
  the job; a settled value has to be *applied*.** `targetVal()` reads
  `$('wlTarget').value` straight from the DOM, but the store write hung off `onchange`,
  which fires only on **blur**. Type a new meters/day, background the app, and the
  route was built at the typed number while the box restored the old one — reported as
  "I set it to 20 and it isn't saving", with a route demonstrably built for 20. Any
  control whose value is read live needs its write on `input`. **`wlPace` had the
  identical shape and now matches** — it was left alone once on purpose, because its
  handler also sets `paceSource: 'override'` and firing that per keystroke tangles with
  `refreshAvgDay`'s don't-overwrite rule. The knot is untied by giving the override a
  way *out*: `oninput` persists (guarded to a finite positive number, so a mid-clear
  blank writes nothing over a real value) and a **blank box on `change` reverts** to the
  measured 30-workday pace and drops the override flag. That revert is what makes the
  `input` write safe — with `refreshAvgDay` refusing to overwrite an override, a
  half-typed number would otherwise pin one that nothing on the device ever heals.
  The second half is the target box, and it was **asymmetric**. Day 1 was sized
  `min(dayCapacity(target, installedToday) + anchor.extend, anchor.ids.length)`, so
  **lowering** the target clamped the day down immediately through `capacity`, while
  **raising** it did nothing at all: the frozen anchor set is re-committed only when
  `needsCommit` sees `replan` *and* a changed target — and only an explicit Optimize
  passed `replan`. "They get stuck on a different value and never got updated" was
  literally true for every increase. (That `capacity` clamp is **gone** now — it is what
  shuffled a committed day's tail into tomorrow; see the today-anchor bullets below. So
  neither direction moves without this handler, which makes the fix below load-bearing
  rather than merely asymmetric-fixing.) `wlTarget`'s
  `onchange` now calls `applyTodayAnchor({ replan: true, resize: true })`. **Both flags
  are load-bearing and `replan` alone fixes nothing** — that was tried: `freshAnchorIds`
  prefers the existing `day` tags, and from the box those tags still describe the OLD
  target, so the re-commit froze the same undersized group and Day 1 never moved.
  `resize` is what turns off the tag preference (`opts.fromTags`), sizing the set by
  count instead. Drop either and the asymmetry returns, looking exactly like a target
  that is being ignored. Nothing timed is lost by ignoring the tags —
  `scheduleRouteConstraints` re-imposes appointments and locks straight afterwards.
  Driving a
  re-plan from a text box is safe because `applyTodayAnchor` already carries the guard
  rails a second unfreeze path would have had to re-invent — `freeReplan` (a day with no
  installs *and* no UTIs, or one already closed out, reshuffles freely), `midReplan`
  bounding a started day's **growth** to the `dayCapacity` it has left, and the
  `capacity === 0` skip that refuses to commit an empty set (exempted for a day whose set
  is spent, which needs no such guard and must stay re-plannable — that is how the
  installer asks for more work after finishing the day they committed to). It passes
  `replan` **without** `travel`, so the
  re-split falls back to `estimateTravel` and flags `wlTimesEstimated` (the route view's
  "(est.)"); only Optimize has a real matrix to hand.
- **`havePack` has to mean what the router will do, not what a pointer says.** It was
  `!!activePackId()` — one localStorage id — while `loadGraph` scores every district in
  `installedPacks()` and picks whichever covers the run, *setting* the active id as a
  side effect. A phone holding a district with no active id therefore routed on the
  road graph while the sheet announced "straight-line algorithm", and — the part that
  actually cost something — the offline gate refused the run for want of a map it had.
  It reads `installedPacks()` now. Any new "do we have a map" test belongs there too.
  **It is a precondition, not just a message.** A phone Optimize **tap** with no
  district downloaded is refused outright — it used to fall back to straight-line
  distances, which is a route that looks solved and is blind to every river, dead end
  and bridge, with nothing on screen saying so. `paintOptimizeGate` greys `#wlOptimize`
  and explains why *before* it is pressed. Three things are load-bearing:
  (1) **the two-second HOLD is deliberately exempt** — it skips the pack by design
  (`opts.noLocalGraph`) and asks a router that has the turn restrictions the pack
  lacks, so it is the only second opinion there is; gate it too and a suspect
  on-device route has nothing to check it against;
  (2) **the paint must never set `btn.disabled`** — a disabled button fires no pointer
  events at all, which kills the hold *and* the tap's own explanatory toast. Greying is
  `#wlOptimize.gated` in `css/capture.css` (opacity only, never `pointer-events:none`)
  plus `aria-disabled`; `disabled` on that button belongs to the run in flight;
  (3) **the desktop planner is not gated** — it routes against a local OSRM and has no
  concept of a pack, so `js/pages/planner.js` must stay free of `installedPacks`.
  Pinned by `tests/worklist-optimize-gate.test.mjs`.
- **One stale pin must never cost the whole route.** `scheduleRouteConstraints`
  rejects an order dated before the route starts by **throwing**, and that throw takes
  the entire route with it, not just that order. In `optimizeRouteHandler` it lands
  *before* the writes for `order`/`day` **and** for `legGeometry*` — so the failure
  reads as two unrelated bugs: day sizes frozen at whatever the last good solve set
  (a raised meters/day target appears to do nothing) and a route map that has fallen
  back to straight lines. It shipped exactly that way when the plan day first moved
  off today, because `toggleOrderLock` stamps `lockedDate` from the order's
  `scheduledDate` — so **every existing lock carried the old plan day** and went
  unsatisfiable the moment the day rolled. Two guards, both required:
  (1) `resolvePlanDay` **clamps** back to `soonestAppointment` — the roll never jumps
  over a still-live commitment (an override is deliberately *not* clamped; that
  conflict surfaces as the warning);
  (2) `expireStaleLocks` clears any pending `lockedDate` before the plan day, at the
  top of `refreshPlanDay`, so both the anchor and Optimize see a solvable list. It runs
  **before** the items are read — an `allSorted()` from before the sweep is stale.
  A missed *appointment* (dated in the past) is deliberately still an error: it is a
  customer promise, not a routing hint, so it is surfaced rather than silently dropped.
- **Never schedule a late arrival, and never model the day twice.** Two rules that
  shipped together because one caused the other.
  (1) **The crew's rule is "never late, only early"** — a 30–45 minute wait in a
  driveway is the acceptable price of an out-of-the-way appointment, and being late
  is not. So `placeAppointments` ranks an on-time arrangement above a late one
  *whatever the wait it costs*, and only among on-time arrangements does the least
  waiting win (the latest non-late slot, so the day still stays productive). Invert
  that and a route quietly trades a customer promise for a few meters.
  (2) **Lateness is reported, not thrown.** `simulateDay` records `lateMin` on the
  stop that misses; `errors` is now *only* for input that cannot be scheduled at all
  (an unparseable appointment time). It used to carry late arrivals too, and every
  caller treated a non-empty `errors` as fatal — so one appointment nobody could
  reach took a whole 24-stop route down with it, in `optimizeRouteHandler` **before**
  any write. An unreachable appointment now takes the earliest slot there is and
  carries a ⚠ badge; the crew decides what to do about it, not the solver.
  (3) **`placeAppointments` must price the day the final simulation will walk.** It
  padded empty slots with `__free_k` placeholders, and `travelLookup` has no matrix
  row for a placeholder — so every free leg cost the nominal `pace − onSite` fallback
  and a placeholder in slot 1 cost **zero** drive-out (`simulateDay`'s `i === 0`
  branch). A day of 30-minute legs was searched as a day of 10-minute ones; the slot
  it picked then arrived an hour late for real, and an on-time arrangement was never
  even considered. It takes the day's real free ids now — the anchor set is exactly
  the constrained items, so the free list is known before the slots are picked. Any
  second model of a day is a model that can disagree with the first; this one
  disagreed *optimistically*, which is the direction that fails late instead of early.
  (4) **`wlPlanIssue` is the single staleness signal.** Every failure path leaves the
  last good `scheduled*` fields in place on purpose (a stale route beats no route in a
  truck) — so the flag is what stops them reading as current. It is set by
  `applyTodayAnchor`'s catch **and** by a failed solve inside `optimizeRouteHandler`,
  and it greys the ETA badges on the worklist cards *and* the route view, which is the
  screen the crew actually navigates by. A new surface that shows a `scheduled*` field
  must consult it; one that doesn't is how "the map says 09:55 but the warning says
  10:13" happens again.
- **The day-1 clock is an ETA input and must never become a sizing input.**
  `ROUTE_DEPART_TIME` is where the day *starts*, not where every re-solve of it
  starts — `scheduleRouteConstraints` read `opts.firstStopTime` once and applied
  it to every day, so a route re-optimized at 11:40 arrived everywhere at
  breakfast and `placeAppointments` searched an afternoon against a morning
  clock (the optimistic direction, which fails late instead of early).
  `opts.day1FirstStopTime` overrides day 1 alone, and `js/worklist.js
  day1DepartTime` decides when it applies. Four things to keep straight:
  (1) **the rule is about the ANCHOR, not the hour.** The muster point is a
  *morning* anchor, so an Optimize staged there keeps 08:15 however late it is
  pressed — that press means "show me the day as planned from the depot".
  "Start from here" and every rolling in-day re-schedule are happening *now*.
  This is the installer's call, not an inference;
  (2) **it is `opts.day1Count`'s twin and shares its trap** — absent is unset,
  and `0` is midnight, a real value. Test against null, never truthiness;
  (3) **nothing about day SIZING may read it.** `counts[]`/`capFor` are deliberately
  untouched. A clock that reaches sizing is the finish-by dial coming back under a
  new name — see the meters/day bullet above. (`dayCapacity` no longer sizes anything
  either; it only bounds how far a deliberate re-plan may grow the day.);
  (4) **the day divider must use the same clock its badges did**
  (`wlDayEta` → `dayDurationMin`), or the header announces ~8h over a route the
  ETAs under it plainly show as four.
  The rolling half needs two more things, and each fails silently alone:
  `applyTodayAnchor`'s write guard now compares `scheduledEta` as well as
  position and date (a moving clock changes the ETA of a stop that has not
  moved, and the old guard skipped exactly that write); and `estimateTravel`
  anchors on `lastDonePin` — the pin of the most recently completed order —
  rather than the muster point, because after the first stop the next drive
  starts from the driveway the crew is parked in, not the depot. That one is
  gated on `planDay() === localDate()`: an evening plan for tomorrow starts at
  the depot like any morning does.
- **The pace gauge's denominator is the ROUTE. The target sizes the day; it does
  not judge it.** `js/compute/estimate.js paceFor` has `onPace: routeShort <= 0`,
  full stop — "will I finish the stops in front of me?" The caption's quiet second
  half is the one thing the route cannot say, and it reads **both ways**:
  `targetShort` ("· 6 under your 24") and `targetOver` ("· 4 over your 24"), at most
  one of them non-zero. `targetOver` exists because the target no longer trims the
  day — *"if I install extra this should just show that I'm ahead of pace"* — and
  without it the footnote simply vanished at the moment it had the best news to give.
  This is the same rule as the meters/day bullet above, applied to the gauge: the
  target's whole job is upstream, deciding how many orders sit on Day 1 when the day
  is **planned**.
  **It was briefly the other way round. Don't redo it — but the rebuttal below was
  also wrong, so don't reuse that either.** The argument for inverting was that Day 1
  "moves underneath the answer" because it is re-sized to `target − installed`. The
  rebuttal ran: Day 1 is `min(capacity + extend, |anchor.ids ∩ pending|)` and a
  completed install drops **both** terms by one, so their sum holds still all day.
  **That is only true at one meter per order.** A two-meter order, or any walk-up,
  drops `capacity` faster than membership — Day 1 really did move underneath the
  answer, and the same arithmetic is what shuffled a committed day's tail into
  tomorrow (see the today-anchor bullets). Day 1 no longer re-sizes at all now, so the
  sum genuinely does hold still and the conclusion stands on its own feet.
  `routeShort` reports being behind perfectly
  well. The two readings are also the *same number* whenever the list is long
  enough to fill the target (`target − done − willDo = pendingCount − willDo`), so
  the change bought nothing except in the one case where it actively hurt: a route
  **shorter** than the target, where it announced "16 short of 24" to a crew with
  four orders left in the world. The field report behind the detour — *"it always
  says I'm on pace"* — had a second and sufficient cause, the next bullet.
  Three traps: the meters/day number is returned **once, at the top level** —
  `paces.target` is already the finish-by *horizon*, and `paces.target.target`
  would be two meanings of the word one dot apart; `done` (PRINTABLE, so UTIs and
  walk-ups count) can exceed the stops the route ever held, which is a good day and
  a bar clamped at 100%; and **`todayPending` filters to `day === 1` strictly, not
  the lowest day present** — a day whose committed set is finished leaves Day 1 empty
  with days 2+ still full, so a min-day
  read hands the gauge *tomorrow's* chunk (today's installs captioned against a
  route nobody is driving, and a "Route done ~" clock for it). It used to arrive the
  other way too — target met ⇒ capacity 0 ⇒ everything stamped day 2+ ⇒ the card gone
  mid-afternoon with work still in front of the crew; that path is closed. Empty is correct
  there: `drivePace` returns null and the card hides.
- **A CONSTANT may be printed by `clockLabel`. Anything DERIVED may not.**
  `js/compute/estimate.js clockLabel` is a bare 12-hour readout — no meridiem, no
  day. That is fine for the two horizons it was written for (`3:45`, `4:45 OT`),
  which are compile-time constants that cannot leave the afternoon. It is wrong for
  `routeFinishMin` (`now + travel + stops × on-site`), which has **no ceiling**: it
  shipped that way and a real **23:29** printed as `11:29` on a card the crew was
  reading at 11:36 in the **morning**, reported as the finish clock running
  backwards. 24:15 printed `12:15`; 35:29 would print `11:29` again. Derived clocks
  go through **`finishLabel`** (am/pm always, `+Nd` past 24 h). Two things to keep
  straight: the rest of that card was **already honest** — `routeFinishMin >
  pace.horizonMin` fired and painted it amber against the true 23:29, so the styling
  is not a cross-check on the text and never was; and the clock is **reported, not
  clamped** (`tests/estimate.test.mjs`) — landing at 5:40 is the thing worth knowing,
  so a fix that hides a late number is the wrong fix.
- **Today's cadence is a MEDIAN, because a day is a handful of gaps and one of them
  is the hold-up.** `onsitePerStopReal` averaged the day's WO→WO gaps, so a morning
  of `[25, 25, 175]` — three installs, then a long wait, then the 4th at 10:30 —
  measured **75 min/stop** for a crew doing 25. It does not settle, either: every
  later projection re-reads the same day, so one wait wrecks the gauge until
  midnight. Reported as *"at 10:30 it said I'd only get 3 more done, when I'd already
  done 3 and had the whole day left."* The arithmetic lives in
  `js/compute/cadence.js` (pure, so it is unit-tested against a real day rather than
  regex'd out of `worklist.js`). Three things: **the median must not become a mean
  again with a trim bolted on** — the spine trims by *residual* against distance
  (`installerOnSiteFit`), which needs a regression this has no room for; **logged
  downtime is netted out first but is NOT the fix** — the call used to pass `[]`
  where `computeGapsLocal` takes the day's rows, which was a plain inconsistency with
  `capture.js`, but a hold-up is usually only written down at end of day if at all,
  so the median has to stand alone; and **today still beats history** — the fallback
  when there are no gaps yet is `dwellShape().base`, never a zero.
- **`avgMovingSpeed` is not a driving speed, and the guard that assumed it was cost
  three stops.** `routeTravel` priced the remaining legs at
  `liveMetrics().avgMovingSpeed` behind a `speed > 1` m/s check — 3.6 km/h, which
  catches a phone that never moved and nothing else. But that average is distance ÷
  (elapsed − idle) with "idle" at or under `IDLE_SPEED_MS` = **1.8 km/h**, and the
  recorder runs whenever the PWA is open, *including while the crew is on foot at a
  meter*. Walking a property at 4 km/h counts as moving, so a rural day driven at
  60–80 reported **18 km/h** and priced 18 remaining legs at 2¼ hours instead of 45
  minutes — ~90 minutes off the afternoon and onto the finish clock.
  `MIN_BELIEVABLE_SPEED_MPS` (25 km/h) is the floor; below it the nominal
  `ESTIMATE_SPEED_KMH` prices the route. **Do not "fix" this in `avgMovingSpeed`
  itself** — raising `IDLE_SPEED_MS` or gating the recorder changes the leg summary
  uploaded to `DriveTracks`, which the map viewer and `installerOnSiteFromTracks`
  both read. The floor is local to the projection on purpose.
- **A second device logs nothing, so nothing on it invalidates the day cache.**
  The whole pace projection — and `dayCapacity`'s `installedToday` — reads
  `dayCache[`name|today`]`, which only `cacheRecentDays` fills, and that ran at
  page load and on reconnect only. The crew logs on a work phone and drives by a
  second one; the drive phone believed all day that zero meters were installed,
  which is the other half of "0 of N · on pace". `wlDownload` now refreshes
  **before** `applyTodayAnchor` (a refresh after it would size the day off the
  stale copy), and `drivePace` refreshes on its own 3-minute throttle — drive.js
  repaints every 4s, and re-fetching that often is as wrong as never. **The cache
  key is `${cfg().name}|${date}`**, so the whole thing is inert if the two phones'
  Settings ▸ name differ by a space; check that before debugging anything else.
- **An ETA has two halves, and `opts.dwell` is as easy to forget as `opts.travel`.**
  `simulateDay` walks `arrival = previous departure + drive`, `departure = arrival +
  on-site`. `opts.travel` answers the drive; `opts.dwell` (`js/route-dwell.js`)
  answers the on-site — and like `travel`, a caller that omits it **silently** gets
  the old flat `pace − 10` guess with no error to notice. Every optimize path passes
  both, and `timeCapacity` must take the same model's `average()` as `opts.onSiteMin`,
  or the day target stops describing the ETAs it sized. Five traps:
  (1) **`extraMeterMin` is not floored at `MIN_ONSITE_MIN`** — a 2nd meter at an
  address the crew is already parked at really does take a couple of minutes, and
  flooring it re-introduces most of the error the tier exists to remove;
  (2) **`simulateDay` pads short days with `__free_k` placeholder ids that have no
  item** — those must price at `dwell.base`; zero makes a half-empty day look like it
  finishes early, and throwing breaks appointment placement;
  (3) **the spine's outlier trim is by RESIDUAL, not by gap minutes** — the slowest
  gaps are mostly the longest drives, so trimming those shaves the far end off the
  distance distribution and pushes the intercept (the shipped number) the wrong way;
  (4) **`Code.gs siteKeyOf` is a hand copy of `siteKey`** and a drift between them
  fails in the worst available way — the spine keys history one way, the phone looks
  it up another, no error and no wrong number, the feature just never fires.
  `tests/route-dwell-parity.test.mjs` evaluates the real Apps Script source to stop
  that. Adding a dwell column also means adding it to `installerMetricsRead`'s
  `boat*`/`land*` projection, which the phone reads *through*;
  (5) **a column appended to a live `InstallerMetrics` sheet arrives
  date-formatted**, because Sheets copies the format of the column it lands beside
  and on that tab the neighbour is `updated`, a datetime. This is not cosmetic —
  `getValues()` returns a **Date** for a date-formatted cell, so a stored `28` left
  `doGet` as `"1900-01-27T…"`, `Number()`'d to `NaN` in `route-dwell.js`, and the
  phone silently kept the pace guess. The entire measured-dwell block shipped that
  way, and the repair in `setupSheets()` had already been written *once* for the
  recent-30 block — as a literal list of three header names that nobody extended.
  It is a deny-list now (`INSTALLER_METRICS_DATE_HEADERS`: every column but the
  three real dates), so the next appended block is covered on arrival. Keep it that
  way; a number format on a text cell is a no-op, so over-reaching is the safe
  direction and naming the numeric columns is the direction that fails silently.
  Anything appended still needs `setupSheets()` run once to repair rows already
  there — the values are correct, only the format is wrong, so there is nothing to
  backfill.
  See ARCHITECTURE.md §"On-site time (dwell)".
- **The phone measures its own roads now — and the press picks the ladder.**
  There are three entry points into `optimizeRoute` and each has its own order:
  **phone tap** = road graph → straight-line (free, offline, never a network
  matrix); **phone hold** (2s) = Google Routes → ORS → straight-line, with the
  road graph **skipped outright** (`opts.noLocalGraph`); **planner** = local OSRM
  → ORS → straight-line (`opts.osrmUrl`, never Google). `js/roadgraph.js` is a
  pure, DOM-free router over a downloaded district pack and returns the **same
  `{D, T}` shape `osrmMatrix` does**; keep that contract or every caller
  downstream breaks. Five traps:
  (1) **the repair pass in `localGraphMatrix` is load-bearing** — an unreachable or
  un-snappable stop comes back `Infinity` and would poison the solve, so those pairs
  fall back to crow-flies individually and the run reports it in `note`;
  (2) **`maps/*.pack` must never enter `sw.js`'s `SHELL`** (see the `sw.js` bullet);
  (3) **a new routing provider string must be added to `js/planner-services.js`** —
  both the display-name map and `createLastRunRecord`'s allow-list whitelist
  providers, so an unlisted one is silently recorded as `haversine` forever;
  (4) **two callers opt out of the graph, for the same underlying reason** — the
  pack has no turn restrictions. The planner (`opts.osrmUrl`) has a real OSRM that
  does; the phone's hold (`opts.noLocalGraph`) is how a crew reaches one. Both
  opt-outs are deliberate: fold either back in and the gesture stops meaning
  anything inside a downloaded district;
  (5) **the hold is refused offline** (`optimizeRouteHandler` in `js/worklist.js`)
  — it skips the pack by definition, so with no signal it can measure nothing at
  all. The toast has to point at the tap that would have worked. The pack also carries an **address
  index** (v2), wired into `geocodeOne` as provider −1 ahead of Nominatim/Google/ORS;
  a miss falls through to them, so it is an accelerator and never a hard dependency.
  **`normalizeStreet` must behave identically on both sides** — the builder normalizes
  OSM's `addr:street`, the phone normalizes what was typed — and its positional rule
  is load-bearing: a suffix expands anywhere *except* the first word, so "Concession
  Rd 4" matches while "St Andrews Rd" (Saint) isn't mangled into "street andrews
  road". Pack format changes mean bumping `PACK_VERSION` in `js/roadgraph.js` (the
  tool imports it) — `tests/roadgraph.test.mjs` builds its fixtures through the real
  writer, so a one-sided change fails there rather than in the field. There is
  deliberately **no v1 reader**: nothing was ever published, so a rebuild beats a
  compatibility branch carried forever.
- **The planner builds districts through a local helper, not in the page.** A web
  page can't run Docker, so `tools/roadpack-server.mjs` does — probed like OSRM and
  Nominatim, and the Districts panel **hides entirely when it isn't running** (it is
  needed to make a district, never to plan a route). Three things there are security
  posture, not style: it binds to **127.0.0.1 only**, every child process is
  `spawn`ed with an **argument array** rather than a shell string, and the district
  id is validated against a strict slug before touching a filename or a git command.
  **Publishing is a separate, confirmed button** because it pushes to `main`, which
  deploys the whole app; it only ever stages `maps/`.
  Two things it got wrong the first time, both invisible until a real Build ran:
  **there is no official osmium container.** `osmcode` publishes none, so the
  `ghcr.io/osmcode/osmium-tool` the server named never existed and every build died
  on `denied` from the registry before osmium ran. It is `iboates/osmium:1.19.0`
  now (community-maintained, pinned, overridable with `--image`), and **that image's
  `ENTRYPOINT` is already `osmium`** — the argv starts at the subcommand, so a
  different image may need the word put back. And **`--data` is only checked when
  a build runs**: a folder that doesn't exist, or holds no `.osm.pbf`, used to look
  like a working panel until the job failed minutes later. `/build` now rejects it
  up front and the panel disables Build with the reason, but the flag is still the
  first thing to check when a district won't build — `curl localhost:8790/status`
  prints the resolved `data` and `pbf`. On this machine the extract lives in
  `D:\osrm`, the same folder mounted into the OSRM and Nominatim containers.
  The panel also **extends** and **removes** districts, and three things there are
  easy to undo by accident: (1) **extend rebuilds the same id over
  `unionBbox(old, drawn)`** — a district is one rectangle, so the id input locks
  while extending, because a changed id builds a second district instead of
  growing the one on screen; (2) **`/remove` is local until Publish**, and a phone
  that already downloaded the district **keeps** it — unpublishing tidies the
  office catalogue, it does not reach into a crew's phone; (3) Publish is gated on
  `status.git` alone and **not** on the district list being non-empty — removing
  the last district leaves a deletion that still has to be published, and gating
  on the list disabled the very button that ships it.
  **Leaflet does not wrap longitude, and that broke builds.** Pan the planner map
  sideways onto the next copy of the world and every `latlng` comes back offset
  by ±360, so a rectangle over Parry Sound posts as −440 rather than −80. osmium
  rejects it (`wrong format for coordinate`) and the failure carried the CLIPPING
  step's label, which read as "outside the province" and only happened after a
  sideways pan. `normalizeBbox` wraps at both ends now — the planner where the
  box is made, the server on the way in — so keep any new source of a drawn box
  going through it. The rectangle is then **trimmed** to the extract's own header
  bbox (`/status` `pbfBbox`, one cached `osmium fileinfo`). Trimming is necessary
  but not sufficient: Geofabrik's bbox is a rectangle around a province that is
  not one, so a corner of it holds no Ontario roads and the build still fails —
  deliberately with a message about the rectangle, not `buildPack`'s "wrong input
  file?", which is the wrong diagnosis there. **The build's scratch files are
  deleted in a `finally`**: a failed build is the one that leaves the most behind,
  and on a real district that is hundreds of megabytes in the OSRM data folder.
  The progress bar is **weighted, not step/total** (`BUILD_PHASES`): the clip
  scans the whole extract and measured ~79% of a small district's build, so equal
  steps parked the bar on 1/9 for most of it — which looks exactly like the hang
  the bar exists to disprove. `pct` is work *behind* you, so it is honestly 0
  during the clip; the moving stripes on the track are what show it is alive.
  A phase renamed on one side only silently stalls the bar —
  `tests/districts.test.mjs` checks every `onPhase` name is in `BUILD_PHASES`.
- **Directions come from the pack, and the pack has no turn restrictions.**
  `js/directions.js` builds turn-by-turn from `pathDetail`'s segment list plus
  pack v3's road names. It can say the geometry turns left; it **cannot** say
  the left turn is legal — same reason the planner still uses a real OSRM. Any
  UI that shows these has to say so. Four traps: road names are stored **raw**,
  not through `normalizeStreet` (a driver reads them, so "Muskoka Road 3" must
  not become "muskoka rd 3" — the address index's normalization is the opposite
  requirement); **a road that bends is still one road**, so same-name legs merge
  through anything short of doubling back, or a curving concession becomes a
  stack of 30 m "bear right" steps; the three tidying passes in
  `buildDirections` each came from real output and each has a test, so don't
  drop one as redundant; and `pathDetail` must not push the arrival segment
  twice when the target sits on the segment the route arrived along, which
  produced a phantom U-turn onto the road just joined.
- **Road lines survive a reorder because the phone re-measures them, not
  because the saved ones are trusted.** Saved `legGeometry*` is keyed to the
  sequence it was fetched for, and both maps refuse to draw it once the live
  order diverges (`variantMatchesLive`). That gate is right — drawing it anyway
  traces the *previous* route's roads — but it is all-or-nothing, and on the
  phone it fired constantly: `applyTodayAnchor` re-leads the pending list after
  **every logged stop** (`planAdvance`), not just on a drag, so a crew holding a
  perfectly good district watched their route collapse to straight lines by
  mid-morning while the correct polylines sat unused in IndexedDB. The fix is
  `offlineRoutePaths(legs)` in `js/route.js`: the route view calls it with the
  legs it is **about to draw** and gets paths measured for that exact sequence,
  so staleness is structurally impossible. Three things to keep:
  (1) **the precedence is measured → saved → straight**, and the saved tier still
  needs its `variantMatchesLive` gate (it is the planner's OSRM path on a phone
  with no pack of its own, and it can still be stale);
  (2) **`legKey()` is exported for both sides** — the caller building the leg
  list and `buildRouteMapModel` consuming it must agree, and a silent key
  mismatch degrades to straight lines rather than erroring;
  (3) **the drive-out's saved polyline is read even when the gate is shut**,
  because its first point is the only record of where the crew start *is* — the
  crew start is not an order and has no row of its own. Only its shape is
  re-measured; a first stop that carries no saved drive-out draws no start pin,
  which is deliberate (no pin beats a wrong one).
- **A pack format change means every district is rebuilt and republished.**
  `PACK_VERSION` is 3 and there is deliberately **no reader for older packs** —
  a v2 pack now throws on decode, which `roadpack.js` treats as unusable. Bump
  it only together with rebuilding and publishing every district in `maps/`, or
  crews lose offline routing until they re-download. The Settings picker's ↻
  marker is what tells them to.
- **A truncated road export used to build a smaller district silently.**
  `eachFeature` counts unparseable lines and `buildPack` threw that count away,
  so a geojsonseq cut short — suspected cause, a Docker bind mount on Windows
  not flushed to the host when the container exits — produced a pack missing
  roads with nothing said. It is fatal now. If a district's node count looks far
  too low for its area, that is the failure to suspect; rebuild and compare.
- **A phone can hold several districts and picks one per run.** `loadGraph(coords)`
  scores installed packs on bbox hits (`pickPack`, pure, in `js/districts.js`) and
  decodes only the winner. Three traps: it scores **descriptors, never decoded
  graphs** (decoding each candidate is the cost the one-graph rule exists to
  avoid); a run with no usable coords must still fall back to a real pack, or a
  phone with a perfectly good district declines to the next matrix provider; and
  a **known-bad pack is filtered out before the scoring**, or one corrupt district
  wins the run and hides the good one beside it. `js/districts.js` is in `SHELL`
  and its absence there means phones keep the old single-pack behaviour silently.

- **Spine reads are cached at two levels (`Code.gs` `rows()`).** Per-request memo (`ROWS_MEMO`) for every tab, plus a cross-request `CacheService` copy for the small slow-changing tabs (`Employees`/`Teams`/`Captains`/`Subs`/`Metrics` — `CACHED_TABS`). **Any code that writes a tab must call `bustRows(tab)`** (the shared helpers `upsertByHeader`/`upsertDayRow`/`deleteDayRows`/`setDayFields`/`ensureName`/`deleteName` already do) or a read later in the same request — or a roster read for up to 6h — sees stale data. Don't add big/hot tabs (`Stops`, `Downtime`, …) to `CACHED_TABS`: they exceed the 100KB/key limit and are written on every log.

- **Timestamps can have a single-digit hour.** Some `Stops` rows in the Sheet store `"2026-06-27 9:13:44"`, not `"09:13:44"` — the frontend `stamp()` emitted an unpadded hour in some engines (padded from 2026-06-28 onward, but existing rows stay unpadded forever). This silently broke morning data twice: (1) time parsers that required two digits (`secOfDay`, `parseLocal` in `Code.gs`; `clockOf`, `parseLocalMs` in `js/time.js`) returned null and dropped every pre-10:00 stop from the gap/travel math; (2) `localeCompare` on the raw timestamp sorted `"…8:52"` *after* `"…11:11"` because `'8' > '1'`, so morning work-order cards rendered near the end of the list. All hour parsers now use `\d{1,2}` and card sorts use `parseLocalMs()`. **Never lexicographically compare a timestamp, never `slice` fixed offsets out of the time part, and assume the hour may be one digit.**

- **Client-side storage is IndexedDB (`js/idb.js` + `js/daycache.js`).** **Storage policy: durable offline state lives in IndexedDB, not `localStorage`.** One DB `meterlog`, **six** stores: `queue` (un-synced writes — the system of record), `dayCache` (the storage-first local copy of the day's orders, key `"name|YYYY-MM-DD"`), `worklist` (the installer's locally-built planned orders), `addrCache` (coord→address cache, key rounded `"lat,lng"`, for offline geocoding), `driveTracks` (Drive-mode leg segments, keyPath `id` — checkpointed each fix (`active`/`queued` flags) and held on the phone; uploaded at end of day (`finishAndUpload`), with a previous un-closed day's leg shipped on next open by `recoverStale`; see ARCHITECTURE.md §"Drive mode"), `roadPacks` (downloaded offline road maps, keyPath `id`, one row per district holding the pack `ArrayBuffer` — megabytes, which is exactly why they are here and not in the `sw.js` shell; see ARCHITECTURE.md §"Offline road maps"). **Adding a store means bumping `DB_VERSION`** in `js/idb.js` (now 5) and adding it in `onupgradeneeded` guarded by `contains`. `localStorage` holds only trivial synchronous config (name, H#) read by `cfg()`/`store`. **Cached records are schema-agnostic:** `applyOptimisticCache`/`reconcileCache` store the whole `addStop`/`addDowntime` payload via spread (`dataOf` strips only `token`/`action`/`_seq`), so **adding a new datapoint to a stop caches automatically** — no per-field code to update. Logging is **storage-first**: `enqueue()` writes the IndexedDB `queue` *and* `applyOptimisticCache()` updates `dayCache` immediately (seeding an empty day copy if none exists), so a stop survives offline before it reaches the Sheet. A server pull (`loadDay`) **merges** instead of clobbering — server wins by `id`, still-pending local rows (`_tempId`) are overlaid. **Retention:** `pruneDayCache(keepDays=8)` runs on load, dropping `dayCache` entries older than ~a week. **Recent days:** `cacheRecentDays(7)` pulls the installer's own last week via the `range` GET into `dayCache`; the "Recent days" sheet reads it (offline-viewable). The **end-of-day travel review is offline-capable**: `computeGapsLocal` (`js/compute/gaps.js`) derives the WO→WO gaps from cached stop timestamps, with in-progress deductions + bookends stashed in `dayCache.eodTravel` (cleared once `saveTravel` syncs); an offline Finish queues `saveTravel`+`saveDay`+`endOfDay` and renders the PDF on the device from the cached day (no connection needed — see §"Daily-log PDF"). The `worklist` is fully editable offline; an order is marked done when its WO# is actually logged (`markWorklistDone`); it syncs across devices **only** via the screen's explicit ⇪ Upload / ⇩ Download buttons (whole-list replaces against the `Worklist` tab, direct `apiPost`/`apiGet` — never the offline queue; offline they just toast). A one-time `migrateLegacyQueue()` drains any old `localStorage['queue']` into the store on first load.
- **Removing a stop is a move, not a delete — and its failure modes are deliberate.** `archiveStop`/`restoreStop` append the copy **before** deleting the source (crash duplicates, never loses). `updateStop` and `archiveStop` return **terminal `{ok:true, archived|missing}`** for an id that's gone — do not "fix" that back to `{ok:false}`: it's what keeps a phone's FIFO queue from wedging forever on a stop the office removed. The closed-day rebuild (`regenerateDayRows`) intentionally **skips** `Days`/`BoatDays`/boat-dispatch and preserves the Tracker row's `weather`/`notes`/`workType` — calling `endOfDay` instead would clobber those and overwrite the historical BoatDays crew snapshot. Phone removals tombstone the id in `dayCache.removedIds` (cleared on server ack) so a racing pull can't resurrect the stop. Leftover gap-tagged travel deductions that straddled a removed stop stop matching any gap — re-open the travel review on a reviewed day; a boat partner's closed day is *not* regenerated (re-close it from edit.html if it matters).
- **Offline geocoding (`js/geocode.js`).** Reverse-geocoding can't be fully offline (would need bundled map data), so it's **cache + backfill**: `resolveAddress(lat,lng)` returns a cached coord→address instantly (works offline), else hits the spine `geocode` when online and caches the result — so a repeat island resolves offline after its first online visit. A stop captured offline keeps its GPS with a blank address; `backfillAddresses()` (run on reconnect) resolves those and posts an address-only `updateStop`. Hand-typed addresses are also cached on log.
- **Offline queue mechanics (`js/queue.js`).** Writes are appended to the IndexedDB `queue` store (`enqueue` → `flush`) and retried when `navigator.onLine`. The store's auto-increment `_seq` key gives FIFO order (head = `q[0]`); `_seq` is internal and stripped before the POST. The queue is page-agnostic — a page registers UI side-effects (the duplicate/conflict notice) via `setQueueHooks`. The service worker (`sw.js`) deliberately lets the POST to the Apps Script URL hit the network and fail when offline so the queue owns retry — do not add the endpoint to the SW cache. `flush()` is **re-entrancy-guarded** (`flushing`) and only deletes an item on a genuine success (`resp.ok` **and** a recognized `{ok|duplicate|flagged}` body); an HTTP error, quota/timeout page, or transient `{ok:false}` is **kept and retried**. **A permanently-rejected write no longer wedges the FIFO.** flush() used to stop at the first non-delivered item, so one write the spine *always* rejects (a non-transient `{ok:false}` — an unknown/legacy action, a validation like OTHER-downtime-needs-a-note, a malformed body) stalled every write queued behind it forever. `classifyFlush` (pure, in `js/queue-policy.js`, unit-tested) now sorts *transient* from *definitive*: a definitive reject is retried `MAX_FLUSH_TRIES` (6) times then **parked** (`_parked` flag) so the rest of the queue keeps draining. Parked items are never dropped — they stay in the durable queue, are surfaced (the pill's “N stuck”, plus a notice), and are un-parked + retried by tapping the status pill (`retryParked`). Lock contention (`busy, retry`) and HTTP/transport failures are transient and never counted toward parking. The pill now also tells a genuinely-offline phone from a spine that isn't answering — `navigator.onLine` for the *label only* (it's reliable when true, so a stuck-false reading only keeps the old “offline” wording, never a wrong “online”); the queue behaviour still runs off the real last-flush outcome, not `navigator.onLine`. Queued append writes (`addStop`/`addDowntime`) carry a **client-generated `id`**; the spine's `idExists()` skips a row whose id was already written, so a timed-out-but-succeeded retry no longer duplicates. (Other writes are upserts/replace and already idempotent.) Mutating `doPost` actions run under a `LockService` script lock so concurrent writes stay atomic; `previewDailyLog` (the one POST that writes nothing) deliberately skips the lock so EOD-prefetch traffic never queues behind the crew's real writes. Adding an IndexedDB store means bumping `DB_VERSION` in `js/idb.js` and adding it in `onupgradeneeded` (guarded by `contains`) — separate from the `sw.js` `CACHE` version.
- **`sw.js` caches the app shell** stale-while-revalidate. The `SHELL` list includes the `css/` + `js/` modules — **when you add a new module/stylesheet, add it to `SHELL` and bump `CACHE`** so phones fetch it. **`maps/*.pack` are the one deliberate exception**: offline road maps are megabytes, `refreshShell()` re-fetches everything in `SHELL` on every ⟳ Force update, and putting them there would turn a routine app update into a many-megabyte download on boat signal. They live in the IndexedDB `roadPacks` store instead (which is also why they survive an app refresh). The `js/roadgraph.js`/`js/roadpack.js` modules *are* in `SHELL`. (`map.html` + `js/pages/map.js` + the vendored Leaflet/Chart files are cached too, so the viewer shell opens offline; only the OSM tiles need a connection.) Normal edits to existing files need no bump. **This also bites during local verification:** a browser profile that loaded any page earlier keeps serving the *old* module and CSS from the SW cache, so a fix you just made can look like it did nothing. Unregister the service worker and clear `caches` before re-measuring — see VERIFY.md.
- **The crew's escape hatch for that is Settings ▸ ⟳ Force update from GitHub** (`#refreshApp` in `index.html`, `refreshAppShell()` in `js/pages/capture.js`). The page owns no copy of `SHELL` — it posts `{type:'REFRESH_SHELL'}` (and `{type:'VERSION'}` for the version line) to the worker over a `MessageChannel`, and `sw.js`'s `refreshShell()` re-fetches its own `SHELL` list, 6 at a time, then replies with progress + `{refreshed, failed}`. Three things there are load-bearing and easy to "simplify" wrongly: (1) each fetch is `new Request(url, {cache:'reload'})` — a plain `fetch`/`cache.addAll` goes through the **browser's HTTP cache**, and GitHub Pages serves a `max-age`, so the refresh would re-store the same stale bytes and appear to do nothing; (2) `cache.put` only on `res.ok` and **nothing is deleted first**, so a file that fails on a weak boat signal keeps its existing cached copy and the phone is never left without an offline shell; (3) it touches **Cache Storage only** — never `localStorage.clear()`, `indexedDB.deleteDatabase()`, or `registration.unregister()`, because that would make every installer re-enter their name/H number/sub/home and could drop un-synced queue writes. `tests/cache-refresh.test.mjs` asserts all three.
- **The GPS recorder runs app-wide while the PWA is open, but only while it's in front.** A web app gets **no GPS in the background** — there is no API for it — so the recorder (`js/drive-recorder.js`, an app-level singleton `capture.js` inits once) records on **any** screen but pauses whenever the PWA is backgrounded. During a Google-Maps hand-off the phone backgrounds the PWA and the leg pauses; `visibilitychange` brackets that as an **anchored gap** (pause point + resume point, in the leg's `gaps` array) rather than pretending to have the path. Don't "fix" this by trying to keep GPS alive in the background, and don't draw a gap as a straight driven line — the map viewer renders it dashed on purpose. **Recording is opt-in per day per phone** (stored `driveRecord = {on, date}`, a stale/absent date reads as **off** — inverted from the old opt-out): only the phone where the driver taps **Start drive tracking** records, which is the guard against two phones (capture + navigation) double-recording the same drive — don't make arming automatic or sticky across days. **Uploads are deferred to end of day:** `finishDay` calls `finishAndUpload()` (from `js/drive-recorder.js`) on **both** the online and offline paths before anything else — legs are held on the phone (`queued:false`) and enqueued only there, except a previous un-closed day's leg which `recoverStale()` ships on next open. Don't re-add mid-day `saveDriveTrack` enqueues. **One continuous leg per day, not one per drive.** iOS *kills* a backgrounded PWA during a Google-Maps hand-off (not just backgrounds it), and a cold reopen used to `startSegment()` a brand-new leg each time — a 17-stop day became ~23 fragment legs, all dumped into the queue at once at Finish. `checkpoint()` now also persists the live segment's **`raw`** state (points **with** their `gap` flags, `gaps`, `pendingPause` — which the encoded polyline drops), and `initDriveRecorder()` **rejoins** today's still-open leg (`resumeSegment`) instead of forking a fresh one; `recoverStale()` leaves today's legs for init to decide (it only ships/pruned *previous*-day legs). `raw` is phone-only — it's stripped (`const {active,queued,raw,...leg}`) from every upload path and never reaches the Sheet. `MAX_POINTS` still rolls a very long leg into a fresh one, so a heavy day is a handful of legs by point-count, not one per stop. **A GPS glitch above `MAX_SPEED_MS` (45 m/s ≈ 162 km/h) — a bad device `coords.speed` or a teleported fix — is dropped at ingestion (`addFix`/`markResume` in `js/drive-track.js`)** so it can't inflate `maxSpeed` (the field once saw 1207 km/h) or add phantom distance; `segmentSummary` also caps `maxSpeed` as a belt-and-suspenders guard for legacy/decoded legs.
- **Dates are Toronto-local.** `dateOf()` in `Code.gs` normalizes Date objects, UTC `…Z` strings, and plain local strings to the Toronto calendar date. This is load-bearing — the "end of day all zeros" bug was a date-comparison mismatch. Don't replace it with `String(ts).slice(0,10)`.
- **Identity is split.** Crew are keyed on the employee "H number" in `Employees`; the boat-team auto-fill (`endOfDay` → `teamHeader`) joins on H number and is collision-safe. But `Stops`/`Tracker` rows are still filtered by **display name** (`sameName`), so same-name installers can still collide there (`Worklist` is the exception — its sync is keyed on H number). Keep this distinction in mind before "fixing" attribution.
- **`status: "DONE"`** is a coordinates-only "already installed here" marker (the one-tap button). It is intentionally excluded from install/UTI tallies, the daily PDF, and the viewer counts — it only feeds the `nearby` proximity check. It is just `addStop` with `status:"DONE"`; do not add an endpoint for it.
- **`Teams.memberLetters`** is a JSON map `{hNumber: "A"}` stored as a string in one cell. People sharing a letter on a boat are partners; `boatTeam` renders as boat number + letter (e.g. `11A`). `parseMemberLetters` tolerates a legacy JSON-array form.
- **Captains/Subs are not employees** — free-text names, no H number, stored in their own list tabs and auto-remembered via `ensureName` whenever a team is saved. An installer with no team can pick their **own** sub in the capture page's Settings — stored as `Employees.subName` (rides `saveEmployee` only when the payload carries the key, so admin saves never blank it); a team's `subName` always wins over it (reports grouping + the daily-log "Sub:" fallback both follow that order).
- **Route timing has two sheet-backed references, and times are road-only.** The desktop planner (and the phone) route toward each installer's **home** (`Employees.homeAddress`, the end-of-day bias) — the route runs furthest-meter-first, then works inward toward home. The crew's **team start** (`Teams.startAddress`, the 08:00–08:30 morning muster point) is **ETA-only: never an ordering anchor.** It stays in the distance/duration matrix so the drive OUT to the day's first (furthest) stop can be timed (the first work order's ETA = depart + that drive), priced (`homeLegMetersFor`), and drawn (the faint dashed drive-out line + start pin), but it does **not** pin where the route begins — `solveVariant` drops it from the ordering matrix when `startIsCommute` (a team start). Only a phone GPS "start from here" (`startFromCurrent`) still anchors the route at your current fix. Both are appended columns (`ensureTeamsColumns`/`ensureEmployeesColumns` create them on save; geocoded lazily by the planner/phone, not the admin page). ETAs are built from a **duration matrix `T`** (`measure.T`, `travelLookup`): `route-constraints.js` adds real travel + `onSiteMinutes(pace)` and `timeCapacity` sizes each day so the target lands by ~14:00 (fewer stops when travel is heavy). **Every source now carries `T`:** OSRM (planner) and — as of the durations work — **Google Routes** (`duration` in the FieldMask) and **ORS** (`metrics:['distance','duration']`) return real minutes, and when no road matrix is pulled (the phone's free straight-line default, or a fallback run) `optimizeRoute` **estimates `T` from the distances** (`estimateDurations`, crow-flies × `ROAD_DETOUR_FACTOR` ÷ `ESTIMATE_SPEED_KMH`) and flags `estimatedTimes`. So the phone finally shows crew-start ETAs + workday-sized days even offline — labeled "(est.)"/"~" in the route view. **The phone must pass `travel` (`travelLookup(measure)`, or `estimateTravelFromCoords` on the matrix-less flip/drag paths) into `scheduleRouteConstraints`** — without it the ETAs silently collapse to flat pace (`firstMin + i·pace`, the old "8:15 first stop, no drive-out" bug). (The `T`-in-minutes convention is uniform: OSRM/ORS ÷60 from seconds, Google via `parseGoogleDuration`.) The landing/"expected stops" projection is **one real-data model** (`js/compute/estimate.js` `projectDayReal` + `workHorizon`), shared by the **plan-mode banner** (`renderPlanEstimate`), the **Drive-screen on-pace line** (`drive.js paintPace`), and the **`#tuning` what-if** — so the three never disagree (the old blended-average `projectDay` is gone). It reprojects **today's remaining route** with travel and on-site split (on-site from today's observed cadence via `onSiteMinutes`; remaining travel = pending `legMetres` ÷ the truck's real `avgMovingSpeed`, else 50 km/h), capped at the stops left, and returns **two paces** — the installer's **finish-by target** and **regular hours** (3:45, → 4:45 OT past 4:00 while the day is still open) — plus the top-level **route-finish clock** `routeFinishMin`/`routeFinishLabel` (`now + remaining travel + stops × on-site`, the same three terms `paceFor` inverts, read forward; horizon-independent, so it is deliberately *not* inside a pace). **Two paces in the model, but the Drive screen paints only the regular-hours card** — the target card's horizon is `ROUTE_DAY_END` (4:00), fifteen minutes from 3:45, and it read as the same card twice; `paces.target` stays for the plan banner and the tuning what-if. All three read `worklist.js paceContext`/`drivePace`. **Closing out the day** (`finishDay`) stamps `localStorage['dayClosedDate']` (kills the OT escalation) and exits plan mode (`exitPlan`). See ARCHITECTURE.md §"Drive mode".
- **Day 1 is frozen by the today anchor — don't day-chunk over raw `pending` again.** The multi-day split cuts the *pending* list into `target`-sized chunks, so finishing orders used to let a re-optimize/Download refill Day 1 from the front of what's left — pulling tomorrow's orders up into today. `worklist.js applyTodayAnchor()` (pure helpers in `route-today.js`) now overrides that: it commits a phone-only `localStorage['wlTodayAnchor']` `{date, ids, target}` snapshot of Day 1 on the first route of the day, keeps Day 1 = *committed ∩ pending* via `scheduleRouteConstraints`' `opts.day1Count`, and re-commits **only on an explicit re-plan**. It runs at every point that stamps `day` — after optimize (pass the **real** `travel` so ETAs stay exact), after Download, after `markWorklistDone`, after `resetWorklistOrder`, on first view, and (see below) after **every** logged stop via `planAdvance`. It writes a pending order only when its `order`/`day` actually change (so an exact downloaded ETA survives an unchanged day). If you add a new writer of `day`, route it through `applyTodayAnchor` or Day 1 will drift again. **Reset a work order** (Today's orders ▸ ↺) is `archiveStop` + `resetWorklistOrder` (inverse of `markWorklistDone`, keeps the typed fields) — no new spine action. See ARCHITECTURE.md §"Multi-day split" and §"Removing a stop".
- **The frozen set IS the day. Nothing re-sizes it in the background — and this rule has been got wrong twice, in opposite directions.** *Round one:* sizing Day 1 to the frozen count alone over-corrected — it shrank only as its own planned orders finished, so meters installed **off-plan** (walk-ups, which `markWorklistDone` never sees) consumed none of the day's target and an order added mid-day couldn't join today at all. *Round two, the fix for that:* Day 1 became `min(dayCapacity(target, installedToday) + anchor.extend, |set ∩ pending|)` — which handed the meters/day target a **live governor** over a set the installer had already committed to, and it shuffled the day all day long. The target counts **meters** and the set counts **orders**, so a two-meter order or any walk-up spent the room faster than it spent the list and the tail of a committed day was stamped Day 2 by mid-morning; once the target was *met* with orders still pending, capacity hit 0 and **every** remaining order was stamped day 2+, taking the pace card off the screen with the crew still working; `needsCommit` re-committed the instant the set emptied, hauling the next chunk up into today; and the Drive screen's 5-minute refresh re-ran all of it on a timer. Reported as *"the next day's work orders are shuffling up every time … I download the WORK list when I start my day, I say that I'm going to do X, and I want it to stay at that unless I manually add more for the same day."* **Day 1 is now `day1Count(day1Ids)` — the committed set, entire.** Five things are load-bearing: (1) **the target sizes the day when the day is PLANNED, then lets go**; installing past it reads as ahead (`targetOver` on the gauge, a later `Route done ~`), never as a shorter list; (2) **an exhausted set stays exhausted** — `needsCommit` returns `Boolean(opts.replan)` there, so a finished day is finished until the installer asks; (3) **work joins a day already under way only by hand** — the `#wlAddTo` sheet, an Optimize press, or the office's own day 1 on a Download; (4) `applyTodayAnchor` still runs after **every** stop (`planAdvance`, above the plan-mode guard) — it re-**times** the day now, which is what keeps the remaining ETAs honest and is the whole point of the 5-minute refresh; (5) **`day1Count` 0 is a real value, not "unset"** — `route-constraints.js` tests it against `null`, because a falsy check hands a finished day a whole fresh target. `dayCapacity` survives for exactly one job: bounding how far a *deliberate* mid-day target raise may grow the day (`freshAnchorIds`' `opts.max`). `anchor.extend` is **gone** with the clamp it existed to buy room back from; a legacy record carrying it is ignored. See ARCHITECTURE.md §"The today anchor".
- **The freeze is keyed on the set's identity *and* on the target that sized it.** Identity alone meant a Day 1 committed at 6 meters/day stayed six orders forever — raising the target to 24 changed nothing, re-optimizing could not shift it, and it survived the night, because a new day's commit prefers the `day` tags already on the orders and those were stamped by the target-6 solve. The anchor carries `target` now (`anchorTarget`, `null` for a legacy record) and `needsCommit` takes a fourth reason: a **re-plan whose target moved**. Four traps: (1) **exactly two callers pass `opts.replan`** — `optimize()` and the meters/day box's `change` handler, the only two moments the installer has said "re-size the day". (The target box was excluded at first, on the reasoning that Optimize is also when the tags have just been re-solved at the new target; that left raising the target doing nothing at all, so it is in now — with `travel` still Optimize's alone, so the box's ETAs come back estimated.) **That tag reasoning was correct and is exactly why `replan` alone was not enough**: the box has no fresh tags, so it must also pass `resize` → `freshAnchorIds`' `opts.fromTags: false`, or the commit re-freezes the old undersized group and a raised target still does nothing. `fromTags` defaults **true**, so every existing caller keeps the preference. Every other caller (`planAdvance`, Download, first view, `markWorklistDone`, `resetWorklistOrder`) passes nothing and must keep today frozen; (2) **an Optimize at an unchanged target must not re-commit a set that is still LIVE**, or you have re-created the original bug (finish a few, re-optimize, tomorrow's work walks up) — on a **spent** set the press re-commits whatever the target says, because there is nothing left to protect and that press is how the installer asks for more work after finishing the day they committed to; (3) **a mid-day re-plan's GROWTH is bounded by `dayCapacity`** via `freshAnchorIds`' `opts.max` — and `max` must treat `null`/absent as *unbounded*, since `Number(null)` is 0 and would silently freeze an empty day on the one path that means "no limit"; a day with no installs **and** no UTIs, or one already closed out, is a day nobody has driven and reshuffles freely; (4) **never commit an empty set** — `capacity === 0` on a live day skips the re-plan outright, because an empty anchor makes `needsCommit` fire again on every subsequent call (a spent day is exempt: only `midReplan` passes `opts.max`, and it cannot fire there). A legacy anchor reads as changed on purpose: it is the one-shot that unsticks a day frozen under a target nobody can recover.
- **The route's start location is asked on every Optimize, not armed ahead of time.** The old persistent "Start from here" pill is gone (`askStartLocation` / `#wlStartAsk` replaces it) — a mode you had to remember to set was the wrong shape for a decision that changes with every mid-day re-optimize. It is a **`.sheet` popup**, the app's existing modal idiom, because Optimize blocks on the answer like the `confirm()` it replaced. *Yes, at the muster point* keeps the usual furthest-meter-first-toward-home solve; *No, from where I am* takes one GPS fix as a real ordering anchor so the **nearest** meter is next (the fix for "I hit my target and the next day's first stop is across the map"); Cancel aborts — **and so must a backdrop tap**: `capture.js` hides any `.sheet` on one, so the resolver listens for that click too, or the promise sits pending behind a hidden sheet and Optimize hangs forever. A live GPS start is priced **straight-line only on its own row/column** (`straightLineNode` over `D`, and `T` scaled by `CROW_MIN_PER_METRE`) — between-stop distances keep whatever matrix the run pulled, and the fix never needs to be in the fetched matrix, so it costs no matrix elements. Don't extend that rewrite to a **team** start: its drive-out is shown, priced and drawn, and must stay real road distance.
- **An unattended refresh is not a Download with the prompts removed.** The Drive
  screen refreshes itself from the sheet every 5 minutes while the driver is
  recording, opted into driving stats, and on the screen (`js/drive.js`
  `tickAutoSync` owns the clock + gate, `js/worklist.js autoSync` owns the work —
  ARCHITECTURE.md §"Drive mode"). Everything hard about it is in what a *timer* may
  do that a *tap* may not. (1) **A locally-`done` order must never come back.**
  `syncWorklist()` pushes the phone's list up only right after a log and no-ops
  offline, and **nothing re-runs it on reconnect** — so a stop logged in a dead zone
  leaves the sheet's `Worklist` row saying `pending` long after the meter reached
  `Stops`. The manual Download resurrecting it is a visible mistake the installer
  asked for; a timer doing it silently sends the crew back to a house they already
  did. Hence `applyDownloadedList(..., {preserveDone:true})` on the automatic path
  only, and the done ids are collected **before** the local store is wiped. It also
  skips the pull outright while the offline queue is non-empty — an un-drained queue
  means the phone is *ahead* of the sheet. (2) **No `toast` and no `confirm`, ever.**
  Nobody can answer a modal at 80 km/h, and "Download failed — check signal" popping
  every five minutes through a dead zone is worse than the staleness it reports;
  every failure keeps the last good copy and says nothing. (3) **No `planAdvance()`**
  — it ends in `fillCapture`, and a background timer must not overwrite a half-typed
  capture form; plan mode re-advances on the next logged stop, which is when it
  matters. (4) **`applyTodayAnchor()` is the half that does the work.** "My route and
  times only get right after a Download" is literally true and has nothing to do with
  the payload: nothing in the pull rewrites `order`/`day`/`scheduledEta` —
  `applyTodayAnchor` does. A day-cache refresh alone (`refreshPaceCache`) moves the
  gauge's `done` count and nothing else, which is why pulling stops-only was tried
  first and read as "still stale". Keep `cacheRecentDays(1)` **before** the anchor
  (the projection and the re-plan bound both read that cache) and keep `PACE_REFRESH_MS`
  equal to `AUTO_SYNC_MS`, or the two pulls become two clocks disagreeing about how
  fresh "fresh" is. (5) **`driveShowMetrics` is now a consent gate, not just a HUD
  switch** — it gates network fetching too, so its label in `index.html` and
  USER-GUIDE.md must keep saying so; a gate the driver cannot read is not consent.
  (6) **The interval must not outlive the screen** (`stopAutoSync` in *both* `close()`
  and `teardown()`), and `refresh()` re-matches the card by `destKey` so a re-ordered
  route cannot swap the house under the driver mid-drive.
- **Never `preventDefault()` a `touchstart` to stop text selection.** It cancels *every* native default for that touch, panning included — on Optimize (a full-width 56px button) that made a strip of the worklist the crew could not scroll through: the only way past it was to start the swipe above or below the button. Selection is CSS's job (`user-select:none` + `-webkit-touch-callout:none`; the `#wlOptimize` rule in `css/capture.css`), and `touch-action:manipulation` still allows panning — it only drops double-tap zoom. If a loupe survives the CSS on iOS, guard **`touchmove`**, and only once the press is already judged stationary; a touchmove guard cannot kill a pan that has begun. **And any press-and-hold must abort on movement**, or a finger that lands on the control while scrolling fires the tap command on release: the recognizer for Optimize's tap-vs-hold is `js/press-hold.js` (pure, injectable timers, `tests/press-hold.test.mjs`) — reuse it rather than hand-rolling timers, and note it aborts past 10px of travel and eats the click that follows a pointer gesture so no command runs twice.

## Daily-log PDF

**The PDF is rendered on the phone, not the spine.** `js/dailylog.js` (`renderDailyLog`) draws it with a vendored jsPDF (`js/vendor/jspdf.umd.min.js`, loaded as a classic `<script>` before the page module) — a close reproduction of the old paper template. It takes a `summary` object: online, the spine's `previewDailyLog`/`endOfDay` summary (high-fidelity merged-boat travel); offline, one built locally by `js/compute/summary.js` (`buildLocalSummary`) from the cached day. So **Generate / Close work with no signal**, and there's no Drive archive copy. **`previewDailyLog` must be POSTed the form's `departure`/`returned`.** `buildDaySummary` reads the bookends from the request body, falling back to the persisted `Days` row — but on the phone `saveDay` runs *after* the PDF is generated, so at preview time the `Days` row is still empty; a `previewDailyLog` call that omits the typed times prints a PDF with **blank Start/End** (the offline `buildLocalSummary` path reads the form directly and was never affected). Every caller — `prefetchEodSummary`/`genLog` in `capture.js` and `genLog` in `edit.js` — passes them; `tests/daily-log-bookends.test.mjs` guards it. The team header + whole-boat dispatch (the only inputs the phone can't derive from its own stops) come from `boatMeta`, which the spine returns on every `addStop` and the `day`/`range` reads and the client caches. The `endOfDay` Tracker/Timing/Days/BoatDays writes are unchanged; it just returns the summary instead of PDF bytes. If you change the layout, edit `dailylog.js` (the `HEADER_BOXES` grid + body/footer) — the old `DailyLog Template` tab / `ANCHORS` are gone. **Land days render a different template** (`renderLandDailyLog`, picked by `summary.workType`): header strip + per-WO delay columns + totals row, no travel column — edit `LAND_*` in the same file.

## Security note

`SHARED_TOKEN` and the Web App URL sit in client-side source on a public-capable GitHub Pages site — this is a deliberate, documented trade-off (open-the-link-and-it-works), mitigated by keeping the repo private. Do not treat the token as a real secret, but also do not introduce anything that assumes per-user auth exists.

## Knowledge graph (graphify)

Optional, and **only useful once a graph exists** — `graphify-out/` is gitignored, so a fresh
clone has none. Build it with `graphify .` from the repo root; that writes `graph.json`, a
plain-language `GRAPH_REPORT.md`, and an interactive HTML view. Code is parsed structurally
(tree-sitter AST, local, no API key, no token cost); the ~55 markdown files go through an LLM,
which means the *first* build spends real tokens unless `GEMINI_API_KEY` is set.

When a graph is present:

- Prefer `graphify query "<question>"` over grepping for orientation questions — it returns a
  scoped subgraph rather than whole files. `graphify path "<A>" "<B>"` traces how two things
  connect; `graphify explain "<concept>"` unpacks one node.
- Read raw files freely once oriented, and always for modifying or debugging specific lines.
  This repo is ~32k lines across 171 files; plenty of questions are answered faster by just
  opening the file, and the graph's matcher is literal substring + IDF, so it misses when your
  wording doesn't match the code's.
- Edges are tagged `EXTRACTED` / `INFERRED` / `AMBIGUOUS`. An `INFERRED` edge is a guess and
  reads as authoritative — verify it against the source before acting on it.
- Two git hooks keep it current: `post-commit` re-runs AST extraction on the code files that
  changed, and `post-checkout` rebuilds on a branch switch. Both skip during
  rebase/merge/cherry-pick, and both are code-only. **Doc changes are not covered** — run
  `graphify update .` after editing markdown, or the graph will confidently describe docs
  that no longer say that.

A stale graph is worse than no graph. If what it tells you contradicts the source, the source
wins — and rebuild.

## Tool-specific notes

Everything above applies to every agent. Only these lines don't:

- **Claude Code** reads `CLAUDE.md`, which points here. It may load plugins listed in
  `.claude/settings.json`, honours Bash permission rules in
  `.claude/settings.local.json` (a denied `git push` is that file, not anything in the
  repo), and has `.claude/launch.json` defining a static-server debug config. Its
  `verify` skill at `.claude/skills/verify/` is a pointer to `VERIFY.md`.
  `.claude/settings.json` also carries two graphify `PreToolUse` hooks that inject a
  "query the graph first" reminder before `Read`/`Glob`/`Grep`/`Bash`. They are nudges
  only — nothing is blocked — and they stay silent when no graph exists. They shell out
  to a bare `graphify` rather than an absolute path, so the tracked file stays portable;
  on a machine without the CLI the hook just errors harmlessly. The `/graphify` skill
  itself is **not** vendored here — it comes from the user-level install
  (`uv tool install graphifyy && graphify install`), same as the CLI it depends on.
- **Codex** reads this file directly. The graphify section above applies to it too, but
  the `PreToolUse` hooks are Claude-Code-only; nothing reminds Codex, so it has to
  remember on its own.

Neither tool's config directory should become the home of a project instruction — see
§"Working in this repo" above.
