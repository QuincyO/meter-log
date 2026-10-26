// ── The reader behind the photo bot ─────────────────────────────────────────
// A local Ollama vision model (default qwen2.5vl:7b) reads every photo, and its
// numbers are the batch. Windows OCR used to read alongside it, keeping only the
// numbers both reported; it was dropped on 2026-10-26 because at Telegram's
// ~1280 px it lost the leading 9 off tall list photos ("07955", "106276",
// ")06362") that the vision model read correctly, parking good orders as unsure.
import { readFile } from 'node:fs/promises';
import { numbersIn, WO_DIGITS } from './extract.mjs';

const VLM_PROMPT = 'This photo shows a handheld device screen listing work order numbers. '
  + `List every ${WO_DIGITS}-digit work order number visible, top to bottom, one per line. `
  + 'Output only the numbers.';

/** The vision model's text for one image, or null. keep_alive holds the model in
 *  VRAM between photos of the same list (cold load is ~30 s, warm a few). */
export async function visionRead(path, { ollamaUrl = 'http://localhost:11434', model = 'qwen2.5vl:7b' } = {}){
  try {
    const images = [(await readFile(path)).toString('base64')];
    const r = await fetch(ollamaUrl.replace(/\/+$/, '') + '/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: VLM_PROMPT, images, stream: false,
        keep_alive: '30m', options: { temperature: 0 } }),
      signal: AbortSignal.timeout(180000),
    });
    if(!r.ok) return null;
    const j = await r.json();
    return typeof j.response === 'string' ? j.response : null;
  } catch { return null; }
}

/** The work-order numbers in one photo, top to bottom. Throws when the model
 *  doesn't answer, so the reply says why rather than reporting an empty photo. */
export async function readPhoto(path, opts = {}){
  const text = await visionRead(path, opts);
  if(text == null) throw new Error("the AI reader (Ollama) didn't answer — is Ollama running?");
  return numbersIn(text);
}
