// Always-on listening: one tap starts it, it auto-restarts until you tap again.
let Voice: any = null;
try { Voice = require('@react-native-voice/voice').default; } catch {}

let on = false;
let timer: any = null;
let cb: (t: string) => void = () => {};
let loc: () => string = () => 'en-US';
let notify: (b: boolean) => void = () => {};

const begin = async () => {
  if (!on || !Voice) return;
  try { await Voice.start(loc()); } catch { schedule(1500); }
};
const schedule = (ms = 400) => { clearTimeout(timer); timer = setTimeout(begin, ms); };

export async function startListening(onText: (t: string) => void, getLocale: () => string, onState: (b: boolean) => void) {
  if (!Voice) return false;
  cb = onText; loc = getLocale; notify = onState; on = true;
  Voice.onSpeechResults = (e: any) => { const t = e.value?.[0]; if (t) cb(t); };
  Voice.onSpeechEnd = () => schedule(300);
  Voice.onSpeechError = async () => { try { await Voice.cancel(); } catch {} schedule(800); };
  notify(true);
  begin();
  return true;
}
export async function stopListening() {
  on = false; clearTimeout(timer);
  try { await Voice?.cancel(); } catch {}
  notify(false);
}
