// Wake word "tuik": when the app is in the background / the phone is locked, a command only counts after "tuik"
// ("tuik pause", or "tuik" and then the command). The recogniser never knows this word, so many spellings are accepted.
const SINGLE = new Set([
  'tuik', 'tuick', 'tuiq', 'twik', 'twick', 'tweak', 'tweek', 'tweaks', 'tuek', 'tuk', 'tik', 'tick', 'tui', 'tuy', 'toik', 'tooik',
  'twix', 'tweet', 'twig', 'twic', 'tvik', 'tuique', 'টুইক', 'তুইক', 'টুইক্', 'টুয়িক', 'টুইক।',
]);
// the recogniser often splits it in two: "to eek", "tu ik", "two ik", "to week"
const JOINED = new Set(['toeek', 'tuik', 'twoik', 'toweek', 'tuick', 'toik', 'tooik', 'tweek', 'tuek', 'toick', 'twoick', 'tuic', 'তু ইক']);
const LEAD = new Set(['hey', 'ok', 'okay', 'hi', 'hello', 'hay', 'ay']);

const norm = (s: string) => s.toLowerCase().replace(/[.,!?।"'“”‘’:;]/g, '').trim();

export function splitWake(text: string): { hit: boolean; rest: string } {
  let words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { hit: false, rest: '' };
  let skip = 0;
  if (words.length > 1 && LEAD.has(norm(words[0]))) skip = 1;          // "hey tuik ..."
  const w = words.slice(skip);
  const take = (n: number) => w.slice(n).join(' ').replace(/^[\s,.:;!?।-]+/, '').trim();
  if (w.length >= 1 && SINGLE.has(norm(w[0]))) return { hit: true, rest: take(1) };
  if (w.length >= 2 && JOINED.has(norm(w[0]) + norm(w[1]))) return { hit: true, rest: take(2) };
  return { hit: false, rest: text };
}
