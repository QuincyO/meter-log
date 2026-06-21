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
