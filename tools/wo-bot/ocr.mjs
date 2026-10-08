// ── The two local readers behind the photo bot ──────────────────────────────
// Windows OCR (winocr.ps1, instant, no install) and a local Ollama vision model
// (default qwen2.5vl:7b). Both read every photo; extract.mjs decides which
// numbers to trust. Either failing returns null rather than throwing, so one
// reader down still yields something (all of it flagged unsure).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
  const [ocrText, vlmText] = await Promise.all([winOcr(path), visionRead(path, opts)]);
  const ocr = ocrText == null ? null : numbersIn(ocrText);
  const vlm = vlmText == null ? null : numbersIn(vlmText);
  return { ...mergeEngines(ocr, vlm), engines: { ocr: ocr != null, vision: vlm != null } };
}
