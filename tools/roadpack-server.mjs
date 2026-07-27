#!/usr/bin/env node
// ── District build service for the desktop planner ──────────────────────────
// A small local helper, in the same spirit as the OSRM and Nominatim containers
// already running on the planning PC. The planner page draws a rectangle and
// POSTs it here; this runs osmium in Docker to clip the Ontario extract, builds
// the pack with tools/build-roadpack.mjs, and (on a separate, explicit request)
// commits and pushes maps/ so phones can download it.
//
//   node tools/roadpack-server.mjs --data D:\osrm
//
// --data is the folder holding your ontario-latest.osm.pbf — the SAME folder
// already mounted into the OSRM and Nominatim containers. The .pbf is
// auto-detected unless you pass --pbf.
//
// SAFETY, deliberate and worth keeping:
//   * Binds to 127.0.0.1 only. Never expose this; it runs Docker and git.
//   * Every child process is spawn()ed with an ARGUMENT ARRAY — never a shell
//     string — so a district id or name can't smuggle in a command.
//   * The district id is validated against a strict slug pattern before it
//     reaches a filename or a git command.
//   * /publish only ever stages `maps/`. It cannot commit anything else, even
//     if the working tree is dirty.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack } from './build-roadpack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const MAPS = join(REPO, 'maps');

const PORT = 8790;

// A district id becomes a filename and a URL path segment. Anything outside
// this pattern is rejected outright rather than escaped.
const ID_OK = /^[a-z0-9][a-z0-9-]{0,31}$/;

function parseArgs(argv){
  const out = {};
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const DATA_DIR = args.data ? resolve(args.data) : '';

// osmcode publishes NO official osmium container — the `ghcr.io/osmcode/osmium-tool`
// this used to name has never existed, so every build died on `denied` from the
// registry before osmium ever ran. `iboates/osmium` is the maintained community
// build of the same tool; the version is pinned so a district built today builds
// the same way in a year. **Its ENTRYPOINT is already `osmium`**, so the argv in
// `osmium()` below starts at the subcommand — an image without that entrypoint
// needs `--image` *and* the word `osmium` put back.
const OSMIUM_IMAGE = args.image || 'iboates/osmium:1.19.0';

function findPbf(){
  if(args.pbf) return args.pbf;
  if(!DATA_DIR || !existsSync(DATA_DIR)) return '';
  const hit = readdirSync(DATA_DIR).find(f => f.endsWith('.osm.pbf') && !f.startsWith('_build_'));
  return hit || '';
}

// ── child processes ──────────────────────────────────────────────────────────

function run(cmd, argv, onLine){
  return new Promise((res) => {
    let child;
    try { child = spawn(cmd, argv, { windowsHide:true }); }
    catch(e){ res({ code:-1, err:String(e && e.message || e) }); return; }
    let err = '';
    const feed = buf => String(buf).split(/\r?\n/).filter(Boolean).forEach(l => onLine && onLine(l));
    child.stdout.on('data', feed);
    child.stderr.on('data', b => { err += b; feed(b); });
    child.on('error', e => res({ code:-1, err:String(e && e.message || e) }));
    child.on('close', code => res({ code, err }));
  });
}

async function dockerUp(){
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if(r.code === 0) return { ok:true };
  return { ok:false, reason: r.code === -1 ? 'Docker is not installed or not on PATH' : 'Docker Desktop is not running' };
}

async function gitUp(){
  const r = await run('git', ['-C', REPO, 'rev-parse', '--is-inside-work-tree']);
  return r.code === 0;
}

// ── jobs ─────────────────────────────────────────────────────────────────────
// A build takes minutes, which is far longer than a fetch should hang. /build
// starts a job and returns its id; the planner polls /job?id=… for the log.
const jobs = new Map();
let jobSeq = 0;

function newJob(){
  const id = String(++jobSeq);
  jobs.set(id, { id, done:false, error:'', log:[], entry:null });
  return jobs.get(id);
}
const push = (job, line) => { job.log.push(line); if(job.log.length > 400) job.log.shift(); };

const osmium = (job, argv) => run('docker',
  ['run', '--rm', '-v', `${DATA_DIR}:/data`, OSMIUM_IMAGE, ...argv],
  l => push(job, l));

async function buildDistrict(job, { id, name, bbox }){
  const pbf = findPbf();
  if(!pbf) throw new Error('No .osm.pbf found in the data folder — pass --pbf');
  const tmp = [];
  const t = suffix => { const f = `_build_${id}${suffix}`; tmp.push(join(DATA_DIR, f)); return `/data/${f}`; };

  const clipped   = t('.osm.pbf');
  const roadsPbf  = t('-roads.osm.pbf');
  const roadsGeo  = t('-roads.geojsonseq');
  const addrPbf   = t('-addr.osm.pbf');
  const addrGeo   = t('-addr.geojsonseq');
  const box = `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;

  const step = async (label, argv) => {
    push(job, `▸ ${label}`);
    const r = await osmium(job, argv);
    if(r.code !== 0) throw new Error(`${label} failed — ${r.err.split('\n').filter(Boolean).pop() || 'see log'}`);
  };

  await step('Clipping the district out of the province', [
    'extract', '-b', box, `/data/${pbf}`, '-o', clipped, '--overwrite']);
  await step('Selecting road ways', [
    'tags-filter', clipped, 'w/highway', '-o', roadsPbf, '--overwrite']);
  await step('Exporting roads', [
    'export', roadsPbf, '-f', 'geojsonseq', '-o', roadsGeo, '--overwrite']);
  // Addresses are best-effort: a district with no address data still yields a
  // perfectly good roads-only pack, it just has no offline geocoding.
  let addrFile = '';
  try {
    await step('Selecting address points', [
      'tags-filter', clipped, 'n/addr:housenumber', 'w/addr:housenumber', '-o', addrPbf, '--overwrite']);
    await step('Exporting addresses', [
      'export', addrPbf, '-f', 'geojsonseq', '-o', addrGeo, '--overwrite']);
    addrFile = join(DATA_DIR, `_build_${id}-addr.geojsonseq`);
  } catch(e){
    push(job, `! addresses skipped — ${e.message}`);
    addrFile = '';
  }

  push(job, '▸ Building the pack');
  const { entry } = await buildPack({
    roadsFile: join(DATA_DIR, `_build_${id}-roads.geojsonseq`),
    addrFile, id, name, bbox, mapsDir: MAPS, log: m => push(job, '  ' + m),
  });

  for(const f of tmp){ try { if(existsSync(f)) unlinkSync(f); } catch { /* leave it */ } }
  push(job, `✓ ${(entry.bytes / 1048576).toFixed(1)} MB — built, not yet published`);
  return entry;
}

// ── remove ───────────────────────────────────────────────────────────────────
// Deletes a district from maps/ and the catalogue. Local only, exactly like a
// build: nothing reaches a phone until Publish pushes maps/ — and `git add`
// stages the deletion the same way it stages a new pack, so removal rides the
// existing button rather than needing a push of its own.
//
// A phone that already downloaded the district KEEPS it. The pack is in that
// phone's IndexedDB and still routes; unpublishing is the office tidying its
// catalogue, and reaching through it to delete a crew's working offline map
// mid-day would be a much worse failure than a stale district in a list.
function removeDistrict(id){
  const idxPath = join(MAPS, 'index.json');
  const index = existsSync(idxPath)
    ? JSON.parse(readFileSync(idxPath, 'utf8')) : { districts: [] };
  if(!Array.isArray(index.districts)) index.districts = [];
  const entry = index.districts.find(d => d && d.id === id);

  // The pack file is deleted whether or not the catalogue knew about it, so a
  // half-finished build can't leave an orphan megabyte behind in maps/.
  const packPath = join(MAPS, `${id}.pack`);
  const hadFile = existsSync(packPath);
  if(hadFile) unlinkSync(packPath);
  if(!entry && !hadFile) return { removed:false, missing:true };

  index.districts = index.districts.filter(d => !d || d.id !== id);
  writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n');
  return { removed:true, name: (entry && entry.name) || id };
}

// ── publish ──────────────────────────────────────────────────────────────────
// Deliberately separate from building: a push to main is a live deploy of the
// whole app, so it is its own explicit action rather than a side effect.
async function publish(job){
  push(job, '▸ Staging maps/');
  let r = await run('git', ['-C', REPO, 'add', '--', 'maps'], l => push(job, l));
  if(r.code !== 0) throw new Error('git add failed');
  // `diff --cached --quiet` exits 0 when nothing is staged — that's the "already
  // published" case, not a failure.
  r = await run('git', ['-C', REPO, 'diff', '--cached', '--quiet', '--', 'maps']);
  if(r.code === 0){ push(job, 'Nothing new to publish — maps/ already matches main.'); return { published:false }; }

  push(job, '▸ Committing');
  r = await run('git', ['-C', REPO, 'commit', '-m', 'Publish offline road map districts'],
    l => push(job, l));
  if(r.code !== 0) throw new Error('git commit failed');

  push(job, '▸ Pushing to main');
  r = await run('git', ['-C', REPO, 'push', 'origin', 'HEAD'], l => push(job, l));
  if(r.code !== 0) throw new Error('git push failed — push by hand and try again');
  push(job, '✓ Published. Phones can download it from Settings ▸ Offline road map.');
  return { published:true };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type':'application/json',
    // The planner is served from GitHub Pages (or localhost); this service is
    // loopback-only, so a wildcard here grants nothing a local page couldn't
    // already do.
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(body));
};

function readBody(req){
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => { b += c; if(b.length > 1e6) rej(new Error('body too large')); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch(e){ rej(e); } });
  });
}

function validBbox(b){
  if(!b) return null;
  const n = ['minLat','minLng','maxLat','maxLng'].map(k => Number(b[k]));
  if(!n.every(Number.isFinite)) return null;
  const [minLat, minLng, maxLat, maxLng] = n;
  if(minLat >= maxLat || minLng >= maxLng) return null;
  if(Math.abs(maxLat - minLat) > 6 || Math.abs(maxLng - minLng) > 8) return null;   // absurdly large
  return { minLat, minLng, maxLat, maxLng };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if(req.method === 'OPTIONS') return json(res, 204, {});

  try {
    if(url.pathname === '/status'){
      const docker = await dockerUp();
      const districts = existsSync(join(MAPS, 'index.json'))
        ? (JSON.parse(readFileSync(join(MAPS, 'index.json'), 'utf8')).districts || []) : [];
      return json(res, 200, {
        ok:true, docker:docker.ok, dockerReason:docker.reason || '',
        data:DATA_DIR, pbf:findPbf(), git:await gitUp(), districts,
      });
    }

    if(url.pathname === '/job'){
      const job = jobs.get(url.searchParams.get('id') || '');
      return job ? json(res, 200, job) : json(res, 404, { error:'no such job' });
    }

    if(url.pathname === '/build' && req.method === 'POST'){
      const body = await readBody(req);
      const id = String(body.id || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const bbox = validBbox(body.bbox);
      if(!ID_OK.test(id)) return json(res, 400, { error:'id must be lowercase letters, numbers and dashes' });
      if(!name) return json(res, 400, { error:'name is required' });
      if(!bbox) return json(res, 400, { error:'draw a sensible rectangle first' });
      if(!DATA_DIR) return json(res, 400, { error:'server started without --data' });
      // Checked here, not just inside the job: a --data folder that doesn't exist
      // (or holds no extract) is a launch-flag typo, and finding that out from a
      // failed job's log is three clicks too late.
      if(!findPbf()) return json(res, 409, { error:`No .osm.pbf in ${DATA_DIR} — restart with --data pointing at the folder holding the Ontario extract` });
      const docker = await dockerUp();
      if(!docker.ok) return json(res, 409, { error:docker.reason });

      const job = newJob();
      json(res, 202, { job:job.id });
      buildDistrict(job, { id, name, bbox })
        .then(entry => { job.entry = entry; })
        .catch(e => { job.error = e.message || String(e); push(job, '✗ ' + job.error); })
        .finally(() => { job.done = true; });
      return;
    }

    // Removal is instant (a file and a JSON entry), so unlike /build it answers
    // directly instead of handing back a job to poll.
    if(url.pathname === '/remove' && req.method === 'POST'){
      const body = await readBody(req);
      const id = String(body.id || '').trim().toLowerCase();
      // The same strict slug the build uses, for the same reason: this reaches
      // a filename. Never relax it to "whatever is in the catalogue".
      if(!ID_OK.test(id)) return json(res, 400, { error:'bad district id' });
      const out = removeDistrict(id);
      return out.missing
        ? json(res, 404, { error:'no such district' })
        : json(res, 200, { ok:true, ...out });
    }

    if(url.pathname === '/publish' && req.method === 'POST'){
      if(!await gitUp()) return json(res, 409, { error:'not a git repository' });
      const job = newJob();
      json(res, 202, { job:job.id });
      publish(job)
        .catch(e => { job.error = e.message || String(e); push(job, '✗ ' + job.error); })
        .finally(() => { job.done = true; });
      return;
    }

    return json(res, 404, { error:'not found' });
  } catch(e){
    return json(res, 500, { error:String(e && e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`District builder on http://localhost:${PORT}`);
  console.log(`  repo:  ${REPO}`);
  console.log(`  data:  ${DATA_DIR || '(none — pass --data D:\\osrm)'}`);
  console.log(`  pbf:   ${findPbf() || '(not found)'}`);
  console.log('\nLeave this running and use the Districts panel on planner.html.');
});
