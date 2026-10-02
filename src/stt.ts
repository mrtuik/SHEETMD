// Offline listening model (sherpa-onnx streaming zipformer, English). Downloaded once (~80 MB), then works with no internet.
// The model records the mic itself, so the phone's echo canceller can remove the app's own voice (phone-call style).
import * as FS from 'expo-file-system/legacy';
import { requireNativeModule } from 'expo';
import { getMeta, setMeta } from './db';

const HF = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main/';
// min = smallest believable size in bytes. A smaller file is a broken/partial download (error page, cut connection);
// feeding such a file to sherpa-onnx makes the native code abort the whole app, so we reject it here first.
export const STT_FILES: { name: string; mb: number; min: number }[] = [
  { name: 'tokens.txt', mb: 0, min: 1000 },
  { name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', mb: 70, min: 20_000_000 },
  { name: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', mb: 2, min: 100_000 },
  { name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', mb: 1, min: 50_000 },
];
const DIR = () => `${FS.documentDirectory}stt/`;
const np = (u: string) => u.replace(/^file:\/\//, '');

export const Stt: any = (() => { try { return requireNativeModule('SheetStt'); } catch { return null; } })();

export const sttState = { downloaded: false, ready: false, downloading: false, progress: 0, error: '', google: true, aec: true, gain: 6 };
const subs = new Set<() => void>();
export const subscribeStt = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const emit = () => subs.forEach((f) => f());
let lastProg = 0;
const emitProgress = () => { const n = Date.now(); if (n - lastProg < 400) return; lastProg = n; emit(); };   // the whole app re-renders on emit: do not do it 100x a second

// Crash guard: a native abort in sherpa-onnx cannot be caught in JS. We write a marker before the risky step and clear it after.
// If the app dies in between, the marker is still there on the next launch, so we know where it died and skip that step (no crash loop).
const setStage = (v: string) => setMeta('stt_stage', v).catch(() => {});

async function haveAll(): Promise<boolean> {
  for (const f of STT_FILES) {
    const i: any = await FS.getInfoAsync(DIR() + f.name).catch(() => null);
    if (!i?.exists || !(i.size >= f.min)) return false;
  }
  return true;
}

export async function initStt(): Promise<boolean> {
  try {
    sttState.google = (await getMeta('stt_google')) !== '0';
    sttState.aec = (await getMeta('stt_aec')) !== '0';
    const g = Number(await getMeta('stt_gain')); if (g >= 1 && g <= 12) sttState.gain = g;
  } catch {}
  try {
    const stage = await getMeta('stt_stage');
    if (stage === 'init') {
      await setStage('');
      sttState.error = 'The app closed while loading the offline model last time, so loading is paused. Delete the model and download again, or keep Google speech on.';
      sttState.downloaded = await haveAll(); sttState.ready = false; emit();
      return false;
    }
    if (stage === 'download') {
      await setStage('');
      sttState.error = 'The app closed while downloading last time. Tap Download to try again.';
    }
  } catch {}
  sttState.downloaded = await haveAll();
  if (!Stt || !sttState.downloaded) { emit(); return false; }
  if (sttState.ready || Stt.isReady()) { sttState.ready = true; emit(); return true; }
  await setStage('init');
  try { sttState.ready = !!(await Stt.init(np(DIR()), 2)); } catch { sttState.ready = false; }
  await setStage('');
  if (!sttState.ready) sttState.error = 'Model could not be loaded';
  emit();
  return sttState.ready;
}

export async function downloadStt(): Promise<boolean> {
  if (sttState.downloading) return false;
  sttState.downloading = true; sttState.error = ''; sttState.progress = 0; emit();
  await setStage('download');
  try {
    await FS.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});
    const total = STT_FILES.reduce((a, f) => a + f.mb, 0) || 1;
    let done = 0;
    for (const f of STT_FILES) {
      const dest = DIR() + f.name;
      const i: any = await FS.getInfoAsync(dest).catch(() => null);
      if (i?.exists && i.size >= f.min) { done += f.mb; continue; }
      await FS.deleteAsync(dest, { idempotent: true }).catch(() => {});
      const part = dest + '.part';
      await FS.deleteAsync(part, { idempotent: true }).catch(() => {});
      const dl = FS.createDownloadResumable(HF + f.name, part, {}, (p) => {
        const frac = p.totalBytesExpectedToWrite ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0;
        sttState.progress = Math.min(0.99, (done + f.mb * frac) / total); emitProgress();
      });
      const r: any = await dl.downloadAsync();
      if (!r || (r.status && r.status >= 400)) throw new Error('Download failed (' + (r?.status ?? '?') + ')');
      const got: any = await FS.getInfoAsync(part).catch(() => null);
      if (!got?.exists || !(got.size >= f.min)) {
        await FS.deleteAsync(part, { idempotent: true }).catch(() => {});
        throw new Error('Download incomplete: ' + f.name + ' (' + (got?.size ?? 0) + ' bytes). Check internet and try again.');
      }
      await FS.moveAsync({ from: part, to: dest });
      done += f.mb;
    }
    sttState.progress = 1; sttState.downloading = false; await setStage(''); emit();
    await new Promise((r) => setTimeout(r, 300));   // let the UI settle before the heavy native model load
    return await initStt();
  } catch (e: any) {
    sttState.downloading = false; await setStage(''); sttState.error = String(e?.message || e || 'Download failed'); emit();
    return false;
  }
}

export async function deleteStt() {
  try { Stt?.release(); } catch {}
  await FS.deleteAsync(DIR(), { idempotent: true }).catch(() => {});
  sttState.downloaded = false; sttState.ready = false; sttState.progress = 0; emit();
}

export const setSttGoogle = (b: boolean) => { sttState.google = b; setMeta('stt_google', b ? '1' : '0').catch(() => {}); emit(); };
export const setSttAec = (b: boolean) => { sttState.aec = b; setMeta('stt_aec', b ? '1' : '0').catch(() => {}); emit(); };
export const setSttGain = (g: number) => { sttState.gain = g; setMeta('stt_gain', String(g)).catch(() => {}); emit(); };
// Google switch ON = the phone's Google recognizer only. OFF = the offline sherpa-onnx model only. No fallback between them.
export const sttActive = () => !!Stt && sttState.ready && !sttState.google;
