# Deferred: live expected-meters preview for the commute-pull dial

Status: **deferred** (backlog). Split off from the 2026-07-24 installer route tuning
work — see `docs/superpowers/specs/2026-07-24-installer-route-tuning-design.md`.

## What was asked

On the tuning screen (`#tuning`), as the installer moves their dials, show an "expected
daily meters" number that reflects **both** dials — including **commute pull** — so they
can see how a setting change would affect their metrics.

## What shipped instead, and why this is separate

The **target-finish-time** dial's effect on expected stops/day shipped in the main task:
it's real, closed-form math (`timeCapacity`: available time ÷ per-stop time) computed
from the installer's `InstallerMetrics` (30-day pace) — no route needed.

The **commute-pull** dial was deliberately left out of that readout. Pull only reshapes
route *ordering* and the day's *endpoint*; its cost is extra real drive time. That drive
time exists only against:

1. the installer's actual pending stops (their coordinates), and
2. a **road-distance matrix** over those stops.

A standalone settings screen has neither, so any pull-driven meters number there would be
fabricated. We won't show an invented figure.

## The honest way to build it later

Surface it on the **worklist screen, right after an Optimize**, where the road matrix
(`measure` / `travelLookup`) already exists for the real stops. Then a live preview can
re-price the *same* stops at different pull values and show the true trade-off
(e.g. "pull 40% → ~13 meters/day, 6 km home; pull 90% → ~11 meters/day, 2 km home").

Sketch:

- After a road-matrix optimize, keep the run's `measure` in memory.
- On a pull-slider change, re-run the day-clustering / chunk re-solve at the new pull
  against the cached matrix (no network — it's a local re-solve).
- Report stops/day and the home-leg distance for the previewed pull, next to the dial.

Constraints / gotchas:

- Only valid on a **road** variant (a straight-line run has no durations — keep the
  readout hidden, consistent with the rest of the UI).
- Must not trigger a new matrix call (respect the per-device element budget); it reuses
  the matrix already fetched.
- Debounce slider input so a drag doesn't re-solve on every pixel.

## Acceptance (when picked up)

- Moving the pull dial after a road optimize updates a live meters/day + home-distance
  figure derived from the cached matrix, with zero network calls.
- Straight-line / no-matrix state hides the pull preview rather than guessing.
