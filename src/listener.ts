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

const schedule = (ms = 400) => { clearTimeout(timer); timer = setTimeout(begin, ms); };
async function begin() {
  if (!on || !Voice || starting) return;
  starting = true;
  try { await Voice.start(loc()); }
  catch { errs++; schedule(Math.min(1000 + errs * 700, 6000)); }
  finally { starting = false; }
}

export async function startListening(onText: (t: string) => void, getLocale: () => string, onState: (b: boolean) => void) {
  if (!Voice) return false;
  cb = onText; loc = getLocale; notify = onState; on = true; errs = 0;
  muteBeep(true);
  Voice.onSpeechStart = () => { errs = 0; };
  Voice.onSpeechResults = (e: any) => { const t = e.value?.[0]; if (t) cb(t); };
  Voice.onSpeechEnd = () => schedule(400);
  Voice.onSpeechError = async (e: any) => {
    const code = Number(e?.error?.code ?? e?.error?.message?.match?.(/\d+/)?.[0]);
    const quiet = code === 6 || code === 7;          // timeout / nothing heard: normal while silent
    if (!quiet) errs++;
    try { await Voice.cancel(); } catch {}
    schedule(quiet ? 350 : Math.min(900 + errs * 600, 6000));
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
