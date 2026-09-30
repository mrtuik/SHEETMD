// Always-on listening: one tap starts it, it auto-restarts until you tap again.
// The recognizer's start/stop beep is muted while listening, and restarts back off so it doesn't churn.
import { muteBeep } from './service';

let Voice: any = null;
try { Voice = require('@react-native-voice/voice').default; } catch {}

let on = false;
let starting = false;
let errs = 0;
let timer: any = null;
let cb: (t: string) => void = () => {};
let loc: () => string = () => 'en-US';
let notify: (b: boolean) => void = () => {};
let partial: (t: string) => boolean = () => false;   // true = the partial words were a complete command and already ran
let handled = false;                                  // a partial result of this utterance already ran its command

const schedule = (ms = 120) => { clearTimeout(timer); timer = setTimeout(begin, ms); };
async function begin() {
  if (!on || !Voice || starting) return;
  starting = true;
  try {
    await Voice.start(loc(), {
      EXTRA_PARTIAL_RESULTS: true,
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 600,
      EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 400,
      EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 250,
    });
  }
  catch { errs++; schedule(Math.min(1000 + errs * 700, 6000)); }
  finally { starting = false; }
}

export async function startListening(onText: (t: string) => void, getLocale: () => string, onState: (b: boolean) => void, onPartial?: (t: string) => boolean) {
  if (!Voice) return false;
  cb = onText; loc = getLocale; notify = onState; on = true; errs = 0; partial = onPartial || (() => false); handled = false;
  muteBeep(true);
  Voice.onSpeechStart = () => { errs = 0; handled = false; };
  Voice.onSpeechPartialResults = (e: any) => { const t = e.value?.[0]; if (t && !handled && partial(t)) handled = true; };
  Voice.onSpeechResults = (e: any) => { const t = e.value?.[0]; if (t && !handled) cb(t); handled = false; };
  Voice.onSpeechEnd = () => schedule(120);
  Voice.onSpeechError = async (e: any) => {
    const code = Number(e?.error?.code ?? e?.error?.message?.match?.(/\d+/)?.[0]);
    const quiet = code === 6 || code === 7;          // timeout / nothing heard: normal while silent
    if (!quiet) errs++;
    try { await Voice.cancel(); } catch {}
    schedule(quiet ? 120 : Math.min(900 + errs * 600, 6000));
  };
  notify(true);
  begin();
  return true;
}
export async function stopListening() {
  on = false; clearTimeout(timer);
  try { await Voice?.cancel(); } catch {}
  muteBeep(false);
  notify(false);
}
