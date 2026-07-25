// The approvals screen. `manageable` and `grantable` are advisory — the spine
// re-checks every action server-side. This function exists only so the screen does
// not offer a button that is guaranteed to be refused, which is a UI concern, not
// a security one.

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
    approve:  status === 'pending',  // deliberately not wider; see comment in Code.gs authApprove
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
