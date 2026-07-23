import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const code = text('Code.gs');
const worker = text('sw.js');
const architecture = text('ARCHITECTURE.md');
const deploy = text('DEPLOY.md');
const guide = text('USER-GUIDE.md');

test('setup formats recent-30 InstallerMetrics fields by their header names', () => {
  const setup = code.slice(code.indexOf('function setupSheets()'), code.indexOf('function ensureTab('));

  for (const header of ['recent30AvgLogMin', 'boatRecent30AvgLogMin', 'landRecent30AvgLogMin']) {
    assert.match(setup, new RegExp(`['\"]${header}['\"]`));
  }
  assert.match(setup, /getLastColumn\(\).*getValues\(\).*indexOf/s);
  assert.match(setup, /getMaxRows\(\)\s*-\s*1/);
  assert.match(setup, /const col = metricHeaders\.indexOf\(header\);/);
  assert.match(setup, /if \(col !== -1\) installerMetrics\.getRange\(2, col \+ 1, metricDataRows, 1\)\.setNumberFormat\(['\"]0['\"]\);/);
});

test('the service-worker cache includes planner services and route variants at v26', () => {
  assert.match(worker, /const CACHE = 'meterlog-v26';/);
  assert.match(worker, /['\"]\.\/js\/planner-services\.js['\"]/);
  // A new shared module only reaches phones if it is in SHELL and CACHE moved.
  assert.match(worker, /['\"]\.\/js\/route-variants\.js['\"]/);
});

test('planner documentation explains live provider provenance and persistent results', () => {
  assert.match(architecture, /Nominatim.*localhost:8080|localhost:8080.*Nominatim/is);
  assert.match(architecture, /usable HTTP response/i);
  assert.match(architecture, /pre-optimize confirmation/i);
  assert.match(architecture, /plannerLastOptimize/);
  assert.match(architecture, /provenance/);
  assert.match(architecture, /osrmReady/);

  assert.match(deploy, /Nominatim.*localhost:8080|localhost:8080.*Nominatim/is);
  assert.match(deploy, /OSRM.*badge|badge.*OSRM/is);
  assert.match(deploy, /table\/v1\/driving/);
  assert.match(deploy, /status\?format=json/);
  assert.match(deploy, /timeout/i);
  assert.match(deploy, /running container.*offline|Docker-status/is);
  assert.match(deploy, /confirmation/i);
  assert.match(deploy, /Last optimization/i);
  assert.match(deploy, /Matrix\/straight-line/i);
  assert.match(deploy, /setupSheets\(\).*recent-30|recent-30.*setupSheets\(\)/is);
  assert.match(deploy, /no deletion.*backfill|no backfill.*deletion/is);

  assert.match(guide, /Last optimization/i);
  assert.match(guide, /Matrix.*Straight-line|Straight-line.*Matrix/is);
  assert.match(guide, /Local.*Google.*ORS|Google.*ORS.*Local/is);
  assert.match(guide, /confirmation/i);
});
