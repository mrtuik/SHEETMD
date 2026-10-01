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
// a line that ends right after a hyphen / en dash that touches a letter or digit ("early-" + "morning", "10–" + "20 mL") continues the same word
const GLUE = /[\p{L}\p{N}][-–]$/u;
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
      if (s && w.x - s.x2 <= lim) { s.text += (w.x - s.x2 < 0.12 * w.size ? '' : ' ') + w.text; s.x2 = Math.max(s.x2, w.x2); }   // gap ~0 = same word split by a font change ("disinfectant" + ".")
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

// a run of lines that forms a table. The first line has 2+ segments (the header, or the first row); the following lines
// start at those same x positions. Cells of one row are NOT on the same baseline (browsers centre the text of a cell
// vertically), so a row may be made of single-segment lines at different y: columns are used, not lines.
function tableRun(L: Ln[], i: number, body: number): { end: number; cols: number[] } | null {
  let j = i;
  const cols: number[] = [];
  const addCol = (x: number) => { if (!cols.some((c) => Math.abs(c - x) <= 6)) { cols.push(x); cols.sort((p, q) => p - q); } };
  if (L[i].segs.length < 2) {
    // header cells can sit on different baselines (a 2-line header cell next to a 1-line one): single-segment lines
    // less than one line pitch above the first multi-segment line belong to that header
    let k = i;
    while (k < L.length && k <= i + 2 && L[k].segs.length < 2 && L[k].marker === '' && L[k].size <= body * 1.15 && (k === i || L[k].y - L[k - 1].y <= 1.25 * L[k].size)) k++;
    if (k >= L.length || k === i || L[k].segs.length < 2 || L[k].y - L[k - 1].y > 1.25 * L[k].size || Math.abs(L[k].size - L[i].size) > 1) return null;
    j = k;
  }
  const first = L[j];
  if (first.segs.length < 2 || first.size > body * 1.15 || first.marker === 'bullet' || first.marker === 'num') return null;
  for (let k = i; k <= j; k++) L[k].segs.forEach((s) => addCol(s.x));
  let multi = 1, end = j;
  const used = new Set<number>();
  for (let k = i; k <= j; k++) L[k].segs.forEach((s) => used.add(colOf(cols, s.x)));
  for (let k = j + 1; k < L.length; k++) {
    const a = L[k - 1], b = L[k];
    const gap = b.y - a.y;
    if (gap > 4.5 * Math.max(a.size, b.size) || b.size > body * 1.15 || b.marker === 'bullet' || b.marker === 'num') break;
    if (Math.abs(b.size - first.size) > 1.5) break;
    const inHead = b.y - first.y <= 1.3 * b.size;                 // still on the header's rows: may open a new column
    if (b.segs.length >= 2) {
      if (inHead) b.segs.forEach((s) => addCol(s.x));
      const al = b.segs.filter((s) => cols.some((c) => Math.abs(c - s.x) <= 6)).length;
      if (al >= 2 || (al >= 1 && b.segs.length === cols.length)) { multi++; end = k; b.segs.forEach((s) => used.add(colOf(cols, s.x))); continue; }
      break;
    }
    const s = b.segs[0];
    if (inHead && b.marker === '') addCol(s.x);
    const ci = cols.findIndex((c) => Math.abs(c - s.x) <= 6);
    if (ci >= 0 && (ci === cols.length - 1 || s.x2 <= cols[ci + 1] - 2) && b.marker === '') { end = k; used.add(ci); continue; }   // single-cell line (wrapped or vertically centred cell text)
    break;
  }
  // a table needs 2 rows with 2+ cells, or a header plus lines that fill at least 2 different columns
  return multi >= 2 || (end >= j + 2 && used.size >= 2) ? { end, cols } : null;
}

// Rows are rebuilt column by column: in each column the lines are grouped into cells (a bigger vertical gap = next
// cell), then the cells of all columns that overlap vertically form one row. Wrapped cell text stays in its cell.
function tableBlock(L: Ln[], i: number, end: number, cols: number[]): Block {
  const run = L.slice(i, end + 1);
  type It = { c: number; y: number; size: number; bold: boolean; text: string };
  const items: It[] = [];
  run.forEach((l) => {
    const byCol = new Map<number, Seg[]>();
    l.segs.forEach((s) => { const c = colOf(cols, s.x); byCol.set(c, [...(byCol.get(c) || []), s]); });
    byCol.forEach((ss, c) => items.push({ c, y: l.y, size: l.size, bold: l.bold, text: ss.map((s) => s.text).join(' ') }));
  });
  // wrapped-line pitch = smallest gap between two lines of the same column
  const gaps: number[] = [];
  cols.forEach((_, c) => { const col = items.filter((t) => t.c === c); for (let k = 1; k < col.length; k++) { const g = col[k].y - col[k - 1].y; if (g > 0.5) gaps.push(g); } });
  const minG = gaps.length ? Math.min(...gaps) : 0, maxG = gaps.length ? Math.max(...gaps) : 0;
  const flat = !gaps.length || maxG < minG * 1.15;               // every cell is one line
  const hdrBold = run[0].bold && run.length > 1 && !run[1].bold;
  type Ch = { c: number; top: number; bot: number; parts: string[] };
  const chunks: Ch[] = [];
  cols.forEach((_, c) => {
    let cur: Ch | null = null, prev: It | null = null;
    items.filter((t) => t.c === c).forEach((t) => {
      const brk = !cur || !prev || flat || (t.y - prev.y) > minG * 1.35 || (hdrBold && prev.y === run[0].y && t.y !== run[0].y);
      if (brk) { cur = { c, top: t.y - t.size * 0.85, bot: t.y + t.size * 0.25, parts: [] }; chunks.push(cur); }
      const ch = cur as Ch;
      const last = ch.parts[ch.parts.length - 1];
      if (last !== undefined && GLUE.test(last)) ch.parts[ch.parts.length - 1] = last + t.text;   // "kidney/coffee-" + "bean"
      else ch.parts.push(t.text);
      ch.bot = t.y + t.size * 0.25;
      prev = t;
    });
  });
  chunks.sort((a, b) => a.top - b.top || a.c - b.c);
  const rows: string[][] = [];
  let rowBot = -1e9, cur: string[] = [];
  chunks.forEach((ch) => {
    if (!rows.length || ch.top > rowBot - 1) { cur = cols.map(() => ''); rows.push(cur); rowBot = ch.bot; }
    else rowBot = Math.max(rowBot, ch.bot);
    const t = ch.parts.join(' ');
    cur[ch.c] = cur[ch.c] ? cur[ch.c] + ' ' + t : t;
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

  // normal line pitch: the smallest vertical gap that is common between two body lines = a wrapped line.
  // (browsers and Word add a little more space between list items and a lot more between paragraphs)
  const hist = new Map<number, number>();
  let pn = 0;
  keep.forEach((L) => L.forEach((l, k) => {
    if (k && r05(l.size) === body && r05(L[k - 1].size) === body) { const g = l.y - L[k - 1].y; if (g > 0 && g < 2.6 * l.size) { const b = r05(g); hist.set(b, (hist.get(b) || 0) + 1); pn++; } }
  }));
  let g0 = body * 1.4;
  const hb = [...hist.keys()].sort((a, b) => a - b).find((b) => (hist.get(b) || 0) >= Math.max(3, pn * 0.05));
  if (hb !== undefined) g0 = hb + 0.25;
  const newPar = g0 * 1.1;           // a gap bigger than this starts a new item / paragraph

  // left margin of the text (smallest x that many lines share); lines indented from it are list items
  const xs = keep.flat().map((l) => l.x);
  let left = xs.length ? Math.min(...xs) : 0;
  [...new Set(xs.map((x) => Math.round(x)))].sort((a, b) => a - b).some((x) => { if (xs.filter((v) => Math.abs(v - x) <= 1.5).length >= 3) { left = x; return true; } return false; });

  const isHead = (l: Ln, prev: Ln | null) => {
    if (l.marker === 'bullet' || l.text.length < 2 || l.text.length > 140) return false;
    if (l.size >= body * 1.12) return true;
    const wc = l.text.split(/\s+/).length;
    // a bold-only line is a heading only at the left margin and with room above it - an all-bold wrapped line of a list item is not
    const room = !prev || l.y - prev.y > g0 * 1.25;
    return l.bold && l.segs.length === 1 && l.marker === '' && wc <= 14 && !/[.,;]$/.test(l.text) && l.x <= left + 6 && room;
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
      if (isHead(l, i ? L[i - 1] : null)) {
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
      if ((cur && prev && gap <= newPar && Math.abs(l.size - prev.size) < 1) || crossPage) {
        const t = (cur || blocks[blocks.length - 1]) as Extract<Block, { t: 'p' | 'li' }>;
        // a line that ends in "-" is cut at a real hyphen of the text (early-morning): keep it, drop only the space
        t.text = GLUE.test(t.text) ? t.text + l.text : t.text + ' ' + l.text;
        if (!cur) cur = t;
      } else if (l.x - left >= 8 && l.size <= body * 1.1) {
        cur = { t: 'li', text: l.text, page: p, mx: l.x, num: false };          // list item whose bullet is a drawn shape, not a character
        blocks.push(cur);
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
  bx.forEach((x) => { if (!bxc.length || x - bxc[bxc.length - 1] > 7) bxc.push(x); });
  const out: string[] = [];
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  for (const b of blocks) {
    if (b.t === 'h') out.push('', '#'.repeat(b.level) + ' ' + b.text.replace(/[:：]+$/, '').trim(), '');
    else if (b.t === 'p') out.push(b.text, '');
    else if (b.t === 'li') {
      const lv = b.num ? 0 : Math.max(0, bxc.findIndex((c, k) => b.mx >= c - 3 && (k === bxc.length - 1 || b.mx < bxc[k + 1] - 3)));
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
