import { speak, stopSpeak } from './tts';
import { cleanForSpeech, speechChunks } from './cleaner';
import { saveSession, getMeta, setMeta } from './db';
import type { Point } from './notes';

export type RState = {
  topicId: number; topic: string; points: Point[]; idx: number; chunk: number;
  status: 'idle' | 'reading' | 'paused'; rate: number; pauseSec: number; lang: 'auto' | 'en' | 'bn';
  voiceEn: string; voiceBn: string;      // voice identifiers ('' = phone default)
  repeatOn: boolean; repeatN: number;    // say every line of a point 2-3 times (like a teacher)
};
export const state: RState = { topicId: 0, topic: '', points: [], idx: 0, chunk: 0, status: 'idle', rate: 0.7, pauseSec: 4, lang: 'auto', voiceEn: '', voiceBn: '', repeatOn: true, repeatN: 2 };

const subs = new Set<() => void>();
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const emit = () => subs.forEach((f) => f());

let token = 0;
let after: number | null = null;
let slow = false;
let spoken = '';
let resumeAt = 0;
let release: (() => void) | null = null;
export const getSpoken = () => spoken;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// chunk 0 = "Point 2. Principle." ; chunk 1.. = the sentences (the screen highlights the same chunks)
export function pointChunks(p: Point): string[] {
  // rich notes: ONE spoken line per bullet (the screen shows the same lines, the active one highlighted)
  const body = p.bullets?.length
    ? p.bullets.flatMap((b) => { const t = cleanForSpeech(b); return t.length <= 240 ? [t] : speechChunks(b); }).filter(Boolean)
    : speechChunks(p.text);
  const t = cleanForSpeech(p.title).replace(/[.]+$/, '').toLowerCase();
  const dup = !!t && !!body[0] && body[0].toLowerCase().startsWith(t);
  return [dup ? `Point ${p.n}.` : cleanForSpeech(`Point ${p.n}. ${p.title}`), ...body];
}

// which bullet (line) of a point a spoken chunk belongs to - the screen highlights that line
export function lineOf(p: Point, chunk: number): number {
  if (!p.bullets?.length || chunk < 0) return -1;
  let n = 0;
  for (let j = 0; j < p.bullets.length; j++) {
    const t = cleanForSpeech(p.bullets[j]);
    n += !t ? 0 : t.length <= 240 ? 1 : speechChunks(p.bullets[j]).length;
    if (chunk < n) return j;
  }
  return -1;
}

function halt() {
  stopSpeak();
  const r = release; release = null;
  r?.();                                   // never leave a reader loop waiting on a stopped utterance
}

// Queue every chunk at once (gapless, "streaming"); resolves when the last one finishes or is stopped.
function say(parts: string[], from = 0, track = false): Promise<void> {
  return new Promise((res) => {
    const todo = parts.slice(from);
    if (!todo.length) { res(); return; }
    const rate = slow ? state.rate * 0.9 : state.rate;
    slow = false;
    // every spoken line of a point is queued N times when "Repeat lines" is on (the heading line "Point 2. ..." is said once)
    const items: { text: string; k: number }[] = [];
    todo.forEach((text, k) => {
      const times = track && state.repeatOn && from + k > 0 ? Math.max(1, state.repeatN) : 1;
      for (let r = 0; r < times; r++) items.push({ text, k });
    });
    let left = items.length;
    release = () => res();
    items.forEach(({ text, k }) => {
      let done = false;
      const fin = () => { if (done) return; done = true; if (--left <= 0) { release = null; res(); } };
      const bn = state.lang === 'bn' || (state.lang === 'auto' && /[\u0980-\u09FF]/.test(text));
      const voice = (bn ? state.voiceBn : state.voiceEn) || undefined;
      speak(text, {
        lang: bn ? 'bn' : 'en', voice, rate,
        onStart: () => { spoken = track ? parts.join(' ') : text; if (track) { state.chunk = from + k; emit(); } },
        onDone: fin, onStopped: fin, onError: fin,
      });
    });
  });
}

async function run(from: number, intro?: string, chunk = 0) {
  const my = ++token;
  halt();
  state.idx = from; state.chunk = chunk; state.status = 'reading'; emit();
  if (intro) { await say(speechChunks(intro)); if (my !== token) return; }
  let start = chunk;
  while (my === token && state.idx < state.points.length) {
    const p = state.points[state.idx];
    state.chunk = start; emit();
    saveSession(state.topicId, p.n, state.rate).catch(() => {});
    await say(pointChunks(p), start, true);
    start = 0;
    if (my !== token) return;
    await sleep(state.pauseSec * 1000);   // time to write
    if (my !== token) return;
    if (after !== null) { state.idx = after; after = null; } else state.idx++;
  }
  if (my === token) { state.idx = Math.max(0, state.points.length - 1); state.chunk = 0; state.status = 'idle'; emit(); }
}

// Always says the topic name first, then reads point by point until you interrupt.
export function startTopic(id: number, name: string, points: Point[], intro?: string) {
  state.topicId = id; state.topic = name; state.points = points; after = null; resumeAt = 0;
  run(0, intro ?? `Topic ${name}. ${points.length} points.`);
}
export function restore(id: number, name: string, points: Point[], n: number, rate: number) {
  Object.assign(state, { topicId: id, topic: name, points, idx: Math.max(0, n - 1), chunk: 0, status: 'paused' });   // speed = the saved setting, not the old session's
  resumeAt = 0;
  emit();
}
export function pause() {
  if (state.status !== 'reading') return;
  resumeAt = state.chunk;
  token++; halt(); state.status = 'paused'; emit();
}
export function resume() {
  if (!state.points.length) return;
  after = null;
  if (state.status === 'idle') { resumeAt = 0; run(0); return; }      // finished or stopped: play again from the start
  slow = true;
  const c = state.status === 'paused' ? resumeAt : 0;
  resumeAt = 0;
  run(state.idx, undefined, c);                                        // continue from the sentence where it paused
}
export function reset() { token++; halt(); resumeAt = 0; after = null; Object.assign(state, { topicId: 0, topic: '', points: [], idx: 0, chunk: 0, status: 'idle' }); emit(); }
export function stop() { token++; halt(); resumeAt = 0; state.status = 'idle'; state.idx = 0; state.chunk = 0; emit(); }
export function goto(i: number) { if (!state.points.length) return; after = null; resumeAt = 0; run(Math.min(Math.max(i, 0), state.points.length - 1)); }
export function next() { goto(Math.min(state.idx + 1, state.points.length - 1)); }
export function prev() { goto(Math.max(state.idx - 1, 0)); }
export function repeat(arg?: string) {
  if (!state.points.length) return;
  let i = state.idx;
  if (arg) {
    const n = parseInt(arg, 10);
    if (!isNaN(n)) i = n - 1;
    else { const f = state.points.findIndex((p) => p.title.toLowerCase().includes(arg.toLowerCase())); if (f >= 0) i = f; }
  }
  i = Math.min(Math.max(i, 0), state.points.length - 1);
  const back = Math.min(state.idx + 1, state.points.length);
  resumeAt = 0;
  run(i);
  after = back;
}
let rateT: any = null;
export function setRate(d: number) {
  state.rate = Math.min(1.5, Math.max(0.3, +(state.rate + d).toFixed(1))); emit(); keep('rate', state.rate);
  // apply NOW: re-start the sentence being read with the new speed (taps are batched, so +,+,+ restarts once)
  if (state.status === 'reading') {
    clearTimeout(rateT);
    rateT = setTimeout(() => { if (state.status === 'reading') { const c = state.chunk; resumeAt = 0; run(state.idx, undefined, c); } }, 500);
  }
}
export function setPause(d: number) { state.pauseSec = Math.min(10, Math.max(0, state.pauseSec + d)); emit(); keep('pause', state.pauseSec); }
export function setLang(l: RState['lang']) { state.lang = l; emit(); keep('lang', l); }
export function setVoice(lang: 'en' | 'bn', id: string) { if (lang === 'bn') state.voiceBn = id; else state.voiceEn = id; emit(); }

// ---- settings that stay the same in every chat and after the app is closed ----
const keep = (k: string, v: string | number | boolean) => { setMeta('set_' + k, String(v)).catch(() => {}); };
export function setRepeat(on: boolean) { state.repeatOn = on; emit(); keep('repeat', on ? '1' : '0'); }
export function setRepeatN(d: number) { state.repeatN = Math.min(3, Math.max(2, state.repeatN + d)); emit(); keep('repeatn', state.repeatN); }
export async function loadSettings() {
  try {
    const g = (k: string) => getMeta('set_' + k).catch(() => '');
    const rate = parseFloat(await g('rate')); if (!isNaN(rate)) state.rate = Math.min(1.5, Math.max(0.3, rate));
    const pz = parseInt(await g('pause'), 10); if (!isNaN(pz)) state.pauseSec = Math.min(10, Math.max(0, pz));
    const lg = await g('lang'); if (lg === 'auto' || lg === 'en' || lg === 'bn') state.lang = lg;
    const ro = await g('repeat'); if (ro) state.repeatOn = ro === '1';
    const rn = parseInt(await g('repeatn'), 10); if (!isNaN(rn)) state.repeatN = Math.min(3, Math.max(2, rn));
  } catch {}
  emit();
}
