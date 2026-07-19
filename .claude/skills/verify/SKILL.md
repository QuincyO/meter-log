---
name: verify
description: Build/launch/drive recipe for verifying meter-log changes end-to-end (static pages + live Apps Script spine)
---

# Verifying meter-log changes

No build step. The surface is the five static pages served over HTTP, talking
to the **live production** Apps Script spine (URL + token in `js/config.js`).

## Launch

`python` on this machine is the Windows Store stub — it exits 49. Use a node
one-liner static server instead (or fix python). A working server script from a
past session: serve repo root on **:8731** with correct `Content-Type` for
`.html/.js/.css` (ES modules refuse to load as `application/octet-stream`).

## Drive (headless Edge + CDP)

No Playwright installed. Headless Edge works:

- Quick smoke (post-JS DOM): `"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  --headless=new --disable-gpu --user-data-dir=<tmp> --virtual-time-budget=20000
  --dump-dom http://localhost:8731/<page>.html` — the budget lets the module +
  spine fetches finish. NOTE: the msedge process lingers after the dump; run it
  with a timeout/background and kill `msedge.exe` procs whose command line
  matches your temp profile when done.
- Full drive: launch Edge with `--remote-debugging-port=9333 --headless=new
  --user-data-dir=<fresh tmp>`, then a node script using the global `WebSocket`
  (node ≥22) against `/json/new?<url>` + `Runtime.evaluate` to click/fill/read
  DOM, `Page.captureScreenshot` for evidence.

## Safety — production data!

- GET actions (`roster`, `pins`, `tracker`, `day`, …) are read-only → safe.
- **Never click Save/Close/log buttons against the real spine** — they write to
  the production Sheet (e.g. Close day posts `endOfDay`, Settings Save enqueues
  `saveEmployee`). To exercise a write path, use CDP `Fetch.enable` on
  `*script.google.com*` + `*googleusercontent.com*` (GETs 302-redirect to the
  latter) and `Fetch.fulfillRequest` a fake `{ok:true,...}` for the POST; also
  stub reads (e.g. `action=tracker` → empty) to force UI states like "open day".
- A fresh Edge profile has empty localStorage → index.html auto-opens the
  settings sheet after ~400ms; seed `localStorage` (`name`, `hNumber`) via
  `Runtime.evaluate` to simulate a configured installer.

## Gotchas

- Spine changes in `Code.gs` are NOT live until pushed (CI deploys) — new GET
  actions 404/err against prod during verification; check the frontend degrades.
- Find dates with data via `action=pins&from=&to=` before driving date pickers.
- `status:"DONE"` stops never render anywhere — a day with only DONE markers
  legitimately shows empty.
