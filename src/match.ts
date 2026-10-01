// Topic matching for voice / typed queries + chunk filters.
//  - queryTokens: "u t i" -> "uti", filler words removed
//  - rankTopics: typo / abbreviation / synonym / sound-alike tolerant ("urinary track infection" -> "Urinary tract infection (UTI)")
//  - decide: auto-pick when confident, else the top 3 options (user taps or says "one / two / three")
//  - isQuestionName / isQuestionBody / stripQuestions: MCQ and question chunks are never read or sent to the model
//  - isJunkHeading: figure captions and sentence-like OCR lines are not topic headings
//  - covers: does the chunk really contain the query words? (checked before any answer)
import { norm } from './mdsplit';
import { words, wordScore } from './fuzzy';

const FILLER = new Set(`topic,topics,about,tell,me,please,on,of,the,explain,read,note,notes,mark,marks,number,short,long,answer,define,what,is,are,in,for,to,and,give,show,open,find,search,টপিক`.split(','));

export const ABBR: Record<string, string> = {
  uti: 'urinary tract infection', cbc: 'complete blood count', esr: 'erythrocyte sedimentation rate', rbc: 'red blood cell',
  wbc: 'white blood cell', hb: 'hemoglobin', pcv: 'packed cell volume', mcv: 'mean corpuscular volume', tlc: 'total leucocyte count',
  dlc: 'differential leucocyte count', bt: 'bleeding time', ct: 'clotting time', pt: 'prothrombin time', aptt: 'activated partial thromboplastin time',
  inr: 'international normalized ratio', lft: 'liver function test', rft: 'renal function test', kft: 'kidney function test',
  ogtt: 'oral glucose tolerance test', gtt: 'glucose tolerance test', tb: 'tuberculosis', afb: 'acid fast bacilli', hiv: 'human immunodeficiency virus',
  elisa: 'enzyme linked immunosorbent assay', pcr: 'polymerase chain reaction', csf: 'cerebrospinal fluid', dm: 'diabetes mellitus',
  mi: 'myocardial infarction', dic: 'disseminated intravascular coagulation', itp: 'immune thrombocytopenic purpura', sgot: 'aspartate aminotransferase',
  sgpt: 'alanine aminotransferase', alp: 'alkaline phosphatase', ldh: 'lactate dehydrogenase', tft: 'thyroid function test',
  vdrl: 'venereal disease research laboratory', mp: 'malaria parasite', rf: 'rheumatoid factor', crp: 'c reactive protein', ana: 'antinuclear antibody',
  hba1c: 'glycosylated hemoglobin', sti: 'sexually transmitted infection', aids: 'acquired immunodeficiency syndrome', ecg: 'electrocardiogram',
};

const SYN_GROUPS = [
  ['kidney', 'renal', 'nephro'], ['heart', 'cardiac', 'cardio'], ['liver', 'hepatic', 'hepato'], ['lung', 'pulmonary', 'respiratory'],
  ['stomach', 'gastric'], ['urine', 'urinary', 'urin'], ['blood', 'hematology', 'hemato'], ['sugar', 'glucose'], ['fever', 'pyrexia'],
  ['cancer', 'carcinoma', 'malignancy', 'neoplasm'], ['stone', 'calculi', 'calculus', 'lithiasis'], ['tract', 'track'], ['cell', 'cells'],
  ['bile', 'biliary'], ['thyroid', 'thyroxine'], ['bone', 'skeletal'], ['sputum', 'phlegm'], ['stool', 'faeces', 'feces'],
];
const ALT = new Map<string, string[]>();
SYN_GROUPS.forEach((g) => g.forEach((w) => ALT.set(w, g)));

// --- sound-alike key: "track" ~ "tract", "phosphate" ~ "fosfate" -------------------------------------------------
const PKC = new Map<string, string>();               // speed: each word's key is computed once
const pk = (w: string): string => {
  const c = PKC.get(w);
  if (c !== undefined) return c;
  const r = pk0(w);
  if (PKC.size > 20000) PKC.clear();
  PKC.set(w, r);
  return r;
};
const pk0 = (w: string): string => {
  const s = w.toLowerCase()
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's').replace(/kn/g, 'n').replace(/wr/g, 'r').replace(/gh/g, '').replace(/(.)\1+/g, '$1');
  return (s[0] || '') + s.slice(1).replace(/[aeiouyhw]/g, '');
};
const lev1 = (a: string, b: string) => {          // true if edit distance <= 1
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
};
const phon = (a: string, w: string): number => {
  if (a.length < 3 || w.length < 3) return 0;
  const ka = pk(a), kw = pk(w);
  if (ka === kw) return 0.88;
  return ka.length >= 4 && kw.length >= 4 && lev1(ka, kw) ? 0.78 : 0;   // short words: only identical sound keys count ("urin" must not match "urti")
};
// edit-distance closeness of two LONG words (7+ letters): "institution" ~ "estimation", "hemoglobin" ~ "hemoglobn"
const lev = (a: string, b: string): number => {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
};
const longNear = (a: string, w: string): number => {
  if (a.length < 7 || w.length < 7 || Math.abs(a.length - w.length) > 3) return 0;
  const r = 1 - lev(a, w) / Math.max(a.length, w.length);
  return r >= 0.55 ? 0.7 : 0;
};
const score1 = (q: string, w: string) => Math.max(wordScore(q, w), phon(q, w), longNear(q, w));

// words that may be missing from a name without changing what the topic is ("... tract infection")
const SOFT = new Set(['infection', 'infections', 'disease', 'diseases', 'syndrome', 'test', 'tests', 'tract', 'cell', 'cells', 'count', 'disorder', 'disorders']);

// --- query ---------------------------------------------------------------------------------------------------------
export function queryTokens(q: string): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => { if (run) { out.push(run); run = ''; } };
  for (const w of words(norm(q))) {
    if (/^[a-z]$/.test(w)) run += w; else { flush(); out.push(w); }          // "u t i" -> "uti"
  }
  flush();
  return out.filter((w) => !FILLER.has(w) && !/^\d+$/.test(w));
}

// variants of the query: as spoken, and with abbreviations written out
export function variants(toks: string[]): string[][] {
  const v: string[][] = [toks];
  if (toks.some((t) => ABBR[t])) v.push(toks.flatMap((t) => (ABBR[t] ? words(ABBR[t]) : [t])));
  return v;
}
export const expandAbbr = (toks: string[]) => variants(toks)[variants(toks).length - 1];

const alts = (t: string) => ALT.get(t) || [t];
const STOPN = new Set(['of', 'and', 'the', 'in', 'to', 'a', 'an', 'for', 'with', 'by', 'on']);

function nameWordsOf(name: string): string[] {
  const w = words(norm(name));
  const core = w.filter((x) => !STOPN.has(x));
  const acr = core.length >= 3 ? core.map((x) => x[0]).join('') : '';
  return acr ? [...w, acr] : w;
}

function scoreName(toks: string[], nw: string[]): number {
  if (!toks.length || !nw.length) return 0;
  if (toks.length >= 3 && nw.includes(toks.map((t) => t[0]).join(''))) return 1;      // "urinary tract infection" == "UTI"
  let sum = 0, hit = 0, miss = false;
  for (const t of toks) {
    let best = 0;
    for (const a of alts(t)) for (const w of nw) { const s = score1(a, w); if (s > best) best = s; if (best === 1) break; }
    sum += best; if (best >= 0.7) hit++;
    if (best < 0.7 && !SOFT.has(t) && t.length >= 3) miss = true;          // a distinctive word of the query is not in this name
  }
  if (!hit) return 0;
  const qcov = sum / toks.length;
  const core = nw.filter((x) => !STOPN.has(x));
  let nhit = 0;
  for (const w of core) if (toks.some((t) => alts(t).some((a) => score1(a, w) >= 0.7))) nhit++;
  const ncov = core.length ? Math.min(1, nhit / core.length) : 0;
  const sc = 0.85 * qcov + 0.15 * ncov;
  return miss ? Math.min(sc, 0.45) : sc;
}

export type Ranked = { id: number; name: string; score: number };

export function rankTopics(toks: string[], list: { id: number; name: string }[]): Ranked[] {
  const vs = variants(toks);
  const best = new Map<string, Ranked>();
  for (const t of list) {
    if (isQuestionName(t.name) || isJunkHeading(t.name)) continue;
    const nw = nameWordsOf(t.name);
    let s = 0;
    for (const v of vs) s = Math.max(s, scoreName(v, nw));
    if (s <= 0) continue;
    const key = t.name.toLowerCase();
    const cur = best.get(key);
    if (!cur || s > cur.score) best.set(key, { id: t.id, name: t.name, score: s });
  }
  return [...best.values()].sort((a, b) => (b.score - a.score) || (a.name.length - b.name.length));
}

export type Decision = { kind: 'auto' | 'options' | 'none'; top?: Ranked; options: string[] };
export function decide(r: Ranked[]): Decision {
  if (!r.length || r[0].score < 0.5) return { kind: 'none', options: r.slice(0, 3).filter((x) => x.score >= 0.3).map((x) => x.name) };
  const top = r[0], second = r[1]?.score ?? 0;
  if (top.score >= 0.95 || (top.score >= 0.82 && top.score - second >= 0.08)) return { kind: 'auto', top, options: [] };
  const floor = Math.max(0.5, top.score - 0.3);
  return { kind: 'options', top, options: r.filter((x) => x.score >= floor).slice(0, 3).map((x) => x.name) };
}

// --- MCQ / question chunks -----------------------------------------------------------------------------------------
const QNAME = /\b(mcqs?|multiple choice|questions?|quiz|practice|exercises?|viva|previous year|pyq|question bank|answer key|solved papers?)\b/i;
export const isQuestionName = (n: string) => QNAME.test(n);

const Q_LINE = /^\s*(?:q\.?\s*\d+|\d+\s*[.)])\s+.{6,}\?\s*$/i;
const Q_LINE2 = /^\s*q\.?\s*\d*\s*[.:)]\s+.{6,}$/i;
const OPT_LINE = /^\s*\(?[a-d][.)]\s+\S/i;
const ANS_LINE = /^\s*(ans(wer)?|correct (answer|option))\s*[:.)\-–]/i;

export function isQuestionBody(body: string): boolean {
  const ls = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (ls.length < 4) return false;
  let q = 0;
  for (const l of ls) if (Q_LINE.test(l) || Q_LINE2.test(l) || OPT_LINE.test(l) || ANS_LINE.test(l)) q++;
  return q / ls.length >= 0.4;
}

// removes question blocks (question line + its a/b/c/d options + answer line); ordinary a) b) lists stay
export function stripQuestions(body: string): string {
  const out: string[] = [];
  let inQ = false;
  for (const l of body.split('\n')) {
    const t = l.trim();
    if (Q_LINE.test(t) || Q_LINE2.test(t)) { inQ = true; continue; }
    if (ANS_LINE.test(t)) { inQ = false; continue; }
    if (inQ && OPT_LINE.test(t)) continue;
    if (t) inQ = false;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// --- junk OCR headings ---------------------------------------------------------------------------------------------
export function isJunkHeading(name: string): boolean {
  const t = name.trim();
  if (t.length < 3) return true;
  const w = t.split(/\s+/);
  if (/^(fig(ure)?|table|plate|chart|image|photo(graph)?|diagram|graph|box|scheme|slide)\.?\s*[\divx]+/i.test(t)) return true;   // "Fig 3.2 ..."
  if (/^(fig|figure)\b\s*[.:]/i.test(t)) return true;
  if (w.length >= 11) return true;                                          // a sentence, not a title
  if (/[.,;]$/.test(t) && w.length >= 4) return true;
  if (/^[a-z]/.test(t) && w.length >= 5) return true;
  if (w.length >= 6 && /\b(is|are|was|were|shows?|showing|seen|observed|has|have|can be|may be|will)\b/i.test(t)) return true;
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters / t.length < 0.6) return true;
  if ((t.match(/\d/g) || []).length / t.length > 0.3) return true;
  if (/(.)\1{3,}/.test(t) || /[|=_~]/.test(t)) return true;
  if (w.length >= 3 && w.filter((x) => x.length === 1).length / w.length >= 0.4) return true;
  return false;
}

// --- does the text really talk about the query? ---------------------------------------------------------------------
// Whole words (or word starts for longer words). Every distinctive query word must be present; only soft words
// ("infection", "tract"...) may be missing. "uti" is NOT found inside "solution" any more.
export function covers(toks: string[], text: string): boolean {
  if (!toks.length) return true;
  const t = norm(text);
  const uniq = [...new Set(words(t))];
  const set = new Set(uniq);
  const has = (tok: string): number => {
    for (const a of alts(tok)) {
      if (set.has(a)) return 1;
      if (a.length >= 5) for (const w of uniq) if (w.startsWith(a) || (a.length >= 6 && w.includes(a))) return 1;
    }
    let best = 0;
    for (const a of alts(tok)) {
      for (const w of uniq) {
        if (Math.abs(w.length - a.length) > 3) continue;
        const s = score1(a, w);
        if (s > best) best = s;
        if (best >= 0.85) return best;
      }
    }
    return best;
  };
  const ok = (list: string[]) => {
    const hard = list.filter((x) => !SOFT.has(x));
    const use = hard.length ? hard : list;
    return use.every((x) => has(x) >= 0.7);
  };
  return variants(toks).some(ok);
}
