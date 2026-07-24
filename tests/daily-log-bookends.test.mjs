import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const capture = text('js/pages/capture.js');
const codeGs  = text('Code.gs');

// The daily-log PDF is drawn from previewDailyLog's summary. buildDaySummary reads
// departure/returned from the request body, falling back to the persisted Days row.
// On the phone, saveDay runs AFTER the PDF is generated, so the Days row is still
// empty at preview time — every previewDailyLog call from the phone MUST pass the
// typed bookends or the PDF prints blank Start / End times (the field-reported bug).
test('every phone previewDailyLog call carries the typed departure/returned', () => {
  const calls = [...capture.matchAll(/action:'previewDailyLog'[\s\S]{0,260}?\}\)/g)];
  assert.ok(calls.length >= 2, `expected ≥2 previewDailyLog calls, found ${calls.length}`);
  for (const m of calls) {
    assert.match(m[0], /departure:\s*\$\('eodDeparture'\)\.value/,
      'previewDailyLog call is missing the departure bookend');
    assert.match(m[0], /returned:\s*\$\('eodReturned'\)\.value/,
      'previewDailyLog call is missing the returned bookend');
  }
});

// The spine side of the contract: buildDaySummary must prefer the body's bookends
// over the (still-empty-at-preview) Days row, or passing them would achieve nothing.
test('buildDaySummary prefers the request bookends over the Days row', () => {
  assert.match(codeGs, /const departure = b\.departure \|\| persisted\.departure/);
  assert.match(codeGs, /const returned  = b\.returned  \|\| persisted\.returned/);
});
