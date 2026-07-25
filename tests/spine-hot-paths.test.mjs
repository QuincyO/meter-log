// Guards two hot-path fixes in Code.gs that are easy to "simplify" back into the
// slow shape they replaced. Both matter because they run inside the global write
// lock, during the quitting-time burst when the whole crew closes out at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const fn = name => {
  const m = CODE.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name}() should exist in Code.gs`);
  return m[0];
};

test('deleteDayRows deletes in runs, not one row at a time', () => {
  const src = fn('deleteDayRows');
  // Each deleteRow() is its own round-trip to the Sheets backend. A day's ~10
  // Timing rows meant ~10 serialized round-trips inside the write lock, on every
  // close and every regenerate. saveWorklist already avoids the same pattern.
  assert.ok(!/\bsh\.deleteRow\s*\(/.test(src),
    'deleteDayRows must not call the single-row deleteRow() — use deleteRows(start, count)');
  assert.match(src, /sh\.deleteRows\(/,
    'deleteDayRows should batch with deleteRows(startRow, howMany)');
  assert.match(src, /if \(!doomed\.length\) return;/,
    'a no-match call should return before busting the row memo');
});

test('avgDispatchTime indexes installs by oldJ instead of scanning them per request', () => {
  const src = fn('avgDispatchTime');
  // Was O(Dispatch x Stops) over the lifetime of both tabs, re-run hourly by
  // avgDispatchTimeJob while holding the script lock.
  assert.match(src, /const byOldJ = \{\}/,
    'installs should be bucketed by oldJ');
  assert.match(src, /byOldJ\[k\]\.sort\(/,
    'each bucket must be sorted by time so the first unused hit is the earliest');
  assert.ok(!/installs\.forEach\(inst => \{\s*if \(inst\.used \|\| inst\.oldJ !== oldJ/.test(src),
    'the per-request full scan over every install must be gone');
  // The pairing rule itself is unchanged and load-bearing: earliest unused install
  // at or after the request time. Two requests for one meter must not both claim it.
  assert.match(src, /if \(inst\.used \|\| inst\.t < t\) continue;/,
    'a candidate must still be skipped when already used or earlier than the request');
});
