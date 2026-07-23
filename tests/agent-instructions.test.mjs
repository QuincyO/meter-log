import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const agents = read('AGENTS.md');
const claude = read('CLAUDE.md');
const verify = read('VERIFY.md');
const skill  = read('.claude/skills/verify/SKILL.md');

// Several LLM agents work on this repo and are expected to behave identically. That
// only holds while there is ONE instruction file. These tests exist because the
// duplicate-file arrangement already failed once: AGENTS.md was a fork of CLAUDE.md
// that drifted several features out of date without anyone noticing.

test('CLAUDE.md is a pointer, not a second copy of the instructions', () => {
  assert.match(claude, /AGENTS\.md/);
  // A pointer is short. If this file starts growing again it has become a fork.
  assert.ok(claude.split('\n').length < 30,
    'CLAUDE.md is growing instructions of its own — put them in AGENTS.md');
  // The give-away headings of the real instruction set must not reappear here.
  for(const heading of ['## Architecture in one paragraph', '## The contract that ties it all together',
    '## Things that are easy to get wrong', '## Frontend module layout'])
    assert.ok(!claude.includes(heading), `CLAUDE.md has re-forked: it now carries "${heading}"`);
});

test('AGENTS.md is agent-neutral and states that it is canonical', () => {
  assert.match(agents, /single source of truth/i);
  // It must not address one tool, the way both files used to ("guidance to Codex…").
  assert.ok(!/^This file provides guidance to \w+/m.test(agents),
    'AGENTS.md addresses a single tool — it is read by all of them');
});

test('the standing workflow rules are in the repo, not in one agent memory', () => {
  // These three lived only in Claude Code's private memory, so Codex never followed
  // them. Losing any of them again means the agents diverge in behaviour.
  assert.match(agents, /[Cc]ommit and push when work is complete/);
  assert.match(agents, /[Nn]ever proceed on defaults when a question goes unanswered/);
  assert.match(agents, /node --test/);
});

test('the timestamp landmine is documented where every agent will see it', () => {
  // Unpadded hours ("2026-06-27 9:13:44") silently broke morning data twice.
  assert.match(agents, /single-digit hour/i);
  assert.match(agents, /[Nn]ever lexicographically compare a timestamp/);
});

test('AGENTS.md describes the app as it is now, not as it was', () => {
  // The stale fork claimed twelve tabs and four pages, and had never heard of the
  // worklist or the planner. Spot-check the things it was missing.
  for(const term of ['Worklist', 'WorklistPlans', 'planner.html', 'reports.html', 'help.html',
    'StopsArchive', 'InstallerMetrics', 'archiveStop', 'route-variants.js',
    'DriveTracks', 'saveDriveTrack', 'drive-track.js'])
    assert.ok(agents.includes(term), `AGENTS.md never mentions ${term}`);
  assert.ok(!/twelve tabs|four pages|four static pages|sixteen tabs/.test(agents),
    'AGENTS.md still carries a stale count from the old fork');
  assert.match(agents, /seventeen tabs/);
});

test('the docs do not tell an agent to serve the pages with python', () => {
  // python here is the Windows Store stub: it exits without serving, so the old
  // `python -m http.server` line sent every agent down a dead end.
  for(const [name, text] of [['AGENTS.md', agents], ['VERIFY.md', verify]]){
    assert.ok(!/^\s*python -m http\.server/m.test(text),
      `${name} still recommends the python server, which does not run on this machine`);
    assert.match(text, /Windows Store stub/);
  }
});

test('the verify recipe is in the repo and the skill only points at it', () => {
  assert.match(verify, /Never click Save \/ Close \/ log buttons against the real spine/);
  assert.match(verify, /Fetch\.fulfillRequest/);
  assert.match(verify, /serviceWorker/);        // the stale-cache trap
  assert.match(skill, /VERIFY\.md/);
  assert.ok(skill.split('\n').length < 25,
    'the verify skill is growing a copy of the recipe — keep it in VERIFY.md');
});
