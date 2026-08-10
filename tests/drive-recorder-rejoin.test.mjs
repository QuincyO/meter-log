import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const rec = text('js/drive-recorder.js');

// A day used to fragment into one short leg per COLD-START: iOS kills the PWA
// during a Google-Maps hand-off, and the old init started a BRAND-NEW segment on
// every cold reopen — so a 17-stop day produced ~23 arbitrarily-cut legs, all
// dumped into the queue at Finish. The recorder REJOINS the still-open leg across
// cold-starts; legs still end on purpose — stillCheck() splits park-to-park at
// each real stop, which is what feeds the dwell model's between-leg holes.

test('checkpoint persists the raw segment so a cold-start can rejoin it', () => {
  assert.match(rec,
    /raw:\s*\{ points: seg\.points, gaps: seg\.gaps, pendingPause: seg\.pendingPause,\s*still: seg\.still \}/);
});

test('resumeSegment rebuilds the live leg from persisted raw state', () => {
  assert.match(rec, /function resumeSegment\(row\)/);
  assert.match(rec, /points: r\.points \|\| \[\], gaps: r\.gaps \|\| \[\]/);
});

test('init rejoins today’s open leg when recording instead of forking a new one', () => {
  assert.match(rec, /if\(open\)\{ resumeSegment\(open\); resumedId = open\.id; \}/);
  // The resumed leg must be excluded from the day-total seed or it double-counts.
  assert.match(rec, /r\.id !== resumedId\) foldIntoDay/);
});

test('recoverStale leaves today’s legs for init (so the rejoin is not stranded)', () => {
  assert.match(rec, /if\(r\.date === today\) continue;/);
});

test('startWatch no longer bails when a segment already exists (it would skip the watch)', () => {
  assert.match(rec, /if\(watchId != null\) return;/);
  assert.doesNotMatch(rec, /function startWatch\(\)\{\s*if\(seg\) return;/);
});

test('the phone-only raw state is stripped from every upload path', () => {
  // Both recoverStale and finishAndUpload must drop raw before enqueueing a leg.
  const strips = rec.match(/const \{ active, queued, raw, \.\.\.leg \} = (?:r|row);/g) || [];
  assert.ok(strips.length >= 2, `expected raw stripped in ≥2 upload paths, found ${strips.length}`);
});
