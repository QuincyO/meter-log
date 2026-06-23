# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A field data-capture app for a hydro meter installer crew working out of boats. There is **no build step, no package manager, no test suite, and no framework** — it is a handful of static files served as-is plus one Google Apps Script. Read `ARCHITECTURE.md` first; it is the authoritative design doc and is kept current.

## Running locally

The three pages are static HTML. Serve the repo root over HTTP (a `file://` open breaks the service worker and fetches):

```
python -m http.server 8731
```

`.claude/launch.json` already defines this as the `static` debug config. Then open `http://localhost:8731/index.html` (the capture form), `/map.html` (read-only map + analytics), or `/teams.html` (crew/boat admin).

The production deploy is **GitHub Pages serving the repo root** — pushing to `main` publishes. There is nothing to compile, so "deploy" = commit + push.

`Code.gs` runs in the Google Apps Script editor bound to the Sheet, deployed as a Web App (Execute as: Me ▸ Anyone). **Pushing `Code.gs` to `main` now auto-deploys it** via `.github/workflows/deploy-appsscript.yml` (`clasp push` + redeploy the *existing* deployment in place, so the `/exec` URL never changes) — see `DEPLOY.md` for the one-time secret setup. You can still deploy by hand (paste into the editor ▸ redeploy) if CI is unavailable. The Action only ships code: when tabs/columns change you must still re-run `setupSheets()` once from the editor (it is additive and leaves existing tabs/data alone — except a schema-changed `Teams` tab, which must be deleted first). The manifest is `appsscript.json`; `.claspignore` keeps clasp from pushing the HTML frontend into the script project.

## Architecture in one paragraph

Three layers (see `ARCHITECTURE.md` §"The three layers"). **Store:** one Google Sheet, nine tabs (`Stops`, `Downtime`, `Tracker`, `Employees`, `Teams`, `Captains`, `Subs`, `Timing`, `Days`) — the system of record. (`Timing` is the per-gap audit trail written at end-of-day; see ARCHITECTURE.md §"Travel vs delay". `Days` is one row per installer/day holding the persisted Departure/Returned bookend times.) **Spine:** `Code.gs`, an Apps Script Web App that does all deterministic writes/reads via `doPost`/`doGet`. **Capture/view:** the four static pages (`index.html` capture, `map.html` viewer, `teams.html` crew admin, `edit.html` back-office stop-editor + daily-log generator). Claude (via the Drive connector, outside this repo) only *generates* the formatted daily-log deliverable and summaries; it never stores data and is not in the write path.

## The contract that ties it all together

The frontends and the spine communicate over a single JSON-over-HTTP protocol, and **changing one side requires changing the other**:

- Every request carries `token` which must equal `SHARED_TOKEN`. This value is duplicated in **five places** that must stay in sync: `Code.gs:42`, `index.html`, `map.html`, `teams.html`, `edit.html`. Same for `WEB_APP_URL` (the `/exec` URL) in the four HTML files.
- **Writes** go through `doPost` → a `switch` on `body.action`: `addStop`, `addDowntime`, `updateStop`, `endOfDay`, `previewDailyLog`, `saveTravel`, `saveDay`, `saveEmployee`, `deleteEmployee`, `saveTeam`, `deleteTeam`, `saveCaptain`, `deleteCaptain`, `saveSub`, `deleteSub`. (`previewDailyLog` builds the daily-log PDF on demand without writing a Tracker row — it shares `buildDaySummary` with `endOfDay`. `endOfDay` is **idempotent** on (date, installer): it upserts the Tracker row and replaces that day's Timing rows, so regenerating from `edit.html` never duplicates. `saveTravel` **replaces** that day's per-gap travel deductions — the WO→WO travel-time subtractions, stored as gap-tagged `Downtime` rows only; idempotent, so re-reviewing never duplicates (see ARCHITECTURE.md §"Travel vs delay"). `saveDay` upserts the `Days` bookend-times row. `updateStop` can also correct a stop's clock via `arrivalTime` — it keeps the row's calendar date.)
- **Reads** go through `doGet` on `?action=`: `day`, `lookup`, `geocode`, `nearby`, `pins`, `tracker`, `timing`, `roster`, `idle`. (`day` also returns `day` = the persisted Departure/Returned bookends and `closed` = whether a Tracker row exists for that installer/date. `idle` returns every WO→WO gap for an installer+date plus any saved deductions, feeding the end-of-day travel-subtraction UI on both `index.html` and `edit.html`. `timing` returns all `Timing` rows; `map.html` averages the WO→WO gaps for the analytics "avg time between meters" metric.)
- The exact field shapes per action live in `ARCHITECTURE.md` §"Data structures". If you add a column to a tab, update the corresponding `*_HEADERS` array in `Code.gs` and the read/write functions that build that row by positional order. **Exception:** `saveEmployee`/`saveTeam` write through `upsertByHeader()`, which maps `{header: value}` onto the sheet's *actual* column order — so reordered `Employees`/`Teams` columns can't scramble those writes (reads via `rows()` were already header-keyed). Other tabs' writes (`addStop`, `endOfDay`/Tracker) are still positional appends.

## Things that are easy to get wrong

- **Offline queue (`index.html`).** The capture form is offline-first: writes are pushed onto a `localStorage` queue (`enqueue` → `flush`) and retried when `navigator.onLine`. The service worker (`sw.js`) deliberately lets the POST to the Apps Script URL hit the network and fail when offline so the page's own queue owns retry — do not add the endpoint to the SW cache. There is **no idempotency key**, so a timed-out-but-succeeded write can duplicate (known limit, see `ARCHITECTURE.md`).
- **`sw.js` caches the app shell** stale-while-revalidate. Normal edits to the HTML need no version bump; only bump `CACHE` if you must force-evict.
- **Dates are Toronto-local.** `dateOf()` in `Code.gs` normalizes Date objects, UTC `…Z` strings, and plain local strings to the Toronto calendar date. This is load-bearing — the "end of day all zeros" bug was a date-comparison mismatch. Don't replace it with `String(ts).slice(0,10)`.
- **Identity is split.** Crew are keyed on the employee "H number" in `Employees`; the boat-team auto-fill (`endOfDay` → `teamHeader`) joins on H number and is collision-safe. But `Stops`/`Tracker` rows are still filtered by **display name** (`sameName`), so same-name installers can still collide there. Keep this distinction in mind before "fixing" attribution.
- **`status: "DONE"`** is a coordinates-only "already installed here" marker (the one-tap button). It is intentionally excluded from install/UTI tallies, the daily PDF, and the viewer counts — it only feeds the `nearby` proximity check. It is just `addStop` with `status:"DONE"`; do not add an endpoint for it.
- **`Teams.memberLetters`** is a JSON map `{hNumber: "A"}` stored as a string in one cell. People sharing a letter on a boat are partners; `boatTeam` renders as boat number + letter (e.g. `11A`). `parseMemberLetters` tolerates a legacy JSON-array form.
- **Captains/Subs are not employees** — free-text names, no H number, stored in their own list tabs and auto-remembered via `ensureName` whenever a team is saved.

## Daily-log PDF

`endOfDay` builds the PDF by copying the `DailyLog Template` tab, filling header anchors (`ANCHORS` in `Code.gs`) + body rows, and exporting via the Sheets export URL. If you move a header box in `setupDailyLogTemplate()`, update its A1 anchor in `ANCHORS`. The Tracker row is written *before* the PDF so a PDF failure can't block closing the day.

## Security note

`SHARED_TOKEN` and the Web App URL sit in client-side source on a public-capable GitHub Pages site — this is a deliberate, documented trade-off (open-the-link-and-it-works), mitigated by keeping the repo private. Do not treat the token as a real secret, but also do not introduce anything that assumes per-user auth exists.
