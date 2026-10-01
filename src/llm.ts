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
Format: numbered points, one per line, exactly like:
1. **Keyword**: short line
Rules: no introduction, no conclusion, no filler words. Each line at most 18 words. Bold only the keyword. Keep numbers, units and names exactly as in the SOURCE.
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
    else { const c = body.match(/^([^:]{2,40}):\s+(.+)$/); if (c) { title = c[1]; body = c[2]; } else { title = body.split(/\s+/).slice(0, 5).join(' ').replace(/(\s+(the|of|to|and|a|an|in|is|are|on|for|with|by|that|which))+$/i, ''); } }
    title = title.replace(/\*+/g, '').replace(/[:.]+$/, '').trim();
    body = body.replace(/\*+/g, '').trim();
    if (!title) continue;
    const line = `${title} ${body}`;
    if (check && !supported(line, srcN, srcWords)) continue;
    pts.push({ title, text: /[.!?।]$/.test(body || title) ? (body || title) : (body || title) + '.' });
    if (pts.length >= hi) break;
  }
  return pts.map((p, i) => ({ n: i + 1, ...p }));
}

export type LlmResult = { pts: Point[] | null; notInSource: boolean; cancelled?: boolean };
const MAXSRC = () => (llm.model === 'q05' ? 3200 : 5200);

// "stop" / a newer request cancels the running job (the phone stops computing at once)
let jobId = 0;
export function cancelGen() { jobId++; try { ctx?.stopCompletion?.(); } catch {} }

async function complete(c: any, job: number, messages: any[], nPredict: number, temperature: number): Promise<{ text: string; cancelled: boolean }> {
  let timer: any;
  try {
    const run = c.completion({
      messages, n_predict: nPredict, temperature, top_p: 0.9, penalty_repeat: 1.1,
      stop: ['<|im_end|>', '<|endoftext|>'],
    });
    const out: any = await Promise.race([
      run,
      new Promise((res) => { timer = setTimeout(() => { try { c.stopCompletion?.(); } catch {} res(null); }, 150000); }),
    ]);
    clearTimeout(timer); touch();
    return { text: job === jobId ? String(out?.text || '').trim() : '', cancelled: job !== jobId };
  } catch { clearTimeout(timer); return { text: '', cancelled: job !== jobId }; }
}
const tokens = (hi: number) => Math.min(800, hi * 45 + 80);     // no more tokens than the points need (faster on the phone)

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

// null pts = the model was not usable / gave nothing good -> caller uses the rule-based notes
export async function llmNotes(name: string, body: string, marks: number, onProgress?: (i: number, n: number) => void): Promise<LlmResult> {
  const c = await getCtx();
  if (!c) return { pts: null, notInSource: false };
  const job = ++jobId;
  const parts = pieces(body, MAXSRC());
  const [lo0, hi0] = parts.length > 1 ? [4, 8] : range(marks);        // long topic: every piece gets its own points
  const kind = kindOf(name);
  const all: Omit<Point, 'n'>[] = [];
  let missing = 0;
  for (let i = 0; i < parts.length; i++) {
    onProgress?.(i + 1, parts.length);
    const src = parts[i];
    const r = await complete(c, job, [
      { role: 'system', content: SYSTEM(lo0, hi0, kind) },
      { role: 'user', content: `Topic: ${name}\nMarks: ${marks}${parts.length > 1 ? `\nPart ${i + 1} of ${parts.length} of the source` : ''}\n\nSOURCE:\n${src}\n\nWrite the answer.` },
    ], tokens(hi0), 0.1);
    if (r.cancelled) return { pts: null, notInSource: false, cancelled: true };
    if (!r.text) { missing++; continue; }
    if (/NOT_IN_SOURCE/.test(r.text)) { if (parts.length === 1) return { pts: null, notInSource: true }; continue; }
    for (const p of parseAnswer(r.text, src, hi0)) all.push({ title: p.title, text: p.text });
  }
  if (missing) return { pts: null, notInSource: false };             // a piece failed: better the complete rule-based notes than notes with a hole
  const seen = new Set<string>();
  const pts = all.filter((p) => { const k = (p.title + p.text).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return { pts: pts.length >= 2 ? pts.slice(0, 40).map((p, i) => ({ n: i + 1, ...p })) : null, notInSource: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// "explain <topic>": the model's OWN knowledge (an optional web reference helps). Not limited to the user's sources.
const EXPLAIN_SYS = (lo: number, hi: number, kind: Kind) => `You are a medical laboratory technology tutor. Explain the topic like a topper's exam copy, from your own correct textbook knowledge.
A REFERENCE (from the web) may be given: use it when it helps, ignore it when it is off-topic.
Never invent numbers, names or facts you are not sure about. Answer in the language of the topic.
Format: numbered points, one per line, exactly like:
1. **Keyword**: short line
Rules: no introduction, no conclusion. Each line at most 18 words. Bold only the keyword.
Suggested order for this kind of topic: ${ORDER[kind]}.
${RULES}
Write ${lo} to ${hi} points.`;

export async function llmExplain(name: string, marks: number, ref = ''): Promise<LlmResult> {
  const c = await getCtx();
  if (!c) return { pts: null, notInSource: false };
  const job = ++jobId;
  const [lo, hi] = range(marks);
  const refTxt = ref ? `\n\nREFERENCE:\n${ref.slice(0, llm.model === 'q05' ? 1800 : 2600)}` : '';
  const r = await complete(c, job, [
    { role: 'system', content: EXPLAIN_SYS(lo, hi, kindOf(name)) },
    { role: 'user', content: `Topic: ${name}\nMarks: ${marks}${refTxt}\n\nWrite the answer.` },
  ], tokens(hi), 0.2);
  if (r.cancelled) return { pts: null, notInSource: false, cancelled: true };
  const pts = parseAnswer(r.text, '', hi, false);
  return { pts: pts.length >= 2 ? pts : null, notInSource: false };
}

// A spoken / typed QUESTION: the model thinks, uses the user's source excerpts where they help, and adds its own
// knowledge where the sources are silent. `basis` says how much of the answer really came from the sources.
const ANSWER_SYS = `You are a medical laboratory technology tutor answering a student's question as a topper's exam answer.
You get SOURCE excerpts from the student's own notes. Think about the question, then answer it.
Use the SOURCE facts whenever they are relevant. If the SOURCE is missing or incomplete, complete the answer with correct standard textbook knowledge.
Never invent numbers, names or facts you are not sure about. Answer in the language of the question.
Format: numbered points, one per line, exactly like:
1. **Keyword**: short line
Rules: no introduction, no conclusion. Each line at most 20 words. Bold only the keyword. Write 4 to 8 points.
Only the points the question needs - no fixed template, no "Classification" unless the question is about types.`;

export type Basis = 'source' | 'mixed' | 'own';
export type AnswerResult = { pts: Point[] | null; basis: Basis; cancelled?: boolean };

export async function llmAnswer(question: string, chunks: { name: string; body: string }[]): Promise<AnswerResult> {
  const c = await getCtx();
  if (!c) return { pts: null, basis: 'own' };
  const job = ++jobId;
  const per = llm.model === 'q05' ? 900 : 1500;
  const src = chunks.map((x, i) => `[${i + 1}] ${x.name}\n${x.body.slice(0, per)}`).join('\n\n').slice(0, MAXSRC());
  const r = await complete(c, job, [
    { role: 'system', content: ANSWER_SYS },
    { role: 'user', content: `QUESTION: ${question}\n\nSOURCE:\n${src || '(nothing found in the sources)'}\n\nWrite the answer.` },
  ], 420, 0.2);
  if (r.cancelled) return { pts: null, basis: 'own', cancelled: true };
  const pts = parseAnswer(r.text, '', 10, false);
  if (pts.length < 2) return { pts: null, basis: 'own' };
  // how much of the answer is really supported by the source excerpts (checked in code, not trusted from the model)
  const srcN = flat(src);
  const srcWords = new Set(srcN.match(/\p{L}{4,}/gu) || []);
  const hit = src ? pts.filter((p) => supported(`${p.title} ${p.text}`, srcN, srcWords)).length : 0;
  const basis: Basis = hit === 0 ? 'own' : hit >= pts.length * 0.8 ? 'source' : 'mixed';
  return { pts, basis };
}
