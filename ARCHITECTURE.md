# Meter Log — Architecture & Data Structures

Digitizing the paper daily log for a hydro meter installer. Fast capture at the
meter on an Android work phone (offline-friendly), durable storage in Google
Drive, automatic running totals, a map + analytics viewer over the data, and
Claude for the formatted daily deliverable + the messy/natural-language bits.

---

## The three layers

**1. Data layer (system of record) — Google Sheets in your Drive.**
One spreadsheet, seven tabs: `Stops`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`. This is the truth.
It is not Claude and not the form. Everything reads from or writes to it.

**2. Capture + view layer (how data gets in, and how it's seen).**
- The **web form / PWA** (`index.html`) — the capture tool. Runs on the Android
  work phone and any browser, offline-first: it queues stops locally and syncs
  when there's signal. Each person sets only their **name**; the Web App URL and
  access token are baked into the file, so there's nothing else to configure.
- The **map + analytics viewer** (`map.html`) — a read-only window over the
  data: plots stops by GPS, filters (installer / status / date range), WO#/J#
  search, and trend charts.
- The **crew + teams admin** (`teams.html`) — manages the `Employees` and
  `Teams` tabs: add/remove crew (first name, last name, employee "H" number),
  build boat teams (identifier, boat name/number, captain, members). The
  installer's name picker and the end-of-day auto-fill both read from here.
- All three are static files hosted on GitHub Pages. They never store the data
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

**Write actions (POST):** `addStop`, `addDowntime`, `updateStop`, `endOfDay`,
`saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`,
`saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`.
**Read actions (GET):** `day` (one installer's stops + downtime for a date),
`lookup` (find by WO# or J#), `geocode` (reverse-geocode lat/lng, no API key),
`nearby` ("is a meter already here?" proximity check), `pins` (every stop, for
the map), `tracker` (all end-of-day rows, for the viewer's trends), `roster`
(the full crew + teams, for `teams.html` and the installer's name picker), `idle`
(team-aware derived idle gaps for one installer+date, for the end-of-day
confirm/label step — see "Automated downtime").

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

Both are **separate counts**: like `DONE`, they're deliberately kept out of the
install/UTI tallies and the install-rate, but unlike `DONE` they *do* appear on
the daily-log PDF (their own body rows + footer counts) and the map/viewer (own
status chips, colors, and the `visited` / `unaccounted` Tracker columns). They are
plain `addStop` calls — no new endpoint.

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
`NEXT_GEN`, `CELL_SIGNAL`, `BAD_WEATHER`, `WAREHOUSE`, `TOOLS_MATERIAL`,
`DISPATCH`, `TRUCK_ISSUES`, `ASSIST`, `URGENT_EER`, `OTHER`.

### Tracker row  (one per installer per day → tab "Tracker")
Appended automatically at end-of-day. This is the "continues forever" sheet, and
the source the viewer's analytics charts read from.
| `date` | `installer` | `installed` | `uti` | `downtimeTotalMin` | `nextGen` | `cellSignal` | `badWeather` | `warehouse` | `toolsMaterial` | `dispatch` | `truckIssues` | `assist` | `urgentEer` | `other` | `weather` | `notes` | `visited` | `unaccounted` | `autoIdleMin` |

The per-category columns are summed minutes for that day, so the running sheet is
also a breakdown, not just a single downtime number. `visited` / `unaccounted` are
the day's counts of those two outcomes; `autoIdleMin` is the **derived** idle time
(see "Automated downtime" below). The last three were **appended** after `notes`
so older sheets migrate cleanly via `ensureTab` — re-run `setupSheets()` once after
deploying to add them.

> **`autoIdleMin` vs `downtimeTotalMin` are related but NOT additive.**
> `downtimeTotalMin` is the sum of *categorized, logged* `Downtime` rows;
> `autoIdleMin` is idle time *derived from stop timestamps*. A confirmed idle gap
> becomes a `Downtime` row, so it can show up in both — don't sum them.

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
team **11A**, letter B → **11B**, etc. The **captain and sub are *not* employees** —
they move between boats, have no H number, and are stored as free-text names.
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

## Automated downtime

Idle time is **derived** by the spine from data already captured — every stop's
Toronto-local timestamp + GPS, plus boat-team membership — so the crew logs nothing
extra for it. It runs in **"Both" mode**: a raw idle number is recorded silently
every day *and* the detected gaps are offered at end-of-day as pre-filled drafts the
installer can label + confirm.

**`computeIdle()` (in `Code.gs`)** treats each stop as one "activity" marker:

1. **Team-aware gaps.** It pools the installer's stops with their *same-letter boat
   partners'* stops for the day (a single-man team is just their own). Sorting all
   markers by time, any gap between consecutive markers is a candidate — so a
   partner's install keeps the whole team's clock running, not just your own.
2. **Travel-aware adjustment.** Each gap is reduced by the time the hop *should*
   have taken — `haversine(prev,cur) ÷ BOAT_SPEED_KMH` + an `ON_METER_MIN` buffer —
   so long inter-island rides aren't counted as idle. Only the leftover above
   `IDLE_GAP_THRESHOLD_MIN` survives.
3. **Morning ramp / EOD tail.** When a **departure** and/or **return** time is
   entered in the end-of-day sheet, the dock→first-stop and last-stop→dock spans are
   added too. (Those two times also fill the previously-blank Departure / Returned
   boxes on the PDF.)

The three tunables (`IDLE_GAP_THRESHOLD_MIN`, `BOAT_SPEED_KMH`, `ON_METER_MIN`) sit
at the top of `Code.gs` and are field-adjustable.

**Wiring.** `endOfDay` calls `computeIdle` and writes the total to the Tracker's
`autoIdleMin` column (the silent number). Separately, when the end-of-day sheet
opens the form fetches `?action=idle&installerId=…&date=…` and renders each gap with
a category dropdown; confirming one **enqueues a normal `addDowntime`** (reusing the
existing Downtime tab/categories), and `finishDay` flushes the queue before closing
so confirmed gaps land in that day's categorized total. The `idle` read omits
ramp/tail (departure/return aren't known yet when the sheet opens); those still fold
into `autoIdleMin` at close. *Known minor limit:* re-opening the sheet re-lists gaps
already confirmed that session — there's no gap↔Downtime backlink.

---

## Auth / config (current state)

- **One shared token**, baked into both `index.html` and `map.html`, must match
  `SHARED_TOKEN` in `Code.gs`. The Web App URL is likewise baked into both files.
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
- **No write de-duplication.** A request that times out client-side *after* the
  server wrote the row gets retried by the offline queue → duplicate stop.
  **Planned fix:** a client-generated idempotency key the spine checks before
  appending.
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
