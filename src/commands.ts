export type Cmd =
  | { t: 'topic'; q: string } | { t: 'repeat'; arg?: string }
  | { t: 'continue' | 'pause' | 'stop' | 'next' | 'prev' | 'slower' | 'faster' | 'unknown' };

const NUM: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

// English + a few Bangla words (for Bangla voice mode)
export function parse(s: string): Cmd {
  const x = s.trim().toLowerCase().replace(/[.!?।,]+$/, '').replace(/\s+/g, ' ');
  let m = x.match(/^(?:topic|টপিক)\s*:?\s+(.+)$/);
  if (m) return { t: 'topic', q: m[1] };
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
