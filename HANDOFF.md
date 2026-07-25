# HANDOFF — auth, cost control, and near-instant sync

**Transient file. Delete it when Phase 1 ships.** It exists so a new session (any
agent) can pick this work up mid-flight. It records *where the work is*, not *how the
system works* — every durable decision already lives in `AGENTS.md`,
`ARCHITECTURE.md` and `DEPLOY.md`, and this file links to them rather than repeating
them. Do not let it become a second source of truth; that is the exact failure
`CLAUDE.md` was written about.

**Read `AGENTS.md` in full first.** Then this.

Branch: `claude/security-scalability-architecture-t142cu` · 333 tests green ·
nothing on `main`, so nothing is deployed.

---

## Why this work exists

A 6-person crew's app is being considered for ~200 installers. Three things block
that, and they compound:

1. **No authentication.** One hardcoded `SHARED_TOKEN` was the entire gate, shipped
   in `js/config.js` to every browser alongside `GMAPS_API_KEY` and `ORS_API_KEY`,
   against an `ANYONE_ANONYMOUS` web app running as the owner. Anyone holding it
   could call `deleteEmployee`. `installer`/`installerId` were caller-supplied
   strings the spine never validated.
2. **The API bill doesn't survive multiplication.** The Routes matrix is billed per
   element (N² per optimize) and guarded only by a per-device localStorage counter.
   Order of magnitude at 200 installers: ~3M elements and ~100k geocodes a month
   against free tiers of 10k each. Self-hosted OSRM + Nominatim already exist in
   `DEPLOY.md` but only `planner.html` uses them.
3. **Nothing pushes.** No polling, SSE or websocket anywhere. Two phones never saw
   each other's work until someone re-opened a list by hand.

Full reasoning, cost figures and the phase plan: see the "Known limits & next phase"
section of `ARCHITECTURE.md`.

---

## Decisions locked with the user — do not re-litigate

| | |
|---|---|
| Auth | H number + **6-digit PIN**, self-signup → owner approves. Not a roster pick. |
| Session | Working week, re-prompt **every Monday** (next Monday 04:00 Toronto, ≥24h out). Not rolling. |
| Roles | Five: Owner, Admin, Foreman, Back-Office, Installer — **capability sets, not a ladder**. |
| Approach | Phased: harden the current stack, keep a seam for a future database. |
| Hosting | Home desktop runs **routing + realtime only** (both degradable). Surface Pro = warm standby. Login and data stay on Apps Script/Sheets for now. |
| Keys | Spine token rotates at the Phase 1 flip. **Maps + ORS rotation deferred to Phase 2** so they rotate once, when they move server-side. |
| Domain | None yet — Phase 2 includes buying one and setting up Cloudflare Tunnel. |
| Scale | ~200 installers, cost kept low. |

The role matrix is in `DEPLOY.md` §"Per-user auth" — that is its home, keep it there.

---

## Done and pushed

**Phase 0 — made credential rotation survivable.**
- `js/queue.js` resolves the credential at **send time** (`authFields()`) instead of
  storing it on each queued item. This is also the migration for items already in
  users' IndexedDB: one destructure key, nothing lost.
- `js/queue-policy.js` gained an `'auth'` verdict. `{ok:false, error:'bad token'}`
  matches neither `busy` nor `retry`, so it used to classify as a *definitive
  reject* and **park every un-synced write on every phone after six attempts** —
  surfaced only as "N stuck" on the pill. A rejected credential is not a poison
  payload.
- `js/pages/capture.js` `resync()` — foreground now pulls as well as pushes. The
  listeners called `flush()` (outbound only), so a phone open all day re-read the
  server zero times. This is the fix for the two-phones complaint at the pull level.
- `deleteDayRows` batches into consecutive runs; `avgDispatchTime` indexes installs
  by `oldJ` instead of scanning every install per request (verified equivalent over
  3000 randomized fixtures — deliberately *not* also windowed, which would change
  which pairs match).

**Phase 1 steps 1 — the gate.**
- `Auth` tab + `setupSheets()`; PIN hashing (iterated HMAC + per-user salt + a
  `PIN_PEPPER` in Script Properties); Monday-anchored sessions; the five roles;
  `POST_POLICY`/`GET_POLICY` over every action (**missing = denied**);
  `authenticate()` wired into `doPost`/`doGet`; `applyScope`.
- **Ships disabled.** Until `REQUIRE_AUTH` is `'true'`, the spine accepts a valid
  session *or* the old shared token, so crew behaviour is unchanged. Flipping it
  back is the rollback, no redeploy.
- `roster()` is projected — it used to hand every installer's home address and GPS
  pin to any caller.
- `DEPLOY.md` documents the three Script Properties, `makeOwner()` bootstrap, the
  migration window and the flip.

**Phase 1 steps 1–2 — the credential lifecycle.** All eight auth actions plus the
`pendingAuth` read are implemented and dispatched; the wrong-PIN ladder is enforced.
The `status` state machine, the four separate privileges, and the reasoning behind
each are in `ARCHITECTURE.md` §"Per-user auth" and `AGENTS.md` §"The auth gate" —
**that is their home, don't restate them here.** Four things worth knowing that
aren't obvious from the diff:

- **`manageableRoles` is new, and it closed a takeover.** `R_ONBOARD` includes
  Back-Office, so without a second bound they could `authResetPin` the *Owner* and
  sign up against the resulting `reset` row as Owner. Every approver action now
  resolves its target through `authTarget`.
- **`makeOwner` now leaves the row in `reset`, not `active`.** Writing `active` with
  no PIN deadlocked the whole rollout (signup refuses an active row, login refuses a
  row with no hash) — the first Owner could never get in. Caught by the bootstrap
  test, which is why that test exists.
- **`authLogin`/`authSignup` dispatch from `UNLOCKED_POST`, ahead of the script
  lock**, and take a short one of their own for the row write. A Monday morning is
  ~200 logins in a few minutes; behind the crew's write lock that stalls the field.
- **`saveEmployee` gained `actFor: R_MANAGE`.** It was `scope:'self'` with the
  default write set, which let a *Foreman* create and rename crew — roster
  management, and contrary to the table its own comment pointed at.

`AUTH_HEADERS` gained `lastFailAt` (the rolling fail window), so `setupSheets()` must
be re-run before this ships — it's additive.

---

**Phase 1 step 3a — the client credential + role model.** `js/auth.js` (session
state, `signIn`/`signUp`/`signOut`, the approver calls, `onAuthChange`) and its pure
half `js/auth-policy.js` (role sets, `canSeePage`, `sessionState`, `loginOutcome`).
Both are in `sw.js` `SHELL`, `CACHE` bumped to v34. Shapes and rules are in
`AGENTS.md` §"Frontend module layout" — three notes that aren't obvious:

- **`authFields()` moved from `js/queue.js` to `js/store.js`.** It now serves the
  direct `api.js` calls too, so there is still exactly one function that decides what
  a request carries. `apiGet` injects it into the query string as well — it used to
  hardcode `token=`.
- **The role sets in `auth-policy.js` are a mirror of `Code.gs`** and exist only to
  hide unusable nav. `tests/auth-client.test.mjs` parses both files and fails on
  drift; if the mirror ever becomes a burden, delete it rather than let it rot.
- **A blank role means "no session yet" and is allowed everything.** That is the
  migration window — hiding the app from a crew that hasn't signed up would be the
  wall this design refuses to build.

---

## Next, in order

1. **The sign-in UI — done, on the capture page.** `js/auth-ui.js` + `css/auth.css`
   inject a dismissible status banner and an `#authSheet` login/signup screen, wired
   into `js/pages/capture.js` and `index.html`, routing every decision through
   `auth-policy.js`'s `bannerFor`/`bannerDismissed`/`signInFeedback`/`signUpFeedback`.
   Verified in a headless browser: the banner, its day-scoped dismissal, the sheet,
   the offline reassurance copy, and capture still working with the banner up.
2. **Per-role nav hiding — done.** `js/nav-roles.js` (`applyRoleNav`/`guardPage`, over
   `canSeePage`/`homePageFor`) is mounted on all seven pages alongside the sign-in
   sheet. Inert while a role is blank, so the migration window still shows everything;
   reads the remembered role, never session validity. It is UI hiding only — the spine
   still re-checks every request. Details in `AGENTS.md` §"Frontend module layout".
3. **An approvals screen — done.** `js/approvals.js` (`rowControls` pure,
   `initApprovals()`/`openApprovals()`) mounts on `index.html`, `reports.html` and
   `map.html` — the pages an R_ONBOARD role can actually open, since `R_CAPTURE` is
   owner/admin/installer and Back-Office reaches `reports.html`/`map.html` via
   `R_VIEW` instead (`map.html` is Back-Office's actual landing page —
   `homePageFor('backoffice')` resolves there). Every action goes through
   `authAction(action, hNumber, extra)`, re-checked server-side through `authTarget`;
   the client duplicates none of the spine's rules. Details in `AGENTS.md`
   §"Frontend module layout".
4. **Rollout** per `DEPLOY.md`, then rotate `SHARED_TOKEN`. **Not yet done — this is
   all that's left of Phase 1.**

Then Phase 2 (edge box + Cloudflare Tunnel + key rotation), Phase 3 (SSE relay),
Phase 4 (bounded tail reads, metrics out of the write lock).

---

## Landmines specific to this work

- **Never let an auth change make a queued write unsendable.** `enqueue()` must
  accept a write with no valid credential, and a credential rejection must never
  park. `tests/queue-auth.test.mjs` guards both. See `AGENTS.md` §"Security note".
- **An existing action's payload may only gain *optional* fields.** A new *required*
  field means a new action name — items already queued won't have it, will be
  definitively rejected, and will park.
- **Roles are sets. Never introduce a numeric level.** Foreman has edit/planner that
  Back-Office lacks; Back-Office has onboarding that Foreman lacks. Neither contains
  the other, so any ordering is wrong and `>=` would silently grant one the other's
  actions. `tests/auth-foundation.test.mjs` fails if a role level appears.
- **Reading for others ≠ writing for others.** `R_READ_ANY` vs `R_ACT_FOR_OTHERS`.
  Back-Office must read the whole crew (that *is* map/analytics) but must never
  write for them. Back-Office's `endOfDay` is a deliberately narrow per-action
  `actFor` override for the reports quick close — do not widen it.
- **`Auth` must never enter `EXPORT_TABS`.** `exportSheetToGithub()` commits every
  listed tab to `data/*.md` and pushes it; that would publish PIN hashes into git
  history. Tested.
- **Nothing on the request hot path may write to the sheet.** `ensureTab()` sets
  formatting and freezes a row — both writes. `authRowFor()` deliberately does not
  call it, and session verification uses the cached `authIndex()` projection rather
  than scanning `Auth` (which also keeps hashes out of shared cache).
- **Offline Monday.** A PIN can only be verified server-side, so a phone with no
  signal on Monday cannot get a session. **The local UI must never be gated on
  session validity** — the app opens, capture works, writes queue. Login is a
  banner, not a wall.
- Standing repo rules still apply: bump `sw.js` `CACHE` when adding a module, and
  unregister the service worker before re-measuring locally (`VERIFY.md`).

---

## Verify

```bash
node --test "tests/*.test.mjs"     # 285 green; no install needed
```

`tests/auth-gate.test.mjs` is the one to read first — it **executes** the real gate
against Apps Script stubs rather than asserting on source text, because a wrong gate
locks 200 people out of a production spine. Its first test is the property that
matters most: while `REQUIRE_AUTH` is off, behaviour is unchanged.

`tests/auth-actions.test.mjs` does the same for the credential lifecycle, over an
in-memory Sheet. It forces `TZ=America/Toronto` at the top on purpose: `Code.gs`
formats timestamps in `TIMEZONE` but parses them back with a component-wise
`new Date(y, m, d, …)`, which reads as *host*-local, and that round-trip is only
exact when the two agree — as they do in Apps Script, where the script timezone
**is** Toronto.

For driving the real pages, and for exercising write paths **without writing to the
production Sheet**, follow `VERIFY.md`. Auth touches every write path, so use a test
deployment against a copy of the Sheet.

Still to write: `tests/session-monday.test.mjs` (the Monday anchor was verified by
an ad-hoc sweep over every hour of 2026 including both DST transitions, but that
check is not yet a permanent test) and `tests/rows-tail.test.mjs` for Phase 4.
