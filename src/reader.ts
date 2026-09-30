import * as Speech from 'expo-speech';
import { cleanForSpeech } from './cleaner';
import { saveSession } from './db';
import type { Point } from './notes';

export type RState = {
  topicId: number; topic: string; points: Point[]; idx: number;
  status: 'idle' | 'reading' | 'paused'; rate: number; pauseSec: number; lang: 'auto' | 'en' | 'bn';
};
export const state: RState = { topicId: 0, topic: '', points: [], idx: 0, status: 'idle', rate: 0.7, pauseSec: 4, lang: 'auto' };

const subs = new Set<() => void>();
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const emit = () => subs.forEach((f) => f());

let token = 0;
let after: number | null = null;
let slow = false;
let spoken = '';
export const getSpoken = () => spoken;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function say(text: string): Promise<void> {
  return new Promise((res) => {
    const bn = state.lang === 'bn' || (state.lang === 'auto' && /[\u0980-\u09FF]/.test(text));
    const rate = slow ? state.rate * 0.9 : state.rate;
    slow = false;
    spoken = cleanForSpeech(text);
    Speech.speak(cleanForSpeech(text), {
      language: bn ? 'bn-BD' : 'en-US', rate,
      onDone: () => res(), onStopped: () => res(), onError: () => res(),
    });
  });
}

async function run(from: number, intro?: string) {
  const my = ++token;
  Speech.stop();
  state.idx = from; state.status = 'reading'; emit();
  if (intro) { await say(intro); if (my !== token) return; }
  while (my === token && state.idx < state.points.length) {
    const p = state.points[state.idx];
    emit();
    saveSession(state.topicId, p.n, state.rate).catch(() => {});
    await say(`${p.n}. ${p.title}. ${p.text}`);
    if (my !== token) return;
    await sleep(state.pauseSec * 1000);   // time to write
    if (my !== token) return;
    if (after !== null) { state.idx = after; after = null; } else state.idx++;
  }
  if (my === token) { state.idx = Math.max(0, state.points.length - 1); state.status = 'idle'; emit(); }
}

export function startTopic(id: number, name: string, points: Point[], announce = false) {
  state.topicId = id; state.topic = name; state.points = points; after = null;
  run(0, announce ? `Topic ${name}` : undefined);
}
export function restore(id: number, name: string, points: Point[], n: number, rate: number) {
  Object.assign(state, { topicId: id, topic: name, points, idx: Math.max(0, n - 1), rate, status: 'paused' });
  emit();
}
export function pause() {
  if (state.status !== 'reading') return;
  token++; Speech.stop(); state.status = 'paused'; emit();
}
export function resume() {
  if (!state.points.length) return;
  after = null; slow = true; run(state.idx);   // restart current point, a bit slower
}
export function stop() { token++; Speech.stop(); state.status = 'idle'; state.idx = 0; emit(); }
export function next() { after = null; run(Math.min(state.idx + 1, state.points.length - 1)); }
export function prev() { after = null; run(Math.max(state.idx - 1, 0)); }
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
  run(i);
  after = back;
}
export function setRate(d: number) { state.rate = Math.min(1.2, Math.max(0.3, +(state.rate + d).toFixed(1))); emit(); }
export function setPause(d: number) { state.pauseSec = Math.min(10, Math.max(1, state.pauseSec + d)); emit(); }
export function setLang(l: RState['lang']) { state.lang = l; emit(); }
