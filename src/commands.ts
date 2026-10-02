import { queryTokens, rankTopics } from './match';

export type Cmd =
  | { t: 'topic'; q: string } | { t: 'exact'; q: string } | { t: 'explain'; q: string } | { t: 'search'; q: string } | { t: 'question'; q?: string }
  | { t: 'repeat'; arg?: string; mode?: 'line' | 'prev' | 'point' } | { t: 'pick'; n: number }
  | { t: 'continue' | 'pause' | 'stop' | 'next' | 'prev' | 'slower' | 'faster' | 'unknown' };

const NUM: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

// English + a few Bangla words (for Bangla voice mode)
// "one / two / three" answers the 3-options question (only acted on while options are waiting)
const PICK: Record<string, number> = {
  one: 1, won: 1, wan: 1, first: 1, '1st': 1, '1': 1, ek: 1, 'এক': 1, 'প্রথম': 1, 'ওয়ান': 1, 'ফার্স্ট': 1, '১': 1,
  two: 2, to: 2, too: 2, tu: 2, second: 2, '2nd': 2, '2': 2, dui: 2, 'দুই': 2, 'দ্বিতীয়': 2, 'টু': 2, 'সেকেন্ড': 2, '২': 2,
  three: 3, tree: 3, free: 3, thri: 3, third: 3, '3rd': 3, '3': 3, tin: 3, 'তিন': 3, 'তৃতীয়': 3, 'থ্রি': 3, 'থার্ড': 3, '৩': 3,
};
// filler words around a spoken choice: "number two", "option 3 please", "the first one", "say two"
const PICK_FILL = new Set(['option', 'number', 'no', 'choose', 'select', 'pick', 'say', 'the', 'please', 'ok', 'okay', 'it', 'is', 'that', 'this', 'i', 'want', 'নম্বর', 'অপশন']);
// what the recogniser writes for a lone "one / two / three" when it mishears: only used while the 3 options are waiting
const PICK_LOOSE: Record<string, number> = {
  on: 1, own: 1, van: 1, von: 1, wann: 1, aan: 1, ann: 1, un: 1, when: 1, want: 1, juan: 1, oun: 1, wun: 1, run: 1, 'ওয়ানা': 1, 'এক্': 1,
  do: 2, dew: 2, tou: 2, tau: 2, doo: 2, tooth: 2, tuo: 2, tue: 2, tuu: 2, 'তু': 2, 'দু': 2, 'দুটো': 2,
  thee: 3, sethu: 3, setu: 3, sethoo: 3, tri: 3, tee: 3, ti: 3, thri: 3, treee: 3, thre: 3, thrie: 3, fee: 3, sri: 3, shree: 3, three: 3, 'ত্রি': 3, 'তিনটা': 3,
};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// spoken "okay" that ends a question ("what is anemia okay")
// 0 = not a choice. Accepts "two", "2", "number two", "the first one", "option 3 please", Bangla / Banglish forms.
export function parsePick(s: string, loose = false): number {
  const toks = s.toLowerCase().replace(/[.!?।,:;"'()\-]/g, ' ').split(/\s+/).filter(Boolean).filter((t) => !PICK_FILL.has(t));
  if (!toks.length || toks.length > 3) return 0;
  const ns = toks.map((t) => (has(PICK, t) ? PICK[t] : loose && has(PICK_LOOSE, t) ? PICK_LOOSE[t] : 0));
  return ns[0] && ns.every((n) => n === ns[0]) ? ns[0] : 0;
}
// names of the options now waiting: the phone's mic hears the app reading "Did you mean A, or B, or C?" and often glues
// it in front of your answer ("did you mean A or B or C one" / "... exact anemia"): that echo must be cut off first.
let CHOICES: string[] = [];
export const setChoiceNames = (n: string[] | null) => { CHOICES = n || []; };
export const head6 = (n: string) => plain(n).split(' ').slice(0, 6).join(' ');
const plain = (n: string) => n.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export function stripChoiceEcho(s: string): string {
  const m = s.toLowerCase().match(/(?:did you mean|say one)[\s\S]*?(?:two|to|too|2)\s*(?:or|and)\s*(?:three|tree|free|3)\s*[.!?।]*\s*(.*)$/);
  if (m) return m[1].trim();
  if (!CHOICES.length) return s;
  const low = s.toLowerCase();
  // the app now speaks only the first words of every option (long OCR titles took ages): match both the full name and its head
  let hits = 0, cut = -1;
  for (const n of CHOICES) {
    let best = -1;
    for (const cand of [plain(n), head6(n)]) { if (cand.length >= 3) { const i = low.lastIndexOf(cand); if (i >= 0) best = Math.max(best, i + cand.length); } }
    if (best >= 0) { hits++; cut = Math.max(cut, best); }
  }
  const heardLine = /did you mean/.test(low);
  if (!heardLine && hits < 2) {
    // the mic heard a piece of the app's own voice and then your "one": the answer is the last word, even when the echo is cut or misheard
    const tk = low.replace(/[.!?।,]+/g, ' ').trim().split(/\s+/);
    const lastTk = tk[tk.length - 1];
    if (tk.length > 3 && has(PICK, lastTk)) {
      const names = new Set(CHOICES.flatMap((n) => plain(n).split(' ')));
      const before = tk.slice(0, -1);
      if (before.filter((w) => names.has(w)).length / before.length >= 0.5) return lastTk;
    }
    return s;                                                        // not the app's own voice
  }
  if (cut >= 0) return s.slice(cut).replace(/^[\s.,!?।]+/, '').trim();
  const k = low.match(/\b(?:topic|exact|explain|question|stop|pause|next|previous|continue|slower|faster|repeat)\b[\s\S]*$/);
  if (k) return k[0].trim();
  const last = low.replace(/[.!?।,]+/g, ' ').trim().split(/\s+/).pop() || '';
  return has(PICK, last) || has(PICK_LOOSE, last) ? last : '';
}
// the user said the NAME of an option ("urine sample") instead of one / two / three
export function pickByName(s: string): number {
  if (!CHOICES.length) return 0;
  const toks = queryTokens(s);
  if (!toks.length || toks.length > 6) return 0;
  const r = rankTopics(toks, CHOICES.map((name, i) => ({ id: i, name })));
  if (!r.length || r[0].score < 0.8) return 0;
  if (r[1] && r[0].score - r[1].score < 0.1) return 0;
  return r[0].id + 1;
}

export const OK_END = /(?:^|\s)(?:okay|ok|okey|o\.k\.?|ওকে|ঠিক আছে)\s*[.!?।]*$/i;
// words that cancel a question that is being dictated
export const CANCEL_Q = /^(?:cancel|stop|never ?mind|বাতিল|স্টপ)$/i;

// What the phone's speech recogniser often writes for a playback command (accent / noise) -> the real command.
const ALIAS: Record<string, Cmd['t']> = {
  stop: 'stop', stock: 'stop', stoop: 'stop', stopp: 'stop', stob: 'stop', stops: 'stop', stopped: 'stop', 'stop the reading': 'stop', 'stop read': 'stop', 'band koro': 'stop', 'bondho': 'stop', 'bondho koro': 'stop', 'stop it': 'stop', 'stop reading': 'stop', 'stop now': 'stop', 'stop stop': 'stop', 'স্টপ': 'stop', 'বন্ধ': 'stop', 'বন্ধ করো': 'stop',
  pause: 'pause', 'pause reading': 'pause', 'thamo': 'pause', 'thaamo': 'pause', paws: 'pause', 'pause please': 'pause', pose: 'pause', paus: 'pause', hold: 'pause', wait: 'pause', 'hold on': 'pause', 'pause it': 'pause', 'থামো': 'pause', 'পজ': 'pause', 'থামাও': 'pause',
  continue: 'continue', 'continue it': 'continue', 'chalu': 'continue', 'chalao': 'continue', resume: 'continue', play: 'continue', 'go on': 'continue', 'carry on': 'continue', 'keep going': 'continue', 'continue reading': 'continue', 'play again': 'continue', start: 'continue', 'চালু': 'continue', 'চালাও': 'continue', 'কন্টিনিউ': 'continue',
  next: 'next', 'next topic': 'next', 'porer': 'next', nex: 'next', 'next point': 'next', 'next one': 'next', skip: 'next', 'skip it': 'next', 'নেক্সট': 'next', 'পরের': 'next', 'পরেরটা': 'next',
  previous: 'prev', 'previous point': 'prev', 'previous one': 'prev', back: 'prev', 'go back': 'prev', last: 'prev', 'last point': 'prev', 'আগের': 'prev', 'আগেরটা': 'prev', 'ব্যাক': 'prev',
  slower: 'slower', 'slow down': 'slower', slow: 'slower', 'go slower': 'slower', 'আস্তে': 'slower',
  faster: 'faster', 'speed up': 'faster', fast: 'faster', 'go faster': 'faster', 'জোরে': 'faster', 'দ্রুত': 'faster',
};
// Ordinary English words that are ALSO playback aliases. The mic hears the app's own voice, so a note line such as
// "Start the ...", "Hold the slide ..." or "Back to ..." used to be taken as a command (pause / restart / previous)
// and reading broke. While the app is reading, these only count when the app itself did not just say that word.
export const WEAK = new Set(['hold', 'wait', 'hold on', 'back', 'go back', 'last', 'start', 'play', 'fast', 'slow', 'skip', 'go on', 'carry on', 'keep going', 'pose', 'stock', 'paws']);
const LEAD = /^(?:(?:ok|okay|hey|hi|please|now|just|you can)\s+)+/;
const TAIL = /(?:\s+(?:please|now|sir|ok|okay|thanks?|thank you))+$/;
const GREET = /^(?:hi+|hii+|hello+|hey+|hola|namaste|thanks?|thank you|ok|okay|good (?:morning|evening|night)|হ্যালো|হাই)$/;
export const isGreeting = (s: string) => GREET.test(s.trim().toLowerCase().replace(/[.!?।,\s]+$/, ''));

export function isWeakCmd(s: string): boolean {
  const x = s.trim().toLowerCase().replace(/[.!?।,]+$/, '').replace(/\s+/g, ' ');
  const y = x.replace(LEAD, '').replace(TAIL, '').trim();
  return !!y && WEAK.has(y) && !!ALIAS[y];
}

export function parse(s: string): Cmd {
  let x = s.trim().toLowerCase().replace(/[.!?।,]+$/, '').replace(/\s+/g, ' ');
  const y = x.replace(LEAD, '').replace(TAIL, '').trim();
  if (y && ALIAS[y]) return { t: ALIAS[y] } as Cmd;             // "okay stop please" == "stop"
  if (y && y !== x && /^(?:topics?|টপিক|exact|exactly|explain|search|google|web search|খোঁজো|সার্চ|question|questions)(?:\s|:|$)/.test(y)) x = y;
  const pn = parsePick(y || x);
  if (pn) return { t: 'pick', n: pn };
  let m = x.match(/^(?:topics?|টপিক)\s*:?\s+(.+)$/);
  if (m) return { t: 'topic', q: m[1] };
  // exact <topic name>: that topic read word for word from the file, heading to next heading (no model)
  m = x.match(/^(?:exactly|exact|egzact|এক্সাক্ট)\s*:?\s*(.+)$/);
  if (m) return { t: 'exact', q: m[1] };
  // explain <topic>: answered from the model's own knowledge (+ a web lookup), NOT from your sources
  m = x.match(/^(?:explain|এক্সপ্লেন|ব্যাখ্যা)\s*:?\s+(?:about\s+)?(.+)$/);
  if (m) return { t: 'explain', q: m[1] };
  // search <anything>: live Google search through Gemini (needs internet + a Gemini key in Models). "search what is the difference between ..." works too.
  m = x.match(/^(?:web search|search|google|খোঁজো|সার্চ)(?:\s*:\s*|\s+)(.+)$/);
  if (m) return { t: 'search', q: m[1].trim() };
  if (/^(?:web search|search|google|খোঁজো|সার্চ)$/.test(x)) return { t: 'search', q: '' };           // only the word: the app asks what to search
  // question [whole question] [okay]: say "question", then the full question, then "okay"
  m = x.match(/^(?:ask (?:a )?question|questions?|প্রশ্ন)(?:\s*:?\s+(.+))?$/);
  if (m) return { t: 'question', q: m[1] };
  m = x.match(/^(?:repeat|again|আবার)(?:\s+(.+))?$/);
  if (m) {
    const a = (m[1] || '').trim();
    if (!a || /^(?:line|this|it|this line|the line|current|current line|now)$/.test(a)) return { t: 'repeat', mode: 'line' };          // the line being read
    if (/^(?:previous|prev|previous line|last|last line|back|before|the previous|one before)$/.test(a)) return { t: 'repeat', mode: 'prev' };   // the line before
    const pm = a.match(/^point(?:\s+(.+))?$/);                                                                                          // the whole point
    if (pm) return { t: 'repeat', mode: 'point', arg: pm[1] ? (NUM[pm[1]] ?? pm[1]) : undefined };
    return { t: 'repeat', mode: 'point', arg: NUM[a] ?? a };                                                                           // "repeat 3" / "repeat <title>"
  }
  return { t: 'unknown' };
}
