// Always-on listening: one tap starts it, it auto-restarts until you tap again.
// The recognizer's start/stop beep is muted while listening, and restarts back off so it doesn't churn.
//
// IMPORTANT (why voice commands stopped working): the recognizer must be restarted only AFTER it has delivered its
// result. Restarting right at "speech end" destroys the recognizer before the final text arrives, so a command
// such as "topic microscope" was lost. Now: result / error -> restart; speech end only starts a safety timer.
import { muteBeep } from './service';
import { Stt, sttActive, sttState } from './stt';

let Voice: any = null;
try { Voice = require('@react-native-voice/voice').default; } catch {}

let on = false;
let starting = false;
let errs = 0;
let timer: any = null;
let guard: any = null;
let cb: (t: string[]) => void = () => {};
let loc: () => string = () => 'en-US';
let notify: (b: boolean) => void = () => {};
let partial: (t: string) => boolean = () => false;   // true = the partial words were a complete command and already ran
let handled = false;                                  // a partial result of this utterance already ran its command
let last = Date.now();                                // last sign of life from the recognizer
let dog: any = null;
let nativeOn = false;                                 // true = the offline sherpa-onnx engine is the one listening
let nsubs: any[] = [];                                  // watchdog: restarts a recogniser that went silent for good

// live feed for the screen (waveform + "what the mic hears right now"). Subscribers update themselves: the whole app does not re-render.
const levelSubs = new Set<(v: number) => void>();
const liveSubs = new Set<(t: string) => void>();
export const subscribeLevel = (f: (v: number) => void) => { levelSubs.add(f); return () => { levelSubs.delete(f); }; };
export const subscribeLive = (f: (t: string) => void) => { liveSubs.add(f); return () => { liveSubs.delete(f); }; };
const emitLevel = (v: number) => levelSubs.forEach((f) => f(v));
const emitLive = (t: string) => liveSubs.forEach((f) => f(t));

// Voice.cancel can hang while the engine is busy: never wait for it more than 700 ms
const safeCancel = () => Promise.race([Promise.resolve(Voice?.cancel?.()).catch(() => {}), new Promise((r) => setTimeout(r, 700))]);

const schedule = (ms = 250) => { clearTimeout(timer); timer = setTimeout(begin, ms); };
async function begin() {
  if (!on || !Voice || starting) return;
  starting = true; last = Date.now();
  try {
    // Voice.start can hang for ever when the engine is busy (that froze listening: "starting" stayed true) -> give up after 3 s
    await Promise.race([Voice.start(loc(), { EXTRA_PARTIAL_RESULTS: true, EXTRA_MAX_RESULTS: 5 }), new Promise((_, rej) => setTimeout(() => rej(new Error('start timeout')), 3000))]);
  }
  catch { errs++; await safeCancel(); schedule(Math.min(300 + errs * 300, 2500)); }
  finally { starting = false; }
}

export async function startListening(onTexts: (t: string[]) => void, getLocale: () => string, onState: (b: boolean) => void, onPartial?: (t: string) => boolean) {
  const useGoogle = sttState.google;
  if (useGoogle ? !Voice : !sttActive()) return false;      // no fallback: the chosen engine or nothing
  cb = onTexts; loc = getLocale; notify = onState; on = true; errs = 0; partial = onPartial || (() => false); handled = false;
  if (!useGoogle) { if (startNative()) { notify(true); return true; } on = false; return false; }
  muteBeep(true);
  Voice.onSpeechStart = () => { last = Date.now(); errs = 0; handled = false; clearTimeout(guard); };
  Voice.onSpeechPartialResults = (e: any) => { last = Date.now(); const t = e.value?.[0]; if (t) emitLive(String(t)); if (t && !handled && partial(t)) handled = true; };
  Voice.onSpeechVolumeChanged = (e: any) => { const v = Number(e?.value); if (!isNaN(v)) emitLevel(Math.max(0, Math.min(1, (v + 2) / 12))); };   // recogniser loudness: about -2 .. 10
  Voice.onSpeechResults = (e: any) => {
    last = Date.now(); clearTimeout(guard);
    emitLive('');                                    // the final words go through the normal path (the screen then shows them as "heard")
    const v: string[] = (e.value || []).filter(Boolean);
    if (v.length && !handled) cb(v);
    handled = false;
    schedule(40);                                    // restart only now: the result has been delivered
  };
  Voice.onSpeechEnd = () => {                        // the result normally follows within a moment; if it never comes, restart anyway
    clearTimeout(guard);
    guard = setTimeout(() => schedule(0), 1500);
  };
  Voice.onSpeechError = async (e: any) => {
    last = Date.now(); clearTimeout(guard); emitLive('');
    const code = Number(e?.error?.code ?? e?.error?.message?.match?.(/\d+/)?.[0]);
    const quiet = code === 6 || code === 7;          // timeout / nothing heard: normal while silent
    const busy = code === 8 || code === 5;           // recogniser busy / client error: a quick fresh restart fixes it (long back-off was the mic "pausing")
    if (!quiet && !busy) errs++;
    await safeCancel();
    schedule(quiet ? 30 : busy ? 250 : Math.min(400 + errs * 300, 2500));
  };
  clearInterval(dog);
  dog = setInterval(async () => {                    // no result / error / speech for 12 s = the recogniser is dead: restart it
    if (!on || Date.now() - last < 8000) return;
    last = Date.now(); starting = false;
    await safeCancel();
    schedule(100);
  }, 4000);
  notify(true);
  begin();
  return true;
}
export async function stopListening() {
  if (nativeOn) stopNative();
  on = false; clearTimeout(timer); clearTimeout(guard); clearInterval(dog);
  try { await Voice?.cancel(); } catch {}
  muteBeep(false);
  emitLive(''); emitLevel(0);
  notify(false);
}

// fresh recogniser (e.g. right after the app finished speaking), so it does not carry the app's own voice into the next result
export async function restartListening(ms = 250) {
  if (nativeOn) { handled = false; try { Stt.reset?.(); } catch {} return; }     // offline engine: continuous, nothing to restart
  if (!on || !Voice) return;
  clearTimeout(guard); handled = false;
  await safeCancel();
  schedule(ms);
}

// a command that ran from a partial result: the final result of this utterance must not run it a second time
export const markHandled = () => { handled = true; };

// ---- offline engine (sherpa-onnx): records the mic itself, with echo cancellation ----
function startNative(): boolean {
  try {
    stopNative();
    nsubs = [
      Stt.addListener('onPartial', (e: any) => { const t = String(e?.text || ''); if (!t) return; last = Date.now(); emitLive(t); if (!handled && partial(t)) handled = true; }),
      Stt.addListener('onFinal', (e: any) => {
        const t = String(e?.text || '').trim(); last = Date.now(); emitLive('');
        if (t && !handled) cb([t]);
        handled = false;
      }),
      Stt.addListener('onLevel', (e: any) => { const v = Number(e?.level); if (!isNaN(v)) emitLevel(Math.max(0, Math.min(1, v))); }),
      Stt.addListener('onError', () => { if (!nativeOn) return; setTimeout(() => { if (on && nativeOn) { try { Stt.start(sttState.aec, sttState.gain); } catch {} } }, 800); }),
    ];
    const ok = !!Stt.start(sttState.aec, sttState.gain);
    if (!ok) { nsubs.forEach((x) => { try { x.remove(); } catch {} }); nsubs = []; return false; }
    nativeOn = true; clearInterval(dog);
    return true;
  } catch { return false; }
}
function stopNative() {
  nativeOn = false;
  try { Stt?.stop(); } catch {}
  nsubs.forEach((x) => { try { x.remove(); } catch {} }); nsubs = [];
}
