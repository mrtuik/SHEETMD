// API keys live in the Android Keystore (expo-secure-store), never in the plain SQLite meta table.
// A key baked into an APK can be extracted, and so can a database file: Keystore is the only place that is not readable by backups / root-less dumps.
import * as SecureStore from 'expo-secure-store';
import { getMeta, delMeta } from './db';

const sk = (k: string) => 'sheetmd_' + k.replace(/[^A-Za-z0-9._-]/g, '_');   // SecureStore keys allow only [A-Za-z0-9._-]

export async function getSecret(k: string): Promise<string> {
  try { return ((await SecureStore.getItemAsync(sk(k))) || '').trim(); } catch { return ''; }
}
export async function setSecret(k: string, v: string): Promise<void> {
  try { if (v) await SecureStore.setItemAsync(sk(k), v); else await SecureStore.deleteItemAsync(sk(k)); } catch {}
}
// First launch after the update: a key still sitting in the old meta table is moved to SecureStore, then erased from the table.
// `legacy` = every old meta name this key was ever saved under (cloud.ts used cl_key_*, llm.ts used cloud_key_*).
export async function loadSecret(k: string, legacy: string[] = []): Promise<string> {
  let v = await getSecret(k);
  for (const old of [k, ...legacy]) {
    const o = ((await getMeta(old).catch(() => '')) || '').trim();
    if (!o) continue;
    if (!v) { v = o; await setSecret(k, v); }                  // keep the first key found, but still erase every old copy below
    await delMeta(old).catch(() => {});
  }
  return v;
}
