// Add files: .md / .txt / .pdf (text or scanned) / images / .zip  ->  topics in the database.
// PDFs and OCR text are turned into real topics (headings found automatically), so "topic X" reads only X.
import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { splitTopics, T } from './mdsplit';
import { addSource, updateSource, addTopics } from './db';
import * as P from './pdfnative';
import { structurePages, chunkPlain } from './pdfstruct';
import { parseWords, layoutPages, plainText, wordCount, Pg } from './pdflayout';
import { cleanOcr } from './ocrclean';

const ext = (n: string) => (n.split('.').pop() || '').toLowerCase();
const IMG = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);
const TXT = new Set(['md', 'markdown', 'txt', 'text']);
const kindOf = (n: string) => { const e = ext(n); return e === 'pdf' ? 'pdf' : e === 'zip' ? 'zip' : IMG.has(e) ? 'image' : TXT.has(e) ? 'text' : ''; };
const base = (n: string) => n.replace(/\.[^.]+$/, '');

type Say = (s: string) => Promise<void>;

function toTopics(name: string, md: string, headings: number): T[] {
  const t = headings >= 2 ? splitTopics(name, md) : [];
  if (t.length >= 2) return t;
  return chunkPlain(base(name), md.replace(/^#+\s+/gm, ''));   // no usable headings: small readable parts
}

async function readPdf(uri: string, name: string, say: Say): Promise<{ topics: T[]; pages: number; ocr: number }> {
  const count = await P.open(uri);
  const pgs: Pg[] = [];            // pages with word positions (new reader: headings, bullets, tables)
  const texts: string[] = [];      // plain text per page (fallback reader)
  let layout = P.hasWords();
  try {
    if (layout) {
      try {
        for (let s = 1; s <= count; s += 10) {
          const e = Math.min(count, s + 9);
          (await P.readWords(s, e)).forEach((r) => pgs.push(parseWords(r)));
          await say(`reading pages ${e}/${count}`);
        }
      } catch { layout = false; pgs.length = 0; }
    }
    if (!layout) {
      for (let s = 1; s <= count; s += 10) {
        const e = Math.min(count, s + 9);
        texts.push(...(await P.readPages(s, e)));
        await say(`reading pages ${e}/${count}`);
      }
    }
  } finally { await P.close().catch(() => {}); }

  // pages with (almost) no text are scans: OCR them, then repair the usual OCR slips
  const lenOf = (i: number) => (layout ? wordCount(pgs[i]) : texts[i].trim().length);
  const scan: number[] = [];
  for (let i = 0; i < count; i++) if (lenOf(i) < 40) scan.push(i);
  const ocrd = new Map<number, string>();
  for (let k = 0; k < scan.length; k++) {
    const i = scan[k];
    try { ocrd.set(i, await P.ocrPdfPage(uri, i + 1)); } catch { ocrd.set(i, ''); }
    await say(`OCR page ${k + 1}/${scan.length}`);
  }
  const plain = (i: number) => (layout ? plainText(pgs[i], i) : texts[i]);
  if (ocrd.size) {
    const whole = Array.from({ length: count }, (_, i) => (ocrd.has(i) ? ocrd.get(i)! : plain(i))).join('\n');
    ocrd.forEach((t, i) => { if (layout) pgs[i] = { w: pgs[i].w, h: pgs[i].h, words: [] }; texts[i] = cleanOcr(t, whole); });
  }

  if (layout) {
    // text pages -> layout reader; scanned pages -> OCR text. Consecutive pages of one kind are read together.
    const parts: string[] = [];
    let heads = 0;
    let i = 0;
    while (i < count) {
      const isScan = ocrd.has(i);
      let j = i;
      while (j + 1 < count && ocrd.has(j + 1) === isScan) j++;
      if (isScan) { const r = structurePages(texts.slice(i, j + 1)); parts.push(r.md); heads += r.headings; }
      else { const r = layoutPages(pgs.slice(i, j + 1)); parts.push(r.md); heads += r.headings; }
      i = j + 1;
    }
    if (heads >= 2) return { topics: toTopics(name, parts.join('\n\n'), heads), pages: count, ocr: ocrd.size };
    // flat PDF (one font, no headings): the older text-based heading guesser
    const flat = Array.from({ length: count }, (_, k) => (ocrd.has(k) ? texts[k] : plainText(pgs[k], k)));
    const r = structurePages(flat);
    return { topics: toTopics(name, r.md, r.headings), pages: count, ocr: ocrd.size };
  }
  const { md, headings } = structurePages(texts);
  return { topics: toTopics(name, md, headings), pages: count, ocr: ocrd.size };
}

async function readImage(uri: string, name: string): Promise<T[]> {
  const t = cleanOcr(await P.ocrImage(uri));
  const { md, headings } = structurePages([t]);
  return toTopics(name, md, headings);
}

const b64Write = async (name: string, b64: string) => {
  const path = `${FS.cacheDirectory}zip_${Date.now()}_${name.replace(/[^\w.\-]+/g, '_')}`;
  await FS.writeAsStringAsync(path, b64, { encoding: FS.EncodingType.Base64 });
  return path;
};

async function importOne(a: { name: string; uri: string }, say: Say): Promise<{ topics: T[]; info: string }> {
  const k = kindOf(a.name);
  if (k === 'text') {
    const text = await FS.readAsStringAsync(a.uri, { encoding: FS.EncodingType.UTF8 });
    return { topics: splitTopics(a.name, text), info: '' };
  }
  if (k === 'pdf') {
    const r = await readPdf(a.uri, a.name, say);
    return { topics: r.topics, info: `${r.pages} pages${r.ocr ? `, ${r.ocr} scanned` : ''}` };
  }
  if (k === 'image') return { topics: await readImage(a.uri, a.name), info: 'image (OCR)' };
  if (k === 'zip') {
    const b64 = await FS.readAsStringAsync(a.uri, { encoding: FS.EncodingType.Base64 });
    const zip = await JSZip.loadAsync(b64, { base64: true });
    const files = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name) && kindOf(f.name) && kindOf(f.name) !== 'zip');
    const all: T[] = [];
    let n = 0;
    for (const f of files) {
      n++;
      await say(`zip ${n}/${files.length}: ${f.name.split('/').pop()}`);
      const short = f.name.split('/').pop() || f.name;
      if (kindOf(f.name) === 'text') { all.push(...splitTopics(short, await f.async('string'))); continue; }
      const path = await b64Write(short, await f.async('base64'));
      try {
        const r = await importOne({ name: short, uri: path }, async () => {});
        all.push(...r.topics);
      } finally { FS.deleteAsync(path, { idempotent: true }).catch(() => {}); }
    }
    return { topics: all, info: `${files.length} files` };
  }
  throw new Error('Unsupported file type');
}

export async function pickAndImport(onChange: () => void, chatId: number): Promise<string | void> {
  let res: Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>;
  try { res = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true }); }
  catch (e: any) { throw new Error('file picker: ' + (e?.message || e)); }
  if (res.canceled || !res.assets?.length) return;
  const done: string[] = [];
  for (const a of res.assets) {
    const k = kindOf(a.name);
    if (!k) { done.push(`${a.name}: unsupported type`); continue; }
    let id: number;
    try { id = await addSource(a.name, k, 'indexing', 'starting', chatId); }
    catch (e: any) { throw new Error('database: ' + (e?.message || e)); }
    onChange();
    const say: Say = async (s) => { await updateSource(id, 'indexing', s); onChange(); };
    try {
      const { topics, info } = await importOne({ name: a.name, uri: a.uri }, say);
      if (!topics.length) { await updateSource(id, 'failed', 'no readable text found'); done.push(`${a.name}: no readable text`); }
      else {
        await say('saving topics');
        for (let i = 0; i < topics.length; i += 20) { await addTopics(id, topics.slice(i, i + 20)); await new Promise((r) => setTimeout(r, 0)); }   // small chunks + a breath between them: search / mic stay responsive while a big file is saved
        await updateSource(id, 'ready', `${topics.length} topics${info ? ' · ' + info : ''}`);
        done.push(`${a.name}: ${topics.length} topics`);
      }
    } catch (e: any) {
      await updateSource(id, 'failed', String(e?.message || e).slice(0, 80));
      done.push(`${a.name}: failed - ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      FS.deleteAsync(a.uri, { idempotent: true }).catch(() => {});
      onChange();
    }
  }
  return done.join('\n');
}
