# Meter Log — User Guide

Meter Log is the crew's tool for recording every meter stop, the day's downtime, and the end-of-day paperwork. It runs in the phone's browser, works with **no signal** (everything syncs later on its own), and replaces the paper daily log with a PDF the phone builds itself.

This guide covers the whole app: the capture page the installers use in the field, and the four office pages (Map & Analytics, Crew & Boat Teams, Edit & Daily Log, Reports).

---

## The pages at a glance

- **Log** (`index.html`) — the capture page. Installers use it all day: log stops, log downtime, plan a worklist, close out the day. This is the page to keep open on the phone.
- **Map & Analytics** (`map.html`) — read-only map of every logged stop plus the numbers (installs, UTIs, downtime, averages). For the office and foremen.
- **Crew & Teams** (`teams.html`) — add crew members, captains and sub foremen, and set up the boat or land crews. For the office.
- **Edit & Daily Log** (`edit.html`) — the back-office editor: fix any stop, remove or restore stops, set day times, close or re-close a day, and generate the daily-log PDF for anyone. For the office.
- **Reports** (`reports.html`) — pick a sub foreman and a date, see the whole crew's totals for that day, and close out anyone who forgot. For sub foremen and the office.

The office pages link to each other through the dropdown in the top bar (**Log / Map / Analytics / Crew & Teams / Edit & Daily Log / Reports / Help**). The capture page keeps things simple for the field: its ☰ menu has only **📋 Worklist**, **🗓 Recent days**, **⚙︎ Settings**, and **❓ Help**.

---

## Getting started (one-time setup)

Do this once per phone, with signal if possible:

1. Open the app link in the phone's browser. For quickest access, add it to the home screen (browser menu → "Add to Home Screen") — it then opens full-screen like an app, even offline.
2. Tap **☰** (top right) → **⚙︎ Settings**. The "Who are you?" card opens.
3. Enter your **First name**, **Last name**, and **Employee # (H)** — the H number is your unique ID; names can repeat, H numbers can't.
4. **Sub foreman** is optional: pick yours only if you are *not* on a boat/land team (a team's sub always wins over this setting).
5. **Home address** is optional too: with it set, **🧭 Optimize route** on the worklist plans your day to finish heading toward home (it starts at the far end and works back). The hint line under the field shows the exact spot it matched — if that's the wrong town, add the town to the address and Save again.
6. Tap **Save**.

That's it. Everything you log from now on is tagged with your name and H number. If you try to log a stop before doing this, the app stops you with an "Add your name first" message and opens Settings for you.

---

## Boat and Land mode

The **Boat / Land** switch sits in the top bar (blue = Boat, green = Land). Pick the mode for the kind of route you're running:

- The choice sticks on the device — set it once and forget it until your work changes.
- Logging works the same in both modes. What changes is the paperwork: a Land day prints the land daily-log template (per-work-order delay columns) instead of the boat one, and the Crew & Teams page shows land crews instead of boat teams.
- The colour is your reminder: blue screens are a boat day, green screens are a land day.

---

## The status pill (is my stuff synced?)

The pill in the top-left corner tells you where your logs are:

- **All synced** — everything is saved to the sheet.
- **N sending…** — the app is pushing N saved items right now.
- **Offline** / **N waiting — offline** — no signal; N items are stored safely on the phone and will send by themselves when signal returns. You don't have to do anything.

---

## Logging a stop

Every stop follows the same rhythm: pick the status, fill the fields, check the address, tap **Log stop**.

1. On "Log a stop", pick the status: **INSTALLED**, **UTI**, or **OTHER**.
2. Enter the **Work order #**.
3. If you had to request this meter from dispatch, tap **Requested?** so it shows **Requested ✓**. That's all — the waiting time is worked out automatically at end of day.
4. Fill in the fields for your status (below).
5. Check the **Address / landmark** row (see "Address and GPS" below).
6. Add a **Note** if anything is worth remembering.
7. Tap **Log stop**. You'll see "Install logged ✓" / "UTI logged ✓" — or "Saved — will sync when online" if you have no signal. Both mean the stop is safe.

### INSTALLED

- **New J#** — required; the app won't log without it.
- **Old J#** — the meter you took out.
- **Meter read** — the final read off the old meter.
- Solar meter? Tap **Solar meter — add a second read** and enter the **Received read** as well (the button shows "Solar ✓ — delivered + received").
- Can't read the meter? Tap **Meter unreadable? Save old J# instead**, pick **Why no read?** (Missing segments / Display blank / dead / Glass fogged / obstructed / Other), and enter the Old J#.

### UTI (unable to install)

- Pick the **Reason** from the dropdown — it starts blank on purpose, and the app won't log until you choose one (No Access, Denied Access, Could Not Locate, Key Required, Unsafe Conditions, and so on; **Other** asks for a short note).
- Add the **Old J#** if you can see the meter.

### OTHER — "we were here"

Use OTHER when you visited a spot but it's neither an install nor a UTI:

- Saw or checked a meter? Enter the **Old J#** — it's logged as a **Visit**.
- Couldn't find or confirm a meter at all? Leave Old J# blank — it's logged as **Unaccounted**.
- Add a note explaining, then **Log stop**.

There's also the one-tap **Already installed here · mark spot** button: it drops a GPS marker meaning "a new meter is already in at this spot". It doesn't count in your tallies or your daily log — it just marks the map so nobody hunts for that meter again.

### Address and GPS

- The app grabs your GPS position while you fill in the form; the grey line shows it ("Location: 44.9, -79.9 (±8 m)").
- Tap **↻ Refresh** to fill the address field from GPS. The address is editable — fix it or type your own (a landmark is fine), and use the small **Unit** box for unit numbers.
- No signal? The stop keeps its GPS position with a blank address, and the app fills the address in by itself once you're back online. Spots you've been to before resolve even offline.

---

## Logging downtime

Whenever the crew loses working time, log it as it happens:

1. Tap **Add downtime** (under the Log stop button).
2. Pick the **Reason**: Next Gen, Cell Signal, Bad Weather, Warehouse, Tools / Material, Truck Issues, Assist, Urgent / EER, Lunch, Break, Misc Travel, Travel Time, or Other (Other asks what happened).
3. Enter the **Minutes**.
4. The **Work order #** is pre-filled with the order you're on (or the last one logged) — keep it if the downtime belongs to that stop, clear or change it if not. On land routes, keeping it right is what puts the delay on the correct line of the PDF.
5. Tap **Log downtime**.

You won't find "Dispatch" in the reason list — waiting on a requested meter is calculated automatically during the end-of-day review, so don't log it by hand.

---

## The worklist (planning your day)

Open it with **☰ → 📋 Worklist**. It's your planned route, saved on the phone — fully usable offline.

### Building the list

1. Tap **＋ Add order** and enter the **Work order #**, the address (house **No.** + **Street / landmark** — recent streets appear as tap-to-fill chips), and the **Old J#** if you know it.
2. Tap **Save order** and keep adding; **Done** closes the form.
3. Drag the **⠿** handle to put the orders in driving order.
4. On each order: **Use →** loads it into the capture form, **🧭** opens directions in the phone's maps app, **Edit** changes it.

An order checks itself off automatically when its work order # is actually logged.

### Optimize route

Tap **🧭 Optimize route** (needs signal) to put the pending orders in the best driving order for you:

- Each address is looked up and matched **near where you are** (within about 80 km), so "Main St" means *your* Main St, not one in another city.
- With a **Home address** in Settings, the route ends heading toward home — the first stop is the far end of the day, and you work your way back. With no home set, whatever order is first in your list stays the starting point.
- An address that can't be matched nearby gets a **📍?** tag and drops to the bottom — fix the address (Edit) and optimize again. If the order was pinned before, it **keeps its old pin** — it just sits out of the route until the address is fixed.
- An address that matches **more than one town** gets a **⚠ which town?** tag: open **Edit** and tap the right place from the list — one tap pins it, and the next optimize routes it.
- If the road distances couldn't be fetched, the finished message says **why** (for example the map key was rejected) and the route is planned on straight-line distances instead — still usable, just blind to rivers and detours.
- The directions button (🧭) hands the order's **address** to your maps app — it navigates to what's written on the card, so even if the planning pin landed oddly, the truck still goes to the right door.

Re-running it any time is safe — completed orders stay done, and only what's left is re-planned.

### Plan mode

Tap **Plan mode: off** to switch it on. The capture form now follows the list: it pre-fills the next pending order, and a banner shows where you are ("Plan: WO 12345 · 2 of 8") with **Skip** (push this order to the back) and **Exit**. Each time you log a stop, the next order loads by itself.

If the GPS address disagrees with the planned one, the form asks "GPS found a different address — which one is right?" — tap **Keep planned: …** or **Use GPS: …**.

### Moving the list between devices

**⇪ Upload list** saves your list to the sheet; **⇩ Download list** replaces the phone's list with the saved copy (matched on your H number, so set up Settings first). Use it to plan on one device and run the route on another. Both need signal, both replace the whole list, and both confirm before doing it.

If the office plans your day on the computer, your Download may already arrive **in optimized driving order** with every address pinned — just start at #1 and work down; no need to tap 🧭 Optimize yourself.

---

## Checking and fixing your logs

- **Today's orders** — the day's tally and every stop so far. Tap a row → **Edit** to fix a field → **Save changes**. A stop that shouldn't be there at all: **Remove from log…** (it's archived, never deleted — the office can restore it).
- **Look up · WO# / J#** — type a work order # or J# and **Search** to find any past stop and **Edit** it.
- **☰ → 🗓 Recent days** — your last week of orders, stored on the phone. Works with no signal, so you can review or fix yesterday from the middle of the lake.

---

## End of day

When the day's done, close it out — this files the day's record and produces the daily-log PDF. It works fully offline.

1. Tap **End of day**.
2. Skim the tally and stop list; tap any stop to fix it.
3. Enter the **Departure time (left dock)** and **Returned to land** times.
4. Do the **travel review**: the app shows the gap between each pair of work orders. For each gap, the untouched part counts as travel; add a reason + minutes row to carve out anything that wasn't travel (a lunch on the water, a wait). If you flagged a stop **Requested ✓**, a **Dispatch** row is already filled in with the calculated wait — adjust it if it's off.
5. Add day **Notes** if you have any.
6. Leave **Include delays & travel time on PDF** checked unless told otherwise.
7. Tap **Finish day** — "Day closed ✓ · PDF downloaded". Offline it's "Day closed offline ✓ · PDF downloaded — will sync when online": the PDF still appears, and the close syncs itself later.

The PDF is built on the phone (no signal needed) and lands in the phone's downloads. Boat days print the boat template with the travel column; Land days print the land template with per-work-order delay columns.

Need the paper before the day's over? **Generate daily log (draft)** builds the same PDF without closing anything.

Closed the day and then found a mistake? Fix the stop, then close again — closing twice is safe and just replaces the day's record. The office can also do it from Edit & Daily Log.

---

## Working offline

The app is built for zero bars — the honest rule is: **keep logging, ignore the signal.**

- The app itself opens offline once it's been loaded on the phone one time.
- Stops, downtime, edits, removals, the worklist, the end-of-day close, and the PDF all work offline. Saves say "— will sync when online" and the status pill counts what's waiting.
- Syncing is automatic when signal returns; nothing is lost if the phone stays offline all day.
- The only things that genuinely need signal: worklist **⇪ Upload / ⇩ Download**, looking up stops older than your cached week, and fresh map tiles on the Map page. They just toast "Offline" and wait — nothing breaks.

---

## Crew & Boat Teams (office)

`teams.html` — where the roster and the crews live. The **Boat / Land** switch picks which set of teams you're editing.

### Crew

Everyone who logs meters, keyed by their H number.

- Use the search box ("Search crew by name or H#…") to find someone, edit their fields in place, and hit the ✓ save. The ✕ removes them (and takes them off any boat).
- **Add a crew member**: First name, Last name, **Employee # (H)**, then **Add**. (Installers who fill in their own Settings on the phone appear here automatically.)

### Captains & Subforemen

Two simple name lists with **Add** and ✕ — no H numbers. Names typed on a team card are remembered here automatically.

### Boat Teams (or "Crews" in Land mode)

One card per boat or land crew:

1. Tap **+ New boat** (or **+ New crew**).
2. Fill the **Boat number** (Land: **Crew number**), optional **Boat name**, **Captain** (boat only), and **Sub / subforeman**.
3. Add the crew: type a name — someone already in the crew list links by H number, a brand-new name is created on the spot.
4. Give each member a **team letter**. Same letter = partners: Boat 11's two A's are team **11A**. The letters are what fill in the daily-log header automatically at end of day.
5. Tap **Save boat** (or **Save crew**). **Delete** removes the whole card.

---

## Edit & Daily Log (office)

`edit.html` — the full editor for any installer's day.

1. Pick the **Installer** and **Date**, tap **Load workorders**.
2. The **Day times & daily log** card shows whether the day is closed ("Day closed ✓" / "Not closed yet") and holds the **Departure / Returned** times (**Save times**), the **Include delays & travel time on PDF** checkbox, **Generate daily log** (build the PDF), and **Close day** / **Re-close day**. Closing includes the same travel review the phone runs; re-closing is always safe — it replaces the day's record rather than duplicating it.
3. **Workorders**: every stop that day, fully editable — any field, the status, even the arrival time. **Save changes** per stop.
4. **Remove from log…** takes a stop out of the day. It's moved to an archive, never deleted, and if the day was already closed the day's record is rebuilt automatically.
5. **Removed stops** appears when the day has archived stops — **Restore** puts one back.

---

## Reports (sub foremen & office)

`reports.html` — one crew's day on one screen.

1. Pick the **Sub foreman** (there's a "No sub foreman" entry for unassigned installers) and the **Date**.
2. Each crew member shows their installed / UTI / delay totals and a **Closed** or **Open** badge; members with nothing that day show "No logs".
3. An open day has a **Close day** button right there — a quick close with no travel review, for chasing down stragglers at day's end. When the travel review matters, close from Edit & Daily Log instead.

---

## Map & Analytics (office)

`map.html` — read-only view of everything logged. The top dropdown flips between **Map** and **Analytics**; both share the filter bar:

- **Find WO# or J#…** + **Find** jumps to a specific stop.
- The installer box filters to one or more installers (type a name; active ones become chips).
- The date range (**From → To**) has **7d / 30d / 60d / All** presets.
- The status chips (**Installed / UTI / Visited / Unaccounted / Already in**) toggle each kind on and off.

**Map** shows a colour-coded pin per stop (legend in the corner). A pin's popup shows the stop's details and has its own **Remove from log…** (archived, restorable from Edit & Daily Log — needs signal).

**Analytics** shows the tiles — Installed, UTI, install rate, downtime minutes, and the pace averages (install→install, between completed WOs, log→log with partner, log→log per boat, dispatch waits) — plus charts: **Installs vs UTI by day**, **Downtime by category (min)**, **UTI reasons**, and the per-installer table.

---

## Troubleshooting

- **"Add your name first"** — Settings isn't filled in. ☰ → ⚙︎ Settings, enter name + H number, Save.
- **"Work order # is required" / "New J# is required" / "Pick a UTI reason"** — a required field is empty; fill it and log again.
- **The pill says "N waiting — offline" for a long time** — normal with no signal; the phone is holding the logs and sends them the moment it can. If it stays stuck *with* good signal, open the app fresh and give it a minute.
- **The address is blank on a stop I logged offline** — expected; it fills itself in after you're back online. The GPS position was captured either way.
- **Wrong address or a typo on a logged stop** — Today's orders (or Look up) → tap the stop → Edit → Save changes. The office can do the same from Edit & Daily Log.
- **A stop was removed by mistake** — nothing is ever deleted. Edit & Daily Log → load that installer + day → **Removed stops** → **Restore**.
- **The daily log shows zeros or is missing stops** — fix or restore the stops first, then close the day again (from the phone or Edit & Daily Log). Re-closing replaces the old record; it never doubles up.
- **Upload/Download list says "Offline"** — worklist sync is the one field feature that needs signal; try again when you have bars.
- **The PDF didn't appear** — check the phone's downloads folder; then tap **Generate daily log (draft)** to build it again.
