# Sign-in UI, role nav, and approvals — design

Phase 1 steps 3b–3d of the per-user auth work (see `HANDOFF.md` §"Next, in order",
items 1–3). The client credential model (`js/auth.js`, `js/auth-policy.js`) and the
whole server side already landed; this is the UI over them.

**The rules this design serves are not restated here.** The `status` state machine,
the four separate privileges, and the offline-Monday rule live in `AGENTS.md`
§"The auth gate", `ARCHITECTURE.md` §"Per-user auth" and `DEPLOY.md`. This document
records only what is being built and why it takes this shape.

## The governing constraint

**Login is a banner, never a wall.** A PIN can only be checked server-side, so a
phone with no signal on a Monday cannot get a session — and still has a full day of
meters to log. Nothing below may block the app opening, block capture, or block a
write from being queued.

## Scope

All three remaining client steps, designed together because they share the same
modules and touch the same nav wiring:

1. The sign-in banner + sheet.
2. Per-role nav hiding and a wrong-page guard.
3. The approvals screen for the `pendingAuth` read.

## Why the UI is JS-injected rather than inline markup

Every other sheet in this app is inline markup in `index.html`. This one cannot be,
for a reason that only shows up once roles are live:

A Foreman's session expires at Monday 04:00. Their remembered role (`authRole`
survives expiry on purpose) redirects them off the capture page to `edit.html`. If
the sign-in sheet exists only in `index.html`, they are on a page with no way to sign
in. So the sheet has to be reachable from all seven pages — and seven copies of the
same markup is precisely the drift failure `CLAUDE.md` was written about.

A module that injects its own DOM and ships its own stylesheet solves both, and also
gives `reports.html` — which has no `.sheet` CSS of its own — the approvals screen
for free. `worklist-tuning.js` and `renderStuck()` already build their own markup, so
this is not a foreign pattern here.

## Modules

| File | Purpose | Depends on |
|---|---|---|
| `js/auth-ui.js` (new) | Owns the sign-in banner + `#authSheet`. Injects its own DOM. Exports `initAuthUI()`, `openAuthSheet()`. | `auth.js`, `auth-policy.js`, `dom.js`, `store.js` |
| `js/nav-roles.js` (new) | `guardPage()` (redirect on wrong role) + `applyRoleNav()` (filter nav entries). | `auth.js`, `auth-policy.js` |
| `js/approvals.js` (new) | The `#approvalsSheet`. Injects its own DOM. Exports `initApprovals()`. | `auth.js`, `dom.js` |
| `css/auth.css` (new) | Banner + both sheets. Self-contained — must not assume `capture.css`. | — |
| `js/auth-policy.js` | Gains `bannerFor(state, name)` → `{show, tone, text, cta}`. Pure. | — |

`bannerFor` goes in `auth-policy.js` beside `sessionState` and `loginOutcome` because
it is the same kind of thing: a pure decision about session state. It is not part of
the `Code.gs` role mirror and the drift test resolves sets by name, so it does not
disturb that guard.

### Wiring order

Every page entry module, in this order:

1. `guardPage()` — before any data load, so a redirect doesn't fire off reads first.
2. `initAuthUI()`
3. `applyRoleNav()`

`js/pages/capture.js` and `js/pages/reports.js` also call `initApprovals()`.

Mount points: `auth-ui` and `nav-roles` on all seven pages; `approvals` on
`index.html` and `reports.html`. Those two are chosen because `R_ONBOARD` is
owner/admin/backoffice, and Back-Office cannot open `index.html` (`R_CAPTURE` is
owner/admin/installer) but can open `reports.html` via `R_VIEW`. Approvals only in
the capture nav would leave Back-Office holding a privilege they can never exercise.

## The banner

Renders from `auth()` through `bannerFor()`. Re-renders on `onAuthChange`, which
already fires on wake — a session expires at a fixed Monday 04:00, so a phone left
open over the weekend crosses that boundary with no request happening, and the banner
must appear when the phone is picked up rather than on the first failed write.

| `state` | Banner |
|---|---|
| `ok` | none |
| `none` | "Not signed in" · **Sign in** · ✕ |
| `expired` | "New week — sign in again, {name}" · **Sign in** · ✕ |

`expired` names the person because `authName`/`authH` survive expiry specifically so
the prompt can be personal and pre-filled.

Dismissal writes `localStorage['authBannerDay'] = <today>`; the banner returns the
next day. This mirrors the existing date-keyed `driveRecord` pattern — a stale or
absent date reads as "show it".

The banner sits above the capture form and covers nothing. **The sync pill keeps its
own separate "N waiting — sign in to sync" wording** and is not changed; the two are
different facts (no session vs. work waiting because of it) and collapsing them would
lose the second.

## The sign-in sheet

One sheet, two modes.

- **Sign in** — H number, 6-digit PIN.
- **Create a PIN** — H number, PIN, confirm PIN.

H number pre-fills from `authH`, falling back to the `hNumber` already in Settings.
The PIN field is `type="password"`, `inputmode="numeric"`, `maxlength="6"`.

Outcomes switch on the `kind` that `signIn`/`signUp` already return. No error-string
pattern-matching — that is why `loginOutcome` returns flags.

| `kind` | Behaviour |
|---|---|
| `ok` | Close, toast "Signed in as {name}", re-run `applyRoleNav()` |
| `pending` | Stay open: "Waiting for approval — you can keep logging meanwhile" |
| `locked` | Stay open, show the lockout and when it lifts |
| `needsPin` | Switch to Create-a-PIN mode: "Your PIN was reset — choose a new one" |
| `failed` | Inline error under the PIN field |
| `offline` | Inline: "No signal — keep logging, your work is saved and will sync" |

The `offline` copy is load-bearing, not decoration: it is the moment an installer
learns that failing to sign in has not cost them anything.

While signed in the sheet shows name, H number and role, plus **Sign out** — which
calls `signOut()` and therefore touches only the session keys. The queue, day cache,
worklist and the person's name/H number all survive, because signing out must never
cost un-synced work.

## Role nav and the page guard

`applyRoleNav()` maps each nav entry to the page it opens and removes the ones
`can(page)` refuses:

- the `<option>`s in `#navSel` on `map`, `edit`, `teams`, `reports`, `planner`
  (`analytics` maps to `map.html`, since it is `map.html#analytics`);
- the buttons in `#navMenu` on `index.html`;
- the approvals entry, shown only for `R_ONBOARD`.

`help.html` has no jump menu — only a Back button — so it has nothing to filter. It
does need one fix: that button falls back to a hardcoded `index.html` when there is
no referrer, which a Foreman cannot open. It should fall back to `landingPage()`.
The guard would bounce them onward correctly anyway, but sending someone to a page
you know they can't have is a redirect to nowhere with extra steps.

`guardPage()` compares the current filename against `canSeePage`. On a refusal it
redirects to `landingPage()` with a toast saying why. `homePageFor` always returns a
page the role can open, so this cannot dead-end.

**This is inert during the migration window.** A blank role is allowed everything by
`roleAllows`, and until people sign in that is everybody. It is also offline-safe:
`authRole` is remembered through expiry, so the nav stays correct with no signal.

The role sets remain what they are — a mirror of `Code.gs` that exists only to hide
unusable UI, never a security boundary. The spine re-checks every request.

## The approvals sheet

Renders the two lists `pendingAuth` returns.

**Pending signups** — name, H number, whether they are on the roster, when they
signed up. Actions: Approve, Reject, and a role `<select>` populated from the
response's `grantable` list. The select defaults to the row's current role; posting
the role unchanged is not treated as a grant attempt server-side, which is what lets
Back-Office (who can grant nothing) still approve the installer in front of them.

**All accounts** — status, last login, fail count, lock state. Actions: Reset PIN,
Unlock, Revoke, change role. Rows whose `manageable` is false render read-only.

Every action posts through `authAction(action, hNumber, extra)` and re-reads the list
on completion. `manageable` and `grantable` are advisory only; the spine re-checks
each one through `authTarget`, so **no rule from `Code.gs` is duplicated client-side**
— the client shows what the server said it may show, and shows the server's refusal
verbatim when it is wrong.

## Error handling

Every spine call already returns `{ok:false, error}` or throws to `{kind:'offline'}`.
The sheets toast the error text as given rather than interpreting it. Nothing in
these modules retries; the approvals screen is an online-only surface by nature and
says so when offline.

## Testing

`tests/auth-ui.test.mjs`
- `bannerFor` across `none` / `expired` / `ok`, including that `ok` shows nothing.
- The outcome table above: each `kind` maps to the stated mode and message.
- Banner dismissal is day-scoped — a stale date shows the banner again.
- `js/auth-ui.js`, `js/nav-roles.js`, `js/approvals.js` and `css/auth.css` are all in
  `sw.js` `SHELL`, and `CACHE` is bumped.

`tests/nav-roles.test.mjs`
- The visible nav set for each of the five roles, and that a blank role sees all of
  it (the migration window).
- `guardPage` picks a page the role can actually open, for every role.

`tests/approvals-ui.test.mjs`
- Which controls a row gets, against `manageable` / `grantable` / `status`.
- A non-`manageable` row renders no action buttons.

Plus the standing invariant, asserted rather than assumed: **nothing in these modules
sits on the path `enqueue()` takes.** `tests/queue-auth.test.mjs` already guards that
a write with no valid credential still queues and that a rejected credential never
parks; this design adds no code between a tap and the queue.

## Service worker

`css/auth.css` and the three new modules join `SHELL`, and `CACHE` goes to `v35`.
Without the bump phones keep serving the old shell and none of this ships.

## Out of scope

- Rotating `SHARED_TOKEN` and flipping `REQUIRE_AUTH` — that is `DEPLOY.md` rollout,
  after this lands.
- Phase 2 (edge box, Cloudflare Tunnel, Maps/ORS key rotation) and later.
- `tests/session-monday.test.mjs`, still owed from the foundation work.

## Noted separately, not part of this work

`Code.gs` carries a **raw NUL byte** in the PIN-hash domain separator
(`String(salt) + '<NUL>' + String(pin)`, ~line 1063). It is correct at runtime, but
it makes `grep`/`ripgrep` classify the whole file as binary and refuse to search it.
Replacing it with the two-character escape `\0` is byte-identical in behaviour. Worth
a one-line commit of its own.
