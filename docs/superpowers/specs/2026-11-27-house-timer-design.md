# House timer on the Drive screen — design

Date: 2026-11-27. Status: approved by the owner and built the same day.

## Why

The app has no direct measure of how long the crew is at a house. It is inferred from
the gaps between logs and from parked holes in the GPS track. The owner wants the crew
to mark it: one button when the truck is parked and they are about to get out, one when
they pull out for the next order.

This is collection only. The owner's words: "I don't want to do anything with these
numbers yet. I just want to start collecting the data." What the numbers mean, and how
they feed the rest of the app, is a later piece of work.

## Goals

1. Two buttons on the Drive screen, placed where the owner drew them: left and right of
   "2 of 14" and the "km/h now" figure.
2. One row per start/end pair on the Google Sheet.
3. A forgotten end must not be a problem. The owner wants to see which order the timer
   started on and which order it ended on.
4. A long timer is fine. Finishing the order and then doing boxes before leaving is
   part of the time, and is kept.

## Non-goals

- No screen, report, ETA or dwell figure reads the new tab.
- No read endpoint on the spine.
- No GPS columns on the row.

## What must not happen

- A new button that is dead, or a Drive screen that breaks, on a phone running a new
  `drive.js` beside an older `index.html` or stylesheet. Phones are updated by hand.
- A timer lost because the app was reloaded or killed while it was running.
- A raw figure replaced by an interpreted one, so the interpretation cannot be redone.

## Approaches considered

1. **Upload with the 3-minute Drive refresh** (the owner's first idea). The refresh
   runs only while drive tracking is armed, "Show driving stats" is on and the Drive
   screen is in front. On a day without tracking it never runs, so finished timers
   would need a second place to wait and a second way up.
2. **Upload through the offline queue at the Leaving press.** The same path every
   logged stop takes: durable on the phone, retried without signal, visible in the Sync
   activity list, no dependence on tracking. **Chosen by the owner.**

For the forgotten end, the owner was offered three choices: end the old timer and start
the new one with no pop-up, ask each time, or block Parked until Leaving is pressed. He
chose the first and added: try to subtract the drive time from the gap.

For the buttons, markup in `index.html` plus rules in `drive.css` was ruled out in
favour of building the row in `drive.js` with inline styles, so the feature is one file
that works beside any older page or stylesheet.

For the drive time, GPS was ruled out: the app gets no fixes while Google Maps is in
front, which is when the truck is driving. The estimate comes from the travel ladder
the ETAs already use.

## Design

**Buttons.** `[ Parked ]  2 of 14 / km/h now  [ Leaving ]`, with one line of text
under the row. Idle: Parked is live and Leaving is greyed. Running: Parked shows the
minutes, Leaving is green, and the line names the order and the start time. After
Leaving the line says what was saved.

**Which order.** The "Driving to" card when there is one, otherwise the big card,
because Navigate moves the big card on to the next house. If the "Driving to" order is
the one the last timer was on, the press is for the big card (the house two doors
down).

**Ending.** Leaving ends the timer on the order Navigate was last pressed on while it
ran, else on its start order. Parked on a different order ends the old timer on that
order and starts a new one. A timer still running the next day is saved with no end
time.

**Drive subtraction.** Only when the end order differs from the start order. One
estimated leg between the two orders (road graph, else straight-line). The row keeps
the raw minutes, the drive, its source and the difference.

**The row** (`SiteVisits` tab): `id, date, installer, hNumber, workType, startTime,
endTime, minutes, startWO, startAddress, endWO, endAddress, endedBy, driveMin,
driveSource, onSiteMin, navTime`.

## Decided by the builder, for the owner to check

- A timer ended under 30 seconds is cancelled as a mis-tap. A second Parked press
  inside those 30 seconds does nothing.
- `navTime`: the time Navigate was first pressed on another order while the timer ran.
  One extra column, kept because it is the best record of when the truck really left a
  house whose timer was forgotten.
- A Leaving press does not look at the big card for the end order. The card moves on
  by itself when the order is logged and the list refreshes, which would look like a
  forgotten timer.
- The subtraction is one leg. A timer forgotten through several houses loses only the
  drive from its first order to its last.
- The order on a row is a hint. The stops logged inside the timer's window are already
  on the `Stops` tab and can be joined by installer and time.

## Left for later

- What on-site time means for an order with a long tail (boxes, downtime), and whether
  logged downtime should be taken off.
- Whether the timers replace or check the dwell model behind the route ETAs.
- A read endpoint, and where the figures are shown.
