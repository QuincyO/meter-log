# Codebase Review — meter-log

> Snapshot review as of 2026-06-25. This is a point-in-time assessment, **not** a
> living design doc — `ARCHITECTURE.md` remains the authoritative description of
> the current design. Citations below were verified against source at review time;
> line numbers may drift as the code changes.

## What this is

A field data-capture PWA for a hydro-meter install crew working out of boats.
Three layers, no build step, no framework, no package manager:

- **Capture/view** — four static HTML pages (`index.html` capture, `map.html`
  viewer/analytics, `teams.html` crew admin, `edit.html` back-office editor) plus
  a service worker (`sw.js`) for offline.
- **Spine** — `Code.gs`, one Google Apps Script Web App (~1540 lines) that does
  every deterministic read/write through `doGet`/`doPost`.
- **Store** — one Google Sheet (eleven tabs) as the system of record.

Deploying the frontend = commit + push (GitHub Pages serves the repo root).
`Code.gs` auto-deploys via a GitHub Action that redeploys the existing
deployment in place.

## What's good

The fundamentals are solid, and a few things are notably well done:

- **Offline-first capture is real, not aspirational.** Writes are storage-first:
  `enqueue()` hits the IndexedDB `queue` *and* updates `dayCache` immediately, so
  a stop survives offline before it ever reaches the Sheet. The flush loop is
  re-entrancy-guarded, FIFO-ordered (`_seq`), and only deletes a queue item on a
  genuinely recognized success — transient failures are kept and retried.
- **Idempotency is designed in.** Append writes carry a client-generated `id` and
  the spine's `idExists()` skips already-written rows, so a timed-out-but-
  succeeded retry doesn't duplicate. `endOfDay`/`saveTravel` are upsert/replace.
- **Date handling is deliberate.** `dateOf()` normalizes Date objects, UTC `…Z`
  strings, and local strings to the Toronto calendar date — and the docs call out
  *why* (the "end of day all zeros" bug). This is load-bearing and treated as such.
- **Docs are unusually strong for a project this size.** `ARCHITECTURE.md`,
  `CLAUDE.md`, and `DEPLOY.md` are thorough, current, and honest about pitfalls.
- **CI is safe.** The deploy Action redeploys the *existing* deployment (stable
  `/exec` URL) with concurrency control, and only triggers on `Code.gs` /
  `appsscript.json` changes.
- **Secrets hygiene is clean.** `.clasprc.json` (the clasp OAuth token) is
  correctly gitignored — verified via `git check-ignore`. The hardcoded
  `SHARED_TOKEN` is a documented, accepted trade-off, not an accident.

## What can be improved

Grouped by theme. Each item notes roughly where it lives and why it matters.
Effort is a rough estimate (S = <1h, M = 1–4h, L = half-day+).

### Maintainability

| Item | Where | Why it matters | Effort |
|------|-------|----------------|--------|
| `SHARED_TOKEN` + `WEB_APP_URL` duplicated in **5 files** | `Code.gs:42` + all 4 HTML pages | Credential/URL rotation is 5 edits; one miss silently breaks a page | S |
| Helper copy-paste across pages | `$`, `esc`, `attr`, `enc`, `toast` in all 4 HTML files | A bug in `esc` must be fixed 4×; ~150 lines of dup | M |
| `:root` CSS vars + button styles duplicated | all 4 HTML files | Theme change = 4 edits | S |
| Status/category enums hardcoded inline | `index.html` `<option>`s vs `edit.html` `CAT_LABEL` | Two sources of truth for the same enum can drift | S |
| Positional column appends | `addStop`/`addDowntime`/Tracker in `Code.gs` | Reordering a Sheet column silently writes to the wrong cell (vs. header-keyed `upsertByHeader()` used elsewhere) | M |
| Deployment-ID drift | hardcoded in the workflow + 3 HTML `WEB_APP_URL`s | Recreating the deployment requires syncing 4 places | — |

### Correctness / robustness

- **`sw.js` SHELL omits `map.html`** (`sw.js:14`, verified). The shell caches
  `index`/`teams`/`edit` but not `map.html`, so the viewer fails to open on a
  first offline visit. One-word fix. **(S)**
- **`endOfDay` reports success on a failed PDF.** `buildDailyLogPdf` can return
  `{error}` (~`Code.gs:215`), but `endOfDay` returns `{ok:true, …}` regardless
  (~812) — the day is marked closed with a missing/broken PDF and no signal. **(S)**
- **`LockService` silently falls back to unlocked** on failure (~`Code.gs:409`).
  When the lock is unavailable, concurrent writes proceed without
  synchronization, defeating the atomicity the retry path assumes. **(S–M)**
- **IndexedDB errors swallowed.** `.catch(() => null)` (~`index.html:457`) hides
  quota-exceeded / private-browsing / corruption failures — an offline stop can
  silently fail to persist with no user feedback. **(M)**
- **`saveTravel` delete-then-append is non-atomic** (~`Code.gs:857`). An
  exception between the delete and the re-append (e.g. quota) loses that day's
  travel deductions with no restore. **(M)**
- **Sheet formula injection.** User strings (installer, notes, weather) are
  written raw; a value starting with `=` is interpreted by Sheets as a formula.
  Prefix user-supplied cells with `'` on write. **(S)**
- **Unbounded numeric inputs.** `lat`/`lng` aren't range-checked ([-90,90] /
  [-180,180]) and downtime `minutes` accepts negatives / huge values, which then
  corrupt daily totals. **(S)**
- **Same-name collisions persist where attribution is name-based.** Dispatch
  matching and `Stops`/`Tracker` filtering key on display name (`sameName`,
  case/space-sensitive), so two crew sharing a name can cross-match. Identity is
  H-number-keyed elsewhere — worth closing the gap or at least normalizing names
  on input. **(M)**

### UX / accessibility (phones, gloves, sunlight, offline)

- **No queue visibility.** The user can't see how many stops are pending sync or
  when the next retry happens — on a boat with no signal this is silent. **(M)**
- **Touch targets below guideline.** `.locbtn` (~40px) and `.mini` (~38px) are
  under the 44px minimum — awkward with gloves. **(S)**
- **Accessibility gaps.** Several icon-only buttons (`.x`, toggle arrows, `☰`)
  lack `aria-label`; modal `.sheet`s have no `role="dialog"`, focus trap, or
  Escape-to-close. **(M)**
- **Validation is server-round-trip only.** Required-but-empty fields surface as
  a toast after a failed send rather than a local red-border check. **(M)**

### Documentation

- **`README.md` is effectively empty** (title only). The three strong docs exist
  but a new contributor has no entry point pointing at them. **(S)**

## What I'd add

All of these fit the no-build-step constraint.

1. **A real `README.md`** — one-paragraph overview, the run command
   (`python -m http.server 8731`), and links to `ARCHITECTURE.md` / `DEPLOY.md` /
   `CLAUDE.md`. Cheapest high-value change here.
2. **A no-build shared layer** — `config.js` (token + URL), `utils.js` (`$`,
   `esc`, `attr`, `enc`, `toast`), and `shared.css` (`:root` + button styles),
   pulled into each page via `<script>` / `<link>`. Eliminates most of the
   cross-file duplication above without introducing a bundler.
3. **A consistency check** — a tiny script (CI step or pre-commit) that greps the
   token, URL, and deployment ID across all 5 files and fails on mismatch. It's
   the one cheap "test" that fits a repo with no runner, and it directly guards
   the most error-prone maintenance task.
4. **Optional, later** — if a JS runner is ever introduced, lightweight smoke
   tests for the SW caching strategy, the queue FIFO/idempotency path, and
   `dateOf()` would cover the load-bearing logic.

## Quick-wins (high value, low effort)

| Priority | Change | Effort |
|----------|--------|--------|
| 1 | Add `./map.html` to `sw.js` SHELL | S |
| 2 | Guard `endOfDay` against a failed PDF (don't return `ok:true`) | S |
| 3 | Write a real `README.md` | S |
| 4 | Extract `config.js` so token/URL live in one place | S |
| 5 | Prefix user strings with `'` on Sheet writes (formula injection) | S |
| 6 | Add `aria-label` to icon-only buttons | S |
| 7 | Range-check `lat`/`lng` and downtime `minutes` | S |
