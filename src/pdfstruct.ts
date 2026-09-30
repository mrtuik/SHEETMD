// A PDF gives plain lines, not headings. This finds the headings (numbered, ALL CAPS, Title Case lines)
// and writes them as "# Heading" so splitTopics() can cut the PDF into real topics.
// Repeating page headers/footers and page numbers are removed first.

import { GENERIC } from './mdsplit';

const SMALL = new Set('a,an,and,as,at,by,for,from,in,of,on,or,the,to,vs,with,via,per,is,are'.split(','));

const key = (l: string) => l.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

function dropRepeats(pages: string[][]): string[][] {
  const n = pages.length;
  if (n < 3) return pages.map((p) => p.filter((l) => !isPageNo(l)));
  const count = new Map<string, number>();
  pages.forEach((p) => {
    const edge = [...p.slice(0, 3), ...p.slice(-3)].map(key).filter(Boolean);
    new Set(edge).forEach((k) => count.set(k, (count.get(k) || 0) + 1));
  });
  const need = Math.max(3, Math.ceil(n * 0.25));
  const bad = new Set([...count].filter(([, c]) => c >= need).map(([k]) => k));
  return pages.map((p) => p.filter((l, i) => {
    if (isPageNo(l)) return false;
    const edge = i < 3 || i >= p.length - 3;
    return !(edge && bad.has(key(l)));
  }));
}

const isPageNo = (l: string) => /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.trim()) || /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(l.trim());

const isBullet = (l: string) => /^\s*([-*+•▪◦●○■□✓✔➤►▶]|\(?\d+[.)]\s+[a-z])/.test(l);
const isCaps = (l: string) => {
  const letters = l.replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase();
};
const titleCase = (l: string) => {
  const w = l.split(/\s+/).filter((x) => /[A-Za-z]/.test(x));
  if (!w.length) return false;
  return w.every((x, i) => /^[A-Z0-9(]/.test(x) || (i > 0 && SMALL.has(x.toLowerCase())));
};

type Head = { level: number; text: string } | null;

function headingOf(l: string, prev: string, next: string): Head {
  const t = l.trim();
  if (t.length < 3 || t.length > 80) return null;
  if (isBullet(t) || /[.,;?!]$/.test(t)) return null;
  const wc = t.split(/\s+/).length;
  if (wc > 10) return null;
  if ((t.match(/[A-Za-z]/g) || []).length / t.length < 0.55) return null;

  if (GENERIC.has(t.toLowerCase().replace(/[:：]+$/, '').trim())) return { level: 3, text: t.replace(/[:：]+$/, '') };

  let m = t.match(/^(chapter|unit|lesson|section)\s+(\d+|[ivxlc]+)\b[.:)\-\s]*(.*)$/i);
  if (m) return { level: 1, text: t };

  m = t.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+([A-Z].*)$/);
  if (m) {
    if (wc > 9 || /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/.test(m[2]) && /[.,;]$/.test(t)) return null;
    const depth = m[1].split('.').length;
    return { level: Math.min(depth, 4), text: m[2].replace(/:$/, '') };
  }

  const nextShort = !!next && next.trim().length < 45 && !/[.!?]$/.test(next.trim());
  const prevShort = !!prev && prev.trim().length < 45 && !/[.!?]$/.test(prev.trim());
  if (isCaps(t) && wc <= 8) return { level: 1, text: t.replace(/:$/, '') };
  // Title Case line sitting on its own (neighbours are not also short list/table cells)
  if (titleCase(t) && t.length >= 4 && !nextShort && !prevShort && next) return { level: 2, text: t.replace(/:$/, '') };
  return null;
}

/**
 * pages: text of each page. Returns markdown-like text (headings as #, # #...).
 * Also joins words broken by a hyphen at a line end.
 */
export function structurePages(pageTexts: string[]): { md: string; headings: number } {
  const pages = dropRepeats(pageTexts.map((p) => p.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)));
  const flat: string[] = [];
  pages.forEach((p) => p.forEach((l) => flat.push(l)));

  // glue "hemo-" + "globin"
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i++) {
    let l = flat[i];
    if (/[A-Za-z]-$/.test(l) && flat[i + 1] && /^[a-z]/.test(flat[i + 1])) { l = l.slice(0, -1) + flat[i + 1]; i++; }
    lines.push(l);
  }

  let headings = 0;
  const out: string[] = [];
  lines.forEach((l, i) => {
    const h = headingOf(l, lines[i - 1] || '', lines[i + 1] || '');
    if (h) { headings++; out.push('', '#'.repeat(h.level) + ' ' + h.text, ''); } else out.push(l);
  });
  return { md: out.join('\n').replace(/\n{3,}/g, '\n\n'), headings };
}

// No headings found at all: cut into readable parts so a topic search still reads a small part, not the whole PDF.
export function chunkPlain(base: string, text: string, size = 3500): { name: string; body: string }[] {
  const paras = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  const out: { name: string; body: string }[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > size) { out.push({ name: '', body: cur }); cur = ''; }
    cur += (cur ? '\n' : '') + p;
  }
  if (cur.trim().length > 20) out.push({ name: '', body: cur });
  return out.map((c, i) => ({ name: `${base} (part ${i + 1})`, body: c.body }));
}
