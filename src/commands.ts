export type Cmd =
  | { t: 'topic'; q: string } | { t: 'explain'; q: string } | { t: 'question'; q?: string }
  | { t: 'repeat'; arg?: string } | { t: 'pick'; n: number }
  | { t: 'continue' | 'pause' | 'stop' | 'next' | 'prev' | 'slower' | 'faster' | 'unknown' };

const NUM: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

// English + a few Bangla words (for Bangla voice mode)
// "one / two / three" answers the 3-options question (only acted on while options are waiting)
const PICK: Record<string, number> = {
  one: 1, won: 1, first: 1, '1': 1, ek: 1, 'এক': 1, 'প্রথম': 1, '১': 1,
  two: 2, to: 2, too: 2, second: 2, '2': 2, dui: 2, 'দুই': 2, 'দ্বিতীয়': 2, '২': 2,
  three: 3, tree: 3, free: 3, third: 3, '3': 3, tin: 3, 'তিন': 3, 'তৃতীয়': 3, '৩': 3,
};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// spoken "okay" that ends a question ("what is anemia okay")
export const OK_END = /(?:^|\s)(?:okay|ok|okey|o\.k\.?|ওকে|ঠিক আছে)\s*[.!?।]*$/i;
// words that cancel a question that is being dictated
export const CANCEL_Q = /^(?:cancel|stop|never ?mind|বাতিল|স্টপ)$/i;

export function parse(s: string): Cmd {
  const x = s.trim().toLowerCase().replace(/[.!?।,]+$/, '').replace(/\s+/g, ' ');
  const pk = x.match(/^(?:option|number|no|choose|select|pick|নম্বর)?\s*(\S+)$/);
  if (pk && has(PICK, pk[1])) return { t: 'pick', n: PICK[pk[1]] };
  let m = x.match(/^(?:topics?|টপিক)\s*:?\s+(.+)$/);
  if (m) return { t: 'topic', q: m[1] };
  // explain <topic>: answered from the model's own knowledge (+ a web lookup), NOT from your sources
  m = x.match(/^(?:explain|এক্সপ্লেন|ব্যাখ্যা)\s*:?\s+(?:about\s+)?(.+)$/);
  if (m) return { t: 'explain', q: m[1] };
  // question [whole question] [okay]: say "question", then the full question, then "okay"
  m = x.match(/^(?:ask (?:a )?question|questions?|প্রশ্ন)(?:\s*:?\s+(.+))?$/);
  if (m) return { t: 'question', q: m[1] };
  m = x.match(/^(?:repeat|again|আবার)(?:\s+(?:point\s+)?(.+))?$/);
  if (m) return { t: 'repeat', arg: m[1] ? (NUM[m[1]] ?? m[1]) : undefined };
  if (/^(continue|resume|play|go on|চালু|চালাও|কন্টিনিউ)$/.test(x)) return { t: 'continue' };
  if (/^(pause|wait|hold on|থামো|পজ)$/.test(x)) return { t: 'pause' };
  if (/^(stop|cancel|স্টপ|বন্ধ)$/.test(x)) return { t: 'stop' };
  if (/^(next|next point|skip|নেক্সট|পরের|পরেরটা)$/.test(x)) return { t: 'next' };
  if (/^(previous|previous point|back|go back|আগের|আগেরটা|ব্যাক)$/.test(x)) return { t: 'prev' };
  if (/^(slower|slow down|slow|আস্তে)$/.test(x)) return { t: 'slower' };
  if (/^(faster|speed up|fast|জোরে|দ্রুত)$/.test(x)) return { t: 'faster' };
  return { t: 'unknown' };
}
