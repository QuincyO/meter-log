# meter-log

Field data-capture app for a hydro meter installer crew — offline-first stop logging, downtime, worklists, and an on-device daily-log PDF, backed by a Google Sheet via one Apps Script.

- **Using the app** → [USER-GUIDE.md](USER-GUIDE.md) (also rendered in-app at `help.html` — ☰ → ❓ Help on the phone, or the Help entry in the office pages' nav dropdown; works offline).
- **How it's built** → [ARCHITECTURE.md](ARCHITECTURE.md) (design doc) and [CLAUDE.md](CLAUDE.md) (working notes). Deploy steps live in [DEPLOY.md](DEPLOY.md).
- **Setting up your own isolated copy** → [ONBOARDING.md](ONBOARDING.md) — for a second developer standing up their own Sheet, Apps Script deployment and Pages site, so their work can't touch the live one. Build the handoff bundle with `node scripts/make-handoff.mjs --out <dir>`.
