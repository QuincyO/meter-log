// ── Per-role nav hiding and the wrong-page guard ────────────────────────────
// A thin DOM layer over canSeePage/homePageFor in auth-policy.js. It hides links
// a role cannot use, because a menu entry that always answers "not allowed for
// your role" is worse than no entry at all.
//
// IT IS NOT A SECURITY BOUNDARY. The role sets it reads are a mirror of Code.gs
// kept only for this purpose; the spine re-checks every request through
// POST_POLICY/GET_POLICY, which is the only authority.
//
// Two properties are load-bearing:
//   1. A BLANK ROLE SEES EVERYTHING. That is the migration window — until people
//      sign up, it is the entire crew. roleAllows() handles this; do not add a
//      check here that bypasses it.
//   2. It reads the REMEMBERED role, never session validity. authRole survives
//      expiry on purpose so the nav stays correct on a phone with no signal.
import { canSeePage, homePageFor } from './auth-policy.js';
import { role } from './auth.js';
import { toast } from './dom.js';

/** Jump-menu <option> value → the page it opens. `analytics` is map.html#analytics,
 *  so it shares map.html's permission; a value missing from here is left alone. */
export const NAV_PAGES = {
  log:       'index.html',
  map:       'map.html',
  analytics: 'map.html',
  teams:     'teams.html',
  edit:      'edit.html',
  reports:   'reports.html',
  planner:   'planner.html',
  help:      'help.html',
};

/** Pure: which of these nav values a role should still see. An unrecognised value
 *  survives — a new menu entry should appear until someone maps it, not vanish. */
export function visibleNavValues(values, roleName) {
  return (values || []).filter(v => {
    const page = NAV_PAGES[v];
    return !page || canSeePage(page, roleName);
  });
}

/** The current page's filename, defaulting to index.html for a bare directory. */
export function currentPage() {
  const path = (typeof location !== 'undefined' && location.pathname) || '';
  return path.replace(/^.*\//, '') || 'index.html';
}

const REDIRECT_KEY = 'navRedirectMsg';

/** Send someone off a page their role cannot open. Returns false when a redirect
 *  has been started — but `location.replace()` does not halt synchronous execution,
 *  so the caller's own init still runs to completion before the navigation commits.
 *  That is harmless (the destination re-fetches cleanly) and no caller relies on the
 *  return value to skip anything; it exists so the redirect is issued as early as
 *  the caller cares to check.
 *  Never dead-ends: homePageFor always names a page the role can open, and an
 *  equal destination is left alone rather than reloaded forever. */
export function guardPage() {
  const page = currentPage();
  const r = role();
  if (canSeePage(page, r)) return true;
  const dest = homePageFor(r);
  if (!dest || dest === page) return true;
  // The toast has to survive the navigation, so it is handed to the destination.
  try { sessionStorage.setItem(REDIRECT_KEY,
    `That page isn't part of your role — opened ${dest} instead`); } catch {}
  location.replace(dest);
  return false;
}

/** Drop the nav entries this role cannot use, and deliver any redirect notice. */
export function applyRoleNav() {
  const r = role();
  // Delivered first, ahead of the filtering below: if anything past this point
  // threw, the notice would never reach this page and would sit in sessionStorage
  // to surface out of context on whatever page loads next.
  deliverRedirectNotice();
  // Map.html predates the shared jump menu and calls its control a view selector
  // (#viewSel); the other back-office pages use #navSel. Query both so filtering
  // works regardless of which page called this, and so a third variant is a
  // one-token change rather than a new branch.
  for (const sel of document.querySelectorAll('#navSel, #viewSel')) {
    for (const opt of [...sel.options]) {
      const page = NAV_PAGES[opt.value];
      if (page && !canSeePage(page, r)) opt.remove();
    }
  }
  const help = document.getElementById('navHelp');
  // Currently unreachable: PAGE_ROLES['help.html'] is the full ROLES list and
  // roleAllows lets a blank role through too, so canSeePage('help.html', r) is
  // true for every role this app has. Kept as defence, not as live filtering.
  if (help && !canSeePage('help.html', r)) help.classList.add('hide');
}

function deliverRedirectNotice() {
  let msg = null;
  try {
    msg = sessionStorage.getItem(REDIRECT_KEY);
    if (msg) sessionStorage.removeItem(REDIRECT_KEY);
  } catch { /* private mode — the redirect still happened, just silently */ }
  if (msg) toast(msg);
}
