import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html    = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js      = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const css     = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');
const planner = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');

// The phone's Optimize measures real roads or it does not run. A tap used to fall
// back to straight-line distances when no district was downloaded — a route that
// looks solved and is blind to every river and dead end, with nothing on screen
// saying so. The district is a precondition now.

test('a tap with no district downloaded is refused, not quietly crow-flied', () => {
  assert.match(js, /if\(!useNetwork && !havePack\)\{/);
  assert.match(js, /Download your district first — Settings ▸ Offline road map/);
});

test('the HOLD is deliberately exempt — it is the only second opinion there is', () => {
  // It skips the pack by design (noLocalGraph) and asks a router that has the
  // turn restrictions the pack lacks. Gating it too would leave a crew with a
  // suspect on-device route and no way to check it.
  assert.match(js, /if\(!useNetwork && !havePack\)\{/);
  assert.doesNotMatch(js, /if\(!havePack\)\{/);
});

test('the gate reads installedPacks(), never the settings pointer', () => {
  // AGENTS.md: havePack has to mean what the router will DO. activePackId() can
  // be blank on a phone holding a perfectly good district, and this gate would
  // then refuse a run it can measure.
  assert.match(js, /const havePack = \(\(await installedPacks\(\)\) \|\| \[\]\)\.length > 0;/);
  assert.doesNotMatch(js, /havePack = .*activePackId/);
});

test('a pack-less tap can no longer reach the straight-line ladder', () => {
  // The refusal above is the only thing standing between the crew and a
  // crow-flies route, so the dead branches that used to announce one are gone.
  assert.doesNotMatch(js, /'straight-line algorithm'/);   // the string, not the comment recalling it
  assert.match(js, /const algorithm = useNetwork\s*\n\s*\? 'Google road distances[^']*'\s*\n\s*: 'offline road map on this phone';/);
});

test('the offline refusal points at the download, not at a tap that now fails', () => {
  assert.match(js, /if\(!navigator\.onLine && \(useNetwork \|\| !\(havePack && alreadyPinned >= 2\)\)\)\{/);
  assert.match(js, /tap Optimize to use the offline map/);              // hold, pack on hand
  assert.match(js, /download your district on wifi first/);             // hold, no pack
  assert.doesNotMatch(js, /tap Optimize for straight-line/);
});

// ── saying so before anyone presses it ──────────────────────────────────────

test('the gated state is painted on the button and explained under it', () => {
  assert.match(js, /async function paintOptimizeGate\(\)\{/);
  assert.match(js, /btn\.classList\.toggle\('gated', !have\)/);
  assert.match(js, /btn\.setAttribute\('aria-disabled', have \? 'false' : 'true'\)/);
  assert.match(html, /id="wlOptimizeGate"/);
  assert.match(css, /#wlOptimize\.gated\{/);
});

test('the gate paint never disables the button — that would kill the hold', () => {
  // A disabled button fires no pointer events at all: the two-second hold (which
  // legitimately still works with no district) and the tap's own explanatory
  // toast would both go dead. `disabled` on this button belongs to the run.
  const fn = js.match(/async function paintOptimizeGate\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'paintOptimizeGate is gone');
  assert.doesNotMatch(fn[0], /\.disabled\s*=/);
  const rule = css.match(/#wlOptimize\.gated\{[^}]*\}/);
  assert.ok(rule, 'the #wlOptimize.gated rule is gone');
  assert.doesNotMatch(rule[0], /pointer-events\s*:\s*none/);
});

test('every worklist render repaints it, so a fresh download clears the notice', () => {
  assert.match(js, /await paintOptimizeGate\(\);/);
  assert.match(js, /export async function renderWorklist\(\)\{[\s\S]*?await paintOptimizeGate\(\);/);
});

test('downloading a district in Settings clears the notice behind it', () => {
  // The ☰ nav lives OUTSIDE captureMain, so Settings can be opened over the
  // worklist screen and closed again without that screen re-rendering. Without
  // this the crew downloads a map and comes back to a button still greyed out
  // and still telling them to download one. paintRoadPacks is the one place
  // both the download and the delete funnel through.
  const capture = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');
  assert.match(capture, /import \{[^}]*paintOptimizeGate[^}]*\} from '\.\.\/worklist\.js'/);
  assert.match(capture, /async function paintRoadPacks\(\)\{[\s\S]*?paintOptimizeGate\(\);/);
  assert.match(js, /export async function paintOptimizeGate\(\)\{/);
});

test('the desktop planner is not gated — it routes against a local OSRM', () => {
  assert.doesNotMatch(planner, /installedPacks/);
  assert.doesNotMatch(planner, /Offline road map/);
});
