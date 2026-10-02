// Offline neural English voices: Piper VITS + Pocket TTS (voice cloning) via sherpa-onnx.
// Voices are downloaded on-demand, stored in app private storage, and run fully offline.
import * as FS from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import * as Device from 'expo-device';
import * as Speech from 'expo-speech';
import * as DocumentPicker from 'expo-document-picker';
import { requireNativeModule } from 'expo';
import { getMeta, setMeta } from './db';

export type VoiceAccent = 'US' | 'GB' | 'IN' | 'PK';   // IN = Indian-accent English speakers (one shared download per dataset), PK = Pocket TTS
export type VoiceGender = 'female' | 'male' | 'clone';

export type VoiceItem = {
  id: string;
  label: string;
  accent: VoiceAccent;
  gender: VoiceGender;
  quality: 'medium';
  url: string;
  bytes: number;
  license: string;
  note?: string;
  engine?: 'pocket';   // omitted = Piper (VITS)
  sid?: number;        // speaker id inside a multi-speaker Piper model (0 for single-speaker)
  pack?: string;       // voices that share ONE download point to the first voice's id
  ref?: 'bundled' | 'custom';   // Pocket: which reference WAV the voice is cloned from
  approx?: boolean;    // download size is an estimate: skip the strict size check
};

// Official Piper VITS medium-quality single-speaker English models from sherpa-onnx
export const VOICES: VoiceItem[] = [
  // US Voices (8 voices)
  {
    id: 'en_US-lessac-medium',
    label: 'Lessac - US female',
    accent: 'US',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2',
    bytes: 67_230_653,
    license: 'Non-commercial (Blizzard Challenge)',
    note: 'Clear, natural textbook style',
  },
  {
    id: 'en_US-amy-medium',
    label: 'Amy - US female',
    accent: 'US',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-medium.tar.bz2',
    bytes: 67_223_746,
    license: 'LGPL-3.0 (Mycroft Mimic3)',
    note: 'Warm and expressive',
  },
  {
    id: 'en_US-ryan-medium',
    label: 'Ryan - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-ryan-medium.tar.bz2',
    bytes: 67_213_100,
    license: 'CC BY-NC-SA 4.0',
    note: 'Confident narration',
  },
  {
    id: 'en_US-joe-medium',
    label: 'Joe - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-joe-medium.tar.bz2',
    bytes: 67_169_394,
    license: 'CC0 (Public Domain)',
    note: 'Conversational tone',
  },
  {
    id: 'en_US-kusal-medium',
    label: 'Kusal - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-kusal-medium.tar.bz2',
    bytes: 67_219_292,
    license: 'CC BY-SA 4.0 (Mimic2)',
    note: 'Crisp articulation',
  },
  {
    id: 'en_US-hfc_female-medium',
    label: 'HFC - US female',
    accent: 'US',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-hfc_female-medium.tar.bz2',
    bytes: 67_228_166,
    license: 'CC BY-NC-SA 4.0',
    note: 'Bright, balanced voice',
  },
  {
    id: 'en_US-hfc_male-medium',
    label: 'HFC - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-hfc_male-medium.tar.bz2',
    bytes: 67_214_049,
    license: 'CC BY-NC-SA 4.0',
    note: 'Deep, steady tone',
  },
  {
    id: 'en_US-norman-medium',
    label: 'Norman - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-norman-medium.tar.bz2',
    bytes: 67_203_672,
    license: 'Public Domain',
    note: 'Classic reading tone',
  },
  // GB Voices (4 voices)
  {
    id: 'en_GB-alan-medium',
    label: 'Alan - UK male',
    accent: 'GB',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alan-medium.tar.bz2',
    bytes: 67_220_121,
    license: 'LGPL-3.0 (Mycroft Mimic3)',
    note: 'British RP, poised and formal',
  },
  {
    id: 'en_GB-jenny_dioco-medium',
    label: 'Jenny - UK female',
    accent: 'GB',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-jenny_dioco-medium.tar.bz2',
    bytes: 67_225_842,
    license: 'CC BY-SA 4.0 (Jenny TTS)',
    note: 'Clear British narration',
  },
  {
    id: 'en_GB-alba-medium',
    label: 'Alba - UK female',
    accent: 'GB',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-alba-medium.tar.bz2',
    bytes: 67_212_349,
    license: 'CC BY 4.0',
    note: 'Gentle Scottish/British accent',
  },
  {
    id: 'en_GB-northern_english_male-medium',
    label: 'Northern - UK male',
    accent: 'GB',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-northern_english_male-medium.tar.bz2',
    bytes: 67_210_490,
    license: 'CC-BY-SA 4.0',
    note: 'Distinctive northern accent',
  },
  // More official Piper English models (sherpa-onnx tts-models release)
  {
    id: 'en_US-john-medium',
    label: 'John - US male',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-john-medium.tar.bz2',
    bytes: 67_200_000,
    approx: true,
    license: 'See Piper voice model card',
  },
  {
    id: 'en_US-kathleen-low',
    label: 'Kathleen - US female (low quality, light)',
    accent: 'US',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-kathleen-low.tar.bz2',
    bytes: 67_200_000,
    approx: true,
    license: 'See Piper voice model card',
  },
  {
    id: 'en_US-danny-low',
    label: 'Danny - US male (low quality, light)',
    accent: 'US',
    gender: 'male',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-danny-low.tar.bz2',
    bytes: 67_200_000,
    approx: true,
    license: 'See Piper voice model card',
  },
  {
    id: 'en_GB-cori-medium',
    label: 'Cori - UK female',
    accent: 'GB',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-medium.tar.bz2',
    bytes: 67_200_000,
    approx: true,
    license: 'See Piper voice model card',
  },
  // Indian-accent English: Piper's multi-speaker CMU Arctic model has Indian-English speakers (ksp, slp, aup, axb, gka).
  // ONE download, 5 speakers (speaker ids from the model's own speaker_id_map: ksp 3, slp 12, aup 13, axb 15, gka 17).
  ...([
    ['in-arctic-ksp', 'KSP - Indian English male', 'male', 3],
    ['in-arctic-slp', 'SLP - Indian English female', 'female', 12],
    ['in-arctic-aup', 'AUP - Indian English male', 'male', 13],
    ['in-arctic-axb', 'AXB - Indian English female', 'female', 15],
    ['in-arctic-gka', 'GKA - Indian English male', 'male', 17],
  ] as [string, string, VoiceGender, number][]).map(([id, label, gender, sid]): VoiceItem => ({
    id,
    label,
    accent: 'IN',
    gender,
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-arctic-medium.tar.bz2',
    bytes: 77_000_000,
    approx: true,
    license: 'CMU Arctic dataset (Piper en_US-arctic-medium)',
    note: 'Indian-accent speaker. One shared download',
    sid,
    pack: 'in-arctic-ksp',
  })),
  // Hindi-first-language speakers reading English (L2-ARCTIC): ONE download, 4 speakers (ids from speaker_id_map: SVBI 2, TNI 9, ASI 10, RRBI 19).
  ...([
    ['in-l2-svbi', 'SVBI - Hindi-accent English', 'female', 2],
    ['in-l2-tni', 'TNI - Hindi-accent English', 'female', 9],
    ['in-l2-asi', 'ASI - Hindi-accent English', 'male', 10],
    ['in-l2-rrbi', 'RRBI - Hindi-accent English', 'male', 19],
  ] as [string, string, VoiceGender, number][]).map(([id, label, gender, sid]): VoiceItem => ({
    id,
    label,
    accent: 'IN',
    gender,
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-l2arctic-medium.tar.bz2',
    bytes: 77_000_000,
    approx: true,
    license: 'L2-ARCTIC dataset (non-commercial: check before any release)',
    note: 'Hindi-speaker accent. One shared download',
    sid,
    pack: 'in-l2-svbi',
  })),
  // Pocket TTS (Kyutai) int8 via sherpa-onnx: ONE download. The voice is CLONED from a short WAV, so any accent can be used.
  // Heavier than Piper: needs a stronger phone (about 600 MB RAM while it speaks).
  {
    id: 'pocket-bria',
    label: 'Pocket - Bria (sample voice in the download)',
    accent: 'PK',
    gender: 'female',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2',
    bytes: 190_000_000,
    approx: true,
    license: 'Kyutai Pocket TTS (see model card)',
    note: 'Natural, English only',
    engine: 'pocket',
    pack: 'pocket-bria',
    ref: 'bundled',
  },
  {
    id: 'pocket-custom',
    label: 'Pocket - My own voice (clone from a WAV)',
    accent: 'PK',
    gender: 'clone',
    quality: 'medium',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2',
    bytes: 190_000_000,
    approx: true,
    license: 'Use only voices you may clone',
    note: 'Pick a clean 5-10 s WAV, e.g. an Indian-English speaker',
    engine: 'pocket',
    pack: 'pocket-bria',
    ref: 'custom',
  },
];

export const DEFAULT_VOICE_ID = 'en_US-lessac-medium';

// Maps expo-speech rate (0.3..1.2) to Piper speed (clamp 0.5..1.3)
export const rateToSpeed = (rate: number): number => Math.min(1.5, Math.max(0.3, +(rate || 0.7).toFixed(2)));

export type VoicePhase = 'none' | 'checking' | 'downloading' | 'paused' | 'extracting' | 'ready' | 'error';

export type VoiceState = {
  phase: VoicePhase;
  got: number;
  total: number;
  msg: string;
};

export type TtsEngine = 'piper' | 'phone';

export type TtsGlobalState = {
  engine: TtsEngine;
  selectedVoice: string;
  isPiperReady: boolean;
  activeSpeaker: 'piper' | 'phone' | 'none';
  ramReason: string;
  boost: number;          // sound boost for the offline voice (1 = normal)
  customVoice: boolean;   // a WAV for the Pocket "my own voice" exists
  voices: Record<string, VoiceState>;
};

export const ttsState: TtsGlobalState = {
  engine: 'phone',
  selectedVoice: DEFAULT_VOICE_ID,
  isPiperReady: false,
  activeSpeaker: 'none',
  ramReason: '',
  boost: 1,
  customVoice: false,
  voices: {},
};

// Initialize voice states for catalog
VOICES.forEach((v) => {
  ttsState.voices[v.id] = { phase: 'none', got: 0, total: v.bytes, msg: '' };
});

// Voices that share one download (multi-speaker Piper, Pocket) use the pack's first voice as the download / state holder.
export const repOf = (id: string): string => VOICES.find((v) => v.id === id)?.pack ?? id;
const voiceOf = (id: string) => VOICES.find((v) => v.id === id);
let curSid = 0;                 // speaker id of the loaded voice (0 for single-speaker models)
let loadedKey = '';             // which model pack is in memory: switching speaker inside it needs no reload
const wantAfter: Record<string, string> = {};   // pack -> the voice the user actually tapped Download on

const subs = new Set<() => void>();
export const subscribeTts = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};
const emit = () => {
  VOICES.forEach((v) => { if (v.pack && v.pack !== v.id && ttsState.voices[v.pack]) ttsState.voices[v.id] = { ...ttsState.voices[v.pack] }; });
  subs.forEach((f) => f());
};

const NativeTts: any = (() => {
  try { return requireNativeModule('SheetTts'); }
  catch { return null; }
})();

const DIR = () => `${FS.documentDirectory}tts/`;
const voiceDir = (id: string) => `${DIR()}${id}/`;
const partPath = (id: string) => `${DIR()}${id}.tar.bz2.part`;
const archivePath = (id: string) => `${DIR()}${id}.tar.bz2`;
const customRefPath = () => `${DIR()}custom-voice.wav`;
const refPathOf = (v: VoiceItem) => (v.ref === 'custom' ? customRefPath() : `${voiceDir(repOf(v.id))}test_wavs/bria.wav`);
// Kotlin java.io.File needs a plain path, not a file:// URI
const np = (uri: string) => uri.replace(/^file:\/\//, '');

const sizeOf = async (uri: string) => {
  try {
    const i = await FS.getInfoAsync(uri);
    return i.exists ? Number(i.size || 0) : 0;
  } catch {
    return 0;
  }
};

async function loadNative(id: string): Promise<boolean> {
  const v = voiceOf(id);
  if (!v || !NativeTts) return false;
  const rid = repOf(id);
  const key = rid;
  const pocket = v.engine === 'pocket';
  if (loadedKey === key && ttsState.isPiperReady) {            // same model files, only another speaker / reference voice
    if (pocket && !(await NativeTts.setReference(np(refPathOf(v))).catch(() => false))) return false;
    curSid = v.sid ?? 0;
    return true;
  }
  loadedKey = '';
  const ok = await NativeTts.init(np(voiceDir(rid)), pocket ? 'pocket' : 'vits').catch(() => false);
  if (ok && pocket && !(await NativeTts.setReference(np(refPathOf(v))).catch(() => false))) return false;
  if (ok) { loadedKey = key; curSid = v.sid ?? 0; }
  return !!ok;
}

const checkVoiceReadyOnDisk = async (id: string): Promise<boolean> => {
  try {
    const dir = voiceDir(id);
    const info = await FS.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return false;
    const files = await FS.readDirectoryAsync(dir);
    if (voiceOf(id)?.engine === 'pocket') {                      // Pocket: several .onnx files + vocab.json (no tokens.txt / espeak data)
      return files.includes('vocab.json') && files.some((f) => f.startsWith('lm_main') && f.endsWith('.onnx'));
    }
    const tokens = await FS.getInfoAsync(`${dir}tokens.txt`);
    const espeak = await FS.getInfoAsync(`${dir}espeak-ng-data`);
    if (!tokens.exists || !espeak.exists) return false;
    return files.some((f) => f.endsWith('.onnx') && !f.endsWith('.json'));
  } catch {
    return false;
  }
};

const checkRamLow = (): { low: boolean; reason: string } => {
  const ram = Number((Device as any).totalMemory || 0);
  if (ram && ram < 3.5e9) {
    const gb = (ram / 1e9).toFixed(1);
    return { low: true, reason: `Low device RAM (~${gb} GB). Phone TTS used for stability.` };
  }
  return { low: false, reason: '' };
};

// Safe voice initialization on app startup
export async function initTts() {
  await FS.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});

  const ramCheck = checkRamLow();
  ttsState.ramReason = ramCheck.reason;
  ttsState.customVoice = (await sizeOf(customRefPath())) > 0;

  // Check state of each voice on disk
  const diskReady: Record<string, boolean> = {};
  for (const v of VOICES) {
    const rid = repOf(v.id);
    if (diskReady[rid] === undefined) diskReady[rid] = await checkVoiceReadyOnDisk(rid);
    if (diskReady[rid]) {
      ttsState.voices[v.id] = { phase: 'ready', got: v.bytes, total: v.bytes, msg: '' };
    } else {
      const part = await sizeOf(partPath(rid));
      ttsState.voices[v.id] = { phase: part > 0 ? 'paused' : 'none', got: part, total: v.bytes, msg: '' };
    }
  }

  const savedVoice = (await getMeta('tts_voice').catch(() => '')) || DEFAULT_VOICE_ID;
  const targetVoice = VOICES.some((v) => v.id === savedVoice) ? savedVoice : DEFAULT_VOICE_ID;
  ttsState.selectedVoice = targetVoice;

  const bst = parseFloat(await getMeta('tts_boost').catch(() => ''));
  if (!isNaN(bst)) ttsState.boost = Math.min(4, Math.max(1, bst));

  const savedEngine = (await getMeta('tts_engine').catch(() => '')) as TtsEngine;

  if (ramCheck.low) {
    ttsState.engine = 'phone';
    ttsState.isPiperReady = false;
    emit();
    return;
  }

  // If selected voice is ready, try loading it
  if (ttsState.voices[targetVoice]?.phase === 'ready' && NativeTts) {
    const loaded = await loadNative(targetVoice);
    if (loaded) {
      ttsState.isPiperReady = true;
      ttsState.engine = savedEngine === 'phone' ? 'phone' : 'piper';
    } else {
      ttsState.isPiperReady = false;
      ttsState.engine = 'phone';
    }
  } else {
    // Check if any other voice is ready
    const anyReady = VOICES.find((v) => ttsState.voices[v.id]?.phase === 'ready' && !(v.ref === 'custom' && !ttsState.customVoice));
    if (anyReady && NativeTts) {
      const loaded = await loadNative(anyReady.id);
      if (loaded) {
        ttsState.selectedVoice = anyReady.id;
        await setMeta('tts_voice', anyReady.id).catch(() => {});
        ttsState.isPiperReady = true;
        ttsState.engine = savedEngine === 'phone' ? 'phone' : 'piper';
      } else {
        ttsState.isPiperReady = false;
        ttsState.engine = 'phone';
      }
    } else {
      ttsState.isPiperReady = false;
      ttsState.engine = 'phone';
    }
  }

  emit();
}

export type TtsPreflight = { ok: boolean; reason?: 'offline' | 'wifi' | 'space'; needMB?: number; freeMB?: number };

export async function preflightVoice(id: string, allowMobile = false): Promise<TtsPreflight> {
  const v = VOICES.find((x) => x.id === id);
  if (!v) return { ok: false, reason: 'offline' };

  let net: any = null;
  try { net = await Network.getNetworkStateAsync(); } catch {}
  if (!net || !net.isConnected || net.isInternetReachable === false) return { ok: false, reason: 'offline' };
  if (!allowMobile && String(net.type).toUpperCase() !== 'WIFI') return { ok: false, reason: 'wifi' };

  const have = await sizeOf(partPath(id));
  const need = Math.max(0, v.bytes - have) + v.bytes * 1.5 + 50e6; // Need archive + extracted files + headroom
  let free = Infinity;
  try { free = await FS.getFreeDiskStorageAsync(); } catch {}
  if (free < need) {
    return { ok: false, reason: 'space', needMB: Math.ceil(need / 1e6), freeMB: Math.floor(free / 1e6) };
  }
  return { ok: true };
}

let activeDownloadId: string | null = null;
let currentResumable: FS.DownloadResumable | null = null;
let dlPoll: any = null;
let userAction: 'pause' | 'cancel' | '' = '';
const downloadQueue: string[] = [];

export async function startVoiceDownload(wanted: string, allowMobile = false): Promise<TtsPreflight> {
  const id = repOf(wanted);
  wantAfter[id] = wanted;
  const v = VOICES.find((x) => x.id === id);
  if (!v) return { ok: false, reason: 'offline' };
  if (ttsState.voices[id]?.phase === 'ready') return { ok: true };

  if (activeDownloadId && activeDownloadId !== id) {
    if (!downloadQueue.includes(id)) downloadQueue.push(id);
    ttsState.voices[id] = { ...ttsState.voices[id], phase: 'checking', msg: 'Queued...' };
    emit();
    return { ok: true };
  }

  ttsState.voices[id] = { ...ttsState.voices[id], phase: 'checking', msg: '' };
  emit();

  const pf = await preflightVoice(id, allowMobile);
  if (!pf.ok) {
    const part = await sizeOf(partPath(id));
    ttsState.voices[id] = { ...ttsState.voices[id], phase: part > 0 ? 'paused' : 'none', msg: '' };
    emit();
    return pf;
  }

  activeDownloadId = id;
  userAction = '';
  runVoiceDownload(id).finally(() => {
    activeDownloadId = null;
    currentResumable = null;
    if (downloadQueue.length > 0) {
      const nextId = downloadQueue.shift()!;
      startVoiceDownload(nextId, allowMobile).catch(() => {});
    }
  });

  return pf;
}

async function runVoiceDownload(id: string) {
  const v = VOICES.find((x) => x.id === id)!;
  await FS.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});

  ttsState.voices[id] = { ...ttsState.voices[id], phase: 'downloading', msg: '' };
  emit();

  dlPoll = setInterval(async () => {
    const n = await sizeOf(partPath(id));
    if (ttsState.voices[id]?.phase === 'downloading') {
      ttsState.voices[id] = { ...ttsState.voices[id], got: n };
      emit();
    }
  }, 1000);

  let ok = false;
  let err = '';

  try {
    for (let attempt = 0; attempt < 5 && !userAction && !ok; attempt++) {
      const have = await sizeOf(partPath(id));
      if (have > v.bytes * (v.approx ? 1.6 : 1.07)) await FS.deleteAsync(partPath(id), { idempotent: true });
      const resume = await sizeOf(partPath(id));
      currentResumable = FS.createDownloadResumable(v.url, partPath(id), {}, undefined, resume > 0 ? String(resume) : undefined);
      try {
        const r: any = await currentResumable.downloadAsync();
        if (userAction) break;
        if (r && (r.status === 200 || r.status === 206)) ok = true;
        else err = `HTTP ${r?.status ?? '?'}`;
      } catch (e: any) {
        if (userAction) break;
        err = String(e?.message || e);
      }
      if (!ok && !userAction) await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  } finally {
    clearInterval(dlPoll);
  }

  if (userAction === 'cancel') {
    await FS.deleteAsync(partPath(id), { idempotent: true });
    ttsState.voices[id] = { phase: 'none', got: 0, total: v.bytes, msg: '' };
    emit();
    return;
  }
  if (userAction === 'pause') {
    const n = await sizeOf(partPath(id));
    ttsState.voices[id] = { phase: 'paused', got: n, total: v.bytes, msg: '' };
    emit();
    return;
  }

  const finalSize = await sizeOf(partPath(id));
  const sane = v.approx ? (finalSize > v.bytes * 0.5 && finalSize < v.bytes * 1.6) : (finalSize > v.bytes * 0.93 && finalSize < v.bytes * 1.07);   // approx size: the extraction check catches a truncated file

  if (!ok || !sane) {
    await FS.deleteAsync(partPath(id), { idempotent: true }).catch(() => {});
    ttsState.voices[id] = { phase: 'error', got: 0, total: v.bytes, msg: 'Voice file damaged - tap Download again' };
    emit();
    return;
  }

  // Extract natively
  ttsState.voices[id] = { ...ttsState.voices[id], phase: 'extracting', msg: 'Preparing...' };
  emit();

  let extracted = false;
  try {
    if (NativeTts?.extractTarBz2) {
      extracted = await NativeTts.extractTarBz2(np(partPath(id)), np(voiceDir(id)));
    }
  } catch {
    extracted = false;
  }

  await FS.deleteAsync(partPath(id), { idempotent: true }).catch(() => {});

  if (!extracted || !(await checkVoiceReadyOnDisk(id))) {
    await FS.deleteAsync(voiceDir(id), { idempotent: true }).catch(() => {});
    ttsState.voices[id] = { phase: 'error', got: 0, total: v.bytes, msg: 'Extraction failed - tap Download again' };
    emit();
    return;
  }

  ttsState.voices[id] = { phase: 'ready', got: v.bytes, total: v.bytes, msg: '' };
  emit();                                          // copy the pack state to every voice of the pack before one is selected

  // If no model is currently ready, or this is the selected voice, load it now
  const sel = wantAfter[id] || id;
  if (!ttsState.isPiperReady || ttsState.selectedVoice === sel) {
    await selectVoice(sel);
  }

  emit();
}

export function pauseVoiceDownload(wanted: string) {
  const id = repOf(wanted);
  if (activeDownloadId === id) {
    userAction = 'pause';
    try { (currentResumable as any)?.pauseAsync?.(); } catch {}
  } else {
    const idx = downloadQueue.indexOf(id);
    if (idx >= 0) downloadQueue.splice(idx, 1);
    ttsState.voices[id] = { ...ttsState.voices[id], phase: 'paused', msg: '' };
    emit();
  }
}

export function cancelVoiceDownload(wanted: string) {
  const id = repOf(wanted);
  if (activeDownloadId === id) {
    userAction = 'cancel';
    try { (currentResumable as any)?.cancelAsync?.(); } catch {}
  } else {
    const idx = downloadQueue.indexOf(id);
    if (idx >= 0) downloadQueue.splice(idx, 1);
    FS.deleteAsync(partPath(id), { idempotent: true }).catch(() => {});
    ttsState.voices[id] = { phase: 'none', got: 0, total: VOICES.find((v) => v.id === id)?.bytes || 0, msg: '' };
    emit();
  }
}

export async function deleteVoice(wanted: string) {
  const id = repOf(wanted);                       // shared pack: deleting one voice removes the shared download (all voices of the pack)
  if (activeDownloadId === id) cancelVoiceDownload(id);

  const selWasThis = repOf(ttsState.selectedVoice) === id;
  if (selWasThis) {
    try { NativeTts?.release?.(); } catch {}
    ttsState.isPiperReady = false;
    loadedKey = '';
  }

  await FS.deleteAsync(voiceDir(id), { idempotent: true }).catch(() => {});
  await FS.deleteAsync(partPath(id), { idempotent: true }).catch(() => {});

  VOICES.filter((x) => repOf(x.id) === id).forEach((x) => {
    ttsState.voices[x.id] = { phase: 'none', got: 0, total: x.bytes, msg: '' };
  });

  if (selWasThis) {
    const nextReady = VOICES.find((x) => repOf(x.id) !== id && ttsState.voices[x.id]?.phase === 'ready' && !(x.ref === 'custom' && !ttsState.customVoice));
    if (nextReady) {
      await selectVoice(nextReady.id);
    } else {
      ttsState.engine = 'phone';
      ttsState.isPiperReady = false;
      await setMeta('tts_engine', 'phone').catch(() => {});
    }
  }

  emit();
}

export async function setBoost(d: number) {
  ttsState.boost = Math.min(4, Math.max(1, +(ttsState.boost + d).toFixed(1)));
  try { NativeTts?.setGain?.(ttsState.boost); } catch {}
  await setMeta('tts_boost', String(ttsState.boost)).catch(() => {});
  emit();
}

export async function selectVoice(id: string) {
  const v = VOICES.find((x) => x.id === id);
  if (!v) return;
  if (v.ref === 'custom' && !ttsState.customVoice) return;      // needs a WAV first

  ttsState.selectedVoice = id;
  await setMeta('tts_voice', id).catch(() => {});

  if (ttsState.voices[id]?.phase === 'ready' && !ttsState.ramReason && NativeTts) {
    const loaded = await loadNative(id);
    if (loaded) {
      ttsState.isPiperReady = true;
      ttsState.engine = 'piper';
      await setMeta('tts_engine', 'piper').catch(() => {});
    } else {
      ttsState.isPiperReady = false;
      ttsState.engine = 'phone';
    }
  }

  emit();
}

export async function setTtsEngine(engine: TtsEngine) {
  ttsState.engine = engine;
  await setMeta('tts_engine', engine).catch(() => {});

  if (engine === 'piper' && !ttsState.isPiperReady && NativeTts) {
    const v = ttsState.selectedVoice;
    if (ttsState.voices[v]?.phase === 'ready') {
      const loaded = await loadNative(v);
      ttsState.isPiperReady = loaded;
    }
  }
  emit();
}

// Pocket "my own voice": the user picks a short, clean WAV (e.g. an Indian-English speaker); Pocket clones it.
export async function pickCustomVoice(): Promise<{ ok: boolean; msg: string }> {
  try {
    const res: any = await DocumentPicker.getDocumentAsync({ type: ['audio/wav', 'audio/x-wav', 'audio/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return { ok: false, msg: '' };
    await FS.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});
    await FS.deleteAsync(customRefPath(), { idempotent: true }).catch(() => {});
    await FS.copyAsync({ from: res.assets[0].uri, to: customRefPath() });
    const ok = NativeTts?.setReference ? await NativeTts.setReference(np(customRefPath())).catch(() => false) : false;
    if (!ok) {
      await FS.deleteAsync(customRefPath(), { idempotent: true }).catch(() => {});
      ttsState.customVoice = false;
      emit();
      return { ok: false, msg: 'Could not read that file. Use a .wav (PCM 16-bit), at least 1 second, ideally 5-10 seconds of one clean voice.' };
    }
    ttsState.customVoice = true;
    emit();
    return { ok: true, msg: '' };
  } catch (e: any) {
    return { ok: false, msg: String(e?.message || e) };
  }
}

// -------------------------------------------------------------
// Unified Speaker Wrapper (used by reader.ts and App.tsx)
// -------------------------------------------------------------
export type SpeakOptions = {
  lang?: 'auto' | 'en' | 'bn';
  rate?: number;
  voice?: string; // phone voice identifier (voiceBn / voiceEn)
  engine?: TtsEngine;
  onStart?: () => void;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (err?: any) => void;
};

type SpeakJob = {
  id: number;
  text: string;
  opts: SpeakOptions;
  finCalled: boolean;
  started?: boolean;   // Piper really began playing
  fell?: boolean;      // handed over to the phone voice: ignore any late Piper events for this job
};

let jobIdCounter = 1;
const speakQueue: SpeakJob[] = [];
let activeJob: SpeakJob | null = null;
let activeSpeakerType: 'piper' | 'phone' | 'none' = 'none';
let fallbackInFlight = false;
let safetyTimer: any = null;

// Listen to native events from SheetTtsModule
if (NativeTts?.addListener) {
  NativeTts.addListener('onStart', ({ id }: { id: number }) => {
    if (activeJob && activeJob.id === id && !activeJob.fell) {
      activeJob.started = true;
      // pre-generate the NEXT chunk only after this one is already playing (generating both at once froze weak phones)
      const curText = activeJob.text;
      const nx = speakQueue.find((j) => j.text !== curText);       // a repeat of the same line is already cached: prepare the next DIFFERENT line
      if (nx && NativeTts?.prepare && !/[\u0980-\u09FF]/.test(nx.text) && nx.opts.engine !== 'phone') {
        try { NativeTts.prepare(nx.text, rateToSpeed(nx.opts.rate ?? 0.7), curSid); } catch {}
      }
      clearTimeout(safetyTimer);               // Piper is speaking: never hand over to the phone voice now
      activeSpeakerType = 'piper';
      ttsState.activeSpeaker = 'piper';
      emit();
      try { activeJob.opts.onStart?.(); } catch {}
    }
  });

  NativeTts.addListener('onDone', ({ id }: { id: number }) => {
    if (activeJob && activeJob.id === id && !activeJob.fell) {
      clearTimeout(safetyTimer);
      finishJob(activeJob, 'done');
      activeJob = null;
      processNextJob();
    }
  });

  NativeTts.addListener('onStopped', ({ id }: { id: number }) => {
    if (activeJob && activeJob.id === id && !activeJob.fell) {
      clearTimeout(safetyTimer);
      finishJob(activeJob, 'stopped');
      activeJob = null;
      processNextJob();
    }
  });

  NativeTts.addListener('onError', ({ id, message }: { id: number; message: string }) => {
    if (activeJob && activeJob.id === id && !fallbackInFlight && !activeJob.fell) {
      clearTimeout(safetyTimer);
      // Fallback to phone expo-speech for this chunk (no silence, no loop)
      fallbackToPhone(activeJob);
    }
  });
}

function finishJob(job: SpeakJob, type: 'done' | 'stopped' | 'error', err?: any) {
  if (job.finCalled) return;
  job.finCalled = true;
  try {
    if (type === 'done') job.opts.onDone?.();
    else if (type === 'stopped') job.opts.onStopped?.();
    else if (type === 'error') job.opts.onError?.(err);
  } catch {}
}

function fallbackToPhone(job: SpeakJob) {
  job.fell = true;
  try { NativeTts?.stop?.(); } catch {}      // Piper must be silent before the phone voice starts (two voices at once was the bug)
  fallbackInFlight = true;
  activeSpeakerType = 'phone';
  ttsState.activeSpeaker = 'phone';
  emit();

  const isBn = job.opts.lang === 'bn' || /[\u0980-\u09FF]/.test(job.text);
  Speech.speak(job.text, {
    language: isBn ? 'bn-BD' : 'en-US',
    voice: job.opts.voice || undefined,
    pitch: 1.0,
    volume: 1.0,
    rate: job.opts.rate ?? 0.7,
    onStart: () => { try { job.opts.onStart?.(); } catch {} },
    onDone: () => {
      fallbackInFlight = false;
      finishJob(job, 'done');
      activeJob = null;
      processNextJob();
    },
    onStopped: () => {
      fallbackInFlight = false;
      finishJob(job, 'stopped');
      activeJob = null;
      processNextJob();
    },
    onError: (e) => {
      fallbackInFlight = false;
      finishJob(job, 'error', e);
      activeJob = null;
      processNextJob();
    },
  });
}

function processNextJob() {
  if (speakQueue.length === 0) {
    activeJob = null;
    activeSpeakerType = 'none';
    ttsState.activeSpeaker = 'none';
    emit();
    return;
  }

  const job = speakQueue.shift()!;
  activeJob = job;

  const isBn = job.opts.lang === 'bn' || (job.opts.lang === 'auto' && /[\u0980-\u09FF]/.test(job.text)) || /[\u0980-\u09FF]/.test(job.text);
  const usePhone = isBn || job.opts.engine === 'phone' || ttsState.engine === 'phone' || !ttsState.isPiperReady || !NativeTts;

  if (usePhone) {
    activeSpeakerType = 'phone';
    ttsState.activeSpeaker = 'phone';
    emit();

    Speech.speak(job.text, {
      language: isBn ? 'bn-BD' : 'en-US',
      voice: job.opts.voice || undefined,
      pitch: 1.0,
      volume: 1.0,
      rate: job.opts.rate ?? 0.7,
      onStart: () => { try { job.opts.onStart?.(); } catch {} },
      onDone: () => { finishJob(job, 'done'); activeJob = null; processNextJob(); },
      onStopped: () => { finishJob(job, 'stopped'); activeJob = null; processNextJob(); },
      onError: (e) => { finishJob(job, 'error', e); activeJob = null; processNextJob(); },
    });
  } else {
    activeSpeakerType = 'piper';
    ttsState.activeSpeaker = 'piper';
    emit();

    // Safety watchdog: if native engine stalls or fails silently
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => {
      if (activeJob && activeJob.id === job.id && !fallbackInFlight && !job.started) {
        fallbackToPhone(job);
      }
    }, voiceOf(ttsState.selectedVoice)?.engine === 'pocket' ? Math.min(120000, 25000 + job.text.length * 500) : Math.min(40000, 12000 + job.text.length * 150));      // slow phone: first audio can take a while; cleared as soon as onStart arrives

    try {
      try { NativeTts.setGain?.(ttsState.boost); } catch {}
      NativeTts.speak(job.id, job.text, rateToSpeed(job.opts.rate ?? 0.7), curSid);
    } catch {
      clearTimeout(safetyTimer);
      fallbackToPhone(job);
    }
  }
}

// start generating a line in the background (e.g. the first line of a point while the topic intro is still being spoken)
export function prewarm(text: string, rate = 0.7) {
  try {
    if (!NativeTts?.prepare || !text || ttsState.engine === 'phone' || !ttsState.isPiperReady || /[\u0980-\u09FF]/.test(text)) return;
    NativeTts.prepare(text, rateToSpeed(rate), curSid);
  } catch {}
}

export function speak(text: string, opts: SpeakOptions = {}) {
  const id = ++jobIdCounter;
  const job: SpeakJob = { id, text, opts, finCalled: false };
  speakQueue.push(job);

  if (!activeJob) {
    processNextJob();
  }
}

export function stopSpeak() {
  clearTimeout(safetyTimer);
  fallbackInFlight = false;

  const current = activeJob;
  activeJob = null;

  try { NativeTts?.stop?.(); } catch {}
  try { Speech.stop(); } catch {}

  if (current) {
    finishJob(current, 'stopped');
  }

  while (speakQueue.length > 0) {
    const j = speakQueue.shift()!;
    finishJob(j, 'stopped');
  }

  activeSpeakerType = 'none';
  ttsState.activeSpeaker = 'none';
  emit();
}
