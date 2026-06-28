# Sheet → Markdown Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Apps Script function set to `Code.gs` that snapshots all 12 sheet tabs into `data/*.md` and commits them to `main` in one atomic commit, run nightly by a time trigger.

**Architecture:** Pure formatters (`mdEscapeCell`, `tabToMarkdown`, `buildIndexMarkdown`) turn each tab's live header row + raw cell values into a GitHub-flavored-markdown table. `buildExportFiles()` reads every tab into a `[{path, content}]` list (12 tab files + a `data/README.md` index). `githubCommitFiles()` pushes them via GitHub's Git Data API (ref → tree → commit → ref update) so all files land in a single commit. `exportSheetToGithub()` orchestrates and is what the nightly trigger (installed once by `createDailyExportTrigger()`) calls.

**Tech Stack:** Google Apps Script (V8), `UrlFetchApp`, `PropertiesService`, `ScriptApp` time triggers, GitHub Git Data REST API v2022-11-28.

## Global Constraints

- **No build step, no package manager, no local test harness.** "Tests" are Apps Script functions runnable from the editor's function-picker that throw on failure / `Logger.log` on success. There is no red-green CLI loop — verification is: push `Code.gs` (auto-deploys via `clasp`, or paste into the editor), then run the named function in the Apps Script editor and read the execution log.
- **All code goes in `Code.gs`** in one new clearly-commented section appended at the end of the file (after the existing helpers, currently ending ~line 1533). No new files in `js/` or `css/`.
- **The write-capable GitHub PAT is a real secret** — it lives ONLY in Script Properties (`GITHUB_TOKEN`), never hardcoded in `Code.gs`. `GITHUB_REPO` (`QuincyO/meter-log`) is the second Script Property. This is unlike `SHARED_TOKEN`, which is a deliberately-public crude gate.
- **Timezone constant** `TIMEZONE` (`'America/Toronto'`) and helper `today()` already exist in `Code.gs` — reuse them, do not redefine.
- **Commit target is `main`.** No separate branch, no PR.
- Spec: `docs/superpowers/specs/2026-06-28-sheet-markdown-export-design.md`.

---

### Task 1: Pure markdown formatters

**Files:**
- Modify: `Code.gs` (append new section at end of file)

**Interfaces:**
- Consumes: `TIMEZONE` (existing constant).
- Produces:
  - `mdEscapeCell(value) -> string` — escapes one cell for a GFM table.
  - `tabToMarkdown(name: string, headers: any[], dataRows: any[][], exportedAt: string) -> string` — full markdown doc for one tab.
  - `buildIndexMarkdown(index: {name:string,count:number}[], exportedAt: string) -> string` — the `README.md` index body.

- [ ] **Step 1: Write the self-test function**

Append to the very end of `Code.gs`:

```javascript
// ── GitHub markdown export — self-tests (run from the editor) ───────────────
function test_markdownFormatting() {
  if (mdEscapeCell('a|b') !== 'a\\|b')   throw new Error('pipe not escaped');
  if (mdEscapeCell('a\nb') !== 'a<br>b') throw new Error('newline not escaped');
  if (mdEscapeCell('a\\b') !== 'a\\\\b') throw new Error('backslash not escaped');
  if (mdEscapeCell(null) !== '')         throw new Error('null should be empty string');
  if (mdEscapeCell(0) !== '0')           throw new Error('0 should stringify');

  const md = tabToMarkdown('T', ['x', 'y'], [[1, 2]], '2026-06-28 03:00');
  if (md.indexOf('# T') !== 0)            throw new Error('missing H1');
  if (md.indexOf('1 row ') === -1)       throw new Error('singular row count');
  if (md.indexOf('| x | y |') === -1)    throw new Error('missing header row');
  if (md.indexOf('| --- | --- |') === -1) throw new Error('missing separator row');
  if (md.indexOf('| 1 | 2 |') === -1)    throw new Error('missing data row');

  const empty = tabToMarkdown('E', ['x'], [], '2026-06-28 03:00');
  if (empty.indexOf('0 rows') === -1)    throw new Error('plural row count');
  if (empty.indexOf('_(no rows)_') === -1) throw new Error('empty tab body');

  const idx = buildIndexMarkdown([{ name: 'Stops', count: 3 }], '2026-06-28 03:00');
  if (idx.indexOf('[Stops](Stops.md)') === -1) throw new Error('index link');
  if (idx.indexOf('3 rows') === -1)      throw new Error('index row count');

  Logger.log('test_markdownFormatting OK');
}
```

- [ ] **Step 2: Confirm it fails**

The three functions don't exist yet. Reason check (no need to deploy yet): running `test_markdownFormatting` now would throw `ReferenceError: mdEscapeCell is not defined`. Proceed to implement.

- [ ] **Step 3: Implement the formatters**

Insert ABOVE the `test_markdownFormatting` function (so the section reads top-down: section header, formatters, then tests):

```javascript
// ── GitHub markdown export ─────────────────────────────────────────────────
// Nightly snapshot of every data tab to data/*.md, committed to `main` in one
// atomic commit via the GitHub Git Data API. Trigger-driven — see
// createDailyExportTrigger(). Auth is a fine-grained PAT in Script Properties
// (GITHUB_TOKEN + GITHUB_REPO); a real secret, never hardcoded here.

// Escape one cell value for a GitHub-flavored-markdown table. Date cells (some
// columns hold real Date objects) render as Toronto 'yyyy-MM-dd HH:mm:ss'.
function mdEscapeCell(value) {
  let s;
  if (value == null) s = '';
  else if (Object.prototype.toString.call(value) === '[object Date]')
    s = Utilities.formatDate(value, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  else s = String(value);
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

// Render one tab as: H1 + "_<n> rows · exported <ts> <tz>_" + GFM table (or
// "_(no rows)_" when there is no data). Trailing newline so files end clean.
function tabToMarkdown(name, headers, dataRows, exportedAt) {
  const meta = '_' + dataRows.length + ' row' + (dataRows.length === 1 ? '' : 's') +
    ' · exported ' + exportedAt + ' ' + TIMEZONE + '_';
  let body;
  if (!dataRows.length) {
    body = '_(no rows)_';
  } else {
    const head = '| ' + headers.map(mdEscapeCell).join(' | ') + ' |';
    const sep  = '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |';
    const lines = dataRows.map(function (r) {
      return '| ' + headers.map(function (_, i) { return mdEscapeCell(r[i]); }).join(' | ') + ' |';
    });
    body = [head, sep].concat(lines).join('\n');
  }
  return '# ' + name + '\n\n' + meta + '\n\n' + body + '\n';
}

// The data/README.md index: timestamp + a bullet per tab linking its file.
function buildIndexMarkdown(index, exportedAt) {
  const lines = index.map(function (t) {
    return '- [' + t.name + '](' + t.name + '.md) — ' +
      t.count + ' row' + (t.count === 1 ? '' : 's');
  });
  return '# Sheet export\n\n_Exported ' + exportedAt + ' ' + TIMEZONE + '_\n\n' +
    'Nightly Markdown snapshot of the meter-log Google Sheet.\n\n' +
    lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Verify it passes**

Push `Code.gs` to `main` (auto-deploys via `clasp`) **or** paste the file into the bound Apps Script editor. In the editor, select `test_markdownFormatting` in the function dropdown and Run.
Expected: execution log shows `test_markdownFormatting OK` and no exception.

- [ ] **Step 5: Commit**

```bash
git add Code.gs
git commit -m "Add markdown table formatters for sheet export"
```

---

### Task 2: Read all tabs into export files

**Files:**
- Modify: `Code.gs` (same section)

**Interfaces:**
- Consumes: `tabToMarkdown`, `buildIndexMarkdown` (Task 1); `TIMEZONE`, `SpreadsheetApp` (existing).
- Produces:
  - `EXPORT_TABS: string[]` — the 12 tab names, in order.
  - `buildExportFiles() -> {path: string, content: string}[]` — 12 tab files (`data/<Tab>.md`) + `data/README.md`, reading each tab's live header row and raw values.

- [ ] **Step 1: Write the self-test function**

Append after `test_markdownFormatting`:

```javascript
function test_buildExportFiles() {
  const files = buildExportFiles();
  // 12 tabs that actually exist + the index. setupSheets() must have run.
  if (!files.length) throw new Error('no files produced');
  const paths = files.map(function (f) { return f.path; });
  if (paths.indexOf('data/README.md') === -1) throw new Error('missing index file');
  if (paths.indexOf('data/Stops.md') === -1)  throw new Error('missing Stops file');
  files.forEach(function (f) {
    if (f.path.indexOf('data/') !== 0) throw new Error('bad path: ' + f.path);
    if (typeof f.content !== 'string' || !f.content.length)
      throw new Error('empty content: ' + f.path);
  });
  Logger.log('test_buildExportFiles OK — ' + files.length + ' files: ' + paths.join(', '));
}
```

- [ ] **Step 2: Confirm it fails**

Reason check: `EXPORT_TABS` / `buildExportFiles` don't exist — running would throw `ReferenceError`. Proceed.

- [ ] **Step 3: Implement**

Insert below `buildIndexMarkdown` (above the self-tests):

```javascript
// Tabs exported, in order. Explicit (NOT ss.getSheets()) so the "DailyLog
// Template" tab is never exported. Headers still come live from each sheet, so
// a column reorder needs no change here — only adding a brand-new tab does.
const EXPORT_TABS = [
  'Stops', 'Downtime', 'Tracker', 'Employees', 'Teams', 'Captains', 'Subs',
  'Timing', 'Days', 'BoatDays', 'Dispatch', 'Metrics'
];

// Read every EXPORT_TABS tab into [{path, content}] markdown files, plus the
// data/README.md index. A missing tab is skipped (run setupSheets() to create
// it). Header row + raw cell values come straight from the live sheet.
function buildExportFiles() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const exportedAt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm');
  const files = [];
  const index = [];
  EXPORT_TABS.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const values = sh.getDataRange().getValues();
    const headers = values.length ? values[0] : [];
    const dataRows = values.slice(1);
    files.push({
      path: 'data/' + name + '.md',
      content: tabToMarkdown(name, headers, dataRows, exportedAt)
    });
    index.push({ name: name, count: dataRows.length });
  });
  files.push({ path: 'data/README.md', content: buildIndexMarkdown(index, exportedAt) });
  return files;
}
```

- [ ] **Step 4: Verify it passes**

Push/paste, then run `test_buildExportFiles` from the editor.
Expected: log shows `test_buildExportFiles OK — 13 files: data/Stops.md, ... , data/README.md` (13 if all 12 tabs exist). No exception.

- [ ] **Step 5: Commit**

```bash
git add Code.gs
git commit -m "Build markdown export file list from all sheet tabs"
```

---

### Task 3: Commit files to GitHub via the Git Data API

**Files:**
- Modify: `Code.gs` (same section)

**Interfaces:**
- Consumes: `PropertiesService`, `UrlFetchApp` (existing).
- Produces:
  - `githubCommitFiles(files: {path,content}[], message: string) -> string` — pushes all files in one commit to `main`; returns the new commit SHA. Throws on missing config or any non-2xx response.

- [ ] **Step 1: Write the config-guard self-test**

Append after `test_buildExportFiles`:

```javascript
// Verifies the missing-config guard WITHOUT hitting GitHub. Safe to run anytime.
function test_githubConfigGuard() {
  const props = PropertiesService.getScriptProperties();
  const savedToken = props.getProperty('GITHUB_TOKEN');
  const savedRepo  = props.getProperty('GITHUB_REPO');
  props.deleteProperty('GITHUB_TOKEN');
  props.deleteProperty('GITHUB_REPO');
  let threw = false;
  try { githubCommitFiles([{ path: 'data/x.md', content: 'x' }], 'msg'); }
  catch (e) { threw = (e.message.indexOf('Script Properties') !== -1); }
  // restore whatever was there so we don't clobber real config
  if (savedToken != null) props.setProperty('GITHUB_TOKEN', savedToken);
  if (savedRepo  != null) props.setProperty('GITHUB_REPO', savedRepo);
  if (!threw) throw new Error('expected a clear Script Properties error');
  Logger.log('test_githubConfigGuard OK');
}
```

- [ ] **Step 2: Confirm it fails**

Reason check: `githubCommitFiles` doesn't exist — `ReferenceError`. Proceed.

- [ ] **Step 3: Implement**

Insert below `buildExportFiles` (above the self-tests):

```javascript
// Push every file in `files` to `main` in ONE atomic commit via the Git Data
// API (ref → base commit → new tree → new commit → move ref). Returns the new
// commit SHA. Throws (with the response body) on any non-2xx, so a partial push
// can never happen — the ref only moves after every blob/tree/commit succeeds.
function githubCommitFiles(files, message) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO');
  if (!token || !repo)
    throw new Error('Set GITHUB_TOKEN and GITHUB_REPO in Script Properties (Project Settings ▸ Script Properties).');

  const api = 'https://api.github.com/repos/' + repo + '/git';
  function gh(path, method, payload) {
    const opt = {
      method: method,
      muteHttpExceptions: true,
      headers: {
        Authorization: 'token ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
    const res = UrlFetchApp.fetch(api + path, opt);
    const code = res.getResponseCode();
    if (code < 200 || code >= 300)
      throw new Error('GitHub ' + method + ' ' + path + ' → ' + code + ': ' + res.getContentText());
    return JSON.parse(res.getContentText());
  }

  const ref        = gh('/ref/heads/main', 'get');
  const baseSha    = ref.object.sha;
  const baseCommit = gh('/commits/' + baseSha, 'get');
  const tree = gh('/trees', 'post', {
    base_tree: baseCommit.tree.sha,
    tree: files.map(function (f) {
      return { path: f.path, mode: '100644', type: 'blob', content: f.content };
    })
  });
  const commit = gh('/commits', 'post', {
    message: message, tree: tree.sha, parents: [baseSha]
  });
  gh('/refs/heads/main', 'patch', { sha: commit.sha });
  return commit.sha;
}
```

- [ ] **Step 4: Verify the guard passes**

Push/paste, then run `test_githubConfigGuard`.
Expected: log shows `test_githubConfigGuard OK`. (This test never calls GitHub; it restores any existing config it temporarily cleared.)

- [ ] **Step 5: Commit**

```bash
git add Code.gs
git commit -m "Add GitHub Git Data API commit helper for sheet export"
```

---

### Task 4: Orchestrator, trigger installer, and one-time setup docs

**Files:**
- Modify: `Code.gs` (same section)
- Modify: `DEPLOY.md` (document the one-time Script Properties + trigger setup)

**Interfaces:**
- Consumes: `buildExportFiles` (Task 2), `githubCommitFiles` (Task 3), `today()`, `ScriptApp`, `TIMEZONE` (existing).
- Produces:
  - `exportSheetToGithub() -> string` — the trigger entry point; builds + commits, logs the SHA, returns it.
  - `createDailyExportTrigger() -> void` — installs a ~3am daily trigger (removing any prior copy first so re-running never stacks triggers).

- [ ] **Step 1: Implement the orchestrator + trigger installer**

Insert below `githubCommitFiles` (above the self-tests):

```javascript
// Trigger entry point: snapshot every tab and push it to main in one commit.
function exportSheetToGithub() {
  const files = buildExportFiles();
  const sha = githubCommitFiles(files, 'Nightly sheet export — ' + today());
  Logger.log('Pushed export commit ' + sha + ' (' + files.length + ' files).');
  return sha;
}

// Run ONCE by hand from the editor to install the nightly (~3am Toronto)
// trigger. Idempotent: deletes any existing exportSheetToGithub trigger first,
// so re-running doesn't stack duplicates.
function createDailyExportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'exportSheetToGithub') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('exportSheetToGithub')
    .timeBased().atHour(3).everyDays(1).inTimezone(TIMEZONE).create();
  Logger.log('Daily export trigger installed (~3am ' + TIMEZONE + ').');
}
```

- [ ] **Step 2: Document the one-time setup in `DEPLOY.md`**

Append this section to the end of `DEPLOY.md`:

```markdown
## Nightly Sheet → Markdown export (one-time setup)

`exportSheetToGithub()` (in `Code.gs`) snapshots every sheet tab into `data/*.md`
on `main` nightly. It needs two one-time manual steps in the bound Apps Script
project — the code can't do these for you:

1. **Create a GitHub fine-grained PAT** scoped to `QuincyO/meter-log` with
   **Contents: Read and write**. Copy the token.
2. **Apps Script ▸ Project Settings ▸ Script Properties**, add:
   - `GITHUB_TOKEN` = the PAT from step 1
   - `GITHUB_REPO` = `QuincyO/meter-log`
3. **Install the trigger:** in the editor, run `createDailyExportTrigger()` once
   (authorize when prompted). It installs a ~3am America/Toronto daily trigger
   and is safe to re-run (it de-dupes its own trigger).

To take a snapshot on demand, run `exportSheetToGithub()` from the editor — the
execution log prints the new commit SHA. The PAT is a real secret and lives only
in Script Properties, never in `Code.gs`.
```

- [ ] **Step 3: Verify end-to-end against the live repo**

This is the real integration check (requires the Script Properties from Step 2 set in the editor — do this once now to verify, even though the plan documents it as a deploy-time step):

1. Push/paste so the new code is in the editor.
2. Run `exportSheetToGithub()` from the function dropdown; authorize the GitHub `UrlFetchApp` scope if prompted.
Expected: execution log shows `Pushed export commit <sha> (13 files).` (13 with all tabs present.)
3. In a terminal: `git pull` — confirm a new `data/` directory arrives with `README.md` + one `.md` per tab, each containing a markdown table.

Verify: `git pull && ls data/` lists `README.md Stops.md Downtime.md ... Metrics.md`. Open `data/Stops.md` and confirm it is a valid markdown table with the tab's headers.

- [ ] **Step 4: Run the full self-test sweep**

In the editor, run `test_markdownFormatting`, `test_buildExportFiles`, and `test_githubConfigGuard` once more.
Expected: each logs its `... OK` line, no exceptions.

- [ ] **Step 5: Commit**

```bash
git add Code.gs DEPLOY.md
git commit -m "Add nightly sheet-export orchestrator, trigger installer, and setup docs"
```

---

## Notes for the implementer

- **Section placement:** all new code is one contiguous block appended to the end of `Code.gs`, ordered top-down: section comment → `mdEscapeCell` → `tabToMarkdown` → `buildIndexMarkdown` → `EXPORT_TABS` → `buildExportFiles` → `githubCommitFiles` → `exportSheetToGithub` → `createDailyExportTrigger` → the three `test_*` functions. Each task appends its piece into that order.
- **No `ARCHITECTURE.md` change is required** for v1 (this is an out-of-band backup, not part of the request/response contract). If you want, add a one-line mention under a "Backups" note — optional, not in scope.
- **GitHub API auth header** uses `token <PAT>` (works for fine-grained PATs) with `X-GitHub-Api-Version: 2022-11-28`.
- **Atomicity:** the ref is moved (`PATCH /refs/heads/main`) only after the tree and commit objects are created, so any earlier failure throws and leaves `main` untouched — never a partial export.
```
