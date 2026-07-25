#!/usr/bin/env node
// ── Build a credential-free handoff bundle for a second developer ───────────
//
//   node scripts/make-handoff.mjs --out ../meter-log-handoff
//   node scripts/make-handoff.mjs --out /tmp/handoff --ref main --zip
//   node scripts/make-handoff.mjs --out /tmp/handoff --scrub-data
//
// Produces a directory (optionally a zip) that a second developer stands up as
// their own isolated tenant — their own Sheet, Apps Script deployment, API keys,
// GitHub repo and Pages site. ONBOARDING.md in the bundle is their runbook.
//
// THE LOAD-BEARING PART IS THAT THERE IS NO .git. js/config.js is committed with
// four live credentials, so `git clone` hands them over permanently even if the
// working tree is blanked afterwards. The bundle is files only — history stays
// behind. Everything else here is belt-and-braces on top of that.
//
// Plain Node, no dependencies: this repo has no package manager (see AGENTS.md).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt  = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if(flag('--help') || flag('-h')){
  console.log(`Usage: node scripts/make-handoff.mjs --out <dir> [--ref <git-ref>] [--zip] [--scrub-data]

  --out <dir>     where to write the bundle (required; must not already exist)
  --ref <ref>     git ref to export (default: HEAD)
  --zip           also write <dir>.zip beside it
  --scrub-data    omit data/ — the exported Sheet snapshot, which contains real
                  crew names, home addresses, customer addresses and GPS traces
`);
  process.exit(0);
}

const OUT = opt('--out');
const REF = opt('--ref', 'HEAD');
if(!OUT){ console.error('error: --out <dir> is required (see --help)'); process.exit(1); }
if(existsSync(OUT)){ console.error(`error: ${OUT} already exists — refusing to overwrite`); process.exit(1); }

// ── 1. export the tree at REF, with no .git ─────────────────────────────────
// `git archive` writes only tracked files at that ref: no .git, no untracked
// local cruft, no ignored files. That is precisely the property we want.
mkdirSync(OUT, { recursive: true });
console.log(`• exporting ${REF} → ${OUT} (no git history)`);
const tar = execFileSync('git', ['archive', '--format=tar', REF],
  { cwd: REPO, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
writeFileSync(join(OUT, '.handoff.tar'), tar);
execFileSync('tar', ['-xf', '.handoff.tar'], { cwd: OUT, stdio: 'inherit' });
rmSync(join(OUT, '.handoff.tar'));

// ── 2. swap in the credential-free config ───────────────────────────────────
const tmplPath = join(OUT, 'js/config.example.js');
if(!existsSync(tmplPath)){
  console.error(`error: js/config.example.js is not in ${REF}.`);
  console.error('       git archive exports tracked files only — commit the template first.');
  process.exit(1);
}
writeFileSync(join(OUT, 'js/config.js'), readFileSync(tmplPath, 'utf8'));
console.log('• js/config.js ← js/config.example.js (placeholders)');

// ── 3. blank the two tenant values that live outside config.js ──────────────
// Code.gs:42's token must byte-match js/config.js, and the workflow redeploys a
// specific Apps Script deployment in place. Both are per-tenant.
const sub = (relPath, pattern, replacement, label) => {
  const p = join(OUT, relPath);
  const before = readFileSync(p, 'utf8');
  const after = before.replace(pattern, replacement);
  if(after === before){ console.error(`error: could not blank ${label} in ${relPath} — pattern drifted`); process.exit(1); }
  writeFileSync(p, after);
  console.log(`• ${relPath} ← ${label} blanked`);
};
sub('Code.gs', /(const SHARED_TOKEN\s*=\s*)'[^']*'/,
    "$1'PASTE_YOUR_SHARED_TOKEN_HERE'", 'SHARED_TOKEN');
sub('.github/workflows/deploy-appsscript.yml', /(DEPLOYMENT_ID:\s*)\S+/,
    '$1PASTE_YOUR_DEPLOYMENT_ID_HERE', 'DEPLOYMENT_ID');

// ── 4. drop local/debug artifacts ───────────────────────────────────────────
for(const junk of ['edge.log']){
  const p = join(OUT, junk);
  if(existsSync(p)){ rmSync(p, { recursive: true }); console.log(`• dropped ${junk}`); }
}

// ── 5. data/ — real production data, kept unless asked otherwise ────────────
const dataDir = join(OUT, 'data');
if(flag('--scrub-data')){
  if(existsSync(dataDir)){ rmSync(dataDir, { recursive: true }); console.log('• dropped data/ (--scrub-data)'); }
} else if(existsSync(dataDir)){
  const n = readdirSync(dataDir).length;
  console.log(`• KEEPING data/ — ${n} files of real exported Sheet data: crew names, H numbers,`);
  console.log('  home addresses, customer addresses, GPS traces. Pass --scrub-data to omit it.');
}

// ── 6. verify the bundle carries no credential ──────────────────────────────
// The bundle checks itself. If any of these survive, the handoff is unsafe and
// this script must fail rather than hand over a file that looks sanitized.
// Everything is scanned except the vendored libraries (large minified blobs that
// carry no project credential) — including data/ and docs/, which are shipped
// verbatim and are exactly where a stray key would go unnoticed.
const FORBIDDEN = [
  [/AKfycb\w+/g,   'an Apps Script deployment id'],
  [/AIza[\w-]{10,}/g, 'a Google API key'],
  [/eyJvcmci[\w=]+/g, 'an OpenRouteService token'],
];
const SKIP_DIRS = new Set(['js/vendor', 'css/vendor']);
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = join(dir, name);
  const rel = relative(OUT, full).replaceAll('\\', '/');
  if(SKIP_DIRS.has(rel)) return [];
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const hits = [];
for(const file of walk(OUT)){
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for(const [pattern, what] of FORBIDDEN)
    for(const m of text.matchAll(pattern))
      hits.push(`${relative(OUT, file)}: ${what} (${m[0].slice(0, 12)}…)`);
}

if(hits.length){
  console.error('\n✗ REFUSING TO SHIP — live credentials survived in the bundle:');
  for(const h of hits) console.error('   ' + h);
  console.error('\nFix the source (or extend this script) and rebuild. The bundle at');
  console.error(`${OUT} is NOT safe to hand over.`);
  process.exit(1);
}

// ── 7. optional zip ─────────────────────────────────────────────────────────
if(flag('--zip')){
  execFileSync('zip', ['-qr', OUT + '.zip', '.'], { cwd: OUT, stdio: 'inherit' });
  console.log(`• wrote ${OUT}.zip`);
}

console.log(`\n✓ bundle ready: ${OUT}`);
console.log('  No git history, no credentials. Hand it over with ONBOARDING.md as the runbook.');
