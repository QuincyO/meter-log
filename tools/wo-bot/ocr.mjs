// ── The two local readers behind the photo bot ──────────────────────────────
// An OCR reader — Windows OCR (winocr.ps1, instant, no install) when the bot runs
// on the PC itself, Tesseract when it runs in the Docker container — and a local
// Ollama vision model (default qwen2.5vl:7b). Both read every photo; extract.mjs
// decides which numbers to trust. Either failing returns null rather than throwing, so one
// reader down still yields something (all of it flagged unsure).
import { execFile } from 'node:child_process';
import { unlink } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numbersIn, mergeEngines, WO_DIGITS } from './extract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const VLM_PROMPT = 'This photo shows a handheld device screen listing work order numbers. '
  + `List every ${WO_DIGITS}-digit work order number visible, top to bottom, one per line. `
  + 'Output only the numbers.';

/** Windows OCR text for one image, or null. powershell.exe, not pwsh — see winocr.ps1. */
export function winOcr(path){
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'winocr.ps1'), path],
      { timeout: 60000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Tesseract text for one image, or null — the OCR reader in the Docker container
 *  (compose.yaml), where Windows OCR doesn't exist. Plain Tesseract reads nothing
 *  off the handheld: small grey digits in a busy photo of a car interior. Fitting
 *  the image to ~2600 px and a local adaptive threshold (-lat) first reads all 15
 *  on the reference photo, at Telegram size and as overlapping crops. */
export function tesseractOcr(path){
  const png = join(tmpdir(), `wo-bot-ocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  return new Promise(resolve => {
    execFile('magick', [path, '-auto-orient', '-resize', '2600x2600', '-colorspace', 'Gray',
      '-lat', '60x60-10%', png], { timeout: 60000 }, err => {
      if(err) return resolve(null);
      execFile('tesseract', [png, 'stdout', '--psm', '11'], { timeout: 60000 }, (err2, stdout) => {
        unlink(png, () => {});
        resolve(err2 ? null : String(stdout));
      });
    });
  });
}

/** The OCR reader for where the bot is running. */
export const ocrRead = process.platform === 'win32' ? winOcr : tesseractOcr;

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

/** Both readers over one photo → { agreed, unsure, engines } where `engines`
 *  says which readers answered (for the reply when one is down). */
export async function readPhoto(path, opts = {}){
  const [ocrText, vlmText] = await Promise.all([ocrRead(path), visionRead(path, opts)]);
  const ocr = ocrText == null ? null : numbersIn(ocrText);
  const vlm = vlmText == null ? null : numbersIn(vlmText);
  return { ...mergeEngines(ocr, vlm), engines: { ocr: ocr != null, vision: vlm != null } };
}
