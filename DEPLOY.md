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

The 🧭 Optimize route feature (`js/route.js`) forward-geocodes worklist
addresses with the **Google Geocoding API**, called straight from the phone
with the key in `js/config.js` (`GMAPS_API_KEY`). Everything else in the
pipeline (the distance matrix and the TSP solve) runs locally and costs
nothing — geocoding is the **only** billable call, it's made once per new
order (pins are cached on the order), and the setup below makes it impossible
to exceed the 10,000-calls/month free tier.

1. **Create a project** at [console.cloud.google.com](https://console.cloud.google.com)
   (e.g. `meter-log`) — use the same Google account that owns the Sheet.
2. **Enable billing** on the project (Google requires a card on file even for
   free-tier use; the steps below guarantee it's never charged).
3. **APIs & Services ▸ Library** — enable the **Geocoding API**. Enable
   *nothing else* (no Maps JavaScript, Places, or Routes API): an API that
   isn't enabled can't bill.
4. **APIs & Services ▸ Credentials ▸ Create credentials ▸ API key**, then
   click the new key and restrict it:
   - **Application restrictions ▸ Websites** — add the GitHub Pages origin
     (`https://<owner>.github.io/*`) and `http://localhost:8731/*` (local dev).
   - **API restrictions ▸ Restrict key** — tick only **Geocoding API**.
5. **Cap the quota (this is what guarantees $0):** APIs & Services ▸
   Geocoding API ▸ **Quotas & System Limits** — edit *Requests per day* down to
   **300** (300 × 31 = 9,300 < the 10,000 free calls/month). Past the cap,
   lookups return `OVER_QUERY_LIMIT`; the app treats that as a miss, the order
   parks with 📍?, and re-optimizing the next day picks it up — degraded, never
   billed.
6. **Billing ▸ Budgets & alerts** — create a **$1 budget** with an email alert
   as a belt-and-suspenders tripwire. If that email ever arrives, something
   about the setup above has drifted.
7. Paste the key into `js/config.js` as `GMAPS_API_KEY` and push.

If usage grows (more installers planning daily), raise the daily cap in step 5
and expect ~US$5 per extra 1,000 geocodes past the free 10k — cost scales with
*new orders added*, never with re-optimizing already-pinned lists.

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
