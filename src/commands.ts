export type Cmd =
  | { t: 'topic'; q: string } | { t: 'exact'; q: string } | { t: 'explain'; q: string } | { t: 'question'; q?: string }
  | { t: 'repeat'; arg?: string } | { t: 'pick'; n: number }
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
  on: 1, own: 1, when: 1, want: 1, juan: 1, oun: 1, wun: 1, run: 1, 'ওয়ানা': 1, 'এক্': 1,
  do: 2, dew: 2, tue: 2, tuu: 2, 'তু': 2, 'দু': 2, 'দুটো': 2,
  thee: 3, thre: 3, thrie: 3, fee: 3, sri: 3, shree: 3, three: 3, 'ত্রি': 3, 'তিনটা': 3,
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
// the phone's mic can hear the app reading "Did you mean ... Say one, two or three." and then the answer: keep only the answer
export function stripChoiceEcho(s: string): string {
  const m = s.toLowerCase().match(/(?:did you mean|say one)[\s\S]*?(?:two|to|too|2)\s*(?:or|and)\s*(?:three|tree|free|3)\s*[.!?।]*\s*(.*)$/);
  return m ? m[1].trim() : s;
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
const LEAD = /^(?:(?:ok|okay|hey|hi|please|now|just|you can)\s+)+/;
const TAIL = /(?:\s+(?:please|now|sir|ok|okay|thanks?|thank you))+$/;
const GREET = /^(?:hi+|hii+|hello+|hey+|hola|namaste|thanks?|thank you|ok|okay|good (?:morning|evening|night)|হ্যালো|হাই)$/;
export const isGreeting = (s: string) => GREET.test(s.trim().toLowerCase().replace(/[.!?।,\s]+$/, ''));

export function parse(s: string): Cmd {
  let x = s.trim().toLowerCase().replace(/[.!?।,]+$/, '').replace(/\s+/g, ' ');
  const y = x.replace(LEAD, '').replace(TAIL, '').trim();
  if (y && ALIAS[y]) return { t: ALIAS[y] } as Cmd;             // "okay stop please" == "stop"
  if (y && y !== x && /^(?:topics?|টপিক|exact|exactly|explain|question|questions)\b/.test(y)) x = y;
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
  // question [whole question] [okay]: say "question", then the full question, then "okay"
  m = x.match(/^(?:ask (?:a )?question|questions?|প্রশ্ন)(?:\s*:?\s+(.+))?$/);
  if (m) return { t: 'question', q: m[1] };
  m = x.match(/^(?:repeat|again|আবার)(?:\s+(?:point\s+)?(.+))?$/);
  if (m) return { t: 'repeat', arg: m[1] ? (NUM[m[1]] ?? m[1]) : undefined };
  return { t: 'unknown' };
}
