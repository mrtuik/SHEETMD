// Splits a .md/.txt file into topics. A heading's topic includes all of its sub-headings,
// so "topic hemoglobin estimation" reads Principle, Procedure, tables... together.
import { stripMarkdown } from './cleaner';

export type T = { name: string; body: string; own?: string };

export const norm = (s: string) => s.toLowerCase().replace(/ae/g, 'e');   // haemoglobin == hemoglobin

const HEAD = /^\s{0,3}(#{1,6})\s+(\S.*?)\s*#*\s*$/;
const CHAP = /^(chapter|unit|lesson)\s+\d+/i;
const BOLD = /^\s*\*\*([^*\n]{2,80}?)\*\*:?\s*$/;

const GENERIC = new Set(`definition,introduction,intro,principle,principles,parts,part,procedure,procedures,method,methods,steps,requirements,reagents,specimen,
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

  hs.forEach((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < hs.length; j++) if (hs[j].level <= h.level) { end = hs[j].i; break; }
    const nextAny = hs[k + 1] ? hs[k + 1].i : lines.length;
    const body = lines.slice(h.i + 1, end).join('\n').trim();
    const own = lines.slice(h.i + 1, nextAny).join('\n').trim();
    const leaf = !hs[k + 1] || hs[k + 1].level <= h.level;
    const parent = hs.slice(0, k).some((p) => p.level < h.level);
    const nm = h.name.toLowerCase();
    if (leaf && parent && (GENERIC.has(nm) || nm.startsWith('explain'))) return;   // sub-section, stays inside its parent topic
    if (body.length > 20 && h.name) res.push({ name: h.name, body, own });
  });
  return res;
}

// File without headings: pull out just the part about the query.
export function excerpt(body: string, toks: string[]): { name: string; body: string } | null {
  const lines = body.replace(/\r/g, '').split('\n');
  const isHead = (l: string) => HEAD.test(l) || BOLD.test(l);
  const cand = (l: string) => {
    const t = l.trim();
    if (!t || t.length > 100) return false;
    const n = norm(t);
    return toks.every((k) => n.includes(k));
  };
  let at = lines.findIndex((l) => cand(l) && (isHead(l) || !/[.!?]$/.test(l.trim())));
  if (at < 0) at = lines.findIndex(cand);
  if (at < 0) return null;
  const hm = lines[at].match(HEAD);
  const level = hm ? hm[1].length : 7;
  let end = Math.min(lines.length, at + 80);
  for (let j = at + 1; j < end; j++) {
    const m = lines[j].match(HEAD);
    if ((m && m[1].length <= level) || (!hm && BOLD.test(lines[j]))) { end = j; break; }
  }
  const out = lines.slice(at + 1, end).join('\n').trim();
  const name = headName(hm ? hm[2] : lines[at]);
  return out.length > 20 && name ? { name, body: out } : null;
}
