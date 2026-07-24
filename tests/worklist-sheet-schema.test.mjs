import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function headers(name){
  const m = code.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);\\r?\\n`));
  assert.ok(m, `${name} not found in Code.gs`);
  return eval(m[1]);
}

// The number of top-level cells in saveWorklist's row literal. Line comments are
// stripped first — prose commas there are not columns.
function rowCellCount(){
  const body = code.match(/const added = orders\.map\(\(o, i\) => pad\(\[([\s\S]*?)\]\)\)/)[1]
    .replace(/\/\/[^\n]*/g, '');
  let depth = 0, cells = 1;
  for(const ch of body){
    if('([{'.includes(ch)) depth++;
    else if(')]}'.includes(ch)) depth--;
    else if(ch === ',' && depth === 0) cells++;
  }
  return cells;
}

test('saveWorklist writes exactly one cell per Worklist header', () => {
  // Worklist rows are a POSITIONAL append. One cell too few or too many silently
  // shifts every column after it — pins land in date columns and the corruption
  // only shows up on the next Download.
  assert.equal(rowCellCount(), headers('WORKLIST_HEADERS').length);
});

test('the route-variant and set-aside columns are appended, never inserted', () => {
  // ensureTab() only fills BLANK header cells by position, so a name slotted
  // into the middle renames nothing on an existing sheet and duplicates the
  // tail instead. New columns must go on the end.
  const wl = headers('WORKLIST_HEADERS');
  assert.deepEqual(wl.slice(-2), ['homeLegMetersRoad', 'homeLegMetersStraight'],
    'the per-day home-leg columns are the new tail');
  assert.deepEqual(wl.slice(-11, -2), ['ignored', 'orderRoad', 'dayRoad', 'legMetersRoad',
    'orderStraight', 'dayStraight', 'legMetersStraight',
    'legGeometryRoad', 'legGeometryStraight']);
  assert.equal(wl.indexOf('scheduledWaitMin'), wl.length - 12, 'the pre-existing tail must not move');

  const wp = headers('WORKLIST_PLANS_HEADERS');
  assert.deepEqual(wp.slice(-2), ['routeVariant', 'straightDistanceSource']);
  assert.equal(wp[wp.length - 3], 'updated', 'updated keeps its original position');
});

test('every Worklist header is unique', () => {
  for(const name of ['WORKLIST_HEADERS', 'WORKLIST_PLANS_HEADERS']){
    const h = headers(name);
    assert.equal(new Set(h).size, h.length, `${name} has a duplicate column`);
  }
});

test('the nightly order repair leaves the saved route variants alone', () => {
  // normalizeWorklistOrders renumbers the LIVE `order` column only. A variant's
  // positions are indexes into its own sequence and are paired with the leg
  // distances measured for it — renumbering them would desync the two.
  const fn = code.match(/function normalizeWorklistOrdersCore\(\)\s*\{[\s\S]*?\n\}/)[0];
  for(const col of ['orderRoad', 'orderStraight', 'legMetersRoad', 'legMetersStraight'])
    assert.doesNotMatch(fn, new RegExp(col));
});

test('the nightly done-sweep never removes a set-aside order', () => {
  // Set aside is a separate column precisely so it survives this sweep; folding
  // it into wlStatus would delete the orders the crew parked for later.
  const fn = code.match(/function clearDoneWorklistJob\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(fn, /ignored/);
  assert.match(fn, /'done'/);
});
