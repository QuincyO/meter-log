// The approvals screen. `manageable` and `grantable` are advisory — the spine
// re-checks every action server-side. This function exists only so the screen does
// not offer a button that is guaranteed to be refused, which is a UI concern, not
// a security one.

/** Which action buttons a row gets, based on status, lock state, and role
 *  grantability. Pure and testable. */
export function rowControls(user, grantable) {
  const roles = Array.isArray(grantable) ? grantable : [];
  if (!user || !user.manageable)
    return { approve: false, reject: false, resetPin: false, unlock: false,
             revoke: false, setRole: false, roles: [] };
  const status = String(user.status || '').trim();
  return {
    // The spine would accept approving a disabled row with its old PIN intact
    // (authApprove only short-circuits on 'active'). This screen does not offer that —
    // Reject wipes the PIN and frees the H number for fresh signup, preventing silent
    // credential resurrection. Product decision, not an oversight; do not widen.
    approve:  status === 'pending',
    // Reject frees the H number in three cases: typo'd signup (pending), stalled reset
    // (reset), or revoked account (disabled). authReject refuses an active row.
    reject:   status === 'pending' || status === 'reset' || status === 'disabled',
    // authResetPin refuses anything not already approved, to avoid parking a
    // pending row in 'reset' — where the next signup activates unapproved.
    resetPin: status === 'active' || status === 'reset',
    unlock:   !!user.locked,
    revoke:   status !== 'disabled',
    setRole:  roles.length > 0 && status !== 'disabled',
    roles:    roles.slice(),
  };
}
