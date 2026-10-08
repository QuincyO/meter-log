#!/usr/bin/env node
// ── Photo → work orders: a Telegram bot that runs on the home PC ────────────
// Photograph the handheld's work-order list (several overlapping photos for a
// long list), send them to the bot, check its reply, tap ✅ Send. The numbers are
// queued in the Sheet's WorklistInbox tab for the installer linked to your
// Telegram account, and land on their phone on the next Worklist ▸ ⇩ Download
// (Code.gs claimWorklistInbox). Everything is read locally — Windows OCR plus a
// local Ollama vision model; see ocr.mjs and extract.mjs.
//
//   node tools/wo-bot/bot.mjs                      run the bot (tray.ps1 is the
//                                                  on/off switch that runs it)
//   node tools/wo-bot/bot.mjs --dry-run a.jpg …    read photos, print, touch nothing
//
// Setup (DEPLOY.md §"Photo work-order bot"): a token from @BotFather and the
// allowed Telegram user ids go in tools/wo-bot/config.local.json (gitignored;
// copy config.example.json). Long polling, so nothing is exposed to the internet.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_APP_URL, SHARED_TOKEN } from '../../js/config.js';
import { readPhoto } from './ocr.mjs';
import { newBatch, addPhoto, addTyped, removeFrom } from './extract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.local.json');
const STATE_PATH = join(HERE, 'state.local.json');

// ── dry run: no Telegram, no Sheet ──────────────────────────────────────────
const args = process.argv.slice(2);
if(args[0] === '--dry-run'){
  const opts = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const batch = newBatch();
  for(const path of args.slice(1)){
    const t = Date.now();
    const r = await readPhoto(path, opts);
    const s = addPhoto(batch, r);
    console.log(`${path}: ${s.read} read, ${s.added} new, ${s.promoted} confirmed by this photo, `
      + `${s.unsure} unsure · readers ${JSON.stringify(r.engines)} · ${Date.now() - t} ms`);
  }
  console.log(`\nConfirmed (${batch.confirmed.length}):\n${batch.confirmed.join('\n')}`);
  if(batch.unsure.length) console.log(`\nUnsure (${batch.unsure.length}):\n${batch.unsure.join('\n')}`);
  process.exit(0);
}

// ── config + state ──────────────────────────────────────────────────────────
if(!existsSync(CONFIG_PATH)){
  console.error(`Missing ${CONFIG_PATH} — copy config.example.json and fill it in.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if(!config.botToken){ console.error('config.local.json: botToken is required'); process.exit(1); }
const allowed = new Set((config.allowedUserIds || []).map(String));
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
state.links = state.links || {};   // Telegram user id → { hNumber, name }
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
const batches = new Map();         // chat id → batch (in memory; a restart drops it)
const batchFor = chat => { if(!batches.has(chat)) batches.set(chat, newBatch()); return batches.get(chat); };

// ── Telegram + spine plumbing ───────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${config.botToken}`;
async function tg(method, params = {}, timeoutMs = 30000){
  const r = await fetch(`${TG}/${method}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if(!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}
const say = (chat, text, extra = {}) => tg('sendMessage', { chat_id: chat, text, ...extra });

async function spineGet(action, params = {}){
  const q = new URLSearchParams({ token: SHARED_TOKEN, action, ...params });
  return (await fetch(`${WEB_APP_URL}?${q}`)).json();
}
async function spinePost(body){
  // text/plain like js/api.js; fetch follows Apps Script's 302 to the result.
  return (await fetch(WEB_APP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ token: SHARED_TOKEN, ...body }) })).json();
}

// ── replies ─────────────────────────────────────────────────────────────────
const HELP = [
  'Send photos of the work-order list — several overlapping photos are fine for a long list.',
  'I read each one twice (OCR + AI) and only keep numbers both agree on; anything doubtful is listed for you to check.',
  '',
  '/link H12345 — whose worklist the orders go to',
  '/list — show the batch',
  'Type numbers — add them (e.g. 905486 907209)',
  '/remove 902732 — drop a number',
  '/clear — start over',
  '/send — queue the batch (or tap ✅ Send)',
].join('\n');

function batchButtons(user, batch){
  const link = state.links[user];
  const row = [];
  if(batch.confirmed.length && link)
    row.push({ text: `✅ Send ${batch.confirmed.length} to ${link.name}`, callback_data: 'send' });
  if(batch.confirmed.length || batch.unsure.length) row.push({ text: '✕ Clear', callback_data: 'clear' });
  return row.length ? { reply_markup: { inline_keyboard: [row] } } : {};
}

function batchStatus(user, batch){
  const lines = [`Batch: ${batch.confirmed.length} ready.`];
  if(batch.unsure.length)
    lines.push(`⚠ Not included — only one reader saw ${batch.unsure.length === 1 ? 'this' : 'these'}. `
      + `Check the photo and type any that are right:\n${batch.unsure.join('\n')}`);
  if(!state.links[user]) lines.push('Link your worklist first: /link H12345');
  return lines.join('\n');
}

// ── handlers ────────────────────────────────────────────────────────────────
async function handleLink(chat, user, text){
  const h = text.replace(/^\/link(@\w+)?/i, '').trim().toUpperCase();
  if(!h) return say(chat, 'Usage: /link H12345 (your employee number)');
  const r = await spineGet('roster');
  const emp = (r && r.employees || []).find(e => String(e.hNumber).trim().toUpperCase() === h);
  if(!emp) return say(chat, `${h} isn't on the roster.`);
  const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || h;
  state.links[user] = { hNumber: String(emp.hNumber).trim(), name };
  saveState();
  return say(chat, `Linked — orders will go to ${name}'s worklist (${state.links[user].hNumber}).`);
}

async function handleSend(chat, user){
  const batch = batchFor(chat), link = state.links[user];
  if(!link) return say(chat, 'Link your worklist first: /link H12345');
  if(!batch.confirmed.length) return say(chat, 'Nothing to send yet — send a photo first.');
  let r;
  try { r = await spinePost({ action: 'queueWorklistOrders', hNumber: link.hNumber,
    orders: batch.confirmed, source: 'telegram' }); }
  catch (e) { return say(chat, `Couldn't reach the sheet (${e.message}). The batch is kept — try /send again.`); }
  if(!r || !r.ok) return say(chat, `The sheet refused it: ${(r && r.error) || 'unknown error'}. The batch is kept.`);
  batches.delete(chat);
  const skipped = r.skipped.length ? ` (${r.skipped.length} already on the list)` : '';
  return say(chat, `Queued ${r.queued.length} for ${r.installer}${skipped}.\n`
    + 'On the phone: Worklist ▸ ⇩ Download.');
}

async function downloadPhoto(fileId){
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`);
  if(!r.ok) throw new Error(`download ${r.status}`);
  const path = join(tmpdir(), `wo-bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  return path;
}

// Photos of one album arrive as separate messages in the same getUpdates batch,
// so they are read one after another and answered with ONE summary per chat.
async function handlePhotos(chat, user, fileIds){
  await say(chat, `Reading ${fileIds.length} photo${fileIds.length === 1 ? '' : 's'}…`);
  const batch = batchFor(chat);
  const lines = [];
  let readerNote = '';
  for(const [i, id] of fileIds.entries()){
    let path;
    try {
      path = await downloadPhoto(id);
      const r = await readPhoto(path, config);
      const s = addPhoto(batch, r);
      lines.push(`Photo ${i + 1}: ${s.read} read, ${s.added + s.promoted} new`
        + (s.unsure ? `, ${s.unsure} unsure` : ''));
      if(!r.engines.ocr || !r.engines.vision)
        readerNote = `⚠ The ${!r.engines.vision ? 'AI reader (Ollama)' : 'Windows OCR'} didn't answer, `
          + 'so nothing could be double-checked — every number is listed as unsure.';
    } catch (e) {
      lines.push(`Photo ${i + 1}: couldn't read it (${e.message})`);
    } finally {
      if(path) try { unlinkSync(path); } catch {}
    }
  }
  const text = [lines.join('\n'), readerNote, batchStatus(user, batch)].filter(Boolean).join('\n\n');
  return say(chat, text, batchButtons(user, batch));
}

async function handleText(chat, user, text){
  const cmd = (text.match(/^\/(\w+)/) || [])[1];
  const batch = batchFor(chat);
  if(cmd === 'start' || cmd === 'help') return say(chat, HELP);
  if(cmd === 'link') return handleLink(chat, user, text);
  if(cmd === 'send') return handleSend(chat, user);
  if(cmd === 'clear'){ batches.delete(chat); return say(chat, 'Cleared.'); }
  if(cmd === 'list'){
    const all = batch.confirmed.length ? `Ready:\n${batch.confirmed.join('\n')}\n\n` : '';
    return say(chat, all + batchStatus(user, batch), batchButtons(user, batch));
  }
  if(cmd === 'remove'){
    const n = removeFrom(batch, text);
    return say(chat, `Removed ${n}. ${batchStatus(user, batch)}`, batchButtons(user, batch));
  }
  const r = addTyped(batch, text);
  if(!r.found) return say(chat, `I only understand 6-digit work-order numbers and the commands below.\n\n${HELP}`);
  return say(chat, `Added ${r.added}. ${batchStatus(user, batch)}`, batchButtons(user, batch));
}

// ── the poll loop ───────────────────────────────────────────────────────────
const warnedStrangers = new Set();
async function handleUpdates(updates){
  const photos = new Map();   // chat → { user, ids[] }, answered after the loop
  for(const u of updates){
    const msg = u.message, cb = u.callback_query;
    const from = (msg || cb || {}).from;
    if(!from) continue;
    const user = String(from.id);
    const chat = msg ? msg.chat.id : cb.message.chat.id;
    if(!allowed.has(user)){
      if(!warnedStrangers.has(user)){
        warnedStrangers.add(user);
        console.log(`Not allowed: Telegram id ${user} (${[from.first_name, from.last_name].filter(Boolean).join(' ')}`
          + `${from.username ? ' @' + from.username : ''}) — add it to allowedUserIds to let them in.`);
        await say(chat, `This bot is private. Your Telegram id is ${user} — `
          + 'ask the owner to add it to allowedUserIds.').catch(() => {});
      }
      continue;
    }
    try {
      if(cb){
        await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        if(cb.data === 'send') await handleSend(chat, user);
        else if(cb.data === 'clear'){ batches.delete(chat); await say(chat, 'Cleared.'); }
        continue;
      }
      const img = msg.photo ? msg.photo[msg.photo.length - 1].file_id
        : (msg.document && /^image\//.test(msg.document.mime_type || '')) ? msg.document.file_id : null;
      if(img){
        if(!photos.has(chat)) photos.set(chat, { user, ids: [] });
        photos.get(chat).ids.push(img);
      } else if(msg.text){
        await handleText(chat, user, msg.text);
      }
    } catch (e) {
      console.error(new Date().toISOString(), e);
      await say(chat, `Something went wrong: ${e.message}`).catch(() => {});
    }
  }
  for(const [chat, { user, ids }] of photos){
    try { await handlePhotos(chat, user, ids); }
    catch (e) { console.error(new Date().toISOString(), e); }
  }
}

const me = await tg('getMe');
console.log(`@${me.username} is running — ${allowed.size} allowed user(s).`);
let offset = 0;
for(;;){
  try {
    const updates = await tg('getUpdates', { offset, timeout: 50,
      allowed_updates: ['message', 'callback_query'] }, 65000);
    if(updates.length) offset = updates[updates.length - 1].update_id + 1;
    await handleUpdates(updates);
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}
