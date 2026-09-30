import * as SQLite from 'expo-sqlite';
import type { Point } from './notes';
import { norm, focus, GENERIC } from './mdsplit';
import { words, textScore, gramQuery } from './fuzzy';

type DB = SQLite.SQLiteDatabase;
let _p: Promise<DB> | null = null;
let triOk = false;

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
        CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, body, topic_id UNINDEXED);
      `);
      // Typo-tolerant index (FTS5 trigram tokenizer, built into SQLite on the phone - nothing to download).
      // Filled from the existing `fts` table once, so sources added earlier do NOT need to be added again.
      try {
        await d.execAsync("CREATE VIRTUAL TABLE IF NOT EXISTS fts_tri USING fts5(name, body, topic_id UNINDEXED, tokenize='trigram')");
        const have = await d.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM fts_tri');
        const old = await d.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM fts');
        if (!have?.n && old?.n) await d.execAsync('INSERT INTO fts_tri(name, body, topic_id) SELECT name, body, topic_id FROM fts');
        triOk = true;
      } catch { triOk = false; }
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
      const nm = norm(t.name), bd = norm(t.own ?? t.body);
      await d.runAsync('INSERT INTO fts(name,body,topic_id) VALUES(?,?,?)', [nm, bd, r.lastInsertRowId]);
      if (triOk) await d.runAsync('INSERT INTO fts_tri(name,body,topic_id) VALUES(?,?,?)', [nm, bd, r.lastInsertRowId]);
    }
  });
});
export const listSources = () => run((d) => d.getAllAsync<Source>('SELECT * FROM sources ORDER BY id DESC'));
export const removeSource = (id: number) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    const ids = 'SELECT id FROM topics WHERE source_id=?';
    await d.runAsync(`DELETE FROM fts WHERE topic_id IN (${ids})`, [id]);
    if (triOk) await d.runAsync(`DELETE FROM fts_tri WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync(`DELETE FROM notes WHERE topic_id IN (${ids})`, [id]);
    await d.runAsync('DELETE FROM topics WHERE source_id=?', [id]);
    await d.runAsync('DELETE FROM sources WHERE id=?', [id]);
  });
});

// FR-2/FR-4: search across all sources, then read ONLY what was asked for.
//  1. word search (exact + prefix) and typo-tolerant trigram search give candidate topics
//  2. a topic whose NAME matches the query wins -> that topic (with its sub-sections) is read
//  3. otherwise the best body match is narrowed down to the matching section / paragraph (focus) - never the whole file
export const findTopic = (q: string) => run((d) => findTopicIn(d, q));
type Row = { topic_id: number; name: string };
async function findTopicIn(d: DB, q: string) {
  const toks = words(norm(q));
  if (!toks.length) return null;

  const wordMatch = toks.map((t) => `"${t}"*`).join(' OR ');
  let rows: Row[] = [];
  try {
    rows = await d.getAllAsync<Row>(
      'SELECT fts.topic_id AS topic_id, t.name AS name FROM fts JOIN topics t ON t.id = fts.topic_id WHERE fts MATCH ? ORDER BY bm25(fts,10.0,1.0) LIMIT 30', [wordMatch]);
  } catch {}
  let fuzzy: Row[] = [];
  const gq = gramQuery(toks);
  if (triOk && gq) {
    try {
      fuzzy = await d.getAllAsync<Row>(
        'SELECT fts_tri.topic_id AS topic_id, t.name AS name FROM fts_tri JOIN topics t ON t.id = fts_tri.topic_id WHERE fts_tri MATCH ? ORDER BY bm25(fts_tri,20.0,1.0) LIMIT 40', [gq]);
    } catch {}
  }

  const seen = new Set<number>();
  const cands = [...rows, ...fuzzy].filter((r) => (seen.has(r.topic_id) ? false : (seen.add(r.topic_id), true)));
  if (!cands.length) {
    const alts = await d.getAllAsync<{ name: string }>('SELECT DISTINCT name FROM topics WHERE name LIKE ? LIMIT 3', [`%${toks[0].slice(0, 3)}%`]);
    return { id: 0, name: '', body: '', alts: alts.map((a) => a.name), found: false };
  }

  // name score: how well does the topic NAME cover the query words (typos allowed)?
  const scored = cands.map((r) => ({ r, s: textScore(toks, norm(r.name)) }));
  scored.sort((a, b) => (b.s - a.s) || (a.r.name.length - b.r.name.length));
  const top = scored[0];
  const alts = (list: { r: Row }[], not: string) =>
    [...new Set(list.map((x) => x.r.name).filter((n) => n.toLowerCase() !== not.toLowerCase()))].slice(0, 3);

  if (top.s >= 0.72) {
    // name matches: read that topic (same-name parts of the SAME file are joined)
    const best = top.r;
    const same = await d.getAllAsync<{ body: string }>(
      'SELECT body FROM topics WHERE lower(name)=lower(?) AND source_id=(SELECT source_id FROM topics WHERE id=?) ORDER BY id', [best.name, best.topic_id]);
    const body = same.map((x) => x.body).join('\n');
    return { id: best.topic_id, name: best.name, body, alts: alts(scored, best.name), found: true };
  }

  // body match: the first word-search hit, else the best typo-tolerant hit - narrowed to the asked part only
  const pick = rows[0] ?? scored.find((x) => x.s >= 0.5)?.r ?? fuzzy[0];
  if (!pick) return { id: 0, name: '', body: '', alts: alts(scored, ''), found: false };
  const one = await d.getFirstAsync<{ name: string; body: string }>('SELECT name, body FROM topics WHERE id=?', [pick.topic_id]);
  if (!one) return { id: 0, name: '', body: '', alts: alts(scored, ''), found: false };
  const ex = focus(one.body, toks);
  // a hit inside "Principle" / "Procedure" is shown under its topic's name
  const nm = GENERIC.has(ex.name.toLowerCase()) ? `${one.name} - ${ex.name}` : ex.name === toks.join(' ') ? one.name : ex.name;
  return { id: 0, name: nm, body: ex.body, alts: alts(scored, nm), found: true };   // id 0 = do not cache
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

// Small key/value settings (e.g. the chosen voice)
export const getMeta = (k: string) => run(async (d) => (await d.getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k=?', [k]))?.v ?? '');
export const setMeta = (k: string, v: string) => run((d) => d.runAsync('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', [k, v]));
