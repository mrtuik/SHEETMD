import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, StyleSheet, ScrollView, Pressable, Switch,
  Platform, PermissionsAndroid, StatusBar, Linking, Image, Keyboard, Alert, useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import { parse, parsePick, isGreeting, stripChoiceEcho, OK_END, CANCEL_Q } from './src/commands';
import { queryTokens } from './src/match';
import { makeNotes, Point } from './src/notes';
import { exactPoints } from './src/exact';
import { splitSentences } from './src/cleaner';
import * as R from './src/reader';
import {
  findTopic, findExact, getNotes, saveNotes, listSources, removeSource, loadSession, clearSession, topicName, cleanupStuck, searchSources,
  listChats, newChat, deleteChat, renameChat, adoptOldSources, loadMsgs, addMsg, getMeta, setMeta, Source, Chat,
} from './src/db';
import { llm, initLlm, subscribeLlm, startDownload, pauseDownload, cancelDownload, llmNotes, llmExplain, llmAnswer, cancelGen, splitMarks, MODELS, Basis } from './src/llm';
import { wikiLookup } from './src/web';
import { loadVoices, voicesFor, bestFor, Vc } from './src/voice';
import { pickAndImport } from './src/importer';
import { startListening, stopListening, restartListening, markHandled } from './src/listener';
import { updateService, stopService, onServiceAction } from './src/service';
import { ICONS, IconName } from './src/icons';
import {
  VOICES, ttsState, subscribeTts, initTts, startVoiceDownload,
  pauseVoiceDownload, cancelVoiceDownload, deleteVoice, selectVoice, setTtsEngine,
  speak, stopSpeak, DEFAULT_VOICE_ID,
} from './src/tts';

type Msg = { id: number; who: 'you' | 'app'; text: string };
const TOPIC = '\u2063T\u2063';                  // hidden marker: this reply is a topic card
const CHOICE = '\u2063C\u2063';                 // hidden marker: this reply is the "did you mean" list (top 3 topics)

const C = { bg: '#FFFFFF', surf: '#F6F6F5', bd: '#E4E4E2', tx: '#0A0A0A', sec: '#737373', acc: '#0A0A0A', on: '#4338ca', ok: '#16a34a', bad: '#dc2626', dis: '#EDEDEB', disI: '#A3A3A3' };
const LANG_LABEL = { auto: 'Auto', en: 'English', bn: 'Bangla' } as const;
const COMMANDS: [string, string][] = [
  ['topic <name>', 'Read that topic from your sources, point by point'],
  ['exact <name>', 'Read that topic word for word from its heading to the next heading (fast, no AI)'],
  ['explain <name>', 'Explain it from my own knowledge + web (not your sources)'],
  ['question ... okay', 'Say "question", then your full question, then "okay": I think, use your sources, add my own knowledge'],
  ['pause  /  continue', 'Hold, or carry on from the same sentence'],
  ['next  /  previous', 'Jump to the next or earlier point'],
  ['repeat  /  repeat 3', 'Read this point (or point 3) again'],
  ['slower  /  faster', 'Change the reading speed'],
  ['stop', 'Stop reading'],
];

const Icon = ({ n, size = 22, color = C.tx, style }: { n: IconName; size?: number; color?: string; style?: any }) => (
  <Image source={ICONS[n]} style={[{ width: size, height: size, tintColor: color }, style]} resizeMode="contain" />
);

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

function Main() {
  const ins = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const sheetMax = Math.max(220, Math.round(winH * 0.88) - 150 - ins.bottom);   // scroll area of a bottom sheet: real pixels, so it always scrolls to the end
  const rootRef = useRef<View>(null);
  const [kbPad, setKbPad] = useState(0);
  useEffect(() => {
    // bottom padding = exactly how much of the screen the keyboard covers, so the input sits right on top of it
    const a = Keyboard.addListener('keyboardDidShow', (e) => {
      rootRef.current?.measureInWindow((_x, y, _w, h) => setKbPad(Math.max(0, Math.round(y + h - e.endCoordinates.screenY))));
    });
    const b = Keyboard.addListener('keyboardDidHide', () => setKbPad(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const [showSet, setShowSet] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState(0);
  const chatRef = useRef(0);
  const [listening, setListening] = useState(false);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [renameText, setRenameText] = useState('');
  const [smart, setSmartOn] = useState(true);
  const [working, setWorking] = useState('');
  const [asking, setAsking] = useState(false);
  const qRef = useRef<{ parts: string[]; timer: any } | null>(null);   // a spoken question being dictated (ends with "okay")
  const choicesRef = useRef<string[] | null>(null);        // the 3 options waiting for a tap / "one, two, three"
  const choiceMarks = useRef(5);
  const choiceExact = useRef(false);            // the 3 options belong to an "exact" request
  const choiceSpeaking = useRef(false);
  const [heard, setHeard] = useState('');                  // last thing the mic heard (so a mis-heard command is visible)
  const askedDl = useRef(false);
  const [showTtsPrompt, setShowTtsPrompt] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [awake, setAwake] = useState(true);
  const [voices, setVoices] = useState<Vc[]>([]);
  const [, force] = useState(0);
  const idRef = useRef(1);
  const list = useRef<ScrollView>(null);
  const follow = useRef(true);
  const rowY = useRef<Record<number, number>>({});
  const cardY = useRef<number | null>(null);
  const refresh = useCallback(async () => { try { setSources(chatRef.current ? await listSources(chatRef.current) : []); } catch {} }, []);
  const refreshChats = useCallback(async () => { try { setChats(await listChats()); } catch {} }, []);
  // every message is saved to the current chat
  const push = (who: Msg['who'], text: string) => {
    setMsgs((m) => [...m, { id: idRef.current++, who, text }]);
    if (chatRef.current) addMsg(chatRef.current, who, text).then(refreshChats).catch(() => {});
  };
  const showChat = async (id: number) => {
    chatRef.current = id; setChatId(id); rowY.current = {}; choicesRef.current = null;
    refresh();                                              // each chat shows only its own sources
    const m = await loadMsgs(id);
    idRef.current = (m.length ? Math.max(...m.map((x) => x.id)) : 0) + 1;
    setMsgs(m);
  };
  const resetReader = async () => { try { R.reset(); } catch {} await clearSession().catch(() => {}); };
  const startNew = async () => {
    setShowMenu(false);
    try {
      await resetReader();
      if (chatRef.current && msgs.length === 0) return;          // already on an empty chat
      const id = await newChat();
      await showChat(id); refreshChats();
    } catch (e: any) { Alert.alert('New chat failed', String(e?.message || e)); }
  };
  const openChat = async (id: number) => {
    setShowMenu(false);
    if (id === chatRef.current) return;
    await resetReader(); await showChat(id);
  };
  const removeChat = (c: Chat) => Alert.alert('Delete chat?', c.title + '\n\nIts sources, topics, notes and search index are deleted too.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      await deleteChat(c.id);
      if (c.id === chatRef.current) {
        await resetReader();
        const rest = await listChats();
        await showChat(rest.length ? rest[0].id : await newChat());
      }
      refreshChats();
    } },
  ]);

  const askRename = (c: Chat) => { setRenameText(c.title); setRenaming(c); };
  const saveRename = async () => {
    const c = renaming; setRenaming(null);
    if (c && renameText.trim()) { await renameChat(c.id, renameText); refreshChats(); }
  };

  useEffect(() => {
    const un = R.subscribe(() => force((x) => x + 1));
    const un2 = subscribeLlm(() => force((x) => x + 1));
    const un3 = subscribeTts(() => force((x) => x + 1));
    (async () => {
      await cleanupStuck().catch(() => {});
      initLlm().catch(() => {});
      initTts().catch(() => {});
      const prompted = await getMeta('tts_prompted').catch(() => '');
      if (prompted !== '1') setShowTtsPrompt(true);
      setSmartOn((await getMeta('smart').catch(() => '1')) !== '0');
      try {                                           // clearest installed voice, unless one was chosen before
        const all = await loadVoices();
        setVoices(all);
        for (const l of ['en', 'bn'] as const) {
          const saved = await getMeta('voice_' + l).catch(() => '');
          R.setVoice(l, saved && all.some((v) => v.identifier === saved) ? saved : bestFor(all, l));
        }
      } catch {}
      let cs = await listChats();
      const id = cs.length ? cs[0].id : await newChat();
      await adoptOldSources().catch(() => {});                  // old sources go to the oldest chat
      await showChat(id);
      refreshChats();
      const s = await loadSession();
      if (s) {
        const pts = await getNotes(s.topic_id);
        if (pts) R.restore(s.topic_id, await topicName(s.topic_id), pts, s.point_n, s.speed);
      }
    })().catch(() => {});
    return () => { un(); un2(); un3(); };
  }, []);
  useEffect(() => { awake ? activateKeepAwakeAsync() : deactivateKeepAwake(); }, [awake]);
  useEffect(() => {
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
    // notification buttons + call pause/resume
    return onServiceAction((a) => {
      if (a === 'toggle') (R.state.status === 'reading' ? R.pause() : R.resume());
      else if (a === 'stop') R.stop();
      else if (a === 'pause') R.pause();
      else if (a === 'resume') R.resume();
    });
  }, []);

  // "did you mean": show the 3 names, read them out, then wait for a tap or "one / two / three"
  const showChoices = (names: string[], marks: number, exactMode = false) => {
    choicesRef.current = names; choiceMarks.current = marks; choiceExact.current = exactMode; rowY.current = {};
    push('app', CHOICE + JSON.stringify(names));
    const line = 'Did you mean: ' + names.map((n) => n.replace(/\s*\(.*?\)\s*/g, ' ').trim()).join(', or ') + '?';   // no number words spoken: the mic cannot mistake the app's own voice for your "one / two / three", so you may answer at any moment
    try { R.stop(); } catch {}
    choiceSpeaking.current = true;                                   // the mic must not hear this as an answer
    const done = () => setTimeout(() => { choiceSpeaking.current = false; restartListening(100); }, 200);   // then a fresh mic: it must not carry the app's own voice into your answer
    setTimeout(() => { choiceSpeaking.current = false; }, Math.min(6000, 1500 + line.length * 60));      // safety: if no callback ever comes, the mic is not left deaf for long
    speak(line, { lang: /[\u0980-\u09FF]/.test(line) ? 'bn' : 'en', voice: R.state.voiceBn || undefined, rate: 0.95, onDone: done, onStopped: done, onError: done });
  };

  const beginDownload = async (mobile = false) => {
    const r = await startDownload(mobile);                          // Wi-Fi + storage are checked first
    if (r.ok) return;
    if (r.reason === 'wifi') Alert.alert('Wi-Fi needed', `Connect to Wi-Fi to download the model (~${Math.round(llm.total / 1e6)} MB).`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Use mobile data', onPress: () => beginDownload(true) }]);
    else if (r.reason === 'space') Alert.alert('Not enough storage', `About ${r.needMB} MB is needed, only ${r.freeMB} MB is free.`);
    else Alert.alert('No internet', 'Connect to the internet and try again.');
  };
  const offerDownload = () => {
    askedDl.current = true;
    const m = MODELS[llm.model];
    Alert.alert('Smart notes', `Download the offline ${m.label} model once (${Math.round(m.bytes / 1e6)} MB, Wi-Fi)? Until then notes use the basic method.`, [
      { text: 'Later', style: 'cancel' }, { text: 'Download', onPress: () => beginDownload() }]);
  };
  const toggleSmart = (v: boolean) => {
    setSmartOn(v); setMeta('smart', v ? '1' : '0').catch(() => {});
    if (v && llm.phase === 'none') { askedDl.current = true; beginDownload(); }            // first Smart use: check + download
  };

  const notFound = (alts: string[]) => push('app', 'Not found in your sources.' + (alts.length ? ` Closest: ${alts.join(', ')}` : ''));
  const makingRef = useRef(false);
  // a newer request cancels the job that is still running (no more "Still writing, one moment")
  const freeUp = async (): Promise<boolean> => {
    if (!makingRef.current) return true;
    cancelGen();
    for (let i = 0; i < 40 && makingRef.current; i++) await new Promise((r) => setTimeout(r, 120));
    if (makingRef.current) { makingRef.current = false; setWorking(''); }      // a stuck job must never block the app: the old one is cancelled, go on
    return true;
  };
  const openTopic = async (qRaw: string, exact = false, marksIn = 5) => {
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    const sm = exact ? { q: qRaw, marks: marksIn } : splitMarks(qRaw);
    const f = await findTopic(sm.q, chatRef.current, exact);
    if (f.kind === 'pick' && f.options?.length) { showChoices(f.options, sm.marks); return; }
    if (!f.found) { notFound(f.alts); return; }
    choicesRef.current = null;

    const useLlm = smart && llm.phase === 'ready';
    if (smart && llm.phase === 'none' && !askedDl.current) offerDownload();
    let pts = await getNotes(f.id, useLlm ? 'llm' : 'rule', sm.marks);   // id 0 (part of a big file) is never cached
    if (!pts && useLlm) {
      makingRef.current = true; setWorking('Writing notes…');
      const r: any = await llmNotes(f.name, f.body, sm.marks, (i, n) => { if (n > 1) setWorking(`Writing notes… part ${i}/${n}`); }).catch(() => ({ pts: null, notInSource: false }));
      makingRef.current = false; setWorking('');
      if (r.cancelled) return;                                            // you said stop / asked something newer
      if (r.notInSource) { notFound(f.alts); return; }                   // the model found nothing about it in the source
      if (r.pts) { pts = r.pts; await saveNotes(f.id, pts, 'llm', sm.marks); }
    }
    if (!pts) { pts = makeNotes(f.name, f.body); await saveNotes(f.id, pts, 'rule', 0); }
    rowY.current = {};
    cardY.current = null;
    push('app', TOPIC + f.name);
    R.startTopic(f.id, f.name, pts);
  };
  // ---------------------------------------------------------------------------------------------------------------
  // explain <topic>: the model's OWN knowledge (+ a web lookup). Sources are NOT used.
  const explainTopic = async (qRaw: string) => {
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    const sm = splitMarks(qRaw);
    const name = sm.q.trim();
    if (!name) { push('app', 'Say or type: explain <topic name>'); return; }
    // the topic is in your sources (even if the words were heard a little wrong, e.g. "institution" for "estimation"):
    // read THAT topic, complete, from your books
    const hit = await findTopic(name, chatRef.current).catch(() => null);
    if (hit && hit.kind === 'pick' && hit.options?.length) { showChoices(hit.options, sm.marks); return; }
    if (hit && hit.kind === 'ok' && hit.found) { await openTopic(qRaw); return; }
    makingRef.current = true; setWorking('Explaining…');
    try {
      const useLlm = smart && llm.phase === 'ready';
      if (smart && llm.phase === 'none' && !askedDl.current) offerDownload();
      const web = await wikiLookup(name).catch(() => null);
      let pts: Point[] | null = null;
      let label = '';
      if (useLlm) {
        const explicitMarks = /\b(\d{1,2}|two|three|four|five|six|seven|eight|ten|twelve)\s*(?:marks?|m)\b/i.test(qRaw);   // no marks said = the full note
        const r = await llmExplain(name, explicitMarks ? sm.marks : 0, web?.text || '', (i, n, t) => setWorking(`Writing ${i}/${n}: ${t}…`));
        if (r.cancelled) return;
        pts = r.pts;
        label = web ? 'Explained from my own knowledge + the web (not from your sources)' : 'Explained from my own knowledge (not from your sources)';
      }
      if (!pts && web) { pts = makeNotes(web.title, web.text); label = 'From the web (Wikipedia). The smart model is not ready yet'; }
      if (!pts) { push('app', 'I cannot explain this now: no internet, and the smart model is not downloaded (Settings > Smart notes).'); return; }
      rowY.current = {}; cardY.current = null;
      push('app', label);
      const nm = 'Explain: ' + name;
      push('app', TOPIC + nm);
      R.startTopic(0, nm, pts, `Explaining ${name}. ${pts.length} points.`);
    } finally { makingRef.current = false; setWorking(''); }
  };

  // A question (spoken "question ... okay", or anything typed): think, use the sources where they fit, add own knowledge
  const answerQuestion = async (q: string) => {
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    makingRef.current = true; setWorking('Thinking…');
    try {
      const chunks = await searchSources(q, chatRef.current, 3).catch(() => []);
      const useLlm = smart && llm.phase === 'ready';
      if (smart && llm.phase === 'none' && !askedDl.current) offerDownload();
      let pts: Point[] | null = null;
      let basis: Basis = 'own';
      if (useLlm) { const r = await llmAnswer(q, chunks); if (r.cancelled) return; pts = r.pts; basis = r.basis; }
      let label = basis === 'source' ? 'Answer from your sources'
        : basis === 'mixed' ? 'Answer: your sources + my own knowledge'
        : 'Not in your sources. Answered from my own knowledge';
      if (!pts && chunks.length) { pts = makeNotes(chunks[0].name, chunks[0].body); label = 'The smart model is not ready. Closest part of your sources'; }
      if (!pts) {
        const w = await wikiLookup(q).catch(() => null);
        if (w) { pts = makeNotes(w.title, w.text); label = 'Nothing in your sources. From the web (Wikipedia)'; }
      }
      if (!pts) { push('app', 'I could not answer: nothing in your sources, and the smart model is not downloaded (Settings > Smart notes).'); return; }
      rowY.current = {}; cardY.current = null;
      push('app', label);
      const nm = 'Answer: ' + (q.length > 60 ? q.slice(0, 57) + '...' : q);
      push('app', TOPIC + nm);
      R.startTopic(0, nm, pts, `Answer. ${pts.length} points.`);
    } finally { makingRef.current = false; setWorking(''); }
  };

  // spoken question: "question" -> say the whole question -> "okay"
  const endQ = () => { if (qRef.current) clearTimeout(qRef.current.timer); qRef.current = null; setAsking(false); };
  const armQ = () => {
    if (!qRef.current) return;
    clearTimeout(qRef.current.timer);
    qRef.current.timer = setTimeout(() => { if (qRef.current) { endQ(); push('app', 'Question cancelled (nothing heard for a while).'); } }, 90000);
  };
  const feedQuestion = (raw: string) => {
    const q = qRef.current; if (!q) return;
    const t = raw.trim();
    if (CANCEL_Q.test(t.replace(/[.!?।,]+$/, ''))) { endQ(); push('app', 'Question cancelled.'); return; }
    const done = OK_END.test(t);
    const part = t.replace(OK_END, '').trim();
    if (part) { q.parts.push(part); push('you', part); }
    armQ();
    if (done) {
      const full = q.parts.join(' ').trim();
      endQ();
      if (full) answerQuestion(full); else push('app', 'I did not hear a question. Say "question" and try again.');
    }
  };
  const startQuestion = (rest?: string) => {
    follow.current = true;
    try { R.pause(); } catch {}
    qRef.current = { parts: [], timer: null }; setAsking(true);
    push('app', 'Say your full question, then say "okay".');
    armQ();
    if (rest) feedQuestion(rest);
  };

  // exact <name>: word for word, heading to next heading, no model
  const exactTopic = async (qRaw: string, strict = false) => {
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    const f = await findExact(qRaw, chatRef.current, strict);
    if (f.kind === 'pick' && f.options?.length) { showChoices(f.options, 0, true); return; }
    if (!f.found) { notFound(f.alts); return; }
    choicesRef.current = null;
    const pts = exactPoints(f.name, f.body);
    rowY.current = {}; cardY.current = null;
    push('app', 'Exact: read word for word from your notes');
    push('app', TOPIC + f.name);
    R.startTopic(0, f.name, pts);
  };
  const pickName = async (nm: string) => {
    choicesRef.current = null;
    if (choiceExact.current) { choiceExact.current = false; await exactTopic(nm, true); return; }
    await openTopic(nm, true, choiceMarks.current);
  };

  const exec = async (text: string, via: 'voice' | 'text' = 'voice') => {
    if (!text.trim()) return;
    const c = parse(text);
    follow.current = true;
    // playback commands act FIRST (no waiting for the database); the chat history is written right after
    switch (c.t) {
      case 'repeat': R.repeat(c.arg); break;
      case 'continue': R.resume(); break;
      case 'pause': R.pause(); break;
      case 'stop': R.stop(); cancelGen(); choicesRef.current = null; setWorking(''); break;
      case 'next': R.next(); break;
      case 'prev': R.prev(); break;
      case 'slower': R.setRate(-0.1); break;
      case 'faster': R.setRate(0.1); break;
    }
    if (c.t === 'topic' || c.t === 'exact' || c.t === 'explain') { try { R.pause(); } catch {} stopSpeak(); choicesRef.current = null; }   // new request: nothing old keeps talking
    if (c.t === 'question' && via === 'voice') { startQuestion(c.q); return; }
    push('you', text);
    if (c.t === 'topic') await openTopic(c.q);
    else if (c.t === 'exact') await exactTopic(c.q);
    else if (c.t === 'explain') await explainTopic(c.q);
    else if (c.t === 'question') { if (c.q) await answerQuestion(c.q); else push('app', 'Type your question and send it.'); }
    else if (c.t === 'pick') {
      const names = choicesRef.current;
      if (!names || !names[c.n - 1]) push('app', 'Nothing to choose.');
      else await pickName(names[c.n - 1]);
    } else if (c.t === 'unknown') {
      // typed text is a normal chat: answered from your sources + the model's own knowledge.
      // (Spoken words that are not a command are ignored, so talking nearby never triggers anything.)
      if (via === 'text') {
        if (isGreeting(text) || !queryTokens(text).length) push('app', 'Hi! Say or type: topic <name>, exact <name>, explain <name>, or ask a question.');
        else await answerQuestion(text);
      }
      else push('app', 'Try: topic <name>, exact <name>, explain <name>, question ... okay, pause, next, repeat 2, continue.');
    }
  };
  const send = () => { const t = input.trim(); if (!t) return; setInput(''); exec(t, 'text'); };

  const addFiles = async () => {
    setBusy(true);
    try { const r = await pickAndImport(refresh, chatRef.current); if (r) push('app', r); } catch (e: any) { push('app', 'Import failed: ' + e.message); }
    setBusy(false); refresh();
  };

  const execRef = useRef(exec);
  execRef.current = exec;
  // Mic stays on; only real commands are accepted, and anything the app is itself speaking is ignored
  const heardSelf = (t: string) => t.trim().split(/\s+/).length >= 3 && R.state.status === 'reading' && R.getSpoken().toLowerCase().includes(t.toLowerCase().trim());
  // one-word playback commands run the moment they are heard (no waiting for the recognizer to finish)
  const FAST = new Set(['pause', 'stop', 'next', 'prev', 'continue', 'slower', 'faster']);
  // options waiting: any of the recogniser's guesses that sounds like one / two / three (also the usual mishearings)
  const WORDS = ['one', 'two', 'three'];
  // While the app is reading, the mic hears the app's own voice, so "stop" arrives glued to the end of the app's words
  // ("...and the cell membrane stop"). A clear command word at the END that the app is not itself saying right now is a real command.
  const TAIL_WORDS = new Set(['stop', 'pause', 'next', 'previous', 'continue', 'resume', 'slower', 'faster']);
  const tailCmd = (t: string): string | null => {
    if (R.state.status !== 'reading') return null;
    const w = t.trim().toLowerCase().replace(/[.!?।,]+/g, '').split(/\s+/).filter(Boolean);
    if (w.length < 2) return null;                                   // a lone word takes the normal path
    const last = w[w.length - 1];
    if (!TAIL_WORDS.has(last) || R.getSpoken().toLowerCase().includes(last)) return null;
    return last;
  };
  const stableT = useRef<any>(null);                                 // topic / exact / explain: runs when the words stop changing, not after the long end-of-speech silence
  const clearStable = () => { clearTimeout(stableT.current); stableT.current = null; };
  const loosePick = (alts: string[]) => { for (const a of alts) { const n = parsePick(stripChoiceEcho(a), true); if (n && n <= (choicesRef.current?.length || 3)) return n; } return 0; };
  // ---- COMMANDS WORK AT ANY TIME, AND FIRST ------------------------------------------------------------------
  // Runs before every other rule (options being read, question dictation, app reading, notes being written):
  //  - stop / pause / next / previous / continue / slower / faster : the moment they are heard (any of the recogniser's guesses)
  //  - topic / exact / explain : the app goes silent at once, then searches (nothing keeps talking over your command)
  //  - one / two / three : whenever options are waiting, even while they are still being read out
  // Returns true when a command was run, so nothing else handles the same words again.
  const lastCmd = useRef({ t: '', at: 0 });
  const dupCmd = (t: string) => { const n = Date.now(); const same = lastCmd.current.t === t && n - lastCmd.current.at < 1500; lastCmd.current = { t, at: n }; return same; };
  const silence = () => { try { R.pause(); } catch {} stopSpeak(); choiceSpeaking.current = false; };
  const hardCmd = (alts: string[], partial: boolean): boolean => {
    const asking = !!qRef.current;
    const opts = !!choicesRef.current;
    for (const a0 of alts) {
      const a = opts ? stripChoiceEcho(a0) : a0;
      if (!a) continue;
      const words = a.trim().split(/\s+/).length;
      const k = parse(a);
      if (asking) {                                                      // dictating a question: only "stop / cancel" is a command
        if (CANCEL_Q.test(a.trim().replace(/[.!?।,]+$/, ''))) return false;   // feedQuestion cancels it
        continue;
      }
      if (k.t === 'pick') {
        if (opts) { const n = loosePick([a]); if (n) { if (dupCmd('pick' + n)) return true; silence(); execRef.current(WORDS[n - 1]); return true; } }
        continue;
      }
      if (FAST.has(k.t) && words <= 3) {
        if (dupCmd(k.t)) return true;
        if (k.t === 'stop') { silence(); }
        execRef.current(a); return true;
      }
      if (['topic', 'exact', 'explain'].includes(k.t) && (k as any).q?.trim() && !heardSelf(a)) {
        if (partial) continue;                                           // partial: the stable-words timer below decides when it is finished
        if (dupCmd(k.t + (k as any).q)) return true;
        silence(); execRef.current(a); return true;
      }
    }
    // a command word glued to the end of the app's own speech ("...cell membrane stop")
    for (const a of alts) { const tc = tailCmd(a); if (tc && !dupCmd('tail' + tc)) { if (tc === 'stop') silence(); execRef.current(tc); return true; } }
    return false;
  };
  const onVoice = (alts: string[]) => {
    if (!alts.length) return;
    setHeard(alts[0].slice(0, 60));
    clearStable();
    if (hardCmd(alts, false)) { restartListening(60); return; }     // commands first, in every state
    if (choiceSpeaking.current) return;                              // otherwise the app's own voice: ignore
    if (qRef.current) { feedQuestion(alts[0]); return; }
    for (const a of alts) { const tc = tailCmd(a); if (tc) { execRef.current(tc); restartListening(150); return; } }
    if (choicesRef.current) {
      const n = loosePick(alts);
      if (n) { execRef.current(WORDS[n - 1]); return; }
      setHeard(alts[0].slice(0, 40) + '  (not one/two/three)');         // so you can see what the phone heard instead
    }          // dictating a question: everything is part of it until "okay"
    if (choicesRef.current) alts = alts.map(stripChoiceEcho).filter(Boolean);     // options waiting: drop the app's own "did you mean..." voice, keep the answer
    if (!alts.length) return;
    let t = alts[0];
    let c = parse(t);
    if (c.t === 'unknown') {
      // the recognizer's 2nd-5th guesses: a name command (topic / exact / explain / question), one / two / three while
      // options are waiting, or a short playback word (stop, pause ...) that the 1st guess got wrong
      const short = alts[0].trim().split(/\s+/).length <= 3;
      const a = alts.slice(1).find((x) => { const k = parse(x); return ['topic', 'exact', 'explain', 'question'].includes(k.t) || (k.t === 'pick' && !!choicesRef.current) || (short && FAST.has(k.t)); });
      if (!a) return;
      t = a; c = parse(a);
    }
    if (c.t === 'pick' && !choicesRef.current) return;             // "one / two" only means something while options are waiting
    if (heardSelf(t)) return;
    execRef.current(t);
  };
  const onPartial = (t: string) => {
    if (qRef.current) { clearStable(); return false; }              // never while a question is being dictated
    if (hardCmd([t], true)) { clearStable(); return true; }          // commands first, in every state
    if (choiceSpeaking.current) return false;
    if (heardSelf(t)) return false;
    const tc = tailCmd(t);
    if (tc) { clearStable(); execRef.current(tc); restartListening(150); return true; }
    if (choicesRef.current) { const n = loosePick([t]); if (n) { execRef.current(WORDS[n - 1]); return true; } }
    const k = parse(stripChoiceEcho(t));
    clearStable();
    if ((k.t === 'topic' || k.t === 'exact' || k.t === 'explain') && (k as any).q?.trim()) {
      const snap = t;                                                // same words for 0.7 s = finished: go now instead of waiting for the end-of-speech silence
      stableT.current = setTimeout(() => { stableT.current = null; if (qRef.current || dupCmd(k.t + (k as any).q)) return; markHandled(); silence(); execRef.current(snap); }, 600);
      return false;
    }
    if (!FAST.has(k.t) && !(k.t === 'pick' && !!choicesRef.current)) return false;      // "one / two / three" runs the moment it is heard, like stop / pause
    execRef.current(stripChoiceEcho(t));
    return true;
  };
  const mic = async () => {
    if (listening) { endQ(); await stopListening(); return; }
    const g = await PermissionsAndroid.request('android.permission.RECORD_AUDIO' as any);
    if (g !== 'granted') return;
    const ok = await startListening(onVoice, () => (R.state.lang === 'bn' ? 'bn-BD' : 'en-US'), setListening, onPartial);
    if (!ok) push('app', 'Voice module not available.');
  };
  useEffect(() => () => { stopListening(); }, []);

  const s = R.state;
  const ready = sources.filter((x) => x.status === 'ready').length;
  const indexing = sources.some((x) => x.status === 'indexing') || busy;
  const cycleLang = () => R.setLang(s.lang === 'auto' ? 'en' : s.lang === 'en' ? 'bn' : 'auto');
  const hasText = input.trim().length > 0;
  const playing = s.status === 'reading';
  const mb = (n: number) => Math.round(n / 1e6);
  const llmPct = Math.min(100, Math.round((llm.got / Math.max(1, llm.total)) * 100));
  const mLabel = MODELS[llm.model].label;
  const llmLine = [
    llm.phase === 'ready' ? `${mLabel} · ready · works offline`
      : llm.phase === 'downloading' ? `Downloading ${mLabel}: ${llmPct}% (${mb(llm.got)}/${mb(llm.total)} MB)`
      : llm.phase === 'paused' ? `Paused at ${llmPct}% - tap Resume`
      : llm.phase === 'checking' ? 'Checking Wi-Fi and storage…'
      : llm.phase === 'error' ? 'Download problem'
      : `One-time download ~${mb(llm.total)} MB on Wi-Fi, then fully offline`,
    llm.msg,
  ].filter(Boolean).join(' · ');

  // Foreground service lives while reading/paused or while the mic is on
  useEffect(() => {
    if (!listening && s.status === 'idle') { stopService(); return; }
    const pt = s.points[s.idx];
    const text = s.status === 'idle' ? 'Listening for commands'
      : `${s.topic} — point ${pt?.n ?? 0}/${s.points.length}${s.status === 'paused' ? ' (paused)' : ''}`;
    updateService('Sheet.md', text, s.status === 'reading', listening);
  }, [s.status, s.idx, s.topic, listening]);

  // keep the point being read in view (stops as soon as you scroll yourself)
  useEffect(() => {
    if (!follow.current || s.status !== 'reading') return;
    const y = rowY.current[s.idx];
    if (y == null || cardY.current == null) return;
    const tm = setTimeout(() => list.current?.scrollTo({ y: Math.max(0, (cardY.current || 0) + y - 90), animated: true }), 180);
    return () => clearTimeout(tm);
  }, [s.idx, s.status]);
  // new message -> show it
  useEffect(() => {
    if (!msgs.length || !follow.current) return;
    const tm = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 150);
    return () => clearTimeout(tm);
  }, [msgs.length]);

  const lastTopic = (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].text.startsWith(TOPIC)) return i; return -1; })();
  const renderMsg = (m: Msg, i: number) => {
    if (m.text.startsWith(TOPIC)) {
      const name = m.text.slice(TOPIC.length);
      const live = i === lastTopic && s.points.length > 0 && s.topic === name;
      if (!live) {                                              // older topic replies stay as a small title row
        return (
          <TouchableOpacity key={m.id} style={st.card} activeOpacity={0.6} onPress={() => { follow.current = true; openTopic(name, true); }}>
            <View style={st.cardHead}><Icon n="file" size={18} /><Text style={st.cardT} numberOfLines={1}>{name}</Text></View>
          </TouchableOpacity>);
      }
      return (
        <View key={m.id} style={st.card} onLayout={(e) => { cardY.current = e.nativeEvent.layout.y; }}>
          <Text style={st.topicT}>{s.topic}</Text>
          {s.points.map((p, k) => {
            const act = k === s.idx && s.status !== 'idle';
            const parts = act ? R.pointChunks(p).slice(1) : [];
            const lines = p.bullets?.length ? p.bullets : [p.text];
            return (
              <TouchableOpacity key={p.n} activeOpacity={0.8} style={st.ptBlock}
                onLayout={(e) => { rowY.current[k] = e.nativeEvent.layout.y; }}
                onPress={() => { follow.current = true; R.goto(k); }}>
                <Text style={st.ptTitle}>{p.title}</Text>
                {p.bullets ? lines.map((ln, j) => {
                  const on = act && R.lineOf(p, s.chunk - 1) === j;       // the line being read now (light highlight)
                  return <Text key={j} style={[st.ptLine, on && st.sentOn]}>{ln}</Text>;
                }) : (
                  <Text style={st.ptLine}>{splitSentences(lines.join(' ')).map((c, j) => <Text key={j} style={act && j === s.chunk - 1 ? st.sentOn : undefined}>{c + ' '}</Text>)}</Text>
                )}
                {!!p.hint && <Text style={st.hint}>Banglish: {p.hint}</Text>}
              </TouchableOpacity>);
          })}
        </View>);
    }
    if (m.text.startsWith(CHOICE)) {
      let names: string[] = [];
      try { names = JSON.parse(m.text.slice(CHOICE.length)); } catch {}
      return (
        <View key={m.id} style={st.card}>
          <Text style={[st.sub, { marginBottom: 4 }]}>Did you mean? Tap one, or say one / two / three</Text>
          {names.map((n, k) => (
            <TouchableOpacity key={k} activeOpacity={0.7} style={st.opt} onPress={() => { follow.current = true; pickName(n); }}>
              <Text style={st.ptN}>{k + 1}</Text><Text style={st.optT} numberOfLines={2}>{n}</Text>
            </TouchableOpacity>))}
        </View>);
    }
    return m.who === 'you'
      ? <View key={m.id} style={st.you}><Text style={st.youT}>{m.text}</Text></View>
      : <Text key={m.id} style={st.reply}>{m.text}</Text>;
  };

  return (
    <View ref={rootRef} collapsable={false} style={[st.root, { paddingTop: ins.top + 4, paddingBottom: kbPad }]}>
      <StatusBar barStyle="dark-content" />
      <View style={st.header}>
        <TouchableOpacity style={st.hBtn} onPress={() => { refreshChats(); setShowMenu(true); }}><Icon n="menu" size={24} /></TouchableOpacity>
        <View style={st.brand}><Image source={require('./assets/logo.png')} style={st.logo} resizeMode="contain" /><Text style={st.title}>Sheet.md</Text></View>
        <TouchableOpacity style={st.hBtn} onPress={() => setShowSet(true)}><Icon n="settings" size={24} /></TouchableOpacity>
      </View>
      {showTtsPrompt && (
        <View style={[st.group, { marginHorizontal: 14, marginTop: 4, marginBottom: 6, paddingVertical: 10 }]}>
          <Text style={[st.txt, { fontWeight: '700', fontSize: 14 }]}>Download clear offline voice (Lessac, ~67 MB, Wi-Fi)?</Text>
          <Text style={[st.sub, { marginTop: 2, marginBottom: 8 }]}>High-quality neural speech that runs fully offline on your device.</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity
              style={[st.miniBtn, { height: 34, paddingHorizontal: 14, backgroundColor: C.acc }]}
              onPress={async () => {
                setShowTtsPrompt(false);
                await setMeta('tts_prompted', '1').catch(() => {});
                startVoiceDownload(DEFAULT_VOICE_ID);
              }}>
              <Text style={[st.txt, { color: '#fff', fontSize: 13, fontWeight: '600' }]}>Download</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.miniBtn, { height: 34, paddingHorizontal: 12 }]}
              onPress={async () => {
                setShowTtsPrompt(false);
                await setMeta('tts_prompted', '1').catch(() => {});
                setShowSet(true);
              }}>
              <Text style={[st.txt, { fontSize: 13 }]}>Choose another</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.miniBtn, { height: 34, paddingHorizontal: 12 }]}
              onPress={async () => {
                setShowTtsPrompt(false);
                await setMeta('tts_prompted', '1').catch(() => {});
              }}>
              <Text style={[st.txt, { fontSize: 13, color: C.sec }]}>Later</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      <View style={st.chip}><Text style={st.sub}>{working ? working : asking ? 'Listening to your question · say okay when done' : indexing ? 'Indexing…' : `${ready} sources ready`}{listening ? '  •  listening' : ''}</Text>{listening && !!heard && <Text style={[st.sub, { textAlign: 'center' }]}>heard: “{heard}”</Text>}</View>

      <ScrollView
        ref={list} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => { follow.current = false; }}>
        {msgs.length === 0 && !sources.length ? (
          <TouchableOpacity style={st.empty} onPress={addFiles}>
            <Icon n="plus" size={22} /><Text style={st.emptyT}>Add a source to begin</Text>
          </TouchableOpacity>) : null}
        {msgs.map(renderMsg)}
      </ScrollView>

      <View style={[st.dock, { paddingBottom: kbPad > 0 ? 10 : ins.bottom + 12 }]}>
        <View style={st.box}>
          <TextInput style={st.boxInput} value={input} onChangeText={setInput} multiline
            placeholder="Ask anything · or: topic anemia, exact anemia, explain anemia" placeholderTextColor="#8A8A8A" />
          <View style={st.boxRow}>
            <TouchableOpacity style={st.boxPlus} onPress={() => setShowSrc(true)}><Icon n="plus" size={24} /></TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={st.pill} onPress={cycleLang}>
              <Text style={st.pillT}>{LANG_LABEL[s.lang]}</Text><Icon n="chevronDown" size={14} />
            </TouchableOpacity>
            <TouchableOpacity style={[st.circle, listening && { backgroundColor: C.on }]} onPress={mic}>
              <Icon n="mic" size={20} color={listening ? '#fff' : C.tx} />
            </TouchableOpacity>
            <TouchableOpacity style={[st.circle, hasText && { backgroundColor: C.acc }]} onPress={send} disabled={!hasText}>
              <Icon n="send" size={20} color={hasText ? '#fff' : C.disI} />
            </TouchableOpacity>
          </View>
          {s.points.length > 0 && (
            <>
              <View style={st.boxSep} />
              <View style={st.ctrl}>
                <TouchableOpacity style={st.ctrlSq} onPress={() => { follow.current = true; R.prev(); }}><Icon n="prev" size={22} /></TouchableOpacity>
                <TouchableOpacity style={st.ctrlWide} onPress={() => { follow.current = true; playing ? R.pause() : R.resume(); }}>
                  <Icon n={playing ? 'pause' : 'play'} size={20} />
                  <Text style={st.ctrlT}>{playing ? 'Pause' : s.status === 'idle' ? 'Play again' : 'Play'}</Text>
                  <Text style={st.sub}>{s.rate.toFixed(1)}x</Text>
                </TouchableOpacity>
                <TouchableOpacity style={st.ctrlSq} onPress={() => { R.stop(); cancelGen(); choicesRef.current = null; setWorking(''); }}><Icon n="close" size={20} /></TouchableOpacity>
                <TouchableOpacity style={st.ctrlSq} onPress={() => { follow.current = true; R.next(); }}><Icon n="next" size={22} /></TouchableOpacity>
              </View>
            </>)}
        </View>
      </View>

      <Modal visible={showMenu} transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={() => setShowMenu(false)}>
        <View style={st.drawerBg}>
          <View style={[st.drawer, { paddingTop: ins.top + 8, paddingBottom: ins.bottom + 12 }]}>
            <View style={st.drawerH}>
              <Image source={require('./assets/logo.png')} style={st.logo} resizeMode="contain" />
              <Text style={[st.title, { flex: 1, marginLeft: 8 }]}>Sheet.md</Text>
              <TouchableOpacity style={st.closeBtn} onPress={() => setShowMenu(false)}><Icon n="close" size={18} /></TouchableOpacity>
            </View>
            <TouchableOpacity style={st.drawerBtn} onPress={startNew}>
              <Icon n="plus" size={20} /><Text style={st.drawerBtnT}>New chat</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.drawerBtn} onPress={() => { setShowMenu(false); setShowSrc(true); }}>
              <Icon n="file" size={20} /><Text style={st.drawerBtnT}>Workspace</Text><Text style={st.sub}>{ready} sources</Text>
            </TouchableOpacity>
            <Text style={[st.secT, { marginTop: 14 }]}>Chats</Text>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {chats.length === 0 && <Text style={[st.sub, { padding: 12 }]}>No chats yet</Text>}
              {chats.map((c) => (
                <View key={c.id} style={[st.chatRow, c.id === chatId && st.chatRowOn]}>
                  <TouchableOpacity style={{ flex: 1, paddingVertical: 20 }} onPress={() => openChat(c.id)}>
                    <Text style={[st.txt, c.id === chatId && { fontWeight: '700' }]} numberOfLines={2}>{c.title}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={st.hBtn} onPress={() => askRename(c)}><Icon n="file" size={18} color={C.sec} /></TouchableOpacity>
                  <TouchableOpacity style={st.hBtn} onPress={() => removeChat(c)}><Icon n="trash" size={18} color={C.sec} /></TouchableOpacity>
                </View>))}
            </ScrollView>
          </View>
          <Pressable style={{ flex: 1 }} onPress={() => setShowMenu(false)} />
        </View>
      </Modal>

      <Modal visible={!!renaming} transparent statusBarTranslucent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <View style={st.dlgBg}>
          <View style={st.dlg}>
            <Text style={st.sheetT}>Rename chat</Text>
            <TextInput style={st.dlgInput} value={renameText} onChangeText={setRenameText} autoFocus selectTextOnFocus maxLength={60} onSubmitEditing={saveRename} />
            <View style={st.dlgRow}>
              <TouchableOpacity style={st.dlgBtn} onPress={() => setRenaming(null)}><Text style={st.txt}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[st.dlgBtn, { backgroundColor: C.acc }]} onPress={saveRename}><Text style={[st.txt, { color: '#fff', fontWeight: '600' }]}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Sheet visible={showSrc} onClose={() => setShowSrc(false)} title="Sources" subtitle={`${ready} ready`} bottom={ins.bottom}>
        <TouchableOpacity style={st.addBtn} onPress={addFiles}>
          <Icon n="plus" size={20} color="#fff" /><Text style={st.addT}>Add files</Text>
        </TouchableOpacity>
        <Text style={[st.sub, { textAlign: 'center' }]}>PDF, .md, .txt, .jpg, .zip</Text>
        <ScrollView style={{ maxHeight: sheetMax }} nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {sources.length === 0 && <Text style={[st.sub, { textAlign: 'center', paddingVertical: 24 }]}>No sources yet</Text>}
          {sources.map((x) => (
            <View key={x.id} style={st.srcRow}>
              <View style={st.fileBox}><Icon n="file" size={20} /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.txt} numberOfLines={1}>{x.name}</Text>
                <View style={st.srcSub}>
                  {x.status === 'ready' && <Icon n="check" size={12} color={C.ok} />}
                  <Text style={[st.sub, x.status === 'failed' && { color: C.bad }]} numberOfLines={1}>{x.status === 'ready' ? (x.info || 'Ready') : (x.info || x.status)}</Text>
                </View>
              </View>
              <TouchableOpacity style={st.hBtn} onPress={async () => { await removeSource(x.id); refresh(); }}><Icon n="trash" size={20} /></TouchableOpacity>
            </View>))}
        </ScrollView>
      </Sheet>

      <Sheet visible={showSet} onClose={() => setShowSet(false)} title="Voice settings" bottom={ins.bottom}>
        <ScrollView style={{ maxHeight: sheetMax }} nestedScrollEnabled contentContainerStyle={{ gap: 10, paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
          {/* Active status & test button */}
          <View style={st.group}>
            <View style={st.line}>
              <Icon n="speed" size={20} />
              <View style={{ flex: 1 }}>
                <Text style={st.txt}>Active speech engine</Text>
                <Text style={st.val}>
                  {ttsState.engine === 'piper' && ttsState.isPiperReady
                    ? `${VOICES.find((v) => v.id === ttsState.selectedVoice)?.engine === 'kokoro' ? 'Kokoro' : 'Piper'}: ${VOICES.find((v) => v.id === ttsState.selectedVoice)?.label || ttsState.selectedVoice}`
                    : 'Phone voice'}
                </Text>
              </View>
              <TouchableOpacity
                style={[st.miniBtn, { height: 36, paddingHorizontal: 12 }]}
                onPress={() => {
                  stopSpeak();
                  speak('Sheet.md reads your notes clearly with offline neural voices.', {
                    rate: s.rate,
                    lang: 'en',
                  });
                }}>
                <Text style={[st.txt, { fontSize: 13, fontWeight: '600' }]}>Test voice</Text>
              </TouchableOpacity>
            </View>
            {!!ttsState.ramReason && (
              <>
                <View style={st.sep} />
                <View style={{ paddingVertical: 8 }}>
                  <Text style={[st.sub, { color: C.bad }]}>{ttsState.ramReason}</Text>
                </View>
              </>
            )}
          </View>

          {/* Voice engine toggle */}
          <Text style={st.secT}>Voice engine</Text>
          <View style={st.seg}>
            <TouchableOpacity
              style={[st.segI, ttsState.engine === 'piper' && st.segOn, !VOICES.some((v) => ttsState.voices[v.id]?.phase === 'ready') && { opacity: 0.5 }]}
              onPress={async () => {
                const anyReady = VOICES.some((v) => ttsState.voices[v.id]?.phase === 'ready');
                if (!anyReady) {
                  Alert.alert('No offline voice ready', 'Download an English voice below to enable clear offline speech.');
                  return;
                }
                if (ttsState.ramReason) {
                  Alert.alert('Low RAM', ttsState.ramReason);
                  return;
                }
                if (R.state.status === 'reading') {
                  R.pause();
                  await setTtsEngine('piper');
                  R.resume();
                } else {
                  await setTtsEngine('piper');
                }
              }}>
              <Text style={[st.segT, ttsState.engine === 'piper' && { color: '#fff' }]}>Offline voice (Piper)</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[st.segI, ttsState.engine === 'phone' && st.segOn]}
              onPress={async () => {
                if (R.state.status === 'reading') {
                  R.pause();
                  await setTtsEngine('phone');
                  R.resume();
                } else {
                  await setTtsEngine('phone');
                }
              }}>
              <Text style={[st.segT, ttsState.engine === 'phone' && { color: '#fff' }]}>Phone voice</Text>
            </TouchableOpacity>
          </View>
          {!VOICES.some((v) => ttsState.voices[v.id]?.phase === 'ready') && (
            <Text style={[st.sub, { paddingHorizontal: 4 }]}>Download an offline voice below to enable Piper.</Text>
          )}

          {/* Reading Speed & Pause between points */}
          <View style={st.group}>
            <StepRow icon="speed" label="Speed" value={`${s.rate.toFixed(1)}x`} onMinus={() => R.setRate(-0.1)} onPlus={() => R.setRate(0.1)} />
            <View style={st.sep} />
            <StepRow icon="timer" label="Pause between points" value={`${s.pauseSec}s`} onMinus={() => R.setPause(-1)} onPlus={() => R.setPause(1)} />
          </View>

          {/* Language selector */}
          <Text style={st.secT}>Language</Text>
          <View style={st.seg}>
            {(['auto', 'en', 'bn'] as const).map((l) => (
              <TouchableOpacity key={l} style={[st.segI, s.lang === l && st.segOn]} onPress={() => R.setLang(l)}>
                <Text style={[st.segT, s.lang === l && { color: '#fff' }]}>{LANG_LABEL[l]}</Text>
              </TouchableOpacity>))}
          </View>

          {/* English voices (Piper Catalog grouped by US / GB) */}
          <Text style={st.secT}>English offline voices</Text>
          {(['US', 'GB', 'KO'] as const).map((accent) => {
            const list = VOICES.filter((v) => v.accent === accent);
            return (
              <View key={accent} style={st.group}>
                <Text style={[st.sub, { paddingTop: 10, fontWeight: '700' }]}>{accent === 'US' ? 'United States (Piper)' : accent === 'GB' ? 'British (UK) (Piper)' : 'Kokoro - higher quality (one 132 MB download, heavier: needs a strong phone)'}</Text>
                {list.map((v, idx) => {
                  const vst = ttsState.voices[v.id] || { phase: 'none', got: 0, total: v.bytes, msg: '' };
                  const isSelected = ttsState.selectedVoice === v.id && ttsState.engine === 'piper';
                  const isReady = vst.phase === 'ready';
                  const pct = Math.min(100, Math.round((vst.got / Math.max(1, vst.total)) * 100));

                  const onDownload = async (mobile = false) => {
                    const r = await startVoiceDownload(v.id, mobile);
                    if (r.ok) return;
                    if (r.reason === 'wifi') {
                      Alert.alert('Wi-Fi needed', `Connect to Wi-Fi to download ${v.label} (~${mb(v.bytes)} MB).`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Use mobile data', onPress: () => onDownload(true) },
                      ]);
                    } else if (r.reason === 'space') {
                      Alert.alert('Not enough storage', `About ${r.needMB} MB is needed, only ${r.freeMB} MB is free.`);
                    } else {
                      Alert.alert('No internet', 'Connect to the internet and try again.');
                    }
                  };

                  const onSelect = async () => {
                    if (!isReady) return;
                    if (R.state.status === 'reading') {
                      R.pause();
                      await selectVoice(v.id);
                      R.resume();
                    } else {
                      await selectVoice(v.id);
                    }
                  };

                  const onPreview = async () => {
                    stopSpeak();
                    setPreviewingVoice(v.id);
                    if (isReady && ttsState.selectedVoice !== v.id) await selectVoice(v.id);     // the preview must use THIS voice
                    speak(`Hello, this is ${v.label}.`, {
                      engine: 'piper',
                      rate: s.rate,
                      lang: 'en',
                      onDone: () => setPreviewingVoice(null),
                      onStopped: () => setPreviewingVoice(null),
                      onError: () => setPreviewingVoice(null),
                    });
                  };

                  const onDelete = () => {
                    Alert.alert('Delete voice?', v.engine === 'kokoro' ? 'All Kokoro voices share one download. It will be removed from private storage.' : `${v.label} will be removed from private storage.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          if (R.state.status === 'reading' && ttsState.selectedVoice === v.id) {
                            R.pause();
                            await deleteVoice(v.id);
                            R.resume();
                          } else {
                            await deleteVoice(v.id);
                          }
                        },
                      },
                    ]);
                  };

                  return (
                    <View key={v.id}>
                      {idx > 0 && <View style={st.sep} />}
                      <View style={[st.voiceRow, { alignItems: 'flex-start', paddingVertical: 10 }]}>
                        {isReady ? (
                          <TouchableOpacity onPress={onSelect} style={{ paddingTop: 2 }}>
                            <Icon n={isSelected ? 'check' : 'play'} size={isSelected ? 18 : 14} color={isSelected ? C.ok : C.disI} />
                          </TouchableOpacity>
                        ) : (
                          <View style={{ width: 18, paddingTop: 4 }}>
                            <Icon n="speed" size={14} color={C.disI} />
                          </View>
                        )}

                        <TouchableOpacity style={{ flex: 1 }} onPress={isReady ? onSelect : undefined} activeOpacity={isReady ? 0.7 : 1}>
                          <Text style={[st.txt, isSelected && { fontWeight: '700' }]} numberOfLines={1}>{v.label}</Text>
                          <Text style={st.sub}>{v.gender === 'female' ? 'Female' : 'Male'} · {mb(v.bytes)} MB{v.note ? ` · ${v.note}` : ''}</Text>
                          <Text style={[st.sub, { color: '#888', fontSize: 11, marginTop: 1 }]}>License: {v.license}</Text>

                          {vst.phase === 'downloading' && (
                            <View style={{ marginTop: 6 }}>
                              <View style={st.barBg}><View style={[st.barFg, { width: `${pct}%` }]} /></View>
                              <Text style={st.sub}>Downloading: {pct}% ({mb(vst.got)}/{mb(vst.total)} MB)</Text>
                            </View>
                          )}
                          {vst.phase === 'paused' && (
                            <Text style={[st.sub, { marginTop: 4, color: C.sec }]}>Paused at {pct}%</Text>
                          )}
                          {vst.phase === 'extracting' && (
                            <Text style={[st.sub, { marginTop: 4, color: C.acc, fontWeight: '600' }]}>Preparing voice...</Text>
                          )}
                          {vst.phase === 'error' && (
                            <Text style={[st.sub, { marginTop: 4, color: C.bad }]}>{vst.msg || 'Download failed'}</Text>
                          )}
                        </TouchableOpacity>

                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          {isReady && (
                            <>
                              <TouchableOpacity style={st.hBtn} onPress={onPreview}>
                                <Icon n={previewingVoice === v.id ? 'pause' : 'play'} size={16} color={C.acc} />
                              </TouchableOpacity>
                              <TouchableOpacity style={st.hBtn} onPress={onDelete}>
                                <Icon n="trash" size={16} color={C.sec} />
                              </TouchableOpacity>
                            </>
                          )}
                          {vst.phase === 'none' && (
                            <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 12 }]} onPress={() => onDownload()}>
                              <Text style={[st.txt, { fontSize: 13, fontWeight: '600' }]}>Download</Text>
                            </TouchableOpacity>
                          )}
                          {vst.phase === 'downloading' && (
                            <>
                              <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 10 }]} onPress={() => pauseVoiceDownload(v.id)}>
                                <Text style={[st.txt, { fontSize: 12 }]}>Pause</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 10 }]} onPress={() => cancelVoiceDownload(v.id)}>
                                <Text style={[st.txt, { fontSize: 12 }]}>Cancel</Text>
                              </TouchableOpacity>
                            </>
                          )}
                          {(vst.phase === 'paused' || vst.phase === 'error') && (
                            <>
                              <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 10, backgroundColor: C.acc }]} onPress={() => onDownload()}>
                                <Text style={[st.txt, { color: '#fff', fontSize: 12, fontWeight: '600' }]}>{vst.phase === 'paused' ? 'Resume' : 'Retry'}</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 10 }]} onPress={() => cancelVoiceDownload(v.id)}>
                                <Text style={[st.txt, { fontSize: 12 }]}>Cancel</Text>
                              </TouchableOpacity>
                            </>
                          )}
                        </View>
                      </View>
                    </View>
                  );
                })}
              </View>
            );
          })}

          {/* Phone voices (Bangla & system fallback) */}
          <Text style={st.secT}>Phone voices (Bangla & system fallback)</Text>
          <View style={st.group}>
            {(['en', 'bn'] as const).map((l, li) => {
              const list = voicesFor(voices, l).slice(0, 5);
              const cur = l === 'en' ? s.voiceEn : s.voiceBn;
              return (
                <View key={l}>
                  {li > 0 && <View style={st.sep} />}
                  <Text style={[st.sub, { paddingTop: 10 }]}>{l === 'en' ? 'English fallback voice' : 'Bangla voice'}</Text>
                  {list.length === 0 && <Text style={[st.val, { paddingVertical: 10 }]}>No voice found - install one below</Text>}
                  {list.map((v) => (
                    <TouchableOpacity key={v.identifier} style={st.voiceRow}
                      onPress={() => { R.setVoice(l, v.identifier); setMeta('voice_' + l, v.identifier).catch(() => {}); }}>
                      <Icon n={v.identifier === cur ? 'check' : 'play'} size={v.identifier === cur ? 18 : 14} color={v.identifier === cur ? C.ok : C.disI} />
                      <Text style={[st.txt, { flex: 1 }, v.identifier === cur && { fontWeight: '700' }]} numberOfLines={1}>{v.name || v.identifier}</Text>
                      <Text style={st.sub}>{/network/i.test(v.identifier) ? 'online' : String(v.quality).toLowerCase() === 'enhanced' ? 'enhanced' : v.language}</Text>
                    </TouchableOpacity>))}
                </View>);
            })}
            <View style={st.sep} />
            <TouchableOpacity style={st.line} onPress={() => Linking.sendIntent('com.android.settings.TTS_SETTINGS').catch(() => Linking.openSettings())}>
              <Icon n="speed" size={20} /><Text style={[st.txt, { flex: 1 }]}>Get a clearer voice (phone TTS settings)</Text>
              <Icon n="chevronDown" size={16} color={C.sec} style={{ transform: [{ rotate: '-90deg' }] }} />
            </TouchableOpacity>
          </View>

          <Text style={st.secT}>Smart notes</Text>
          <View style={st.group}>
            <View style={st.line}>
              <Icon n="file" size={20} />
              <View style={{ flex: 1 }}><Text style={st.txt}>Smart notes (offline AI)</Text><Text style={st.val}>{llmLine}</Text></View>
              <Switch value={smart} onValueChange={toggleSmart} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            {(llm.phase === 'downloading' || llm.phase === 'paused') && (
              <View style={st.barBg}><View style={[st.barFg, { width: `${llmPct}%` }]} /></View>)}
            {llm.phase !== 'ready' && (
              <>
                <View style={st.sep} />
                <View style={[st.line, { gap: 8 }]}>
                  {llm.phase === 'checking' ? <Text style={st.sub}>Checking Wi-Fi and storage…</Text>
                    : llm.phase === 'downloading' ? (
                      <>
                        <TouchableOpacity style={st.miniBtn} onPress={() => pauseDownload()}><Text style={st.txt}>Pause</Text></TouchableOpacity>
                        <TouchableOpacity style={st.miniBtn} onPress={() => cancelDownload()}><Text style={st.txt}>Cancel</Text></TouchableOpacity>
                      </>
                    ) : (
                      <>
                        <TouchableOpacity style={[st.miniBtn, { backgroundColor: C.acc }]} onPress={() => beginDownload()}>
                          <Text style={[st.txt, { color: '#fff', fontWeight: '600' }]}>{llm.phase === 'paused' ? 'Resume' : 'Download'}</Text>
                        </TouchableOpacity>
                        {llm.phase === 'paused' && <TouchableOpacity style={st.miniBtn} onPress={() => cancelDownload()}><Text style={st.txt}>Cancel</Text></TouchableOpacity>}
                      </>
                    )}
                </View>
              </>)}
          </View>

          <Text style={st.secT}>Background</Text>
          <View style={st.group}>
            <View style={st.line}>
              <Icon n="screen" size={20} /><Text style={[st.txt, { flex: 1 }]}>Keep screen awake</Text>
              <Switch value={awake} onValueChange={setAwake} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            <View style={st.sep} />
            <TouchableOpacity style={st.line} onPress={() => Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() => {})}>
              <Icon n="battery" size={20} /><Text style={[st.txt, { flex: 1 }]}>Allow unrestricted battery</Text>
              <Icon n="chevronDown" size={16} color={C.sec} style={{ transform: [{ rotate: '-90deg' }] }} />
            </TouchableOpacity>
          </View>

          <Text style={st.secT}>Voice commands</Text>
          <View style={st.group}>
            {COMMANDS.map(([c, d], i) => (
              <View key={c}>
                {i > 0 && <View style={st.sep} />}
                <View style={st.cmdRow}><Text style={st.cmd}>{c}</Text><Text style={st.cmdD}>{d}</Text></View>
              </View>))}
          </View>
          <Text style={[st.sub, { paddingHorizontal: 4 }]}>Bangla mode also understands: থামো, পরের, আগের, আবার, চালু{'\n'}Voice only reacts to these commands. Anything you TYPE is a normal chat question: answered from your sources + my own knowledge.</Text>
        </ScrollView>
      </Sheet>
    </View>
  );
}

const Sheet = ({ visible, onClose, title, subtitle, bottom, children }:
  { visible: boolean; onClose: () => void; title: string; subtitle?: string; bottom: number; children: React.ReactNode }) => (
  <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="slide" onRequestClose={onClose}>
    <View style={st.sheetBg}>
      <Pressable style={{ flex: 1 }} onPress={onClose} />
      <View style={[st.sheet, { paddingBottom: bottom + 16 }]}>
        <View style={st.grab} />
        <View style={st.sheetH}>
          <View style={{ flex: 1 }}>
            <Text style={st.sheetT}>{title}</Text>
            {subtitle ? <Text style={st.sub}>{subtitle}</Text> : null}
          </View>
          <TouchableOpacity style={st.closeBtn} onPress={onClose}><Icon n="close" size={18} /></TouchableOpacity>
        </View>
        {children}
      </View>
    </View>
  </Modal>
);

const StepRow = ({ icon, label, value, onMinus, onPlus }:
  { icon: IconName; label: string; value: string; onMinus: () => void; onPlus: () => void }) => (
  <View style={st.line}>
    <Icon n={icon} size={20} />
    <View style={{ flex: 1 }}><Text style={st.txt}>{label}</Text><Text style={st.val}>{value}</Text></View>
    <TouchableOpacity style={st.step} onPress={onMinus}><Icon n="minus" size={18} /></TouchableOpacity>
    <TouchableOpacity style={st.step} onPress={onPlus}><Icon n="plus" size={18} /></TouchableOpacity>
  </View>
);

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 6 },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.tx },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { width: 34, height: 24 },
  chip: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  sub: { color: C.sec, fontSize: 12 },
  txt: { color: C.tx, fontSize: 15 },
  youT: { color: '#fff', fontSize: 14 },
  reply: { color: C.tx, fontSize: 14, lineHeight: 20, alignSelf: 'flex-start', maxWidth: '92%', paddingHorizontal: 2 },
  you: { backgroundColor: C.acc, alignSelf: 'flex-end', borderRadius: 3, paddingHorizontal: 11, paddingVertical: 7, maxWidth: '80%' },
  empty: { borderWidth: 1, borderColor: C.bd, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 40, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  emptyT: { color: C.tx, fontSize: 16 },

  card: { backgroundColor: 'transparent', borderRadius: 1, paddingVertical: 4 },
  topicT: { fontWeight: '700', fontSize: 18, lineHeight: 26, color: C.tx, marginBottom: 6 },
  ptBlock: { paddingVertical: 8 },
  ptTitle: { fontWeight: '700', fontSize: 16, lineHeight: 24, color: C.tx, marginBottom: 2 },
  ptLine: { color: C.tx, fontSize: 16, lineHeight: 25, marginBottom: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  cardT: { flex: 1, fontWeight: '700', fontSize: 16, color: C.tx },
  ptRow: { flexDirection: 'row', gap: 10, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 2 },
  ptRowOn: { backgroundColor: '#EEF0FF' },
  ptN: { width: 22, color: C.sec, fontSize: 14, textAlign: 'right', paddingTop: 1 },
  ptNOn: { color: C.tx, fontWeight: '700' },
  pt: { color: C.sec, fontSize: 15 },
  ptActive: { color: C.tx, fontWeight: '700' },
  sentBox: { marginTop: 6, fontSize: 15, lineHeight: 22 },
  sent: { color: C.sec },
  sentOn: { color: C.tx, fontWeight: '600', backgroundColor: '#FFF3B0' },
  bul: { color: C.sec, fontSize: 15, lineHeight: 22, width: 16 },
  hint: { color: C.sec, fontSize: 14, lineHeight: 20, fontStyle: 'italic', marginTop: 2 },

  dock: { paddingHorizontal: 12, paddingTop: 6 },
  box: { borderWidth: 1.5, borderColor: '#D6D6D3', borderRadius: 3, backgroundColor: C.bg, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 },
  boxSep: { height: 1, backgroundColor: '#ECECEA', marginTop: 6, marginHorizontal: -10 },
  boxInput: { minHeight: 44, maxHeight: 120, fontSize: 16, color: C.tx, paddingHorizontal: 4, paddingVertical: 6, textAlignVertical: 'top' },
  boxRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  boxPlus: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 3, paddingHorizontal: 10, height: 38 },
  pillT: { fontSize: 14, fontWeight: '600', color: C.tx },
  circle: { width: 40, height: 40, borderRadius: 3, alignItems: 'center', justifyContent: 'center' },

  ctrl: { flexDirection: 'row', gap: 4, paddingTop: 4 },
  ctrlSq: { width: 62, height: 46, borderRadius: 3, alignItems: 'center', justifyContent: 'center' },
  ctrlWide: { flex: 1, height: 46, borderRadius: 3, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  ctrlT: { fontSize: 16, fontWeight: '600', color: C.tx },

  drawerBg: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.35)' },
  drawer: { width: '80%', maxWidth: 340, backgroundColor: C.bg, paddingHorizontal: 14, gap: 8, elevation: 16 },
  drawerH: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6 },
  drawerBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 50, borderRadius: 16, backgroundColor: C.surf, paddingHorizontal: 14 },
  drawerBtnT: { flex: 1, fontSize: 16, fontWeight: '600', color: C.tx },
  chatRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 12, minHeight: 68 },
  chatRowOn: { backgroundColor: C.surf },
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 18, paddingTop: 10, gap: 12, maxHeight: '88%', elevation: 16 },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#D4D4D4', marginBottom: 2 },
  sheetH: { flexDirection: 'row', alignItems: 'center' },
  sheetT: { fontSize: 20, fontWeight: '700', color: C.tx },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.surf, alignItems: 'center', justifyContent: 'center' },
  addBtn: { backgroundColor: C.acc, borderRadius: 18, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addT: { color: '#fff', fontSize: 16, fontWeight: '600' },
  srcRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.surf },
  fileBox: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.surf, alignItems: 'center', justifyContent: 'center' },
  srcSub: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },

  secT: { fontSize: 13, fontWeight: '600', color: C.sec, marginTop: 6, paddingHorizontal: 4 },
  group: { backgroundColor: C.surf, borderRadius: 18, paddingHorizontal: 14 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56 },
  sep: { height: 1, backgroundColor: C.bd },
  val: { fontSize: 13, color: C.sec, marginTop: 1 },
  step: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: C.bd, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', backgroundColor: C.surf, borderRadius: 16, padding: 4 },
  segI: { flex: 1, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.acc },
  segT: { fontSize: 14, fontWeight: '600', color: C.tx },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  opt: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderRadius: 3, backgroundColor: C.surf, marginTop: 6 },
  optT: { flex: 1, fontSize: 15, fontWeight: '600', color: C.tx },
  barBg: { height: 6, borderRadius: 3, backgroundColor: C.bd, overflow: 'hidden', marginBottom: 12 },
  barFg: { height: 6, borderRadius: 3, backgroundColor: C.acc },
  miniBtn: { height: 40, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1.5, borderColor: C.bd, alignItems: 'center', justifyContent: 'center' },
  dlgBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 24 },
  dlg: { backgroundColor: C.bg, borderRadius: 20, padding: 18, gap: 14, elevation: 16 },
  dlgInput: { borderWidth: 1.5, borderColor: C.bd, borderRadius: 12, paddingHorizontal: 12, height: 48, fontSize: 16, color: C.tx },
  dlgRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dlgBtn: { height: 42, paddingHorizontal: 20, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surf },
  cmdRow: { paddingVertical: 10 },
  cmd: { fontSize: 15, fontWeight: '600', color: C.tx },
  cmdD: { fontSize: 13, color: C.sec, marginTop: 1 },
});
