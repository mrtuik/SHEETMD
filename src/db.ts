import * as SQLite from 'expo-sqlite';
import type { Point } from './notes';
import { norm, excerpt } from './mdsplit';

type DB = SQLite.SQLiteDatabase;
let _p: Promise<DB> | null = null;

// One shared connection. The promise is cached, so two callers at start-up can never open the file twice
// (that race was orphaning a native handle -> "NativeDatabase.prepareAsync ... NullPointerException").
function openDb(): Promise<DB> {
  if (!_p) {
    _p = (async () => {
      const d = await SQLite.openDatabaseAsync('sheetmd.db');
      await d.execAsync(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, name TEXT, type TEXT, status TEXT, info TEXT);
        CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, source_id INTEGER, name TEXT, body TEXT);
        CREATE TABLE IF NOT EXISTS notes(topic_id INTEGER PRIMARY KEY, points_json TEXT, created_at INTEGER);
        CREATE TABLE IF NOT EXISTS session(id INTEGER PRIMARY KEY CHECK(id=1), topic_id INTEGER, point_n INTEGER, word_offset INTEGER, speed REAL, updated_at INTEGER);
        CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER);
        CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, chat_id INTEGER, who TEXT, text TEXT);
        CREATE INDEX IF NOT EXISTS msgs_chat ON msgs(chat_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, body, topic_id UNINDEXED);
      `);
      return d;
    })().catch((e) => { _p = null; throw e; });
  }
  return _p;
}
export const db = () => openDb();

// Every DB call goes through here: one at a time (no query can slip into another call's transaction),
// and if the native handle was lost it reconnects once and retries.
let chain: Promise<unknown> = Promise.resolve();
function run<T>(fn: (d: DB) => Promise<T>): Promise<T> {
  const job = chain.then(async () => {
    try { return await fn(await openDb()); }
    catch (e: any) {
      if (/NullPointer|prepareAsync|closed|released/i.test(String(e?.message || e))) {
        _p = null;
        return await fn(await openDb());
      }
      throw e;
    }
  });
  chain = job.catch(() => {});
  return job;
}

// Call once at app start: a source left "indexing" by a killed app is marked failed (its finished part stays usable).
export const cleanupStuck = () => run((d) => d.runAsync("UPDATE sources SET status='failed', info='interrupted - add again' WHERE status='indexing'"));

export type Source = { id: number; name: string; type: string; status: string; info: string };

export const addSource = (name: string, type: string, status = 'ready', info = '') => run(async (d) => {
  const r = await d.runAsync('INSERT INTO sources(name,type,status,info) VALUES(?,?,?,?)', [name, type, status, info]);
  return r.lastInsertRowId;
});
export const updateSource = (id: number, status: string, info: string) =>
  run((d) => d.runAsync('UPDATE sources SET status=?, info=? WHERE id=?', [status, info, id]));
export const addTopics = (sourceId: number, topics: { name: string; body: string; own?: string }[]) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    for (const t of topics) {
      const r = await d.runAsync('INSERT INTO topics(source_id,name,body) VALUES(?,?,?)', [sourceId, t.name, t.body]);
      await d.runAsync('INSERT INTO fts(name,body,topic_id) VALUES(?,?,?)', [norm(t.name), norm(t.own ?? t.body), r.lastInsertRowId]);
    }
  });
});
export const listSources = () => run((d) => d.getAllAsync<Source>('SELECT * FROM sources ORDER BY id DESC'));
export const removeSource = (id: number) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    const ids = 'SELECT id FROM topics WHERE source_id=?';
    await d.runAsync(`DELETE FROM fts WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync(`DELETE FROM notes WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync('DELETE FROM topics WHERE source_id=?', [id]);
    await d.runAsync('DELETE FROM sources WHERE id=?', [id]);
  });
});

// FR-2/FR-4: search across all sources. Topics whose NAME has every query word win; otherwise body match.
export const findTopic = (q: string) => run((d) => findTopicIn(d, q));
async function findTopicIn(d: DB, q: string) {
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
export const getNotes = (topicId: number): Promise<Point[] | null> => run(async (d) => {
  if (!topicId) return null;
  const r = await d.getFirstAsync<{ points_json: string }>('SELECT points_json FROM notes WHERE topic_id=?', [topicId]);
  if (!r) return null;
  try { const j = JSON.parse(r.points_json); return j && j.v === NOTES_V ? j.pts : null; } catch { return null; }
});
export const saveNotes = (topicId: number, pts: Point[]) => run(async (d) => {
  if (!topicId) return;
  await d.runAsync('INSERT OR REPLACE INTO notes VALUES(?,?,?)', [topicId, JSON.stringify({ v: NOTES_V, pts }), Date.now()]);
});
export const topicName = (id: number) => run(async (d) => {
  const r = await d.getFirstAsync<{ name: string }>('SELECT name FROM topics WHERE id=?', [id]);
  return r?.name ?? '';
});

// FR-7: session persistence
export const saveSession = (topicId: number, pointN: number, speed: number) =>
  run((d) => d.runAsync('INSERT OR REPLACE INTO session VALUES(1,?,?,?,?,?)', [topicId, pointN, 0, speed, Date.now()]));
export const loadSession = () =>
  run((d) => d.getFirstAsync<{ topic_id: number; point_n: number; speed: number }>('SELECT * FROM session WHERE id=1'));
export const clearSession = () => run((d) => d.runAsync('DELETE FROM session'));

// Chats (side panel): each chat is its own saved message list
export type Chat = { id: number; title: string; updated_at: number };
export const listChats = () => run((d) => d.getAllAsync<Chat>('SELECT id,title,updated_at FROM chats ORDER BY updated_at DESC, id DESC'));
export const newChat = () => run(async (d) => {
  const t = Date.now();
  const r = await d.runAsync('INSERT INTO chats(title,created_at,updated_at) VALUES(?,?,?)', ['New chat', t, t]);
  return r.lastInsertRowId;
});
export const deleteChat = (id: number) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    await d.runAsync('DELETE FROM msgs WHERE chat_id=?', [id]);
    await d.runAsync('DELETE FROM chats WHERE id=?', [id]);
  });
});
export const loadMsgs = (chatId: number) =>
  run((d) => d.getAllAsync<{ id: number; who: 'you' | 'app'; text: string }>('SELECT id,who,text FROM msgs WHERE chat_id=? ORDER BY id', [chatId]));
export const addMsg = (chatId: number, who: 'you' | 'app', text: string) => run(async (d) => {
  await d.runAsync('INSERT INTO msgs(chat_id,who,text) VALUES(?,?,?)', [chatId, who, text]);
  const first = await d.getFirstAsync<{ title: string }>('SELECT title FROM chats WHERE id=?', [chatId]);
  if (first?.title === 'New chat' && who === 'you') {
    await d.runAsync('UPDATE chats SET title=?, updated_at=? WHERE id=?', [text.trim().slice(0, 40) || 'New chat', Date.now(), chatId]);
  } else await d.runAsync('UPDATE chats SET updated_at=? WHERE id=?', [Date.now(), chatId]);
});
