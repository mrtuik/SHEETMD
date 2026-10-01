// Always-on listening: one tap starts it, it auto-restarts until you tap again.
// The recognizer's start/stop beep is muted while listening, and restarts back off so it doesn't churn.
//
// IMPORTANT (why voice commands stopped working): the recognizer must be restarted only AFTER it has delivered its
// result. Restarting right at "speech end" destroys the recognizer before the final text arrives, so a command
// such as "topic microscope" was lost. Now: result / error -> restart; speech end only starts a safety timer.
import { muteBeep } from './service';

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
let dog: any = null;                                  // watchdog: restarts a recogniser that went silent for good

const schedule = (ms = 250) => { clearTimeout(timer); timer = setTimeout(begin, ms); };
async function begin() {
  if (!on || !Voice || starting) return;
  starting = true; last = Date.now();
  try {
    // Voice.start can hang for ever when the engine is busy (that froze listening: "starting" stayed true) -> give up after 5 s
    await Promise.race([Voice.start(loc(), { EXTRA_PARTIAL_RESULTS: true, EXTRA_MAX_RESULTS: 5 }), new Promise((_, rej) => setTimeout(() => rej(new Error('start timeout')), 5000))]);
  }
  catch { errs++; try { await Voice.cancel(); } catch {} schedule(Math.min(800 + errs * 500, 4000)); }
  finally { starting = false; }
}

export async function startListening(onTexts: (t: string[]) => void, getLocale: () => string, onState: (b: boolean) => void, onPartial?: (t: string) => boolean) {
  if (!Voice) return false;
  cb = onTexts; loc = getLocale; notify = onState; on = true; errs = 0; partial = onPartial || (() => false); handled = false;
  muteBeep(true);
  Voice.onSpeechStart = () => { last = Date.now(); errs = 0; handled = false; clearTimeout(guard); };
  Voice.onSpeechPartialResults = (e: any) => { last = Date.now(); const t = e.value?.[0]; if (t && !handled && partial(t)) handled = true; };
  Voice.onSpeechResults = (e: any) => {
    last = Date.now(); clearTimeout(guard);
    const v: string[] = (e.value || []).filter(Boolean);
    if (v.length && !handled) cb(v);
    handled = false;
    schedule(120);                                   // restart only now: the result has been delivered
  };
  Voice.onSpeechEnd = () => {                        // the result normally follows within a moment; if it never comes, restart anyway
    clearTimeout(guard);
    guard = setTimeout(() => schedule(0), 2500);
  };
  Voice.onSpeechError = async (e: any) => {
    last = Date.now(); clearTimeout(guard);
    const code = Number(e?.error?.code ?? e?.error?.message?.match?.(/\d+/)?.[0]);
    const quiet = code === 6 || code === 7;          // timeout / nothing heard: normal while silent
    if (!quiet) errs++;
    try { await Voice.cancel(); } catch {}
    schedule(quiet ? 100 : Math.min(600 + errs * 400, 3000));
  };
  clearInterval(dog);
  dog = setInterval(async () => {                    // no result / error / speech for 12 s = the recogniser is dead: restart it
    if (!on || Date.now() - last < 12000) return;
    last = Date.now(); starting = false;
    try { await Voice.cancel(); } catch {}
    schedule(100);
  }, 4000);
  notify(true);
  begin();
  return true;
}
export async function stopListening() {
  on = false; clearTimeout(timer); clearTimeout(guard); clearInterval(dog);
  try { await Voice?.cancel(); } catch {}
  muteBeep(false);
  notify(false);
}

// fresh recogniser (e.g. right after the app finished speaking), so it does not carry the app's own voice into the next result
export async function restartListening(ms = 250) {
  if (!on || !Voice) return;
  clearTimeout(guard); handled = false;
  try { await Voice.cancel(); } catch {}
  schedule(ms);
}
