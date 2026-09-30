import * as FS from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import JSZip from 'jszip';
import { addSource, addTopics, updateSource } from './db';

const TEXT = /\.(md|txt)$/i;

export function splitTopics(fileName: string, text: string) {
  const isH = (l: string) => /^#{1,3}\s+\S/.test(l) || /^(chapter|unit|lesson)\s+\d+/i.test(l.trim());
  const res: { name: string; body: string[] }[] = [];
  let cur: { name: string; body: string[] } | null = null;
  for (const l of text.replace(/\r/g, '').split('\n')) {
    if (isH(l)) { if (cur) res.push(cur); cur = { name: l.replace(/^#+\s*/, '').trim(), body: [] }; }
    else { if (!cur) cur = { name: fileName.replace(/\.[^.]+$/, ''), body: [] }; cur.body.push(l); }
  }
  if (cur) res.push(cur);
  return res.map((r) => ({ name: r.name, body: r.body.join('\n').trim() })).filter((r) => r.body.length > 20);
}

async function indexText(name: string, text: string, type: string) {
  const id = await addSource(name, type, 'indexing');
  const topics = splitTopics(name, text);
  await addTopics(id, topics);
  await updateSource(id, 'ready', `${topics.length} topics`);
}

export async function pickAndImport(): Promise<string> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, type: '*/*', copyToCacheDirectory: true });
  if (res.canceled) return '';
  let ok = 0, skipped = 0;
  for (const a of res.assets) {
    const n = a.name;
    if (TEXT.test(n)) {
      await indexText(n, await FS.readAsStringAsync(a.uri), 'text'); ok++;
    } else if (/\.zip$/i.test(n)) {
      const b64 = await FS.readAsStringAsync(a.uri, { encoding: FS.EncodingType.Base64 });
      const zip = await JSZip.loadAsync(b64, { base64: true });
      for (const [p, f] of Object.entries(zip.files)) {
        if (f.dir) continue;
        if (TEXT.test(p)) { await indexText(p, await f.async('string'), 'zip'); ok++; }
        else skipped++;
      }
    } else {
      await addSource(n, 'unsupported', 'skipped', 'PDF/image OCR not added yet'); skipped++;
    }
  }
  return `${ok} imported` + (skipped ? `, ${skipped} skipped (PDF/image not supported yet)` : '');
}
