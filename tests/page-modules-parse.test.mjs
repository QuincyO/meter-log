// The rest of this suite reads the page modules as *text* (regex/string
// assertions against the source), so a syntax error in one of them is invisible
// to every other test here — nothing ever asks Node to actually parse the file.
// That gap was real this round and had to be caught by hand. This test closes it
// by running Node's own parser (`--check`) over each page module.
//
// Plain `node --check some.js` is not reliable for these files: with no
// package.json `"type": "module"` in this repo, `--check` on a `.js` path falls
// back to a CommonJS parse that can silently pass malformed ESM (verified by
// hand — a deliberately broken file with top-level `import` and an unbalanced
// brace parsed clean under plain `--check`, while `node file.js` correctly threw).
// Piping the source through stdin with `--input-type=module` forces the real ESM
// parser and catches it. `execFileSync` with argv (no shell) keeps this
// cross-platform, including Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = ['capture', 'map', 'edit', 'teams', 'reports', 'planner', 'help'];

for (const p of PAGES) {
  test(`js/pages/${p}.js parses as valid JavaScript`, () => {
    const file = `js/pages/${p}.js`;
    const src = readFileSync(new URL(`../${file}`, import.meta.url));
    try {
      execFileSync(process.execPath, ['--input-type=module', '--check'],
        { input: src, cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      assert.fail(`${file} failed to parse:\n${err.stderr ? err.stderr.toString() : err.message}`);
    }
  });
}
