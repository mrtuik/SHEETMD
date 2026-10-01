// "exact <topic name>": word-for-word reading of one topic from the file. NO model, NO rewriting.
// The whole topic is read, from its heading to the next topic's heading: sub-headings, bullets, numbered lists,
// paragraphs and TABLES, in the file's own order. Every sub-heading becomes its own point ("Point 3. Autoclave")
// and EVERYTHING under it is read (nothing is left as a bare title).
// A table is read as:  "Table. Left column: A. Right column: B."  then  "Row 1. Left side: ... Right side: ..."
// Only layout noise is removed: HTML tags/styles, page markers, "Back to Index".
import { stripMarkdown } from './cleaner';
import type { Point } from './notes';

const HEAD = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/;
const BOLD = /^\s*\*\*([^*\n]{2,80}?)\*\*:?\s*$/;
const BULLET = /^\s*(?:[-*+•▪◦●○■□])\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const NOISE = [
  /^\W*back to index\W*$/i,
  /^\W*(?:page\s*\d+(?:\s*of\s*\d+)?|left column|right column)\W*$/i,
  /^\W*mr\.?\s*tuik notes\W*(?:\|?\s*page\s*\d+(?:\s*of\s*\d+)?)?\W*$/i,
  /^\W*batch\s*[a-z]?\d+\W*$/i,
  /^[-=_*~\s]{3,}$/,
];

export function stripHtml(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const isSep = (l: string) => /^[\s|:\-]+$/.test(l) && /-/.test(l);
const isRow = (l: string) => /^\s*\|/.test(l) || (l.match(/\|/g) || []).length >= 2;
const cellsOf = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => stripMarkdown(c).replace(/^[-—–]$/, '').trim());
const dot = (s: string) => (/[.!?।:;]$/.test(s) ? s : s + '.');

// table -> spoken lines. Left side / right side for 2 columns, column names for more.
export function tableLines(rows: string[][], hasHead: boolean): string[] {
  const n = Math.max(...rows.map((r) => r.length), 0);
  if (!n) return [];
  let head: string[] | null = hasHead ? rows[0] : null;
  let data = hasHead ? rows.slice(1) : rows;
  const hk = head ? head.join('|').toLowerCase() : '';
  data = data.filter((r) => r.some((c) => c) && !(hk && r.join('|').toLowerCase() === hk));     // header repeated at a page break
  const out: string[] = [];
  if (n === 1) { data.forEach((r) => r[0] && out.push(r[0])); return out; }
  if (n === 2) {
    out.push(head && (head[0] || head[1])
      ? `Table. Left column: ${head[0] || 'blank'}. Right column: ${head[1] || 'blank'}.`
      : 'Table. Two columns, left side and right side.');
    data.forEach((r, i) => {
      const parts = [`Row ${i + 1}.`];
      if (r[0]) parts.push(`Left side: ${dot(r[0])}`);
      if (r[1]) parts.push(`Right side: ${dot(r[1])}`);
      out.push(parts.join(' '));
    });
    return out;
  }
  const names = Array.from({ length: n }, (_, j) => (head && head[j]) || `Column ${j + 1}`);
  out.push(`Table with ${n} columns: ${names.join(', ')}.`);
  data.forEach((r, i) => {
    const parts = [`Row ${i + 1}.`];
    names.forEach((nm, j) => { if (r[j]) parts.push(`${nm}: ${dot(r[j])}`); });
    out.push(parts.join(' '));
  });
  return out;
}

export function exactPoints(name: string, body: string): Point[] {
  const pre = body.replace(/\r/g, '').split('\n').map((l) => (isRow(l) ? l.replace(/<br\s*\/?>/gi, ' ') : l)).join('\n');
  const lines = stripHtml(pre).split('\n');
  type Raw = { title: string; lines: string[] };
  const raws: Raw[] = [{ title: 'Introduction', lines: [] }];
  const cur = () => raws[raws.length - 1];
  let fence = false;
  const hasHash = lines.some((l) => HEAD.test(l));      // bold lines are headings only in files that have no # headings

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) { fence = !fence; continue; }
    if (!t) continue;
    if (NOISE.some((r) => r.test(t))) continue;
    let m: RegExpMatchArray | null;
    if (!fence && (m = t.match(HEAD) || (!hasHash ? t.match(BOLD) : null))) {
      const title = stripMarkdown(m[1]).replace(/^\d+[.)]\s+/, '').replace(/[:：]+$/, '').trim();
      if (!title) continue;
      if (!cur().lines.length) cur().title = cur().title === 'Introduction' ? title : `${cur().title} - ${title}`;   // heading right after heading
      else raws.push({ title, lines: [] });
      continue;
    }
    if (!fence && isRow(t)) {
      const rows: string[][] = [];
      let hasHead = false;
      for (let k = i; k < lines.length && isRow(lines[k].trim()); k++, i = k - 1) {
        const l = lines[k].trim();
        if (isSep(l)) { if (rows.length === 1) hasHead = true; continue; }
        rows.push(cellsOf(l));
      }
      cur().lines.push(...tableLines(rows, hasHead));
      continue;
    }
    const q = t.replace(/^>+\s?/, '');
    if ((m = q.match(NUMBERED))) { const x = stripMarkdown(m[2]); if (x) cur().lines.push(`${m[1]}: ${x}`); continue; }   // "1: Take 5 mL ..." (a bare "1." is dropped by the voice)
    if ((m = q.match(BULLET))) { const x = stripMarkdown(m[1].replace(/^\[[ xX]\]\s*/, '')); if (x) cur().lines.push(x); continue; }
    const x = stripMarkdown(q);
    if (x) cur().lines.push(x);
  }

  // long sections are cut into parts (a short pause between parts = time to write)
  const pts: Omit<Point, 'n'>[] = [];
  for (const r of raws) {
    if (!r.lines.length) continue;
    let part: string[] = [], len = 0, k = 1;
    const flush = () => {
      if (!part.length) return;
      pts.push({ title: k > 1 ? `${r.title}, part ${k}` : r.title, text: part.join(' '), bullets: part });
      part = []; len = 0; k++;
    };
    for (const l of r.lines) { if (part.length && len + l.length > 900) flush(); part.push(l); len += l.length; }
    flush();
  }
  if (!pts.length) return [{ n: 1, title: name, text: 'Nothing to read in this topic.' }];
  return pts.map((p, i) => ({ n: i + 1, ...p }));
}

// every word of the topic must be somewhere in the points (used by the self-test)
export function missingWords(body: string, pts: Point[]): string[] {
  const clean = (s: string) => stripMarkdown(stripHtml(s)).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3);
  const said = new Set(clean(pts.map((p) => p.title + ' ' + (p.bullets || [p.text]).join(' ')).join(' ')));
  const need = clean(body.split('\n').filter((l) => !isSep(l.trim())).join(' '));
  return [...new Set(need.filter((w) => !said.has(w) && !/^(left|right|column|side|row|table)$/.test(w)))];
}
