import * as SQLite from 'expo-sqlite';
import type { Point } from './notes';

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
export async function addTopics(sourceId: number, topics: { name: string; body: string }[]) {
  const d = await db();
  await d.withTransactionAsync(async () => {
    for (const t of topics) {
      const r = await d.runAsync('INSERT INTO topics(source_id,name,body) VALUES(?,?,?)', [sourceId, t.name, t.body]);
      await d.runAsync('INSERT INTO fts(name,body,topic_id) VALUES(?,?,?)', [t.name, t.body, r.lastInsertRowId]);
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

// FR-2/FR-4: search across all sources; same-name topics from different books are merged
export async function findTopic(q: string) {
  const d = await db();
  const toks = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!toks.length) return null;
  const match = toks.map((t) => `"${t}"*`).join(' OR ');
  const rows = await d.getAllAsync<{ topic_id: number; name: string }>(
    'SELECT topic_id, name FROM fts WHERE fts MATCH ? ORDER BY bm25(fts,10.0,1.0) LIMIT 6', [match]);
  if (!rows.length) {
    const alts = await d.getAllAsync<{ name: string }>(
      'SELECT DISTINCT name FROM topics WHERE name LIKE ? LIMIT 3', [`%${toks[0].slice(0, 3)}%`]);
    return { id: 0, name: '', body: '', alts: alts.map((a) => a.name), found: false };
  }
  const best = rows[0];
  const same = await d.getAllAsync<{ body: string }>('SELECT body FROM topics WHERE lower(name)=lower(?)', [best.name]);
  const alts = [...new Set(rows.map((r) => r.name).filter((n) => n.toLowerCase() !== best.name.toLowerCase()))].slice(0, 3);
  return { id: best.topic_id, name: best.name, body: same.map((s) => s.body).join('\n'), alts, found: true };
}

export async function getNotes(topicId: number): Promise<Point[] | null> {
  const r = await (await db()).getFirstAsync<{ points_json: string }>('SELECT points_json FROM notes WHERE topic_id=?', [topicId]);
  return r ? JSON.parse(r.points_json) : null;
}
export async function saveNotes(topicId: number, pts: Point[]) {
  await (await db()).runAsync('INSERT OR REPLACE INTO notes VALUES(?,?,?)', [topicId, JSON.stringify(pts), Date.now()]);
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
