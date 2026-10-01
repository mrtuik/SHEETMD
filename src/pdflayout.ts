// Layout-aware PDF reader. The native module gives every WORD with its position, font size and bold flag.
// From that this file rebuilds the real structure of the page:
//   headings (by font size / bold), wrapped heading lines joined, bullets + nested bullets, numbered lists,
//   paragraphs (wrapped lines joined) and TABLES (columns found by x position, wrapped cell text kept inside its
//   own cell, repeated header rows at a page break removed, a table that continues on the next page merged).
// Output is markdown, so splitTopics() / exactPoints() work on it exactly like on a hand-written .md file.

export type W = { x: number; x2: number; y: number; size: number; bold: boolean; text: string };
export type Pg = { w: number; h: number; words: W[] };

// native format: first line "P\t<width>\t<height>", then one word per line "x\tx2\ty\tsize\tbold\ttext"
export function parseWords(raw: string): Pg {
  const pg: Pg = { w: 595, h: 842, words: [] };
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    const f = ln.split('\t');
    if (f[0] === 'P') { pg.w = +f[1] || 595; pg.h = +f[2] || 842; continue; }
    if (f.length < 6) continue;
    const x = +f[0], x2 = +f[1], y = +f[2], size = +f[3];
    const text = f.slice(5).join(' ').trim();
    if (!text || !isFinite(x) || !isFinite(y)) continue;
    pg.words.push({ x, x2: isFinite(x2) && x2 > x ? x2 : x + text.length * (size || 10) * 0.5, y, size: size > 0 ? size : 10, bold: f[4] === '1', text });
  }
  return pg;
}

type Seg = { x: number; x2: number; text: string };
type Ln = { page: number; y: number; size: number; bold: boolean; x: number; x2: number; text: string; segs: Seg[]; marker: '' | 'bullet' | 'num'; mx: number };

const BUL1 = /^[•▪◦●○■□‣∙·▫◾▸►▶]$/;
const BUL2 = /^([•▪◦●○■□‣∙·▫◾▸►▶])(\S.*)$/;
const NUM1 = /^\d{1,2}[.)]$/;
const key = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const isPageNo = (l: string) => /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.trim()) || /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(l.trim());
const r05 = (n: number) => Math.round(n * 2) / 2;

function buildLines(pg: Pg, page: number): Ln[] {
  const ws = [...pg.words].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: W[][] = [];
  for (const w of ws) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(w.y - r[0].y) <= Math.max(2, 0.4 * Math.max(w.size, r[0].size))) r.push(w); else rows.push([w]);
  }
  const out: Ln[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let marker: Ln['marker'] = '';
    let mx = 0, num = '';
    let rest = row;
    const f = row[0];
    if (BUL1.test(f.text) && row.length > 1) { marker = 'bullet'; mx = f.x; rest = row.slice(1); }
    else if (BUL2.test(f.text)) {
      const m = f.text.match(BUL2)!;
      marker = 'bullet'; mx = f.x; rest = [{ ...f, text: m[2] }, ...row.slice(1)];
    } else if (NUM1.test(f.text) && row.length > 1) { marker = 'num'; mx = f.x; num = f.text; rest = row.slice(1); }
    if (!rest.length) continue;
    const size = Math.max(...rest.map((w) => w.size));
    const lim = Math.max(0.9 * size, 6);
    const segs: Seg[] = [];
    for (const w of rest) {
      const s = segs[segs.length - 1];
      if (s && w.x - s.x2 <= lim) { s.text += ' ' + w.text; s.x2 = Math.max(s.x2, w.x2); }
      else segs.push({ x: w.x, x2: w.x2, text: w.text });
    }
    const text = (num ? num + ' ' : '') + segs.map((s) => s.text).join(' ');
    out.push({ page, y: row[0].y, size, bold: rest.every((w) => w.bold), x: rest[0].x, x2: rest[rest.length - 1].x2, text, segs, marker, mx });
  }
  return out;
}

// plain text of a page (lines, no structure) - used when the structured result has too few headings
export const plainText = (pg: Pg, page = 0) => buildLines(pg, page).map((l) => l.text).join('\n');
export const wordCount = (pg: Pg) => pg.words.reduce((a, w) => a + w.text.length, 0);

type Block =
  | { t: 'h'; size: number; bold: boolean; text: string; page: number; y: number; level: number }
  | { t: 'p'; text: string; page: number }
  | { t: 'li'; text: string; page: number; mx: number; num: boolean }
  | { t: 'tbl'; rows: string[][]; cols: number[]; page: number };

const colOf = (cols: number[], x: number) => { let c = 0; cols.forEach((v, i) => { if (v <= x + 6) c = i; }); return c; };

// a run of lines that forms a table: >= 2 lines that have 2+ segments starting at the same x positions
function tableRun(L: Ln[], i: number, body: number): { end: number; cols: number[] } | null {
  const first = L[i];
  if (first.segs.length < 2 || first.size > body * 1.15 || first.marker === 'bullet') return null;
  const cols = first.segs.map((s) => s.x);
  let multi = 1, end = i;
  for (let k = i + 1; k < L.length; k++) {
    const a = L[k - 1], b = L[k];
    const gap = b.y - a.y;
    if (gap > 4.5 * Math.max(a.size, b.size) || b.size > body * 1.15 || b.marker === 'bullet') break;
    if (b.segs.length >= 2) {
      const al = b.segs.filter((s) => cols.some((c) => Math.abs(c - s.x) <= 6)).length;
      if (al >= 2 || (al >= 1 && b.segs.length === cols.length)) { multi++; end = k; continue; }
      break;
    }
    const s = b.segs[0];
    const ci = cols.findIndex((c) => Math.abs(c - s.x) <= 6);
    if (ci >= 0 && (ci === cols.length - 1 || s.x2 <= cols[ci + 1] - 2) && b.marker === '') { end = k; continue; }   // wrapped cell text
    break;
  }
  return multi >= 2 ? { end, cols } : null;
}

function tableBlock(L: Ln[], i: number, end: number, cols: number[]): Block {
  const run = L.slice(i, end + 1);
  const gaps = run.slice(1).map((l, k) => l.y - run[k].y);
  const minG = gaps.length ? Math.min(...gaps) : 0, maxG = gaps.length ? Math.max(...gaps) : 0;
  const flat = maxG < minG * 1.15;
  const rows: string[][] = [];
  let cur: string[] = [];
  run.forEach((l, k) => {
    const newRow = k === 0 || flat || (l.y - run[k - 1].y) > minG * 1.35 || (k === 1 && run[0].bold && !l.bold);
    if (newRow) { cur = cols.map(() => ''); rows.push(cur); }
    l.segs.forEach((s) => { const c = colOf(cols, s.x); cur[c] = cur[c] ? cur[c] + ' ' + s.text : s.text; });
  });
  return { t: 'tbl', rows, cols, page: run[0].page };
}

const sameCols = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 10);

export function layoutPages(raw: Pg[]): { md: string; headings: number } {
  const lines: Ln[][] = raw.map((pg, p) => buildLines(pg, p));

  // header / footer: page numbers, and lines in the top / bottom margin that repeat on other pages
  const edge = new Map<string, number>();
  raw.forEach((pg, p) => new Set(lines[p].filter((l) => l.y < pg.h * 0.07 || l.y > pg.h * 0.93).map((l) => key(l.text))).forEach((k) => edge.set(k, (edge.get(k) || 0) + 1)));
  const keep = lines.map((L, p) => L.filter((l) => {
    const inEdge = l.y < raw[p].h * 0.07 || l.y > raw[p].h * 0.93;
    if (!inEdge) return true;
    return !(isPageNo(l.text) || (raw.length >= 2 && (edge.get(key(l.text)) || 0) >= 2));
  }));

  // body font size = the size that carries most characters
  const bySize = new Map<number, number>();
  keep.forEach((L) => L.forEach((l) => bySize.set(r05(l.size), (bySize.get(r05(l.size)) || 0) + l.text.length)));
  let body = 10, best = -1;
  bySize.forEach((n, s) => { if (n > best) { best = n; body = s; } });

  // normal line pitch (to tell "wrapped line" from "new paragraph")
  const pit: number[] = [];
  keep.forEach((L) => L.forEach((l, k) => { if (k && Math.abs(l.size - L[k - 1].size) < 1 && l.size <= body * 1.1) { const g = l.y - L[k - 1].y; if (g > 0 && g < 2.6 * l.size) pit.push(g); } }));
  pit.sort((a, b) => a - b);
  const g0 = pit.length ? pit[Math.floor(pit.length * 0.3)] : body * 1.3;

  const isHead = (l: Ln) => {
    if (l.marker === 'bullet' || l.text.length < 2 || l.text.length > 140) return false;
    if (l.size >= body * 1.12) return true;
    const wc = l.text.split(/\s+/).length;
    return l.bold && l.segs.length === 1 && l.marker === '' && wc <= 14 && !/[.,;]$/.test(l.text);
  };

  const blocks: Block[] = [];
  keep.forEach((L, p) => {
    let cur: Block | null = null;
    let prev: Ln | null = null;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      const run = tableRun(L, i, body);
      if (run) {
        const tb = tableBlock(L, i, run.end, run.cols) as Extract<Block, { t: 'tbl' }>;
        const last = blocks[blocks.length - 1];
        if (last && last.t === 'tbl' && last.page === p - 1 && sameCols(last.cols, tb.cols)) {     // table continues on the next page
          if (tb.rows.length && last.rows.length && tb.rows[0].join('|').toLowerCase() === last.rows[0].join('|').toLowerCase()) tb.rows.shift();
          last.rows.push(...tb.rows); last.page = p;
        } else blocks.push(tb);
        i = run.end; cur = null; prev = null;
        continue;
      }
      if (isHead(l)) {
        const last = blocks[blocks.length - 1];
        if (last && last.t === 'h' && last.page === p && Math.abs(last.size - l.size) < 0.6 && last.bold === l.bold && l.y - last.y <= 1.7 * l.size && !/[:.]$/.test(last.text)) {
          last.text += ' ' + l.text; last.y = l.y;                         // heading that wrapped onto a second line
        } else blocks.push({ t: 'h', size: l.size, bold: l.bold, text: l.text, page: p, y: l.y, level: 0 });
        cur = null; prev = l;
        continue;
      }
      if (l.marker) {
        cur = { t: 'li', text: l.marker === 'num' ? l.text : l.text, page: p, mx: l.mx, num: l.marker === 'num' };
        blocks.push(cur); prev = l; continue;
      }
      const gap = prev ? l.y - prev.y : 1e9;
      const crossPage = !prev && blocks.length && (() => { const b = blocks[blocks.length - 1]; return (b.t === 'p' || b.t === 'li') && /^[a-z(]/.test(l.text) && !/[.!?:]$/.test(b.text); })();
      if ((cur && prev && gap <= g0 * 1.35 && Math.abs(l.size - prev.size) < 1) || crossPage) {
        const t = (cur || blocks[blocks.length - 1]) as Extract<Block, { t: 'p' | 'li' }>;
        t.text = /[A-Za-z]-$/.test(t.text) && /^[a-z]/.test(l.text) ? t.text.slice(0, -1) + l.text : t.text + ' ' + l.text;
        if (!cur) cur = t;
      } else { cur = { t: 'p', text: l.text, page: p }; blocks.push(cur); }
      prev = l;
    }
  });

  // heading levels: bigger font = higher level; bold-only headings at body size are the lowest level
  const hs = blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h');
  const sizes: number[] = [];
  hs.filter((h) => h.size >= body * 1.12).map((h) => r05(h.size)).sort((a, b) => b - a).forEach((s) => { if (!sizes.length || sizes[sizes.length - 1] - s > 0.75) sizes.push(s); });
  hs.forEach((h) => {
    if (h.size >= body * 1.12) { const k = sizes.findIndex((s) => Math.abs(s - r05(h.size)) <= 0.75); h.level = Math.min(4, (k < 0 ? sizes.length - 1 : k) + 1); }
    else h.level = Math.min(6, sizes.length + 1 > 5 ? 5 : sizes.length + 1);
  });

  // markdown
  const bx = [...new Set(blocks.filter((b): b is Extract<Block, { t: 'li' }> => b.t === 'li' && !b.num).map((b) => Math.round(b.mx)))].sort((a, b) => a - b);
  const bxc: number[] = [];
  bx.forEach((x) => { if (!bxc.length || x - bxc[bxc.length - 1] > 5) bxc.push(x); });
  const out: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  for (const b of blocks) {
    if (b.t === 'h') out.push('', '#'.repeat(b.level) + ' ' + b.text.replace(/[:：]+$/, '').trim(), '');
    else if (b.t === 'p') out.push(b.text, '');
    else if (b.t === 'li') {
      const lv = b.num ? 0 : Math.max(0, bxc.findIndex((c) => Math.abs(c - b.mx) <= 5));
      out.push('  '.repeat(Math.min(lv, 3)) + (b.num ? '' : '- ') + b.text);
    } else {
      out.push('');
      const n = b.cols.length;
      b.rows.forEach((r, i) => {
        out.push('| ' + r.map(esc).join(' | ') + ' |');
        if (i === 0) out.push('|' + ' --- |'.repeat(n));
      });
      out.push('');
    }
  }
  return { md: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', headings: hs.length };
}
