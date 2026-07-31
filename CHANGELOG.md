---
title: CHANGELOG
type: index
aliases: [Changelog, Change Log]
tags: [changelog, project/meter-log]
created: 2026-07-26
---

# Changelog

What shipped, newest first — one line per day, each linking to that day's page in
[`changelog/`](changelog/). `AGENTS.md` and `ARCHITECTURE.md` describe how the app works
*now*; this records how it got that way, and the bug or the reasoning behind each change,
which a diff alone doesn't carry.

**Dates, not version numbers.** There is no release process: GitHub Pages serves the repo
root and CI deploys `Code.gs`, both from `main`, so a merge to `main` *is* the release.

**Adding an entry?** Write the day page and add its row here, in the same commit as the
change — see `AGENTS.md` §"Standing workflow rules". The automated
`Nightly sheet export — <date>` commits are the spine writing its own Sheet snapshot back to
the repo, and are not listed.

> In Obsidian: `Ctrl+O` and type a date to jump straight to a day, or open a row below.
> The vault root is the repo root, so every page here is a real note.

## 2026-07

| Day                                   | What shipped                                                       |
| ------------------------------------- | ------------------------------------------------------------------ |
| [2026-07-31](changelog/2026-07-31.md) | **A 🔓/🔒 toggle: the day is settled when the installer says it is** — this was the fourth change in a week to "which orders are on today", so the mechanism that kept needing fixing was the *inferring*, not any of the inferences; unlocked, the meters/day target and the plan date are live and 🧭 Optimize re-plans every day at whatever number is in the box, and locked, day 1 is frozen exactly as it stands and nothing moves work in or out of it — not a logged stop, not a Download, not another Optimize — until it's unlocked by hand, with an added order raising the same *Add to today / Leave for later* question and slotting in without pushing anything off the end. `needsCommit`, `dayCapacity`, `opts.max`/`opts.fromTags`/`opts.replan`/`opts.resize` and the whole `freeReplan`/`midReplan`/`exhausted` triangle are deleted; the press is the only commit there is. The lock is **one date** (locked iff it equals the plan day), so a new day releases it with nothing to expire. **Unlocked is deliberately not "no `day1Count`"** — `applyTodayAnchor` also runs after every logged stop, on the Drive screen's 5-minute refresh, on Download and at boot, and re-chunking there would refill day 1 from the front of pending for anyone who simply hadn't pressed 🔒, which is yesterday's bug back on a timer; there are three answers, and only the meters/day box asks for the re-chunk. The variant switch and the drag write-back carry the count too, or the lock leaked through both. The office gets the same toggle on the planner, synced by one appended `WorklistPlans.dayLockDate` column whose blank is a **real value** (so the spine guards on key presence, not truthiness, or unlocking from the phone would never reach the sheet). **And the road-distance button stops answering with the whole week** — two orders 2 km apart with the tile reading 241 km, which was correct arithmetic over a four-day plan with one far-off order at the bottom of the list, summed into the figure a crew reads as today's driving; nothing was double-counting a commute (a day's first stop has always been charged 0 and the drive out lives in `homeLegMeters*`, which no total reads), the headline was simply unscoped. The phone's tiles and counts line price **day 1** now, and the counts line takes its metres from `liveDayMeters` — the same live `day` field the day dividers bucket on — so the headline and Day 1's divider are the same number *by construction* rather than two sums that happen to agree; the tiles bucket on each variant's own saved day, so road-vs-straight stays a like-for-like choice. The office keeps the whole plan and now says so (`241 km (road) · 4 days`), and the phone gains a caption carrying what its tiles leave out, because there is nothing to hover on a phone. Two comments that described the opposite of their code are fixed with it — including the day divider's own tooltip, which told the installer the drive out was in the number beside it |
| [2026-07-30](changelog/2026-07-30.md) | **The work list you download at the start of the day stays the day you committed to** — the meters/day target sized Day 1 live against the meters actually installed, and since the target counts meters while the list counts orders, a two-meter order or a walk-up pushed the tail of a committed day out to tomorrow by mid-morning (and a *met* target pushed the whole remainder out, taking the pace card off the screen with it), while a finished day rolled tomorrow's chunk up into today by itself, all of it re-run every 5 minutes by the new auto-refresh; Day 1 is the committed set entire now, the target sizes the day when the day is *planned* and then lets go, and work joins a day already under way only by hand — 🧭 Optimize, the Add-to-today sheet (which loses its tail-rolling middle option and now works on a cleared day), or the office's own Day 1 on a Download; installing extra reads as "· 4 over your 24" with a later *Route done ~* instead of as a shorter list. **And** the Drive screen's "Route done ~" clock stops reading as a time that has already passed — it was a bare 12-hour label on a number with no ceiling, so a real 11:29 **at night** printed as `11:29` on a card being read at 11:36 in the morning, and it carries am/pm now (plus a day marker past midnight); the day's on-site pace is the **median** of its gaps instead of the mean, so one long hold-up costs a single gap rather than wrecking every projection until midnight, and any delay the crew did log is netted out instead of being counted as time spent installing; and a day-average "moving speed" dragged under 25 km/h by on-foot minutes at the meter no longer prices the remaining route, which had been charging the afternoon 2¼ hours of driving for 45 minutes of road |
| [2026-07-29](changelog/2026-07-29.md) | The phone's 🧭 Optimize tap now requires the district to be downloaded — no more silent straight-line routes that look solved and ignore every river and dead end — with the button greyed and the reason printed before anyone presses it; the two-second network hold stays exempt as the only second opinion an on-device route has, and the desktop planner is untouched. **And a duplicate J number now warns instead of discarding the stop** — logging a New or Old J# already on one of your own stops from the past week blocks the tap with a card naming the order it's on, offering *Go back and fix it* or *Log it anyway*, checked on-device (so it works offline) and again on the spine; the old path returned before `appendRow` and told the installer "Entry discarded", which destroyed real field work. **And the Drive screen now refreshes itself from the sheet every 5 minutes** — gated on drive tracking being armed, the *Show driving stats* opt-in, and being on that screen — pulling the list and today's stops and then re-anchoring, which is the part that actually re-times the route; a timer never toasts, never confirms, never touches the capture form, and never resurrects an order already logged on this phone |
| [2026-07-28](changelog/2026-07-28.md) | The drive-mode pace is measured against the meters/day target instead of a day that was already shrunk to fit, so it can report being behind again; a phone the crew only drives by finds out what the logging phone has done; and a route re-optimized at noon departs on the clock the crew is actually on, with the remaining ETAs re-timed from the last completed stop after every meter; the Drive screen drops the near-duplicate Target gauge and its one remaining card now says what time the route itself is done; and the gauge goes back to measuring the route rather than the target — with the arithmetic showing why the morning's reasoning for the swap was wrong, and the day-2 chunk it was quietly pacing once the target was met |
| [2026-07-27](changelog/2026-07-27.md) | Route map keeps its road lines all day; the Optimize press picks the matrix ladder; a raised meters/day target can unfreeze Day 1; on-site time is measured per stop instead of guessed; the phone can plan a route for a day that isn't today, and a stale lock stops taking the whole route down with it; Finish By is scrapped so meters/day alone sizes a day; the Optimize sheet stops claiming straight-line over a road-routed run; a typed meters/day survives without blurring the box, and changing it re-splits the days on the spot instead of waiting for an Optimize; the day divider's length is read back from the route's own ETAs instead of a historical cadence plus an hour; the measured on-site block stops being stored as a 1900 date, which is why no phone had ever used it; an appointment is placed against the day the route will really drive instead of a placeholder one, arriving early and waiting always beats arriving late, and an ETA left over from a rejected route now says so |
| [2026-07-26](changelog/2026-07-26.md) | Offline road maps, offline geocoding, districts drawn on the planner; graphify wiring; district builds fixed, with a progress bar; districts you can remove, grow and hold several of; turn-by-turn off the offline pack |
| [2026-07-25](changelog/2026-07-25.md) | Walk-up meters count toward the day; start-location popup          |
| [2026-07-24](changelog/2026-07-24.md) | Route tuning dials, real ETAs, the drive HUD, four field bugs      |
| [2026-07-23](changelog/2026-07-23.md) | Drive mode, two route variants, one instruction set for all agents |
| [2026-07-22](changelog/2026-07-22.md) | Optimize turned on for everyone; per-installer metrics             |
| [2026-07-21](changelog/2026-07-21.md) | Google Routes + ORS road matrices; the desktop planner             |
| [2026-07-20](changelog/2026-07-20.md) | Route optimization arrives; worklist sync; a long bug-fixing day   |
| [2026-07-19](changelog/2026-07-19.md) | Sub-foremen and a per-sub reports page                             |
| [2026-07-18](changelog/2026-07-18.md) | Land-work mode; removing a stop became archive-before-delete       |
| 2026-07-04 → 07-17                    | *Quiet fortnight — nightly Sheet export only*                      |
| [2026-07-03](changelog/2026-07-03.md) | A performance pass for scale: caching, locks, date windows         |
| 2026-06-30 → 07-02                    | *Nightly Sheet export only*                                        |

## 2026-06

| Day | What shipped |
|---|---|
| [2026-06-29](changelog/2026-06-29.md) | Accuracy-driven GPS; instant end-of-day PDF |
| [2026-06-28](changelog/2026-06-28.md) | Timestamps stop lying; the PDF moves to the phone |
| [2026-06-27](changelog/2026-06-27.md) | Dispatch dedup; a steadier GPS fix |
| [2026-06-26](changelog/2026-06-26.md) | The app is modularized into shared ES modules |
| [2026-06-25](changelog/2026-06-25.md) | Storage-first: a stop survives before it's sent |
| [2026-06-24](changelog/2026-06-24.md) | Offline cache, and the first worklist |
| [2026-06-23](changelog/2026-06-23.md) | Travel time becomes per-installer |
| [2026-06-22](changelog/2026-06-22.md) | Log types, downtime, and the back-office editor |
| [2026-06-21](changelog/2026-06-21.md) | Teams take shape; CI starts deploying the spine |
| [2026-06-20](changelog/2026-06-20.md) | The spine, the map, the service worker |
| [2026-06-19](changelog/2026-06-19.md) | Shaping the capture form |
| [2026-06-18](changelog/2026-06-18.md) | Initial commit |
