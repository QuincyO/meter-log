# Auth setup & rollout

Per-user logins, enforced in `Code.gs`. The static pages already ship `SHARED_TOKEN`
in public source, so that token is **not** the gate — these signed per-user sessions
are. Everything here is $0 (Apps Script + Sheets + Script Properties). Full design:
`ARCHITECTURE.md` §"Auth".

The order below is deliberate: **the backend ships dormant** (the `ENFORCE_AUTH` flag
is off), so nothing breaks while you set up. You only flip enforcement on at the end,
once you can log in — and you can flip it off again instantly if anything misbehaves.

---

## One-time setup

1. **Deploy the new `Code.gs`.** Push this branch's `Code.gs` (CI auto-deploys in
   place) or paste it into the Apps Script editor and redeploy. Nothing changes yet —
   `ENFORCE_AUTH` is unset, so every existing call still works.

2. **Generate the server secrets.** In the Apps Script editor, run **`generateAuthSecrets`**
   once. Confirm under *Project Settings ▸ Script Properties* that `AUTH_PEPPER` and
   `AUTH_SIGNING_KEY` now exist. (Never share, commit, or overwrite these. Re-running
   the function is safe — it won't overwrite existing values.)

3. **Create the tabs.** Run **`setupSheets`** once. It adds the `Users` and `Access`
   tabs (and leaves every existing tab untouched). Leave `Access` empty — the built-in
   `DEFAULT_ACCESS` fallback governs until you choose to customize it.

4. **(Optional) Tune the hash cost.** Run **`benchmarkHash`** and read the log. If it
   reports much more than ~800 ms, lower `DEFAULT_ITERATIONS` in `Code.gs` (top of the
   Auth section) and redeploy; much less, you can raise it.

5. **Create the first supervisor (you).** In the editor, run a one-off like:
   ```js
   function makeMe(){ return createUser('quincy', 'a-strong-temp-password', 'supervisor', 'Quincy Orta', 'H123'); }
   ```
   - `displayName` (3rd-from-last arg) **must equal that person's full name in the
     `Employees` tab** — installer-ownership compares it. For a supervisor it only
     needs to be a sensible display label.
   - `hNumber` links the login to its `Employees` row.
   Then run **`testLogin('quincy','a-strong-temp-password')`** and check the log: you
   should see `ok:true` with a `session`, and a decoded `verifyToken` payload.
   Run **`testForged('quincy','a-strong-temp-password')`** — it must print
   `forged → rejected`.

6. **Deploy the frontend.** It's already in this branch (the `login.html` page, the
   gates, the session plumbing, the bumped service worker). Once it's live, visiting any
   page with no session sends you to `login.html`.

7. **Flip enforcement on.** Add a Script Property **`ENFORCE_AUTH` = `true`**
   (*Project Settings ▸ Script Properties ▸ Add*). No redeploy needed. Now every
   write/read requires a valid session. To roll back instantly, set it to `false` (or
   delete it).

8. **Provision the crew.** For each person run `createUser(username, tempPassword,
   'installer', 'First Last', 'Hxxx')` (displayName = their `Employees` full name).
   Hand out credentials; they sign in at `login.html`.

---

## Verifying it (curl)

`URL` = the `/exec` from `js/config.js`; `TOKEN` = `SHARED_TOKEN` from `js/config.js`.

```bash
# Login → expect {"ok":true,"session":"…","role":"supervisor",…}
curl -s "$URL" -H 'Content-Type: text/plain' \
  -d '{"token":"TOKEN","action":"login","username":"quincy","password":"a-strong-temp-password"}'

# Wrong password → {"ok":false,"error":"bad credentials"}  (6th try → "locked")

# With ENFORCE_AUTH on, a write bearing a garbage session → {"ok":false,"error":"auth"}
curl -s "$URL" -H 'Content-Type: text/plain' \
  -d '{"token":"TOKEN","action":"addStop","session":"not.a.real.token","installer":"x","timestamp":"2026-06-28 09:00:00","workOrderId":"1","status":"INSTALLED"}'

# A real session from the login response → the write succeeds.
```

In a browser (served over http, pointing at the live `/exec`): no session on
`edit.html` redirects to login. Sign in as an **installer** → capture works,
`teams.html` bounces, `edit.html`'s picker is locked to them, `map.html` hides other
installers' specific numbers. Sign in as a **supervisor** → all four pages, full
pickers and the per-installer breakdown.

---

## Day-to-day (all from the Apps Script editor)

| Need | Run |
|------|-----|
| Add a user | `createUser('username','tempPass','installer'\|'supervisor','First Last','Hxxx')` |
| Reset a password | `setPassword('username','newPass')` |
| Change a role | `setRole('username','supervisor')` |
| Disable someone | `deactivateUser('username')` — takes effect at their next login or token expiry |
| List users | `listUsers()` (View ▸ Logs) |
| Force-log-out **everyone** now | delete `AUTH_SIGNING_KEY`, run `generateAuthSecrets` (passwords survive) |
| Change who-can-do-what | edit the **`Access`** tab (no redeploy) |

### Editing the `Access` policy
One row per role: `role`, `actions`, `pages`, `tokenDays`, `active`.
- `actions` / `pages` — space- or comma-separated, or `*` for all. Add the pseudo-action
  `editAnyInstaller` to a role to let it read/write **anyone's** logs (that's what makes
  a "supervisor"). `pages` are `index map teams edit`.
- `tokenDays` — a number of days, **or** the literal `monday` (expire next Monday 00:00
  Toronto). Defaults: installer `monday`, supervisor `30`.
- Leave the tab empty to use the built-in defaults. Every role used in `Users.role` must
  have an `Access` row (or be covered by the default), or that user can do nothing but log in.

---

## Notes / limits
- **Map privacy is UI-only.** An installer's browser still receives the raw analytics
  data; `map.js` just hides other installers' specific numbers. A technical installer
  could read them in DevTools. The write-protection (the main goal) is hard-enforced.
- **Tokens are stateless.** Deactivating a user or changing their role only takes hold
  when their current token expires (≤ a week for installers) — unless you rotate
  `AUTH_SIGNING_KEY` to invalidate all sessions at once.
- **Never** move the token into an `Authorization`/custom header — it would trigger a
  CORS preflight the app deliberately avoids. It belongs in the request body / query.
