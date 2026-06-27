# Meter Log — Architecture & Data Structures

Digitizing the paper daily log for a hydro meter installer. Fast capture at the
meter on an Android work phone (offline-friendly), durable storage in Google
Drive, automatic running totals, a map + analytics viewer over the data, and
Claude for the formatted daily deliverable + the messy/natural-language bits.

---

## The three layers

**1. Data layer (system of record) — Google Sheets in your Drive.**
One spreadsheet, twelve tabs: `Stops`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`, `Timing`, `Days`, `BoatDays`, `Dispatch`, `Metrics`. This is the truth.
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
- All four are static files hosted on GitHub Pages. They never store the data
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
`updateStop`, `endOfDay`,
`previewDailyLog` (build the daily-log PDF on demand from today's stops **without**
writing a Tracker row or requiring departure/return — the real `endOfDay` later
fills the blanks),
`saveTravel` (replace a day's per-gap travel deductions — see "Travel vs delay"),
`saveDay`,
`saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`,
`saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`.
**Read actions (GET):** `day` (one installer's stops + downtime for a date),
`range` (one installer's stops + downtime over a from/to window, grouped by day —
backs the phone's offline "recent days" cache in a single call),
`lookup` (find by WO# or J#), `geocode` (reverse-geocode lat/lng, no API key),
`nearby` ("is a meter already here?" proximity check), `pins` (every stop, for
the map), `tracker` (all end-of-day rows, for the viewer's trends), `timing`
(all per-gap `Timing` rows, for the analytics "avg time between meters" metric),
`boatdays` (all `BoatDays` rows — the daily boat-crew snapshots — for the viewer's
"avg log→log (boat)" tile, which groups a day's logs by the boat that ran them),
`dispatch` (all `Dispatch` rows, for the analytics "avg dispatch downtime" tile),
`avgDispatchTime` (a pure read of the stored `Metrics` avg dispatch time, which
`endOfDay` keeps fresh by pairing every requested meter to its completed install
off-peak — see "Avg dispatch time"), `roster`
(the full crew + teams, for `teams.html` and the installer's name picker), `idle`
(team-aware **every WO→WO gap** for one installer+date, each with any deductions
already saved — plus a pre-filled `DISPATCH` deduction on a requested install's
gap — for the end-of-day subtraction step — see "Travel vs delay" and "Dispatch
downtime").

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
  signal queues `saveTravel` + `saveDay` and tells the installer to tap Finish
  again online for the PDF (the spine builds it, so closing the day needs a
  connection); when online the authoritative `idle` overrides the local gaps.
- **`worklist`** (keyPath `id`) — the installer's locally-built **planned
  orders** (a personal to-do list, never sent to the Sheet). Add / edit / delete
  all run against IndexedDB, so the list is fully editable offline. An order is
  marked done when its work order is **actually logged** (matched by WO#), not
  at prefill time.
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
(`js/pages/map.js` is intentionally not precached: it depends on CDN
Leaflet/Chart that aren't cached either.)

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
- **`compute/`** — `gaps.js` (WO→WO gaps, mirrors `computeIdle`), `tally.js`
  (`PRINTABLE`/`countDay`/`tallyText`).
- **`pages/`** — `capture.js`, `map.js`, `teams.js`, `edit.js`.

CSS: `css/tokens.css` (design tokens + reset) and `css/base.css` (shared
components) back the capture page; `css/{capture,map,teams,edit}.css` are
per-page. `map.js` uses the CDN Leaflet (`L`) + Chart globals loaded by classic
`<script>`s before its module.

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

### DowntimeEntry  (zero or more per day → tab "Downtime")
| field         | type            | notes                                       |
|---------------|-----------------|---------------------------------------------|
| `id`          | string          |                                             |
| `timestamp`   | string          | Toronto local, `yyyy-MM-dd HH:mm:ss`        |
| `installer`   | string          |                                             |
| `category`    | enum (below)    |                                             |
| `minutes`     | integer         |                                             |
| `workOrderId` | string \| null  | pair downtime to a WO when relevant         |
| `note`        | string          | **required** when category is `OTHER`       |

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
| `date` | `installer` | `installed` | `uti` | `downtimeTotalMin` | `nextGen` | `cellSignal` | `badWeather` | `warehouse` | `toolsMaterial` | `dispatch` | `truckIssues` | `assist` | `urgentEer` | `other` | `weather` | `notes` | `visited` | `unaccounted` | `autoIdleMin` | `travelMin` | `delayMin` |

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

**End-of-day auto-fill.** When an installer ends their day, the form sends their
`installerId` (H number). The spine finds their boat row, reads `memberLetters`,
and fills the daily log header:
- **Boat Team** = boat number + *their own* letter (e.g. `11A`)
- **Partner** = crew members on the same boat who share their letter
- **Captain** / **Sub** = the boat's free-text captain and sub names
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
`previewDailyLog` request body sends `includeDelays`; when `false`, `buildDailyLogPdf`
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
append and the match runs once off-peak, when the phone can pull today's requests
fresh.

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
truth for the global match + the running average** — `endOfDay` runs it once at
close (off-peak). It pairs **every** requested meter (`Dispatch`) to the completed
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
