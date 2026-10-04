// The assistant's tools. Each one = name + description + JSON-schema params + a wrapper over a Kotlin function (modules/sheet-device).
// Contract: run() NEVER throws; it always returns { ok, result } so the agent loop can tell the model what really happened.
// `final` (optional) ends the turn with that exact reply ('' = say nothing: another part of the app is now speaking, e.g. study mode).
// `prepare` marks a tool that must be confirmed by the user first (calls, SMS): it resolves the target and the agent asks "...? yes".
import { dev, hasDevice, isErr, errText, need } from './device';
import { addFact, listFacts, forgetFacts } from '../db';
import { webAnswer } from '../llm';
import { wikiLookup } from '../web';
import { SCREEN_TOOLS } from './screen';
import { NOTIFY_TOOLS } from './notify';

// `confirm` = stop here and ask the user (question, "...? Say yes."); on yes the SAME tool runs again with `args`
export type ToolResult = { ok: boolean; result: string; final?: string; confirm?: { question: string; args: any } };
export type ToolCtx = { exec: (t: string) => void; askNotes: (q: string) => void; signal?: AbortSignal };
export type Prepared = { ok: true; args: any; label: string; text?: string; ask?: string } | ToolResult;   // ask = the exact question to speak (default: call / SMS wording)
export type Tool = {
  name: string; description: string; parameters: any;
  prepare?: (a: any) => Promise<Prepared>;
  run: (a: any, c: ToolCtx) => Promise<ToolResult>;
};

const ok = (result: string, final?: string): ToolResult => ({ ok: true, result, final });
const no = (result: string): ToolResult => ({ ok: false, result });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required });
const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'number', description });
const str = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const noDev = no('Phone control is not available in this build.');
// wraps a native call: missing module, permission and native errors all become a plain {ok:false}
async function native(fn: () => any | Promise<any>, good: (r: string) => string): Promise<ToolResult> {
  if (!hasDevice()) return noDev;
  try {
    const r = await fn();
    return isErr(r) ? no(errText(r)) : ok(good(String(r ?? '')));
  } catch (e: any) { return no(String(e?.message || e || 'failed').slice(0, 160)); }
}
const looksNumber = (s: string) => /^\+?[\d\s\-()]{3,}$/.test(s);
const PERM = (p: string) => 'android.permission.' + p;

// name or number -> { number, label } (READ_CONTACTS is asked here, at first use)
async function resolveTarget(who: string): Promise<{ number: string; label: string } | ToolResult> {
  if (!hasDevice()) return noDev;
  if (looksNumber(who)) return { number: who.replace(/[^\d+]/g, ''), label: who };
  const denied = await need([PERM('READ_CONTACTS')], 'to find contacts by name');
  if (denied) return no(denied);
  const r = String(await dev.findContact(who).catch(() => ''));
  if (!r || isErr(r)) return no(`I could not find "${who}" in your contacts.`);
  const [name, number] = r.split('|');
  return { number, label: name };
}

// WMO weather codes (Open-Meteo)
const WX = (c: number) => c === 0 ? 'clear' : c <= 3 ? 'partly cloudy' : c <= 48 ? 'foggy' : c <= 57 ? 'drizzle' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'rain showers' : c <= 86 ? 'snow showers' : 'thunderstorm';
async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  signal?.addEventListener?.('abort', () => ctl.abort());
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}

export const TOOLS: Tool[] = [
  {
    name: 'open_app', description: 'Open an installed app by its name (e.g. WhatsApp, Camera, YouTube).',
    parameters: obj({ name: S('App name as the user said it') }, ['name']),
    run: (a) => native(() => dev.openApp(str(a.name)), (r) => `Opened ${r}.`),
  },
  {
    name: 'call_contact', description: 'Phone call to a contact name or a phone number. The user is asked to confirm first.',
    parameters: obj({ name_or_number: S('Contact name or phone number') }, ['name_or_number']),
    prepare: async (a) => {
      const who = str(a.name_or_number);
      if (!who) return no('Who should I call?');
      const t = await resolveTarget(who);
      if ('ok' in t) return t;
      const denied = await need([PERM('CALL_PHONE')], 'to place calls');          // asked now, so "yes" can dial at once
      if (denied) return no(denied);
      return { ok: true, args: { number: t.number }, label: t.label };
    },
    run: (a) => native(() => dev.call(str(a.number)), () => 'Calling now.'),
  },
  {
    name: 'send_sms', description: 'Send a text message (SMS) to a contact name or number. The user is asked to confirm first.',
    parameters: obj({ to: S('Contact name or phone number'), text: S('Message text') }, ['to', 'text']),
    prepare: async (a) => {
      const who = str(a.to), text = str(a.text);
      if (!who || !text) return no('I need who to message and what to say.');
      const t = await resolveTarget(who);
      if ('ok' in t) return t;
      const denied = await need([PERM('SEND_SMS')], 'to send text messages');
      if (denied) return no(denied);
      return { ok: true, args: { number: t.number, text }, label: t.label, text };
    },
    run: (a) => native(() => dev.sendSms(str(a.number), str(a.text)), () => 'Message sent.'),
  },
  {
    name: 'set_alarm', description: 'Set an alarm at a clock time (24-hour hour and minute).',
    parameters: obj({ hour: N('0-23'), minute: N('0-59'), label: S('Optional label') }, ['hour', 'minute']),
    run: (a) => {
      const h = Math.round(Number(a.hour)), m = Math.round(Number(a.minute) || 0);
      if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return Promise.resolve(no('That is not a valid time.'));
      return native(() => dev.setAlarm(h, m, str(a.label)), () => `Alarm set for ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}.`);
    },
  },
  {
    name: 'set_timer', description: 'Start a countdown timer.',
    parameters: obj({ seconds: N('Length in seconds'), label: S('Optional label') }, ['seconds']),
    run: (a) => {
      const s = Math.round(Number(a.seconds));
      if (!(s >= 1 && s <= 86400)) return Promise.resolve(no('That is not a valid timer length.'));
      const txt = s % 60 === 0 ? `${s / 60} minute` : s < 60 ? `${s} second` : `${Math.floor(s / 60)} minute ${s % 60} second`;
      return native(() => dev.setTimer(s, str(a.label)), () => `${txt} timer set.`);
    },
  },
  {
    name: 'add_calendar_event', description: 'Open a new calendar event ready to save. Times are ISO 8601 with the user time zone offset.',
    parameters: obj({ title: S('Event title'), start_iso: S('Start, ISO 8601'), end_iso: S('End, ISO 8601 (optional, default 1 hour)') }, ['title', 'start_iso']),
    run: (a) => {
      const s = Date.parse(str(a.start_iso));
      if (isNaN(s)) return Promise.resolve(no('I could not read the start time.'));
      const e0 = Date.parse(str(a.end_iso));
      const e = isNaN(e0) || e0 <= s ? s + 3600000 : e0;
      return native(() => dev.addEvent(str(a.title), s, e), () => 'The event is open in your calendar. Tap save there.');
    },
  },
  {
    name: 'torch', description: 'Turn the flashlight on or off.',
    parameters: obj({ on: { type: 'boolean', description: 'true = on, false = off' } }, ['on']),
    run: (a) => native(() => dev.torch(a.on === true || a.on === 'true'), () => (a.on === true || a.on === 'true' ? 'Flashlight on.' : 'Flashlight off.')),
  },
  {
    name: 'set_volume', description: 'Change the media volume: a level 0-100, or up, down, mute.',
    parameters: obj({ level: S('"0".."100", "up", "down" or "mute"') }, ['level']),
    run: (a) => native(() => dev.setVolume(str(a.level).toLowerCase()), (r) => r || 'Volume changed.'),
  },
  {
    name: 'media_control', description: 'Control the playing music/video app.',
    parameters: obj({ action: { type: 'string', enum: ['play', 'pause', 'next', 'prev'], description: 'play, pause, next or prev' } }, ['action']),
    run: (a) => native(() => dev.media(str(a.action)), () => `Media: ${str(a.action)}.`),
  },
  { name: 'get_battery', description: 'Battery level and whether it is charging.', parameters: obj({}), run: () => native(() => dev.battery(), (r) => r) },
  {
    name: 'get_time', description: 'Current date and time on the phone.', parameters: obj({}),
    run: async () => ok(new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })),
  },
  {
    name: 'get_location', description: 'Approximate (city-level) location of the phone.', parameters: obj({}),
    run: async () => {
      const denied = await need([PERM('ACCESS_COARSE_LOCATION')], 'to know roughly where you are');
      if (denied) return no(denied);
      return native(() => dev.location(), (r) => r);
    },
  },
  {
    name: 'open_url', description: 'Open a web address in the browser.',
    parameters: obj({ url: S('http(s) address') }, ['url']),
    run: (a) => {
      let u = str(a.url);
      if (!/^https?:\/\//i.test(u)) u = /^[\w-]+(\.[\w-]+)+/.test(u) ? 'https://' + u : '';
      if (!u) return Promise.resolve(no('That is not a web address.'));
      return native(() => dev.openUrl(u), () => 'Opened in the browser.');
    },
  },
  {
    name: 'web_search', description: 'Look something up on the web (news, facts, anything you are not sure of). Returns a short answer.',
    parameters: obj({ query: S('What to look up') }, ['query']),
    run: async (a, c) => {
      const q = str(a.query);
      if (!q) return no('Nothing to search.');
      const r = await webAnswer(q, c.signal);                                      // live Google through Gemini, or the chosen model's knowledge
      if (r) return ok(r);
      const w = await wikiLookup(q, 600).catch(() => null);                         // no key / offline answer: Wikipedia intro
      return w ? ok(`${w.title}: ${w.text.slice(0, 500)}`) : no('I could not find an answer. Check the internet.');
    },
  },
  {
    name: 'get_weather', description: 'Current weather for a city, or for where the phone is when no city is given.',
    parameters: obj({ city: S('City name (optional)') }),
    run: async (a, c) => {
      let lat = 0, lon = 0, place = str(a.city);
      if (place) {
        const g = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(place), c.signal);
        const p = g?.results?.[0];
        if (!p) return no(`I could not find a place called ${place}.`);
        lat = p.latitude; lon = p.longitude; place = p.name;
      } else {
        const denied = await need([PERM('ACCESS_COARSE_LOCATION')], 'to get the weather where you are');
        if (denied) return no(denied);
        const loc = hasDevice() ? String(await dev.location().catch(() => '')) : '';
        const m = loc.match(/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
        if (!m) return no('I could not get your location. Tell me a city.');
        lat = +m[1]; lon = +m[2]; place = 'your location';
      }
      const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`, c.signal);
      const cur = w?.current;
      if (!cur) return no('The weather service did not answer. Check the internet.');
      return ok(`${place}: ${Math.round(cur.temperature_2m)}°C (feels ${Math.round(cur.apparent_temperature)}°C), ${WX(cur.weather_code)}, wind ${Math.round(cur.wind_speed_10m)} km/h.`);
    },
  },
  {
    name: 'remember', description: 'Save a short fact about the user (name, preference, anything they ask you to remember). Write it as a short English sentence.',
    parameters: obj({ fact: S('e.g. "User\'s name is Nex"') }, ['fact']),
    run: async (a) => (await addFact(str(a.fact)).catch(() => false)) ? ok('Saved.') : no('I could not save that.'),
  },
  {
    name: 'forget', description: 'Delete saved facts that contain these words.',
    parameters: obj({ fact: S('Words of the fact to delete') }, ['fact']),
    run: async (a) => { const n = await forgetFacts(str(a.fact)).catch(() => 0); return n ? ok(`Forgot ${n} thing${n > 1 ? 's' : ''}.`) : no('I had nothing saved like that.'); },
  },
  {
    name: 'recall', description: 'List everything saved about the user.', parameters: obj({}),
    run: async () => { const f = await listFacts().catch(() => []); return ok(f.length ? f.map((x) => x.text).join('; ') : 'Nothing saved yet.'); },
  },
  {
    name: 'start_study', description: 'Start reading a study topic aloud from the user\'s notes (study mode). Use when they say topic/read/study <name>.',
    parameters: obj({ topic: S('Topic name') }, ['topic']),
    run: async (a, c) => { const t = str(a.topic); if (!t) return no('Which topic?'); c.exec('exact ' + t); return ok('Study mode started.', ''); },   // study mode does the talking now
  },
  {
    name: 'ask_notes', description: 'Answer a study / medical-lab question from the user\'s own notes (their uploaded sources).',
    parameters: obj({ question: S('The question') }, ['question']),
    run: async (a, c) => { const q = str(a.question); if (!q) return no('What is the question?'); c.askNotes(q); return ok('Answering from notes.', ''); },
  },
  ...NOTIFY_TOOLS,                                  // Phase 2 / Part 2: notifications (src/agent/notify.ts)
  ...SCREEN_TOOLS,                                  // Phase 2 / Part 1: screen control (src/agent/screen.ts)
];
export const toolByName = (n: string) => TOOLS.find((t) => t.name === n);
