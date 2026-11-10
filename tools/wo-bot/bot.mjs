#!/usr/bin/env node
// ── Photo → work orders: a Telegram bot that runs on the home PC ────────────
// Photograph the handheld's work-order list (several overlapping photos for a
// long list), send them to the bot, check its reply, tap ✅ Send. The numbers are
// queued in the Sheet's WorklistInbox tab for the installer linked to your
// Telegram account, and land on their phone on the next Worklist ▸ ⇩ Download
// (Code.gs claimWorklistInbox). Everything is read locally by an Ollama vision
// model; see ocr.mjs and extract.mjs.
//
//   node tools/wo-bot/bot.mjs                      run the bot (tray.ps1 is the
//                                                  on/off switch that runs it)
//   node tools/wo-bot/bot.mjs --dry-run a.jpg …    read photos, print, touch nothing
//
// Setup (DEPLOY.md §"Photo work-order bot"): a token from @BotFather and the
// owner's Telegram user id go in tools/wo-bot/config.local.json (gitignored;
// copy config.example.json). The owner lets everyone else in from Telegram —
// a stranger's first message sends the owner an ✅ Allow button — see access.mjs.
// Long polling, so nothing is exposed to the internet.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_APP_URL, SHARED_TOKEN } from '../../js/config.js';
import { readPhoto } from './ocr.mjs';
import { newBatch, addPhoto, addTyped, removeFrom, sendOrder } from './extract.mjs';
import { ownerOf, isOwner, isAllowed, parseUserId, allowUser, revokeUser, listUsers } from './access.mjs';

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
    try {
      const s = addPhoto(batch, await readPhoto(path, opts));
      console.log(`${path}: ${s.read} read, ${s.added} new · ${Date.now() - t} ms`);
    } catch (e) { console.log(`${path}: ${e.message}`); }
  }
  console.log(`\nRead (${batch.confirmed.length}):\n${batch.confirmed.join('\n')}`);
  process.exit(0);
}

// ── config + state ──────────────────────────────────────────────────────────
if(!existsSync(CONFIG_PATH)){
  console.error(`Missing ${CONFIG_PATH} — copy config.example.json and fill it in.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if(!config.botToken){ console.error('config.local.json: botToken is required'); process.exit(1); }
const owner = ownerOf(config);
const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
state.links = state.links || {};   // Telegram user id → { hNumber, name }
state.allowed = state.allowed || {}; // Telegram user id → { name, addedAt } — let in by the owner
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
  'I read them with AI and list every number; check the list against the screen before you send.',
  '',
  '/link H12345 — whose worklist the orders go to',
  '/list — show the batch',
  'Type numbers — add them (e.g. 905486 907209)',
  '/remove 902732 — drop a number',
  '/clear — start over',
  '/send — queue the batch (or tap ✅ Send)',
].join('\n');
const OWNER_HELP = [
  '',
  'Only you (the owner):',
  '/users — who can use the bot',
  '/allow 123456789 — let a Telegram id in',
  '/revoke 123456789 — take them back out',
].join('\n');
const helpFor = user => isOwner(config, user) ? HELP + '\n' + OWNER_HELP : HELP;

function batchButtons(user, batch){
  const link = state.links[user];
  const row = [];
  if(batch.confirmed.length && link)
    row.push({ text: `✅ Send ${batch.confirmed.length} to ${link.name}`, callback_data: 'send' });
  if(batch.confirmed.length) row.push({ text: '✕ Clear', callback_data: 'clear' });
  return row.length ? { reply_markup: { inline_keyboard: [row] } } : {};
}

function batchStatus(user, batch){
  const lines = [`Batch: ${batch.confirmed.length} ready.`];
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
    orders: sendOrder(batch), source: 'telegram' }); }
  catch (e) { return say(chat, `Couldn't reach the sheet (${e.message}). The batch is kept — try /send again.`); }
  if(!r || !r.ok) return say(chat, `The sheet refused it: ${(r && r.error) || 'unknown error'}. The batch is kept.`);
  batches.delete(chat);
  const skipped = r.skipped.length ? ` (${r.skipped.length} already on the list)` : '';
  return say(chat, `Queued ${r.queued.length} for ${r.installer}${skipped}.\n`
    + 'On the phone: Worklist ▸ ⇩ Download.');
}

// ── access: the owner lets people in and out from Telegram ──────────────────
const strangers = new Map();       // Telegram id → display name, as last seen this run
const nameOf = from => [from.first_name, from.last_name].filter(Boolean).join(' ')
  + (from.username ? ` (@${from.username})` : '');

// A stranger's first message (per run): tell them, and send the owner a button.
async function handleStranger(chat, from){
  const user = String(from.id), name = nameOf(from);
  const known = strangers.has(user);
  strangers.set(user, name);
  if(known) return;
  console.log(`Not allowed: Telegram id ${user} (${name}) — asked the owner.`);
  await say(chat, `This bot is private. I've asked the owner to let you in — `
    + `you'll get a message here when they do. (Your Telegram id is ${user}.)`).catch(() => {});
  if(!owner) return;
  await say(owner, `${name || 'Someone'} (id ${user}) wants to use the bot.`, {
    reply_markup: { inline_keyboard: [[{ text: `✅ Allow ${name || user}`, callback_data: `allow:${user}` }]] },
  }).catch(e => console.error(new Date().toISOString(), `couldn't reach the owner: ${e.message}`));
}

async function grant(chat, id){
  const name = strangers.get(id) || '';
  const r = allowUser(config, state, id, name);
  if(!r.ok) return say(chat, `${name || id} can already use the bot.`);
  saveState();
  strangers.delete(id);
  console.log(`Allowed: Telegram id ${id} (${name}) — by the owner.`);
  await say(chat, `✅ ${name || id} can use the bot now. /revoke ${id} to undo.`);
  // Private chat id = user id. Fails harmlessly if they never opened the bot.
  await say(id, `You're in. First tell me whose worklist the orders go to: /link H12345\n\n${HELP}`)
    .catch(() => say(chat, `(I couldn't message them — they need to open @${me.username} and tap Start.)`));
}

async function handleAllow(chat, text){
  const id = parseUserId(text);
  if(!id) return say(chat, 'Usage: /allow 123456789 (their Telegram id — the bot tells them it when they message it)');
  return grant(chat, id);
}

async function handleRevoke(chat, text){
  const id = parseUserId(text);
  if(!id) return say(chat, 'Usage: /revoke 123456789 — /users shows the ids');
  const r = revokeUser(config, state, id);
  if(r.ok){
    saveState();
    batches.delete(Number(id));
    console.log(`Revoked: Telegram id ${id} (${r.name}) — by the owner.`);
    return say(chat, `Removed ${r.name || id}. They can't use the bot any more.`);
  }
  if(r.reason === 'owner') return say(chat, "That's you — the owner can't be removed.");
  if(r.reason === 'config') return say(chat, `${id} is in config.local.json on the PC; remove it there.`);
  return say(chat, `${id} isn't on the list. /users shows who is.`);
}

function handleUsers(chat){
  const label = { owner: ' — owner', config: ' — in config file', bot: '' };
  const lines = listUsers(config, state).map(u =>
    `${u.name || '(no name yet)'} · ${u.id}${label[u.source]}`
    + (u.link ? `\n   → ${u.link.name}'s worklist (${u.link.hNumber})` : '\n   → not linked yet'));
  return say(chat, `Can use the bot (${lines.length}):\n\n${lines.join('\n')}`);
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
  for(const [i, id] of fileIds.entries()){
    let path;
    try {
      path = await downloadPhoto(id);
      const s = addPhoto(batch, await readPhoto(path, config));
      lines.push(`Photo ${i + 1}: ${s.read} read, ${s.added} new`);
    } catch (e) {
      lines.push(`Photo ${i + 1}: couldn't read it (${e.message})`);
    } finally {
      if(path) try { unlinkSync(path); } catch {}
    }
  }
  const text = [lines.join('\n'), batchStatus(user, batch)].join('\n\n');
  return say(chat, text, batchButtons(user, batch));
}

async function handleText(chat, user, text){
  const cmd = (text.match(/^\/(\w+)/) || [])[1];
  const batch = batchFor(chat);
  if(cmd === 'start' || cmd === 'help') return say(chat, helpFor(user));
  if(cmd === 'allow' || cmd === 'revoke' || cmd === 'users'){
    if(!isOwner(config, user)) return say(chat, 'Only the owner can do that.');
    if(cmd === 'allow') return handleAllow(chat, text);
    if(cmd === 'revoke') return handleRevoke(chat, text);
    return handleUsers(chat);
  }
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
  if(!r.found) return say(chat, `I only understand 6-digit work-order numbers and the commands below.\n\n${helpFor(user)}`);
  return say(chat, `Added ${r.added}. ${batchStatus(user, batch)}`, batchButtons(user, batch));
}

// ── the poll loop ───────────────────────────────────────────────────────────
async function handleUpdates(updates){
  const photos = new Map();   // chat → { user, ids[] }, answered after the loop
  for(const u of updates){
    const msg = u.message, cb = u.callback_query;
    const from = (msg || cb || {}).from;
    if(!from) continue;
    const user = String(from.id);
    const chat = msg ? msg.chat.id : cb.message.chat.id;
    if(!isAllowed(config, state, user)){
      await handleStranger(chat, from).catch(() => {});
      continue;
    }
    try {
      if(cb){
        await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        const allowId = (String(cb.data || '').match(/^allow:(\d+)$/) || [])[1];
        if(allowId){ if(isOwner(config, user)) await grant(chat, allowId); }
        else if(cb.data === 'send') await handleSend(chat, user);
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
console.log(`@${me.username} is running — ${listUsers(config, state).length} allowed user(s)`
  + (owner ? `, owner ${owner}.` : ' — no owner set, so nobody can let people in from Telegram.'));
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
