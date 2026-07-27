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
| [2026-07-27](changelog/2026-07-27.md) | Route map keeps its road lines all day; the Optimize press picks the matrix ladder; a raised meters/day target can unfreeze Day 1; on-site time is measured per stop instead of guessed; the phone can plan a route for a day that isn't today |
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
