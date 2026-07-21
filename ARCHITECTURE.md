# Meter Log — Architecture & Data Structures

Digitizing the paper daily log for a hydro meter installer. Fast capture at the
meter on an Android work phone (offline-friendly), durable storage in Google
Drive, automatic running totals, a map + analytics viewer over the data, and
Claude for the formatted daily deliverable + the messy/natural-language bits.

---

## The three layers

**1. Data layer (system of record) — Google Sheets in your Drive.**
One spreadsheet, fourteen tabs: `Stops`, `StopsArchive`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`, `Timing`, `Days`, `BoatDays`, `Dispatch`, `Metrics`, `Worklist`. This is the truth.
It is not Claude and not the form. Everything reads from or writes to it.

**2. Capture + view layer (how data gets in, and how it's seen).**
- The **web form / PWA** (`index.html`) — the capture tool. Runs on the Android
  work phone and any browser, offline-first: it stores stops locally in
  IndexedDB and syncs when there's signal (see "Client-side storage"). Each
  person sets only their **name**; the Web App URL and
  access token live in `js/config.js`, so there's nothing else to configure.
- The **map + analytics viewer** (`map.html`) — a read-only window over the
  data: plots stops by GPS, filters (installer / status / date range), WO#/J#
  search, and trend charts.
- The **crew + teams admin** (`teams.html`) — manages the `Employees` and
  `Teams` tabs: add/remove crew (first name, last name, employee "H" number),
  build boat teams (identifier, boat name/number, captain, members). The
  installer's name picker and the end-of-day auto-fill both read from here.
- The **back-office editor** (`edit.html`) — pick an installer + date, list the
  workorders they logged that day, correct any field (including each stop's
  **arrival time**, via `updateStop`'s `arrivalTime`), set the day's **Departure /
  Returned** bookends (persisted to the `Days` tab via `saveDay`), then **generate
  the daily-log PDF** — which closes the day idempotently (`endOfDay`).
- The **reports page** (`reports.html`) — pick a **sub foreman**, then a date,
  and see that sub's **whole current crew** for the day (an installer's sub =
  their team's `subName` first, else their own `Employees.subName` pick; a
  "No sub foreman" option covers the unassigned). Members who logged show the
  day's core tallies (installed / UTI / delay minutes), a closed/open badge
  (closed = a Tracker row exists), and a **quick "Close day"** button that
  fires a minimal idempotent `endOfDay` — no travel review; the full review +
  re-close still lives in `edit.html`. Members with nothing that day show a
  muted "No logs" line (note: `Teams` is current-state only, so a past date
  lists today's crew makeup). Closed rows read the Tracker row; open rows are
  tallied live from `pins` + the windowed `downtime` read — the whole day is
  fetched once per date; switching subs only re-renders. Linked from the nav
  of the three backend pages only, not from the capture page.
- The **help page** (`help.html`) — renders `USER-GUIDE.md` (the single copy of
  the end-user instructions, also readable on GitHub) via a tiny markdown-subset
  renderer in `js/pages/help.js`; both files are in the service-worker shell, so
  it opens offline. Linked from the capture page's ☰ menu ("❓ Help") and the
  backend pages' nav dropdown. Keep the guide inside the renderer's subset
  (`#`–`###` headings, paragraphs, `-`/`1.` lists, `---`, `**bold**`, `` `code` ``).
- The **desktop route planner** (`planner.html` + `js/pages/planner.js` +
  `css/planner.css`) — the office-side half of land-route planning, desktop-first
  and installable from Chrome/Edge as an app window. Pick an installer (roster,
  keyed on H number), ⇩ Load their saved `Worklist` rows or paste orders in,
  optimize with road distances from a **local OSRM server**
  (`optimizeRoute(..., {osrmUrl})` — free, see DEPLOY.md §"Desktop planner +
  local OSRM"), review the numbered route + connecting line on a Leaflet map,
  then ⇪ Upload (`saveWorklist`). Pins + order ride the sheet, so the phone's
  ⇩ Download lands a finished route with zero phone-side spend. The PC's
  IndexedDB `worklist` store is its scratch copy (cleared per installer switch).
  Linked from the backend pages' nav only, not from the capture page.
- All seven are static files hosted on GitHub Pages. They never store the data
  themselves — they post it / read it and move on.

> The earlier iPhone Shortcuts capture path has been **dropped.** The work phone
> is Android and the web form does everything the shortcuts did — same endpoint,
> same Sheet, cross-platform — with a one-time name entry instead of editing a
> shortcut per person. (`MeterLog-Shortcuts.md` is now obsolete.)

**3. Claude layer (generate + interpret, never store).**
Through the Google Drive connector, Claude:
- generates the **formatted daily log sheet** that matches the paper template,
- writes a **plain-English day/week summary**,
- cleans up **"Other" downtime notes** into tidy categorized entries.
Claude does *not* hold data between sessions and is not the thing that remembers
yesterday — the Sheet is.

---

## The honest part about "Claude automatically updates the sheet"

Two things to know so the design stays solid:

1. **The Drive connector can *create* and *read* files well, but it can't
   surgically append a row to one ever-growing sheet in place.** So using Claude
   to append to the running tracker every day is fragile.
2. **Claude doesn't run on a schedule by itself.** "Automatic" needs a trigger
   (you opening Claude, or a call from the form).

So the reliable design splits the work:

- **Deterministic writes** (append a stop, append the daily total row) → handled
  instantly and for free by the tiny **Google Apps Script web app** bound to the
  Sheet. No server to host. This is the spine (`Code.gs`).
- **Generation + interpretation** (the formatted daily deliverable, summaries,
  messy text) → **Claude via the connector.** This is where an LLM earns its
  place.

You still get "Sheets in Drive store it, Claude makes the deliverables." The
boring row-appends are done by the spine, not Claude — more reliable, instant,
and works even with no signal (queued up on the phone).

---

## Data flow

```
  CAPTURE (Android phone / any browser)      THE SPINE                  THE STORE
                                             (Apps Script Web App URL)  (Google Sheet)

  ┌────────────────────┐                    ┌─────────────────────┐     ┌──────────┐
  │ index.html          │ ── POST JSON ──▶   │ doPost              │     │ Stops     │
  │ web form / PWA       │                    │   addStop           │ ──▶ │ Downtime  │
  │ • offline queue      │                    │   addDowntime       │     │ Tracker   │
  │ • person = H# (self- │                    │   updateStop        │     └────┬─────┘
  │   registration)      │                    │                     │          │
  └────────────────────┘                    │   endOfDay          │          │
                                              │                     │          │ read via
  ┌────────────────────┐                    │ doGet               │          │ connector
  │ map.html            │ ◀── GET JSON ──    │   day  lookup       │ ◀────────┘
  │ map + analytics      │                    │   geocode  nearby   │          │
  │ • pins / filters /   │                    │   pins  tracker     │          ▼
  │   search / trends    │                    └─────────────────────┘     ┌──────────┐
  └────────────────────┘                                                  │ Claude:   │
                                                                          │ daily log │
                                                                          │ + summary │
                                                                          └──────────┘
```

**Write actions (POST):** `addStop`, `addDowntime`,
`dispatchRequest` (Apple Shortcut: log a pending meter request — see "Dispatch downtime"),
`updateStop`,
`archiveStop` (move a Stops row to `StopsArchive` — the "remove from the log"
action on all three surfaces; never a hard delete, idempotent on id, every
outcome terminal so an offline queue always drains; auto-regenerates a closed
day's Tracker/Timing — see "Removing a stop"),
`restoreStop` (move an archived row back into `Stops`; edit.html only),
`endOfDay`,
`previewDailyLog` (return the day `summary` on demand from today's stops **without**
writing a Tracker row or requiring departure/return — the phone renders the PDF
from it; the real `endOfDay` later fills the blanks),
`saveTravel` (replace a day's per-gap travel deductions — see "Travel vs delay"),
`saveDay`,
`saveWorklist` (whole-list replace of one installer's saved `Worklist` rows —
the planning page's explicit **Upload** button; delete-then-append keyed on the
employee **H number** (names can collide, H numbers can't), so a re-upload
never duplicates and an empty upload clears the saved copy; `order` is
**renumbered server-side** 0,10,20… by sorted position on every upload — never
written verbatim — so duplicate/blank order values from old clients can't
round-trip; the nightly `clearDoneWorklistJob` runs the same
`normalizeWorklistOrders()` repair across every installer's rows),
`saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`,
`saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`.
**Read actions (GET):** `day` (one installer's stops + downtime for a date),
`range` (one installer's stops + downtime over a from/to window, grouped by day —
backs the phone's offline "recent days" cache in a single call),
`lookup` (find by WO# or J#), `geocode` (reverse-geocode lat/lng, no API key),
`nearby` ("is a meter already here?" proximity check), `pins` (stops, for
the map), `tracker` (end-of-day rows, for the viewer's trends), `downtime`
(all installers' `Downtime` rows, windowed on the row `timestamp` — backs the
reports page's open-day delay tallies in one call), `timing`
(per-gap `Timing` rows, for the analytics "avg time between meters" metric),
`boatdays` (`BoatDays` rows — the daily boat-crew snapshots — for the viewer's
"avg log→log (boat)" tile, which groups a day's logs by the boat that ran them),
`dispatch` (`Dispatch` rows, for the analytics "avg dispatch downtime" tile).
These five viewer reads accept an **optional `from`/`to`** date window
(`yyyy-MM-dd`, Toronto, inclusive; omitted = the whole tab): `pins` windows on
the stop `timestamp`, `tracker`/`timing`/`boatdays` on `date`, `dispatch` on
`completedTime` falling back to `requestTime`. Remaining reads:
`avgDispatchTime` (a pure read of the stored `Metrics` avg dispatch time, which
the hourly `avgDispatchTimeJob` trigger keeps fresh by pairing every requested
meter to its completed install — see "Avg dispatch time"), `roster`
(the full crew + teams, for `teams.html` and the installer's name picker), `idle`
(team-aware **every WO→WO gap** for one installer+date, each with any deductions
already saved — plus a pre-filled `DISPATCH` deduction on a requested install's
gap — for the end-of-day subtraction step — see "Travel vs delay" and "Dispatch
downtime"), `archived` (one installer's removed stops for a date — edit.html's
"Removed stops" list, so a removal can be inspected and restored), `worklist`
(one installer's saved `Worklist` planned orders, matched on the employee
**H number** and returned **sorted** — order asc, blanks last, createdAt tie —
the planning page's explicit **Download** button, which replaces the phone's
local list with them, renumbering by array position as it lands).

---

## Client-side storage (the phone)

The capture PWA (`index.html`) is **offline-first**, and **IndexedDB is the
durable store for everything that must survive with no signal**. The client logic
lives in native ES modules under `js/` (see "Frontend module layout"); the
IndexedDB wrapper is `js/idb.js` and the day-cache logic is `js/daycache.js`. One
database, `meterlog`, with **four** object stores:

- **`queue`** (keyPath `_seq`, auto-increment) — the **system of record for
  un-synced writes**. Every `addStop` / `addDowntime` / `updateStop` /
  `saveEmployee` etc. is appended here first; `flush()` POSTs the head to the
  spine and only deletes it on a genuine success (`resp.ok` **and** a recognized
  `{ok|duplicate|flagged}` body), so a busy-window failure is kept and retried.
  The auto-increment `_seq` preserves FIFO order; `_seq` is internal and stripped
  before the POST. Append writes carry a client-generated `id` so a
  timed-out-but-succeeded retry is idempotent (`idExists` on the spine).
- **`dayCache`** (key `"name|YYYY-MM-DD"`) — the **storage-first local copy of
  the day's orders**. Logging writes here *immediately* (`applyOptimisticCache`
  seeds an empty copy if none exists), so "Today's orders" / End-of-day show the
  stop instantly and offline, before anything reaches the Sheet. A server pull
  (`loadDay`) **merges** rather than replaces: the server is authoritative for
  rows it knows about (by `id`), and any still-pending local row (`_tempId`,
  not yet acked) is overlaid so a refresh never drops un-synced work — **local
  pending wins** until it syncs, then the server copy takes over. The
  **end-of-day travel review works offline too**: `computeGapsLocal` derives the
  WO→WO gaps from the cached stops' timestamps (the same walk as `computeIdle`,
  so the network `idle` fetch isn't needed to show or edit travel time), and the
  in-progress deductions + Departure/Returned bookends are stashed in the cache
  field `eodTravel` (cleared once `saveTravel` syncs). Finishing the day with no
  signal queues `saveTravel` + `saveDay` + `endOfDay` and **renders the PDF on the
  device** from the cached day (the phone draws it with jsPDF — no connection
  needed; see "Daily-log PDF"); when online the authoritative `idle` overrides the
  local gaps.
- **`worklist`** (keyPath `id`) — the installer's locally-built **planned
  orders** (a personal to-do list). Add / edit / delete all run against
  IndexedDB, so the list is fully editable offline. An order is marked done when
  its work order is **actually logged** (matched by WO#), not at prefill time.
  The list can be moved between devices via the sheet's `Worklist` tab, but only
  through the screen's explicit **Upload** / **Download** buttons — manual,
  whole-list replaces in both directions (`saveWorklist` / `?action=worklist`),
  called directly (never through the offline queue: with no signal they toast
  and do nothing), keyed on the installer's **H number** so same-name installers
  can't collide. The sheet copy is a transfer/backup medium; IndexedDB stays
  the working copy.
- **`addrCache`** (key = the coordinate rounded to ~11 m, e.g. `"44.9612,-79.9881"`)
  — a coord→address cache so reverse-geocoding works offline. See "Offline
  geocoding" below.

**Records are schema-agnostic.** `applyOptimisticCache`/`reconcileCache` store the
*whole* `addStop`/`addDowntime` payload by spread (`dataOf` strips only the
transport keys `token`/`action`/`_seq`), so adding a new datapoint to a stop is
cached automatically — there is no per-field list to keep in sync. The cached
record is just the data.

**Retention (~a week).** `pruneDayCache(keepDays=8)` runs on load and deletes
`dayCache` entries whose date is older than the window, so the phone keeps roughly
the installer's last week rather than an unbounded history. **Recent days:**
`cacheRecentDays(7)` pulls the installer's own last week via the `range` GET (one
request) into `dayCache`, and the "Recent days" sheet renders it — so prior days
are viewable, and editable (each edit posts `updateStop`), with no signal. Older
data not on the phone is fine; the Sheet remains the full record.

**`localStorage` is reserved for trivial, synchronous device config only** —
the person's name and H number (read synchronously by `cfg()` all over the UI).
Losing it just re-prompts for a name; there's no data loss. **Policy going
forward: any durable offline state belongs in IndexedDB, not `localStorage`.**
(The pre-IndexedDB build kept the queue in `localStorage`; a one-time
`migrateLegacyQueue()` drains it into the `queue` store on first load of the new
build.)

The service worker (`sw.js`) caches the **app shell** — the HTML pages, the
`css/` stylesheets, and the `js/` modules — so the app opens with no signal. When
you add a new module or stylesheet, add it to the `SHELL` list and bump `CACHE`.
It deliberately lets the POST to the spine hit the network and fail when offline,
so the IndexedDB `queue` owns retry — don't add the endpoint to the SW cache.
(`map.html` + `js/pages/map.js` + the vendored Leaflet/Chart files are
precached too, so the viewer shell opens offline; only the OSM tiles need a
connection.)

---

## Frontend module layout

No bundler, no build step — native ES modules + plain CSS, served as-is by GitHub
Pages. Each HTML page is markup + `<link>`s + one `<script type="module">` entry
point in `js/pages/`. Shared modules in `js/`:

- **`config.js`** — `WEB_APP_URL` + `SHARED_TOKEN`, the single frontend copy
  (imported everywhere). With `Code.gs` that's the only other place the token
  lives — two, down from the previous five.
- **`dom.js`** (`$`, `enc`, `esc`, `attr`, `toast`), **`time.js`** (`stamp`,
  `localDate`, `localDateOffset`, `clockOf`, `hhmmMin`, `ordinal`, `parseLocalMs`).
- **`store.js`** (`store` + `cfg()`), **`idb.js`** (IndexedDB wrapper +
  `DB_VERSION`), **`api.js`** (`apiGet`/`apiPost` — inject token + URL).
- **`queue.js`** (offline queue; UI side-effects via `setQueueHooks`),
  **`daycache.js`** (optimistic/reconcile/merge + retention + recent days),
  **`geocode.js`** (addrCache + `resolveAddress` + `backfillAddresses`).
- **`worklist.js`** (the worklist screen + plan mode), **`route.js`** (the
  optimize pipeline: Google forward geocoding bounded to ~80 km of the crew +
  Google Routes road matrix (budget-guarded, straight-line fallback) + pinned
  open-path TSP — see "Work modes" ▸ "Route optimization").
- **`compute/`** — `gaps.js` (WO→WO gaps, mirrors `computeIdle`), `tally.js`
  (`PRINTABLE`/`countDay`/`tallyText`).
- **`pages/`** — `capture.js`, `map.js`, `teams.js`, `edit.js`, `reports.js`,
  `planner.js`.

CSS: `css/tokens.css` (design tokens + reset) and `css/base.css` (shared
components) back the capture page; `css/{capture,map,teams,edit,reports}.css` are
per-page (plus `css/vendor/leaflet.css`). `map.js` uses the Leaflet (`L`) +
Chart globals loaded by classic `<script>`s before its module — vendored at
`js/vendor/leaflet.js` + `js/vendor/chart.umd.min.js`, no CDN.

## Offline geocoding

Reverse-geocoding can't be fully offline (that would need bundled map data), so
`js/geocode.js` does **cache + backfill on sync**:

- **Cache:** every resolved coordinate→address is stored in the `addrCache`
  IndexedDB store, keyed by the coordinate rounded to ~11 m. A crew works the same
  islands daily, so after the first online visit a spot resolves **instantly and
  offline**. Hand-typed addresses are cached too (on log).
- **`resolveAddress(lat,lng)`** returns a cache hit immediately; else, when
  online, calls the spine `geocode`, caches the result, and returns it; else
  returns `null` (the field stays blank, the GPS is still captured).
- **Backfill:** a stop captured offline keeps its coordinates with no address.
  `backfillAddresses()` runs on reconnect — for each cached stop with coords but no
  address it resolves the address and posts an address-only `updateStop` (idempotent
  via the stop id), then patches the cache. Capped per run; the rest are picked up
  on the next online tick.

The spine `geocode` action (Google Maps service, no API key) is unchanged — it's
just the online resolver behind the cache now.

---

## Removing a stop (archive / restore)

A mis-logged order is **removed by moving its row to `StopsArchive`** — never a
hard delete. Because every stop-derived read pulls from the live `Stops` tab,
the move alone erases the stop from the map, the analytics, and the phones (on
their next pull). Three surfaces trigger it, all posting the same `archiveStop`:

- **edit.html** — a "Remove from log…" button inside each stop card's edit panel
  (confirm + optional reason), then a full authoritative day reload. The same
  page shows the day's **"Removed stops"** list (the `archived` read) with a
  **Restore** button per row (`restoreStop`).
- **index.html (Today's Work)** — the same button on the phone's stop card,
  **offline-capable**: the `archiveStop` rides the offline queue, and
  `applyOptimisticCache` immediately drops the stop from `dayCache` *and*
  tombstones its id in `dayCache.removedIds`. The merge helpers
  (`mergePending`/`mergePendingRows`) filter tombstoned ids out of server pulls,
  so a pull that races the queued archive can't resurrect the stop; the
  tombstone clears when the server acks (`reconcileCache`). A never-synced stop
  removes cleanly too — FIFO flushes its `addStop` first, then the archive.
- **map.html** — a button in the pin popup (online-only; the viewer has no queue).

Spine guarantees (`archiveStop`):
- **Archive-before-delete**: the copy is appended to `StopsArchive` (with
  `removedAt`/`removedBy`/`reason`) before `deleteRow` — a crash duplicates
  (converged on retry by the id guard) rather than loses data.
- **Idempotent + always terminal**: already-archived → `{ok, alreadyArchived}`;
  id found nowhere → `{ok, missing}`. Never a retryable error for a gone id, so
  a phone's FIFO queue can't wedge. For the same reason, `updateStop` on an
  archived id returns `{ok, archived:true}` and **drops the edit** (the archive
  is a frozen record) instead of `id not found`.
- **Closed-day repair**: if a Tracker row exists for the stop's (installer, date),
  `regenerateDayRows` rebuilds Tracker + Timing from the surviving stops via the
  shared `writeTrackerAndTiming` (also used by `endOfDay`). It deliberately
  **skips** the close-time side effects: no `Days` write, no `BoatDays` snapshot
  (that would overwrite the historical crew record with today's roster), no boat
  dispatch recompute — and it preserves the Tracker row's `weather`/`notes`/
  `workType`, which only ride in on a real close.

Known edges (accepted): gap-tagged travel deductions whose `gap HH:MM–HH:MM`
note straddled the removed stop no longer match a gap after the merge — re-open
the day's travel review if it had been reviewed; a boat **partner's** closed day
isn't regenerated (their merged-timeline gaps changed) — re-close their day from
edit.html; a removed stop's worklist order stays marked done.

---

## Work modes (boat / land)

The operation runs two kinds of routes and the app captures both: **boat work**
(the original — boat teams, captains, the travel-column daily log) and **land
work** (truck routes — crews with a sub foreman, a flat per-WO-delays daily
log). The captured data is identical; what changes is the chrome and the PDF.

- **The toggle.** A Boat/Land segmented switch at the top of `index.html` (and
  `teams.html`), persisted per device as `localStorage['workMode']`. It sets
  `data-mode` on `<html>` (an inline `<head>` snippet applies it pre-paint), and
  the CSS accent tokens follow: **boat = blue, land = green** (`--accent*` in
  `css/tokens.css`; `css/teams.css` carries its own copy).
- **`workType` column.** Every `addStop` / `addDowntime` payload — and the
  `endOfDay` Tracker upsert — carries `workType: 'boat' | 'land'` (blank legacy
  rows read as boat via `normWorkType`). Same tabs, one extra column; no
  separate land tabs.
- **Daily log.** `buildDaySummary` returns `workType` (the caller's value, else
  inferred from the day's stops) and `js/dailylog.js` branches on it: land days
  render the land sheet — header strip (Name / Date / Sign / Weather), one row
  per install/UTI with its delay minutes spread across per-category
  **DELAYS (MIN)** columns, a totals row summing each category, and **no travel
  column** (travel is still reviewed at EOD and written to Timing/Tracker as
  always — it just doesn't print). `C` marks an install, `UTI` a UTI (whose
  reason prints in Meter Read / Notes). Delay minutes land on a row by matching
  the downtime's `workOrderId`; un-attributed minutes still count in the column
  totals and are listed on a "Not tied to a WO#" footer line.
- **Crews.** A land crew is a `Teams` row with `type='land'` — crew number in
  `boatNumber`, sub foreman in `subName`, no captain/boat name. `teams.html`
  shows boat teams in boat mode and crews in land mode. A land `endOfDay` skips
  the BoatDays snapshot + shared boat-dispatch bookkeeping.
- **Worklist & plan mode.** The worklist is a full-page screen on `index.html`
  (`js/worklist.js`; the old popup is gone) for both modes: orders hold WO# /
  Address / Old J#, drag the ⠿ handle to reorder (persisted as an `order` field
  on the existing IndexedDB `worklist` items), recent-street chips +
  copy-street-forward cut repeat typing on same-street runs. Each card with an
  address gets a 🧭 **Directions** button — it opens the OS maps app in a new
  context (Apple Maps on iOS, the Google Maps universal dir link elsewhere) on
  the order's **cached coords when it has them** (the exact pin the route was
  solved on — the maps app can't re-geocode the text to a different spot),
  falling back to the address text plus an `", ON"` region hint. The explicit
  **⇪ Upload / ⇩ Download** buttons move the list between devices via the
  sheet's `Worklist` tab (see "Client-side storage" and the `Worklist` row
  shape). **Plan mode** (`localStorage['planMode']`, toggled on the worklist
  screen) feeds the capture form: the first pending order pre-fills it, each
  logged stop advances to the next, Skip sends the current order to the back of
  the queue. If the planned address and the GPS-resolved one materially
  disagree, an inline chooser makes the installer pick before the stop can be
  logged.
- **Route optimization** (`js/route.js`, the 🧭 Optimize button on the worklist
  screen; online-only). The whole pipeline runs on the phone: forward-geocode
  every pending order (**Google Geocoding API**, key in `config.js` —
  referrer-restricted, API-restricted to Geocoding + Routes, and quota-capped
  per DEPLOY.md so it can never bill past the 10k/month free tier; past the
  daily cap new orders just park until tomorrow) → pull a **road-distance
  matrix from the Google Routes API** (tiled in 625-element requests; Google
  bills per stop-pair, so a per-device monthly element budget in
  `js/route.js`/localStorage guards the free tier) with a **straight-line
  haversine fallback** when the matrix fails or the budget is spent → solve
  the open-path TSP locally
  (nearest-neighbour + 2-opt + Or-opt) → rewrite `order`. **Matching is biased
  AND hard-bounded to `GEO_RADIUS_KM` (80 km) around the crew** — a `bounds`
  box + `region=ca` (soft bias only on Google) plus the local haversine belt,
  which is the actual gate — so a same-named street one
  region over parks instead of matching; the gate center is the phone's GPS,
  falling back to the list's own median (also used when the fix is > 80 km from
  the list — planning far from the route area must not invalidate good pins),
  then the home pin. Stored coords are **revalidated against the circle every
  run**, so historical wrong-town pins self-heal. An address matching several
  distinct places gets **no coords + `geoAmbig`** (the "⚠ which town?" badge;
  Edit shows the candidates as one-tap chips), a no-match gets `geoFail`
  (`📍?`) — both park at the bottom until fixed; the flags are phone-local,
  never uploaded. The solve is **pinned**: with a home pin (Settings →
  `localStorage` `homeAddress`/`homeLat`/`homeLng`, geocoded once at save) the
  path is solved pinned at home and read backwards — ending the day moving
  toward home, the start landing at the far side of the cluster — otherwise the
  list's first order is pinned as the start with the end open.
  `optimizeRoute` also takes `opts.osrmUrl` — the **desktop planner's** matrix
  source: one free `table` call against a self-hosted OSRM (straight-line as
  its only fallback, never the billable Google path), which is how the office
  plans a route at zero matrix cost and uploads it for the phone to Download
  (see the planner page bullet under "The three layers").
- **Validation (both modes).** An install can't submit without a New J#; a UTI
  can't submit until a reason is picked (the dropdown starts blank).

## Data structures

### Stop  (one row per work order visited → tab "Stops")
| field             | type                | notes                                            |
|-------------------|---------------------|--------------------------------------------------|
| `id`              | string              | unique (timestamp + random)                      |
| `timestamp`       | string              | Toronto local, `yyyy-MM-dd HH:mm:ss`, set at capture |
| `installer`       | string              | the person's name — this is what makes it multi-user |
| `workOrderId`     | string              | WO#                                              |
| `unit`            | string              | e.g. "C20-5", "22"                               |
| `address`         | string              | House / Address (optional — boat work uses coords)|
| `lat`             | number \| null      | preferred locator                                |
| `lng`             | number \| null      | preferred locator                                |
| `newJNumber`      | string              | New J#                                            |
| `oldJNumber`      | string \| null      | saved when there's no read / on a UTI            |
| `meterRead`       | number \| null      | the reading, or null if UTI / unreadable         |
| `status`          | `"INSTALLED"` \| `"UTI"` \| `"VISITED"` \| `"UNACCOUNTED"` \| `"DONE"` | see status notes below |
| `utiReason`       | string \| null      | e.g. "No Access"                                 |
| `notes`           | string              | free text                                        |
| `noReadReason`    | string \| null      | why an install had no read (e.g. "Missing segments") |
| `meterReadReceived` | number \| null    | second read for solar meters (delivered + received) |
| `workType`        | `"boat"` \| `"land"` | which side of the operation logged it (blank = boat) |

**"Mark spot done" markers.** A `status` of `DONE` is a lightweight record made
by the one-tap **Already installed here · mark spot** button on the web form: it
carries only `lat`/`lng` (plus who logged it) — no work order, read, or J#. It
exists for the proximity / "is this already done?" map check, which reads any
`Stops` row with coordinates. Because the meter may not have been installed by
the person logging it, `DONE` is deliberately left out of the end-of-day
installed/UTI tallies, the formatted daily log, and the viewer's install/UTI
counts — it never inflates anyone's numbers. It needs no special endpoint: it's
just `addStop` with `status: "DONE"` and coordinates.

**"We were here" outcomes (`VISITED` / `UNACCOUNTED`).** Two lighter outcomes for
trips that finish no work order but should still be on the record:

- **`VISITED`** — showed up, *saw* a meter, but couldn't do it. Carries an
  `oldJNumber` + a `notes` comment; no read, no new J#.
- **`UNACCOUNTED`** — showed up but couldn't find or confirm a meter (may or may
  not have power, could be indoors — unknown). Carries only coordinates + a `notes`
  comment. WO# is optional for both.

On the capture form these two share one **OTHER** status button (alongside the
mark-spot DONE button). The single "we were here" log asks only for an Old J#
(optional) + notes; the stored status is **derived on save** — an Old J# present →
`VISITED`, blank → `UNACCOUNTED`. The backend still receives a plain `addStop` with
the resolved status, so the Sheet / PDF / map distinction is unchanged.

Both are **separate counts** in the store: like `DONE`, they're deliberately kept
out of the install/UTI tallies and the install-rate. On the **daily-log PDF** they
get **no body row** — the body is installs + UTIs only — and instead roll up, together
with `DONE`, into a single **"Visited N"** footer tally (`N = visited + unaccounted +
done`), since each one means the crew still took the time to go and check the island.
On the **map/viewer** they keep their own status chips, colors, and the `visited` /
`unaccounted` Tracker columns. They are plain `addStop` calls — no new endpoint.

### StopsArchive row  (one per removed stop → tab "StopsArchive")

The **"remove from the log" archive** — a Stops row moved here (never hard-deleted)
by `archiveStop`, and moved back by `restoreStop`. Columns are exactly
`STOPS_HEADERS` plus three removal-metadata fields:

| field       | type   | notes                                              |
|-------------|--------|-----------------------------------------------------|
| *(all Stop fields)* | | verbatim copy of the removed row                |
| `removedAt` | string | Toronto local `yyyy-MM-dd HH:mm:ss`, stamped by the spine |
| `removedBy` | string | installer's name (phone), `"map viewer"` (map), blank (edit.html) |
| `reason`    | string | optional free text, prompted at removal time        |

Semantics (see "Removing a stop" below for the flow):
- Because every stop-derived read (`pins`, `day`, `range`, `lookup`, `nearby`,
  tallies) reads the live `Stops` tab, moving the row removes the stop from the
  map, the statistics, and the today's-work list automatically.
- `archiveStop` appends the archive copy **before** deleting the source row, so a
  crash mid-way duplicates (converged by the id guard on retry) rather than loses.
- If the stop's day was already **closed**, the spine auto-rebuilds that
  installer/date's Tracker + Timing rows (`regenerateDayRows`) from the surviving
  stops — preserving the Tracker row's `weather`/`notes`/`workType` and leaving
  the historical `Days`/`BoatDays` rows untouched. Removing the day's *last* stop
  leaves a zeroed Tracker row (the day stays "closed" on the record).
- Restore is edit.html's "Removed stops" list (the `archived` read + `restoreStop`).

### DowntimeEntry  (zero or more per day → tab "Downtime")
| field         | type            | notes                                       |
|---------------|-----------------|---------------------------------------------|
| `id`          | string          |                                             |
| `timestamp`   | string          | Toronto local, `yyyy-MM-dd HH:mm:ss`        |
| `installer`   | string          |                                             |
| `category`    | enum (below)    |                                             |
| `minutes`     | integer         |                                             |
| `workOrderId` | string \| null  | pair downtime to a WO when relevant (the form pre-fills the current/last WO; on the land PDF this is what puts the minutes on that WO's row) |
| `note`        | string          | **required** when category is `OTHER`       |
| `workType`    | `"boat"` \| `"land"` | blank = boat                           |

**Downtime categories:**
- **Delays** (`CATEGORIES` in `Code.gs`, each gets a Tracker column): `NEXT_GEN`,
  `CELL_SIGNAL`, `BAD_WEATHER`, `WAREHOUSE`, `TOOLS_MATERIAL`, `DISPATCH`,
  `TRUCK_ISSUES`, `ASSIST`, `URGENT_EER`, `OTHER`. (`DISPATCH` is **not** selectable
  in the manual *Add downtime* form — it's added only via the EOD review; see
  "Dispatch downtime".)
- **Breaks** (`BREAK_CATS`): `LUNCH`, `BREAK` — summed on the log's "Breaks:" line,
  kept out of `downtimeTotalMin`.
- **Travel adjustments** (`TRAVEL_ADJ_CATS`): `MISC_TRAVEL` — summed on the log's
  "Misc Travel:" line.
- **Legacy:** `TRAVEL_TIME` — kept for back-compat; **not** subtracted from a gap and
  not counted as a delay (see "Travel vs delay").

All allocation categories **except** `TRAVEL_TIME` subtract from their WO→WO gap's
travel. `BREAK_CATS` / `TRAVEL_ADJ_CATS` are intentionally absent from `CATEGORIES`, so
they ride on the row-based `Downtime` tab and get **no** Tracker breakdown column — that
is what let the feature ship with no sheet-schema change.

### Tracker row  (one per installer per day → tab "Tracker")
Written at end-of-day. This is the "continues forever" sheet, and the source the
viewer's analytics charts read from. `endOfDay` **upserts** it by `(date, installer)`
— closing or regenerating the same day overwrites the row in place rather than
duplicating, so the back-office `edit.html` can regenerate freely.
| `date` | `installer` | `installed` | `uti` | `downtimeTotalMin` | `nextGen` | `cellSignal` | `badWeather` | `warehouse` | `toolsMaterial` | `dispatch` | `truckIssues` | `assist` | `urgentEer` | `other` | `weather` | `notes` | `visited` | `unaccounted` | `autoIdleMin` | `travelMin` | `delayMin` | `workType` |

The per-category columns are summed minutes for that day, so the running sheet is
also a breakdown, not just a single downtime number. `visited` / `unaccounted` are
the day's counts of those two outcomes. `travelMin` is the **derived** travel time
(see "Travel vs delay" below) = the sum of each WO→WO gap's **net** minutes (raw minus
what was subtracted) + launch leg. `autoIdleMin` and `delayMin` are **legacy** columns left in
place for old rows (now written blank). All were **appended** after `notes` so older
sheets migrate cleanly via `ensureTab` — re-run `setupSheets()` once after deploying.

> **`travelMin` vs `downtimeTotalMin` are separate, not additive.**
> `downtimeTotalMin` is the sum of the 10 **delay** `Downtime` categories (breaks,
> misc travel, and `TRAVEL_TIME` excluded); `travelMin` is the net WO→WO travel after
> those same delays/breaks/misc were subtracted from each gap. They never share the
> same minutes — don't sum them.

### Day  (one row per installer per day → tab "Days")
The day's **bookend clock times**, persisted so the daily log can always be rebuilt
with them — the field end-of-day form used to send `departure`/`returned` only
transiently and discard them after the PDF.
| field             | type   | notes                                                  |
|-------------------|--------|--------------------------------------------------------|
| `date`            | string | Toronto local `yyyy-MM-dd`                             |
| `installer`       | string | display name                                          |
| `departure`       | string | `"HH:mm"` — left the dock (Launch leg)                |
| `returned`        | string | `"HH:mm"` — back to land (Return leg)                 |
| `dispatchMin`     | number | this installer's own dispatch downtime for the day    |
| `boatDispatchMin` | number | whole-boat dispatch downtime, shared by the crew      |

Upserted by `saveDay` (keyed on `date`+`installer`, which writes only the first
four columns and leaves the dispatch columns intact); also written by `endOfDay`
when those times are supplied. `buildDaySummary` falls back to this row when a
request omits the bookends, and `?action=day` returns it (plus a `closed` flag) so
`edit.html` can pre-fill the inputs.

`dispatchMin`/`boatDispatchMin` were **appended** after `returned`, so add the two
header cells to an existing `Days` tab (re-run `setupSheets()` won't add columns to
an existing tab). At end-of-day `updateBoatDispatch(date, team)` recomputes the
boat's shared dispatch sum — `dispatchMinFor` (sum of each member's `DISPATCH`
`Downtime` rows) across every crew member on the boat that day — and writes each
member's own total + the shared sum onto their `Days` row via `setDayFields`
(header-aware partial upsert that preserves bookends and creates a row for a
teammate who hasn't closed yet). It runs on every close, so the `Days` sheet
converges to the latest edit even when teammates close at different times; an
installer who closes first may print a stale boat total on their PDF (see "Dispatch
downtime"). The shared total is also printed on the daily-log PDF (`boatDispatch`
anchor) and surfaced in `map.html` analytics ("Avg boat dispatch downtime" + "Total
dispatch downtime").

### BoatDay  (one row per boat per day → tab "BoatDays")
A snapshot of who crewed a boat on a given day, taken at end-of-day. `Teams` is
current-state only, so this is the **only historical record of daily boat membership**
— and it's what lets the viewer group a day's logs by the boat that ran them.
| field           | type   | notes                                                          |
|-----------------|--------|----------------------------------------------------------------|
| `date`          | string | Toronto local `yyyy-MM-dd`                                     |
| `boatNumber`    | string | the boat, e.g. `"11"` (match key with `date`)                 |
| `boatName`      | string | display label, snapshotted from `Teams`                       |
| `captainName`   | string | free-text, snapshotted                                        |
| `subName`       | string | free-text, snapshotted                                        |
| `memberLetters` | string | JSON `{hNumber:"A"}` map, copied from the team at close time  |
| `memberNames`   | string | JSON array of crew display names (so the viewer can group by name) |

Upserted by `recordBoatDay` (keyed on `date`+`boatNumber`), called from `endOfDay`
for the closing installer's boat — so every crew member who closes re-upserts the same
row to one current snapshot. `?action=boatdays` returns all rows; `js/pages/map.js`
builds a `date|installer → boatNumber` index from `memberNames` and averages each
boat's consecutive-log gaps for the **"avg log→log (boat)"** analytics tile (the
boat-wide cadence — anyone sharing the boat that day, any letter; an installer with no
boat that day falls back to a solo chain).

### Employee  (one row per crew member → tab "Employees")
The crew roster, managed from `teams.html`. Keyed on the **employee number**
("H number") so two people with the same name never collide — first/last name
are a display label only.
| field       | type    | notes                                              |
|-------------|---------|----------------------------------------------------|
| `hNumber`   | string  | unique key — the employee/"H" number               |
| `firstName` | string  | display label                                      |
| `lastName`  | string  | display label                                      |
| `active`    | boolean | soft-delete / hide from pickers (defaults to true) |
| `subName`   | string  | the installer's **own** sub-foreman pick (capture-page Settings). Only meaningful when they're not on a team — a team's `subName` always wins (the Settings field shows it locked). Rides `saveEmployee` **only when the payload carries it**, so admin saves never blank it; feeds the reports-page grouping and the daily-log "Sub:" box as a fallback. |

### Team  (one row per boat → tab "Teams")
A boat, managed from `teams.html`. `memberLetters` is a JSON map keying each
installer's H number to their team letter (e.g. `{"H100":"A","H200":"A","H300":"B"}`).
People sharing the same letter are partners — Boat 11 members with letter A form
team **11A**, letter B → **11B**, etc. A boat can hold any number of crew (letters
run A..Z). The **captain and sub are *not* employees** — they move between boats,
have no H number, and are stored as free-text names.

Crew are added on the boat card by **typing a name**: an existing installer is
linked by H number, while a brand-new name is sent in the `saveTeam` payload's
`newMembers: [{name, letter}]` array and the spine auto-creates an `Employees` row
for it (`ensureEmployeeByName` — matches an existing full name first to avoid
duplicates, otherwise generates an H number; single-word names leave `lastName`
blank). Storage stays `{hNumber: letter}`, so all attribution below is unchanged.
| field           | type        | notes                                               |
|-----------------|-------------|-----------------------------------------------------|
| `id`            | string      | unique (timestamp + random)                         |
| `boatNumber`    | string      | e.g. "11"                                           |
| `boatName`      | string      | e.g. "Sea Ray"                                      |
| `captainName`   | string      | the captain's first name (free text, no H#)         |
| `subName`       | string      | the sub/subforeman's first name (free text, no H#)  |
| `memberLetters` | JSON string | map of `{hNumber: letter}` — no captain/sub here    |
| `type`          | `"boat"` \| `"land"` | blank = boat. A **land crew** reuses the shape: crew number in `boatNumber`, sub foreman in `subName`, captain/boat name blank. `teamsList()` projects it (normalized via `normWorkType`) so the `roster` read carries it — teams.html's boat/land mode filter depends on that |

**End-of-day auto-fill.** When an installer ends their day, the form sends their
`installerId` (H number). The spine finds their boat row, reads `memberLetters`,
and fills the daily log header:
- **Boat Team** = boat number + *their own* letter (e.g. `11A`)
- **Partner** = crew members on the same boat who share their letter
- **Captain** / **Sub** = the boat's free-text captain and sub names (no team
  sub → falls back to the installer's own `Employees.subName` Settings pick)
- **Boat Name** = the boat name from the team row

PDF is named `FirstNameLastName_Date_DailyLog.pdf` where the name comes from the
Employees tab lookup on the installer's H number. Installers with no H number
still log fine; their team boxes stay blank.

### Captain name list  (→ tab "Captains")
A deduplicated list of captain first names. `saveTeam` always calls `ensureName`
so any name typed in a team card is remembered automatically. Used to populate
the captain dropdown on boat cards in `teams.html`.
| field  | type   |
|--------|--------|
| `name` | string |

### Sub name list  (→ tab "Subs")
Same pattern as Captains, for sub/subforeman names.
| field  | type   |
|--------|--------|
| `name` | string |

### DispatchRequest  (one row per meter request → tab "Dispatch")
A meter request fired from the Apple Shortcut. The first three columns are written
when the request fires; the rest are filled **in place** when the matching stop is
completed (see "Dispatch downtime"). The `matched`=`Y` rows are the measured
dispatch downtimes the average is built from.
| field           | type   | notes                                                      |
|-----------------|--------|------------------------------------------------------------|
| `id`            | string | unique (timestamp + random)                                |
| `requestTime`   | string | Toronto-local `yyyy-MM-dd HH:mm:ss` — when the request fired|
| `oldJNumber`    | string | the match key — the J# the request is keyed to             |
| `installer`     | string | filled on match — who completed the matching stop          |
| `completedTime` | string | filled on match — the matching stop's timestamp            |
| `minutes`       | number | filled on match — `completedTime − requestTime`            |
| `matched`       | string | `''` until matched, then `'Y'`                             |

### Metric  (one row per metric → tab "Metrics")
A key/value summary store. Currently one row, `avgDispatchTime`, refreshed by
`avgDispatchTime()` (see "Avg dispatch time"). Room for more metrics later.
| field     | type          | notes                                                |
|-----------|---------------|------------------------------------------------------|
| `metric`  | string        | the key, e.g. `avgDispatchTime`                      |
| `value`   | number/string | the stored value (`''` when not yet computable)      |
| `updated` | string        | Toronto-local timestamp of the last refresh          |

### Worklist row  (one per planned order → tab "Worklist")
A flat copy of one phone's IndexedDB `worklist` record, keyed per installer on
the employee **H number** (unlike the name-filtered `Stops`/`Tracker` tabs —
names can collide, H numbers can't). Written **only** by the planning screen's
explicit Upload (`saveWorklist`, a delete-then-append whole-list replace of
that H number's rows) and read only by Download (`?action=worklist&hNumber=…`)
— never touched automatically, so the sheet copy is a transfer/backup medium
and the phone's IndexedDB stays the working copy. An empty upload clears the
installer's saved rows.
| field         | type   | notes                                                        |
|---------------|--------|--------------------------------------------------------------|
| `id`          | string | the client-generated order id (preserved across the round trip) |
| `installer`   | string | display-name label only, filled from the roster at upload time (falls back to the posted name) — never a match key |
| `hNumber`     | string | employee number — **the per-installer match key**            |
| `workOrderId` | string | WO#                                                          |
| `unit`        | string | legacy popup-era field, round-tripped so it's never dropped  |
| `address`     | string | free-text `"num street"` / landmark                          |
| `oldJNumber`  | string | optional old J#                                              |
| `wlStatus`    | string | `'pending'` \| `'done'`                                      |
| `order`       | number | sort position — **renumbered 0,10,20… by `saveWorklist` on every upload** (blanks-last, `createdAt` tie), re-repaired nightly by `normalizeWorklistOrders()`; `''` only on legacy rows that predate the renumbering |
| `createdAt`   | string | Toronto-local `yyyy-MM-dd HH:mm:ss`                          |
| `updatedAt`   | string | Toronto-local `yyyy-MM-dd HH:mm:ss`                          |
| `lat` / `lng` | number | the order's cached geocode pin (`''` when not located) — round-tripped so a downloaded list routes without re-geocoding |

The phone-local `geoFail` / `geoAmbig` flags (parked / "which town?" — see
"Route optimization") deliberately do **not** ride the sync: `wireShape` strips
them on upload and the next optimize re-derives them.

---

## Sample stop (the JSON the form posts)

```json
{
  "token": "YOUR_SHARED_TOKEN",
  "action": "addStop",
  "installer": "Quincy",
  "timestamp": "2026-06-19 10:58:04",
  "workOrderId": "573054",
  "unit": "C20-5",
  "address": "Horse Island",
  "lat": 44.9612, "lng": -79.9881,
  "status": "INSTALLED",
  "meterRead": 3950,
  "meterReadReceived": null,
  "newJNumber": "J4729753",
  "oldJNumber": null,
  "noReadReason": null,
  "utiReason": null,
  "notes": ""
}
```

---

## Travel vs delay

Timing is **derived** by the spine from data already captured — every stop's
Toronto-local timestamp + GPS, plus boat-team membership — so the crew logs nothing
extra for it. The crew's mental model: *under ~20 min between stops you're just
driving (travel); a longer gap is worth a look.* The auto split is by **time**;
distance only hints what a flagged gap probably was.

**`computeIdle()` (in `Code.gs`)** walks the day's markers in time order — **every**
stop counts (install, UTI, visited, unaccounted, **and** done), "since we still take
the time to go and check":

1. **Team-aware.** It pools the installer's stops with their *same-letter boat
   partners'* stops for the day (a single-man team is just their own), so a
   partner's install advances the whole team's clock — "from the first meter to
   whoever does the next one, me or my partner."
2. **One row per gap.** `computeIdle` emits one typed row per gap — the single source
   the totals, the PDF column, and the `Timing` tab all derive from. `type` is:
   - **`Travel`** — a WO→WO gap **< `FLAG_GAP_MIN`** (default 20 min).
   - **`Flagged`** — a WO→WO gap **≥ `FLAG_GAP_MIN`** (now just a styling / `suggest`
     hint; **every** WO→WO gap is surfaced for review regardless of length).
   - **`Launch`** (dock→first) / **`Return`** (last→dock) legs, when a departure /
     return time is entered — always pure travel, not shown for subtraction.
3. **Subtraction model (the saved travel).** At end-of-day review **every WO→WO gap**
   is shown with its raw minutes. The reviewer subtracts any downtime, lunch, or break
   that happened during that drive (multiple chunks per gap, each a reason + minutes);
   the **remainder is that gap's travel time** — the value saved. A 60-min gap with
   *15 Next Gen + 15 Break* subtracted nets to **30**. Each chunk is one `Downtime` row
   tagged `gap <start>–<end>` + the arriving WO#. `buildDaySummary` sums the subtractable
   chunks per gap (everything **except** legacy `TRAVEL_TIME`) and sets
   `perStopTravel[stop] = max(0, raw − subtracted)`. The PDF's per-row "Travel (min)"
   column and the "Travel Time:" box (its running sum) both show this **net** value, and
   `s.travelMinutes` (Tracker `travelMin`) is the same net total minus the row-less
   `Return` leg. No overlap with the "Delay Time:" box — subtracted minutes live in their
   own bucket, not in travel.

The two tunables (`FLAG_GAP_MIN`, `SAME_ISLAND_M`) sit at the top of `Code.gs` and
are field-adjustable.

**Four buckets at the bottom of the log.** Every `Downtime` row (gap-subtracted or
manually logged) is classified by category into one of four non-overlapping totals:
- **Delays** — the 10 `CATEGORIES` (Next Gen, Dispatch, …). The PDF "Delay Time:" box
  and the Tracker per-category columns = this total.
- **Breaks** — `LUNCH` + `BREAK`, on their own "Breaks:" line, kept **out** of the
  delay total (a break isn't a work disruption).
- **Misc Travel** — `MISC_TRAVEL`, on its own line (travel that wasn't WO→WO, e.g. a
  fuel run pulled out of the clean ride number).
- **Travel** — the per-gap remainders (above). Legacy `TRAVEL_TIME` rows are **not**
  subtracted from a gap (they meant "the whole gap was travel"), so old closed days
  still compute unchanged.

`BREAK_CATS` / `TRAVEL_ADJ_CATS` are deliberately kept **out** of `CATEGORIES` so they
never claim a Tracker column — they ride on the row-based `Downtime` tab and surface on
the PDF footer, so adding them needed **no sheet-schema change**.

**Clean-log toggle (`includeDelays`).** Both end-of-day surfaces carry an "Include
delays & travel time on PDF" checkbox (checked by default). The `endOfDay` /
`previewDailyLog` request body sends `includeDelays`; it rides in the `summary` as
`includeDelays`, and when `false` the phone renderer (`js/dailylog.js`)
suppresses the "Delay Time:" box, the "Travel Time:" box, the per-stop Travel (min)
column, and the whole Delays/Breaks/Misc Travel footer line — leaving an installs/UTIs
log (Departure/Returned still print). The flag is **PDF-only**: `buildDaySummary` still
computes every total and `endOfDay` still writes the full `Tracker` + `Timing` rows, so
analytics is unaffected by the choice. Absent flag ⇒ included (back-compat).

**`Timing` tab (audit trail).** `endOfDay` writes one row per gap —
`date, installer, fromTime, toTime, minutes, distanceM, type, bucket, workOrderId, fromStatus, toStatus` —
where `type` is Travel / Flagged / Launch / Return and `bucket` is `travel` (nothing
subtracted), `mixed` (partly subtracted), or `delay` (fully consumed). `fromStatus` /
`toStatus` are the gap's endpoint stop statuses (blank at a dock end), letting analytics
separate the **install-to-install** lens from the **any-log-to-any-log** lens — `map.html`
shows both tiles ("Avg install-to-install" filters to gaps where both ends are INSTALLED).
Every number on the daily log traces back to these rows. To stay idempotent, `endOfDay` first
**deletes** that `(date, installer)`'s existing rows, then writes the fresh set.
`previewDailyLog` does **not** write it (preview stays no-write).

**Wiring.** Both surfaces (`index.html` end-of-day, `edit.html` back-office) fetch
`?action=idle&installerId=…&date=…` — which now returns **every WO→WO gap** plus any
deductions already saved for it — and render an editable card per gap (raw minutes, a
live net-travel readout, add/remove reason+minutes rows). On generate/finish they POST
**`saveTravel`** with the full allocation set; `saveTravel` **replaces** that day's
gap-tagged `Downtime` rows (idempotent — re-editing never duplicates), and the caller
then POSTs `endOfDay`, which reads those rows back through `buildDaySummary`.
Gap-allocation rows are stamped on the gap's own date so a past day edited from
`edit.html` reads them back. Manual *Add downtime* rows (free-text/empty notes) are
never touched by `saveTravel`.

---

## Dispatch downtime

"Dispatch" downtime is the wait between asking dispatch for a new work order and
actually getting on it. It used to be a manual guess; now it can be **measured**.

**The flow.** When the installer requests a meter, a new **Apple Shortcut** both
texts dispatch **and** POSTs `dispatchRequest` to the spine with a `time` and an
`oldJ`. That appends a *pending* row to the `Dispatch` tab (match key = `oldJ`,
installer unknown at this point — match is **oldJ-only**). Later, when the crew
completes that work order, they log a stop in `index.html` with the **"Requested
meter?"** checkbox ticked (shown on INSTALLED + UTI, which both already send
`oldJNumber`).

**Flagged live, matched & pre-filled at end of day.** Logging stays a cheap
append and the global match runs hourly in the background, off every request's
critical path.

- **Live (client).** Ticking "Requested meter?" only sets a `requestedMeter` flag
  on the stop (persisted as a `Stops` column). No dispatch row is written at log
  time — at log time the phone usually has no request data to compare against
  anyway.
- **End of day (spine, `?action=idle` → `dispatchSuggestMin`).** When the EOD
  travel review opens (on `index.html` *or* `edit.html`), the `idle` endpoint
  computes the dispatch wait for each gap's arriving install and injects it into
  that gap's `allocations` as an editable **`DISPATCH`** deduction — *pre-filled
  in the travel-subtraction dropdown*, so it subtracts from that gap's travel
  time. From today's `Dispatch` rows it takes the latest request at/before the
  stop with the same `oldJ`: **same day** → the measured wait (install − request);
  **cross-day** → `avg × 1.25` (don't count the overnight hours). A flagged stop
  with *no* logged request falls back to the running **average**. It's only
  suggested when the gap has no already-saved `DISPATCH` allocation, so re-opening
  a closed day never doubles it.

The crew can edit or remove the pre-filled minutes; `Finish` saves it through
`saveTravel` as a normal gap-tagged `DISPATCH` `Downtime` row, so it flows through
`buildDaySummary` untouched — subtracting from that gap's travel time **and**
counting in the Tracker `dispatch` column / the daily-log PDF's Delays bucket /
the viewer counts (exactly like a LUNCH or BREAK gap allocation).

**The EOD review is the *only* place to add/edit dispatch downtime.** The manual
*Add downtime* form no longer offers a `DISPATCH` reason — it was double-counting
against the pre-filled gap deduction. `CATEGORIES` in `Code.gs` still includes
`DISPATCH` so the EOD deduction tallies normally; the field form just stops
emitting it.

**Boat-shared total.** A dispatch wait stalls the whole boat, so the crew share
one number. At end-of-day `updateBoatDispatch(date, team)` sums every boat
member's own `DISPATCH` `Downtime` (via `dispatchMinFor`) and writes each
member's own total + the shared boat sum onto their `Days` row (`dispatchMin` /
`boatDispatchMin`; see "Day" above). It recomputes from the live `Downtime` rows
on every close, so editing dispatch downtime and re-finishing updates the sum for
the whole crew. The shared sum prints on the daily-log PDF (`boatDispatch`
anchor) — an installer closing before teammates may print a stale (smaller)
number, which is acceptable since the `Days` backend is the source of truth and
always converges. `map.html` analytics shows "Avg boat dispatch downtime" (mean
of boat-day sums, from Tracker `dispatch` + `BoatDays` membership) and "Total
dispatch downtime" (every installer's own total summed). This is distinct from
the existing "Avg dispatch downtime" tile, which is the measured request→install
wait from the `Dispatch` tab.

**Time format.** Both `requestTime` and the stop timestamp are naive Toronto-local
`yyyy-MM-dd HH:mm:ss`; `parseLocal()` builds a component-wise `Date` from each so
the difference is exact regardless of host zone. The shortcut must send its `time`
in that same format (a "Format Date" step with a `yyyy-MM-dd HH:mm:ss` Toronto
custom format).

**Analytics.** `?action=dispatch` returns all `Dispatch` rows; `map.html` averages
the `matched=Y` ones (scoped by the page's installer + date filters, dated by
`completedTime`) into the "Avg dispatch downtime" tile.

**Avg dispatch time.** `avgDispatchTime()` in `Code.gs` is the **single source of
truth for the global match + the running average** — it runs from an **hourly time
trigger** (`avgDispatchTimeJob`; installed once via `createAvgDispatchTrigger()`),
not inside `endOfDay`: the O(Stops × Dispatch) pairing is the most expensive
computation in the spine, and holding the write lock with it while the whole crew
closes at quitting time was the sharpest scaling bottleneck. The job skips
quietly if a write holds the lock (the next hourly run converges). It pairs **every** requested meter (`Dispatch`) to the completed
install (`Stops`, status `INSTALLED`/`UTI`) carrying the same `oldJ` — each request
claiming the earliest still-unused install at/after its `requestTime` — **fills**
that `Dispatch` row (`installer`/`completedTime`/`minutes`/`matched=Y`), then
writes the rounded mean wait in minutes to the **`Metrics`** tab (row
`avgDispatchTime`). The mean is built from **same-day pairs only**; a cross-day
pair is still marked `matched` but its `minutes` are recorded as `avg × 1.25` and
kept *out* of the mean, so an overnight wait can't inflate the average that the
cross-day rule then multiplies. Keyed on the install record rather than a live
flag, it is retroactive — it counts installs that were never tapped "Requested?"
— and idempotent (re-runs converge; only changed rows are rewritten, unmatched
rows are left alone). `?action=avgDispatchTime` is a pure read of the stored
`Metrics` value; `?action=idle` reads it as the basis for a flagged stop's
fallback estimate and the cross-day cap.

**Known limit.** `addStop` now carries a client-generated `id` and the spine skips a
duplicate id, so a timed-out-but-succeeded retry of a completed stop no longer
double-writes. `dispatchRequest` (the Apple Shortcut path, not on the offline queue)
still has **no idempotency key**, so a retried request could double-write; and oldJ-only
matching can mis-attribute if two crew reuse the same oldJ at once — accepted trade-offs
consistent with the rest of the app.

---

## Auth / config (current state)

- **One shared token**, defined once in `js/config.js` (imported by every page),
  must match `SHARED_TOKEN` in `Code.gs`. The Web App URL lives there too. That's
  the only two places either value appears now (was five).
- **No page-level login** on the viewer — a deliberate trade for "open the link
  and it works." The token sits in the page source, so anyone who opens either
  page can read it. Keeping the repo private is a sensible extra step.
- **Identity = self-registration** (first name, last name, H number) on first
  open of `index.html`. The form enqueues a `saveEmployee` call through the
  offline queue, so the employee record is created even with no signal at
  registration time. Good enough for a small crew; see the limits below.

---

## Build order

1. **Spine + store** — create the Sheet, paste `Code.gs`, deploy as a Web App,
   grab the `/exec` URL, and run `setupSheets()` once to create the tabs.
2. **Field capture** — host `index.html` (the PWA) on GitHub Pages, paste the
   `/exec` URL into `WEB_APP_URL`. Each person sets their name. This is the daily
   tool, replacing paper.
3. **Project** — make the Claude Project and generate the formatted daily sheet
   + summaries via the connector.
4. **Map + analytics viewer** — host `map.html`, paste the same `/exec` URL.
   *(Done.)*
5. **Crew + boat teams** — host `teams.html` (same `/exec` URL + token). After
   pasting the current `Code.gs`, **redeploy** the Web App and **re-run
   `setupSheets()`** once to add the `Employees`, `Teams`, `Captains`, and `Subs`
   tabs (it leaves existing tabs untouched). If a `Teams` tab already exists from
   an older schema, **delete it first** — the column order changed. Add the crew,
   build the boat cards (assign letters to members), and each installer fills out
   the self-registration form on first open. *(No template rebuild needed — the
   daily-log header boxes already existed; the spine only maps values into them.)*
6. **Later (parked):** a WordPress showcase site, optional GPS-based downtime
   auto-detection, and the scale-up work in the next section.

---

## Known limits & next phase (the path past a small crew)

The current Sheets + Apps Script design is great for a handful of installers. It
is not built for ~200, and the gaps are worth recording before they bite:

- **Apps Script ceilings.** Web apps have per-script concurrent-execution and
  daily-quota limits. Predictable busy windows — everyone logging around the
  morning start, everyone hitting End of Day at quitting time — will approach or
  exceed them at scale. Failures are quiet (the offline queue just keeps
  retrying), so it shows up as sluggishness before it shows up as errors.
- **Reads load the whole sheet.** `lookup`, `pins`, `tracker`, and `nearby` each
  pull every row into memory per call. Fine at hundreds of rows; linearly slower
  as months of data accumulate across many people.
- **Identity is a free-text name.** Two "Mike"s merge into one; nothing
  authenticates who logged a stop. **Partly addressed:** the crew now lives in
  the `Employees` tab keyed on the **employee number** (H number), the installer
  picks themselves from that list, and end-of-day joins on the H number — so the
  boat-team auto-fill is collision-proof. **Still pending:** stop rows are still
  filtered/attributed by the display name (not the H number), so same-name
  collisions remain possible in the `Stops`/`Tracker` tallies until those rows
  also carry `installerId`.
- **One shared token, in public files.** No way to revoke one person without
  rotating everyone's. **Planned fix:** per-installer credentials tied to the
  employee number.
- **Write de-duplication (queued appends).** `addStop`/`addDowntime` now carry a
  client-generated `id`; the spine's `idExists()` skips a row already written under
  that id, so a request that times out client-side *after* the server wrote the row no
  longer duplicates on retry. `flush()` also keeps an item queued unless it sees a real
  success, and is re-entrancy-guarded. `dispatchRequest` (off-queue, Apple Shortcut)
  is still unkeyed — **planned fix:** extend the same id check there.
- **`updateStop` has no audit trail.** Edits overwrite in place with no history.
  **Planned fix:** record who/when/old-value for corrections.
- **Single point of failure.** The spine runs as one Google identity
  ("Execute as: Me").

**Rule of thumb:** don't rebuild preemptively. Harden the cheap, high-value
items (employee-number identity, write de-dup) early since they're painful to
retrofit once months of rows exist; treat replacing the Apps Script spine +
Sheets store with a real backend + database as a bridge to cross only when real
slowdowns appear — likely well before 200, somewhere in the tens of active
users.
