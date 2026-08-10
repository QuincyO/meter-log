import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectNotes } from '../js/dailylog.js';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// The daily-log PDF is drawn top-down and stops after the totals row, so the
// bottom of the page is blank. collectNotes gathers the day's free-text remarks —
// end-of-day, downtime, and per-stop — that drawNotesBlock prints into that space.
test('collectNotes gathers end-of-day, downtime, and per-stop notes', () => {
  const notes = collectNotes({
    notes: 'Wrapped up early, tide came in.',
    downtime: [
      { category: 'OTHER', minutes: 20, workOrderId: 'WO7', note: 'Ferry was late.' },
    ],
    stops: [
      { workOrderId: 'WO7', address: '12 Bay St', timestamp: '2026-08-10 09:00', notes: 'Dog in yard.' },
    ],
  });
  const texts = notes.map(n => n.text);
  assert.ok(texts.includes('Wrapped up early, tide came in.'), 'end-of-day note missing');
  assert.ok(texts.includes('Ferry was late.'), 'downtime note missing');
  assert.ok(texts.includes('Dog in yard.'), 'per-stop note missing');
  // End-of-day note leads the block.
  assert.equal(notes[0].label, 'End of day');
  // Downtime label carries the category, WO#, and minutes for context.
  const dt = notes.find(n => n.text === 'Ferry was late.');
  assert.match(dt.label, /Other/);
  assert.match(dt.label, /WO7/);
  assert.match(dt.label, /20 min/);
});

// The downtime `note` column is overloaded: the EOD travel review writes
// `gap HH:MM–HH:MM` machine tags into it (Code.gs saveTravel). Those are not human
// remarks and must never leak into the printed Notes block.
test('collectNotes skips gap machine-tags from the travel review', () => {
  const notes = collectNotes({
    downtime: [
      { category: 'DISPATCH', minutes: 8, workOrderId: 'WO3', note: 'gap 09:10–09:25' },
      { category: 'OTHER', minutes: 5, note: 'Real note.' },
    ],
  });
  assert.equal(notes.length, 1, 'gap tag should be excluded');
  assert.equal(notes[0].text, 'Real note.');
});

// Nothing to say → nothing drawn (drawNotesBlock is a no-op on an empty list).
test('collectNotes returns [] when there are no notes', () => {
  assert.deepEqual(collectNotes({ notes: '', downtime: [{ category: 'OTHER', note: '  ' }], stops: [{ notes: '' }] }), []);
  assert.deepEqual(collectNotes({}), []);
});

// Both PDF templates must paint the block, and the phone must overlay the freshly
// typed end-of-day note before rendering (previewDailyLog / the prefetch drop it).
test('both renderers draw the notes block and capture overlays the typed note', () => {
  const dailylog = text('js/dailylog.js');
  const drawCalls = [...dailylog.matchAll(/drawNotesBlock\(/g)];
  assert.ok(drawCalls.length >= 2, `expected drawNotesBlock in both templates, found ${drawCalls.length}`);

  const capture = text('js/pages/capture.js');
  const overlays = [...capture.matchAll(/summary\.notes\s*=\s*\$\('eodNotes'\)\.value\.trim\(\)/g)];
  assert.ok(overlays.length >= 2, `expected ≥2 eodNotes overlays before render, found ${overlays.length}`);
});
