// Rule-based exam notes built from the markdown structure:
// sub-headings -> points (Principle, Procedure...), tables -> spoken rows, bullets -> sentences.
// Swap makeNotes() for an LLM later; the Point shape stays the same.
import { stripMarkdown, splitSentences } from './cleaner';

export type Point = { n: number; title: string; text: string };
type Sec = { title: string; items: string[] };

const HEAD = /^\s{0,3}#{1,6}\s+(\S.*?)\s*#*\s*$/;
const BOLD = /^\s*\*\*([^*\n]{2,80}?)\*\*:?\s*$/;
const BULLET = /^\s*([-*+•▪◦●○■□]|\d+[.)])\s+(.*)$/;
const DEF = /\b(is|are|refers to|means|defined as|mane|holo)\b/i;
const EX = /(for example|e\.g\.|such as|formula|example)|=/i;

const title = (s: string) => stripMarkdown(s).replace(/^\d+[.)]\s+/, '').replace(/[:：]+$/, '').trim();
const unlabel = (s: string) => s.replace(/^definition\s*:\s*/i, '');
const endP = (s: string) => (/[.!?।:;]$/.test(s) ? s : s + '.');
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => stripMarkdown(c));
const isSep = (l: string) => /^[\s|:\-]+$/.test(l) && /-/.test(l);
const isRow = (l: string) => /^\s*\|/.test(l) || (l.match(/\|/g) || []).length >= 2;

function tableRows(rows: string[]): string[] {
  let head: string[] | null = null;
  const data: string[][] = [];
  rows.forEach((r, i) => {
    if (isSep(r)) return;
    const c = cells(r);
    if (i === 0 && rows[1] && isSep(rows[1])) head = c; else data.push(c);
  });
  const out: string[] = [];
  for (const c of data) {
    const vals = c.map((x) => (x === '-' || x === '—' ? '' : x));
    if (vals.every((x) => !x)) continue;
    if (vals.length === 2) { out.push(vals[1] ? `${vals[0]}: ${vals[1]}` : vals[0]); continue; }
    const parts = vals.slice(1).map((v, k) => (v ? (head && head[k + 1] ? `${head[k + 1]}: ${v}` : v) : '')).filter(Boolean);
    out.push([vals[0], ...parts].filter(Boolean).join('. '));
  }
  return out;
}

function parse(body: string): { pre: string[]; secs: Sec[] } {
  const pre: string[] = [];
  const secs: Sec[] = [];
  let cur: string[] = pre;
  let para: string[] = [];
  let fence = false;
  const flush = () => {
    if (para.length) cur.push(...splitSentences(stripMarkdown(para.join(' '))).filter((s) => s.length > 3));
    para = [];
  };
  const lines = body.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) { flush(); fence = !fence; continue; }
    const t = l.trim();
    if (!t) { flush(); continue; }
    let m: RegExpMatchArray | null;
    if (!fence && (m = t.match(HEAD) || t.match(BOLD))) {
      flush();
      const s: Sec = { title: title(m[1]), items: [] };
      secs.push(s); cur = s.items;
      continue;
    }
    if (!fence && /^[-=_*~\s]{3,}$/.test(t)) { flush(); continue; }
    if (!fence && isRow(t)) {
      flush();
      const rows = [t];
      while (i + 1 < lines.length && isRow(lines[i + 1].trim())) rows.push(lines[++i].trim());
      cur.push(...tableRows(rows));
      continue;
    }
    const q = t.replace(/^>+\s?/, '');
    const ex = q.match(/^\*\*(explain[^*]{0,40})\*\*:?\s*(.*)$/i) || q.match(/^(explain\s*\(mr\.?\s*tuik\))\s*:?\s*(.*)$/i);
    if (ex) {                                   // the "Explain (Mr. Tuik)" box is its own point
      flush();
      const s: Sec = { title: title(ex[1]), items: [] };
      const r = stripMarkdown(ex[2]);
      if (r) s.items.push(...splitSentences(r));
      secs.push(s); cur = s.items;
      continue;
    }
    if ((m = q.match(BULLET))) { flush(); const it = stripMarkdown(m[2].replace(/^\[[ xX]\]\s*/, '')); if (it.length > 3) cur.push(it); continue; }
    para.push(q);
  }
  flush();
  return { pre, secs: secs.filter((s) => s.items.length) };
}

const label = (it: string) => {
  const m = it.match(/^([^:]{2,40}):\s+\S/);
  if (m) return m[1].trim();
  const w = it.replace(/^[^A-Za-z\u0980-\u09FF0-9]+/, '').split(/\s+/).slice(0, 5).join(' ').replace(/[,;:.\-–—]+$/, '');
  return w.length >= 3 ? w : 'Point';
};

function groups(items: string[]): string[][] {
  const out: string[][] = [];
  let g: string[] = [], len = 0;
  for (const it of items) {
    if (g.length && (g.length >= 6 || len + it.length > 650)) { out.push(g); g = []; len = 0; }
    g.push(it); len += it.length;
  }
  if (g.length) out.push(g);
  return out;
}

export function makeNotes(name: string, body: string): Point[] {
  const { pre, secs } = parse(body);
  const pts: Omit<Point, 'n'>[] = [];
  const nm = title(name);
  let def = '';

  if (!secs.length) {
    if (!pre.length) return [{ n: 1, title: 'Empty', text: 'No content found for this topic.' }];
    const di = Math.max(0, pre.findIndex((s) => DEF.test(s)));
    def = unlabel(pre[di]);
    const rest = pre.filter((_, i) => i !== di);
    const examples = rest.filter((s) => EX.test(s));
    pts.push({ title: 'Definition', text: endP(def) });
    rest.filter((s) => !EX.test(s)).slice(0, 25).forEach((k) => pts.push({ title: label(k), text: endP(k) }));
    if (examples.length) pts.push({ title: 'Examples', text: examples.slice(0, 4).map(endP).join(' ') });
  } else {
    const hasDef = secs.some((s) => /^definition/i.test(s.title));
    let rest = pre;
    if (!hasDef) {
      const di = pre.findIndex((s) => DEF.test(s));
      if (di >= 0) { def = unlabel(pre[di]); rest = pre.filter((_, i) => i !== di); pts.push({ title: 'Definition', text: endP(def) }); }
    }
    groups(rest).forEach((g, k) => pts.push({ title: k ? `Overview, part ${k + 1}` : 'Overview', text: g.map(endP).join(' ') }));
    for (const s of secs) {
      groups(s.items).forEach((g, k) => pts.push({ title: k ? `${s.title}, part ${k + 1}` : s.title, text: g.map(endP).join(' ') }));
    }
  }

  if (pts.length > 40) pts.length = 40;
  if (pts.length >= 3) {
    const d = def ? splitSentences(def)[0] : '';
    pts.push({ title: 'Quick summary', text: d ? `${nm}. ${endP(d)}` : `${nm}. Covered: ${pts.map((p) => p.title).join(', ')}.` });
  }
  return pts.map((p, i) => ({ n: i + 1, ...p }));
}
