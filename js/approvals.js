// ── The approvals screen ────────────────────────────────────────────────────
// Renders the pendingAuth queue and runs the six approver actions. Mounted on
// index.html (an owner/admin approving from a phone on shift) and reports.html
// (Back-Office, who holds R_ONBOARD but cannot open the capture page).
//
// IT DUPLICATES NO RULE FROM Code.gs. `manageable` and `grantable` ride in on the
// response and are advisory; every action is re-checked server-side through
// authTarget. The screen shows what the spine said it may show, and shows the
// spine's refusal verbatim when that turns out to be wrong.

/** Which controls a row gets. Pure. Mirrors what the spine will actually accept,
 *  so the screen never offers a button that is guaranteed to be refused —
 *  which is a UI concern, not a security one. */
export function rowControls(user, grantable) {
  const roles = Array.isArray(grantable) ? grantable : [];
  if (!user || !user.manageable)
    return { approve: false, reject: false, resetPin: false, unlock: false,
             revoke: false, setRole: false, roles: [] };
  const status = String(user.status || '').trim();
  return {
    approve:  status === 'pending',
    // authReject refuses an active row outright ("revoke instead of rejecting").
    reject:   status === 'pending',
    // authResetPin refuses anything not already approved, to avoid parking a
    // pending row in 'reset' — where the next signup activates unapproved.
    resetPin: status === 'active' || status === 'reset',
    unlock:   !!user.locked,
    revoke:   status !== 'disabled',
    setRole:  roles.length > 0 && status !== 'disabled',
    roles:    roles,
  };
}
