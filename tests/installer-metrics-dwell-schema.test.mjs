// Schema guards for the measured-dwell block on InstallerMetrics. Every failure
// mode here is silent in production: the phone keeps working, keeps showing ETAs,
// and simply goes on using the old pace guess forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

const DWELL_FIELDS = ['onSiteMin', 'extraMeterMin', 'travelMinPerKm', 'onSiteSource'];

function metricsHeaders(){
  // INSTALLER_METRICS_HEADERS is built by .concat() chains, so evaluate it with the
  // one array it depends on rather than pattern-matching a literal.
  const keys = code.match(/const INSTALLER_METRIC_KEYS = (\[[\s\S]*?\]);\r?\n/);
  const decl = code.match(/const INSTALLER_METRICS_HEADERS = ([\s\S]*?);\r?\n\r?\n/);
  assert.ok(keys && decl, 'InstallerMetrics header declarations not found in Code.gs');
  return new Function(`const INSTALLER_METRIC_KEYS = ${keys[1]};
    return ${decl[1].replace(/\/\/[^\n]*/g, '')};`)();
}

test('every dwell field exists in all three work-mode column groups', () => {
  const headers = metricsHeaders();
  for(const f of DWELL_FIELDS){
    const cap = f[0].toUpperCase() + f.slice(1);
    for(const col of [f, 'boat' + cap, 'land' + cap]){
      assert.ok(headers.includes(col), `InstallerMetrics is missing the ${col} column`);
    }
  }
});

test('the dwell columns are appended after the established ones', () => {
  // ensureTab() only fills header cells that are BLANK at a given position, so a
  // name slotted into the middle renames nothing on an existing sheet and
  // duplicates the tail instead. New columns must land at the end.
  const headers = metricsHeaders();
  const firstDwell = Math.min(...DWELL_FIELDS.map(f => headers.indexOf(f)));
  assert.ok(firstDwell > headers.indexOf('recent30AvgLogMin'),
    'the dwell block must come after the recent30AvgLogMin block');
  assert.ok(headers.indexOf('avgLogMin') < firstDwell,
    'the dwell block must come after the original metric keys');
});

test('installerMetricsRead projects every dwell field down to its canonical name', () => {
  // The phone reads THROUGH this projection with workType=land. A field added to
  // the headers but forgotten here simply never reaches the route model — no error,
  // no wrong number, just a measurement that silently never applies.
  const body = code.match(/function installerMetricsRead\([\s\S]*?\n\}/);
  assert.ok(body, 'installerMetricsRead not found');
  for(const f of DWELL_FIELDS){
    assert.ok(body[0].includes(`'${f}'`),
      `installerMetricsRead does not project ${f} for boat/land`);
  }
});

test('refreshInstallerMetrics fills the dwell block on every write', () => {
  const body = code.match(/function refreshInstallerMetrics\([\s\S]*?\n\}/);
  assert.ok(body, 'refreshInstallerMetrics not found');
  assert.ok(/applyOnSiteMetrics\(row, nm\)/.test(body[0]),
    'refreshInstallerMetrics must call applyOnSiteMetrics, or the columns stay blank forever');
});

test('the siteDwell read is wired into doGet', () => {
  const body = code.match(/function doGet\([\s\S]*?\n\}/);
  assert.ok(body, 'doGet not found');
  assert.ok(/p\.action === 'siteDwell'/.test(body[0]), 'doGet does not serve ?action=siteDwell');
  assert.ok(/crewSiteDwell\(/.test(body[0]), 'the siteDwell action must call crewSiteDwell');
});

test('onSiteSource uses the documented vocabulary', () => {
  // 'gps' | 'fit' | 'pace' — the readouts branch on these exact strings.
  const body = code.match(/function applyOnSiteMetrics\([\s\S]*?\n\}/);
  assert.ok(body, 'applyOnSiteMetrics not found');
  for(const v of ["'gps'", "'fit'", "'pace'"]){
    assert.ok(body[0].includes(v), `applyOnSiteMetrics never produces ${v}`);
  }
});
