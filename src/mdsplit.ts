// Splits a .md/.txt file into topics. A heading's topic includes all of its sub-headings,
// so "topic hemoglobin estimation" reads Principle, Procedure, tables... together.
import { stripMarkdown } from './cleaner';
import { textScore, words } from './fuzzy';

export type T = { name: string; body: string; own?: string };

export const norm = (s: string) => s.toLowerCase().replace(/ae/g, 'e');   // haemoglobin == hemoglobin

const HEAD = /^\s{0,3}(#{1,6})\s+(\S.*?)\s*#*\s*$/;
const CHAP = /^(chapter|unit|lesson)\s+\d+/i;
const BOLD = /^\s*\*\*([^*\n]{2,80}?)\*\*:?\s*$/;

export const GENERIC = new Set(`definition,introduction,intro,principle,principles,parts,part,procedure,procedures,method,methods,steps,requirements,reagents,specimen,
normal values,normal range,reference range,interpretation,uses,applications,advantages,disadvantages,merits,demerits,limitations,precautions,sources of error,errors,
causes,features,clinical features,symptoms,signs,diagnosis,treatment,management,complications,examples,example,summary,conclusion,types,classification,morphology,
indications,contraindications,significance,clinical significance,comparison,difference,differences,mechanism,working,note,notes,tips,mnemonic,mnemonics,
important points,key points,short note,diagram,flow chart,table`.split(',').map((x) => x.trim()));

export const headName = (s: string) =>
  stripMarkdown(s).replace(/^\d+[.)]\s+/, '').replace(/[:：]+$/, '').trim();

export function splitTopics(fileName: string, text: string): T[] {
  const lines = text.replace(/\r/g, '').split('\n');
  type H = { i: number; level: number; name: string };
  const hs: H[] = [];
  let fence = false;
  const hasHash = lines.some((l) => HEAD.test(l));
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    let m = l.match(HEAD);
    if (m) { hs.push({ i, level: m[1].length, name: headName(m[2]) }); return; }
    if (CHAP.test(l.trim())) { hs.push({ i, level: 1, name: l.trim() }); return; }
    if (!hasHash && (m = l.match(BOLD))) hs.push({ i, level: 7, name: headName(m[1]) });
  });

  const res: T[] = [];
  const base = fileName.replace(/\.[^.]+$/, '');
  const first = hs.length ? hs[0].i : lines.length;
  const pre = lines.slice(0, first).join('\n').trim();
  if (pre.length > 20) res.push({ name: base, body: pre });

  // generic sub-sections (Principle, Procedure...) are not topics: they stay inside their parent
  const skip = hs.map((h, k) => {
    const leaf = !hs[k + 1] || hs[k + 1].level <= h.level;
    const parent = hs.slice(0, k).some((p) => p.level < h.level);
    const nm = h.name.toLowerCase();
    return leaf && parent && (GENERIC.has(nm) || nm.startsWith('explain'));
  });

  hs.forEach((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < hs.length; j++) if (hs[j].level <= h.level) { end = hs[j].i; break; }
    // own text = up to the next heading that is itself a topic, so text under skipped sub-sections stays searchable
    let nextAny = lines.length;
    for (let j = k + 1; j < hs.length; j++) if (!skip[j]) { nextAny = hs[j].i; break; }
    const body = lines.slice(h.i + 1, end).join('\n').trim();
    const own = lines.slice(h.i + 1, nextAny).join('\n').trim();
    if (skip[k]) return;
    if (body.length > 20 && h.name) res.push({ name: h.name, body, own });
  });
  return res;
}

// Pulls out ONLY the part about the query from a big body (a PDF, or a file without headings).
// 1) a heading / title-like line that contains every query word -> that section, up to the next heading
// 2) otherwise the best matching paragraph and a little after it
// Never returns the whole body.
const MAX_CHARS = 6000;

export function excerpt(body: string, toks: string[]): { name: string; body: string } | null {
  const lines = body.replace(/\r/g, '').split('\n');
  const isHead = (l: string) => HEAD.test(l) || BOLD.test(l);
  const cand = (l: string) => {
    const t = l.trim();
    if (!t || t.length > 100) return false;
    return textScore(toks, norm(t)) >= 0.8;
  };
  let at = lines.findIndex((l) => cand(l) && (isHead(l) || !/[.!?]$/.test(l.trim())));
  if (at < 0) return null;
  const hm = lines[at].match(HEAD);
  const level = hm ? hm[1].length : 7;
  let end = Math.min(lines.length, at + 80);
  for (let j = at + 1; j < end; j++) {
    const m = lines[j].match(HEAD);
    if ((m && m[1].length <= level) || (!hm && BOLD.test(lines[j]))) { end = j; break; }
  }
  const out = lines.slice(at + 1, end).join('\n').trim().slice(0, MAX_CHARS);
  const name = headName(hm ? hm[2] : lines[at]);
  return out.length > 20 && name ? { name, body: out } : null;
}

export function focus(body: string, toks: string[]): { name: string; body: string } {
  const ex = excerpt(body, toks);
  if (ex) return ex;
  const lines = body.replace(/\r/g, '').split('\n');
  // paragraphs: blank-line separated; a wall of lines (PDF text) is cut into windows of 10 lines
  let paras: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (!l.trim()) { if (cur.length) { paras.push(cur.join('\n')); cur = []; } continue; }
    cur.push(l);
    if (cur.length >= 10) { paras.push(cur.join('\n')); cur = []; }
  }
  if (cur.length) paras.push(cur.join('\n'));
  paras = paras.filter((p) => p.trim());
  if (!paras.length) return { name: toks.join(' '), body: body.slice(0, MAX_CHARS) };

  let best = 0, bestS = -1;
  paras.forEach((p, i) => {
    const n = norm(p);
    let s = textScore(toks, n);
    const w = words(n);
    const freq = toks.reduce((a, t) => a + w.filter((x) => x.startsWith(t)).length, 0);
    s += Math.min(freq, 6) * 0.05;
    if (s > bestS) { bestS = s; best = i; }
  });

  // start one paragraph earlier when it is a short title-like line, then read forward
  let from = best;
  if (from > 0 && paras[from - 1].length < 90 && !/[.!?]$/.test(paras[from - 1].trim())) from--;
  let out = '';
  let to = from;
  while (to < paras.length && (out.length + paras[to].length < MAX_CHARS || to === from)) {
    const ph = paras[to].split('\n')[0];
    if (to > best && (HEAD.test(ph) || BOLD.test(ph))) break;   // next section starts
    out += (out ? '\n\n' : '') + paras[to];
    to++;
  }
  const first = paras[from].split('\n')[0].replace(/^\s*#+\s*/, '').trim();
  const name = first.length <= 80 && !/[.!?]$/.test(first) ? headName(first) : toks.join(' ');
  return { name: name || toks.join(' '), body: out };
}
