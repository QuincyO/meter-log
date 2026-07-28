import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const code = text('Code.gs');
const worker = text('sw.js');
const architecture = text('ARCHITECTURE.md');
const deploy = text('DEPLOY.md');
const guide = text('USER-GUIDE.md');

// A column appended to a live InstallerMetrics sheet inherits the format of the one
// it lands beside, and the one it lands beside is `updated` — a datetime. So every
// appended minute count arrives date-formatted: 28 is STORED as 28 and read back by
// getValues() as a Date, JSON'd as "1900-01-27T…", and Number()'d to NaN by
// js/route-dwell.js — which silently falls back to the old pace guess. This repair
// used to name the three recent-30 columns literally, so it had to be hand-edited on
// every schema addition; it wasn't, and the whole measured-dwell block shipped that
// way. It is a deny-list of the real date columns now, and these tests hold it there.
function metricsNumberCols(headers) {
  const deny = code.match(/^const INSTALLER_METRICS_DATE_HEADERS = (\[[\s\S]*?\]);$/m);
  const fn = code.match(/^function installerMetricsNumberCols\([\s\S]*?^\}$/m);
  assert.ok(deny && fn, 'Code.gs no longer declares the InstallerMetrics format repair');
  return new Function(`const INSTALLER_METRICS_DATE_HEADERS = ${deny[1]};
    ${fn[0]}
    return installerMetricsNumberCols(${JSON.stringify(headers)});`)();
}

function installerMetricsHeaders() {
  const keys = code.match(/const INSTALLER_METRIC_KEYS = (\[[\s\S]*?\]);\r?\n/);
  const decl = code.match(/const INSTALLER_METRICS_HEADERS = ([\s\S]*?);\r?\n\r?\n/);
  assert.ok(keys && decl, 'InstallerMetrics header declarations not found in Code.gs');
  return new Function(`const INSTALLER_METRIC_KEYS = ${keys[1]};
    return ${decl[1].replace(/\/\/[^\n]*/g, '')};`)();
}

test('the format repair covers every non-date InstallerMetrics column', () => {
  const headers = installerMetricsHeaders();
  const cols = metricsNumberCols(headers);

  // The three genuine dates keep their date format — repairing them would be the
  // mirror-image bug (a real Date rendered as a 46000-ish serial).
  for (const header of ['firstDay', 'lastDay', 'updated']) {
    assert.ok(!cols.includes(headers.indexOf(header) + 1), `${header} must stay date-formatted`);
  }
  // Everything else, including both appended blocks and anything appended next.
  headers.forEach((h, i) => {
    if (['firstDay', 'lastDay', 'updated'].includes(h)) return;
    assert.ok(cols.includes(i + 1), `InstallerMetrics column ${h} is left un-repaired`);
  });
});

test('the repair reads the columns off the live sheet and keeps fractions', () => {
  const setup = code.slice(code.indexOf('function setupSheets()'), code.indexOf('function ensureTab('));

  // By header off the real sheet, so a schema addition/reordering can't turn a fixed
  // column index into the wrong one.
  assert.match(setup, /getLastColumn\(\).*getValues\(\).*map/s);
  assert.match(setup, /getMaxRows\(\)\s*-\s*1/);
  assert.match(setup, /installerMetricsNumberCols\(metricHeaders\)/);
  // Not '0': hoursWorked (142.5), avgPerHour (0.7) and travelMinPerKm (7.2) are
  // fractional, and an integer format would display them rounded.
  assert.match(setup, /setNumberFormat\('0\.#+'\)/);
});

test('the service-worker cache includes planner services, route variants and drive mode', () => {
  // The version is pinned so that adding a module forces the CACHE bump that
  // actually ships it; bump it here too. (The title used to name a version and
  // drifted a release behind — don't put it back.)
  assert.match(worker, /const CACHE = 'meterlog-v38';/);
  assert.match(worker, /['\"]\.\/js\/planner-services\.js['\"]/);
  // A new shared module only reaches phones if it is in SHELL and CACHE moved.
  assert.match(worker, /['\"]\.\/js\/route-variants\.js['\"]/);
  assert.match(worker, /['\"]\.\/js\/route-today\.js['\"]/);
  assert.match(worker, /['\"]\.\/js\/drive\.js['\"]/);
  assert.match(worker, /['\"]\.\/js\/drive-track\.js['\"]/);
  assert.match(worker, /['\"]\.\/js\/drive-recorder\.js['\"]/);
  assert.match(worker, /['\"]\.\/css\/drive\.css['\"]/);
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
