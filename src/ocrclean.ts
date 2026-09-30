// Fixes typical OCR mistakes at import time (only for text that came from OCR).
//  1. ligatures, broken hyphenation, stray symbols
//  2. common look-alike slips: "Uiis" -> "This", "die" -> "the", "tbe" -> "the" ...
//  3. document-adaptive spell fix: a word that appears ONCE but is one letter away from a word that appears
//     many times in the same document is almost certainly an OCR slip of it ("hemoglobln" -> "hemoglobin").
//     No dictionary is needed, so medical terms are safe: they are learned from the document itself.

const SLIPS: [RegExp, string][] = [
  [/\b(Uiis|Tiiis|Thls|Tliis|Tbis|Ihis|Tihs|Thi5|Th1s)\b/g, 'This'],
  [/\b(uiis|tiiis|thls|tliis|tbis|ihis|thi5|th1s)\b/g, 'this'],
  [/\b(tbe|tlie|tiie|lhe|ihe|thc|tne)\b/g, 'the'],
  [/\b(Tbe|Tlie|Tiie|Lhe|Ihe|Thc)\b/g, 'The'],
  [/\bdie(?= [a-z]{3,})/g, 'the'],                 // "die" before a lowercase word is almost always "the"
  [/\b(aud|anil|arid|aod)\b(?= [a-z])/g, 'and'],
  [/\b(wilh|wiih|witb|vvith|wjth)\b/g, 'with'],
  [/\b(lhat|tliat|tbat|thal)\b/g, 'that'],
  [/\b(lo)\b(?= (the|be|a|an|all|each|measure|estimate|determine|detect|check|find|use|get|see|do|make|take)\b)/g, 'to'],
  [/\b(ol)\b(?= (the|a|an|all|blood|red|white|serum|plasma|urine)\b)/g, 'of'],
  [/\b(nol|noi)\b(?= [a-z])/g, 'not'],
  [/\biu\b(?= (the|a|an|all|blood|red|white)\b)/g, 'in'],
  [/\b(fiom|fr0m|frorn)\b/g, 'from'],
  [/\b(wlien|whcn|vvhen)\b/g, 'when'],
  [/\b(whicb|vvhich|whieh)\b/g, 'which'],
  [/\b(ihere|tbere|tliere)\b/g, 'there'],
  [/\b(nonnal|nornial|normai)\b/g, 'normal'],
  [/\b(conlent|contenl)\b/g, 'content'],
];

const vocabOf = (text: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const w of text.toLowerCase().match(/\p{L}{4,}/gu) || []) m.set(w, (m.get(w) || 0) + 1);
  return m;
};

const dels = (w: string): string[] => {
  const o: string[] = [];
  for (let i = 0; i < w.length; i++) o.push(w.slice(0, i) + w.slice(i + 1));
  return o;
};

// true if a and b are exactly one SUBSTITUTION apart (same length) - insertions/deletions are not touched,
// so plurals and endings (cell / cells) are never "corrected"
const oneSub = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && (++d > 1 || i === a.length - 1)) return false;   // last letter = ending (s/d), leave it
  return d === 1;
};

// one inserted or missing letter in the MIDDLE of a word (not at the end), e.g. "hemoglbin" / "hemoglobin"
const oneGap = (short: string, long: string) => {
  if (long.length !== short.length + 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (i === 0 || i >= short.length) return false;          // change at the very start or end: leave it
  return short.slice(i) === long.slice(i + 1);
};

function buildFixer(vocab: Map<string, number>) {
  const trusted: string[] = [];
  vocab.forEach((n, w) => { if (n >= 3 && w.length >= 5) trusted.push(w); });
  const idx = new Map<string, string[]>();
  for (const t of trusted) for (const k of [t, ...dels(t)]) { const a = idx.get(k); if (a) a.push(t); else idx.set(k, [t]); }

  return (w: string): string => {
    const lw = w.toLowerCase();
    if (lw.length < 5 || (vocab.get(lw) || 0) > 1) return w;       // seen more than once: probably a real word
    const found = new Set<string>();
    for (const k of [lw, ...dels(lw)]) (idx.get(k) || []).forEach((t) => found.add(t));
    let best = '', bestN = 0;
    found.forEach((t) => {
      if (t[0] !== lw[0]) return;                                   // OCR rarely gets the first letter wrong inside a word
      if (!(oneSub(lw, t) || oneGap(lw, t) || oneGap(t, lw))) return;
      const n = vocab.get(t) || 0;
      if (n > bestN && n >= 3) { best = t; bestN = n; }
    });
    if (!best) return w;
    if (w === w.toUpperCase()) return best.toUpperCase();
    if (w[0] === w[0].toUpperCase()) return best[0].toUpperCase() + best.slice(1);
    return best;
  };
}

/**
 * @param ocrText   text that came from OCR (the part to repair)
 * @param wholeDoc  optional: all text of the document (OCR + real text). Gives the spell fixer a bigger vocabulary.
 */
export function cleanOcr(ocrText: string, wholeDoc?: string): string {
  let t = ocrText
    .replace(/\r/g, '')
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00AD/g, '')                                         // soft hyphen
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')                       // hemo-\nglobin -> hemoglobin
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]*[|¦\\]+[ \t]*$/gm, '')                         // lines that are only a stray bar
    .replace(/(^|\n)[ \t]*[-_=~.·•]{2,}[ \t]*(?=\n|$)/g, '$1');     // lines of dashes / dots

  for (const [rx, to] of SLIPS) t = t.replace(rx, to);

  // a digit or bar inside a letter-word is a look-alike (only the clear cases)
  t = t
    .replace(/([a-z])0(?=[a-z])/g, '$1o')                          // b0ne -> bone
    .replace(/([a-z])\|(?=[a-z])/g, '$1l')                         // he|p -> help
    .replace(/\brn(?=[aeiou])/g, 'm');                              // rnedical -> medical

  const vocab = vocabOf(wholeDoc ? wholeDoc + '\n' + t : t);

  // "1" inside a word is an i or an l: try both and keep the one that is a word seen in the document
  t = t.replace(/\b[A-Za-z]{2,}1[A-Za-z1]*\b/g, (w0) => {
    // clear patterns first: ...1ty -> ity, ...1ng -> ing, ...1on -> ion, b1l / p1l -> bil / pil
    const w = w0.replace(/1(?=(ty|ng|on|ous|ve|al|ze|se)\b)/gi, 'i').replace(/([bp])1(?=l)/gi, '$1i');
    const pos = [...w].flatMap((c, i) => (c === '1' ? [i] : []));
    if (pos.length > 4) return w;
    let first = '';
    for (let m = 0; m < 1 << pos.length; m++) {
      const a = [...w];
      pos.forEach((p, k) => { a[p] = m & (1 << k) ? 'i' : 'l'; });
      const v = a.join('');
      if (!first) first = v;
      if ((vocab.get(v.toLowerCase()) || 0) >= 1) return v;
    }
    return first;
  });

  // adaptive spell fix
  const fix = buildFixer(vocab);
  t = t.replace(/\p{L}{5,}/gu, (w) => fix(w));

  return t.replace(/\n{3,}/g, '\n\n').trim();
}
