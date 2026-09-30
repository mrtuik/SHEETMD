// Rule-based exam notes (fixed order: Definition, key points, examples, summary).
// Swap makeNotes() for a llama.rn call later; the Point shape stays the same.
export type Point = { n: number; title: string; text: string };

const clean = (s: string) => s.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim();

function items(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    if (!l || /^#{1,6}\s/.test(l) || /^[-=*_|:\s]{3,}$/.test(l)) continue;
    if (/^([-*•]|\d+[.)])\s+/.test(l)) out.push(clean(l.replace(/^([-*•]|\d+[.)])\s+/, '')));
    else out.push(...(l.match(/[^.!?।]+[.!?।]?/g) || []).map(clean));
  }
  return out.filter((s) => s.length > 3);
}

export function makeNotes(name: string, body: string): Point[] {
  const all = items(body);
  if (!all.length) return [{ n: 1, title: 'Empty', text: 'No content found for this topic.' }];
  const ex = /(for example|e\.g\.|such as|formula|example)|=/i;
  const di = Math.max(0, all.findIndex((s) => /\b(is|are|refers to|means|defined as)\b/i.test(s)));
  const def = all[di];
  const rest = all.filter((_, i) => i !== di);
  const examples = rest.filter((s) => ex.test(s));
  const keys = rest.filter((s) => !ex.test(s)).slice(0, 20);
  const pts: Omit<Point, 'n'>[] = [{ title: 'Definition', text: def }];
  keys.forEach((k) => pts.push({ title: k.split(/\s+/).slice(0, 3).join(' ').replace(/[,;:]$/, ''), text: k }));
  if (examples.length) pts.push({ title: 'Examples', text: examples.slice(0, 4).join(' ') });
  pts.push({ title: 'Quick summary', text: `${name}. ${def}` });
  return pts.map((p, i) => ({ n: i + 1, ...p }));
}
