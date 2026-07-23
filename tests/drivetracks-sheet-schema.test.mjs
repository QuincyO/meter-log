import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function headers(name){
  const m = code.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);\\r?\\n`));
  assert.ok(m, `${name} not found in Code.gs`);
  return eval(m[1]);
}

// Cells in saveDriveTrack's positional row literal — line comments stripped so
// prose commas don't count.
function rowCellCount(){
  const fn = code.match(/function saveDriveTrack\(b\)\s*\{[\s\S]*?\n\}/)[0];
  const body = fn.match(/const row = \[([\s\S]*?)\];/)[1]
    .replace(/\/\/[^\n]*/g, '');
  let depth = 0, cells = 1;
  for(const ch of body){
    if('([{'.includes(ch)) depth++;
    else if(')]}'.includes(ch)) depth--;
    else if(ch === ',' && depth === 0) cells++;
  }
  return cells;
}

test('saveDriveTrack writes exactly one cell per DriveTracks header', () => {
  // A positional append: one cell off shifts every later column, so the encoded
  // polyline would land in a numeric column and the replay would silently break.
  assert.equal(rowCellCount(), headers('DRIVETRACKS_HEADERS').length);
});

test('every DriveTracks header is unique', () => {
  const h = headers('DRIVETRACKS_HEADERS');
  assert.equal(new Set(h).size, h.length, 'DRIVETRACKS_HEADERS has a duplicate column');
});

test('the opaque text columns (gaps, encoded) are the last two, in order', () => {
  // setupSheets pins L2:M to text by position; if these move, that pin — and the
  // "don't let Sheets read a leading @ as a formula" guard — points at the wrong
  // columns.
  const h = headers('DRIVETRACKS_HEADERS');
  assert.deepEqual(h.slice(-2), ['gaps', 'encoded']);
  assert.equal(h.indexOf('gaps'), 11, 'gaps must be column L (index 11)');
  assert.equal(h.indexOf('encoded'), 12, 'encoded must be column M (index 12)');
});

test('DriveTracks is created by setupSheets and served by both endpoints', () => {
  assert.match(code, /ensureTab\(ss, 'DriveTracks', DRIVETRACKS_HEADERS\)/);
  assert.match(code, /case 'saveDriveTrack':\s*return json\(saveDriveTrack\(body\)\)/);
  assert.match(code, /p\.action === 'driveTracks'/);
});

test('saveDriveTrack is idempotent on a client-generated id', () => {
  // The leg rides the offline queue; a retry of a write that already landed must
  // ack terminally, never append a second copy.
  const fn = code.match(/function saveDriveTrack\(b\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /idExists\(sh, b\.id\)/);
});
