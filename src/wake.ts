// Wake word "tuik": when the app is in the background / the phone is locked, a command only counts after "tuik"
// ("tuik pause", or "tuik" and then the command). The recogniser never knows this word, so many spellings are accepted.
//
// FIX: while the app is reading, the mic hears the app's OWN voice first and "tuik" arrives glued to the END of it
// ("...cell membrane tuik pause"). The old code only looked at the first word, so "tuik" never woke the app during
// reading. Now the LAST "tuik" anywhere in the heard text counts (unless the app itself just said that word).
const SINGLE = new Set([
  'tuik', 'tuick', 'tuiq', 'twik', 'twick', 'tweak', 'tweek', 'tweaks', 'tuek', 'tuk', 'tik', 'tick', 'tui', 'tuy', 'toik', 'tooik',
  'twix', 'tweet', 'twig', 'twic', 'tvik', 'tuique', 'tuke', 'tuuk', 'teek', 'teak', 'quick', 'tweeq', 'twiq', 'tuck',
  'টুইক', 'তুইক', 'টুইক্', 'টুয়িক', 'টুইক।', 'টুইট', 'টুক', 'টিক', 'ট্যুইক', 'তুইক্',
]);
// the recogniser often splits it in two: "to eek", "tu ik", "two ik", "to week", "2 ick"
const JOINED = new Set(['toeek', 'tuik', 'twoik', 'toweek', 'tuick', 'toik', 'tooik', 'tweek', 'tuek', 'toick', 'twoick', 'tuic', '2ik', '2ick', '2eek', 'toeak', 'tweak', 'tuiq', 'tueek', 'তুইক', 'টুইক', 'তু ইক']);
// sounds-like pattern: t / tw / tu / to / two / 2 / qu + vowels + ik / ick / eek / eak
const PH = /^(?:t|tw|tu|to|too|two|2|kw|qu|dw)(?:u|o|w|e|i|y|a)*(?:ik|ick|eek|eak|ek|uk|uck|ic|iq|ique|ix|eke|ike)s?$/;
const LEAD = new Set(['hey', 'ok', 'okay', 'hi', 'hello', 'hay', 'ay']);

const norm = (s: string) => s.toLowerCase().replace(/[.,!?।"'“”‘’:;]/g, '').trim();
const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

// strict = safe to accept in the MIDDLE of a sentence (not a common English word like tick / quick / tweet)
const STRICT_ONE = new Set(['tuik', 'tuick', 'tuiq', 'twik', 'twick', 'tuek', 'toik', 'tooik', 'tuique', 'tvik', 'twiq', 'tweeq', 'টুইক', 'তুইক', 'টুইক্', 'টুয়িক', 'ট্যুইক', 'তুইক্']);
const one = (w: string, strict: boolean) => {
  if (strict) return STRICT_ONE.has(w) || (/^(?:tu|twi|toi|tooi|twoi)/.test(w) && PH.test(w));
  return SINGLE.has(w) || PH.test(w);
};
const two = (a: string, b: string, strict: boolean) => {
  const j = a + b;
  if (JOINED.has(j)) return true;
  return !strict ? PH.test(j) : /^(?:tu|twi|toi|tooi|twoi|toe|twoe|2)/.test(j) && PH.test(j);
};
// how many words (0 / 1 / 2) starting at i are the wake word
function at(w: string[], i: number, strict: boolean): number {
  const a = norm(w[i] || '');
  if (!a) return 0;
  if (one(a, strict)) return 1;
  if (i + 1 < w.length && two(a, norm(w[i + 1]), strict)) return 2;
  return 0;
}
const trimLead = (s: string) => s.replace(/^[\s,.:;!?।-]+/, '').trim();

export function splitWake(text: string, spoken = ''): { hit: boolean; rest: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { hit: false, rest: '' };
  // 1) wake word at the start ("tuik pause", "hey tuik pause")
  const skip = words.length > 1 && LEAD.has(norm(words[0])) ? 1 : 0;
  const n0 = at(words, skip, false);
  // a word of the notes the app itself is saying ("quick", "tick", "tweet" ...) is not the wake word
  const sp0 = new Set(tokens(spoken));
  const own = n0 > 0 && spoken !== '' && words.slice(skip, skip + n0).map(norm).every((t) => sp0.has(t));
  if (n0 && !own) return { hit: true, rest: trimLead(words.slice(skip + n0).join(' ')) };
  // 2) glued behind the app's own voice: take the LAST clear "tuik" that the app did not say itself
  const sp = new Set(tokens(spoken));
  for (let i = words.length - 1; i >= 1; i--) {
    const n = at(words, i, true);
    if (!n) continue;
    if (spoken && words.slice(i, i + n).map(norm).every((t) => sp.has(t))) continue;     // the app said this word
    return { hit: true, rest: trimLead(words.slice(i + n).join(' ')) };
  }
  return { hit: false, rest: text };
}
