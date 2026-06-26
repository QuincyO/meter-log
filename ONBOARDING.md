# Onboarding — meter-log

Welcome! This guide gets you from zero to making your first change. It assumes you
haven't coded in a while, so it explains the jargon in plain language as it comes
up. It's a primer — when you want the authoritative detail, it points you at the
deeper docs (`ARCHITECTURE.md`, `CLAUDE.md`, `DEPLOY.md`).

Read this once, run the app locally, then keep `ARCHITECTURE.md` open as your
reference.

---

## 1. What you're working on

**meter-log** is a small web app that replaces a paper "daily log" for a crew that
installs hydro (electricity) meters out on the water, travelling between islands by
boat. An installer taps a form on an Android work phone at each meter; the app
records what they did, where (GPS), and when. At the end of the day it tallies
everything and produces the formatted daily-log PDF that used to be filled in by
hand.

Two things make it interesting:

- **It works offline.** Boats lose cell signal constantly. The app saves everything
  on the phone first and syncs to the cloud later when signal returns — nothing is
  lost in a dead zone.
- **There's almost nothing to "build."** No compiler, no framework, no package
  manager, no test suite. It's plain HTML/CSS/JavaScript files plus one Google
  script. You edit a file, refresh the browser, and that's it.

---

## 2. The 30-second mental model

The whole system is **three layers**:

```
  PHONE / BROWSER                 THE SPINE                    THE STORE
  (capture + view)                (one Google script)          (one Google Sheet)

  index.html  ──── POST JSON ───▶  doPost ── writes ──▶  ┌─────────────────────┐
  (phone form)                     (addStop, …)          │ tabs: Stops,        │
  map.html    ◀─── GET JSON ─────  doGet  ── reads ───▶  │ Downtime, Tracker,  │
  (viewer)                         (day, pins, …)        │ Employees, … (12)   │
  teams.html  ────────────────────────────────────────▶ └─────────────────────┘
  edit.html
```

- **Store** — one **Google Sheet** with twelve tabs. This is the *system of record*
  ("the single place the real data lives — if it's not here, it didn't happen").
  Everything ultimately reads from or writes to this Sheet.
- **Spine** — `Code.gs`, a **Google Apps Script** ("a small JavaScript program that
  Google hosts and runs for you, attached to a Sheet — no server of your own to rent
  or maintain"). It's the only thing allowed to touch the Sheet. The web pages can't
  write to the Sheet directly; they ask the spine to do it.
- **Capture + View** — four **static files** ("plain files served exactly as they
  are, with no build/compile step") hosted on **GitHub Pages** ("free website hosting
  that just publishes the files in your repo"). These are the four screens people
  actually use.

The four screens:

| Page | Who uses it | What it does |
|------|-------------|--------------|
| `index.html` | installer, on the phone | the capture form — log each meter, end the day |
| `map.html` | office | read-only map of every stop + analytics charts |
| `teams.html` | office | manage crew members and boat teams |
| `edit.html` | office | fix a logged day and (re)generate its PDF |

> The authoritative version of this picture, with the data-flow diagram and every
> field of every tab, is `ARCHITECTURE.md` → "The three layers" and "Data structures".

---

## 3. Key terms, decoded

You'll see these words throughout the code and docs. One plain sentence each:

| Term | In plain language |
|------|-------------------|
| **PWA** (Progressive Web App) | A website that can be "installed" on a phone and behaves like an app, including working offline. `index.html` is the PWA. |
| **offline-first** | The app is designed to work with no internet, saving locally and syncing later — not to fall over when signal drops. |
| **service worker** (`sw.js`) | A background script the browser keeps around so the app's files load even with no internet. It's what makes "open the app on a boat with no signal" work. |
| **ES module** | A modern JavaScript file that can `import` from other JS files. Our code is split into small modules under `js/` instead of one giant file. The browser loads them directly — still nothing to compile. |
| **IndexedDB** | A small database built into every browser, living on the phone. We use it to store un-synced work durably so it survives the app closing or the phone restarting. |
| **localStorage** | A *much* simpler browser storage, only for tiny scraps (the person's name). Rule here: durable data goes in IndexedDB, not localStorage. |
| **`doGet` / `doPost`** | The two entry points of the Google script. `doGet` answers **reads** (give me data); `doPost` handles **writes** (save this). Everything funnels through these two. |
| **action** | A label inside each request telling the spine *what* to do, e.g. `addStop`, `day`. The spine looks at it and runs the matching code. |
| **idempotent** | "Safe to run twice." If the phone isn't sure a save went through and sends it again, an idempotent operation won't create a duplicate. Designed-in here on purpose. |
| **queue / flush** | The list of un-synced writes waiting on the phone (the *queue*), and the act of sending them to the spine when signal returns (*flush*). |
| **optimistic update** | Show the result on screen *immediately* (assume it'll succeed), then sync in the background — so the app feels instant even offline. |
| **upsert** | "Update if it exists, otherwise insert." Used so re-saving a day overwrites that day's row instead of adding a second one. |
| **geocoding** | Turning GPS coordinates (lat/lng) into a human address. "Reverse geocoding" is the direction we use. |
| **token** | A shared password string every request must include so the spine knows the request is from our app. Not a real secret here (see §7). |

---

## 4. Get it running locally

There's **nothing to install or compile**. You just need to serve the folder over
HTTP and open it in a browser.

From the repo root, start a tiny local web server (Python ships with one):

```
python -m http.server 8731
```

Then open any of the pages in your browser:

- http://localhost:8731/index.html — the phone capture form
- http://localhost:8731/map.html — the map + analytics viewer
- http://localhost:8731/teams.html — crew/boat admin
- http://localhost:8731/edit.html — back-office editor

> `.claude/launch.json` already defines this exact server as the `static` debug
> config, if you launch from the editor.

**Why you must serve it over HTTP — don't just double-click the HTML file.** Opening
a file directly gives a `file://...` address. Under `file://`, three things silently
break: the ES-module `import`s won't load, the service worker won't register, and the
data fetches are blocked by the browser. Always go through `http://localhost:...`,
even for a quick look.

**Deploying is just commit + push** (covered in §9). Because there's no build step,
"deploy" literally means pushing your files.

---

## 5. Repo tour

What each thing at the top level is for:

| Path | What it is |
|------|-----------|
| `index.html` `map.html` `teams.html` `edit.html` | the four screens; each is markup + `<link>`s to CSS + one `<script type="module">` |
| `js/` | the shared JavaScript modules (see below) |
| `js/pages/` | one entry-point module per screen: `capture.js`, `map.js`, `teams.js`, `edit.js` |
| `css/` | styles: `tokens.css` + `base.css` are shared; `capture/map/teams/edit.css` are per-page |
| `sw.js` | the service worker (offline caching of the app's files) |
| `Code.gs` | **the spine** — the entire Google Apps Script backend (reads + writes) |
| `appsscript.json` | configuration for the Google script (timezone, permissions) |
| `.github/workflows/` | the GitHub Action that auto-deploys `Code.gs` |
| `manifest.json`, `icon-*.png` | PWA metadata + app icons (so it installs on the phone) |
| `ARCHITECTURE.md` `CLAUDE.md` `DEPLOY.md` `REVIEW.md` | the deep docs (see §11) |

The shared `js/` modules, one line each (from `CLAUDE.md` → "Frontend module
layout"):

| Module | Role |
|--------|------|
| `config.js` | the Web App URL + shared token — the single frontend copy |
| `dom.js` | tiny helpers for touching the page (`$`, `esc`, `toast`, …) |
| `time.js` | date/time helpers (timestamps, local dates) |
| `store.js` | localStorage config (the person's name + H number) |
| `idb.js` | the IndexedDB wrapper + the database version number |
| `api.js` | `apiGet` / `apiPost` — send a request to the spine (adds token + URL) |
| `queue.js` | the offline queue (`enqueue` / `flush`) |
| `daycache.js` | the local copy of today's orders (optimistic + merge + retention) |
| `geocode.js` | address lookup + offline address cache |
| `compute/gaps.js` | works out the travel-time gaps between stops |
| `compute/tally.js` | counts up a day's installs/UTIs for the tally |

---

## 6. How a stop gets saved (a worked example)

Follow a single tap, "I installed a meter," from the phone to the Sheet. This shows
how the layers connect — and why it survives with no signal:

1. The installer fills the form on `index.html` and taps save.
2. **Save locally first.** The app writes the stop into the IndexedDB **queue** (the
   durable list of un-synced writes) *and* immediately updates the **day-cache** (the
   local copy of today's orders). This is the *optimistic update* — the stop appears
   in "Today's orders" instantly, online or not.
3. **Sync when possible.** `flush()` takes the oldest item in the queue and sends it
   to the spine as an HTTP POST carrying JSON like
   `{ token, action: "addStop", installer, workOrderId, lat, lng, … }`.
   - No signal? The send fails, the item stays in the queue, and `flush()` retries
     later. Nothing is lost.
4. **The spine handles it.** `doPost` in `Code.gs` reads `action: "addStop"`, and a
   `switch` statement routes it to the code that appends a new row to the **`Stops`**
   tab of the Sheet.
5. **Done safely.** Each write carries a unique `id`. If the phone times out but the
   write actually succeeded, the retry is recognized and skipped — no duplicate row
   (that's *idempotent* in action).

The takeaway: the phone is the source of truth until a write syncs; the Sheet becomes
the source of truth once it does. The merge logic that keeps these straight lives in
`js/daycache.js` and is described in `ARCHITECTURE.md` → "Client-side storage".

---

## 7. The contract between the pages and the spine

This is the one concept that trips up newcomers, so internalize it:

> The web pages and the spine communicate over **one JSON-over-HTTP protocol**, and
> **changing one side usually means changing the other.** If you add a field on the
> form, the spine has to know how to store it; if you add a column to the Sheet, the
> code that builds that row has to be updated too.

Every request includes a `token` that must equal `SHARED_TOKEN`. That value (and the
spine's URL) live in exactly **two** places that must stay in sync:
`js/config.js` (used by every page) and `Code.gs`. If they disagree, requests are
rejected.

The actions at a glance (the exact field shapes are in `ARCHITECTURE.md` → "Data
structures" — always check there before adding or changing a field):

- **Writes (`doPost`):** `addStop`, `addDowntime`, `dispatchRequest`, `updateStop`,
  `endOfDay`, `previewDailyLog`, `saveTravel`, `saveDay`, `saveEmployee`,
  `deleteEmployee`, `saveTeam`, `deleteTeam`, `saveCaptain`, `deleteCaptain`,
  `saveSub`, `deleteSub`.
- **Reads (`doGet`):** `day`, `range`, `lookup`, `geocode`, `nearby`, `pins`,
  `tracker`, `timing`, `boatdays`, `dispatch`, `avgDispatchTime`, `roster`, `idle`.

A note on **security**: the token sits in plain source on a public-capable site. That
is a *deliberate, documented* trade-off ("open the link and it works"), mitigated by
keeping the repo private. Don't treat the token as a real secret — but also don't
build anything that assumes proper per-user login exists, because it doesn't.

---

## 8. Things that are easy to get wrong

A digest of the landmines (full list in `CLAUDE.md` → "Things that are easy to get
wrong"). Each with *why it matters*:

- **Durable offline data goes in IndexedDB, not localStorage.** localStorage is only
  for trivial config (name, H number). *Why: anything important must survive offline;
  localStorage isn't built for that here.*
- **Dates are Toronto-local.** `dateOf()` in `Code.gs` carefully normalizes every
  date to the Toronto calendar day. *Why: it's load-bearing — a past "end of day
  showed all zeros" bug came from getting this wrong. Don't replace it with a naive
  string slice.*
- **Add a JS module or CSS file → add it to the `SHELL` list in `sw.js` AND bump the
  `CACHE` version.** *Why: the service worker only serves files it knows about; miss
  this and phones won't get your new file offline.*
- **Add an IndexedDB store → bump `DB_VERSION` in `js/idb.js`** (and create it in the
  upgrade handler). *Why: the browser only sets up a new store when the version
  number increases.*
- **Add a column to a Sheet tab → update the matching `*_HEADERS` array in `Code.gs`
  and the code that builds that row (by position).** *Why: most writes place values
  by column order, so a mismatch writes data into the wrong cell. (The `Employees`
  and `Teams` writes are the exception — they map by header name.)*
- **`status: "DONE"`, `VISITED`, and `UNACCOUNTED` are excluded from tallies on
  purpose.** *Why: they're "we were here / already done" markers, not completed
  installs — counting them would inflate someone's numbers.*
- **Identity is split: crew are keyed by "H number" (employee number), but `Stops`
  rows are still filtered by display name.** *Why: before you "fix" an attribution
  bug, know which key a given piece of code uses — two people with the same name can
  still collide in the name-keyed paths.*

---

## 9. How deploying works

There are two independent deploys, both triggered by **pushing to `main`**:

| What | How it ships |
|------|--------------|
| The four HTML pages + `js/` + `css/` | GitHub Pages serves the repo root — pushing publishes them. Nothing to build. |
| `Code.gs` (the spine) | A GitHub Action redeploys the *existing* Google deployment in place, so the spine's URL never changes. |

Two things to remember:

- You can still deploy the spine by hand (paste `Code.gs` into the Apps Script editor
  and redeploy) if CI is unavailable.
- **After changing tabs/columns, you must re-run `setupSheets()` once** from the Apps
  Script editor. The Action only ships code; it doesn't create new tabs/columns. This
  step is additive and safe — except a schema-changed `Teams` tab, which must be
  deleted first.

Full details and the one-time secret setup are in `DEPLOY.md`.

---

## 10. Your first change — a safe path

A low-risk way to get your feet wet:

1. **Read `ARCHITECTURE.md` start to finish.** It's the authoritative design doc and
   it's kept current. This guide is the on-ramp; that's the map.
2. **Run it locally** (§4) and click around all four pages so you know what each does.
3. **Work on a branch**, not `main`. (You're already on one for this session.)
4. **Make a tiny, visible change** to one page — e.g. a label or a color in a
   `css/` file — and refresh the browser to see it. This proves your loop works.
5. **Verify by running it.** There's no test suite, so verification is literally
   "serve it, open it, and look." For backend changes, also re-run `setupSheets()` if
   you touched tabs/columns.
6. **Commit and push** when it works. Pushing to `main` deploys (§9), so only push
   changes you've actually checked in the browser.

---

## 11. Where to go deeper

| Doc | Read it for |
|-----|-------------|
| `ARCHITECTURE.md` | **Start here.** The authoritative design, the data flow, and the exact shape of every Sheet tab and request. |
| `CLAUDE.md` | The working rules and the full "easy to get wrong" list — how to safely change each part. |
| `DEPLOY.md` | How deployment + CI works, and the one-time secret setup. |
| `REVIEW.md` | A point-in-time code-review snapshot: what's good, what's rough, and candidate first tasks. (Line numbers may have drifted — verify before relying on them.) |

---

## 12. Good first issues

Small, self-contained tasks pulled from `REVIEW.md`'s "quick-wins" list — good for a
first PR. These are from a review *snapshot*, so **verify each is still true in the
current code before starting** (line numbers and details may have moved):

- Add `./map.html` to the `SHELL` list in `sw.js` so the viewer opens on a first
  offline visit (and bump `CACHE`).
- Make `endOfDay` not report success when the PDF actually failed to build.
- Range-check inputs: `lat`/`lng` within valid bounds, downtime `minutes`
  non-negative.
- Add `aria-label`s to the icon-only buttons (accessibility).
- Prefix user-supplied text with `'` when writing to the Sheet, so a value starting
  with `=` isn't treated as a spreadsheet formula.

Pick one, follow the safe path in §10, and ask questions early.

Welcome aboard.
