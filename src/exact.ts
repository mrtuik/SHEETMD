// "exact <topic name>": word-for-word reading of one topic from the .md file. NO model, NO rewriting.
// The topic is read from its heading to the next topic's heading (sub-headings, bullets, numbered steps and table rows
// all included, in the file's own order). Only layout noise is removed: HTML tags/styles, page markers, "Back to Index".
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
const rowText = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => stripMarkdown(c)).filter((c) => c && c !== '-' && c !== '—').join(', ');

export function exactPoints(name: string, body: string): Point[] {
  const lines = stripHtml(body.replace(/\r/g, '')).split('\n');
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
      while (true) {
        if (!isSep(t === lines[i].trim() ? t : lines[i].trim())) { const r = rowText(lines[i]); if (r) cur().lines.push(r); }
        if (i + 1 < lines.length && isRow(lines[i + 1].trim())) i++; else break;
      }
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
