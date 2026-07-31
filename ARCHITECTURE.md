# Meter Log — Architecture & Data Structures

Digitizing the paper daily log for a hydro meter installer. Fast capture at the
meter on an Android work phone (offline-friendly), durable storage in Google
Drive, automatic running totals, a map + analytics viewer over the data, and
Claude for the formatted daily deliverable + the messy/natural-language bits.

---

## The three layers

**1. Data layer (system of record) — Google Sheets in your Drive.**
One spreadsheet, seventeen tabs: `Stops`, `StopsArchive`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`, `Timing`, `Days`, `BoatDays`, `Dispatch`, `Metrics`, `InstallerMetrics`, `Worklist`, `WorklistPlans`, `DriveTracks`. This is the truth.
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
  optimize with road distances from a **local OSRM server** and automatic local
  Nominatim geocoding (`http://localhost:5000` / `http://localhost:8080`, with
  saved custom URLs). OSRM/Nominatim readiness badges mean their probe received
  a usable HTTP response — not merely that a Docker container is running. A
  pre-optimize confirmation says which cached/new addresses and matrix fallback
  chain will be used; the completed run records its actual provider/matrix
  provenance in persistent `localStorage['plannerLastOptimize']`. The desktop
  planner uses local OSRM → ORS → straight-line for road routing, never Google
  road matrix. Review the numbered route + connecting line on a Leaflet map,
  then ⇪ Upload (`saveWorklist`). Pins + order ride the sheet, so the phone's
  ⇩ Download lands a finished route with zero phone-side spend. The PC's
  IndexedDB `worklist` store is its scratch copy (cleared per installer switch).
  Timed appointments, fixed queue slots, route settings, and resulting ETAs
  round-trip with the route so the office and phone see the same plan.
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
the planning page's explicit **Upload** button; a batched body rewrite keyed on
the employee **H number** (names can collide, H numbers can't), so a re-upload
never duplicates and an empty upload clears the saved copy; `order` is
**renumbered server-side** 0,10,20… by sorted position on every upload — never
written verbatim — so duplicate/blank order values from old clients can't
round-trip; the nightly `clearDoneWorklistJob` runs the same
`normalizeWorklistOrders()` repair across every installer's rows),
`savePlan` (plan-only upsert of one installer's `WorklistPlans` row — route tuning +
`target` — **without** touching order rows; the phone posts it on Download so its
installer-owned tuning/target reaches the office without the whole-list replace
`saveWorklist` would do; see "WorklistPlan row"),
`saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`,
`saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`,
`saveDriveTrack` (append one Drive-mode driving leg — client-generated `id`,
idempotent on retry like `addStop`; see "Drive mode").
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
local list with them, renumbering by array position as it lands),
`driveTracks` (Drive-mode driving legs, optionally one installer + a from/to
window on the leg date — backs the map viewer's route replay; see "Drive mode").

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
  (`addStop` no longer answers with `ok:false, duplicate` — a duplicate J# is a
  warning on an `ok:true` ack now, see §"Duplicate J numbers". `duplicate` stays
  in the accept list because `saveDriveTrack` still uses it for an idempotent
  re-send, and because an old spine must never wedge the FIFO.)
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

**Force update from GitHub.** Stale-while-revalidate always leaves a phone one
load behind a push, and the worker's background re-fetch is itself answerable
from the browser's HTTP cache — GitHub Pages serves a `max-age`, so a phone can
sit on old code indefinitely. Settings ▸ **⟳ Force update from GitHub**
(`#refreshApp`) is the escape hatch: `refreshAppShell()` in
`js/pages/capture.js` calls `registration.update()` (picking up a `SHELL` that
gained files), then posts `{type:'REFRESH_SHELL'}` to the active worker over a
`MessageChannel`. `sw.js`'s `refreshShell()` re-downloads its own `SHELL` — six
at a time, each as `new Request(url, {cache: 'reload'})`, which is what actually
bypasses the HTTP cache — reporting `{type:'progress', done, total}` per file
and finishing with `{refreshed, failed}`; the page then reloads.
`{type:'VERSION'}` returns `CACHE` for the version line.

The design is deliberately **in-place, not nuke-and-reload**. Each file is
`cache.put` only on `res.ok` and nothing is deleted first, so a download that
dies mid-way leaves the previous shell intact rather than stranding the phone
without one. And it rewrites **Cache Storage only** — never `localStorage`
(name, H number, sub, home, work mode) and never IndexedDB (`queue`, `dayCache`,
`worklist`, `addrCache`), so updating costs the installer nothing: no re-entered
details, no dropped un-synced writes. The only `localStorage` change is an added
`shellRefreshed` timestamp behind the version line.

It is also **static files only — the refresh makes no spine calls at all**
(measured: 0 Apps Script requests across the whole `REFRESH_SHELL` run, against
60 files re-downloaded). `SHELL` is same-origin relative paths and the `/exec`
endpoint has never been in it, so there is nothing in the list that could reach
the Sheet. The reload afterwards is an ordinary app open and does whatever any
open does — the usual `roster`/`range` read plus a queue flush — which is why
`tests/cache-refresh.test.mjs` pins `SHELL` to relative paths.

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
- **`jdup.js`** — the pure duplicate-J# rule (`normalizeJ`, `jConflicts`), shared
  by the capture page's pre-submit chooser and — as a hand copy pinned by
  `tests/jdup-parity.test.mjs` — by the spine. It finds conflicts and nothing
  else; see §"Duplicate J numbers (warn, never discard)".
- **`worklist.js`** (the worklist screen + plan mode),
  **`worklist-route-view.js`** (the phone's selected-day Leaflet route editor),
  **`worklist-address-fill.js`** (the one-at-a-time address walkthrough, plus the
  address text helpers `splitAddr`/`joinAddr`/`recentStreets` and the
  queue/sink rules),
  **`drag-autoscroll.js`** (drag-to-the-edge page scrolling, shared by both
  touch-drag lists),
  **`route.js`** (the optimize pipeline: Google forward geocoding bounded to ~80 km of the crew +
  Google Routes road matrix (budget-guarded, straight-line fallback) + pinned
  open-path TSP — see "Work modes" ▸ "Route optimization"),
  **`route-variants.js`** (the two saved routes and their distances — pure
  functions shared by the phone worklist and the desktop planner so the two
  screens can't drift; see "Route variants").
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

**Reset a work order (index.html, Today's orders).** Beside "Remove from log…" the
Today stop card carries **↺ Reset order…** (`opts.resettable`, wired in
`js/pages/capture.js makeStopCard`) for "I logged the wrong thing — start this house
over." It fires the same `archiveStop` to pull the logged meter back out of the day,
then calls `resetWorklistOrder(workOrderId)` (`js/worklist.js`) — the inverse of
`markWorklistDone`: it flips the matching worklist order back to `pending` (preferring
a `done` match), **keeping** the typed WO#/address/unit/old J#/pin while clearing the
done-only derived state (`ignored`, lock, `scheduled*`), then re-applies the today
anchor so an order that belonged to today returns to Day 1. No new spine action — it
composes `archiveStop` (the meter) with a local worklist edit (the order), and the
whole-list `syncWorklist` pushes the revived order up.

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

## Duplicate J numbers (warn, never discard)

A J number is a meter's serial: **New J#** is the meter going in, **Old J#** the
one coming out. The same serial twice means somebody mistyped it or logged the
stop twice — but *which* of the two entries is wrong is a judgement call the
installer makes standing in the driveway. So the system only ever **finds**
conflicts. It never rejects, merges or deletes a stop.

**This replaced a reject path, and that history is the point of the section.**
`addStop` used to `return { ok:false, duplicate:true, history }` on an exact
WO#+New J# match — *before* `sh.appendRow(row)` — and the phone rendered
"Duplicate — … Entry discarded." Real field work was destroyed by it, at the
moment the crew is least able to notice. The row is written first now, always;
the warning rides back on an otherwise ordinary `{ok:true}` ack.
`tests/stop-never-discarded.test.mjs` fails the build if an early return
reappears in `addStop` before the append.

### The rule

`js/jdup.js` — pure, DOM-free, unit-tested (`tests/jdup.test.mjs`).
`jConflicts(candidate, stops, {from, installer})` returns one `{stop, field,
value}` per matching (stop, field) pair.

- **Same-field only.** New J# against New J#, Old J# against Old J#, never
  across the two. A meter installed at one house and legitimately pulled out of
  another later carries that serial in *both* columns by design — cross-matching
  would flag every ordinary swap and train the crew to dismiss the warning.
- **A blank J# never matches.** Every UTI has a blank New J# and most rows have
  a blank Old J#; blank-vs-blank would flag the whole week. This is the single
  most important guard in the module.
- **An Old J# repeated on the SAME work order is not a conflict.** The revisit:
  a UTI records the old meter's serial, the crew comes back and installs — same
  site, same meter, two correct rows. Nothing is lost by the carve-out, because
  two real installs on one order still surface through the New J# rule (same
  meter) or the WO#-keyed `flagged` warning (different meter); an Old J# across
  two *different* orders — the actual mistype — still fires.
- **Self-exclusion by id**, and **no status filter** (a duplicated Old J# on a
  UTI or a Visit is as real as one on an install). Removed stops are out of
  scope on both sides for free — the spine keeps them in `StopsArchive`, and
  `applyOptimisticCache`/`mergePendingRows` drop them from `dayCache`.
- **Scope: this installer's own stops, the last `J_DUP_DAYS` = 7 days**, and the
  window is anchored on the **stop's own date**, not "today", so a leg logged
  offline and synced days later is still checked against the right week.

### Where it runs — twice, on purpose

1. **On the phone, before the stop is sent** (`js/pages/capture.js`). A hit
   blocks the **Log stop** tap and shows the `#jConflict` chooser naming the
   order the number is already on — *Go back and fix it* / *Log it anyway*. The
   entry stays in the form either way. The index it checks against comes from
   `loadRecentDays(7)`, which is exactly the agreed scope and reads only
   IndexedDB, so the check fires **with no signal**. It is **preloaded into
   `recentJStops` rather than awaited inside the handler**: `$('logStop').onclick`
   must stay synchronous or the plan-mode WO# clipboard copy loses its user
   gesture. "Log it anyway" acks the entry's `jSignature` (status-free: WO# +
   New J# + Old J#) and re-enters the same handler, so it is scoped to the exact
   question asked — editing a J#, filling from the plan, or logging the stop
   clears it.
2. **On the spine, on the ack** (`Code.gs jConflictsFor` → `res.jConflicts`).
   Wider than the phone can be: it sees stops the crew logged from another
   device, and anything the phone's week missed. Surfaced by the queue's
   `onResult` hook as the amber notice banner, which — unlike every other notice
   — does **not** auto-dismiss, because it is something to act on. Suppressed
   when the chooser already asked about that exact entry.

`Code.gs` carries a hand copy of the four rule functions (Apps Script cannot
import an ES module). `tests/jdup-parity.test.mjs` evaluates the real `Code.gs`
source and holds both to the same output — without it the two drift silently,
and the feature just behaves at random. **Change one, change the other.**

The response is additive (`res.jConflicts`), and the older WO#-keyed
`flagged`/`history` pair is still set alongside it, so a phone running cached
pre-`jConflicts` modules still shows *something* and still keeps the stop. **No
schema change** — no new `Stops` column, so no `setupSheets()` re-run.

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
  copy-street-forward cut repeat typing on same-street runs. Dragging to within
  ~96 px of the top or bottom of the screen **scrolls the page under the finger**
  (`js/drag-autoscroll.js`, shared with the route editor's list), so a card can
  cross a list longer than the screen in one gesture; each scrolled pixel is
  folded back into the drag anchor and the slot re-picked, which is what keeps
  the card glued to the finger. Each card with an
  address gets a 🧭 **Directions** button — it opens the OS maps app in a new
  context (Apple Maps on iOS, the Google Maps universal dir link elsewhere) on
  the order's **address text** plus an `", ON"` region hint (the typed address is
  the source of truth: a mis-geocoded pin must not steer the truck), falling back
  to the cached coords only for an addressless order. It also **copies the
  address line to the clipboard** on the way out — the crew pastes it into the
  work app while the route loads; the write is issued synchronously in the tap
  handler, before the iOS scheme hand-off takes the page away, and a
  denied/unsupported clipboard never blocks directions. The explicit
  **⇪ Upload / ⇩ Download** buttons move the list between devices via the
  sheet's `Worklist` tab (see "Client-side storage" and the `Worklist` row
  shape). **Plan mode** (`localStorage['planMode']`, toggled on the worklist
  screen) feeds the capture form: the first pending order pre-fills it, each
  logged stop advances to the next, Skip sends the current order to the back of
  the queue. If the planned address and the GPS-resolved one materially
  disagree, an inline chooser makes the installer pick before the stop can be
  logged. **View route map** opens `#worklist-route`, a phone-sized Leaflet
  editor over that same IndexedDB list: it defaults to the first remaining
  numbered day (with chips for later days and unassigned orders), draws cached
  routable pins + a numbered line, and keeps parked pins visible as muted `!`
  markers outside the line. A compact list below the map can be reordered by
  touch or keyboard within the selected day; the existing whole-list
  `0,10,20…` order normalization persists the change immediately, with no
  second copy or Save step. Opening the view never geocodes or optimizes.
  Cached pins and reordering work offline; only the OSM tile background needs
  signal. Hardware/browser Back follows route editor → worklist → capture.
  **📝 Fill in missing addresses** opens `#worklist-address`
  (`js/worklist-address-fill.js`), a one-order-at-a-time pass over everything
  that can't be routed — blank address, `geoFail`, or `geoAmbig`. The work app
  the crew plans from labels its GPS pins with nothing but a WO#, so a list is
  built from numbers first and the addresses looked up after; doing that through
  the list meant scrolling to an order, opening Edit (which paints at the *top*
  of the screen), saving, and scrolling back. The screen shows the WO# big enough
  to read and tap-to-copy, the address fields, the same one-tap town chips an
  ambiguous card offers, and ‹ Back / Skip › / Save & next. The queue is
  **snapshotted on open**, so saving advances but Back still steps into orders
  already filled. Leaving it — by the button, by Finish, or by hardware Back —
  runs the sink once: orders **still without any address** are renumbered to the
  bottom of the pending group (above done and set-aside) through the same
  `persistOrderIds` the drag uses, so locks and appointments are still honoured,
  and the list heads that group with a "Needs address" divider. An order that has
  an address the geocoder disliked keeps its place — it is routable text, just
  unpinned. Entirely local: no network on any path.
  Orders can carry a Toronto-local timed appointment and a fixed calendar-date /
  within-day slot. Appointment cards use a bell badge; locking snapshots the
  current date+slot, removes that card's drag handle, and survives Upload/Download.
  This per-order lock is **not** the work-list lock below — that one freezes the whole
  of day 1 and lives on the `WorklistPlans` row, not on an order.
  `WorklistPlans` stores route start date, first-stop time, editable pace, the
  installer-owned tuning (`commutePull`) + `target`, and the work-list lock's
  `dayLockDate`, once per H number instead of repeating those settings on every order.
- **Offline road maps (`js/roadgraph.js` + `js/roadpack.js` + `tools/build-roadpack.mjs`).**
  The phone's own road-distance source, and the first rung of the matrix ladder
  below. A **district pack** — the drivable OSM road network for one working area,
  distilled to node positions, segments with a speed and a oneway bit, and the
  shape points for drawing — is downloaded once from Settings ▸ **Offline road
  map** and kept in the IndexedDB `roadPacks` store. `js/roadgraph.js` then does
  on-device what a self-hosted OSRM does over HTTP: snap coordinates to the
  network, run one Dijkstra per source (costed in seconds, carrying metres), and
  reconstruct paths. `matrix()` returns the **same `{D, T}` shape `osrmMatrix`
  returns** — metres and minutes — which is what lets it drop into `optimizeRoute`
  without anything downstream changing, and `path()` feeds the existing
  `encodePolyline` so the **phone can finally produce `legGeometryRoad` itself**
  rather than only decoding the planner's.
  A ~150 km district lands at a few MB. **The phone's 🧭 Optimize tap requires one**
  — no district, no on-device optimize (the two-second network hold is exempt); see
  §"Work modes" ▸ "Route optimization". Things that are load-bearing here:
  - **The route map measures its legs at draw time, and that is what keeps the
    roads on screen.** `offlineRoutePaths(legs)` (`js/route.js`) takes the legs
    the map is about to draw and returns a path per leg from the pack — one
    shared decode, the run's own coordinates picking the district as always. It
    exists because *saved* geometry is keyed to the sequence it was fetched for,
    and the phone reorders that sequence constantly: `applyTodayAnchor` re-leads
    the pending list after every logged stop, which trips `variantMatchesLive`
    and made both maps drop the geometry wholesale. Measuring what is on screen
    removes the staleness question instead of answering it. Precedence is
    **measured → saved → straight**; the saved tier keeps its gate, since on a
    phone with no district of its own that polyline is the planner's OSRM path
    and can genuinely be stale. A leg the pack can't carry is simply absent from
    the result, which every caller already draws straight.
  - **The pack stores only raw arrays.** The adjacency (CSR) and the snapping grid
    are rebuilt at decode time — both O(segments) and a few milliseconds — which
    keeps the format small and the writer simple. Decode is not the slow part.
  - **`snap` splits a segment without mutating the graph.** It returns the metres
    to each end (`toFromM`/`toToM`, scaled so they sum to the pack's `segLen`), and
    the search is seeded at both endpoints with those partial costs. Same-segment
    pairs are handled directly. Snapping to the nearest *node* instead would be
    half a block wrong on every stop.
  - **Oneways are honoured**, so the matrix is legitimately asymmetric. A router
    that ignored them would send the crew the wrong way up a street.
  - **The repair pass in `localGraphMatrix` is not optional.** Anything the graph
    can't reach (a stop that snapped to no road, a disconnected island) comes back
    `Infinity`, which would poison the solve and every metre total downstream; those
    pairs — and only those pairs — fall back to crow-flies × `ROAD_DETOUR_FACTOR`.
    The run says so in its `note` rather than patching silently.
  - **Coverage gate.** A run is routed locally only when the pack covers
    ≥ `LOCAL_MIN_COVERAGE` (80%) of its coordinates; below that the crew is working
    outside the district they downloaded and the run declines to the next provider.
  - **Packs are not in `sw.js`'s `SHELL`** — they are megabytes and `refreshShell()`
    re-fetches the whole shell on every ⟳ Force update. They live in IndexedDB and
    survive app refreshes. The `roadgraph.js`/`roadpack.js` *modules* are in `SHELL`.
  - **A phone may HOLD several districts but ROUTES on one per run.** `loadGraph(coords)`
    scores every installed district on how many of the run's stops fall inside its
    **bbox** — `pickPack` in `js/districts.js`, pure and unit-tested — and decodes only
    the winner, which then becomes the active district so Settings keeps naming what is
    in use. Scoring reads the descriptors in the localStorage mirror, never a decoded
    graph: deciding by decoding each candidate is exactly the cost the one-graph rule
    exists to avoid. Ties go to the district the installer picked by hand, and a run
    that says nothing (no coords, or every stop outside every district) falls back to
    that same choice rather than to no map at all. Stops outside the winner take the
    repair path above and price crow-flies. A district that fails to decode is dropped
    **before** the scoring, so one corrupt pack can't win the run and mask a good pack
    beside it.
  - **The desktop planner is deliberately excluded** (`opts.osrmUrl` set): its local
    OSRM has turn restrictions and penalties this graph does not, so it stays the
    better answer where it's available.
  Packs are built by `tools/build-roadpack.mjs` (plain Node, no dependencies) from
  a bbox-clipped `osmium` export of the same Ontario `.pbf` already downloaded for
  OSRM, and committed under `maps/` with a published `maps/index.json` catalogue —
  GitHub Pages serves them like everything else. See DEPLOY.md and `maps/README.md`.
- **Turn-by-turn directions (`js/directions.js`, pack v3).** The graph already knew
  the way; v3 adds what each road is *called* — a road-name table plus one name id
  per segment (`segName`/`roadText`/`roadBlob`, appended, ~4 bytes a segment) — and
  `pathDetail` returns the segments a drive ran over and the direction each was
  driven. `buildDirections` turns those into instructions: bearings in and out of
  each segment give a signed turn angle, `TURN_BANDS` classifies it, and the road
  name says what to turn onto. All pure and DOM-free; `offlineDirections(from, to)`
  in `js/route.js` is the wiring, and it picks the district from the stops exactly
  as the matrix does. Names are stored **raw**, deliberately unlike the address
  index's `normalizeStreet` form — this text is read by a driver, so "Muskoka Road
  3" must not arrive as "muskoka rd 3". Three tidying passes, each added because
  the raw list read badly against a real district and each pinned by a test:
  short steps (< `MIN_STEP_M`) fold into the one before, adjacent steps on the same
  road rejoin, and a turn onto an unnamed link adopts the name of the road it leads
  onto ("Turn left onto Highway 11 for 4.4 km", not "Turn left for 430 m" then
  "Continue on Highway 11"). A road that **bends** stays one instruction — merging
  only on a dead-straight join produced a stack of unusable 30 m steps on a curving
  concession. **The pack carries no turn restrictions**, so these are a driver's aid
  and not something to follow blindly; that is the same reason the desktop planner
  still routes against a real OSRM, and the UI must say so. A v2 pack routes fine
  and simply reports `canGiveDirections === false`.
- **Offline geocoding (the pack's second job).** Forward geocoding was the one part
  of Optimize that still needed signal after on-device routing landed, so pack v2
  carries an address index built from the same extract: a street dictionary, a
  locality dictionary, and house-number points sorted by (street, number).
  `geocodeAddress` is wired into `geocodeOne` as **provider −1, ahead of Nominatim,
  Google and ORS** — free, instant, radio off. A miss is not an error: it falls
  through to the network providers exactly as before, so a thin OSM area still
  geocodes when there's signal. Load-bearing details:
  - **`normalizeStreet` runs on both sides** — the builder normalizes OSM's
    `addr:street` before storing it, the phone normalizes what the installer typed.
    They must agree or the phone silently fails to match addresses it actually has.
    Its rule is subtle: a suffix expands anywhere **except** the first word, because
    "Concession Rd 4" and "County Rd 12" put the suffix mid-name while "St Andrews
    Rd" (Saint) must not become "street andrews road". Directions expand anywhere,
    so "N Main St" and "North Main Street" collide.
  - **Missing house numbers interpolate** between the bracketing neighbours. OSM
    rarely has every civic number, and "between 410 and 460" puts the pin on the
    right stretch of a 12 km concession rather than at one end of it.
  - **One hit per locality, never auto-picked.** The same street name recurs across
    a district, so `geocodeAddress` returns a hit per town and route.js's existing
    `pickBest` raises the "⚠ pick a town" ambiguity — the same protection the online
    providers get.
  - A roads-only pack (no address file at build time) is perfectly valid and simply
    has no offline geocoding.
- **District building from the planner (`tools/roadpack-server.mjs`).** Drawing a
  rectangle on the planner map beats hand-typing bbox corners, but a web page can't
  run Docker — so a small **local helper service** does, in the same spirit as the
  OSRM and Nominatim containers already on the planning PC. The planner probes it
  (`probeBuilder`) and **hides the whole Districts panel when it isn't running**:
  it is needed to *make* a district, never to plan a route, so its absence is normal
  rather than a fault. Build runs the `osmium` chain in Docker, then `buildPack`,
  and writes `maps/`. **Publishing is a deliberately separate button** — a push to
  `main` is a live deploy of the whole app, so it asks first and only ever stages
  `maps/`. Security posture, worth keeping: the service binds to **127.0.0.1 only**,
  every child process is `spawn`ed with an argument array rather than a shell string,
  and the district id is validated against a strict slug before it reaches a filename
  or a git command.
  Two more things the panel can do, both landing in `maps/` and both reaching phones
  only via that same Publish:
  - **⊕ Extend** grows a district instead of making a new one. A district *is* one
    rectangle, so extending means rebuilding the **same id** over `unionBbox(old, drawn)`
    — `buildPack` already overwrites the pack and replaces the catalogue entry, so an
    extend is a build over more ground and nothing else. The id input locks while
    extending, because a changed id would quietly build a second district instead. When
    the two rectangles are far apart the union is mostly land nobody drives, so the
    panel warns above `SPARSE_UNION` (2× the ground of the areas themselves) and points
    at a separate district — which is now a real option, since the phone picks between
    districts per run on its own.
  - **A drawn rectangle is wrapped, then trimmed, before it is built.** Leaflet
    reports **unwrapped** longitudes, so panning the map sideways onto the next copy
    of the world posts a Parry Sound rectangle at −440 instead of −80; osmium rejects
    that outright and the failure carried the clipping step's label, which read as
    "outside the province". `normalizeBbox` wraps it at both ends — the planner where
    the box is made, the server on the way in. It is then clamped to the extract's own
    header bbox (`/status` `pbfBbox`, one cached `osmium fileinfo`), because nothing on
    screen shows where the province data stops and clipping empty ground does not fail
    at the clip — it fails a minute later in the pack build. Trimming is necessary but
    not sufficient: Geofabrik's bbox is a rectangle around a province that isn't one,
    so a corner of it still holds no roads, and that case is reported as a rectangle in
    the wrong place rather than as `buildPack`'s "wrong input file?".
  - **The build reports weighted progress.** `BUILD_PHASES` in the service carries a
    weight per phase and the job exposes `phase`/`step`/`steps`/`pct`/`startedAt`; the
    panel draws a determinate bar. The weights are the point: the first phase scans the
    whole province extract whatever the district's size (~79% of a measured small
    build), so equal steps left the bar on 1/9 for most of it. `pct` counts work
    *behind* the current phase, so it is honestly 0 through the clip — the moving
    stripes on the track, not an inflated fill, are what show the build is alive.
    Scratch files are removed in a `finally`, since a failed build is the one that
    leaves the most behind.
  - **✕ Remove** (`POST /remove`) deletes `maps/<id>.pack` and its catalogue entry.
    The slug is validated exactly as `/build` validates it — this reaches a filename.
    It is local until Publish, which stages the deletion through the same `git add`.
    **A phone that already downloaded the district keeps it**: the pack is in that
    phone's IndexedDB and still routes. Unpublishing is the office tidying its
    catalogue, and reaching through it to delete a crew's working offline map mid-day
    would be the worse failure. Because an extended district keeps its id and name, the
    Settings picker compares the catalogue's `builtAt`/`bytes` against what is installed
    and shows **↻** rather than ✓ — without that, a grown district reads as "already
    installed" forever and never reaches the crew.
- **Route optimization** (`js/route.js`, the 🧭 Optimize button on the worklist
  screen). **There is no single ladder — the entry point picks one:**

  | run | matrix order |
  |---|---|
  | phone, normal **tap** | on-device road graph → straight-line |
  | phone, two-second **hold** | *(graph skipped, `opts.noLocalGraph`)* budget-guarded Google Routes → OpenRouteService → straight-line |
  | desktop planner | *(graph skipped, `opts.osrmUrl`)* local OSRM → OpenRouteService → straight-line |

  So a tap never reaches a billable matrix at all: with a district downloaded it is
  road-accurate, real durations mean ETAs lose their "(est.)" label, and Optimize
  works with the radio off — the only thing still needing signal is geocoding an
  address that has never been pinned, and those park as they always have. Without a
  district a tap simply solves on crow-flies. The **hold is the deliberate second
  opinion**: the pack carries no turn restrictions, so when its answer looks wrong
  the crew needs one press that asks a router which has them — which means the hold
  must *skip* the graph rather than merely sit below it. It is refused offline
  (`optimizeRouteHandler`), since it has no other source to fall back on. The rest
  of the pipeline runs on the phone: forward-geocode
  every pending order (**Google Geocoding API**, key in `config.js` —
  API-restricted to Geocoding + Routes (no referrer restriction — the
  Geocoding web service rejects those keys, see DEPLOY.md) and quota-capped
  per DEPLOY.md so it can never bill past the 10k/month free tier; past the
  daily cap new orders just park until tomorrow) — **with an
  OpenRouteService (ORS) backup** (`config.js` `ORS_API_KEY`, blank = disabled):
  a Google rejection/over-quota/miss retries the address on ORS (Pelias,
  GeoJSON `[lng,lat]`) before parking → pull a **road-distance
  matrix from the Google Routes API** (tiled in 625-element requests; Google
  bills per stop-pair, so a per-device monthly element budget in
  `js/route.js`/localStorage guards the free tier), then **ORS's hosted matrix**
  (one free call, `[lng,lat]`, capped at ~3,500 pairs ≈ 59 stops), then a
  **straight-line haversine fallback** when both fail or the budget is spent →
  solve the open-path TSP locally
  (nearest-neighbour + 2-opt + Or-opt) → rewrite `order`. ORS is strictly a
  backup — only reached when the primary returns nothing. **Matching is biased
  AND hard-bounded to `GEO_RADIUS_KM` (currently 240 km) around the crew** — a `bounds`
  box + `region=ca` (soft bias only on Google) plus the local haversine belt,
  which is the actual gate — so a same-named street one
  region over parks instead of matching; the gate center is the phone's GPS,
  falling back to the list's own median (also used when the fix is > 80 km from
  the list — planning far from the route area must not invalidate good pins),
  then the home pin. Stored coords are **revalidated against the circle every
  run** — but a stored pin is **never blanked**: an out-of-circle ("stale") pin
  is re-geocoded and only a successful in-circle match (or an explicit
  which-town pick) replaces it; a miss keeps the last good pin and parks the
  order by flag, so the pin still rides the next Worklist upload for future
  runs. **Parked = `geoFail` ∪ `geoAmbig` ∪ no-coords** (`isParked`) — parked
  orders never enter the matrix or the solve, even when they still carry a
  kept pin. An address matching several distinct places gets `geoAmbig` (a
  "⚠ pick a town" pill on the card, with the candidate towns as one-tap chips
  **right on the card** — the Edit form repeats them), a no-match gets
  `geoFail` (a "📍 fix address" pill) — both park at the bottom until fixed
  (existing coords, if any, are kept but not routed). The pills sit in the
  card's **title row**, next to the WO# — never at the tail of the address
  line, which wraps to full length and used to clip them; an order with no
  coords and no flags (never geocoded, or the flags were shed by a ⇩ Download
  — they never ride the sync) shows a muted "no pin" pill, derived from
  `isParked`. The flags are phone-local, never uploaded. `optimizeRoute` returns `{ orderedIds,
  parkedIds, usedFallback, fallbackReason, mode, geoReason, note, dayOf, dayFallback,
  provenance }`, where `provenance` records per-provider geocoding counts and
  the actual routing method/provider/fallback reason. Its desktop options include
  `osrmUrl` and `osrmReady`: a false `osrmReady` skips the local matrix call and
  falls back to ORS then straight-line; it never selects Google road matrix.
  (`dayOf`/`dayFallback` are the multi-day split — see below;
  `dayOf` is `{}` when `opts.target` is unset):
  `fallbackReason` is the concrete reason the solve fell back to straight-line
  (Google's error status/message, `OSRM`/`ORS <reason>`, or the spent budget —
  both providers' reasons joined when both matrix sources failed) and
  `geoReason` flags a key-level geocode rejection (`REQUEST_DENIED` etc.) that
  ORS did **not** rescue; `note` is the reassuring "addresses/roads via
  OpenRouteService backup" line when ORS carried the run — all surfaced in the
  optimize toast so a broken key no longer looks like "offline". The solve is **pinned**: normally, a home pin
  (Settings → `localStorage` `homeAddress`/`homeLat`/`homeLng`, geocoded once at
  save) fixes the route's homeward end and puts the start on the far side of the
  cluster; without Home, the list's first order is fixed as the start. The phone
  worklist also offers a **one-run GPS start**, chosen from the chooser Optimize
  opens on every run (see "the start-location question" below). When taken, Optimize
  asks for one fresh GPS fix and uses it as the fixed start while retaining Home as
  the fixed end; without Home, the end floats. The fix is reused as the geocode
  gate and is never stored or synced. If it is denied or times out, the run
  visibly falls back to the normal Home/first-order behavior. `Route starts`,
  `First stop at`, and `Pace` remain scheduling inputs applied after this
  geographic solve; they do not choose the route's geographic origin.
  **Multi-day split (`opts.target`, meters/day):** when set, the master route is
  cut into `ceil(N/target)` **contiguous** chunks (farthest→nearest home, since a
  home-pinned tour is roughly distance-banded) and **each chunk is re-solved
  home-pinned** over its own sub-matrix so the day **ends near home** — the last
  day ending at the globally closest-to-home meter, and a lone near-home order
  falling into a late day, not an early far one. With **both** a team start and a
  home (the planner's case), the team start is **ETA-only**: it stays in the matrix
  for the drive-out timing/pricing but is dropped from the ordering, so each chunk is
  still re-solved home-pinned (farthest→home). Only a phone GPS **Start from here**
  re-solves each chunk pinned at **both** ends (`orderChunkStartHome`: start → … →
  home). Zig-zag *within* a day is fine;
  only the day endpoints are constrained. It returns `dayOf` (`{id: dayNumber}`);
  with no home pin it degrades to plain count-chunks (`dayFallback:true`). The
  A day is sized by the **meters/day target and nothing else**. It briefly had a second,
  invisible input: a per-installer "Finish by" dial, with `min(target, timeCapacity)`
  shrinking the day to what landed before that clock. Above the implied ceiling the
  typed target did nothing — 16, 24 and 40 gave the same day — and the app never said
  so, which is exactly how it was reported. `timeCapacity`, `dayFinishBy`, `breakMin`
  and `opts.onSiteMin` are gone from the router; `WorklistPlans.finishBy` remains as a
  blank column only because `ensureTab` appends and cannot remove one. One clock is
  left, a **constant** (`config.js ROUTE_DAY_END`), and it answers a single unrelated
  question — is today over, for the plan day — never how big a day is. The day-landing
  projection (`projectDayReal`, the Drive screen and the tuning readout) still uses it,
  which is safe precisely because a projection reports and never shortens.
  `target` is a soft anchor from a manual meters/day field on both the planner and
  the phone worklist — the installer's `avgPerDay` (InstallerMetrics) shows beside
  it, and the day cluster syncs via the `Worklist.day` column to the phone's Day 1
  / Day 2 dividers.
- **The plan day — which day the route is being built *for*.** Day indices become
  calendar dates through `scheduleRouteConstraints`' `routeStartDate`, and the phone
  used to derive that as `nextWeekday(localDate())`. That name reads like "tomorrow"
  but is only a **weekend clamp**, so on any weekday it returned *today* — a route
  planned at 5pm on a day nobody worked was dated today, with a full day's orders
  frozen into a day already over, and an appointment booked for tomorrow pushed out
  to **Day 2** (`workdayOffset(today, tomorrow) = 1`, by construction). The calendar
  date is load-bearing in exactly one place, appointments and locks — "Tuesday 10am"
  is a promise to a customer and cannot be said as a day index — so the fix was not to
  strip dates out but to let the phone name the day. `js/route-planday.js` (pure,
  unit-tested) is that decision: `weekdayOnOrAfter` (the old clamp, honestly named),
  `nextWorkday` (genuinely tomorrow), and `resolvePlanDay`, which answers **override →
  rolled → today**. The roll fires when today is closed out, or when nothing has been
  logged and the installer's `finishBy` clock has passed; a day that is **under way**
  never rolls however late it is, because the crew is still driving it. The installer
  can also point the `#wlPlanDate` control ("Planning for") at any weekday; a stale
  override — one whose date has passed — is dropped rather than carried, and a weekend
  pick snaps forward, since `scheduleRouteConstraints` refuses a weekend start.
  `resolvePlanDay` needs the day's tally (async), while `planShape()` is called
  synchronously from a dozen places, so `worklist.js` **caches** the answer and
  refreshes it at the choke points that already await. Before the first refresh the
  accessor answers conservatively (as if the day were under way, so it never rolls on
  incomplete information): a wrong "today" self-corrects on the next refresh, a wrong
  "tomorrow" would silently move the installer's route. The **office still owns the
  date** on the sheet — the phone's implicit pushes (`syncWorklist` after a log, the
  `savePlan` riding Download) omit `routeStartDate`, and `Code.gs saveWorklistPlan`
  only writes the column when the payload carries one, because `upsertByHeader` leaves
  an unlisted header alone. Only the explicit ⇪ Upload re-dates the row.
  **A moving plan day must stay solvable, and that takes two guards.**
  `scheduleRouteConstraints` rejects an order dated before the route starts by
  *throwing*, which costs the whole route rather than that one order — and in
  `optimizeRouteHandler` the throw lands before the writes for `order`/`day` **and**
  for `legGeometry*`, so it surfaces as two unrelated-looking bugs at once: day sizes
  frozen at the last good solve (a raised meters/day target looks ignored) and a route
  map back on straight lines. So (1) `resolvePlanDay` **clamps** to
  `soonestAppointment` — the earliest pending appointment on or after today — and the
  roll never jumps over a live commitment; an explicit override is *not* clamped,
  because that conflict is the installer's to see rather than have overruled. And
  (2) `expireStaleLocks` clears any pending `lockedDate` earlier than the plan day.
  Locks are the ones that bite: `toggleOrderLock` derives `lockedDate` from the order's
  `scheduledDate`, so every lock carries whatever the plan day was when it was set, and
  the first roll invalidates all of them at once. A lock is a routing convenience whose
  day has passed, so expiring it is right; a missed *appointment* stays an error,
  because it is a promise to a customer and dropping it silently would hide that.
- **The work-list lock — 🔓 while planning, 🔒 once the day is settled.** The chunking
  above runs over the **pending** list, so as orders are logged (dropped from `pending`)
  a re-optimize refills Day 1 to a full `target` from the front of what's left, pulling
  the next day's orders up into today. That is right while the installer is still
  deciding what the week looks like and wrong the moment they have decided what they are
  driving — so they say which, with a toggle above 🧭 Optimize on the phone worklist and
  in the planner's settings card.

  - **🔓 Unlocked.** Nothing is frozen. Set the meters/day target, set the day, press
    Optimize, and every day is sized by the target and nothing else — 6 gives six-order
    days, 8 gives eight. Changing the target alone re-splits on the spot.
  - **🔒 Locked.** Day 1 is frozen exactly as it stands. Nothing moves work in or out of
    it — not a logged stop, not a Download, not another Optimize — until the installer
    unlocks. Optimize still re-solves the *geography* of the locked day; it just cannot
    change who is in it.
  - **The one exception**, while locked: adding an order raises the `#wlAddTo` sheet
    ("Add to today" / "Leave for later"). Accepted, it is slotted in by cheapest
    insertion and the day simply runs longer.

  **The lock is ONE DATE, and that is the whole of its semantics**: locked iff
  `localStorage['wlDayLock']` names the day being planned. A new plan day therefore
  releases it for free, with no timer and nothing to expire — a lock is a statement
  about one day's work, so Tuesday's means nothing on Wednesday. The frozen SET is the
  anchor beside it (`wlTodayAnchor` = `{date, ids, target}`), written once at the press
  by `freshAnchorIds` — which takes the route's current lowest-`day` group, because that
  is literally what is on the screen the installer is looking at when they decide the day
  is right. `worklist.js applyTodayAnchor()` remains the single choke point: it reorders
  pending so the locked orders lead (`orderAnchorFirst`) and re-schedules through
  `scheduleRouteConstraints` with **`opts.day1Count`**, while days 2+ fill by `target`.

  **Unlocked is not "no `day1Count`", and that distinction is load-bearing.**
  `applyTodayAnchor` also runs after every logged stop, on the Drive screen's 5-minute
  `autoSync`, on Download and at boot. If those re-chunked from the front of `pending`,
  an installer who had simply not pressed 🔒 would watch tomorrow's orders climb into
  today as they worked — the original field report, back again and on a timer. So there
  are three answers, not two: **locked** ⇒ the frozen set entire; **unlocked and asked to
  re-chunk** ⇒ `null`, size every day by the target; **unlocked and passive** ⇒ hold the
  day as currently tagged. Exactly one caller asks for the re-chunk — the meters/day box,
  which moved the number without re-solving, so its `day` tags still describe the old
  one. Optimize does not need to ask: it rewrites every tag at the new target moments
  before it calls, so holding them *is* the fresh split. **Zero is a real `day1Count`,
  not "unset"** (`route-constraints.js` tests it against `null`) — a locked day whose
  work is finished genuinely holds no stops, and truthiness there hands it a whole fresh
  target.

  Every path that re-schedules the pending list has to pass the count, not just this one:
  `switchVariant` and `persistOrderIds` (the drag write-back) call
  `scheduleRouteConstraints` themselves, and while they omitted it the lock leaked —
  flipping road↔straight, or dragging one card, silently re-chunked Day 1 back to a full
  target. `currentDay1Count()` is the single answer all three read.

- **What the toggle replaced, and why it is worth not rebuilding.** The freeze used to be
  automatic, and the whole of its difficulty was *inferring* when the installer meant to
  re-plan. `needsCommit` grew four reasons (a new day, an exhausted set, an explicit
  re-plan, a re-plan whose target had moved), `dayCapacity` bounded how far a mid-day
  raise could grow the day, `freshAnchorIds` gained `opts.max` and `opts.fromTags`, and
  `applyTodayAnchor` carried a `freeReplan`/`midReplan`/`exhausted` triangle. Each piece
  was a correct fix to a real report. Together they still could not answer the two
  questions the installer was actually asking — *is my day settled right now, and what do
  I press to change it?* All of it is gone; the press is the only commit there is.

  Two of its lessons survive as rules, because they are about the domain rather than the
  mechanism:

  - **The target counts METERS and the set counts ORDERS.** Day 1 was once
    `min(dayCapacity(target, installedToday) + anchor.extend, |set ∩ pending|)`, so an
    order carrying two meters — or any walk-up, which `markWorklistDone` never sees —
    spent the day's room faster than it spent the list, and the tail of a committed day
    was stamped Day 2 by mid-morning. Worse, once the target was **met** with orders
    still pending, capacity hit 0, `day1Count` was 0, and a full afternoon's work was
    silently declared tomorrow's — taking the pace gauge (which reads Day 1 strictly) off
    the Drive screen with the crew still working. Nothing may re-size a locked day from
    meters installed. Installing past the target reads as being **ahead of pace**
    (`targetOver`, and a `Route done ~` clock that moves later), never as a shorter list.
  - **An exhausted locked day stays exhausted.** `needsCommit` used to re-commit the
    moment the set emptied, hauling the next chunk up into today. A finished day is
    finished; more work arrives by unlocking, or by hand through "Add to today".

  Reported from the field as *"the next day's work orders are shuffling up every time …
  I download the WORK list when I start my day, I say that I'm going to do X, and I want
  it to stay at that unless I manually add more for the same day."*

- **Joining a locked day — by hand, or by the office.** Two paths add to a frozen set,
  and both are somebody's deliberate act:
  - **An order added on the phone** (`saveOrder` → `offerAddTo`, `#wlAddTo`) asks,
    because nobody else has weighed in on it: **Add to today** (the day runs longer) or
    **Leave for later**. There was a third — *Add to today, keep the day's size*, which
    rolled the tail to tomorrow — and it went with the capacity clamp: an option whose
    job is to shuffle the tail down is the reported behaviour with a button in front of
    it. The sheet appears only while the list is LOCKED (unlocked there is nothing to
    join and nothing to protect, so the question would have no consequence attached to
    either answer), **including on a day whose work is finished**: nothing re-commits, so
    bailing there would send the order silently to tomorrow. Accepted orders are slotted
    in by **cheapest insertion** (`insertByProximity`, pure, over saved pins via
    `haversine`) so they land beside their nearest neighbours instead of at the end of
    the day, then written back through the same `persistOrderIds` the drag uses so locks
    and appointments still get their say. An order with no usable pin goes last, which is
    where an unpinnable order belongs. Ids accumulate across a burst of adds — the form's
    copy-street-forward flow makes that the normal case — so one answer covers the burst.
  - **Download** (`adoptPlannerDay1`) used to ask nothing — *the planner decides, the
    phone obeys*. **The lock reverses that**: the installer pressed 🔒 on a day they had
    looked at, and an office re-plan landing during it is exactly the case the toggle
    exists to survive. Orders the office tagged `day === 1` that are not already in the
    frozen set go through the **same sheet** as a hand-typed one. Only the manual ⇩
    Download raises it (`opts.interactive`) — this also runs on the Drive screen's
    5-minute `autoSync`, whose whole contract is that it never speaks, so there the
    extras simply stay out of today and wait for the installer to open the worklist.
    Unlocked there is nothing to adopt: no frozen set exists and the downloaded `day`
    tags already are the day.

- **The lock on the sheet — one appended column, and one direction of travel.**
  `WorklistPlans.dayLockDate` carries the DATE only; the membership up there is just the
  rows tagged `day === 1`, so there is no second source of truth for the same fact. It
  rides the plan payload like `target`. Three rules:
  - **Blank is a real value**, so `Code.gs saveWorklistPlan` guards on key *presence*
    (`hasOwnProperty`) rather than truthiness — the one place it differs from
    `routeStartDate`. A truthiness guard would make unlocking from the phone a silent
    no-op on the sheet, forever.
  - **The phone adopts a lock, never an unlock.** `loadPlanFields` takes the sheet's date
    only when the phone is currently unlocked for that day; a blank column never releases
    a day the installer settled, because unlocking is a press on the device doing it.
    This is the *one* downloaded plan field the phone adopts — `target` and `commutePull`
    sitting beside it are deliberately refused, because those are tuning and a lock is
    not.
  - **A lock adopted from the sheet arrives without its set.** `applyTodayAnchor` repairs
    that by snapshotting the day as tagged — the same thing that was pressed on at the
    other end — and `currentDay1Count` falls back to the tag count in the window before
    it runs, because reading the anchor blind would return 0 and collapse Day 1.
  - The column lands at **L**, which `setupSheets()` pins to plain text. A date-formatted
    cell returns a `Date` from `getValues()`, and this string is compared for equality
    against the plan day: it would fail with no error and no wrong number to notice.

  See `js/route-today.js`, `tests/route-today.test.mjs`,
  `tests/worklist-day-frozen.test.mjs` (the wiring — which call sites may move the day),
  and the `day1Count` cases in `tests/route-constraints.test.mjs`.

  `optimizeRoute` also takes `opts.osrmUrl` — the **desktop planner's** matrix
  source: one free `table` call against a self-hosted OSRM (then the ORS backup,
  then straight-line — never the billable Google path), which is how the office
  plans a route at zero matrix cost and uploads it for the phone to Download
  (see the planner page bullet under "The three layers").
  After the geographic solve, `js/route-constraints.js` maps route days to weekdays
  and applies appointments/locks. **Appointments are never planned late, and the crew
  would rather wait than be late** — arrival may be up to 20 minutes early, earlier
  arrival becomes explicit waiting that shifts later ETAs, and `placeAppointments`
  ranks *any* on-time arrangement above *any* late one no matter what the wait costs.
  Among on-time arrangements the least waiting still wins (the latest non-late slot),
  so the day stays productive; waiting is the price of avoiding lateness, not a goal.
  The search simulates the day with the **real** orders that will fill its free slots
  — it once padded with `__free_k` placeholders the travel lookup had no rows for, so
  it priced a day of 30-minute legs as one of 10-minute legs and picked slots the
  final simulation then arrived an hour late for. An appointment that **no** slot can
  reach in time is not a route-ending error: it takes the earliest slot available and
  reports `lateMin`, surfaced as a ⚠ badge on the worklist card, the route view and
  the planner row. Only genuinely unschedulable input still aborts without rewriting
  the current route — invalid weekends, duplicate locked slots, an unparseable
  appointment time, an order dated before the route starts. When one does abort, the
  previous `scheduled*` fields survive by design (a stale route beats none in a
  truck) and `wlPlanIssue` marks them: the plan-date hint carries the reason and both
  the cards and the route view grey their ETAs, so a stale time can never read as a
  current one.
- **Two-reference, time-aware routing (desktop planner + phone).** The planner
  sources two sheet-backed references per installer instead of the phone's single
  localStorage home pin: the crew's shared **start location** (Teams `startAddress` —
  the morning muster point, departed **08:00**, no later than **08:30**) and the
  installer's own **home** (Employees `homeAddress` — the end-of-day bias). The phone
  reads both too (home from Settings; the crew start is cached read-only from Teams
  and geocoded on the phone). `optimizeRoute` takes the start as `opts.start` and the
  home as `home`. The team start is **ETA-only — never an ordering anchor**: the
  route still runs furthest-first toward home; the start only times, prices
  (`homeLegMetersFor`, still kept out of the between-stop total), and draws the drive
  OUT to each day's first (furthest) stop. `measure.startIsCommute` marks it a
  commute so `solveVariant` drops it from the ordering matrix — distinct from the
  one-run GPS start, which stays a real ordering anchor (its first leg is a charged
  driven leg).
  **Which matrix is used is the press, not a menu.** A normal tap on 🧭 Optimize
  measures **on this phone**, against the district pack, and costs nothing. Holding
  it two seconds **skips the pack** and asks the network instead (Google → ORS →
  straight-line). The tap is therefore the everyday press even for a road-accurate
  route, and the crew never has to remember which one costs money; the hold is there
  for the case the pack cannot serve, because the pack has **no turn restrictions**
  and can route you the wrong way up a street a real router knows about. That is also
  why the hold has to skip the graph rather than rank below it: while it merely ranked
  below, holding changed nothing at all inside a downloaded district. A hold with no
  signal is refused outright (it has nothing left to measure with) and the toast
  points back at the tap.
  **A downloaded district is a precondition for the tap.** With no pack the tap used
  to fall back to crow-flies distances — a plausible-looking order blind to rivers,
  dead ends and bridges, and nothing on screen said so. It is refused now, and
  `paintOptimizeGate` (`js/worklist.js`, called from every `renderWorklist`) greys
  `#wlOptimize` and prints the reason in `#wlOptimizeGate` before anyone presses it:
  *download your district in Settings ▸ Offline road map*. The **hold stays exempt**
  — it is the only second opinion a suspect on-device route has — so the button is
  greyed by a CSS class and `aria-disabled`, never by the `disabled` property, which
  would suppress the pointer events the hold gesture (and the tap's own toast) runs
  on. **The desktop planner is not gated**: it routes against a local OSRM and never
  holds a pack. Straight-line ordering survives only as the network ladder's last
  rung and as the comparison variant, never as an unannounced substitute for roads. Both presses now request `compareVariants`, so a pack-routed tap saves the
  road **and** straight-line routes for the toggle to compare — it costs one extra
  local solve and can never trigger a matrix call (`route.js` only reads the flag
  inside `if(onRoad)`). The recognizer is `js/press-hold.js` — pure, injectable timers,
  unit-tested — and `bindOptimizeGesture` in `js/worklist.js` is only the DOM wiring
  for it. It **aborts the press past 10px of travel**, because Optimize is a
  full-width button and a swipe up the worklist lands on it; without that (and with
  the `touchstart` `preventDefault()` that used to guard against iOS selecting the
  label) the button was both unscrollable and liable to start a route optimization on
  an accidental brush. Text selection is suppressed in CSS instead — see the
  `#wlOptimize` rule in `css/capture.css` and the note in AGENTS.md.
  **Which start is used is asked on every Optimize, not armed ahead of time.**
  The old persistent "Start from here" pill is gone: it was a mode the crew had to
  remember to set, and the answer changes with every mid-day re-optimize. The phone's
  Optimize now opens a **`.sheet` popup** (`askStartLocation`, `#wlStartAsk`) — the
  app's existing modal idiom, since Optimize blocks on the answer the way the
  `confirm()` it replaced did — asking *are you
  starting from the morning meeting location?* **Yes** routes the usual way
  (furthest-meter-first, working back toward home). **No** takes one GPS fix as the
  ordering anchor, so `solveVariant` runs `orderChunkStartHome` and the **nearest**
  meter is next — the answer to "I hit my target and want to keep going, but the next
  day's first stop is across the map". Cancel aborts, and so does a **backdrop tap**:
  `capture.js` closes any `.sheet` that way, so `askStartLocation` listens for the same
  click and resolves null — without it the promise would sit pending behind a hidden
  sheet and Optimize would never continue. With no home pin on file either answer
  degrades to the plain most-efficient solve, as before.
  **A live GPS start is priced straight-line — except on the on-device graph.**
  `straightLineNode` rewrites
  that node's row/column of `D` (and of `T`, scaled by `CROW_MIN_PER_METRE`) with
  crow-flies values while every **between-stop** distance keeps whatever the run
  actually pulled — the Google/ORS matrix on the two-second hold, crow-flies on a tap
  with no district, and an existing road matrix is reused rather than re-fetched. That
  rewrite exists to keep a live fix out of a matrix somebody **pays** for; a downloaded
  district costs nothing and already routed the fix along with every other stop, so the
  rewrite is skipped when `usedLocalGraph` — applying it there would replace a real road
  distance with an estimate. It therefore applies on a hold (which skips the graph, so
  `usedLocalGraph` is false) and not on a pack-carried tap, which is the correct split:
  the hold is the run that costs money. `tests/worklist-start-location.test.mjs` guards both halves. Only *which meter is
  nearest* has to be right, so the fix never needs to be in the fetched matrix and
  anchoring the route where you stand costs no matrix elements. A **team** start is
  deliberately excluded from this: its drive-out is shown, priced and drawn, so it
  keeps real road distance.
  ETAs are built from a **duration matrix `T`** — `measure.T`, exposed by
  `travelLookup(measure)` as `fromStart(id)` (morning drive out of the crew start)
  and `between(fromId,toId)` (drive between two stops). `simulateDay` builds each ETA
  from the previous departure + real travel + **on-site time**. **Every matrix source now
  carries `T`:** OSRM (`?annotations=distance,duration`), **Google Routes** (`duration`
  in the FieldMask → `parseGoogleDuration`), and **ORS** (`metrics:['distance','duration']`),
  all in minutes. When **no** road matrix is pulled — the phone's free straight-line
  default, or a fallback run — `optimizeRoute` **estimates `T` from the distances**
  (`estimateDurations` = crow-flies × `ROAD_DETOUR_FACTOR` ÷ `ESTIMATE_SPEED_KMH`) and
  sets `estimatedTimes`, so ETAs + day sizing still work offline; the route view
  labels them "(est.)"/"~". **Day sizing to ~14:00:** `timeCapacity` shrinks the
  per-day count (`dayTarget`, returned to keep the scheduler's day boundaries aligned)
  so the daily target lands by 14:00 — two hours before the 16:00 shift end — which
  makes travel-heavy days hold fewer stops (the "home bias as important as production"
  balance falls out of charging real travel time). This whole path was dead on the
  phone until durations were populated — with `T` always present it now engages.
- **Callers must pass `travel`.** `scheduleRouteConstraints` computes ETAs only when
  handed `opts.travel`; without it (the bug that showed "8:15, no drive-out") it
  silently uses the flat `firstStopTime + (slot-1) × pace` cadence. The main Optimize
  passes `travelLookup(base.measure)`; the matrix-less **variant flip** and **drag
  reschedule** pass `estimateTravelFromCoords(items, start, home)` — a haversine
  estimate over the saved pins, so those paths keep realistic ETAs on-device without
  a fetch. A downloaded planner route is always real OSRM (no "(est.)"). **That
  `start` follows the crew:** `js/worklist.js estimateTravel` anchors on
  `lastDonePin` — the pin of the most recently completed order — falling back to the
  muster point, because after the day's first stop the next drive begins in the
  driveway the crew is parked in. Gated on `planDay() === localDate()`; an evening
  plan for tomorrow starts at the depot like any morning.
- **Day 1 departs on the clock the crew is actually on** (`opts.day1FirstStopTime`).
  `ROUTE_DEPART_TIME` (08:15) is where the *day* starts, not where every re-solve of
  it starts — `scheduleRouteConstraints` applied one `firstStopTime` to every day, so
  a route re-optimized at 11:40 arrived everywhere at breakfast and `placeAppointments`
  searched an afternoon against a morning clock. `firstMinFor(day)` overrides day 0
  alone; days 2+ keep the constant, and omitting it is byte-identical to before.
  `js/worklist.js day1DepartTime` decides when it applies, and **the rule is about the
  anchor, not the hour**: an Optimize staged at the muster point keeps 08:15 (that
  press means "the day as planned from the depot"), while "Start from here" and every
  rolling re-schedule (`applyTodayAnchor` after each logged stop, the variant flip, the
  drag) use the current time. **ETAs only** — nothing in day sizing reads it, or the
  finish-by clock is back under a new name. `applyTodayAnchor`'s write guard compares
  `scheduledEta` too, since a moving clock re-times a stop that has not moved.
- **The day divider's length is read back from the schedule, not modelled twice.**
  `dayDurationMin(items, firstStopTime, fallbackOnSite)` (`js/route-constraints.js`)
  spans the departure clock to the last stop's **departure** — its `scheduledEta`
  plus its own `scheduledOnSiteMin` — so the header and the ETA badges under it can
  never disagree. It replaced `count × recent30AvgLogMin + 60`, a historical
  log-to-log cadence blind to both the distance printed beside it and the dwell
  model; that figure survives only as the fallback for a list with no ETAs yet, and
  is the only path that still adds the lunch hour (a simulated span must not, or the
  header announces a finish the last badge contradicts). `scheduledOnSiteMin` is
  therefore written by **every** path that writes `scheduledEta` — optimize, the
  today-anchor re-lead, the drag re-persist, and `applyVariant` — or the divider
  prices the last stop with the previous run's on-site minutes.

### On-site time (dwell)

The other half of every ETA, and until it was measured it was one flat number for
every stop on every route: `onSiteMinutes(pace)` = the 30-day `recent30AvgLogMin`
minus a **hardcoded** `NOMINAL_TRAVEL_MIN = 10`, floored at 8. The subtraction is
necessary (a log-to-log pace already contains the drive the scheduler is about to add
back for real); the *number* was never checked against anything.

**`js/route-dwell.js`** is the pure model — `dwellLookup({paceMin, onSiteMin,
extraMeterMin, siteFactors})` returns `{base, forItem(item, prevItem), average(items)}`
— and **`opts.dwell` is the exact mirror of `opts.travel`**, with the same trap: a
caller that forgets it silently gets the old flat number and no error. Three tiers,
each falling through to the next, so a run with no measurements schedules identically
to before the module existed:

1. **A repeat meter** — `siteKey(item.address) === siteKey(prevItem.address)`, same day
   — takes `extraMeterMin`. Deliberately *not* floored at `MIN_ONSITE_MIN`: the real
   figure is 11–12 min against a 25–29 min fresh site, and ~11% of all logged gaps are
   these.
2. **A site with a track record** scales `base` by its factor, clamped to 0.4–2.5.
3. Everything else takes `base` = the measured `onSiteMin`, else `onSiteMinutes(pace)`.

`timeCapacity` takes the same model's `average(items)` as `opts.onSiteMin`, because a
day target that disagrees with the ETAs it sizes is worse than both being wrong the
same way.

**Measured spine-side** (`Code.gs`), from data the crew already produces — no new taps
and no new order fields. For two consecutive logged stops, `gap = drive + work +
interruptions`, where the interruptions are exactly the gap-tagged `Downtime` rows
allocated in the end-of-day travel review (`isGapDeduction` — note this nets out
*every* category, where `installerRecentAvgLogMin` nets out only LUNCH/BREAK).
Subtract them and regress the remainder on distance: the **intercept** is on-site
work, the **slope** is the installer's real travel rate. Stored per work mode in the
appended `InstallerMetrics` block `onSiteMin` / `extraMeterMin` / `travelMinPerKm` /
`onSiteSource`, read through `installerMetricsRead`'s `boat*`/`land*` projection.

- **`onSiteSource` is `'gps' | 'fit' | 'pace'`** — GPS wins when available, since the
  hole between one `DriveTracks` leg ending and the next starting is literal
  arrive/depart, the one thing a Stops timestamp can never be (one moment per stop, no
  arrival). Recording is opt-in per phone per day, so most installers land on the fit.
  `'pace'` means no evidence and is the safe default until `backfillInstallerMetrics()`
  runs.
- **Outliers trim by RESIDUAL, not by gap minutes.** Trimming the slowest gaps looks
  equivalent and is not — they are mostly the longest drives, so it shaves the far end
  off the distance distribution, drags the slope down and pushes the intercept (the
  shipped number) up.
- **`siteKey` is civic number + normalized street, from the first comma-segment that
  starts with a digit.** A logged Stops address is usually a full geocoder string
  ("10 Island 19c, Carling, ON P0G 1G0, Canada") and a worklist order carries what the
  office typed, so keeping the locality tail means the two can never match. Segment
  zero is also wrong — label-prefixed addresses ("Town of, 14 Maple Heights Dr, …")
  collapse onto one key. **Never keyed on coordinates:** a Stops pin is a phone GPS fix
  and jitters between visits to one property. `Code.gs siteKeyOf` is a hand copy (Apps
  Script cannot import a module) held to the JS original by
  `tests/route-dwell-parity.test.mjs`, because a drift there fails silently.
- **Site factors are crew-wide and gated hard** (`?action=siteDwell`, ≥4 visits, and a
  usable travel rate — without one "work" is just the raw gap, so a remote site scores
  slow for being remote). At current data volume almost nothing qualifies and the tier
  correctly does nothing.
- **No `Worklist` column.** The per-stop dwell rides in IndexedDB as
  `scheduledOnSiteMin`; `wireShape()` is an explicit allow-list, so it never reaches
  the sheet. `scheduledLateMin` — minutes past an appointment the day cannot reach,
  see "Route optimization" — is local for the same reason: both are re-derived by the
  next solve, so syncing them would only let a stale one outlive the route it came from.
- **Validation (both modes).** An install can't submit without a New J#; a UTI
  can't submit until a reason is picked (the dropdown starts blank).

## Drive mode

Two pieces: a low-distraction **driving screen** reached **only from the worklist**
(`#drive`, a hash-routed sibling screen inside `index.html`, like `#worklist-route` —
module `js/drive.js`, styles `css/drive.css`, wired by `initWorklist()`), and an
**app-level GPS recorder** (`js/drive-recorder.js`, initialized once by
`js/pages/capture.js`) that runs **whenever the capture PWA is open** — on any
screen, not just `#drive`.

- **Driver-facing (`js/drive.js`):** shows **only the current order's card** — WO#,
  unit+address, Old J#, appointment/notes — with a big **Navigate** button (the shared
  `openDirections()` Google-Maps hand-off) and **Advance / Back** buttons. Navigate
  **advances the display to the next order before handing off** — so the next card is
  already showing when the driver switches back from Maps — while still routing to the
  order that was pressed. Advance/Back move a **local display pointer** across the
  pending set *only*; none of them change an order's status, touch the Sheet, or affect
  plan mode (an order still goes `done` only when its meter is logged, exactly as
  before). **By default** no map, no speed, no trip numbers on screen — but an
  **optional driving-stats HUD** (a big **current speed** readout plus total
  distance / avg km/h / idle / max km/h — avg is **moving** speed, idle excluded —
  in **metric** to match the office map) can be switched on
  **per phone** via the `#tuning` screen's *Show driving stats* toggle
  (`localStorage['driveShowMetrics']`, default OFF, **never uploaded**). It shows only
  while this phone is actively recording, updates each GPS fix from `liveMetrics()`
  (recorder-side day totals = finalized legs + the live leg), and is labeled *"Maps gaps
  not counted"* because foreground-only tracking undercounts a same-phone Maps hand-off
  (true gap-filled totals are office-side, not yet built). The screen also
  holds the **▶ Start / ■ Stop drive tracking** button (arms/disarms the recorder) and
  the wake-lock toggle; opening/closing the screen no longer starts/stops GPS.
- **On-pace line (`js/drive.js` `paintPace`, under the "Driving to" card).** A live
  landing projection built from **real working data**, not a single blended average:
  it reprojects **today's remaining route** and separates travel from on-site time.
  On-site minutes/stop come from today's observed WO→WO cadence with the nominal
  drive stripped (`onSiteMinutes`, the same decomposition the route planner uses) —
  the **median** of the day's gaps, net of any logged downtime
  (`js/compute/cadence.js observedOnSiteMin`), because a day is a handful of gaps and
  a mean lets one hold-up stand in for every stop; remaining travel is the pending
  route's `legMetres` priced at the truck's **real measured moving speed**
  (`liveMetrics().avgMovingSpeed`) — but only while that average is still believable
  as *driving* (`MIN_BELIEVABLE_SPEED_MPS`, 25 km/h), since the recorder counts
  on-foot minutes at a meter as moving; below the floor, and before any drive is
  logged, it is 50 km/h. The count is **capped at the stops left in the route**.
  `projectDayReal` (`js/compute/estimate.js`) returns **two paces** — the installer's
  **target finish** (`finishByMin`, which the phone passes as the fixed
  `ROUTE_DAY_END`) and **regular working hours**, 3:45 PM escalating to **4:45 PM
  OT** once past 4:00 PM **while the day is still open** (`workHorizon`) — but the
  **Drive screen shows only the working-hours card**. The target card was fifteen
  minutes from it and said the same thing twice; `paces.target` survives for the
  plan-mode banner and the `#tuning` what-if, which are the model's other two
  callers. The card reads `~N` with an *on pace ✓* / *N stops short* note (green
  when today's remaining route lands by that horizon, amber when it doesn't).
- **The route-finish clock** (`projectDayReal`'s top-level `routeFinishMin` /
  `routeFinishLabel`, painted under the card's caption as *"Route done ~4:20 pm"*).
  What time the **last stop still on today's route** is finished, on the current
  pace: `now + remainingTravelMin + pendingCount × onsitePerStop` — the same three
  terms `paceFor` inverts, read forward instead of against a horizon. Deriving it
  from the identical inputs is the point; a separately-sourced clock could disagree
  with the `~N installs` number directly above it. It has **no horizon of its own**,
  so it sits at the top level rather than inside a pace, and it always reports the
  real clock — landing at 5:40 is exactly what the driver is asking — turning
  **amber** (`.dp-eta.late`) once it passes the card's own `horizonMin`. Null when
  nothing is pending. Because it is unbounded it is formatted by **`finishLabel`**,
  not `clockLabel`: am/pm always, plus a `+Nd` marker past 24 hours. `clockLabel`
  stays the bare 12-hour readout and is only ever safe for the fixed horizons —
  through it, a real 23:29 printed as `11:29` on a card being read at 11:36 in the
  morning.
  **The denominator is the ROUTE — the stops still on today's Day 1 — and the
  meters/day target is the footnote, read in both directions.** `onPace` is
  `routeShort <= 0`; the caption reads "12 of 18 stops", plus "· 6 under your 24"
  (`targetShort`) when the day projects short of the target, or "· 4 over your 24"
  (`targetOver`) when it projects past it. At most one of the pair is non-zero. The
  target's job is upstream: it decided how many orders went on the route when the day
  was **planned**, and it does not govern the day after that — so a crew that installs
  extra keeps its whole list and reads as ahead, which is what `targetOver` exists to
  say. This was briefly inverted, and the arithmetic that rebutted it (`done +
  pendingCount` is stable) was itself only true at one meter per order; see
  `js/compute/estimate.js paceFor`, which keeps the whole account. It is true now,
  because Day 1 no longer re-sizes at all.
  **`todayPending` is `day === 1` strictly, not the lowest day present** — a day whose
  committed set is finished leaves Day 1 empty with days 2+ still full, and a min-day
  read would pace *tomorrow's* chunk. Empty there is correct: `drivePace` returns null
  and the card hides. (It used to arrive the other way too: target met ⇒ everything
  stamped day 2+ ⇒ the card gone mid-afternoon with work still in front of the crew.
  That path is closed.)
  Sourced by worklist.js `paceContext`/`drivePace` (owns the route + dayCache) and
  passed into `initDrive` like `getPending`; recomputed on open/refresh and
  throttled to a few seconds while the recorder ticks. `drivePace` also re-pulls
  today's stops (`cacheRecentDays(1)`) on a **3-minute** throttle of its own,
  because a phone the crew only *drives* by never logs anything and so never
  invalidates the dayCache the whole projection reads — the second-device case
  where it reported "0 of N · on pace" all day. `wlDownload` pulls the same thing,
  **before** `applyTodayAnchor` so the day is sized off the fresh copy. Visible whenever there's a route to project,
  **tracking or not** (drive tracking only sharpens the travel pricing). The **same
  `projectDayReal` model is the single source** for the landing estimate everywhere:
  the **plan-mode banner** (`renderPlanEstimate`, compacted to one line) and a
  **what-if on the `#tuning` screen** (`worklist-tuning.js`) both use it — the
  expected-stops readout uses the route's real average leg travel, and a *"Projected
  to land ~N today"* line reprojects against the dragged finish time. (The old
  blended-average `projectDay` is gone.) **Closing out
  the day** (`finishDay`) stamps `localStorage['dayClosedDate']` — which drops the
  4:45 OT escalation — and **exits plan mode** (`exitPlan`), since the plan is spent.
- **The automatic refresh (`js/drive.js` `tickAutoSync` → `js/worklist.js` `autoSync`).**
  Nothing on this screen was ever on a clock: the only repaint driver is the
  recorder's `subscribe()`, which fires per GPS fix, so the card and the ETAs froze
  the moment fixes stopped (a Maps hand-off, GPS denied, a phone not recording) and
  only a trip back to the worklist to tap ⇩ Download unfroze them. `drive.js` now
  runs a `setInterval` while the screen is open and refreshes on a **5-minute**
  timestamp throttle (`AUTO_SYNC_MS`; the interval itself ticks every 30 s, which is
  retry granularity, not the period — a tick that lands while the driver is in Maps
  then costs seconds of staleness rather than a whole further period). `syncAt = 0`
  means "never synced", so the first tick after opening refreshes at once; the stamp
  is module-scoped and deliberately **not** reset by `open()`, because the crew hops
  between the worklist and this screen constantly and a re-entry inside the window
  must not re-fetch.
  **Three gates, all required, and the middle one is the consent.** `isRecording()`
  (drive tracking armed — the per-day per-device opt-in), `showMetricsPref()` (the
  `#tuning` *Show driving stats* toggle), and the screen being open — plus not
  backgrounded and `navigator.onLine`. `driveShowMetrics` was only ever the HUD's
  switch; it is the fetch's switch too now, on the reasoning that consenting to see
  live driving numbers is what consents to fetching them. The toggle's hint in
  `index.html` and USER-GUIDE.md say so — a gate the driver can't read isn't consent.
  **What it pulls, and the half that actually matters.** `autoSync` re-runs the
  ⇩ Download landing (`applyDownloadedList`, shared with `wlDownload` so a sheet row
  can never be normalized two ways) then `cacheRecentDays(1)` then
  **`applyTodayAnchor()`**. That last call is the answer to "why do my times only get
  right after a Download": nothing in the pull rewrites `order`/`day`/`scheduledEta`
  — `applyTodayAnchor` does, by re-running `scheduleRouteConstraints` from where the
  crew is now. A day-cache refresh alone (`refreshPaceCache`) moves the gauge's
  `done` count and nothing else. `PACE_REFRESH_MS` was raised 3 → 5 min to match, so
  the two pulls share one period rather than being two clocks disagreeing about how
  fresh "fresh" is.
  **Four things it must never do**, each a way an unattended timer goes wrong: no
  `confirm` (nobody can answer one at 80 km/h), no `toast` (a "check signal" popping
  every five minutes through a dead zone is worse than the staleness it reports — a
  failure keeps the last good copy silently), no `savePlan` push (nothing changed
  locally), and no `planAdvance()` (it ends in `fillCapture`, and a background timer
  must not overwrite a half-typed capture form; plan mode re-advances on the next
  logged stop). It also skips the pull entirely while the offline queue is non-empty
  — an un-drained queue means the phone is *ahead* of the sheet — and passes
  `preserveDone:true`, which is the trap AGENTS.md carries. `refresh()` re-matches
  the card by `destKey` so a re-ordered route can't swap the house under the driver.
- **Office-facing (silent, `js/drive-recorder.js`):** records the driving leg — GPS
  points `{lat,lng,t,spd}` (device `coords.speed`, else derived) — the whole time the
  PWA is open and armed, **holding it on the phone** and uploading to the `DriveTracks`
  tab via the offline queue (`saveDriveTrack`) **only at end of day** (`finishAndUpload`,
  called from `finishDay`). The map viewer replays it (the 🚗 **Drive routes** toggle,
  off by default).

**Recording is opt-in per day, per device — the two-phone dedup rule.** Some
installers run the PWA on two phones: a work phone for capture (which *does* use plan
mode, since plan mode pastes order data into the capture fields) and a personal phone
for planning + CarPlay navigation. To keep both from recording the same drive,
recording is **OFF every morning** until the driver taps **Start drive tracking** on
the Drive screen — only the phone that taps Start becomes that day's recorder. The
arm state is `localStorage['driveRecord']` = `{on, date}` (a stale/absent date reads
as OFF — inverted from the old opt-*out* `driveTrack` default). The top-bar
**`driveChip`** on the capture page shows live state ("🛰 Recording" / "Location off")
and, once armed, is tappable to pause/resume; initial arming stays on the Drive-screen
button so a capture-only phone can't accidentally start.

The pure track model is `js/drive-track.js` (DOM-free, unit-tested): a segment
state machine (`createSegment`/`addFix`/`markPause`/`markResume`/`finalizeSegment`),
a compact interleaved-varint polyline (`encodeTrack`/`decodeTrack`, lat/lng ×1e5,
time **relative** to leg start so the zig-zag never overflows int32, speed 0.1 m/s),
and `segmentSummary` (distance/avg/max in m/s, plus **`idleMin`** — time on intervals
at or below `IDLE_SPEED_MS` ≈ 0.5 m/s, gaps excluded like distance). A **fix filter** drops a new point
that is both < 15 m and < 3 s from the last (jitter + battery/storage dial);
`MAX_POINTS` rolls a very long leg to a fresh row before the 50k-char cell limit.

**The platform limit is load-bearing.** A web app gets **no GPS while
backgrounded**, so the recorder captures only while the PWA is actually in front —
during a Google-Maps hand-off the leg pauses. `visibilitychange` (owned by the
app-level recorder now, so it fires on any screen) brackets each background stretch
as an **anchored gap** (`markPause` on the last point, `markResume` on the first fix
back), stored in the leg's `gaps` array as pause+resume lat/lng/time pairs. The
desktop planner can OSRM-route between a pair to reconstruct the missing stretch; the
map viewer draws a gap as a **dashed** connector so it reads as "was navigating", not
"GPS failed".

**Controls & safety.** The per-day **opt-in** (the Start button above) is the
driver's control: with it off, no watch runs and nothing is recorded or uploaded.
An optional **Screen Wake Lock** (`localStorage['driveWake']`, default off, labelled
as a battery cost) keeps a dashboard-mounted phone recording. The `driveChip` /
Drive-screen indicator is the only tracking-related thing the driver sees — the
awareness disclosure, no numbers. **Uploads are deferred to end of day:** `finishDay`
calls `finishAndUpload()` (from `js/drive-recorder.js`) before anything else, on both
the online and offline paths — it clears the watch, releases the wake lock, finalizes
the active leg, and enqueues **every un-queued leg dated today**. A leg is
checkpointed to the IndexedDB `driveTracks` store on each fix (marked `active`,
`queued:false`); `recoverStale()` on the next open finalizes any leg left `active`,
**ships legs from a previous un-closed day** (today's stay local until Finish), and
prunes legs older than ~8 days. `saveDriveTrack` is idempotent on the leg id and each
shipped leg is marked `queued:true`, so a leg can't double-upload. Legs with < 2
points are dropped, never uploaded.

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
| `homeAddress` | string | the installer's home — the route planner's **end-of-day bias anchor** (each planned day is pulled to finish near it). Entered on the crew card in `teams.html`; the planner geocodes it lazily (`homeLat`/`homeLng` cache the pin — currently written only if a planner write-back runs, else left blank and re-geocoded from the address). Rides `saveEmployee` **only when the payload carries it**. `ensureEmployeesColumns()` appends the three columns on any save. |
| `homeLat` / `homeLng` | number | cached geocode of `homeAddress` (may be blank — the planner re-geocodes the address when absent) |

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
| `startAddress`  | string      | the crew's shared **morning meet-up point** — the route's **ETA-only** drive-out reference (departs at 08:00, no later than 08:30; the drive-out to each day's first stop is measured/drawn from it, but it never anchors the ordering — the route runs furthest-first toward home). Entered on the boat/crew card; geocoded lazily by the planner (and on the phone). Rides `saveTeam` **only when the payload carries it**; `ensureTeamsColumns()` appends the three columns on any save |
| `startLat` / `startLng` | number | cached geocode of `startAddress` (may be blank — re-geocoded from the address when absent) |

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

### InstallerMetric  (one row per installer → tab "InstallerMetrics")
Per-installer lifetime analytics, keyed on the employee **H number** (name is a
display label only — same split as `Worklist`). Rolled up by
`refreshInstallerMetrics(hNumber, name)` from the installer's `Tracker` per-day
rows + `Days` bookends (+ a lifetime `Stops` gap scan for `avgLogMin`) —
**re-summed, not delta-added**, so a re-close/regenerate is idempotent. Refreshed
incrementally at end-of-day (and on a closed-day rebuild) and in bulk by
`backfillInstallerMetrics()` (editor-run once). `avgPerDay`/`avgLogMin` feed the
route planner's target field (see "Route optimization"). Reshaping this tab means
re-running `setupSheets()` once (delete an old-schema copy first). The
`Tracker`/`Days` roll-up is name-keyed (`sameName`), so same-name installers
merge — the app's standing limitation.

**Every metric is stored three ways in its own column group** — combined
(unprefixed), **boat-only** (`boat*` prefix), and **land-only** (`land*` prefix)
— so a slow-land / fast-boat installer's target reference reflects the mode
they're actually working in. Boat/land attribution is the `workType` column on
`Tracker`/`Stops`/`Downtime`; a `Days` (hours) row is attributed to the
`workType` of that installer's `Tracker` row for the same date. `rollupInstallerMode`
computes each mode; the metric fields are:
| field         | type          | notes                                                   |
|---------------|---------------|---------------------------------------------------------|
| `hNumber`     | string        | employee number — the match key                         |
| `name`        | string        | display label, from the roster                          |
| `firstDay` / `lastDay` | string | Toronto `yyyy-MM-dd` span of closed days (combined)    |
| `daysWorked`  | number        | count of Tracker rows                                    |
| `hoursWorked` | number        | Σ (returned − departure) from `Days`, hours (1 dp)      |
| `totalLogs`   | number        | installs + utis + visited + unaccounted                 |
| `installs` / `utis` / `visited` / `unaccounted` | number | summed daily counts                  |
| `downtimeMin` | number        | summed `downtimeTotalMin`                                |
| `avgLogMin`   | number        | mean min/meter over the installer's whole history, breaks removed |
| `recent30AvgLogMin` | number  | mean min/stop over the latest 30 distinct worked days, breaks removed; appointment-planning pace |
| `avgPerDay`   | number        | (installs+utis) / daysWorked — the target-field hint    |
| `avgPerHour`  | number        | (installs+utis) / hoursWorked (1 dp)                     |
| `updated`     | string        | Toronto-local timestamp of the last refresh             |

Each of the 11 metric rows (`daysWorked`…`avgPerHour`) appears three times: the
combined column, `boat`-prefixed (e.g. `boatAvgPerDay`), and `land`-prefixed
(e.g. `landAvgPerDay`). `?action=installerMetrics` takes optional `hNumber` and
`workType` — `workType=boat|land` **projects that mode's prefixed columns down to
the canonical field names** (a reader always sees `avgPerDay`/`avgLogMin`), while
`all`/omitted returns the full wide row (its combined columns are already
canonical). Both route-planning surfaces request the land projection and prefer
`recent30AvgLogMin`, falling back to lifetime `avgLogMin` and then an editable
30-minute default when history is unavailable.

### Worklist row  (one per planned order → tab "Worklist")
A flat copy of one phone's IndexedDB `worklist` record, keyed per installer on
the employee **H number** (unlike the name-filtered `Stops`/`Tracker` tabs —
names can collide, H numbers can't). Written **only** by the planning screen's
explicit Upload (`saveWorklist`, a batched whole-list replace of that H
number's rows — one body rewrite + one trailing-row delete, so the cost stays
flat regardless of list size) and read only by Download (`?action=worklist&hNumber=…`)
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
| `lat` / `lng` | number | the order's cached geocode pin — round-tripped so a downloaded list routes without re-geocoding. `''` only when the order was **never** located or its address was hand-edited (which clears the pin on purpose); a failed re-geocode parks the order but never blanks the stored pin |
| `day`         | number | the route planner's multi-day cluster number (1-based; `''` = unassigned/parked/done) — drives the phone worklist's Day 1 / Day 2 dividers. Set by the optimize `dayOf`, carried through the sync |
| `appointmentDate` / `appointmentTime` | string | optional Toronto-local timed appointment (`yyyy-MM-dd`, `HH:mm`) |
| `lockedDate` / `lockedSlot` | string/number | exact weekday and one-based within-day slot held through reorder and optimization |
| `scheduledDate` / `scheduledEta` | string | optimizer result displayed on both route surfaces |
| `scheduledSlot` / `scheduledWaitMin` | number | one-based day slot and explicit early-arrival waiting |
| `ignored`     | string | `'TRUE'` = set aside: out of the route, day counts, meters/day target and plan mode, but still on the list and still synced. Deliberately **not** a third `wlStatus` value — `clearDoneWorklistJob` sweeps `'done'` rows nightly, and a set-aside order must survive |
| `orderRoad` / `dayRoad` / `legMetersRoad` | number | the saved **road-matrix route**: position, day cluster, and metres driven arriving at this stop from the previous **stop**. A day's first stop is 0 — the drive out to it is not in this total (see `homeLegMeters*`) |
| `orderStraight` / `dayStraight` / `legMetersStraight` | number | the saved **straight-line route**, same three fields |
| `legGeometryRoad` / `legGeometryStraight` | string | the OSRM-encoded polyline (polyline5) of that same arriving **between-stops** leg for each variant. A day's first stop is empty here — its drive out from the crew start is drawn separately from `homeLegGeometry*` (below). Empty when the planner never fetched directions, a leg had no route, or an Optimize reordered the stop and OSRM was down (blanked so a stale leg can't be drawn — see "Route variants"). Opaque text; `setupSheets` pins these columns to `@` |
| `homeLegMetersRoad` / `homeLegMetersStraight` | number | per-variant drive-out distance to a **day's first stop**, stored on that first stop (one per day). Measured from the crew's **team start** (the morning drive out of the muster point) — **only** when one is set. Home is the end-of-day bias and is **never** a drive-out anchor, so a run with no team start records nothing here. Deliberately **kept out of** `legMeters*` and the day/route total — a "distance out" reference number, shown as a **`start`** readout on the day headers. Empty for non-first stops and when the crew has no start location. (Field name is legacy; despite the `home` prefix it holds the **crew-start** drive-out.) |
| `homeLegGeometryRoad` / `homeLegGeometryStraight` | string | per-variant **drive-out path** from the crew start to a **day's first stop**, stored on that first stop (parallel to `homeLegMeters*`). The OSRM road polyline (polyline5) when the local server is up, else a straight two-point line `encodePolyline`'d from the crew-start and first-stop coords, else empty (no crew start on file). Drawn as a **faint dashed line + start pin** on both the planner map and the phone route view — never in any distance total. Rides the sync verbatim, blanked on any reorder, drawn only while `variantMatchesLive` holds. Opaque text; `setupSheets` pins these columns (`AH:AI`) to `@` |

### Route variants (the two saved routes)

An optimize run over a road matrix solves the same stops **twice** — once on road
distances, once on straight-line — and saves both sequences in their own columns.
`order`/`day`/`scheduled*` stay what they always were: the LIVE sequence every
consumer already reads. Switching variants (the road / straight-line control on
both the planner and the phone worklist) copies one saved sequence into those
live fields and re-runs `scheduleRouteConstraints`, so appointments and locks are
re-honoured; nothing downstream of `order` changes. `js/route-variants.js` holds
that logic for both screens.

Both sequences are **priced against the same matrix**, so their kilometre totals
answer "which order is cheaper to drive" rather than comparing road km with
crow-flies km. `legMeters*` counts the driving **between stops** only: a day's
first stop is charged 0, and neither the drive out to it nor the drive back home
at day's end is in the total (each day already ends near home). The **drive out
from the crew's team start** to a day's first stop is still measured —
`homeLegMetersFor` prices it per day into `homeLegMeters*` — but kept out of the
total and saved for reference (shown as a **`start`** readout on the day headers),
because folding a commute leg into the driving total muddies the "which order is
cheaper" comparison. Home is the **end-of-day bias only** — it orients where each
day ends but is never a drive-out anchor, so a run with no team start shows no
drive-out reference at all. A phone "start from here" first leg (a real driven leg
from the current GPS fix) **is** still charged to the total. The extra straight-line solve is local and costs no lookup — and it happens
**only on a run that actually pulled a road matrix**. A straight-line run (the
phone's plain Optimize tap) still does exactly one solve, writes only the straight
variant, and leaves any earlier road route untouched. Staleness is handled by
display, never by deletion: a saved sequence that no longer covers the pending
orders greys its button out and marks the total "out of date", and a manual drag
marks it "edited".

**The phone shows ONE DAY; the office shows the whole plan.** `variantMeters` sums
every pending order's leg, which is the right answer for planning a week and the
wrong one for a crew asking "how far am I driving". A field report made that
concrete: eight orders, two of them 2 km apart, and the road button read **241 km**
— correct arithmetic over a four-day plan with one far-off order at the bottom of
the list, sitting above day headers reading 2.2 km and 6.3 km. So the two summary
builders take a scope:

- `routeTotalSummary(items, variant, src, {day})` and
  `variantSummary(items, variant, {day})` price one day. The phone passes
  `day: 1` (`worklist.js HEADLINE_DAY` — Day 1 strictly, the same convention
  `todayPending` uses). The counts line's scoped metres come from
  **`liveDayMeters`**, bucketed on the *live* `day` field the day dividers use, so
  the headline and that day's divider are the same number **by construction**. The
  tiles bucket on each variant's *own* saved day, because two saved plans put
  different stops on their first day and comparing each plan's own day 1 is what
  keeps the choice like-for-like.
- `{days: true}` appends the span (`· 4 days`). The planner passes it and stays
  unscoped: planning the week is what that screen is for, and a labelled
  whole-plan figure cannot be misread as one day's driving.
- `routeScopeText` is the caption under the phone's tiles — *"Day 1 only — the
  whole plan is 241 km over 4 days"*. A phone has nothing to hover, so the number
  the tiles no longer show has to be on screen or it is gone. Blank when there is
  nothing to disambiguate (a one-day plan, or an unmeasured route).

Never label it "today": the phone can plan a day that is not today (§"The plan
day"), and a Thursday-evening plan for Friday would be lying under that word.

**Known, not yet fixed:** setting an order aside — or completing it — drops *its*
leg from the total but leaves the **next** stop's leg, which was measured *from
the stop that is no longer on the route*. Neither `variantCoversPending` nor
`variantMatchesLive` fires, so that figure prints unqualified. It needs
re-pricing, not re-scoping.

**Road directions geometry.** The desktop planner also fetches the *actual road
path* of every **between-stops** leg of both variants from the same local OSRM —
the `route` service (`osrmLegGeometry` in `js/route.js`, one GET per leg), distinct
from the `table` service that gives the distance matrix. A day's first stop stores no
*between-stops* geometry — but the **drive out to it from the crew start is fetched and
drawn** separately, into `homeLegGeometry*` (road path when OSRM is up, a straight
`encodePolyline`'d two-point line otherwise), rendered as a faint dashed line + start
pin on both maps and kept out of every distance total. The polyline5
result is stored on the **arriving** order in `legGeometryRoad`/`legGeometryStraight`
(same between-stops leg semantics as `legMeters*`), so the planner map draws real
roads instead of straight pin-to-pin lines (`decodePolyline` + Leaflet). Geometry is
fetched automatically at the end of a road-matrix Optimize (skipped when the matrix
fell back off OSRM) and on demand via the planner's **Get directions** button (no
re-solve). It rides the sync verbatim like `legMeters*` — the phone never generates
it and must not blank it — and an address edit clears both the pin and the stale
geometry. A leg with no route saved falls back to a straight segment on the map.

**Geometry must never outlive the order it was fetched against** (this was a live
bug: after an OSRM-offline / ORS-matrix Optimize the map drew a long stale leg
"pointing to home"). Two guards keep it honest: (1) **every Optimize blanks
`legGeometry*` on the stops it reorders** — the automatic re-fetch above refills it
only when OSRM is up, so an OSRM-offline run leaves the legs empty (straight
fallback) rather than keyed to the old order; and (2) at **draw time** both maps
(`renderMap` on the planner and the phone) only trust saved geometry while
`variantMatchesLive` is true — after a manual drag (the live order changes but the
variant's saved order doesn't) the geometry is dropped and legs draw straight until
the next Optimize. Never draw `legGeometry*` against a sequence it wasn't measured
for.

**The phone draws that saved geometry too, but never fetches any.** The phone's
route view (`js/worklist-route-view.js` `buildRouteMapModel`) decodes the active
variant's `legGeometry*` per leg with `decodePolyline` — on-device, **no network** —
so a downloaded road route follows real roads on the phone map, exactly like the
planner. Any leg without saved geometry (an edited/quick-change leg, or a list the
office never routed) draws as a straight segment. So only the desktop *generates*
geometry; the phone only *displays* it and stays fully offline. The phone also draws
the crew-start **drive-out** the same way — decoding the day-first-stop's
`homeLegGeometry*` into a faint dashed line with a distinct start pin (road path when
the office saved one, straight otherwise; nothing when the crew has no start).

### WorklistPlan row  (one per installer → tab "WorklistPlans")
| field | type | notes |
|-------|------|-------|
| `hNumber` | string | installer match key |
| `routeStartDate` | string | Day 1 weekday (`yyyy-MM-dd`) |
| `firstStopTime` | string | planned arrival time at slot 1 (`HH:mm`) |
| `paceMin` | number | editable minutes per stop; recent-30-day metric or 30-minute fallback |
| `paceSource` | string | `recent30`, `fallback`, or `override` |
| `updated` | string | Toronto-local update timestamp |
| `routeVariant` | string | `'road'` \| `'straight'` — which saved route is live. The office sets it, the phone downloads it, and the installer's own switch rides back up on the next upload |
| `straightDistanceSource` | string | `'road'` when the straight variant's `legMetersStraight` were priced on a road matrix (so its total is comparable with the road route's), `'straight-line'` when they are crow-flies and the UI must label them an estimate |
| `commutePull` | number | tuning: 0–100 home-bias dial (`homeWeight = commutePull/100`) — how hard each day's end hugs home. **Installer-owned** |
| `finishBy` | string | **retired, kept blank** — the meters/day target alone sizes a day. The column stays only because `ensureTab` appends and cannot remove one |
| `target` | number | meters/day soft target. **Installer-owned** |
| `dayLockDate` | string | the **work-list lock**: the `yyyy-MM-dd` whose day 1 is settled, blank when the list is open. The DATE only — the frozen membership is just the rows tagged `day === 1`, so there is no second source of truth for it. Written on key *presence*, not truthiness, because blank is a real value (see below). Pinned to plain text in `setupSheets()` (col L) — a `Date` out of `getValues()` fails the equality compare against the plan day silently |

**Tuning + target are installer-owned** (`commutePull`/`target`): the
phone is the source of truth. On Download the phone pushes its local copies up via
the plan-only `savePlan` action (`saveWorklistPlan`, no order rows touched) and does
**not** overwrite them with the sheet's copy, so the next route built for that
installer — on the phone or the planner — uses their latest weights. The planner
reads them (`loadPlan`) and routes with them but never clobbers them.

**`dayLockDate` is the one exception, and it travels in one direction.** It is not
tuning — it is somebody saying a particular day is settled, and the office pressing 🔒
on a route it just built for this installer is as real as the installer pressing it. So
`loadPlanFields` *does* adopt it, unlike `target` beside it: the sheet's date is taken
when the phone is currently **unlocked** for that day. A blank column never releases a
lock, because unlocking is a press on the device doing it. And because blank is
meaningful, `saveWorklistPlan` guards the write on `hasOwnProperty` rather than
truthiness — the truthiness form `routeStartDate` uses would make unlocking from the
phone a silent no-op on the sheet, forever. See §"The work-list lock".

The phone-local `geoFail` / `geoAmbig` flags (parked / "which town?" — see
"Route optimization") deliberately do **not** ride the sync: `wireShape` strips
them on upload and the next optimize re-derives them.

### DriveTrack row  (one per driving leg → tab "DriveTracks")
One Drive-mode driving leg (see "Drive mode"). `encoded` is the compressed
polyline of the leg's `{lat,lng,t,spd}` points (`js/drive-track.js`); `gaps` is a
JSON array of pause/resume anchors bracketing the stretches the phone couldn't
record. `setupSheets` pins `gaps`/`encoded` (cols L–M) to text so Sheets can't
read a leading `@`/`[` as a formula. Appended after the existing tabs; a positional
append guarded by `tests/drivetracks-sheet-schema.test.mjs`.
| field | type | notes |
|-------|------|-------|
| `id` | string | client-generated; `saveDriveTrack` is idempotent on it |
| `date` | string | Toronto-local `yyyy-MM-dd` — the window key |
| `installer` | string | display name (read filter is `sameName`) |
| `workType` | string | `'boat'` \| `'land'` (blank = boat) |
| `startTime` | number | epoch ms of the first point |
| `endTime` | number | epoch ms of the last point |
| `pointCount` | number | recorded points |
| `distanceM` | number | driven distance, metres (gap jumps excluded) |
| `driveMin` | number | elapsed minutes across the leg |
| `avgSpeed` | number | m/s over the leg (stopped time included) |
| `maxSpeed` | number | m/s, best single fix |
| `gaps` | string | JSON `[{pauseLat,pauseLng,pauseT,resumeLat,resumeLng,resumeT}]` |
| `encoded` | string | interleaved-varint polyline of `{lat,lng,t,spd}` |

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

**Land-mode lead gap (first WO downtime).** The chronologically-first WO is never a
WO→WO gap's *arriving* stop, so on a boat day its card shows only the read-only
`Launch` leg — no way to subtract downtime. On a **land day** (travel isn't printed
anyway) that WO still needs to carry delay minutes, so both the `?action=idle`
handler and the offline `computeGapsLocal(…, land)` prepend a zero-length **`lead`
gap** on the first stop, anchored `HH:MM–HH:MM` on the stop's own clock (`from==to`,
so it collides with no real WO→WO or `Launch` gap and round-trips on reopen). The EOD
card renders it as an **"Add downtime"** editor (`g.lead`) instead of "Travel in",
and it saves through `saveTravel` as an ordinary gap-tagged `Downtime` row carrying
the first WO#, so the land PDF's per-WO `byWO` bucket lands it on that row. Land is
the caller's `workType`, else inferred from the day's stops (same as
`buildDaySummary`). Boat days are untouched. The lead gap lives only in the `idle`
read + client editor path, **not** in `computeIdle` used by `buildDaySummary`, so no
bogus 0-minute `Timing`/travel row is written.

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
