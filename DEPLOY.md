# Deploying

Two independent deploys, both triggered by pushing to `main`:

| What | How | Trigger |
|------|-----|---------|
| The three HTML pages (`index/map/teams`) | GitHub Pages serves the repo root | every push to `main` (nothing to build) |
| `Code.gs` (the Apps Script Web App) | `.github/workflows/deploy-appsscript.yml` via `clasp` | pushes to `main` that change `Code.gs` or `appsscript.json` |

The Apps Script workflow runs `clasp push` then **redeploys the existing
deployment in place** (`clasp deploy -i <deploymentId>`). That bumps the version
but keeps the same `/exec` URL the HTML pages are hard-coded against. It never
creates a *new* deployment (that would change the URL and break the frontend).

You can still deploy by hand at any time — paste `Code.gs` into the editor and
redeploy — the Action just automates it.

## One-time setup (do this once)

### 1. Add two GitHub repo secrets

Settings ▸ Secrets and variables ▸ Actions ▸ **New repository secret**:

- **`SCRIPT_ID`** — the Apps Script *project* ID. In the script editor open
  **Project Settings** (gear icon) ▸ "IDs", or copy it from the editor URL:
  `https://script.google.com/.../projects/`**`<SCRIPT_ID>`**`/edit`.
- **`CLASPRC_JSON`** — your clasp login credentials. Generate locally:

  ```bash
  npm install -g @google/clasp@2.4.2
  clasp login
  ```

  Then paste the **entire contents** of the file it created:
  - Windows: `C:\Users\Quincy\.clasprc.json`
  - macOS/Linux: `~/.clasprc.json`

  (This holds an OAuth refresh token for the Google account that owns the Sheet
  + script. Treat it like a password — it only lives in the GitHub secret.)

The deployment ID is **not** a secret — it is already public in the client HTML
(the segment between `/s/` and `/exec`) and is set as `DEPLOYMENT_ID` directly in
the workflow.

### 2. (Recommended) Replace `appsscript.json` with the real one

`appsscript.json` in this repo is a sensible default. To guarantee CI doesn't
drift from the project's actual manifest (timezone, web-app access, OAuth
scopes), pull the real one once — **clone into a throwaway folder so it can't
clobber your local `Code.gs`:**

```bash
clasp clone <SCRIPT_ID> --rootDir /tmp/gas
cp /tmp/gas/appsscript.json ./appsscript.json
git add appsscript.json && git commit -m "Use the project's real Apps Script manifest"
```

## Google Maps Platform key (one-time setup)

The 🧭 Optimize route feature (`js/route.js`) makes two kinds of Google Maps
Platform calls straight from the phone with the key in `js/config.js`
(`GMAPS_API_KEY`):

- **Geocoding API** — one forward geocode per *new* order (pins are cached on
  the order). Free tier: 10,000 calls/month.
- **Routes API `computeRouteMatrix`** — the road-distance matrix each optimize
  run solves on, billed per **element** (origins × destinations: a 25-stop day
  with a home pin ≈ 26² = 676 elements per run). Free tier: 10,000
  elements/month. When the matrix can't be fetched (offline, quota, budget
  spent) the solve falls back to straight-line distances and the toast says so
  — the route is still good, just blind to rivers/detours.

Setup, with the guardrails that keep it at $0:

1. **Create a project** at [console.cloud.google.com](https://console.cloud.google.com)
   (e.g. `meter-log`) — use the same Google account that owns the Sheet.
2. **Enable billing** on the project (Google requires a card on file even for
   free-tier use; the steps below guarantee it's never charged).
3. **APIs & Services ▸ Library** — enable the **Geocoding API** and the
   **Routes API**. Enable *nothing else* (no Maps JavaScript or Places): an
   API that isn't enabled can't bill.
4. **APIs & Services ▸ Credentials ▸ Create credentials ▸ API key**, then
   click the new key and restrict it:
   - **Application restrictions — leave on "None".** Counter-intuitive but
     load-bearing: the Geocoding **web service** endpoint the app calls
     categorically rejects referrer-restricted keys — every lookup returns
     `REQUEST_DENIED — API keys with referer restrictions cannot be used with
     this API`, no matter what referrer is sent — so a Websites restriction
     bricks all geocoding (the Routes API would accept it; the geocoder
     won't). The API restriction below plus the quota caps are what actually
     bound the spend. (The stricter alternative is two keys — a
     website-restricted one for Routes and an unrestricted one for Geocoding —
     but with both APIs capped it buys little.)
   - **API restrictions ▸ Restrict key** — tick only **Geocoding API** and
     **Routes API**.
5. **Cap the geocoding quota:** APIs & Services ▸ Geocoding API ▸
   **Quotas & System Limits** — edit *Requests per day* down to **300**
   (300 × 31 = 9,300 < the 10,000 free calls/month). Past the cap, lookups
   return `OVER_QUERY_LIMIT`; the app treats that as a miss, the order parks
   with 📍?, and re-optimizing the next day picks it up — degraded, never
   billed.
6. **The matrix budget lives in the app**, not the console (the Routes API has
   no daily element cap to set): `MATRIX_FREE_ELEMENTS` in `js/route.js`
   (9,000) is each device's monthly element allowance, tracked in
   localStorage; a run that would exceed it solves on straight-line instead.
   **This is per device** — if several installers optimize daily on one
   billing account, lower the constant to (10,000 ÷ devices) or accept that
   heavy months bill ~US$5 per extra 1,000 elements.
7. **Billing ▸ Budgets & alerts** — create a **$1 budget** with an email alert
   as a belt-and-suspenders tripwire (with several devices this, not the
   client budget, is the real account-wide guard).
8. Paste the key into `js/config.js` as `GMAPS_API_KEY` and push.

Costs scale with *new orders* (geocoding) and *optimize runs* (matrix
elements) — re-optimizing an already-pinned list re-bills only the matrix,
never the geocodes.

If every optimize run still ends in a straight-line toast after the key is in
place, see "the optimize toast says straight-line" under Troubleshooting — the
toast names the concrete cause.

## Desktop planner + local OSRM (one-time setup)

`planner.html` is the office-side planning app: pick an installer, load/paste
their orders, optimize, review the numbered route on the map, ⇪ Upload — the
installer then just taps ⇩ Download on the phone and drives the finished
route. Its road distances come from **OSRM running on your own PC** — free and
unmetered — so the only Google spend from planning is one geocode per *new*
address (pins upload with the list and are never re-billed). If OSRM is down
the planner still works, it just solves on straight-line distances and says
so in the toast — it never silently falls into the billable Google matrix.

Install the planner as a Windows app: open `planner.html` on the deployed
site in Chrome/Edge ▸ ⋮ menu ▸ **Cast, save and share ▸ Install page as
app** (or *More tools ▸ Create shortcut… ▸ Open as window*) — own window,
Start-menu icon, auto-updates on every push.

Set up OSRM once (Windows, ~20 minutes, mostly download time):

1. Install **Docker Desktop** (WSL2 backend, the default).
2. Make a data folder (e.g. `C:\osrm`) and download the Ontario road network
   into it: <https://download.geofabrik.de/north-america/canada/ontario-latest.osm.pbf>
   (~1.5 GB; re-download every few months if you want new roads).
3. Preprocess it (one-time per download; a few minutes on a fast machine):

   ```powershell
   cd C:\osrm
   docker run -t -v ${PWD}:/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/ontario-latest.osm.pbf
   docker run -t -v ${PWD}:/data osrm/osrm-backend osrm-contract /data/ontario-latest.osrm
   ```

4. Serve it (survives reboots via `--restart`):

   ```powershell
   docker run -d --restart unless-stopped -p 5000:5000 -v ${PWD}:/data osrm/osrm-backend osrm-routed --algorithm ch --max-table-size 1000 /data/ontario-latest.osrm
   ```

5. Smoke test — should print a `distances` matrix:

   ```powershell
   curl "http://localhost:5000/table/v1/driving/-79.37,45.05;-79.31,45.11?annotations=distance"
   ```

The planner's OSRM field defaults to `http://localhost:5000` (Chrome/Edge
allow an HTTPS page to call localhost, so no TLS setup is needed). If the
browser console ever shows a CORS error from OSRM, front it with a one-line
proxy (e.g. Caddy: `caddy reverse-proxy --from :5001 --to :5000` plus a CORS
header) — recent osrm-backend builds send `Access-Control-Allow-Origin: *`
out of the box, so this is unlikely.

The planner's geocoding uses the same `GMAPS_API_KEY` — same key, same
restrictions (API-restricted, no application restriction — see §"Google Maps
Platform key"), nothing to change.

## After a schema change

When tabs/columns change you still need to run `setupSheets()` once from the
editor (see CLAUDE.md). The Action only pushes code + redeploys; it does not run
functions.

## Troubleshooting

- **Workflow fails at "Write clasp auth"** — a secret is missing/empty.
- **`clasp push` fails with an auth error** — the `CLASPRC_JSON` token expired;
  re-run `clasp login` locally and update the secret.
- **The `/exec` URL changed** — someone created a new deployment instead of
  redeploying. Put the old deployment's ID back, or update `DEPLOYMENT_ID` in the
  workflow **and** `WEB_APP_URL` in all three HTML files to match.
- **The optimize toast says "straight-line (…)" or "lookups failed: …" even
  though the key is set** — the toast names the cause; the full Google
  response is in the browser console (`console.warn`).
  - `REQUEST_DENIED` on lookups, and the console says *"API keys with referer
    restrictions cannot be used with this API"*: the key has a **Websites**
    application restriction, which the Geocoding web service categorically
    rejects (every address lookup fails, all orders park). Fix: key ▸
    **Application restrictions ▸ None** — the API restriction + quota caps
    are the guard (see §"Google Maps Platform key" step 4).
  - `REQUEST_DENIED` / `PERMISSION_DENIED` otherwise: check that **both** the
    Geocoding API *and* the Routes API are enabled on the key's project
    **and** ticked in the key's **API restrictions**. A key with only
    Geocoding enabled geocodes fine but every matrix call is rejected —
    permanent straight-line routes that look like the key "isn't helping".
  - `OVER_QUERY_LIMIT` / `monthly road-data budget spent`: the $0 guardrails
    (daily geocode cap, `MATRIX_FREE_ELEMENTS`) working as designed — routes
    go straight-line until the quota/month resets.
  - `network error` / `offline`: no path to Google at all (signal, firewall).
  - No straight-line note at all, just "N parked": geocoding failed before
    routing ever started — with fewer than two pinned orders there is no
    route to solve, straight-line or otherwise. Fix the lookups first.

## Hourly dispatch-average refresh (one-time setup)

`avgDispatchTime()` (the global dispatch request↔install match + the `Metrics`
average) no longer runs inside `endOfDay` — with the whole crew closing at
quitting time it was the longest hold on the write lock. It now runs from an
hourly time trigger:

- **Install the trigger:** in the editor, run `createAvgDispatchTrigger()` once.
  Safe to re-run (it de-dupes its own trigger). Without it, matched `Dispatch`
  rows and the `Metrics` average simply stop refreshing — same-day dispatch
  suggestions at end-of-day still work (they're computed live from raw
  `Dispatch` rows), but the map's "avg dispatch downtime" tile and the
  cross-day/fallback estimates go stale.

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
