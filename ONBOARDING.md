# ONBOARDING — standing up your own copy

You have been given a copy of the meter-log source as **files, not a git clone**. This
document takes you from those files to a fully working, fully isolated instance: your own
Google Sheet, your own Apps Script deployment, your own API keys, your own GitHub repo and
GitHub Pages site.

**Isolation is the point.** Nothing you build here should be able to read or write the
production Sheet, redeploy the production Apps Script, or spend the production API quota.
The steps below are ordered so that is true at every stage, and §12 is a checklist to
prove it.

Work through this once, top to bottom. It takes about an hour, most of it waiting on
Google's consent screens.

---

## 1. What you were given, and what you must not do

The bundle was produced by `scripts/make-handoff.mjs`. Deliberately:

- **There is no `.git` directory.** The original repo has live credentials committed in
  its history, so history was not shipped. You start a fresh repo in §7.
- **`js/config.js` is all placeholders** (it is a copy of `js/config.example.js`).
- **`Code.gs`'s `SHARED_TOKEN` and the deploy workflow's `DEPLOYMENT_ID` are blanked.**

Until you complete §3–§5 the app will refuse to talk to any spine at all: `js/api.js`
throws and the offline queue holds its writes instead of sending them. That is the
preflight guard (`CONFIG_READY` in `js/config.js`) and it is there on purpose — an
unconfigured copy fails loudly rather than quietly posting into someone else's Sheet.

**Never paste the original deployment's `/exec` URL or shared token into this copy.** If
you ever find yourself with those values, you are one reload away from writing into live
field data. There is no undo on the crew's Sheet.

Read [`AGENTS.md`](AGENTS.md) before changing code — it is the single source of truth for
how this project works, and [`ARCHITECTURE.md`](ARCHITECTURE.md) is the design doc.

## 2. Copy the Sheet

The Apps Script is *container-bound*: it reaches its spreadsheet through
`SpreadsheetApp.getActiveSpreadsheet()` and there is no Sheet ID anywhere in the source.
So "which Sheet" is decided entirely by which spreadsheet your script is attached to — you
never configure it.

**Preferred route.** You will be shared the original Sheet as **Viewer**. Immediately:

1. **File ▸ Make a copy** → save it to **your own** Google Drive. A copy made by you is
   owned by you.
2. Confirm the copy is in your Drive and the original is not.
3. Ask for the share on the original to be **revoked**. You do not need it again, and
   leaving it in place is a standing hazard.

**Fallback**, if sharing the original is not wanted: you receive a `.xlsx` export
(File ▸ Download ▸ Microsoft Excel) and import it into a new Sheet in your Drive. One real
hazard on this path: **xlsx caps a cell at 32,767 characters while Google Sheets allows
50,000.** The `DriveTracks` tab stores encoded GPS polylines that can exceed that, and they
will be silently truncated. Everything else is short text and numbers and survives fine.
If drive-track replay on `map.html` matters to your work, use the Drive-copy route.

Either way, the copy carries the real data — crew names, H numbers, home addresses,
customer addresses, GPS traces. Treat it accordingly.

## 3. Create your Apps Script project

On **your** copy of the Sheet: **Extensions ▸ Apps Script**.

1. Paste in `Code.gs` from the bundle, replacing whatever is there.
2. **Project Settings ▸ "Show `appsscript.json` manifest file in editor"**, then paste in
   `appsscript.json` from the bundle.
3. **Generate your own shared token** and set it at `Code.gs:42`, replacing
   `PASTE_YOUR_SHARED_TOKEN_HERE`:

   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   Keep it somewhere — you need the identical string in §5.
4. Run `setupSheets()` once from the editor (pick it from the function dropdown ▸ Run) and
   accept the OAuth consent prompt. On a copied Sheet this is effectively a verification
   step: `setupSheets()` is *additive*, and `ensureTab()` only fills header cells that are
   **blank**, so your existing tabs and data are left alone. It creates anything missing.

If a copied Sheet ever needs a tab *reshaped* rather than extended, the tab must be deleted
before re-running `setupSheets()` — see [`DEPLOY.md`](DEPLOY.md) §"After a schema change".

## 4. Deploy the Web App

In the Apps Script editor: **Deploy ▸ New deployment ▸ Web app**.

- **Execute as:** Me
- **Who has access:** Anyone

Deploy, accept the consent screen, and copy the **`/exec` URL**. It looks like
`https://script.google.com/macros/s/AKfycb…/exec`.

The "Anyone" access with a single shared token is the project's deliberate, documented auth
model — see `AGENTS.md` §"Security note". Do not build anything that assumes per-user auth
exists, and keep your repo private.

## 5. Fill in your config

```
cp js/config.example.js js/config.js
```

Then edit `js/config.js`:

- `WEB_APP_URL` ← the `/exec` URL from §4.
- `SHARED_TOKEN` ← the token you generated in §3. It must **byte-match** `Code.gs:42`; a
  mismatch gives `{ok:false, error:'bad token'}` on every call.

Leave `GMAPS_API_KEY` and `ORS_API_KEY` blank for now — blank is a supported working state
(route optimization falls back to straight-line distances, which is fine for development).

`js/config.js` is **committed, not gitignored** — GitHub Pages serves the repo root as-is,
so your deployed site needs it in git. That makes it the one file that is permanently
different between your repo and anyone else's; see §13.

## 6. Your own API keys (optional)

Only needed for land-mode route optimization against real road distances.

- **Google Maps Platform** — [`DEPLOY.md`](DEPLOY.md) §"Google Maps Platform key". Follow
  it exactly, including the quota caps: the key must have **no application restriction**
  (the Geocoding web service rejects referrer-restricted keys outright), be **API-restricted
  to Geocoding + Routes**, and be **capped at 300 geocoding requests/day** so it cannot bill
  past the free tier.
- **OpenRouteService** — [`DEPLOY.md`](DEPLOY.md) §"OpenRouteService backup". Free token,
  used only as a fallback when the primary returns nothing.

Use **your own** keys. Reusing another tenant's spends their quota and puts their key in a
second place.

## 7. Your own GitHub repo and Pages site

1. Create a **new private repo** under your own account.
2. `git init` in the bundle directory, commit, and push.
3. **Settings ▸ Pages ▸ Source: Deploy from a branch**, branch `main`, folder `/ (root)`.

That is all Pages needs. There is no build step, `.nojekyll` is already present, every
asset path in the HTML is relative, and there is no `CNAME` — so the app works unchanged
under your account name and repo name, at whatever subpath Pages gives you.

Note what this means: **pushing to `main` is a production deploy** on your instance. That
is the project's normal deploy model (`AGENTS.md` §"Standing workflow rules"), and it is
why the tests get run before a push.

## 8. CI deploy of `Code.gs` (optional)

`.github/workflows/deploy-appsscript.yml` pushes `Code.gs` to Apps Script and redeploys the
existing deployment in place, so the `/exec` URL never changes. To enable it on your repo:

1. Replace `DEPLOYMENT_ID` at line 31 with the segment between `/s/` and `/exec` in **your**
   `/exec` URL.
2. Add repo secrets `SCRIPT_ID` and `CLASPRC_JSON` — how to obtain both is in
   [`DEPLOY.md`](DEPLOY.md) §"One-time setup".

Skipping this is fine. The manual path — paste `Code.gs` into the editor, then
**Deploy ▸ Manage deployments ▸ edit ▸ New version** — works and is what you will use
while iterating anyway.

## 9. Time-driven triggers (optional)

Run these once from the Apps Script editor if you need what they do:

- `createAvgDispatchTrigger()` — hourly, refreshes the `Metrics` average dispatch time.

- `createDailyExportTrigger()` — nightly Sheet→Markdown export into `data/*.md`.
  **Do not install this until Script Properties `GITHUB_REPO` and `GITHUB_TOKEN` point at
  your own repo** (Project Settings ▸ Script Properties). It commits to `main` through the
  Git Data API. It cannot reach the original repo — you have no PAT for it — but set the
  properties deliberately rather than relying on that.

Neither trigger is needed for development.

## 10. Verify it works

```
node --test "tests/*.test.mjs"
```

No install needed — the suite is plain Node over the pure modules plus doc/schema
assertions, and it touches neither the network nor the Sheet. The quoted glob matters.

Then serve the repo root over HTTP and drive it — the recipe, including the inline
`serve.mjs` (port 8731), is in [`VERIFY.md`](VERIFY.md) §2. A `file://` open breaks the
service worker, the ES-module imports, and the fetches.

**The payoff of your own tenant:** `VERIFY.md` §4 says *"never click Save / Close / log
buttons against the real spine"*. **On your instance that restriction does not apply.** You
can log stops, close days, run end-of-day, and save teams against your own Sheet as much as
you like — that is the entire reason for setting this up. The CDP request-interception
recipe (`VERIFY.md` §3) is still useful for forcing specific UI states without generating
data, but it is no longer a safety requirement.

One gotcha that will waste your afternoon otherwise: **`sw.js` caches the app shell**, so a
browser profile that loaded a page earlier keeps serving the old JS and CSS. Unregister the
service worker and clear `caches` before concluding a change did nothing — `VERIFY.md` §5.

## 11. Local OSRM + Nominatim (only for `planner.html`)

The desktop route planner wants a local OSRM server for road-distance matrices and a local
Nominatim for geocoding, both free and offline. Setup:
[`DEPLOY.md`](DEPLOY.md) §"Desktop planner + local OSRM" and §"Local geocoding — Nominatim".

`scripts/export-geo-bundle.ps1` and `scripts/setup-geo-on-new-pc.ps1` carry hardcoded
`D:\osrm` / `C:\osrm` paths from the original machine — adjust them for yours. Defaults are
`http://localhost:5000` (OSRM) and `http://localhost:8080` (Nominatim), overridable in the
planner's own settings and stored per-browser.

The other six pages do not need any of this.

## 12. Confirm you are isolated

Do all four. This is the check the whole document exists for.

1. **No foreign credentials in the tree.** From the repo root:

   ```
   grep -rn 'AKfycb\|AIza\|eyJvcmci' --exclude-dir=.git --exclude-dir=vendor .
   ```

   Every hit must be a value **you** created in §4 or §6. Anything else means a credential
   came across in the bundle — stop and report it.

2. **No history came across.** `git log` shows only your own commits, starting from your
   initial one.

3. **A write lands in your Sheet.** Log a test stop from `index.html`, then confirm the row
   appears in **your** copy's `Stops` tab.

4. **Network traffic goes only to your deployment.** With DevTools ▸ Network open, use the
   app and confirm every `script.google.com` request carries **your** deployment id. This is
   the one that catches a half-finished config.

## 13. Working alongside the original repo

Your **runtime** is fully isolated — own Sheet, own deployment, own keys, own Pages site.
Your **code** is meant to flow back. Three files are permanently different between the two
repos and must never travel in a patch:

| File | Why it differs |
|---|---|
| `js/config.js` | your `/exec` URL, token, and API keys |
| `Code.gs` line 42 | your `SHARED_TOKEN` |
| `.github/workflows/deploy-appsscript.yml` line 31 | your `DEPLOYMENT_ID` |

The practical mechanism for the first one, which is the only one you will edit often:

```
git update-index --skip-worktree js/config.js
```

Your local edits then stop appearing in `git status` and cannot be committed by reflex. To
temporarily undo it (e.g. to change the file intentionally), use `--no-skip-worktree`.

For the other two, just check your diff before pushing — they change rarely.

**How work comes back:** you will be invited as a collaborator on the original repo with
`main` protected. Push a feature branch there and open a PR. Your runtime stays isolated;
only code review is shared. Before any push, run `node --test "tests/*.test.mjs"` — on the
original repo a merge to `main` deploys to a working crew.

Anything durable you learn — a workflow rule, a landmine in the data, a decision and its
reasoning — belongs in `AGENTS.md`, `ARCHITECTURE.md`, or `VERIFY.md`, not in your editor's
private memory. Several different LLM agents also work on this codebase and they can only
see what is in the repo. See `AGENTS.md` §"Working in this repo".
