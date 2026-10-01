import * as SQLite from 'expo-sqlite';
import type { Point } from './notes';
import { norm, focus, excerpt, GENERIC } from './mdsplit';
import { gramQuery, words } from './fuzzy';
import { queryTokens, expandAbbr, variants, rankTopics, decide, isQuestionName, isQuestionBody, stripQuestions, covers, isJunkHeading } from './match';

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
      // each chat owns its sources (old databases get the column added; old sources are adopted by adoptOldSources)
      try { await d.execAsync('ALTER TABLE sources ADD COLUMN chat_id INTEGER'); } catch {}
      await d.execAsync('CREATE INDEX IF NOT EXISTS src_chat ON sources(chat_id)');
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

export const addSource = (name: string, type: string, status = 'ready', info = '', chatId = 0) => run(async (d) => {
  const r = await d.runAsync('INSERT INTO sources(name,type,status,info,chat_id) VALUES(?,?,?,?,?)', [name, type, status, info, chatId || null]);
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
// only the sources of ONE chat
export const listSources = (chatId: number) => run((d) => d.getAllAsync<Source>('SELECT * FROM sources WHERE chat_id=? ORDER BY id DESC', [chatId]));
// sources that belong to no chat yet (added before chats owned sources) go to the OLDEST chat
export const adoptOldSources = () => run(async (d) => {
  const c = await d.getFirstAsync<{ id: number }>('SELECT id FROM chats ORDER BY created_at ASC, id ASC LIMIT 1');
  if (c) await d.runAsync('UPDATE sources SET chat_id=? WHERE chat_id IS NULL', [c.id]);
});

// removes topics + notes + both search indexes (+ a saved session) of the given sources
const SRC_OF_CHAT = 'SELECT id FROM sources WHERE chat_id=?';
async function wipe(d: DB, srcSql: string, args: (number | string)[]) {
  const tids = `SELECT id FROM topics WHERE source_id IN (${srcSql})`;
  await d.runAsync(`DELETE FROM fts WHERE topic_id IN (${tids})`, args);
  if (triOk) await d.runAsync(`DELETE FROM fts_tri WHERE topic_id IN (${tids})`, args);
  await d.runAsync(`DELETE FROM notes WHERE topic_id IN (${tids})`, args);
  await d.runAsync(`DELETE FROM session WHERE topic_id IN (${tids})`, args);
  await d.runAsync(`DELETE FROM topics WHERE source_id IN (${srcSql})`, args);
}
const shrink = async (d: DB) => { try { await d.execAsync('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); } catch {} };   // give the storage back

export const removeSource = (id: number) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    await wipe(d, 'SELECT ?', [id]);
    await d.runAsync('DELETE FROM sources WHERE id=?', [id]);
  });
  await shrink(d);
});

// Search order (per chat): 1) topic NAME (typo / abbreviation / synonym / sound-alike tolerant)  2) topic BODY.
//  - sure about the name -> that topic; unsure -> the top 3 names (kind 'pick'); nothing close -> body search
//  - MCQ / question chunks are never returned (hard filter), and the chunk must really contain the query words
export type Found = { kind: 'ok' | 'pick' | 'none'; found: boolean; id: number; name: string; body: string; alts: string[]; options?: string[] };
const none = (alts: string[] = []): Found => ({ kind: 'none', found: false, id: 0, name: '', body: '', alts });

export const findTopic = (q: string, chatId: number, exact = false) => run((d) => findTopicIn(d, q, chatId, exact));

// "exact <name>": finds ONE topic by its HEADING (no body search, no model) and returns its full, unfiltered text.
//  1) same heading  2) same heading without "Topic 1:" / "(brackets)"  3) every spoken word is in the heading
//  4) sound-alike / typo match on the heading names. Unsure -> the closest names to choose from.
const nz = (s: string) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const canon = (s: string) => nz(s.replace(/\([^)]*\)/g, ' ').replace(/^\s*(?:topic|chapter|unit|lesson|part)?\s*\d+\s*[:.)\-\u2013]\s*/i, ' '));
export const findExact = (q: string, chatId: number, strict = false) => run(async (d): Promise<Found> => {
  const scope = "JOIN sources s ON s.id = t.source_id WHERE s.chat_id = ? AND s.status = 'ready'";
  const rows = await d.getAllAsync<{ id: number; name: string }>(`SELECT t.id AS id, t.name AS name FROM topics t ${scope} ORDER BY t.id`, [chatId]);
  const ok = async (r: { id: number; name: string }): Promise<Found> => {
    const body = (await nameBody(d, r.id, r.name)).trim();
    return body.length ? { kind: 'ok', found: true, id: r.id, name: r.name, body, alts: [] } : none();
  };
  const want = q.trim();
  if (!want || !rows.length) return none();
  const exactRow = rows.find((r) => r.name.toLowerCase() === want.toLowerCase());
  if (exactRow) return ok(exactRow);
  if (strict) return none();
  const a = nz(want), c = canon(want);
  const same = rows.find((r) => nz(r.name) === a) || (c && rows.find((r) => canon(r.name) === c));
  if (same) return ok(same);
  const qw = words(a);
  const uniq = (list: { id: number; name: string }[]) => {
    const seen = new Set<string>();
    return list.filter((r) => (seen.has(r.name.toLowerCase()) ? false : (seen.add(r.name.toLowerCase()), true)));
  };
  if (qw.length) {
    const hit = uniq(rows.filter((r) => { const nw = words(nz(r.name)); return qw.every((w) => nw.some((x) => x === w || (w.length >= 4 && x.startsWith(w)))); }))
      .sort((x, y) => x.name.length - y.name.length);
    if (hit.length === 1) return ok(hit[0]);
    if (hit.length > 1) return { kind: 'pick', found: false, id: 0, name: '', body: '', alts: hit.slice(0, 3).map((x) => x.name), options: hit.slice(0, 3).map((x) => x.name) };
  }
  const toks = queryTokens(want);
  if (!toks.length) return none();
  const ranked = rankTopics(toks, rows);
  const dec = decide(ranked);
  if (dec.kind === 'auto' && dec.top) return ok(dec.top);
  if (dec.kind === 'options') return { kind: 'pick', found: false, id: 0, name: '', body: '', alts: dec.options, options: dec.options };
  return none(dec.options);
});
type Row = { topic_id: number; name: string };

async function nameBody(d: DB, id: number, name: string): Promise<string> {
  // same-name parts of the SAME file are joined
  const same = await d.getAllAsync<{ body: string }>(
    'SELECT body FROM topics WHERE lower(name)=lower(?) AND source_id=(SELECT source_id FROM topics WHERE id=?) ORDER BY id', [name, id]);
  return same.map((x) => x.body).join('\n');
}

async function findTopicIn(d: DB, q: string, chatId: number, exact: boolean): Promise<Found> {
  const scope = 'JOIN sources s ON s.id = t.source_id WHERE s.chat_id = ? AND s.status = \'ready\'';
  if (exact) {                                               // the user tapped / said one of the 3 options
    const r = await d.getFirstAsync<{ id: number; name: string }>(`SELECT t.id AS id, t.name AS name FROM topics t ${scope} AND lower(t.name)=lower(?) ORDER BY t.id LIMIT 1`, [chatId, q]);
    if (!r) return none();
    const body = stripQuestions(await nameBody(d, r.id, r.name));
    return body.length > 20 && !isQuestionBody(body) ? { kind: 'ok', found: true, id: r.id, name: r.name, body, alts: [] } : none();
  }

  const toks = queryTokens(q);
  if (!toks.length) return none();

  // 1) name match
  const names = await d.getAllAsync<{ id: number; name: string }>(`SELECT t.id AS id, t.name AS name FROM topics t ${scope}`, [chatId]);
  const ranked = rankTopics(toks, names);
  const dec = decide(ranked);
  if (dec.kind === 'options') return { kind: 'pick', found: false, id: 0, name: '', body: '', alts: dec.options, options: dec.options };
  if (dec.kind === 'auto' && dec.top) {
    const body = stripQuestions(await nameBody(d, dec.top.id, dec.top.name));
    if (body.length > 20 && !isQuestionBody(body) && covers(toks, dec.top.name + '\n' + body)) {
      return { kind: 'ok', found: true, id: dec.top.id, name: dec.top.name, body, alts: ranked.slice(1, 4).map((x) => x.name) };
    }
  }

  // 2) body match (words + typo-tolerant trigrams), question chunks filtered out
  const ex = expandAbbr(toks);
  const ftsToks = [...new Set([...toks, ...ex].filter((t) => t.length >= 2))];
  const wordMatch = ftsToks.map((t) => `"${t}"*`).join(' OR ');
  let rows: Row[] = [];
  try {
    rows = await d.getAllAsync<Row>(
      `SELECT fts.topic_id AS topic_id, t.name AS name FROM fts JOIN topics t ON t.id = fts.topic_id JOIN sources s ON s.id = t.source_id
       WHERE fts MATCH ? AND s.chat_id = ? AND s.status = 'ready' ORDER BY bm25(fts,10.0,1.0) LIMIT 30`, [wordMatch, chatId]);
  } catch {}
  let fuzzy: Row[] = [];
  const gq = gramQuery(ftsToks);
  if (triOk && gq) {
    try {
      fuzzy = await d.getAllAsync<Row>(
        `SELECT fts_tri.topic_id AS topic_id, t.name AS name FROM fts_tri JOIN topics t ON t.id = fts_tri.topic_id JOIN sources s ON s.id = t.source_id
         WHERE fts_tri MATCH ? AND s.chat_id = ? AND s.status = 'ready' ORDER BY bm25(fts_tri,20.0,1.0) LIMIT 40`, [gq, chatId]);
    } catch {}
  }
  const seen = new Set<number>();
  const cands = [...rows, ...fuzzy].filter((r) => !isQuestionName(r.name) && (seen.has(r.topic_id) ? false : (seen.add(r.topic_id), true))).slice(0, 16);

  // 2b) GATHER from the sources: everything the books say about the topic, from every chunk that really talks about it.
  //  - a section whose HEADING is the topic            -> strong (whole section)
  //  - a paragraph that names the topic 2+ times       -> medium (that paragraph + the next one)
  //  - one passing mention (e.g. "lymphocytes ... in meningitis") is NOT the topic and is ignored
  const hard = ex.filter((t) => t.length >= 3);
  const stem = (t: string) => (t.length >= 7 ? t.slice(0, t.length - 3) : t);
  const stems = (hard.length ? hard : ex).map(stem);
  const hits = (para: string): number => {
    const w = words(norm(para));
    let n = 0;
    for (const x of w) if (stems.some((st) => x.startsWith(st))) n++;
    return n;
  };
  const allHave = (para: string) => { const w = words(norm(para)); return stems.every((st) => w.some((x) => x.startsWith(st))); };
  type Piece = { name: string; text: string; score: number };
  const pieces: Piece[] = [];
  for (const c of cands) {
    await new Promise((r) => setTimeout(r, 0));                 // let the screen / mic breathe between heavy steps
    const one = await d.getFirstAsync<{ name: string; body: string }>('SELECT name, body FROM topics WHERE id=?', [c.topic_id]);
    if (!one || isQuestionBody(one.body)) continue;
    const part = excerpt(one.body, ex);
    if (part && (covers(toks, part.name) || covers(ex, part.name))) {
      const body = stripQuestions(part.body);
      if (body.length >= 20 && !isQuestionBody(body)) {
        const nm = isJunkHeading(part.name) ? one.name : GENERIC.has(part.name.toLowerCase()) ? `${one.name} - ${part.name}` : part.name;
        pieces.push({ name: nm, text: body, score: 100 + Math.min(body.length, 3000) / 100 });
        continue;
      }
    }
    const paras = stripQuestions(one.body).split(/\n\s*\n|\n(?=#{1,6}\s)/).map((x) => x.trim()).filter(Boolean);
    const take = new Set<number>();
    let total = 0;
    paras.forEach((p, i) => { if (allHave(p)) { const n = hits(p); total += n; if (n >= 2) { take.add(i); if (i + 1 < paras.length) take.add(i + 1); } } });
    if (take.size) pieces.push({ name: isJunkHeading(one.name) ? 'Source' : one.name, text: [...take].sort((x, y) => x - y).map((i) => paras[i]).join('\n\n'), score: total });
  }
  if (pieces.length) {
    pieces.sort((x, y) => y.score - x.score);
    const picked: Piece[] = [];
    let size = 0;
    for (const p of pieces) { if (size >= 7000) break; picked.push(p); size += p.text.length; }
    const body = picked.map((p) => p.text).join('\n\n').slice(0, 9000);
    const strong = picked.find((p) => p.score >= 100);
    const nm = strong ? strong.name : ex.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
    return { kind: 'ok', found: true, id: 0, name: nm, body, alts: ranked.slice(0, 3).map((x) => x.name) };   // id 0 = do not cache
  }
  return none([...new Set([...dec.options, ...ranked.slice(0, 3).map((x) => x.name)])].slice(0, 3));
}

// Best source excerpts for a QUESTION (this chat's sources only; MCQ / question chunks are never used)
export const searchSources = (q: string, chatId: number, limit = 3) => run(async (d) => {
  const out: { name: string; body: string }[] = [];
  const toks = queryTokens(q);
  if (!toks.length || !chatId) return out;
  const ex = expandAbbr(toks);
  const ftsToks = [...new Set([...toks, ...ex].filter((t) => t.length >= 3))];
  if (!ftsToks.length) return out;
  let rows: Row[] = [];
  try {
    rows = await d.getAllAsync<Row>(
      `SELECT fts.topic_id AS topic_id, t.name AS name FROM fts JOIN topics t ON t.id = fts.topic_id JOIN sources s ON s.id = t.source_id
       WHERE fts MATCH ? AND s.chat_id = ? AND s.status = 'ready' ORDER BY bm25(fts,10.0,1.0) LIMIT 12`, [ftsToks.map((t) => `"${t}"*`).join(' OR '), chatId]);
  } catch {}
  const gq = gramQuery(ftsToks);
  if (triOk && gq) {
    try {
      rows = rows.concat(await d.getAllAsync<Row>(
        `SELECT fts_tri.topic_id AS topic_id, t.name AS name FROM fts_tri JOIN topics t ON t.id = fts_tri.topic_id JOIN sources s ON s.id = t.source_id
         WHERE fts_tri MATCH ? AND s.chat_id = ? AND s.status = 'ready' ORDER BY bm25(fts_tri,20.0,1.0) LIMIT 12`, [gq, chatId]));
    } catch {}
  }
  const seen = new Set<number>();
  for (const r of rows) {
    if (out.length >= limit) break;
    if (seen.has(r.topic_id) || isQuestionName(r.name)) continue;
    seen.add(r.topic_id);
    const one = await d.getFirstAsync<{ name: string; body: string }>('SELECT name, body FROM topics WHERE id=?', [r.topic_id]);
    if (!one || isQuestionBody(one.body)) continue;
    const text = stripQuestions(focus(one.body, ex).body);
    if (text.length < 30 || isQuestionBody(text)) continue;
    out.push({ name: isJunkHeading(one.name) ? 'Source' : one.name, body: text });
  }
  return out;
});

const NOTES_V = 3;   // bump when the notes format changes: old cached notes are rebuilt
// mode 'llm' wants smart notes for the same marks; mode 'rule' accepts whatever is cached
export const getNotes = (topicId: number, mode: 'rule' | 'llm' = 'rule', marks = 5): Promise<Point[] | null> => run(async (d) => {
  if (!topicId) return null;
  const r = await d.getFirstAsync<{ points_json: string }>('SELECT points_json FROM notes WHERE topic_id=?', [topicId]);
  if (!r) return null;
  try {
    const j = JSON.parse(r.points_json);
    if (!j || j.v !== NOTES_V) return null;
    if (mode === 'llm' && !(j.mode === 'llm' && j.marks === marks)) return null;
    return j.pts;
  } catch { return null; }
});
export const saveNotes = (topicId: number, pts: Point[], mode: 'rule' | 'llm' = 'rule', marks = 0) => run(async (d) => {
  if (!topicId) return;
  await d.runAsync('INSERT OR REPLACE INTO notes VALUES(?,?,?)', [topicId, JSON.stringify({ v: NOTES_V, mode, marks, pts }), Date.now()]);
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
// deleting a chat deletes EVERYTHING it owns: messages, sources, topics, notes, search index
export const deleteChat = (id: number) => run(async (d) => {
  await d.withTransactionAsync(async () => {
    await wipe(d, SRC_OF_CHAT, [id]);
    await d.runAsync('DELETE FROM sources WHERE chat_id=?', [id]);
    await d.runAsync('DELETE FROM msgs WHERE chat_id=?', [id]);
    await d.runAsync('DELETE FROM chats WHERE id=?', [id]);
  });
  await shrink(d);
});
export const renameChat = (id: number, title: string) =>
  run((d) => d.runAsync('UPDATE chats SET title=? WHERE id=?', [title.trim().slice(0, 60) || 'New chat', id]));
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
