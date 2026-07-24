# Installer route tuning — design

Date: 2026-07-24

## Problem

On the phone worklist screen, **Route starts** (`wlRouteDate`) and **First stop at**
(`wlRouteTime`) don't meaningfully drive the plan — they're clutter. Separately, the
route optimizer already sizes days to the installer's 30-day pace and a ~14:00 finish,
but only on a road-matrix run, and the "home bias" is a hard-coded binary (each day is
re-solved to *end* near home) with no way for an installer to tune it. Installers want:

1. The two dead fields gone.
2. ETAs anchored to a fixed departure time plus real drive-out road time.
3. A visible start-location pin and a drive-out line to the first order.
4. Two tunable dials — how hard the route heads home, and finish-early vs more stops.
5. A settings screen for those dials (and future installer-only settings), reachable
   only from the capture page, whose values the office planner silently uses too.

## What already exists (confirmed in code)

- `js/route-constraints.js` `simulateDay`: with a `travel` lookup, arrival at the first
  stop is `departClock + travel.fromStart(id)`; `departClock` starts at `firstMin` (from
  `opts.firstStopTime`). So the departure/drive-out ETA model is already there — it just
  reads the soon-to-be-deleted field.
- `js/route.js` `timeCapacity()`: sizes stops/day so on-site time
  (`onSiteMinutes(pace)`, pace-derived from `recent30AvgLogMin`) + real drive lands the
  day by `opts.dayFinishBy` (planner default 14:00). Only runs with road durations `T`.
- Home bias is binary: `orderChunkHome` / `orderChunkStartHome` re-solve each day's
  chunk pinned to *end* near home. No weight.
- `WorklistPlans` sheet row (`Code.gs` `WORKLIST_PLANS_HEADERS`) already carries
  per-installer plan settings and rides the worklist Upload/Download sync.
- Per-leg road geometry (`legGeometryRoad`/`legGeometryStraight`) is fetched from OSRM's
  `route` service after a road-matrix optimize and decoded on the phone with no network.
  The drive-out to the first stop is currently **excluded** from geometry and undrawn.

## Design

### 1. Remove the two dead fields

- Delete the **Route starts** and **First stop at** inputs from the
  `.wl-schedule-settings` block in `index.html` (~lines 189–190).
- Remove their wiring in `js/worklist.js`: the `routeStartDate` / `firstStopTime`
  reads in `planShape`, their `store` writes in `savePlanLocal`, their assignment in
  `loadPlanFields`, and the two `onchange` handlers in `initWorklist`. `Pace (min/stop)`
  stays.
- `scheduleRouteConstraints` still requires both internally, so they become derived
  defaults, never UI:
  - **Route start date** → `nextWeekday(localDate())`. It only ever mattered for mapping
    appointment/lock dates onto day numbers.
  - **First-stop / departure time** → the global constant in §3.
- `WORKLIST_PLANS_HEADERS` keeps the `routeStartDate`/`firstStopTime` columns
  (append-only schema rule — never remove/reorder). `saveWorklistPlan` writes them from
  the derived defaults so old readers keep working.

### 2. ETA anchored to a fixed departure + real drive-out

No new model — point `departClock`'s base at the global departure constant instead of
the deleted field. Result on any road-matrix run:

    ETA(first order) = ROUTE_DEPART_TIME + road-matrix(start → first order)

The straight-line path keeps hiding ETAs (unchanged, intended).

### 3. Global departure constant in `js/config.js`

```js
// When the crew leaves the start location each morning. Global (not per-installer);
// change it with a commit — GitHub Pages ships it.
export const ROUTE_DEPART_TIME = '08:15';
```

Imported by `js/worklist.js` and `js/pages/planner.js` as the departure clock / first-
stop base. The planner keeps clamping to its `[08:00, 08:30]` muster window
(`departMinutes`), so a constant inside that window is honoured verbatim.

### 4. Start pin + drive-out line, with road geometry when available

Reverse the "no drive-out line" rule **for the crew start only** (never for home):

- Draw a distinct **start pin** and a **drive-out line** from the start to the day's
  first order on both `js/worklist-route-view.js` (phone) and the planner map
  (`js/pages/planner.js`).
- The line uses **real road geometry when we have it, straight otherwise** — same
  contract as the between-stop legs. Add an appended geometry pair to `Worklist`,
  `homeLegGeometryRoad` / `homeLegGeometryStraight` (paralleling the existing
  `homeLegMeters*`). The desktop planner's OSRM `route` fetch is extended to also fetch
  the start → first-stop leg per day and store it there; it rides the worklist sync
  verbatim; the phone decodes it on-device with no network. Absent geometry (edit,
  OSRM-offline/ORS run, phone straight optimize) ⇒ a plain straight line.
- Geometry lifecycle mirrors `legGeometry*`: an Optimize that reorders the first stop
  blanks the stale `homeLegGeometry*`, and both maps only draw it while the live
  sequence still matches the saved variant (`variantMatchesLive`).
- Update AGENTS.md's "no drive-out line" note to reflect the start-leg exception.

### 5. Two installer dials

Both live on the tuning screen (§6), sync via `WorklistPlans`, and are read **silently**
by the optimizer (never labelled "installer-set" in any office UI).

**A. Commute pull** — how hard each day curls back toward home.
- UI: 0–100% slider. Default **70** (close to today's hard pin).
- Mechanism: in the per-day chunk re-solve (`orderChunkHome`/`orderChunkStartHome`),
  scale the home node's sub-matrix edges by `pull/100` before solving. `pull=0` ⇒ home
  edges ~0 ⇒ the endpoint is indifferent to home (route ends where production is best);
  `pull=100` ⇒ true home distances ⇒ today's full "end near home" behavior; in between
  blends smoothly. Exact interpolation (and whether it also nudges day-cluster
  assignment) is settled in the implementation plan; behavior at the 0 / 70 / 100
  anchors is the contract.

**B. Target finish time** — finish-early vs more stops.
- UI: an editable time, default **14:00**, feeding `opts.dayFinishBy`.
- Earlier ⇒ `timeCapacity` fits fewer stops/day (home sooner); later ⇒ more meters.
- This also wires the pace/finish day-sizing — currently planner-only — into the
  **phone** road optimize, by passing `dayFinishBy` from this setting there too.

New `WorklistPlans` columns, appended after `straightDistanceSource`:
`commutePull` (integer 0–100), `finishBy` (`HH:MM`). Written by `saveWorklistPlan`,
returned by the `worklist` read, defaulted (`70` / `14:00`) when blank.

### 6. Tuning screen — `#tuning`, capture-nav only

A hash-routed screen inside `index.html` (sibling of `#worklist` / `#drive`), added to
the ☰ `#navMenu` as `🎛 Route tuning`. Chosen over a standalone `tuning.html` because:
"only accessible from the capture page" comes for free (no back-office page links it), it
reuses `store` / `idb` / `config`, and it needs no new HTML file, `sw.js` `SHELL` entry,
or router.

Layout:

```
🎛 Route tuning
  Commute pull        [====o-----]  70%
    Low = most meters · High = shortest drive home

  Target finish time  [ 14:00 ]
    Earlier = fewer stops, home sooner

  ── At this finish time ─────────────
  ~11 stops/day          ← live, moves with the finish dial
  Your 30-day pace: 24 min/stop      (context, InstallerMetrics.avgLogMin)
  Recent avg: 12 meters/day          (context, InstallerMetrics.avgPerDay)

  [ Save ]     Leave-start time is set org-wide: 08:15
```

Values persist to `store` locally and ride the existing worklist **Upload / Download**
into `WorklistPlans` — no new endpoint, no new sync path.

### 7. Live "expected stops/day" readout (finish-time only)

Real math, not a placeholder. Reuse the `timeCapacity` shape:

    available = finishBy − ROUTE_DEPART_TIME − breakMin
    perStop   = onSiteMinutes(pace) + nominalBetweenDrive
    expected  = floor((available − nominalMorningDrive) / perStop)

fed from the installer's own `InstallerMetrics` (30-day pace `avgLogMin`, plus the
nominal drive constants the code already uses) and recomputed on every finish-dial
change. Show it with historical `avgPerDay` and pace as static context.

**Commute pull does not move this number** and is intentionally not wired into it — pull
only reshapes ordering/endpoint, whose production cost is real drive time that exists
only against an actual route + road matrix a standalone screen doesn't have. Showing a
number for it would be invented. Its true live cost preview is a **separate deferred
task** (see `docs/backlog/live-expected-meters-preview.md`), whose honest home is the
worklist screen right after an Optimize, where the matrix exists.

## Testing

- `tests/route-constraints.test.mjs`: first-stop ETA base comes from the constant, not a
  passed field; a fixture with `commutePull` 0 vs 100 yields different day endpoints;
  an earlier `finishBy` shrinks the per-day count.
- `tests/route-variants.test.mjs` / route tests: `homeLegGeometry*` fetched/stored for
  the drive-out leg; blanked when the first stop is reordered; straight fallback when
  absent.
- `tests/worklist-sheet-schema.test.mjs`: `commutePull`, `finishBy`,
  `homeLegGeometryRoad`, `homeLegGeometryStraight` present and appended last.
- Doc-content assertion (if the suite guards it): AGENTS.md drive-out note updated.
- `node --test "tests/*.test.mjs"` green before any push (a push to `main` is a
  production deploy).

## Out of scope / deferred

- Live cost preview for the commute-pull dial — `docs/backlog/live-expected-meters-preview.md`.
- Any per-installer override of the departure time (it is global in `config.js` by
  decision).
