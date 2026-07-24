import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

test('settings shows a read-only starting-location field under the home address', () => {
  assert.match(html, /id="cfgStart"[^>]*readonly/);
  // it sits after the home address input
  assert.ok(html.indexOf('id="cfgHome"') < html.indexOf('id="cfgStart"'),
    'the starting-location field must come after home address');
});

test('the crew start is pulled from the roster and painted read-only', () => {
  // cached from the team the installer belongs to, then painted.
  assert.match(capture, /store\.set\('crewStartAddress'/);
  assert.match(capture, /team\.startAddress/);
  assert.match(capture, /function paintStartField/);
  assert.match(capture, /\$\('cfgStart'\)/);
  assert.match(capture, /el\.value = start/);
  // painted when Settings opens.
  assert.match(capture, /paintStartField\(\)/);
});
