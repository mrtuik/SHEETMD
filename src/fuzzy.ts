// Small fuzzy-matching helpers shared by search (db.ts) and section reading (mdsplit.ts).
// A typo or an OCR slip ("Penneab1lity") still matches because words are compared by shared 3-letter pieces.

export const words = (s: string): string[] => s.match(/[\p{L}\p{N}]+/gu) || [];

export function grams(w: string): Set<string> {
  const p = `  ${w} `;
  const g = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) g.add(p.slice(i, i + 3));
  return g;
}

// Dice similarity of two words, 0..1 (1 = same)
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const x = grams(a), y = grams(b);
  let hit = 0;
  x.forEach((k) => { if (y.has(k)) hit++; });
  return (2 * hit) / (x.size + y.size);
}

// How well does ONE query word match ONE word of the text? 1 = exact / starts with / contains.
export function wordScore(q: string, w: string): number {
  if (w === q || w.startsWith(q)) return 1;
  if (q.length >= 4 && w.includes(q)) return 0.95;
  if (q.length >= 4 && q.startsWith(w) && w.length >= 4) return 0.9;
  const d = dice(q, w);
  return d >= 0.5 ? d : 0;
}

// Average over the query words of their best match inside `text`. All words found = close to 1.
export function textScore(toks: string[], text: string): number {
  const ws = words(text);
  if (!ws.length || !toks.length) return 0;
  let sum = 0;
  for (const t of toks) {
    let best = 0;
    for (const w of ws) { const s = wordScore(t, w); if (s > best) { best = s; if (best === 1) break; } }
    sum += best;
  }
  return sum / toks.length;
}

// FTS5 trigram query: the query words cut into 3-letter pieces, OR-ed. More shared pieces = better bm25 rank.
export function gramQuery(toks: string[], maxPerWord = 30): string {
  const parts: string[] = [];
  for (const t of toks) {
    if (t.length < 3) continue;
    let n = 0;
    for (let i = 0; i + 3 <= t.length && n < maxPerWord; i++, n++) parts.push(`"${t.slice(i, i + 3)}"`);
  }
  return [...new Set(parts)].join(' OR ');
}
