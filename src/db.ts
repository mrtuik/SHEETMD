import * as SQLite from 'expo-sqlite';
import type { Point } from './notes';
import { norm, excerpt } from './mdsplit';

let _db: SQLite.SQLiteDatabase | null = null;
export async function db() {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('sheetmd.db');
  await _db.execAsync(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, name TEXT, type TEXT, status TEXT, info TEXT);
    CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, source_id INTEGER, name TEXT, body TEXT);
    CREATE TABLE IF NOT EXISTS notes(topic_id INTEGER PRIMARY KEY, points_json TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS session(id INTEGER PRIMARY KEY CHECK(id=1), topic_id INTEGER, point_n INTEGER, word_offset INTEGER, speed REAL, updated_at INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, body, topic_id UNINDEXED);
  `);
  return _db;
}

export type Source = { id: number; name: string; type: string; status: string; info: string };

export async function addSource(name: string, type: string, status = 'ready', info = '') {
  const d = await db();
  const r = await d.runAsync('INSERT INTO sources(name,type,status,info) VALUES(?,?,?,?)', [name, type, status, info]);
  return r.lastInsertRowId;
}
export async function updateSource(id: number, status: string, info: string) {
  await (await db()).runAsync('UPDATE sources SET status=?, info=? WHERE id=?', [status, info, id]);
}
export async function addTopics(sourceId: number, topics: { name: string; body: string; own?: string }[]) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    for (const t of topics) {
      const r = await d.runAsync('INSERT INTO topics(source_id,name,body) VALUES(?,?,?)', [sourceId, t.name, t.body]);
      await d.runAsync('INSERT INTO fts(name,body,topic_id) VALUES(?,?,?)', [norm(t.name), norm(t.own ?? t.body), r.lastInsertRowId]);
    }
  });
}
export async function listSources() {
  return (await db()).getAllAsync<Source>('SELECT * FROM sources ORDER BY id DESC');
}
export async function removeSource(id: number) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    const ids = 'SELECT id FROM topics WHERE source_id=?';
    await d.runAsync(`DELETE FROM fts WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync(`DELETE FROM notes WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync('DELETE FROM topics WHERE source_id=?', [id]);
    await d.runAsync('DELETE FROM sources WHERE id=?', [id]);
  });
}

// FR-2/FR-4: search across all sources. Topics whose NAME has every query word win; otherwise body match.
export async function findTopic(q: string) {
  const d = await db();
  const toks = norm(q).match(/[\p{L}\p{N}]+/gu) || [];
  if (!toks.length) return null;
  const match = toks.map((t) => `"${t}"*`).join(' OR ');
  const rows = await d.getAllAsync<{ topic_id: number; name: string }>(
    'SELECT fts.topic_id AS topic_id, t.name AS name FROM fts JOIN topics t ON t.id = fts.topic_id WHERE fts MATCH ? ORDER BY bm25(fts,10.0,1.0) LIMIT 30', [match]);
  if (!rows.length) {
    const alts = await d.getAllAsync<{ name: string }>(
      'SELECT DISTINCT name FROM topics WHERE name LIKE ? LIMIT 3', [`%${toks[0].slice(0, 3)}%`]);
    return { id: 0, name: '', body: '', alts: alts.map((a) => a.name), found: false };
  }
  const hit = (n: string) => toks.filter((t) => norm(n).includes(t)).length;
  rows.sort((a, b) => {
    const x = hit(a.name), y = hit(b.name);
    if (x !== y) return y - x;
    return x === toks.length ? a.name.length - b.name.length : 0;
  });
  const best = rows[0];
  const alts = [...new Set(rows.map((r) => r.name).filter((n) => n.toLowerCase() !== best.name.toLowerCase()))].slice(0, 3);
  const same = await d.getAllAsync<{ body: string }>('SELECT body FROM topics WHERE lower(name)=lower(?)', [best.name]);
  const body = same.map((s) => s.body).join('\n');
  if (hit(best.name) < toks.length) {            // matched through the text of a big file: read only the relevant part
    const ex = excerpt(body, toks);
    if (ex) return { id: 0, name: ex.name, body: ex.body, alts, found: true };   // id 0 = do not cache
  }
  return { id: best.topic_id, name: best.name, body, alts, found: true };
}

const NOTES_V = 2;   // bump when the notes format changes: old cached notes are rebuilt
export async function getNotes(topicId: number): Promise<Point[] | null> {
  if (!topicId) return null;
  const r = await (await db()).getFirstAsync<{ points_json: string }>('SELECT points_json FROM notes WHERE topic_id=?', [topicId]);
  if (!r) return null;
  try { const j = JSON.parse(r.points_json); return j && j.v === NOTES_V ? j.pts : null; } catch { return null; }
}
export async function saveNotes(topicId: number, pts: Point[]) {
  if (!topicId) return;
  await (await db()).runAsync('INSERT OR REPLACE INTO notes VALUES(?,?,?)', [topicId, JSON.stringify({ v: NOTES_V, pts }), Date.now()]);
}
export async function topicName(id: number) {
  const r = await (await db()).getFirstAsync<{ name: string }>('SELECT name FROM topics WHERE id=?', [id]);
  return r?.name ?? '';
}

// FR-7: session persistence
export async function saveSession(topicId: number, pointN: number, speed: number) {
  await (await db()).runAsync('INSERT OR REPLACE INTO session VALUES(1,?,?,?,?,?)', [topicId, pointN, 0, speed, Date.now()]);
}
export async function loadSession() {
  return (await db()).getFirstAsync<{ topic_id: number; point_n: number; speed: number }>('SELECT * FROM session WHERE id=1');
}
