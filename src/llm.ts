// Smart notes: Qwen2.5 Instruct (GGUF, Q4_K_M) running on the phone through llama.rn.
//  - The model is NOT inside the app. It is downloaded ONCE from the official Qwen Hugging Face repos
//    (Wi-Fi + free-storage check, progress, resume), stored in the app's private folder, then everything is offline.
//  - 1.5B by default; a phone with little RAM gets 0.5B (also used if 1.5B fails to load).
//  - Notes = topper's exam copy built ONLY from the source text; every point is checked against the source.
import * as FS from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import * as Device from 'expo-device';
import { getMeta, setMeta } from './db';
import type { Point } from './notes';
import { tidyPoint } from './notes';

export type ModelId = 'q15' | 'q05';
export const MODELS: Record<ModelId, { label: string; file: string; url: string; bytes: number }> = {
  q15: {
    label: 'Qwen2.5 1.5B Instruct',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    bytes: 1_117_000_000,                      // ~1.12 GB (official repo listing)
  },
  q05: {
    label: 'Qwen2.5 0.5B Instruct',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    bytes: 491_000_000,                        // ~491 MB (official repo listing)
  },
};

export type LlmState = {
  phase: 'none' | 'checking' | 'downloading' | 'paused' | 'ready' | 'error';
  model: ModelId; got: number; total: number; msg: string;
};
export const llm: LlmState = { phase: 'none', model: 'q15', got: 0, total: MODELS.q15.bytes, msg: '' };
const subs = new Set<() => void>();
export const subscribeLlm = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const emit = () => subs.forEach((f) => f());
const set = (p: Partial<LlmState>) => { Object.assign(llm, p); emit(); };

const DIR = () => `${FS.documentDirectory}models/`;
const finalPath = (m: ModelId) => DIR() + MODELS[m].file;
const partPath = (m: ModelId) => finalPath(m) + '.part';
const sizeOf = async (uri: string) => { const i: any = await FS.getInfoAsync(uri); return i.exists ? Number(i.size || 0) : 0; };

// RAM decides the model (phones with about 4 GB or less get 0.5B)
const pickModel = async (): Promise<ModelId> => {
  const saved = (await getMeta('llm_model').catch(() => '')) as ModelId;
  if (saved === 'q15' || saved === 'q05') return saved;
  const ram = Number((Device as any).totalMemory || 0);
  const m: ModelId = ram && ram < 4.5e9 ? 'q05' : 'q15';
  await setMeta('llm_model', m).catch(() => {});
  return m;
};

const isGguf = async (uri: string) => {
  try { return (await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64, position: 0, length: 4 })) === 'R0dVRg=='; }   // "GGUF"
  catch { return false; }
};
const sane = (m: ModelId, size: number) => size > MODELS[m].bytes * 0.93 && size < MODELS[m].bytes * 1.07;

// App start: is the model already on the phone (or half downloaded)?
export async function initLlm() {
  const m = await pickModel();
  set({ model: m, total: MODELS[m].bytes, got: 0, msg: '' });
  const fin = await sizeOf(finalPath(m));
  if (fin && sane(m, fin) && (await isGguf(finalPath(m)))) { set({ phase: 'ready', got: fin }); return; }
  const part = await sizeOf(partPath(m));
  set({ phase: part ? 'paused' : 'none', got: part });
}

export type Pre = { ok: boolean; reason?: 'offline' | 'wifi' | 'space'; needMB?: number; freeMB?: number };
export async function preflight(allowMobile: boolean): Promise<Pre> {
  const m = llm.model;
  let net: any = null;
  try { net = await Network.getNetworkStateAsync(); } catch {}
  if (!net || !net.isConnected || net.isInternetReachable === false) return { ok: false, reason: 'offline' };
  if (!allowMobile && String(net.type).toUpperCase() !== 'WIFI') return { ok: false, reason: 'wifi' };
  const need = Math.max(0, MODELS[m].bytes - (await sizeOf(partPath(m)))) * 1.15 + 150e6;
  let free = Infinity;
  try { free = await FS.getFreeDiskStorageAsync(); } catch {}
  if (free < need) return { ok: false, reason: 'space', needMB: Math.ceil(need / 1e6), freeMB: Math.floor(free / 1e6) };
  return { ok: true };
}

let job: FS.DownloadResumable | null = null;
let poll: any = null;
let userStop: 'pause' | 'cancel' | '' = '';
let running = false;

// Checks Wi-Fi + storage first (returned at once), then downloads in the background with automatic resume.
export async function startDownload(allowMobile = false): Promise<Pre> {
  if (running || llm.phase === 'ready') return { ok: true };
  set({ phase: 'checking', msg: '' });
  const pf = await preflight(allowMobile);
  if (!pf.ok) { set({ phase: (await sizeOf(partPath(llm.model))) ? 'paused' : 'none' }); return pf; }
  running = true; userStop = '';
  download().catch((e) => set({ phase: 'error', msg: String(e?.message || e).slice(0, 100) })).finally(() => { running = false; });
  return pf;
}

async function download() {
  const id = llm.model, m = MODELS[id];
  await FS.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});
  set({ phase: 'downloading', msg: '' });
  poll = setInterval(async () => { const n = await sizeOf(partPath(id)); if (llm.phase === 'downloading') set({ got: n }); }, 1000);
  let ok = false, err = '';
  try {
    for (let attempt = 0; attempt < 5 && !userStop && !ok; attempt++) {
      const have = await sizeOf(partPath(id));
      if (have > m.bytes * 1.07) await FS.deleteAsync(partPath(id), { idempotent: true });      // bad leftover
      const resume = await sizeOf(partPath(id));
      job = FS.createDownloadResumable(m.url, partPath(id), {}, undefined, resume > 0 ? String(resume) : undefined);
      try {
        const r: any = await job.downloadAsync();
        if (userStop) break;
        if (r && (r.status === 200 || r.status === 206)) ok = true; else err = `HTTP ${r?.status ?? '?'}`;
      } catch (e: any) { if (userStop) break; err = String(e?.message || e); }
      if (!ok && !userStop) await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));      // wait, then resume
    }
  } finally { clearInterval(poll); job = null; }

  if (userStop === 'cancel') { await FS.deleteAsync(partPath(id), { idempotent: true }); set({ phase: 'none', got: 0 }); return; }
  if (userStop === 'pause') { set({ phase: 'paused', got: await sizeOf(partPath(id)) }); return; }
  if (!ok) { set({ phase: 'paused', got: await sizeOf(partPath(id)), msg: err.slice(0, 100) || 'download stopped - tap Resume' }); return; }

  const size = await sizeOf(partPath(id));
  if (!sane(id, size) || !(await isGguf(partPath(id)))) {                       // wrong size / not a GGUF file: start clean
    await FS.deleteAsync(partPath(id), { idempotent: true });
    set({ phase: 'error', got: 0, msg: 'Downloaded file is damaged - tap Download again' });
    return;
  }
  await FS.deleteAsync(finalPath(id), { idempotent: true });
  await FS.moveAsync({ from: partPath(id), to: finalPath(id) });
  set({ phase: 'ready', got: size, msg: '' });
}

export async function pauseDownload() { userStop = 'pause'; try { await job?.pauseAsync(); } catch {} }
export async function cancelDownload() {
  userStop = 'cancel';
  try { await job?.pauseAsync(); } catch {}
  if (!running) { await FS.deleteAsync(partPath(llm.model), { idempotent: true }); set({ phase: 'none', got: 0 }); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Running the model
let ctx: any = null;
let idle: any = null;
const touch = () => { clearTimeout(idle); idle = setTimeout(() => { try { ctx?.release?.(); } catch {} ctx = null; }, 180000); };   // free RAM after 3 min

async function getCtx(): Promise<any | null> {
  if (llm.phase !== 'ready') return null;
  if (active) {                                    // an old (cancelled) job is still running inside the model: stop it, or reload the model
    try { ctx?.stopCompletion?.(); } catch {}
    await Promise.race([active, new Promise((r) => setTimeout(r, 2500))]);
    if (active) { try { await ctx?.release?.(); } catch {} ctx = null; active = null; }
  }
  if (ctx) { touch(); return ctx; }
  try {
    const { initLlama } = require('llama.rn');
    ctx = await initLlama({ model: finalPath(llm.model).replace(/^file:\/\//, ''), n_ctx: 3072, n_threads: 4, n_gpu_layers: 0, use_mlock: false });
    touch();
    return ctx;
  } catch {
    ctx = null;
    if (llm.model === 'q15') {                     // not enough memory for 1.5B: fall back to 0.5B (downloaded once, automatically)
      await FS.deleteAsync(finalPath('q15'), { idempotent: true }).catch(() => {});
      await setMeta('llm_model', 'q05').catch(() => {});
      set({ model: 'q05', total: MODELS.q05.bytes, got: 0, phase: 'none', msg: 'Phone memory is low: switching to the 0.5B model' });
      startDownload(false).catch(() => {});
    } else set({ phase: 'error', msg: 'Model could not start on this phone' });
    return null;
  }
}

// "anemia 10 marks" -> { q: 'anemia', marks: 10 }   (default 5 marks)
const WORDN: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, twelve: 12 };
export function splitMarks(q: string): { q: string; marks: number } {
  const m = q.match(/\b(\d{1,2}|two|three|four|five|six|seven|eight|ten|twelve)\s*(?:marks?|m)\b/i);
  if (!m) return { q: q.trim(), marks: 5 };
  const n = /^\d/.test(m[1]) ? parseInt(m[1], 10) : WORDN[m[1].toLowerCase()];
  return { q: q.replace(m[0], ' ').replace(/\s+/g, ' ').trim(), marks: Math.min(15, Math.max(2, n || 5)) };
}
const range = (marks: number): [number, number] =>
  marks <= 2 ? [3, 4] : marks <= 4 ? [4, 6] : marks <= 7 ? [6, 8] : marks <= 9 ? [8, 11] : [10, 14];

// ---------------------------------------------------------------------------------------------------------------------
// The sections of a note depend on WHAT the topic is. A test has Principle/Procedure, a disease has Etiology/Pathogenesis,
// a germ has Morphology/Culture. "Classification" is written ONLY when the source itself lists types - never forced.
type Kind = 'test' | 'organism' | 'disease' | 'other';
const TEST_RX = /\b(estimation|determination|measurement|test|tests|count|counting|stain|staining|method|technique|assay|procedure|medium|media|microscope|microscopy|centrifuge|analy[sz]er|smear|culture|sterili[sz]ation|collection|preparation|reaction)\b/i;
const ORG_RX = /(coccus|cocci|bacillus|bacilli|bacter|virus|viridae|vibrio|salmonella|shigella|klebsiella|pseudomonas|proteus|escherichia|e\. ?coli|clostridi|mycobacter|treponema|plasmodium|leishmania|entamoeba|giardia|candida|aspergillus|helminth|worm|fungus|fungi|rickettsia|chlamydia|mycoplasma|staphylo|strepto|neisseria|haemophilus|hemophilus|brucella|borrelia|trypanosoma|filaria|taenia|ascaris|ancylostoma)/i;
const DIS_RX = /(itis\b|emia\b|aemia\b|osis\b|oma\b|pathy\b|penia\b|philia\b|syndrome|infection|fever|anemia|anaemia|leuk|lymphoma|myeloma|cancer|carcinoma|failure|deficiency|disease|disorder|diabetes|hepatitis|tuberculosis|malaria|typhoid|cholera)/i;
const kindOf = (name: string): Kind => TEST_RX.test(name) ? 'test' : ORG_RX.test(name) ? 'organism' : DIS_RX.test(name) ? 'disease' : 'other';
const ORDER: Record<Kind, string> = {
  test: 'Principle, Requirements (reagents / apparatus), Procedure, Calculation / Normal values, Interpretation, Sources of error, Clinical significance',
  organism: 'Morphology, Culture, Antigens / Virulence factors, Pathogenesis, Clinical features, Lab diagnosis, Treatment, Prevention',
  disease: 'Definition, Etiology, Pathogenesis, Clinical features, Lab diagnosis, Complications, Treatment',
  other: 'Definition first (only if the text really defines it), then the topic\'s own parts in the order of the text',
};
const RULES = `Use ONLY the sections that really apply to THIS topic, and only as far as the text covers them. Do not fill a template.
Write a "Classification" / "Types" point ONLY when the text itself lists types, classes or groups - otherwise do not write it at all.
Never write an empty or generic point. Point titles must be the real names used in the text.`;

const SYSTEM = (lo: number, hi: number, kind: Kind) => `You write university exam answers exactly like a topper's exam copy (medical lab technology).
Use ONLY the SOURCE text. Never add a fact, number or name that is not in the SOURCE. Write in the language of the SOURCE.
Cover EVERY part of the SOURCE that is about the topic - do not skip a section, a list, a table row or a value.
The SOURCE may be several passages taken from different places of the books: merge them into ONE clean answer, remove repeats, and ignore any passage that is not about the topic.
The topic name was typed by voice and may be slightly misspelled: write about the topic the SOURCE is really about.
Format: clean numbered points, one point per line, EXACTLY like:
1. **Title**: Concise explanation here.
2. **Title**: Concise explanation here.
Rules: no introduction, no conclusion, no filler words.
- Title: the real topic or concept name used in the SOURCE, 2 to 5 words, inside ** **.
- Explanation: 1 or 2 short, complete sentences (at most 25 words). Never stop in the middle of a sentence.
- Never repeat the title inside the explanation and never write the same word twice in a row. Do not start the explanation with the title.
- Bold only the title. Keep numbers, units and names exactly as in the SOURCE.
Suggested order for this kind of topic: ${ORDER[kind]}.
${RULES}
Write ${lo} to ${hi} points (fewer if the SOURCE has less).
If the SOURCE has nothing about the topic, reply exactly: NOT_IN_SOURCE`;

const flat = (s: string) => s.toLowerCase().replace(/ae/g, 'e');
function supported(line: string, srcN: string, srcWords: Set<string>): boolean {
  const nums = line.match(/\d+(?:\.\d+)?/g) || [];
  for (const n of nums) if (!srcN.includes(n)) return false;                     // an invented number
  const ws = (flat(line).match(/\p{L}{4,}/gu) || []);
  if (!ws.length) return true;
  let hit = 0;
  for (const w of ws) if (srcWords.has(w) || srcN.includes(w.slice(0, Math.max(4, w.length - 2)))) hit++;
  return hit / ws.length >= 0.6;                                                 // most words must come from the source
}

function parseAnswer(text: string, src: string, hi: number, check = true): Point[] {
  const srcN = flat(src);
  const srcWords = new Set(srcN.match(/\p{L}{4,}/gu) || []);
  const pts: Omit<Point, 'n'>[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = raw.match(/^\s*(?:\d+[.)]|[-*•])\s*(.+)$/);
    if (!m) continue;
    let title = '', body = m[1].trim();
    const b = body.match(/^\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/);
    if (b) { title = b[1]; body = b[2]; }
    else { const c = body.match(/^([^:]{2,40}):\s+(.+)$/); if (c) { title = c[1]; body = c[2]; } else title = ''; }   // no label: tidyPoint() finds a natural split or leaves it untitled
    const tp = tidyPoint(title, body);                    // title cleanly separated; a body that repeats the title is cleaned
    if (!tp.title && !tp.text) continue;
    const line = `${tp.title} ${tp.text}`;
    if (check && !supported(line, srcN, srcWords)) continue;
    pts.push({ title: tp.title, text: tp.text });
    if (pts.length >= hi) break;
  }
  return pts.map((p, i) => ({ n: i + 1, ...p }));
}

export type LlmResult = { pts: Point[] | null; notInSource: boolean; cancelled?: boolean };
const MAXSRC = () => (llm.model === 'q05' ? 3200 : 5200);

// "stop" / a newer request cancels the running job (the phone stops computing at once)
let jobId = 0;
let active: Promise<any> | null = null;          // the native completion that is running right now
const cancelHooks = new Set<() => void>();
export function cancelGen() { jobId++; searchJob++; try { searchAbort?.abort(); } catch {} try { ctx?.stopCompletion?.(); } catch {} cancelHooks.forEach((f) => f()); }   // waiting jobs return at once

async function complete(c: any, job: number, messages: any[], nPredict: number, temperature: number, onToken?: (t: string) => void): Promise<{ text: string; cancelled: boolean; cut?: boolean }> {
  if (job !== jobId) return { text: '', cancelled: true };
  let timer: any;
  let hook: (() => void) | null = null;
  try {
    const run = c.completion({
      messages, n_predict: nPredict, temperature, top_p: 0.9, penalty_repeat: 1.1,
      stop: ['<|im_end|>', '<|endoftext|>'],
    }, onToken ? (d: any) => { if (job === jobId && d?.token) onToken(String(d.token)); } : undefined);   // tokens arrive while the model writes: the screen can show every finished line at once
    const tracked: Promise<any> = Promise.resolve(run).catch(() => {}).then(() => { if (active === tracked) active = null; });
    active = tracked;
    const out: any = await Promise.race([
      run,
      new Promise((res) => { timer = setTimeout(() => { try { c.stopCompletion?.(); } catch {} res(null); }, 150000); }),
      new Promise((res) => { hook = () => res(null); cancelHooks.add(hook); }),
    ]);
    touch();
    return { text: job === jobId ? String(out?.text || '').trim() : '', cancelled: job !== jobId, cut: !!out?.stopped_limit };   // cut = stopped because the token limit was reached (last line may be unfinished)
  } catch { return { text: '', cancelled: job !== jobId }; }
  finally { clearTimeout(timer); if (hook) cancelHooks.delete(hook); }
}
const tokens = (hi: number) => Math.min(900, hi * 55 + 80);     // no more tokens than the points need (faster on the phone)

// Cuts a long source into pieces (at blank lines) so NO portion is left out; each piece is written separately.
function pieces(body: string, max: number): string[] {
  const text = body.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\n+/)) {
    if (cur && cur.length + para.length + 2 > max) { out.push(cur); cur = ''; }
    if (para.length > max) { for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max)); continue; }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur) out.push(cur);
  return out;
}

// The model ran out of tokens in the middle of a line: keep only its whole sentences (or nothing).
const trimCut = (l: string) => { const t = l.trim(); if (/[.!?।]["')\]]?$/.test(t)) return t; const m = t.match(/^(.*[.!?।])\s/); return m ? m[1] : ''; };
const dropCutTail = (text: string) => { const ls = text.split('\n'); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i >= 0) ls[i] = trimCut(ls[i]); return ls.join('\n'); };

// Cuts the model's output into finished lines while it is still being written.
function lineStream(onLine: (line: string) => void) {
  let buf = '';
  let tokens = 0;
  return {
    push(t: string) {
      tokens++; buf += t;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    },
    flush(cut = false) { const l = cut ? trimCut(buf) : buf; if (l.trim()) onLine(l); buf = ''; },
    got: () => tokens,
  };
}

// null pts = the model was not usable / gave nothing good -> caller uses the rule-based notes
// onPoint: every point is handed over the moment its line is finished (the screen shows it and the voice starts reading it).
export async function llmNotes(name: string, body: string, marks: number, onProgress?: (i: number, n: number) => void, onPoint?: (p: Point) => void): Promise<LlmResult> {
  const c = await getCtx();
  if (!c) return { pts: null, notInSource: false };
  const job = ++jobId;
  const parts = pieces(body, MAXSRC());
  const [lo0, hi0] = parts.length > 1 ? [4, 8] : range(marks);        // long topic: every piece gets its own points
  const kind = kindOf(name);
  const all: Omit<Point, 'n'>[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i + 1, parts.length);
    const src = parts[i];
    // every finished line becomes a point at once (checked against the source like before, repeats dropped)
    let taken = 0;
    const take = (line: string) => {
      if (taken >= hi0 || all.length >= 40) return;
      for (const p of parseAnswer(line, src, hi0)) {
        const k = (p.title + p.text).toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); taken++;
        all.push({ title: p.title, text: p.text });
        onPoint?.({ n: all.length, title: p.title, text: p.text });
      }
    };
    const ls = lineStream(take);
    const r = await complete(c, job, [
      { role: 'system', content: SYSTEM(lo0, hi0, kind) },
      { role: 'user', content: `Topic: ${name}\nMarks: ${marks}${parts.length > 1 ? `\nPart ${i + 1} of ${parts.length} of the source` : ''}\n\nSOURCE:\n${src}\n\nWrite the answer.` },
    ], tokens(hi0), 0.1, onPoint ? (t) => ls.push(t) : undefined);
    if (r.cancelled) return { pts: null, notInSource: false, cancelled: true };
    if (!r.text) { missing++; continue; }
    if (/NOT_IN_SOURCE/.test(r.text)) { if (parts.length === 1) return { pts: null, notInSource: true }; continue; }
    const txt = r.cut ? dropCutTail(r.text) : r.text;
    if (onPoint) { if (ls.got()) ls.flush(!!r.cut); else txt.split('\n').forEach((l) => { if (l.trim()) take(l); }); }   // last line (no newline after it) / a model build that gives no live tokens
    else for (const p of parseAnswer(txt, src, hi0)) { const k = (p.title + p.text).toLowerCase(); if (!seen.has(k)) { seen.add(k); all.push({ title: p.title, text: p.text }); } }
  }
  // streaming: points were already shown and spoken, so a failed piece is skipped; without streaming a hole means "use the complete rule-based notes"
  if (missing && !onPoint) return { pts: null, notInSource: false };
  return { pts: all.length >= 2 ? all.slice(0, 40).map((p, i) => ({ n: i + 1, ...p })) : null, notInSource: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// "explain <topic>": the model's OWN knowledge (an optional web reference helps). Not limited to the user's sources.
// Written like a topper's full note: the topic is split into SECTIONS (Definition, Etiology, Pathogenesis...) and every
// section is generated on its own, with 4-6 bullet lines each (+ a Banglish hint line). One small job per section works
// far better on a small phone model than one giant answer.
export const EXPLAIN_BANGLISH = true;          // false = no "Banglish:" hint line under each point
const SECTIONS: Record<Kind, string[]> = {
  disease: ['Definition', 'Etiology', 'Types', 'Pathogenesis', 'Clinical features', 'Lab diagnosis', 'Complications', 'Treatment', 'Prevention'],
  test: ['Definition', 'Principle', 'Requirements', 'Procedure', 'Calculation and normal range', 'Interpretation', 'Sources of error', 'Clinical significance'],
  organism: ['Definition', 'Morphology', 'Culture', 'Virulence factors', 'Pathogenesis', 'Clinical features', 'Lab diagnosis', 'Treatment and prevention'],
  other: ['Definition', 'Key features', 'How it works', 'Types or parts', 'Importance in the lab', 'Clinical significance'],
};
const SEC_HINT: Record<string, string> = {
  'Definition': 'The FIRST bullet must be a complete exam-ready definition that starts with "Definition:". Then: what it is, who or what is affected, why it matters.',
  'Etiology': 'List every important cause and risk factor (organisms, drugs, conditions, age groups), one per bullet.',
  'Types': 'Write this ONLY if the topic really has types or classes: one bullet per type with its key point. If it has no real types, reply exactly: SKIP',
  'Pathogenesis': 'Explain step by step how it happens, one step per bullet, in order.',
  'Clinical features': 'One sign or symptom per bullet, the most important first, with the typical finding.',
  'Lab diagnosis': 'List the tests that confirm it, the sample, and the typical result of each test (use real values only if sure).',
  'Procedure': 'Numbered steps in the correct order, one short step per bullet, with volumes, times and speeds if sure.',
  'Calculation and normal range': 'Give the formula and the normal values for male and female (units too) only if you are sure.',
  'Sources of error': 'One common mistake or error per bullet and how to avoid it.',
  'Treatment': 'Main drugs or measures, supportive care, and when each is used.',
  'Complications': 'The important complications, one per bullet.',
};
const sectionCount = (marks: number) => (marks <= 0 ? 99 : marks <= 2 ? 3 : marks <= 4 ? 4 : marks <= 7 ? 6 : marks <= 9 ? 7 : 99);

const SEC_SYS = (topic: string, sec: string, lo: number, hi: number) => `You are a medical laboratory technology teacher writing ONE section of a topper's exam note, from your own correct textbook knowledge.
Topic: ${topic}. Section: ${sec}.
Write ${lo} to ${hi} bullet lines for this section.
Rules:
- Every bullet starts with "- ". One idea per bullet, simple English, 8 to 22 words. Start with the key word, like "- Fever: usually high, above 38 C."
- Cover the section completely: every important cause, step, value or name a student must write in the exam. No empty or generic lines.
- Never invent numbers, names or facts you are not sure about. Do not repeat the topic name in every line.
- No introduction, no conclusion, no headings, no numbering, no bold.
${EXPLAIN_BANGLISH ? '- After the bullets write ONE last line that starts with "Banglish:" and explains this section in very simple Bengali written in English letters, maximum 20 words.\n' : ''}- If this section does not apply to the topic at all, reply exactly: SKIP
${SEC_HINT[sec] || ''}
A REFERENCE (from the web) may be given: use it only where it helps, ignore it when it is off-topic.`;

function parseSection(text: string, seen: Set<string>): { bullets: string[]; hint: string } {
  const bullets: string[] = [];
  let hint = '';
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    let l = raw.trim().replace(/^(?:[-*•▪●]|\d+[.)])\s*/, '').replace(/\*+/g, '').trim();
    if (!l) continue;
    const bn = l.match(/^banglish\s*:\s*(.+)$/i);
    if (bn) { if (!hint && bn[1].trim().split(/\s+/).length >= 4) hint = bn[1].trim(); continue; }
    if (l.length < 8) continue;
    const k = l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(k)) continue;
    seen.add(k);
    bullets.push(/[.!?।]$/.test(l) ? l : l + '.');
    if (bullets.length >= 7) break;
  }
  return { bullets, hint };
}

export async function llmExplain(name: string, marks: number, ref = '', onProgress?: (i: number, n: number, title: string) => void, onPoint?: (p: Point) => void): Promise<LlmResult> {
  const c = await getCtx();
  if (!c) return { pts: null, notInSource: false };
  const job = ++jobId;
  const kind = kindOf(name);
  const secs = SECTIONS[kind].slice(0, sectionCount(marks));
  const [lo, hi] = marks > 0 && marks <= 2 ? [3, 4] : marks > 0 && marks <= 4 ? [4, 5] : [4, 6];
  const refTxt = ref ? `\n\nREFERENCE:\n${ref.slice(0, llm.model === 'q05' ? 1200 : 1800)}` : '';
  const seen = new Set<string>();
  const pts: Point[] = [];
  for (let i = 0; i < secs.length; i++) {
    const sec = secs[i];
    onProgress?.(i + 1, secs.length, sec);
    let got: { bullets: string[]; hint: string } = { bullets: [], hint: '' };
    for (let attempt = 0; attempt < 2; attempt++) {                       // one retry if the model wrote too little
      const r = await complete(c, job, [
        { role: 'system', content: SEC_SYS(name, sec, lo, hi) },
        { role: 'user', content: `Write the "${sec}" section of the note on: ${name}.${refTxt}` },
      ], 380, attempt ? 0.35 : 0.2);
      if (r.cancelled) return { pts: null, notInSource: false, cancelled: true };
      if (/^\s*SKIP\b/i.test(r.text)) break;
      got = parseSection(r.text, new Set(seen));
      if (got.bullets.length >= 3) break;
    }
    if (got.bullets.length < 2) continue;                                 // section skipped / not usable
    got.bullets.forEach((b) => seen.add(b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
    const pt: Point = { n: pts.length + 1, title: sec, text: got.bullets.join(' '), bullets: got.bullets, hint: got.hint || undefined };
    pts.push(pt);
    onPoint?.(pt);                                                        // this section is shown and read while the next one is written
  }
  return { pts: pts.length >= 2 ? pts : null, notInSource: false };
}

// A spoken / typed QUESTION: the model thinks, uses the user's source excerpts where they help, and adds its own
// knowledge where the sources are silent. `basis` says how much of the answer really came from the sources.
const ANSWER_SYS = `You are a medical laboratory technology tutor answering a student's question as a topper's exam answer.
You get SOURCE excerpts from the student's own notes. Think about the question, then answer it.
Use the SOURCE facts whenever they are relevant. If the SOURCE is missing or incomplete, complete the answer with correct standard textbook knowledge.
Never invent numbers, names or facts you are not sure about. Answer in the language of the question.
Format: clean numbered points, one point per line, EXACTLY like:
1. **Title**: Concise explanation here.
2. **Title**: Concise explanation here.
Rules: no introduction, no conclusion. Title = 2 to 5 words inside ** **. Explanation = 1 or 2 short, complete sentences (at most 25 words), never cut in the middle, never repeating the title. Write 4 to 8 points.
Only the points the question needs - no fixed template, no "Classification" unless the question is about types.`;

export type Basis = 'source' | 'mixed' | 'own';
export type AnswerResult = { pts: Point[] | null; basis: Basis; cancelled?: boolean };

export async function llmAnswer(question: string, chunks: { name: string; body: string }[], onPoint?: (p: Point) => void): Promise<AnswerResult> {
  const c = await getCtx();
  if (!c) return { pts: null, basis: 'own' };
  const job = ++jobId;
  const per = llm.model === 'q05' ? 900 : 1500;
  const src = chunks.map((x, i) => `[${i + 1}] ${x.name}\n${x.body.slice(0, per)}`).join('\n\n').slice(0, MAXSRC());
  let shown = 0;
  const seenA = new Set<string>();
  const takeA = (line: string) => {
    if (shown >= 10) return;
    for (const p of parseAnswer(line, '', 10, false)) {
      const k = (p.title + p.text).toLowerCase();
      if (seenA.has(k)) continue;
      seenA.add(k); shown++;
      onPoint?.({ n: shown, title: p.title, text: p.text });
    }
  };
  const lsA = lineStream(takeA);
  const r = await complete(c, job, [
    { role: 'system', content: ANSWER_SYS },
    { role: 'user', content: `QUESTION: ${question}\n\nSOURCE:\n${src || '(nothing found in the sources)'}\n\nWrite the answer.` },
  ], 420, 0.2, onPoint ? (t) => lsA.push(t) : undefined);
  if (r.cancelled) return { pts: null, basis: 'own', cancelled: true };
  const txtA = r.cut ? dropCutTail(r.text) : r.text;
  if (onPoint) { if (lsA.got()) lsA.flush(!!r.cut); else txtA.split('\n').forEach((l) => { if (l.trim()) takeA(l); }); }
  const seenF = new Set<string>();
  const pts = parseAnswer(txtA, '', 10, false).filter((p) => { const k = (p.title + p.text).toLowerCase(); if (seenF.has(k)) return false; seenF.add(k); return true; }).map((p, i) => ({ ...p, n: i + 1 }));
  if (pts.length < 2) return { pts: null, basis: 'own' };
  // how much of the answer is really supported by the source excerpts (checked in code, not trusted from the model)
  const srcN = flat(src);
  const srcWords = new Set(srcN.match(/\p{L}{4,}/gu) || []);
  const hit = src ? pts.filter((p) => supported(`${p.title} ${p.text}`, srcN, srcWords)).length : 0;
  const basis: Basis = hit === 0 ? 'own' : hit >= pts.length * 0.8 ? 'source' : 'mixed';
  return { pts, basis };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live Google search through the Gemini API (Grounding with Google Search). Online only: an alternative to the local Qwen model.
// "search <anything>" -> Gemini searches Google, writes 2-8 numbered study points -> the same Point[] the rest of the app already reads.
// NOTE: gemini-2.0-flash was shut down by Google on 1 June 2026, and gemini-2.5-flash is scheduled for 16 October 2026.
// So the default is gemini-3.5-flash; the model can be changed in Models, and a retired model falls back to the other one by itself.
export type GeminiModelId = 'gemini-3.5-flash' | 'gemini-3.1-flash-lite';
export const GEMINI_MODELS: { id: GeminiModelId; label: string; note: string }[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', note: 'Best answers' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', note: 'Fastest, lightest' },
];
// @ts-ignore  optional default key baked into the build (EXPO_PUBLIC_GEMINI_API_KEY); a key typed in Models always wins
const ENV_KEY: string = (typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_GEMINI_API_KEY) || '';
export const gem: { key: string; model: GeminiModelId } = { key: '', model: 'gemini-3.5-flash' };
export const hasEnvKey = () => !!ENV_KEY;
export const hasGeminiKey = () => !!(gem.key || ENV_KEY);
export async function loadGemini() {
  gem.key = ((await getMeta('gemini_key').catch(() => '')) || '').trim();
  const m = (await getMeta('gemini_model').catch(() => '')) as GeminiModelId;
  if (GEMINI_MODELS.some((x) => x.id === m)) gem.model = m;
}
export async function saveGeminiKey(k: string) { gem.key = k.trim(); await setMeta('gemini_key', gem.key).catch(() => {}); }
export async function saveGeminiModel(m: GeminiModelId) { gem.model = m; await setMeta('gemini_model', m).catch(() => {}); }

export type GeminiErrKind = 'nokey' | 'badkey' | 'offline' | 'quota' | 'empty' | 'http' | 'cancelled';
export class GeminiError extends Error {
  kind: GeminiErrKind;
  constructor(kind: GeminiErrKind, msg = '') { super(msg || kind); this.kind = kind; }
}

let searchJob = 0;
let searchAbort: AbortController | null = null;

// short / fact question -> 2-3 points; long or "explain / compare" question -> 5-8 points
export function searchDepth(q: string): { lo: number; hi: number; deep: boolean } {
  const words = q.trim().split(/\s+/).filter(Boolean).length;
  const deep = words >= 6 || /\b(explain|mechanism|compare|comparison|difference|differences|differentiate|distinguish|pathogenesis|versus|vs)\b/i.test(q) || /(ব্যাখ্যা|পার্থক্য)/.test(q);
  return deep ? { lo: 5, hi: 8, deep } : { lo: 2, hi: 3, deep };
}

const searchPrompt = (q: string, lo: number, hi: number, deep: boolean) => `You are a medical laboratory technology teacher. Use Google Search to find current, correct information, then write exam-ready study notes for this question:
"${q}"

Write ${lo} to ${hi} numbered points.${deep ? ' Cover what applies: definition, mechanism or principle, clinical features, laboratory diagnosis, key facts and values.' : ' Only the most important, high-yield facts.'}
Format: one point per line, EXACTLY like:
1. **Key Concept**: 1-2 clear factual sentences.
2. **Key Concept**: 1-2 clear factual sentences.
Rules:
- Key Concept = 2 to 5 words inside ** **. Explanation = 1 or 2 complete sentences, at most 30 words, never cut in the middle.
- Never repeat the Key Concept inside its explanation.
- No introduction, no conclusion, no headings, no links, no citation numbers like [1], no source names.
- Keep numbers, units and names exact. Answer in the language of the question.`;

const stripCites = (t: string) => t.replace(/\s*\[(?:\d+(?:\s*[,\u2013-]\s*\d+)*)\]/g, '').replace(/\s*\((?:source|sources)[^)]*\)/gi, '');
// "1. **A**: text\n   * more" -> the indented sub-bullet becomes part of point 1 (not a new point without a title)
function mergeSub(t: string): string {
  const out: string[] = [];
  for (const l of t.replace(/\r/g, '').split('\n')) {
    if (/^\s{2,}[-*\u2022]\s+\S/.test(l) && out.length) { const a = out[out.length - 1].trimEnd(); out[out.length - 1] = (/[.!?\u0964:;]$/.test(a) ? a : a + '.') + ' ' + l.replace(/^\s*[-*\u2022]\s+/, '').replace(/\*+/g, '').trim(); }
    else if (l.trim()) out.push(l);
  }
  return out.join('\n');
}

async function geminiCall(model: string, key: string, prompt: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
    signal,
  });
  if (!r.ok) return { status: r.status, text: '' };
  const data: any = await r.json().catch(() => null);
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  return { status: 200, text: parts.filter((p) => p?.text && !p.thought).map((p) => String(p.text)).join('') };
}

export async function searchWithGoogle(query: string, apiKey?: string, model?: GeminiModelId): Promise<Point[]> {
  const key = (apiKey || gem.key || ENV_KEY || '').trim();
  if (!key) throw new GeminiError('nokey');
  let net: any = null;
  try { net = await Network.getNetworkStateAsync(); } catch {}
  if (net && (!net.isConnected || net.isInternetReachable === false)) throw new GeminiError('offline');

  const my = ++searchJob;
  try { searchAbort?.abort(); } catch {}
  const ctl = new AbortController();
  searchAbort = ctl;
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, 30000);
  const { lo, hi, deep } = searchDepth(query);
  const prompt = searchPrompt(query.trim(), lo, hi, deep);
  const first = model || gem.model;
  const order: GeminiModelId[] = [first, ...GEMINI_MODELS.map((m) => m.id).filter((id) => id !== first)];
  try {
    let text = '';
    let lastStatus = 0;
    for (const m of order) {
      let res: { status: number; text: string };
      try { res = await geminiCall(m, key, prompt, ctl.signal); }
      catch (e: any) { if (my !== searchJob) throw new GeminiError('cancelled'); throw new GeminiError(ctl.signal.aborted ? 'http' : 'offline', String(e?.message || e)); }
      if (my !== searchJob) throw new GeminiError('cancelled');
      lastStatus = res.status;
      if (res.status === 200) { text = res.text; break; }
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new GeminiError('badkey', `HTTP ${res.status}`);
      if (res.status === 429) throw new GeminiError('quota', 'HTTP 429');
      if (res.status !== 404) break;                                  // 404 = this model id was retired: try the next one; anything else: stop
    }
    if (!text.trim()) throw new GeminiError(lastStatus && lastStatus !== 200 ? 'http' : 'empty', `HTTP ${lastStatus}`);
    const clean = mergeSub(stripCites(text));
    let pts = parseAnswer(clean, '', hi, false);
    if (!pts.length) {                                                // the model ignored the numbering: take its lines as points anyway
      const alt: Omit<Point, 'n'>[] = [];
      for (const l of clean.split('\n')) {
        const t = tidyPoint('', l.replace(/^\s*(?:\d+[.)]|[-*\u2022])\s*/, ''));
        if (t.text.length > 8) alt.push(t);
        if (alt.length >= hi) break;
      }
      pts = alt.map((p, i) => ({ n: i + 1, ...p }));
    }
    if (!pts.length) throw new GeminiError('empty');
    return pts;
  } finally { clearTimeout(timer); if (searchAbort === ctl) searchAbort = null; }
}
