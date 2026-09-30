import * as FS from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import JSZip from 'jszip';
import { addSource, addTopics, updateSource } from './db';
import * as Pdf from './pdfnative';
import { splitTopics } from './mdsplit';

const TEXT = /\.(md|txt)$/i, PDF = /\.pdf$/i, IMG = /\.(jpe?g|png)$/i;
type T = { name: string; body: string; own?: string };

// ---- PDF heading detection + streaming splitter (works page by page, so any size) ----
function isHeading(l: string) {
  const t = l.trim(), words = t.split(/\s+/).length;
  if (t.length < 3 || t.length > 70 || /[.,;]$/.test(t)) return false;
  if (/^(chapter|unit|lesson|section)\s+[\dIVXivx]+/i.test(t)) return true;
  if (/^\d+(\.\d+)+[.)]?\s+\S/.test(t) && words <= 10) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && t === t.toUpperCase() && words <= 8;
}
function joinLines(lines: string[]) {
  const out: string[] = [];
  for (const l of lines) {
    if (!l) { out.push(''); continue; }
    const prev = out[out.length - 1];
    if (prev === undefined || prev === '' || /^([-•▪*]|\d+[.)])\s/.test(l)) out.push(l);
    else if (/[A-Za-z]-$/.test(prev)) out[out.length - 1] = prev.slice(0, -1) + l;
    else out[out.length - 1] = prev + ' ' + l;
  }
  return out.filter(Boolean).join('\n');
}
class Splitter {
  ready: T[] = [];
  title: string; name: string; part = 1; body: string[] = []; len = 0;
  constructor(base: string) { this.title = base; this.name = base; }
  feed(text: string) {
    for (const raw of text.replace(/\r/g, '').split('\n')) {
      const l = raw.trim();
      if (/^\d{1,4}$/.test(l)) continue;              // page numbers
      if (l && isHeading(l)) { this.flush(); this.title = this.name = l; this.part = 1; continue; }
      this.body.push(l); this.len += l.length;
      if (this.len > 5000 && /[.!?।]$/.test(l)) { this.flush(); this.name = `${this.title} (part ${++this.part})`; }
    }
  }
  flush() {
    const b = joinLines(this.body);
    if (b.length > 20) this.ready.push({ name: this.name, body: b });
    this.body = []; this.len = 0;
  }
  drain() { const r = this.ready; this.ready = []; return r; }
}

async function importPdf(name: string, uri: string, tick: () => void) {
  const id = await addSource(name, 'pdf', 'indexing', '0%');
  try {
    const total = await Pdf.open(uri);
    const sp = new Splitter(name.replace(/\.[^.]+$/, ''));
    let ocr = 0;
    for (let p = 1; p <= total; p += 8) {
      const end = Math.min(p + 7, total);
      const pages = await Pdf.readPages(p, end);
      for (let i = 0; i < pages.length; i++) {
        let t = pages[i];
        if (t.trim().length < 30) { try { t = await Pdf.ocrPdfPage(uri, p + i); ocr++; } catch {} }  // scanned page
        sp.feed(t);
      }
      await addTopics(id, sp.drain());               // topics usable while the rest is still indexing
      await updateSource(id, 'indexing', `${Math.round((end / total) * 100)}%`);
      tick();
    }
    sp.flush(); await addTopics(id, sp.drain());
    await updateSource(id, 'ready', `${total} pages` + (ocr ? `, ${ocr} OCR (low quality)` : ''));
  } catch (e: any) {
    await updateSource(id, 'failed', String(e?.message || e).slice(0, 60));
  } finally { try { await Pdf.close(); } catch {} tick(); }
}

async function importImage(name: string, uri: string) {
  const id = await addSource(name, 'image', 'indexing', 'OCR…');
  try {
    const text = await Pdf.ocrImage(uri);
    const topics = splitTopics(name, text);
    await addTopics(id, topics.length ? topics : [{ name: name.replace(/\.[^.]+$/, ''), body: text }]);
    await updateSource(id, 'ready', 'OCR (low quality)');
  } catch (e: any) { await updateSource(id, 'failed', String(e?.message || e).slice(0, 60)); }
}

async function indexText(name: string, text: string, type: string) {
  const id = await addSource(name, type, 'indexing');
  const topics = splitTopics(name, text);
  await addTopics(id, topics);
  await updateSource(id, 'ready', `${topics.length} topics`);
}

export async function pickAndImport(tick: () => void = () => {}): Promise<string> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, type: '*/*', copyToCacheDirectory: true });
  if (res.canceled) return '';
  let ok = 0, bad = 0;
  for (const a of res.assets) {
    const n = a.name;
    try {
      if (TEXT.test(n)) await indexText(n, await FS.readAsStringAsync(a.uri), 'text');
      else if (PDF.test(n)) await importPdf(n, a.uri, tick);
      else if (IMG.test(n)) await importImage(n, a.uri);
      else if (/\.zip$/i.test(n)) {
        const zip = await JSZip.loadAsync(await FS.readAsStringAsync(a.uri, { encoding: FS.EncodingType.Base64 }), { base64: true });
        for (const [p, f] of Object.entries(zip.files)) {
          if (f.dir) continue;
          if (TEXT.test(p)) await indexText(p, await f.async('string'), 'zip');
          else if (PDF.test(p) || IMG.test(p)) {
            const tmp = FS.cacheDirectory + 'z_' + Date.now() + '_' + p.split('/').pop();
            await FS.writeAsStringAsync(tmp, await f.async('base64'), { encoding: FS.EncodingType.Base64 });
            PDF.test(p) ? await importPdf(p, tmp, tick) : await importImage(p, tmp);
            await FS.deleteAsync(tmp, { idempotent: true });
          } else continue;
          ok++;
        }
        continue;
      } else { await addSource(n, 'unsupported', 'skipped', 'unsupported type'); bad++; continue; }
      ok++;
    } catch (e: any) { await addSource(n, 'error', 'failed', String(e?.message || e).slice(0, 60)); bad++; }
    await FS.deleteAsync(a.uri, { idempotent: true }).catch(() => {});   // text is indexed; free the cache copy
    tick();
  }
  return `${ok} imported` + (bad ? `, ${bad} failed` : '');
}
