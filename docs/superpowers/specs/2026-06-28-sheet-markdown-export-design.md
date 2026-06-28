# Nightly Google Sheet → Markdown export to GitHub

**Date:** 2026-06-28
**Status:** Approved (ready for implementation plan)

## Goal

Snapshot the meter-log Google Sheet's tabs into Markdown files committed to this
repo nightly, with no laptop involved. Gives a version-controlled, human- and
Claude-readable backup of the system of record, diffable per tab over time.

## Decisions

| Question | Decision |
|----------|----------|
| Where it runs | **Apps Script** — a new section in `Code.gs`, direct sheet access, pushes via the GitHub API. |
| Trigger | **Nightly time trigger** (~3am Toronto), installed once from the editor. |
| Layout | **One file per tab + an index** under `data/`. |
| Scope | **All 12 tabs.** |
| Commit target | **`main`** (straight commit; accepts a nightly data commit in history). |

## Output in the repo

```
data/
  README.md      ← index: links to each tab file, row counts, last-export timestamp (Toronto)
  Stops.md
  Downtime.md
  Tracker.md
  Employees.md
  Teams.md
  Captains.md
  Subs.md
  Timing.md
  Days.md
  BoatDays.md
  Dispatch.md
  Metrics.md
```

Each tab file:

```markdown
# Stops

_<N> rows · exported 2026-06-28 03:00 America/Toronto_

| col1 | col2 | ... |
| --- | --- | ... |
| v | v | ... |
```

- Table built from the tab's actual header row (row 1) + all data rows.
- Cell values containing `|`, newlines, or backslashes are escaped so the GFM
  table stays valid (`|` → `\|`, newline → `<br>`).
- An empty tab (header only) renders `_(no rows)_` instead of a table.
- `README.md` lists every tab with its row count and links to its file, plus the
  single export timestamp.

The tab list is **derived from the existing `setupSheets()` tab order** so adding
a future tab needs no change here (see Implementation notes).

## How it commits — one atomic commit via the Git Data API

`exportSheetToGithub()` produces all 13 files in memory, then makes one commit
(not 13) so the repo never sees a partial push:

1. Build the 13 file contents in memory (`buildExportFiles()`).
2. `GET /repos/{owner}/{repo}/git/ref/heads/main` → latest commit SHA.
3. `GET` that commit → its tree SHA.
4. `POST /git/trees` — 13 entries (`data/*.md`, mode `100644`, `content`), `base_tree` = current tree.
5. `POST /git/commits` — message `"Nightly sheet export — <YYYY-MM-DD>"`, tree = new tree, parents = `[current SHA]`.
6. `PATCH /git/refs/heads/main` → point `main` at the new commit.

All via `UrlFetchApp` against `https://api.github.com`.

**Side effects:** data files don't touch `Code.gs`, so the
`deploy-appsscript.yml` workflow is **not** triggered. GitHub Pages will
republish (harmless — no app files change).

## Auth — a real secret, kept out of source

Unlike `SHARED_TOKEN` (a deliberately-public crude gate), a write-capable GitHub
token must **never** sit in the public-capable source. So:

- A GitHub **fine-grained PAT** scoped to `QuincyO/meter-log` with
  **Contents: read & write**.
- Stored in **Script Properties**, not in `Code.gs`:
  - `GITHUB_TOKEN` = the PAT
  - `GITHUB_REPO` = `QuincyO/meter-log`
- Read at runtime via `PropertiesService.getScriptProperties()`. If either is
  missing, the function throws a clear "set Script Properties" error.

This is a one-time manual setup (Project Settings ▸ Script Properties), the same
place the trigger is installed.

## Components (each independently runnable/testable from the editor)

| Function | Purpose | Pure? |
|----------|---------|-------|
| `tabToMarkdown(name, headers, rows)` | Render one tab as an H1 + meta line + GFM table (or `_(no rows)_`). | Yes |
| `mdEscapeCell(value)` | Escape `\|`, newlines, backslashes for a table cell. | Yes |
| `buildExportFiles()` | Read every tab, return `[{path, content}]` for all tabs + `README.md`. | Reads sheet only |
| `githubCommitFiles(files, message)` | The Git Data API dance; throws on any non-2xx. | Network |
| `exportSheetToGithub()` | Orchestrator the trigger calls: `buildExportFiles()` → `githubCommitFiles()`. | — |
| `createDailyExportTrigger()` | Install the ~3am daily trigger; run once by hand. Removes any prior copy first so re-running doesn't stack triggers. | — |

## Error handling

- `githubCommitFiles` checks `getResponseCode()` on every call; on non-2xx it
  throws an `Error` including the response body, so failures surface in the Apps
  Script execution log and the standard trigger-failure email.
- The commit is atomic (single ref update at the end), so a mid-run failure
  leaves `main` untouched — never a partial export.
- Missing `GITHUB_TOKEN`/`GITHUB_REPO` → explicit thrown error before any network call.

## Implementation notes

- Place the new code in its own clearly-commented section at the end of `Code.gs`
  (e.g. `// ── GitHub markdown export ──`).
- Derive the tab list + headers from the existing `*_HEADERS` constants /
  `setupSheets()` order rather than re-listing them, so it stays in sync as tabs
  evolve. Read rows with the existing `rows()` / sheet read helpers where they fit.
- Timestamp uses `Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm')`.
- File content is sent as the raw string in the tree blob `content` field
  (GitHub accepts UTF-8 directly; no base64 needed for the trees API).

## Out of scope (YAGNI)

- No separate `data-export` branch or PR flow — commits straight to `main`.
- No per-tab incremental diffing or "only commit if changed" logic in v1 (a
  nightly no-op commit is acceptable; can add a skip-if-identical check later).
- No CSV/JSON export — Markdown tables only.
- No frontend or `?action=` endpoint — trigger-driven and editor-runnable only.
