# Audits page — design

Date: 2026-11-19. Status: awaiting the owner's approval. Nothing is built yet.

## Why

The owner had a performance review about delays. A one-off PDF, "Land work time analysis",
was made from an export of the sheet. It showed where an average day goes, how much time
between meters is neither work nor a logged delay, and how the logged delays break down. He
found it useful and wants the same information in the app, for every installer, plus a view
of a single day.

The page is read-only. It changes nothing on the sheet.

## Who uses it

- **The office (the owner).** Opens Audits from the "Go to view" dropdown on the office
  pages, behind the office password. Picks one installer at a time.
- **An installer.** Opens "My audit" from the ☰ menu on the log page and sees their own
  figures, worked out the same way, quality flags included. The only difference from the
  office view is that it has no drive-log overlay and no speed numbers.

## Goals

1. Everything in the PDF has a place on the page (list below). Nothing is left out.
2. A single-day view: timeline, totals, delays, comparison with usual, and a map of the route
   worked.
3. Over the same data and period, the page lands on the PDF's numbers.
4. Any audit, period or day, prints cleanly (print or save as PDF from the browser).

## Not in scope

- Comparing installers side by side, or ranking them.
- Flags for missing pins, missing close-outs or breaks never logged. The only flag is a long
  gap with nothing logged against it.
- Flagging speed. Drive-log speeds are shown as numbers only.
- Any write to the sheet, any new stored column, or any change to the pause figure the spine
  already stores on `InstallerMetrics`.
- Per-installer sign-in. It does not exist and this does not add it.

## What would make it a failure even if it works

- Personal performance figures committed to the repo. GitHub Pages publishes the whole tree.
  Tests use made-up fixtures; the check against the PDF's figures is run from outside the
  repo and its numbers are never committed.
- Wording that judges. An unlogged pause is "unlogged pause time, breaks included". The data
  cannot tell a break from an unlogged delay, and the page must not pretend it can.
- The words "drive back" or "return to the yard" anywhere. The crew goes home from the field.
- Anything that breaks a phone on old cached files: a `sw.js` change, a new id bound without
  a guard, or a capture-side action put behind the office password.

## The owner's rules (they apply to every installer)

1. The shift starts at **07:30**, always.
2. The day ends at the time set at close-out (`Days.returned`: normally 16:00, 17:00 for
   overtime). **When the last meter is logged after that time, the day runs to the last
   meter**, "close-out and drive home" shows 0, and the day is marked "worked past the set
   end time".
3. Dispatch logged **before the first meter** is shown as its own block, "drive to the first
   order". The owner's wording was "usually", so the label names what was logged (dispatch
   before the first meter) and does not claim more. Dispatch logged between meters is an
   ordinary delay.
4. The time after the last meter is labelled **"close-out and drive home"**.
5. The break allowance is **60 minutes a day** (two 15-minute breaks and a 30-minute lunch,
   taken whenever, almost never logged). It is the line unlogged pause time is compared with.
6. Downtime is being held up while working; breaks and lunch are personal time. Logged delays
   do not contain breaks.
7. Per-day statistics use only days with **8 or more orders**. Shorter days still appear in
   the day-by-day table and can be opened, marked as left out of the statistics.
8. A single gap is flagged when its unlogged pause is **45 minutes or more**.
9. **Land by default, with a Land / Boat / All switch.** Boat and All show the full audit,
   worked out the same way, under a clear note that the pause figures were only checked
   against land work.
10. With no day picked the page shows **all work to date** in the chosen mode, with a date
    range picker.
11. A picked day is compared with two baselines: the installer's **30 worked days before that
    day**, and **all their work to date** in the chosen mode.

## The two views

The owner approved this layout from a mockup on 2026-11-19.

### Period view (opens first)

Controls: installer picker (office only), Land / Boat / All, from and to dates, "Pick a day",
Print. Then, in this order:

1. **Headline** — four numbers: orders and working days; orders a day with the best day;
   unlogged pause on a typical (median) day; delay logged per day with the share before the
   first meter.
2. **Where an average day goes** — one stacked bar from the start to the end time, markers at
   shift start, first meter, last meter and end. Segments in order: logged delays before the
   first meter other than dispatch; drive to the first order; before the first meter and not
   logged (this includes the first installation, because a log is written when the job is
   finished); working; unlogged pauses (breaks included); pause time that was logged as a
   delay; close-out and drive home. It uses averages so the parts add up to the day; a
   caption says the text elsewhere uses medians, which run a little lower.
3. **Unlogged pause time per day** — histogram of days in bins 0–15, 15–30, 30–45, 45–60,
   60–75, 75–90, 90–105, 105–120, 120–150, 150+, with a marker at the 60-minute allowance.
   Beside it: median, average, middle half of days, lowest and highest tenth, pauses per day,
   the typical longest pause and when it starts, the same measure before logged delays are
   taken off, and the count of long gaps (45+ minutes, nothing logged) and the days they
   fell on.
4. **By month** — days, orders a day, first meter, last meter, minutes per order (first to
   last meter over the orders after the first, so pauses are in it), unlogged pause (median),
   logged delay (average).
5. **Logged delays by category** — total minutes, share of all logged delay, days logged,
   share before the first meter, share between meters. Travel, break and lunch entries are
   left out. Then per day: before the first meter (split into dispatch and all other),
   between meters, logged without a time of day, total. Category totals cover every day in
   the period, short days included, as in the PDF.
6. **Output** — orders a day (average, median, slowest tenth, best tenth, best day), first
   meter (average and middle half), last meter, first-to-last span, minutes per order, and
   orders by status (installed, unable to install, other visits).
7. **Day by day** — one row per day: date, orders, first meter, last meter, delay logged
   before the first meter, delay logged between meters, unlogged pause, longest pause and
   when it started, and a tag when the day has a long gap. A row opens that day.
8. **Method and limits** — closed until opened (open in print). See "Method" and "Limits".

### Day view (a picked day, or a row from the table)

Controls: back to the period, previous and next worked day, Print. Then:

1. **Timeline** — the day from the start to the end time. Before the first meter it is split
   the same three ways as the average-day bar, from that day's own logged delays. Then one
   block per gap between logs: work, and where the gap ran long, its logged-delay part and its
   unlogged-pause part. Then close-out and drive home. A flagged gap carries a tag. A block
   opens its detail: the two orders, the straight-line distance, the usual time for that
   distance, the overrun, and what was logged against it.
2. **This day, and how it compares** — orders, first meter, last meter, delay logged before
   the first meter, delay logged between meters, unlogged pause, longest pause and when it
   started; one column for the day and one for each baseline.
3. **Delays logged this day** — category, minutes, and the gap each was logged against.
   Dispatch before the first meter is labelled as the drive to the first order.
4. **Route worked** — a map in the look of the worklist's route map: the orders as pins
   numbered in the order they were logged, joined in that order. Office view only: when a
   drive log exists for the day, a switch overlays where the truck drove, with top speed,
   average speed, distance, driving time and the number of legs. No drive log that day reads
   "No drive log was recorded this day".
5. **Every log, in order** — time, order number, status, gap from the previous log, usual
   time, and how the gap was read (work, pause, logged delay).

## Method

All of it comes from one installer's `Stops`, `Downtime` and `Days` rows.

1. **Which logs count.** Statuses `INSTALLED`, `UTI`, `VISITED`, `UNACCOUNTED`.
2. **Land or boat** is decided by date and installer with
   `js/compute/installer-lifetime.js workTypeOn`, never by a row's `workType` tag.
3. **Days.** Logs grouped by Toronto calendar day, sorted by time.
4. **Gaps.** The time between each log and the next on the same day, with the straight-line
   distance between the two pins. Seven kinds by distance: under 60 m, 60 m–0.5 km, 0.5–1,
   1–2, 2–5, 5–10, over 10 km.
5. **Usual time.** For each kind, the median gap for that installer. A gap with a missing pin
   is compared with the median of every gap.
6. **Pauses.** A gap 10 minutes or more over the usual time for its kind is a pause; the
   excess is its length. A smaller overrun stays work.
7. **Logged delays come off.** A delay carries a note `gap HH:MM–HH:MM` naming its gap. Those
   minutes come off that gap's pause, never below zero. The key is the date plus both clock
   minutes, floored. `BREAK`, `LUNCH`, `MISC_TRAVEL` and legacy `TRAVEL_TIME` rows are not
   taken off.
8. **Unlogged pause time** for a day is the sum of what is left. The typical day is the
   median of those daily totals.
9. **Working time** for a day is the sum of its gaps with each pause capped at the usual time
   for its kind, so span = work + all pause time.
10. **Where a logged delay falls**, from its gap note: before (the gap ends at or before the
    first meter), between, after (it starts at or after the last meter), or untimed (no gap
    note).
11. **Before the first meter, not logged** = first meter − 07:30 − delay logged before the
    first meter. **Close-out and drive home** = end time − last meter.

**The work-type trap.** Gap-delay rows in `Downtime` are written with a blank `workType`,
which reads as boat. Never filter those rows by work mode. Filter the stops by mode and let
the row's key find its gap.

**Timestamps** can have a single-digit hour. Parse with the existing helpers in `js/time.js`;
never slice or compare them as text.

## Limits (printed on the page, in plain words)

- It cannot separate a break from an unlogged delay. Both are a gap that ran long with nothing
  logged against it.
- The comparison is with the installer's own usual pace, not a company standard or another
  installer. A stop that took longer because the job was harder counts as a pause.
- A log records one moment per order, when the entry is saved. Arrival and departure are not
  recorded, so the first installation and the drive to it sit before the first log.
- Start and end are the 07:30 rule and the time recorded at close-out. Neither was checked
  against anything.
- Distances are straight lines between pins. The route map joins the pins with straight lines
  too; it is the order worked, not the roads driven.
- Logged delays are as entered. Reading morning dispatch as the drive to the first order is
  how the installer says it is used.
- The 10-minute threshold, the 45-minute flag and the 8-order rule are choices.
- On Boat and All: the pause method was only checked against land work.
- Drive logs are recorded only on the days and phones where tracking was switched on, and
  only while the app was in front. Average speed includes slow movement while parked.

## How it gets made

These are the builder's calls (Claude's), not things the owner chose, unless marked.

**Two pages over shared code.**
- `audits.html` + `js/pages/audits.js` — the office page. Starts with `await requireAdmin()`.
- `my-audit.html` + `js/pages/my-audit.js` — the installer's page. No password. The name is
  the one in the phone's Settings; no picker; no drive log. A "back to the log" link.
- `js/compute/audit.js` — every number. Pure and DOM-free, so `node --test` covers it.
- A shared rendering module and `css/audits.css` for both pages.
- Charts are plain HTML and SVG, not canvas, so they print sharply. The map is the vendored
  Leaflet.

**Menus.** "Audits" is added to the dropdown on Map, Crew & Teams, Edit & Daily Log, Reports
and Route Planner, and each page's handler learns the new value. On the log page the ☰ menu
gets a "My audit" entry that carries its own action (it must not depend on `capture.js`
binding a new id), so it cannot be broken by a phone running new markup against old cached
script, or the reverse. The menu's stylesheet styles `button` elements only, so a button
keeps its look on a phone with an old cached stylesheet where a bare link would not.

**The service worker is not touched.** Any byte change to `sw.js` makes every phone
re-download the whole shell. The new files stay out of `SHELL`; the audit needs a connection
anyway, and the worker caches them on first load. The new modules reach anything recently
added to a shell module through a namespace import with a `typeof` check.

**One new read on the spine: `audit`.** It takes an installer name and returns that
installer's logs (the four statuses; time, status, order number, address, pin), their
`Downtime` rows and their `Days` start and end times, for all dates. The page fetches it once
per installer and does everything else in the browser, so changing the range, the mode or the
day needs no second request, and the Apps Script time limit is not in play.
- It answers to the app's public token when an installer is named, exactly like `day` and
  `range` today, and refuses a blank name outright.
- **Owner's decision (2026-11-18):** this makes a named installer's logged delays and
  close-out times readable without the office password. Their stops already are. Drive logs
  are not: `driveTracks` and `downtime` stay in `ADMIN_GET`.
- "Only their own" is therefore not a lock. Anyone who puts another name in Settings sees
  that installer's audit. The page hides the picker; it cannot do more without sign-in.
- The office page reads the day's drive log through the existing password-gated
  `driveTracks` read, only when a day is opened.

**Choices inside the calculation.**
- The usual time per distance kind is taken over **all the installer's work to date in the
  chosen mode**, whatever range is picked. A short range or a single day then still has a
  stable "usual", and a full-range audit matches the PDF. A kind with fewer than 5 gaps is
  compared with the median of every gap, as the spine does.
- Medians and tenths use the PDF script's definition (the value at position `floor(n × p)` of
  the sorted list), so the page reproduces the PDF. It need not equal the spine's stored
  figure, which uses a different window (the latest 30 days with 5+ logs).
- "30 worked days before that day" means the 30 most recent days with 8+ orders, in the
  chosen mode, before the picked day. With fewer available the column says how many it used.
- In the comparison columns each row uses the statistic the rest of the page uses for that
  measure: averages for orders, first meter, last meter and logged delay; medians for
  unlogged pause and longest pause. The column heads say which.
- A day with no close-out uses 16:00 and says so. A first log before 07:30 starts the bar at
  that log.
- Short ranges and new installers: the page shows what there is and says how many days the
  statistics rest on. It never invents a figure from no days.

**State in the address.** Installer, mode, range and day ride in the page address, so the
browser's Back button returns from a day to the period and a view can be reopened.

**Print.** A print stylesheet: controls hidden, a heading with the installer, mode, period or
day and the date printed, method and limits opened.

## Checking it

- `tests/audit-compute.test.mjs` over made-up days where every answer is known by hand: each
  distance kind, the 10-minute boundary, the floored delay key, blank-`workType` gap rows
  kept, break and lunch not taken off, before / between / after / untimed, the dispatch
  split, the 8-order rule, the late-day rule, the 45-minute flag, single-digit hours, both
  baselines.
- `tests/admin-gate.test.mjs`: `audit` is token-only when named and refused when blank;
  `downtime` and `driveTracks` stay gated; `audits.js` awaits `requireAdmin()`;
  `my-audit.js` never calls a gated action.
- Outside the repo: feed the 2026-11-18 export through `js/compute/audit.js` and compare with
  the reference values in the owner's context folder (`Documents\audits-page-context\` on his
  PC, which also holds the scripts that made the PDF; `report-data.mjs` there is the
  reference for every figure, including which days each one counts). One thing to watch: the PDF script also
  dropped rows tagged `boat` on land dates, which this design does not. If the totals differ
  because of it, raise it with the owner; do not quietly copy the tag rule.
- Drive both pages in a headless browser with the spine stubbed (`VERIFY.md` §4). No write to
  the production sheet.

## Docs that change with it

`USER-GUIDE.md` (both pages, in the help renderer's markdown subset), `AGENTS.md` (the new
pages, the `audit` read and its gate, why `sw.js` was left alone), `ARCHITECTURE.md` (an
Audits section and the read's shape), and the changelog day page plus the `CHANGELOG.md` row
in the same commit as the code.

## Left to the builder

File and function names beyond those above, the exact shape of the `audit` response, the
look of the gap detail, empty and error states, and the styling, within the look of the
existing office pages.
