import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, StyleSheet, ScrollView, Pressable, Switch,
  Platform, PermissionsAndroid, AppState, StatusBar, Linking, Image, Keyboard, Alert, useWindowDimensions,
  Animated, Easing, ActivityIndicator, ToastAndroid, Share,
} from 'react-native';
import LottieView from 'lottie-react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import * as Clipboard from 'expo-clipboard';
import { parse, parsePick, isGreeting, stripChoiceEcho, setChoiceNames, pickByName, OK_END, CANCEL_Q, isWeakCmd } from './src/commands';
import { queryTokens } from './src/match';
import { makeNotes, Point } from './src/notes';
import { exactPoints } from './src/exact';
import { splitSentences } from './src/cleaner';
import * as R from './src/reader';
import {
  findTopic, findExact, getNotes, saveNotes, listSources, removeSource, loadSession, clearSession, topicName, cleanupStuck, searchSources,
  listTopics, listChats, newChat, deleteChat, renameChat, adoptOldSources, loadMsgs, addMsg, setMsgData, getMeta, setMeta, Source, Chat, listFacts, removeFact, Fact,
} from './src/db';
import { llm, initLlm, subscribeLlm, startDownload, pauseDownload, cancelDownload, llmNotes, llmExplain, llmAnswer, cancelGen, splitMarks, MODELS, Basis,
  searchWithCloud, searchInfo, GeminiError, GEMINI_MODELS, GeminiModelId, gem, loadGemini, saveGeminiKey, saveGeminiModel, hasGeminiKey, providerLabel } from './src/llm';
import { cloud, cloudReady, loadCloud, saveProvider, saveCloudKey, saveCloudModel, saveCustomUrl, openRouterFreeModels, PROVIDERS, KEY_LINK, DEFAULT_MODEL, ProviderId, OrModel } from './src/cloud';
import { wikiLookup } from './src/web';
import { noteSpoken, runAgent, agentReady, hasPending, dropPending, armPending, confirmVerdict, resolvePending, cancelAgent, looksLikeRequest, echoOfReply, checkProvider } from './src/agent/agent';
import { startAnnouncer, parseAllow, notifEnabled, notifOpenSettings } from './src/agent/notify';
import { bubbleListening, bubbleOverride, bubbleHeard, bubbleReply, onBubbleTap, assistantOn, setAssistantMode, overlayGranted, askOverlay, registerBubbleMenu, refreshBubbleMenu } from './src/agent/bubble';
import { loadVoices, voicesFor, bestFor, Vc } from './src/voice';
import { pickAndImport } from './src/importer';
import { startListening, stopListening, restartListening, markHandled, subscribeLevel, subscribeLive } from './src/listener';
import { updateService, stopService, onServiceAction, batteryUnrestricted, askBatteryUnrestricted } from './src/service';
import { splitWake } from './src/wake';
import { Stt, sttState, subscribeStt, initStt, downloadStt, deleteStt, setSttGoogle, setSttAec, setSttGain } from './src/stt';
import { ICONS, IconName } from './src/icons';
import {
  VOICES, ttsState, subscribeTts, initTts, startVoiceDownload,
  pauseVoiceDownload, cancelVoiceDownload, deleteVoice, selectVoice, setTtsEngine, setBoost,
  speak, stopSpeak, DEFAULT_VOICE_ID, pickCustomVoice,
} from './src/tts';

type CardData = { pts: Point[]; tid: number; liked?: boolean };       // the full reply of a topic card: saved with the message, so it is never hidden and survives a restart
type Msg = { id: number; who: 'you' | 'app'; text: string; data?: CardData };
const parseCard = (j: any): CardData | undefined => { try { const d = typeof j === 'string' ? JSON.parse(j) : j; return d && Array.isArray(d.pts) && d.pts.length ? d : undefined; } catch { return undefined; } };
// plain text of a reply (for Copy)
const cardText = (name: string, pts: Point[]) => [name, '', ...pts.map((p) => {
  const body = p.bullets?.length ? p.bullets.map((b) => '- ' + b).join('\n') : p.text;
  return `${p.n}. ${p.title}${body ? '\n' + body : ''}${p.hint ? '\nBanglish: ' + p.hint : ''}`;
})].join('\n').trim();
const TOPIC = '\u2063T\u2063';                  // hidden marker: this reply is a topic card
const CHOICE = '\u2063C\u2063';                 // hidden marker: this reply is the "did you mean" list (top 3 topics)

const C = { bg: '#FFFFFF', surf: '#F6F6F5', bd: '#E4E4E2', tx: '#0A0A0A', sec: '#737373', acc: '#0A0A0A', on: '#0A0A0A', ok: '#16a34a', bad: '#dc2626', dis: '#EDEDEB', disI: '#A3A3A3' };
const LANG_LABEL = { auto: 'Auto', en: 'English', bn: 'Bangla' } as const;
const COMMANDS: [string, string][] = [
  ['topic <name>', 'Read that topic from your sources, point by point'],
  ['exact <name>', 'Read that topic word for word from its heading to the next heading (fast, no AI)'],
  ['explain <name>', 'Explain it from my own knowledge + web (not your sources)'],
  ['search <topic>  /  search short <topic>', 'Live search (Google Gemini, or the Cloud API you choose in Models; needs internet + a key): a short answer'],
  ['search long <topic>  /  search long <topic> 5 marks', 'The same search written as a full exam answer (sections, numbered lab steps), read point by point'],
  ['question ... okay', 'Say "question", then your full question, then "okay": I think, use your sources, add my own knowledge'],
  ['pause  /  continue', 'Hold, or carry on from the same sentence'],
  ['next  /  previous', 'Jump to the next or earlier point'],
  ['repeat', 'Say the line being read again'],
  ['repeat previous', 'Say the previous line again'],
  ['repeat point  /  repeat point 3', 'Read this point (or point 3) again'],
  ['slower  /  faster', 'Change the reading speed'],
  ['tuik <command>', 'App in background or phone locked: say "tuik" first ("tuik pause", "tuik topic anemia"), or "tuik" and then the command'],
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
  const inputRef = useRef<TextInput>(null);
  const kbOpen = useRef(false);
  const kbTop = useRef(0);
  const [kbPad, setKbPad] = useState(0);
  useEffect(() => {
    // bottom padding = how much of the screen the keyboard still covers, so the input box always sits right on top of it.
    // measureInWindow() is relative to the window BELOW the status bar, while the keyboard position is in screen coordinates,
    // so the status bar height is added (without it the bottom row of the box stayed under the keyboard).
    // The keyboard is read with Keyboard.metrics() on every check (not from a flag), and re-checked while it is open,
    // so a missed show / hide event can never leave the box hidden behind it.
    const sb = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;
    let timer: any = null;
    const measure = () => {
      const m = Keyboard.metrics();
      if (!m || !m.height) { kbOpen.current = false; setKbPad((p) => (p === 0 ? p : 0)); return; }
      kbOpen.current = true; kbTop.current = m.screenY;
      rootRef.current?.measureInWindow((_x, y, _w, h) => {
        const pad = Math.max(0, Math.round(y + h + sb - kbTop.current));
        setKbPad((p) => (Math.abs(p - pad) < 2 ? p : pad));
      });
    };
    const start = () => { measure(); if (timer) clearInterval(timer); timer = setInterval(measure, 300); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } kbOpen.current = false; setKbPad(0); };
    const a = Keyboard.addListener('keyboardDidShow', (e) => { kbOpen.current = true; kbTop.current = e.endCoordinates.screenY; start(); });
    const b = Keyboard.addListener('keyboardDidHide', stop);
    return () => { a.remove(); b.remove(); if (timer) clearInterval(timer); };
  }, []);
  const keepFocus = () => { if (kbOpen.current) setTimeout(() => inputRef.current?.focus(), 30); };        // buttons never take the keyboard away
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const [showSet, setShowSet] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [hasKey, setHasKey] = useState(false);           // a Gemini key is saved (or built in)
  const [gemModel, setGemModel] = useState<GeminiModelId>(gem.model);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyShown, setKeyShown] = useState(false);
  const modelsScroll = useRef<ScrollView>(null);
  // Cloud API (Models): which provider answers "search ...", and the key / model of each one
  const [prov, setProv] = useState<ProviderId>(cloud.provider);
  const [provOpen, setProvOpen] = useState(false);             // the provider dropdown
  const [modelDraft, setModelDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [orList, setOrList] = useState<OrModel[] | null>(null);   // OpenRouter free models, read live
  const [orBusy, setOrBusy] = useState(false);
  const [cloudTick, setCloudTick] = useState(0);              // re-draw after a key / model is saved
  // floating Topics list (topics found in this chat's sources)
  const [showTopics, setShowTopics] = useState(false);
  const [topicList, setTopicList] = useState<{ id: number; name: string; pri: number }[]>([]);
  const [topicQ, setTopicQ] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState(0);
  const chatRef = useRef(0);
  const [listening, setListening] = useState(false);
  const [renaming, setRenaming] = useState<Chat | null>(null);
  const [renameText, setRenameText] = useState('');
  const [smart, setSmartOn] = useState(true);
  const [fastTopic, setFastTopic] = useState(true);          // topic <name>: start reading at once from the source (no waiting for the AI)
  const reqRef = useRef(0);
  const [working, setWorking] = useState('');
  const [asking, setAsking] = useState(false);
  const qRef = useRef<{ parts: string[]; timer: any } | null>(null);   // a spoken question being dictated (ends with "okay")
  const choicesRef = useRef<string[] | null>(null);        // the 3 options waiting for a tap / "one, two, three"
  const choiceMarks = useRef(5);
  const choiceExact = useRef(false);            // the 3 options belong to an "exact" request
  const choiceSpeaking = useRef(false);
  const [heard, setHeard] = useState('');                  // last thing the mic heard (so a mis-heard command is visible)
  useEffect(() => { if (!heard) return; const t = setTimeout(() => setHeard(''), 9000); return () => clearTimeout(t); }, [heard]);
  const askedDl = useRef(false);
  const [showTtsPrompt, setShowTtsPrompt] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [awake, setAwake] = useState(true);
  const [assistOn, setAssistOn] = useState(false);          // Assistant mode: the floating bubble
  const [overlayOk, setOverlayOk] = useState(false);        // "display over other apps" is allowed
  const [facts, setFacts] = useState<Fact[]>([]);           // what the assistant was asked to remember
  const [agentMsg, setAgentMsg] = useState('');             // result of the provider check
  const [announceOn, setAnnounceOn] = useState(false);     // speak new notifications of the allowed apps (off by default)
  const [announceApps, setAnnounceApps] = useState('');     // allowed app names, comma separated
  const [notifOk, setNotifOk] = useState(false);            // Notification access is allowed in Android settings
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
  const dbIds = useRef<Record<number, number>>({});          // screen id -> database id of the same message
  const waitSave = useRef<Record<number, string>>({});       // a card saved before its database id was known
  const saveT = useRef<Record<number, any>>({});
  const [liveId, setLiveId] = useState(0);                   // the topic card that is being read now (shows the highlight)
  const push = (who: Msg['who'], text: string): number => {
    const id = idRef.current++;
    setMsgs((m) => [...m, { id, who, text }]);
    if (text.startsWith(TOPIC)) setLiveId(id);
    if (chatRef.current) addMsg(chatRef.current, who, text).then((dbId) => {
      dbIds.current[id] = dbId;
      const w = waitSave.current[id]; if (w) { delete waitSave.current[id]; setMsgData(dbId, w).catch(() => {}); }
      refreshChats();
    }).catch(() => {});
    return id;
  };
  // keep the full points (and the like) inside the card message
  const saveCard = (id: number, d: CardData) => {
    setMsgs((m) => m.map((x) => (x.id === id ? { ...x, data: d } : x)));
    clearTimeout(saveT.current[id]);
    saveT.current[id] = setTimeout(() => {
      const json = JSON.stringify(d); const db = dbIds.current[id];
      if (db) setMsgData(db, json).catch(() => {}); else waitSave.current[id] = json;
    }, 500);
  };
  const showChat = async (id: number) => {
    chatRef.current = id; setChatId(id); rowY.current = {}; choicesRef.current = null; setLiveId(0);
    refresh();                                              // each chat shows only its own sources
    const m = await loadMsgs(id);
    idRef.current = (m.length ? Math.max(...m.map((x) => x.id)) : 0) + 1;
    dbIds.current = {}; waitSave.current = {};
    m.forEach((x) => { dbIds.current[x.id] = x.id; });
    setMsgs(m.map((x) => ({ id: x.id, who: x.who, text: x.text, data: x.text.startsWith(TOPIC) ? parseCard(x.data) : undefined })));
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
    const un4 = subscribeStt(() => force((x) => x + 1));
    (async () => {
      await cleanupStuck().catch(() => {});
      initLlm().catch(() => {});
      initTts().catch(() => {});
      initStt().catch(() => {});
      await R.loadSettings();                         // speed, pause, language, repeat lines, sound boost: same in every chat
      const prompted = await getMeta('tts_prompted').catch(() => '');
      if (prompted !== '1') setShowTtsPrompt(true);
      await loadGemini(); setHasKey(hasGeminiKey()); setGemModel(gem.model);
      await loadCloud(); setProv(cloud.provider); syncDrafts(cloud.provider); setCloudTick((n) => n + 1);
      setAssistOn(assistantOn()); setOverlayOk(overlayGranted()); listFacts().then(setFacts).catch(() => {});
      setSmartOn((await getMeta('smart').catch(() => '1')) !== '0');
      setFastTopic((await getMeta('fast_topic').catch(() => '1')) !== '0');
      setAnnounceOn((await getMeta('announce').catch(() => '')) === '1'); setAnnounceApps((await getMeta('announce_apps').catch(() => '')) || ''); setNotifOk(notifEnabled());
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
    return () => { un(); un2(); un3(); un4(); };
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
    setChoiceNames(names);
    choicesRef.current = names; choiceMarks.current = marks; choiceExact.current = exactMode; rowY.current = {};
    push('app', CHOICE + JSON.stringify(names));
    const line = 'Did you mean: ' + names.map((n) => n.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ')).join(', or ') + '?';   // only the first words of each option: long titles made this line 20 s long   // no number words spoken: the mic cannot mistake the app's own voice for your "one / two / three", so you may answer at any moment
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
  const toggleFast = (v: boolean) => { setFastTopic(v); setMeta('fast_topic', v ? '1' : '0').catch(() => {}); };
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
  // ---- chunk-by-chunk streaming: every point the model finishes is shown and read at once -------------------------------
  // The FIRST point starts the reading; each new point is added while the voice goes on (the reader waits for the next one if it catches up).
  type Sess = { id: number; name: string; intro: string; label: string; pts: Point[]; started: boolean };
  const newStream = (id: number, name: string, intro: string, label = ''): Sess => ({ id, name, intro, label, pts: [], started: false });
  const feedStream = (se: Sess, p: Point) => {
    se.pts.push(p);
    if (se.started) { R.appendPoints([p]); return; }
    // reading starts with the FIRST point the model finishes; the reader then waits (growing) for each next point
    se.started = true;
    rowY.current = {}; cardY.current = null; follow.current = true;
    if (se.label) push('app', se.label);
    push('app', TOPIC + se.name);
    R.startTopic(se.id, se.name, [...se.pts], se.intro, true);
  };
  const openTopic = async (qRaw: string, exact = false, marksIn = 5) => {
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    const sm = exact ? { q: qRaw, marks: marksIn } : splitMarks(qRaw);
    const f = await findTopic(sm.q, chatRef.current, exact);
    if (f.kind === 'pick' && f.options?.length) { showChoices(f.options, sm.marks); return; }
    if (!f.found) { notFound(f.alts); return; }
    choicesRef.current = null;
    const myReq = ++reqRef.current;

    const useLlm = smart && !fastTopic && llm.phase === 'ready';        // fast topics: no AI wait, the reading starts in about a second
    if (smart && !fastTopic && llm.phase === 'none' && !askedDl.current) offerDownload();
    let pts = await getNotes(f.id, useLlm ? 'llm' : 'rule', sm.marks);   // id 0 (part of a big file) is never cached
    if (!pts && useLlm) {
      makingRef.current = true; setWorking('Writing notes…');
      const se = newStream(f.id, f.name, `Topic ${f.name}.`);
      let r: any = { pts: null, notInSource: false };
      try {
        r = await llmNotes(f.name, f.body, sm.marks, (i, n) => { if (n > 1) setWorking(`Writing notes… part ${i}/${n}`); }, (p) => feedStream(se, p)).catch(() => ({ pts: null, notInSource: false }));
      } finally {
        if (se.started) R.endStream();                                    // nothing more is coming: the reading may finish
        makingRef.current = false; setWorking('');
      }
      if (r.cancelled) { if (reqRef.current === myReq) push('app', 'Stopped. Say or type the topic again.'); return; }   // never leave an empty reply
      if (r.notInSource) { notFound(f.alts); return; }                   // the model found nothing about it in the source
      if (r.pts) { await saveNotes(f.id, r.pts, 'llm', sm.marks); if (se.started) return; pts = r.pts; }   // already on screen and being read when it was streamed
      else if (se.started) return;                                       // the reading started on the first point; never start a second reading on top of it
    }
    if (!pts || !pts.length) { pts = makeNotes(f.name, f.body); await saveNotes(f.id, pts, 'rule', 0); }
    if (!pts || !pts.length) { push('app', `Found “${f.name}” but there is no readable text in it.`); return; }
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
        label = web ? 'Explained from my own knowledge + the web (not from your sources)' : 'Explained from my own knowledge (not from your sources)';
        const se = newStream(0, 'Explain: ' + name, `Explaining ${name}.`, label);
        const r = await llmExplain(name, explicitMarks ? sm.marks : 0, web?.text || '', (i, n, t) => setWorking(`Writing ${i}/${n}: ${t}…`), (p) => feedStream(se, p));
        if (se.started) R.endStream();
        if (r.cancelled) return;
        if (se.started) return;                                           // sections were shown and read as they were written
        pts = r.pts;
      }
      if (!pts && web) { pts = makeNotes(web.title, web.text); label = 'From the web (Wikipedia). The smart model is not ready yet'; }
      if (!pts) { push('app', 'I cannot explain this now: no internet, and the smart model is not downloaded (Models).'); return; }
      rowY.current = {}; cardY.current = null;
      push('app', label);
      const nm = 'Explain: ' + name;
      push('app', TOPIC + nm);
      R.startTopic(0, nm, pts, `Explaining ${name}. ${pts.length} points.`);
    } finally { R.endStream(); makingRef.current = false; setWorking(''); }
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
      const labelOf = (b: Basis) => b === 'source' ? 'Answer from your sources'
        : b === 'mixed' ? 'Answer: your sources + my own knowledge'
        : 'Not in your sources. Answered from my own knowledge';
      if (useLlm) {
        const se = newStream(0, 'Answer: ' + (q.length > 60 ? q.slice(0, 57) + '...' : q), 'Answer.');
        const r = await llmAnswer(q, chunks, (p) => feedStream(se, p));
        if (se.started) R.endStream();
        if (r.cancelled) return;
        if (se.started) { push('app', labelOf(r.basis)); return; }       // the answer was shown and read while it was written; how much came from your sources is said at the end
        pts = r.pts; basis = r.basis;
      }
      let label = labelOf(basis);
      if (!pts && chunks.length) { pts = makeNotes(chunks[0].name, chunks[0].body); label = 'The smart model is not ready. Closest part of your sources'; }
      if (!pts) {
        const w = await wikiLookup(q).catch(() => null);
        if (w) { pts = makeNotes(w.title, w.text); label = 'Nothing in your sources. From the web (Wikipedia)'; }
      }
      if (!pts) { push('app', 'I could not answer: nothing in your sources, and the smart model is not downloaded (Models).'); return; }
      rowY.current = {}; cardY.current = null;
      push('app', label);
      const nm = 'Answer: ' + (q.length > 60 ? q.slice(0, 57) + '...' : q);
      push('app', TOPIC + nm);
      R.startTopic(0, nm, pts, `Answer. ${pts.length} points.`);
    } finally { R.endStream(); makingRef.current = false; setWorking(''); }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // search <anything>: live Google search through Gemini. Online only; the answer is shown and read point by point like any topic.
  // current provider's drafts (model / URL) follow the provider that is open in Models
  const syncDrafts = (id: ProviderId) => {
    setKeyDraft(''); setKeyShown(false); setProvOpen(false);
    if (id !== 'gemini') { setModelDraft(cloud.model[id] || ''); setUrlDraft(cloud.customUrl || ''); }
  };
  const pickProvider = async (id: ProviderId) => { setProv(id); await saveProvider(id); syncDrafts(id); };
  const providerOn = (id: ProviderId) => (id === 'gemini' ? hasKey : cloudReady(id));
  const saveKey = async () => {
    const k = keyDraft.trim();
    if (prov === 'gemini') {
      if (k.length < 20) { Alert.alert('Gemini API key', 'That key looks too short. Copy the full key from Google AI Studio.'); return; }
      await saveGeminiKey(k); setHasKey(true); setKeyDraft(''); setKeyShown(false); Keyboard.dismiss();
      ToastAndroid.show('Gemini key saved', ToastAndroid.SHORT);
      return;
    }
    const id = prov;
    if (k) {
      if (k.length < 8) { Alert.alert('API key', 'That key looks too short. Copy the full key.'); return; }
      await saveCloudKey(id, k);
    }
    const m = modelDraft.trim();
    if (m) await saveCloudModel(id, m); else if (id !== 'custom') await saveCloudModel(id, DEFAULT_MODEL[id]);
    if (id === 'custom') {
      const u = urlDraft.trim();
      if (!/^https?:\/\//i.test(u)) { Alert.alert('Custom API', 'Base URL must start with https:// (example: https://api.groq.com/openai/v1)'); return; }
      await saveCustomUrl(u);
      if (!m) { Alert.alert('Custom API', 'Type the model name too (example: llama-3.3-70b-versatile).'); return; }
    }
    setKeyDraft(''); setKeyShown(false); setCloudTick((n) => n + 1); Keyboard.dismiss();
    ToastAndroid.show('Saved', ToastAndroid.SHORT);
  };
  const removeKey = () => {
    const nm = PROVIDERS.find((x) => x.id === prov)?.label || 'API';
    Alert.alert(`Remove ${nm} key?`, 'Search with this provider stops working until you add a key again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        if (prov === 'gemini') { await saveGeminiKey(''); setHasKey(hasGeminiKey()); }
        else { await saveCloudKey(prov, ''); setCloudTick((n) => n + 1); }
      } }]);
  };
  const loadFreeModels = async () => {
    setOrBusy(true);
    try { setOrList(await openRouterFreeModels()); }
    catch { ToastAndroid.show('Could not load the list. Check internet.', ToastAndroid.SHORT); }
    setOrBusy(false);
  };
  const useModel = async (id: string) => { setModelDraft(id); if (prov !== 'gemini') { await saveCloudModel(prov, id); setCloudTick((n) => n + 1); } };
  const pickGemModel = async (m: GeminiModelId) => { setGemModel(m); await saveGeminiModel(m); };

  const searchTopic = async (qRaw: string, mode: 'short' | 'long' = 'short') => {
    const sm = mode === 'long' ? splitMarks(qRaw) : { q: qRaw.trim(), marks: 10 };      // "search long anemia 5 marks"; no marks said = 10
    const marks = mode === 'long' && /\b(\d{1,2}|two|three|four|five|six|seven|eight|ten|twelve)\s*(?:marks?|m)\b/i.test(qRaw) ? sm.marks : 10;
    const q = sm.q.trim();
    if (!q) { push('app', 'Say or type: search <topic>, or search long <topic> for a full exam answer'); return; }
    if (!(await freeUp())) { push('app', 'Still busy, try again in a moment.'); return; }
    if (!hasGeminiKey() && !cloudReady(cloud.provider)) { push('app', 'Search needs an API key. Add one in Models > Cloud API (top right).'); setShowModels(true); return; }
    const myReq = ++reqRef.current;
    let offlineFallback = false;                                       // Gemini limit used up -> answer with the offline model after this block
    makingRef.current = true; setWorking(mode === 'long' ? 'Searching Google live… writing full notes' : 'Searching Google live…');
    try {
      const pts = await searchWithCloud(q, { mode, marks });
      if (reqRef.current !== myReq) return;                            // a newer request took over
      rowY.current = {}; cardY.current = null;
      const nm = (mode === 'long' ? 'Search (long): ' : 'Search: ') + (q.length > 60 ? q.slice(0, 57) + '...' : q);
      const live = /^Google/.test(searchInfo.via);
      push('app', searchInfo.fromCache ? 'Saved answer from your earlier search (no API call used). Not from your sources'
        : live ? (mode === 'long' ? `Live Google search (Gemini): full ${marks}-mark answer. Not from your sources` : 'Live Google search (Gemini): short answer. Not from your sources')
        : `${searchInfo.via}: ${mode === 'long' ? `full ${marks}-mark answer` : 'short answer'} from the model's own knowledge. NOT live Google and not from your sources, so double-check important facts`);
      push('app', TOPIC + nm);
      R.startTopic(0, nm, pts, `Search. ${pts.length} points.`);       // shown 1, 2, 3... and read aloud at once
    } catch (e: any) {
      const k = e instanceof GeminiError ? e.kind : 'http';
      if (k === 'cancelled') { if (reqRef.current === myReq) push('app', 'Stopped.'); return; }
      if (k === 'nokey' || k === 'badkey') {
        push('app', k === 'nokey' ? 'Search needs an API key. Add one in Models > Cloud API (top right).' : 'The API key was not accepted. Check it in Models > Cloud API.');
        setShowModels(true);
      } else if (k === 'quota') {
        if (smart && llm.phase === 'ready') {
          offlineFallback = true;
          push('app', 'The free limit of your cloud API is used up for now. Answering with the offline model instead. This is NOT live search, so double-check important facts');
        } else push('app', 'The free limit of your cloud API is used up for now (it usually resets daily). Try again later, or pick another provider in Models > Cloud API. Download the smart model in Models to get offline answers when this happens');
      }
      else {
        const msg = 'Could not get a search answer. Check internet, or the model name in Models > Cloud API.';
        push('app', msg);
        ToastAndroid.show(msg, ToastAndroid.LONG);
      }
    } finally { makingRef.current = false; setWorking(''); }
    if (offlineFallback) await explainTopic(mode === 'long' ? qRaw : `${q} 3 marks`);
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
    choicesRef.current = null; setChoiceNames(null);
    if (choiceExact.current) { choiceExact.current = false; await exactTopic(nm, true); return; }
    await openTopic(nm, true, choiceMarks.current);
  };

  // ---- assistant: its replies are shown in chat AND spoken; the bubble draws the same state ----
  const sayAgent = (text: string) => {
    follow.current = true; push('app', text); bubbleReply(text);
    const bn = /[\u0980-\u09FF]/.test(text);
    const end = () => { bubbleOverride(null); armPending(); setTimeout(() => restartListening(150), 200); };   // a fresh mic: it must not carry the app's own voice into the next sentence
    speak(text, { lang: bn ? 'bn' : 'en', voice: (bn ? R.state.voiceBn : R.state.voiceEn) || undefined, rate: 0.95, onStart: () => bubbleOverride('speaking'), onDone: end, onStopped: end, onError: end });
  };
  const agentCtx = {
    history: () => msgsRef.current.map((m) => ({ who: m.who, text: m.text })),
    exec: (t: string) => { execRef.current(t, 'text'); },
    askNotes: (q: string) => { answerQuestion(q); },
    reply: sayAgent,
    state: (x: 'thinking' | 'idle') => bubbleOverride(x === 'thinking' ? 'thinking' : null),
  };
  const runAgentFor = async (text: string) => {
    try { R.pause(); } catch {}                                       // new request: nothing old keeps talking
    stopSpeak();
    await runAgent(text, agentCtx);
    if (hasPending()) wakeRef.current.until = Date.now() + 18000;     // the "haan / na" may come with the screen off: no wake word needed for it
  };
  const exec = async (text: string, via: 'voice' | 'text' = 'voice') => {
    if (!text.trim()) return;
    bubbleHeard(text);
    // a call / SMS is waiting for "haan" / "na": checked BEFORE any other routing; anything else said drops the old question
    const verdict = confirmVerdict(text);
    if (verdict) { follow.current = true; push('you', text); await resolvePending(verdict, agentCtx); return; }
    if (hasPending()) dropPending();
    const c = parse(text);
    follow.current = true;
    // playback commands act FIRST (no waiting for the database); the chat history is written right after
    switch (c.t) {
      case 'repeat': R.repeat(c.arg, c.mode); break;
      case 'continue': R.resume(); break;
      case 'pause': R.pause(); break;
      case 'stop': R.stop(); cancelGen(); cancelAgent(); bubbleOverride(null); choicesRef.current = null; setWorking(''); break;
      case 'next': R.next(); break;
      case 'prev': R.prev(); break;
      case 'slower': R.setRate(-0.1); break;
      case 'faster': R.setRate(0.1); break;
    }
    if (c.t === 'topic' || c.t === 'exact' || c.t === 'explain' || c.t === 'search') { try { R.pause(); } catch {} stopSpeak(); choicesRef.current = null; }   // new request: nothing old keeps talking
    if (c.t === 'question' && via === 'voice') { startQuestion(c.q); return; }
    push('you', text);
    if (c.t === 'topic') await openTopic(c.q);
    else if (c.t === 'exact') await exactTopic(c.q);
    else if (c.t === 'explain') await explainTopic(c.q);
    else if (c.t === 'search') await searchTopic(c.q, c.mode);
    else if (c.t === 'question') { if (c.q) await answerQuestion(c.q); else push('app', 'Type your question and send it.'); }
    else if (c.t === 'pick') {
      const names = choicesRef.current;
      if (!names || !names[c.n - 1]) push('app', 'Nothing to choose.');
      else await pickName(names[c.n - 1]);
    } else if (c.t === 'unknown') {
      // anything that is not a study command goes to the assistant (agent) when a model is set up; otherwise the old behaviour:
      // typed text is a normal chat answered from your sources + the model's own knowledge.
      // (Spoken words only get here through agentVoice: talking nearby never triggers anything.)
      if (via === 'text' && (isGreeting(text) || !queryTokens(text).length)) push('app', 'Hi! Say or type: topic <name>, exact <name>, explain <name>, or ask a question.');
      else if (agentReady()) await runAgentFor(text);
      else if (via === 'text') await answerQuestion(text);
      else push('app', 'Try: topic <name>, exact <name>, explain <name>, question ... okay, pause, next, repeat 2, continue.');
    }
  };
  // floating Topics: the topics that were found in this chat's sources when the files were added; tapping one runs "exact <topic>"
  const toggleTopics = async () => {
    if (showTopics) { setShowTopics(false); return; }
    try {
      const l = await listTopics(chatRef.current);
      setTopicList([...l.filter((x) => x.pri === 0), ...l.filter((x) => x.pri !== 0)]);
    } catch { setTopicList([]); }
    setTopicQ(''); setShowTopics(true);
  };
  const pickTopicName = (name: string) => {
    setShowTopics(false); setTopicQ(''); follow.current = true;
    exec(`exact ${name}`, 'text'); keepFocus();
  };
  const send = () => { const t = input.trim(); if (!t) return; setInput(''); exec(t, 'text'); keepFocus(); };

  const addFiles = async () => {
    setBusy(true);
    try { const r = await pickAndImport(refresh, chatRef.current); if (r) push('app', r); } catch (e: any) { push('app', 'Import failed: ' + e.message); }
    setBusy(false); refresh();
  };

  const execRef = useRef(exec);
  execRef.current = exec;
  // Mic stays on; only real commands are accepted, and anything the app is itself speaking is ignored
  // ---- the mic hears the app's OWN voice: never let that become a command -------------------------------------------
  const tok = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const stem = (w: string) => w.slice(0, 5);
  const heardSelf = (t: string) => {
    if (R.state.status !== 'reading') return false;
    const ht = tok(t);
    if (ht.length < 3) return false;
    if (R.getSpoken().toLowerCase().includes(t.toLowerCase().trim())) return true;
    const sp = new Set(tok(R.getSpoken()).map(stem));
    return ht.filter((w) => sp.has(stem(w))).length / ht.length >= 0.75;      // misheard by a word or two: still the app's voice
  };
  // The app's OWN reading that the mic picked up (even misheard by a word or two): never shown as "heard" and never a command.
  // A real command (stop / next / topic ... / tuik) is not hidden, only plain reading words are.
  const ownVoice = (t: string) => {
    if (!t || R.state.status !== 'reading') return false;
    if (parse(t).t !== 'unknown') return false;
    const ht = tok(t);
    if (ht.length < 2) return false;
    const sp = new Set(tok(R.getSpoken()).map((w) => w.slice(0, 4)));
    return ht.filter((w) => sp.has(w.slice(0, 4))).length / ht.length >= 0.5;
  };
  // "Topic X. 6 points." is spoken by the app itself; the mic hears "topic X" and used to open the topic AGAIN, over and over
  // (so the lines were never reached). While that intro plays (and for 2.5 s after) a topic / exact / explain command made only of its words is ignored.
  const introEcho = (q: string) => {
    const intro = R.introActive();
    if (!intro) return false;
    const it = new Set(tok(intro).map(stem));
    const qt = tok(q).filter((w) => !/^(?:point|points)$/.test(w));
    return qt.length > 0 && qt.filter((w) => it.has(stem(w))).length / qt.length >= 0.7;
  };
  // ordinary words that are also playback aliases (hold / wait / back / last / start / play ...): while reading, only a command when the app did not say that word itself
  const weakEcho = (a: string) => R.state.status === 'reading' && Date.now() - wakeRef.current.fresh > 3000 && (R.wordEcho(a) || isWeakCmd(a)) && (R.wordEcho(a) || (() => { const sp = new Set(tok(R.getSpoken())); const w = tok(a); return w.length > 0 && w.every((x) => sp.has(x)); })());
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
  const nameFromAlts = (alts: string[]) => { for (const a of alts) { const n = pickByName(stripChoiceEcho(a)); if (n && n <= (choicesRef.current?.length || 3)) return n; } return 0; };   // you said the option's name
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
        if (weakEcho(a)) continue;                                       // the app's own word, not a command
        if (dupCmd(k.t)) return true;
        if (k.t === 'stop') { silence(); }
        execRef.current(a); return true;
      }
      if (['topic', 'exact', 'explain'].includes(k.t) && (k as any).q?.trim() && !heardSelf(a) && !introEcho((k as any).q)) {
        if (partial) continue;                                           // partial: the stable-words timer below decides when it is finished
        if (dupCmd(k.t + (k as any).q)) return true;
        silence(); execRef.current(a); return true;
      }
    }
    // a command word glued to the end of the app's own speech ("...cell membrane stop")
    for (const a of alts) { const tc = tailCmd(a); if (tc && !dupCmd('tail' + tc)) { if (tc === 'stop') silence(); execRef.current(tc); return true; } }
    return false;
  };
  // ---- WAKE WORD "tuik": app in background / phone locked -> a command only counts after "tuik" -------------------------
  const [awakeUI, setAwakeUI] = useState(false);
  const wakeRef = useRef<{ until: number; paused: boolean; timer: any; fresh: number }>({ until: 0, paused: false, timer: null, fresh: 0 });
  const disarm = (resumeReading: boolean) => {
    const w = wakeRef.current; clearTimeout(w.timer); w.timer = null;
    const was = w.paused; w.until = 0; w.paused = false; setAwakeUI(false);
    if (was && resumeReading && R.state.status === 'paused') R.resume();
  };
  const armWake = (ms = 9000) => {
    const w = wakeRef.current;
    if (!w.until && R.state.status === 'reading') { w.paused = true; try { R.pause(); } catch {} }   // so your command is heard clearly
    w.until = Date.now() + ms; setAwakeUI(true);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => disarm(true), ms);                  // nothing said: carry on reading
  };
  // returns the text(s) to treat as a command, or null = not meant for the app
  // "tuik" works in EVERY state now: alone it pauses the reading and listens 9 s for the command (so you see / hear it worked);
  // in the background / locked it is also REQUIRED before a command. It is found even when glued behind the app's own voice.
  const wakeGate = (alts: string[], partial: boolean): string[] | null => {
    const w = wakeRef.current;
    const cut = alts.map((a) => splitWake(a, R.getSpoken()));
    // Word by word reading: the mic hears each lone word, and a lone short word is very often misheard as "stop" / "next" / "pause"
    // (that stopped the reading by itself). So while the app reads word by word, a command needs "tuik" first, like in the background.
    const wordMode = R.state.wordGap > 0 && R.state.status === 'reading';
    const bg = (R.state.wakeOn && AppState.currentState !== 'active') || wordMode;
    const clearArm = () => { clearTimeout(w.timer); w.timer = null; w.paused = false; w.until = 0; setAwakeUI(false); };
    const withRest = cut.filter((c) => c.hit && c.rest).map((c) => c.rest);
    if (withRest.length) {                                           // "tuik pause" / "...reading tuik pause"
      const slowFast = withRest.some((r) => ['slower', 'faster'].includes(parse(r).t));
      const resumeAfter = slowFast && w.paused;
      w.fresh = Date.now();                                          // said after "tuik": never mistaken for the app's own word
      if (!partial) disarm(false); else clearArm();
      if (resumeAfter) setTimeout(() => { if (R.state.status === 'paused') R.resume(); }, 400);
      return withRest;
    }
    if (cut.some((c) => c.hit)) { armWake(); return null; }          // just "tuik": listen for the command
    if (!bg) {                                                       // app open: no wake word needed
      if (w.until && alts.some((a) => parse(a).t !== 'unknown')) clearArm();       // the command after "tuik" arrived
      return alts.filter(Boolean).length ? alts : null;
    }
    const talking = !!choicesRef.current || !!qRef.current;          // options waiting / question being dictated: already in a conversation
    if (Date.now() < w.until || talking) {
      const known = alts.some((a) => parse(a).t !== 'unknown');
      if (known) {
        const slowFast = alts.some((a) => ['slower', 'faster'].includes(parse(a).t));
        const resumeAfter = slowFast && w.paused;
        clearArm();
        if (resumeAfter) setTimeout(() => { if (R.state.status === 'paused') R.resume(); }, 400);
      }
      return alts;
    }
    return null;                                                     // background speech without "tuik": ignore
  };
  // A spoken sentence that is not a study command reaches the assistant ONLY when the user called it ("tuik ..." or the bubble was tapped),
  // and never when it is the app's own voice (reading, a spoken reply) or a lone word: so room noise can never start a model call.
  const agentVoice = (t: string) => {
    const w = wakeRef.current;
    const called = Date.now() < w.until || Date.now() - w.fresh < 4000;
    if (!called || !agentReady() || choicesRef.current || qRef.current || choiceSpeaking.current) return;
    if (ttsState.activeSpeaker !== 'none' || ownVoice(t) || heardSelf(t) || echoOfReply(t) || !looksLikeRequest(t)) return;
    disarm(false);
    execRef.current(t);
  };
  const onVoice = (alts0: string[]) => {
    if (!alts0.length) return;
    const g = wakeGate(alts0, false);
    if (!g) { if (!ownVoice(alts0[0])) setHeard(alts0[0].slice(0, 40) + '  (ignored: say "tuik" first)'); return; }
    let alts = g;
    if (!ownVoice(alts[0])) setHeard(alts[0].slice(0, 60));          // the app's own reading is not shown as something you said
    clearStable();
    if (hasPending() && ttsState.activeSpeaker === 'none') { const a = alts.find((x) => confirmVerdict(x)); if (a) { execRef.current(a); return; } }   // "haan" / "na" to a call or SMS question
    if (hardCmd(alts, false)) { restartListening(60); return; }     // commands first, in every state
    if (choiceSpeaking.current) return;                              // otherwise the app's own voice: ignore
    if (qRef.current) { feedQuestion(alts[0]); return; }
    for (const a of alts) { const tc = tailCmd(a); if (tc) { execRef.current(tc); restartListening(150); return; } }
    if (choicesRef.current) {
      const n = loosePick(alts) || nameFromAlts(alts);
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
      const a = alts.slice(1).find((x) => { const k = parse(x); return (['topic', 'exact', 'explain'].includes(k.t) && !introEcho((k as any).q || '')) || k.t === 'question' || (k.t === 'pick' && !!choicesRef.current) || (short && FAST.has(k.t) && !weakEcho(x)); });
      if (!a) { agentVoice(alts[0]); return; }
      t = a; c = parse(a);
    }
    if (c.t === 'pick' && !choicesRef.current) return;             // "one / two" only means something while options are waiting
    if (['topic', 'exact', 'explain'].includes(c.t) && introEcho((c as any).q || '')) return;
    if (FAST.has(c.t) && weakEcho(t)) return;
    if (heardSelf(t)) return;
    execRef.current(t);
  };
  const onPartial = (t0: string) => {
    const g = wakeGate([t0], true); if (!g) return false;
    const t = g[0];
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
      if (introEcho((k as any).q)) return false;                     // the app's own "Topic X" intro
      const snap = t;                                                // same words for 0.7 s = finished: go now instead of waiting for the end-of-speech silence
      stableT.current = setTimeout(() => { stableT.current = null; if (qRef.current || introEcho((k as any).q) || dupCmd(k.t + (k as any).q)) return; markHandled(); silence(); execRef.current(snap); }, 600);
      return false;
    }
    if (!FAST.has(k.t) && !(k.t === 'pick' && !!choicesRef.current)) return false;      // "one / two / three" runs the moment it is heard, like stop / pause
    if (FAST.has(k.t) && weakEcho(t)) return false;
    execRef.current(stripChoiceEcho(t));
    return true;
  };
  const mic = async () => {
    keepFocus();
    if (listening) { endQ(); await stopListening(); return; }
    const g = await PermissionsAndroid.request('android.permission.RECORD_AUDIO' as any);
    if (g !== 'granted') return;
    const ok = await startListening(onVoice, () => (R.state.lang === 'bn' ? 'bn-BD' : 'en-US'), setListening, onPartial);
    if (!ok) push('app', sttState.google ? 'Google speech is not available on this phone.' : 'Offline model not ready. Download it in Settings, or turn Google speech on.');
  };
  useEffect(() => () => { stopListening(); }, []);
  // floating bubble: tap = the same as the mic button (plus a 14 s window in which the assistant listens, no wake word needed)
  const micRef = useRef(mic); micRef.current = mic;
  const armRef = useRef(armWake); armRef.current = armWake;
  const listeningRef = useRef(false); listeningRef.current = listening;
  useEffect(() => onBubbleTap(() => { const was = listeningRef.current; micRef.current(); if (!was) armRef.current(14000); }), []);
  useEffect(() => { bubbleListening(listening); }, [listening]);
  // bubble menu (chevron on the bubble): registered once; every action calls the same functions as the voice commands
  useEffect(() => registerBubbleMenu({
    talk: () => { const was = listeningRef.current; micRef.current(); if (!was) armRef.current(14000); },
    exec: (t) => { execRef.current(t, 'text'); },
    stopAll: () => { R.stop(); cancelGen(); cancelAgent(); stopSpeak(); dropPending(); bubbleOverride(null); choicesRef.current = null; setWorking(''); },
    pause: () => R.pause(), resume: () => { follow.current = true; R.resume(); }, next: () => R.next(), prev: () => R.prev(),
    playing: () => R.state.status === 'reading',
    topics: async () => (await listTopics(chatRef.current)).map((x) => x.name),
    last: () => msgsRef.current.filter((m) => !m.text.startsWith(TOPIC)).slice(-3).map((m) => (m.who === 'you' ? 'You: ' : 'AI: ') + m.text.slice(0, 140)),
    hide: () => { setAssistantMode(false); setAssistOn(false); },
  }), []);
  useEffect(() => { refreshBubbleMenu(); }, [R.state.status]);        // the Play / Pause label follows the reader (debounced in bubble.ts)
  // announce notifications: a NEW one from an allowed app is spoken once - never while reading, never over the app's own voice
  const announceRef = useRef({ on: false, apps: [] as string[] });
  announceRef.current = { on: announceOn, apps: parseAllow(announceApps) };
  useEffect(() => startAnnouncer({
    enabled: () => announceRef.current.on, apps: () => announceRef.current.apps,
    canSpeak: () => R.state.status !== 'reading' && ttsState.activeSpeaker === 'none',
    say: (text) => {
      noteSpoken(text); bubbleReply(text);
      const bn = /[\u0980-\u09FF]/.test(text);
      const end = () => { bubbleOverride(null); setTimeout(() => restartListening(150), 200); };
      speak(text, { lang: bn ? 'bn' : 'en', voice: (bn ? R.state.voiceBn : R.state.voiceEn) || undefined, rate: 0.95, onStart: () => bubbleOverride('speaking'), onDone: end, onStopped: end, onError: end });
    },
  }), []);
  const toggleAnnounce = (v: boolean) => {
    if (v && !notifEnabled()) {
      Alert.alert('Notification access', 'To hear new notifications, turn on Sheet.md assistant on the next screen, then come back and switch this on. If it is greyed out: App info > the three dots > Allow restricted settings.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Open settings', onPress: notifOpenSettings }]);
      return;
    }
    setAnnounceOn(v); setMeta('announce', v ? '1' : '0').catch(() => {});
  };
  const saveAnnounceApps = (t: string) => { setAnnounceApps(t); setMeta('announce_apps', t).catch(() => {}); };
  useEffect(() => {                                                    // back from the Android overlay-permission screen
    const sub = AppState.addEventListener('change', (st2) => { if (st2 === 'active') { setOverlayOk(overlayGranted()); setNotifOk(notifEnabled()); } });
    return () => sub.remove();
  }, []);
  const toggleAssistant = (v: boolean) => {
    if (v && !overlayGranted()) {
      Alert.alert('Display over other apps', 'The floating bubble needs this permission. Turn it on for Sheet.md on the next screen, then come back and switch Assistant mode on.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Open settings', onPress: askOverlay }]);
      return;
    }
    setAssistantMode(v); setAssistOn(v);
  };
  useEffect(() => { if (showSet) { setOverlayOk(overlayGranted()); setNotifOk(notifEnabled()); listFacts().then(setFacts).catch(() => {}); setAgentMsg(''); } }, [showSet]);

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
    if (!listening && s.status === 'idle' && !working && !assistOn) { stopService(); return; }      // Assistant mode keeps the service (and the bubble) alive
    const pt = s.points[s.idx];
    const text = (s.status === 'idle' && working) ? working : s.status === 'idle' ? (awakeUI ? 'Listening… say your command' : assistOn && !listening ? 'Assistant ready: tap the bubble' : s.wakeOn ? 'Say “tuik” then a command' : 'Listening for commands')
      : `${s.topic} — point ${pt?.n ?? 0}/${s.points.length}${s.status === 'paused' ? ' (paused)' : ''}`;
    updateService('Sheet.md', text, s.status === 'reading', listening);
  }, [s.status, s.idx, s.topic, listening, awakeUI, s.wakeOn, !!working, assistOn]);

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

  useEffect(() => {
    if (!working || !follow.current) return;
    const tm = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 150);
    return () => clearTimeout(tm);
  }, [!!working]);

  // ---- topic replies: every reply keeps its FULL points on screen (older ones are not collapsed, not hidden) ----
  const msgsRef = useRef<Msg[]>([]); msgsRef.current = msgs;
  // the card that is being read now (highlight + follow). Others are shown complete from their saved points.
  const liveMsgId = (() => {
    if (liveId && msgs.some((x) => x.id === liveId)) return liveId;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].text.startsWith(TOPIC) && msgs[i].text.slice(TOPIC.length) === s.topic) return msgs[i].id;
    return 0;
  })();
  const liveMsgRef = useRef(0); liveMsgRef.current = liveMsgId;
  // save the points of the card being read into its message (also while the model is still streaming new points)
  useEffect(() => {
    if (!s.points.length) return;
    const m = msgs.find((x) => x.id === liveMsgId);
    if (!m || m.text.slice(TOPIC.length) !== s.topic) return;
    const d = m.data;
    if (d && (d.pts === s.points || (d.pts.length === s.points.length && d.tid === s.topicId))) return;
    saveCard(m.id, { pts: s.points, tid: s.topicId, liked: d?.liked });
  }, [s.points, s.topic, s.topicId, liveMsgId, msgs]);
  const goPoint = useCallback((k: number) => { follow.current = true; R.goto(k); }, []);
  const setRowY = useCallback((k: number, y: number) => { rowY.current[k] = y; }, []);
  // read a saved reply (from the start, or from a tapped point)
  const playCard = useCallback((id: number, from = 0) => {
    const m = msgsRef.current.find((x) => x.id === id);
    const pts = m?.data?.pts;
    if (!m || !pts || !pts.length) return;
    if (makingRef.current) cancelGen();                                 // a new reading never mixes with notes that are still being written
    follow.current = true; rowY.current = {}; cardY.current = null;
    stopSpeak(); setLiveId(id);
    R.startTopic(m.data?.tid || 0, m.text.slice(TOPIC.length), pts, undefined, false, from);
  }, []);
  // play button under a reply: pause / resume the one being read, or start this one
  const onPlayBtn = useCallback((id: number) => {
    const m = msgsRef.current.find((x) => x.id === id); if (!m) return;
    const name = m.text.slice(TOPIC.length);
    if (liveMsgRef.current === id && R.state.topic === name && R.state.points.length) {
      if (R.state.status === 'reading') R.pause(); else { follow.current = true; R.resume(); }
    } else playCard(id, 0);
  }, [playCard]);
  const copyCard = useCallback(async (id: number) => {
    const m = msgsRef.current.find((x) => x.id === id); if (!m) return;
    const name = m.text.slice(TOPIC.length);
    const pts = m.data?.pts?.length ? m.data.pts : R.state.topic === name ? R.state.points : [];
    if (!pts.length) return;
    try { await Clipboard.setStringAsync(cardText(name, pts)); ToastAndroid.show('Copied', ToastAndroid.SHORT); }
    catch { ToastAndroid.show('Could not copy', ToastAndroid.SHORT); }
  }, []);
  const shareCard = useCallback(async (id: number) => {
    const m = msgsRef.current.find((x) => x.id === id); if (!m) return;
    const name = m.text.slice(TOPIC.length);
    const pts = m.data?.pts?.length ? m.data.pts : R.state.topic === name ? R.state.points : [];
    if (!pts.length) return;
    try { await Share.share({ message: cardText(name, pts) }); } catch { ToastAndroid.show('Could not share', ToastAndroid.SHORT); }
  }, []);
  const likeCard = useCallback((id: number) => {
    const m = msgsRef.current.find((x) => x.id === id); if (!m) return;
    const name = m.text.slice(TOPIC.length);
    const base: CardData | undefined = m.data ?? (R.state.topic === name && R.state.points.length ? { pts: R.state.points, tid: R.state.topicId } : undefined);
    if (base) saveCard(id, { ...base, liked: !base.liked });
  }, []);
  const renderMsg = (m: Msg, i: number) => {
    if (m.text.startsWith(TOPIC)) {
      const name = m.text.slice(TOPIC.length);
      const live = m.id === liveMsgId && s.points.length > 0 && s.topic === name;
      const writing = !!working && m.id === liveId;                         // still being written: no buttons yet (they appear when the reply is complete, like Claude)
      if (!live) {
        const pts = m.data?.pts;
        if (pts && pts.length) {
          return <TopicCard key={m.id} id={m.id} name={name} pts={pts} liked={!!m.data?.liked} writing={writing} onPlay={onPlayBtn} onGo={playCard} onCopy={copyCard} onShare={shareCard} onLike={likeCard} />;
        }
        // an older reply from before replies were saved: only its title is known
        return (
          <TouchableOpacity key={m.id} style={st.card} activeOpacity={0.6} onPress={() => {
            if (/^(Explain|Answer|Search)/.test(name)) ToastAndroid.show('This old reply was not saved. Ask it again.', ToastAndroid.SHORT);
            else { follow.current = true; openTopic(name, true); }
          }}>
            <View style={st.cardHead}><Icon n="file" size={18} /><Text style={st.cardT}>{name}</Text></View>
          </TouchableOpacity>);
      }
      return (
        <View key={m.id} style={st.card} onLayout={(e) => { cardY.current = e.nativeEvent.layout.y; }}>
          <Text style={st.topicT}>{s.topic}</Text>
          {s.points.map((p, k) => {
            const act = k === s.idx && s.status !== 'idle';
            return <PointBlock key={p.n} p={p} k={k} line={act ? R.lineOf(p, s.chunk - 1) : -1} sent={act ? s.chunk - 1 : -1} onGo={goPoint} onY={setRowY} />;
          })}
          {!writing && <CardActions id={m.id} playing={playing} liked={!!m.data?.liked} onPlay={onPlayBtn} onCopy={copyCard} onShare={shareCard} onLike={likeCard} />}
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
        <View style={st.hSide}>
          <TouchableOpacity style={st.hBtn} onPress={() => { refreshChats(); setShowMenu(true); }}><Icon n="menu" size={24} /></TouchableOpacity>
        </View>
        <View style={st.brand}><Text style={st.title}>Sheet.md</Text></View>
        <View style={[st.hSide, { justifyContent: 'flex-end' }]}>
          <TouchableOpacity style={st.hBtn} onPress={() => setShowModels(true)}><Icon n="models" size={24} /></TouchableOpacity>
          <TouchableOpacity style={st.hBtn} onPress={() => setShowSet(true)}><Icon n="settings" size={24} /></TouchableOpacity>
        </View>
      </View>
      <ScrollView
        ref={list} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => { follow.current = false; }}>
        {msgs.length === 0 && !sources.length ? (
          <TouchableOpacity style={st.empty} onPress={addFiles}>
            <Icon n="plus" size={22} /><Text style={st.emptyT}>Add a source to begin</Text>
          </TouchableOpacity>) : null}
        {msgs.map(renderMsg)}
        {(working || indexing) ? (
          <View style={st.statusRow}>
            {/* tiny pulsing dot, left-aligned right where the reply text will start (like ChatGPT / Claude); mounted only while working, so it stops when the reply is done */}
            <WritingAnim />
            <Text style={st.statusT}>{working || 'Indexing…'}</Text>
          </View>) : null}
      </ScrollView>

      <View style={[st.dock, { paddingBottom: kbPad > 0 ? 8 : ins.bottom + 14 }]}>
        {/* floating Topics button (right side, just above the input box) with a drop-up list. Black and white only. */}
        <View style={st.tpWrap}>
          {showTopics && (
            <View style={st.tpPanel}>
              <TextInput style={st.tpSearch} value={topicQ} onChangeText={setTopicQ} placeholder="Search topics" placeholderTextColor="#000000" autoCapitalize="none" autoCorrect={false} />
              <ScrollView style={{ maxHeight: Math.min(300, Math.round(winH * 0.38)) }} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {(() => {
                  const q = topicQ.trim().toLowerCase();
                  const rows = (q ? topicList.filter((x) => x.name.toLowerCase().includes(q)) : topicList).slice(0, 80);
                  if (!rows.length) return <Text style={st.tpEmpty}>{topicList.length ? 'No topic matches.' : 'No topics yet. Add a PDF or file with the + button.'}</Text>;
                  return rows.map((x) => (
                    <Pressable key={x.id} onPress={() => pickTopicName(x.name)} style={({ pressed }) => [st.tpRow, pressed && { backgroundColor: C.tx }]}>
                      {({ pressed }) => <Text style={[st.tpRowT, pressed && { color: '#FFFFFF' }]} numberOfLines={2}>{x.name}</Text>}
                    </Pressable>));
                })()}
              </ScrollView>
            </View>)}
          <TouchableOpacity style={st.tpBtn} activeOpacity={0.7} onPress={toggleTopics}>
            <Icon n="file" size={16} />
            <Text style={st.tpBtnT}>Topics</Text>
            <Icon n="chevronDown" size={14} style={{ transform: [{ rotate: showTopics ? '0deg' : '180deg' }] }} />
          </TouchableOpacity>
        </View>
        <View style={st.box}>
          {/* top card (like the "Start interview" card in Claude): what the mic hears, the player, or a prompt - always inside the input box */}
          {(listening || s.points.length > 0) && (
            <View style={st.tcard}>
              {listening && (
                <View style={st.liveRow}>
                  <Wave mic active color={C.on} height={28} />
                  <LiveText hide={ownVoice} heard={heard} status={asking ? 'Listening to your question · say okay when done' : awakeUI ? 'Listening… say your command' : 'Listening'} />
                </View>)}
              {listening && s.points.length > 0 && <View style={st.tsep} />}
              {s.points.length > 0 && (
                <View style={st.playRow}>
                  <View style={st.playInfo}>
                    <Wave active={playing} color={C.tx} height={20} />
                    <Text style={[st.sub, { fontSize: 13 }]} numberOfLines={1}>{s.status === 'idle' ? 'Finished' : `Point ${Math.min(s.idx + 1, s.points.length)}/${s.points.length}`} · {s.rate.toFixed(1)}x</Text>
                  </View>
                  <View style={st.playBtns}>
                    <TouchableOpacity style={st.pBtn} onPress={() => { follow.current = true; R.prev(); keepFocus(); }}><Icon n="prev" size={15} /></TouchableOpacity>
                    <TouchableOpacity style={[st.pBtn, st.pBtnMain]} onPress={() => { follow.current = true; playing ? R.pause() : R.resume(); keepFocus(); }}>
                      <Icon n={playing ? 'pause' : 'play'} size={15} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity style={st.pBtn} onPress={() => { follow.current = true; R.next(); keepFocus(); }}><Icon n="next" size={15} /></TouchableOpacity>
                    <TouchableOpacity style={st.pBtn} onPress={() => { cancelGen(); choicesRef.current = null; setWorking(''); resetReader(); keepFocus(); }}><Icon n="close" size={14} /></TouchableOpacity>
                  </View>
                </View>)}
            </View>)}
          {showTtsPrompt && !listening && s.points.length === 0 && (
            <View style={st.tcard}>
              <View style={st.promoHead}>
                <Icon n="speed" size={20} />
                <Text style={st.promoT}>Download a clear offline voice</Text>
                <TouchableOpacity style={st.promoX} onPress={async () => { setShowTtsPrompt(false); await setMeta('tts_prompted', '1').catch(() => {}); }}><Icon n="close" size={16} color={C.sec} /></TouchableOpacity>
              </View>
              <Text style={[st.sub, { marginTop: 2 }]}>Lessac, ~67 MB on Wi-Fi. Runs fully offline.</Text>
              <View style={st.promoRow}>
                <TouchableOpacity style={st.promoBtn} onPress={async () => { setShowTtsPrompt(false); await setMeta('tts_prompted', '1').catch(() => {}); startVoiceDownload(DEFAULT_VOICE_ID); }}>
                  <Text style={st.promoBtnT}>Download</Text>
                </TouchableOpacity>
                <TouchableOpacity style={st.promoGhost} onPress={async () => { setShowTtsPrompt(false); await setMeta('tts_prompted', '1').catch(() => {}); setShowSet(true); }}>
                  <Text style={[st.txt, { fontSize: 14 }]}>Choose another</Text>
                </TouchableOpacity>
              </View>
            </View>)}
          <TextInput ref={inputRef} style={st.boxInput} value={input} onChangeText={setInput} multiline blurOnSubmit={false}
            onPressIn={() => { if (!Keyboard.metrics()) { inputRef.current?.blur(); setTimeout(() => inputRef.current?.focus(), 60); } }}   // already focused but keyboard hidden: tap must bring it back
            placeholder="Ask anything · or: topic anemia, exact anemia, explain anemia" placeholderTextColor="#8A8A8A" />
          <View style={st.boxRow}>
            <TouchableOpacity style={st.boxPlus} onPress={() => { setShowSrc(true); }}><Icon n="plus" size={24} /></TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={st.pill} onPress={() => { cycleLang(); keepFocus(); }}>
              <Text style={st.pillT}>{LANG_LABEL[s.lang]}</Text><Icon n="chevronDown" size={14} />
            </TouchableOpacity>
            <TouchableOpacity style={[st.circle, listening && { backgroundColor: C.on }]} onPress={mic}>
              <Icon n="mic" size={20} color={listening ? '#fff' : C.tx} />
            </TouchableOpacity>
            <TouchableOpacity style={[st.circle, hasText && { backgroundColor: C.acc }]} onPress={send} disabled={!hasText}>
              <Icon n="send" size={20} color={hasText ? '#fff' : C.disI} />
            </TouchableOpacity>
          </View>
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

      <Sheet visible={showModels} onClose={() => { setShowModels(false); Keyboard.dismiss(); }} title="Models" subtitle="Offline AI on your phone, and live Google search" bottom={ins.bottom}>
        <ScrollView ref={modelsScroll} style={{ maxHeight: sheetMax }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10, paddingBottom: 28 + kbPad }} showsVerticalScrollIndicator={false}>
          <Text style={st.secT}>Offline model</Text>
          <View style={st.group}>
            <View style={st.mHead}>
              <View style={st.mTile}><Icon n="file" size={20} /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.txt}>Smart notes</Text>
                <Text style={st.val}>{llmLine}</Text>
              </View>
              <View style={[st.badge, { backgroundColor: llm.phase === 'ready' ? '#DCFCE7' : llm.phase === 'error' ? '#FEE2E2' : '#EDEDEB' }]}>
                <Text style={[st.badgeT, { color: llm.phase === 'ready' ? C.ok : llm.phase === 'error' ? C.bad : C.sec }]}>
                  {llm.phase === 'ready' ? 'Ready' : llm.phase === 'downloading' ? `${llmPct}%` : llm.phase === 'paused' ? 'Paused' : llm.phase === 'checking' ? 'Checking' : llm.phase === 'error' ? 'Error' : 'Not downloaded'}
                </Text>
              </View>
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <View style={{ flex: 1 }}><Text style={st.txt}>Use Smart notes</Text><Text style={st.val}>{mLabel} · works fully offline</Text></View>
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

          <Text style={st.secT}>Cloud API</Text>
          <View style={st.group}>
            <View style={st.mHead}>
              <View style={st.mTile}><Icon n="models" size={20} /></View>
              <View style={{ flex: 1 }}>
                <Text style={st.txt}>Search with a cloud model</Text>
                <Text style={st.val}>{providerOn(prov) ? `${PROVIDERS.find((x) => x.id === prov)?.label} is ready` : 'Pick a provider and add its key'}</Text>
              </View>
              <View style={[st.badge, { backgroundColor: providerOn(prov) ? '#DCFCE7' : '#EDEDEB' }]}>
                <Text style={[st.badgeT, { color: providerOn(prov) ? C.ok : C.sec }]}>{providerOn(prov) ? 'On' : 'No key'}</Text>
              </View>
            </View>
            <View style={st.sep} />
            <View style={{ paddingVertical: 12, gap: 8 }}>
              <Text style={st.txt}>Provider</Text>
              <TouchableOpacity style={st.dd} activeOpacity={0.7} onPress={() => setProvOpen((v) => !v)}>
                <Text style={st.ddT} numberOfLines={1}>{PROVIDERS.find((x) => x.id === prov)?.label}</Text>
                <Icon n="chevronDown" size={16} style={{ transform: [{ rotate: provOpen ? '180deg' : '0deg' }] }} />
              </TouchableOpacity>
              {provOpen && (
                <View style={st.ddList}>
                  {PROVIDERS.map((p) => (
                    <TouchableOpacity key={p.id} style={st.ddItem} activeOpacity={0.7} onPress={() => pickProvider(p.id)}>
                      <View style={{ flex: 1 }}>
                        <Text style={[st.txt, prov === p.id && { fontWeight: '700' }]}>{p.label}</Text>
                        <Text style={st.val}>{p.note}</Text>
                      </View>
                      {providerOn(p.id) && <Icon n="check" size={16} color={C.ok} />}
                    </TouchableOpacity>))}
                </View>)}
            </View>
            <View style={st.sep} />
            <View style={{ paddingVertical: 12, gap: 10 }}>
              <Text style={st.txt}>{prov === 'gemini' ? 'Gemini API key' : `${PROVIDERS.find((x) => x.id === prov)?.label} API key${prov === 'custom' ? ' (optional for a local server)' : ''}`}</Text>
              {prov === 'custom' && (
                <TextInput style={st.keyInput} value={urlDraft} onChangeText={setUrlDraft} placeholder="Base URL, e.g. https://api.groq.com/openai/v1" placeholderTextColor={C.disI}
                  autoCapitalize="none" autoCorrect={false} spellCheck={false} keyboardType="url" />)}
              <View style={st.keyRow}>
                <TextInput
                  style={st.keyInput} value={keyDraft} onChangeText={setKeyDraft}
                  placeholder={(prov === 'gemini' ? gem.key : cloud.key[prov as 'openrouter' | 'openai' | 'custom']) ? '•••••••• saved. Paste a new key to replace' : prov === 'gemini' ? 'Paste your key (AIza…)' : prov === 'openrouter' ? 'Paste your key (sk-or-…)' : prov === 'openai' ? 'Paste your key (sk-…)' : 'Paste your key'} placeholderTextColor={C.disI}
                  secureTextEntry={!keyShown} autoCapitalize="none" autoCorrect={false} spellCheck={false} contextMenuHidden={false}
                  onFocus={() => setTimeout(() => modelsScroll.current?.scrollToEnd({ animated: true }), 300)} onSubmitEditing={saveKey} />
                <TouchableOpacity style={st.miniBtn} onPress={() => setKeyShown((v) => !v)}><Text style={st.txt}>{keyShown ? 'Hide' : 'Show'}</Text></TouchableOpacity>
              </View>
              {prov !== 'gemini' && (
                <>
                  <Text style={st.txt}>Model</Text>
                  <TextInput style={st.keyInput} value={modelDraft} onChangeText={setModelDraft}
                    placeholder={prov === 'openrouter' ? 'openrouter/free' : prov === 'openai' ? 'gpt-4o-mini' : 'model name'} placeholderTextColor={C.disI}
                    autoCapitalize="none" autoCorrect={false} spellCheck={false} />
                  {prov === 'openrouter' && (
                    <>
                      <TouchableOpacity style={[st.miniBtn, { alignSelf: 'flex-start', flexDirection: 'row', gap: 8 }]} onPress={loadFreeModels} disabled={orBusy}>
                        {orBusy && <ActivityIndicator size="small" color={C.tx} />}
                        <Text style={st.txt}>{orList ? 'Reload free models' : 'Show free models'}</Text>
                      </TouchableOpacity>
                      {!!orList && (
                        <View style={st.ddList}>
                          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                            {orList.length === 0 ? <Text style={[st.val, { padding: 12 }]}>No free models found right now.</Text> : orList.map((m) => (
                              <TouchableOpacity key={m.id} style={st.ddItem} activeOpacity={0.7} onPress={() => useModel(m.id)}>
                                <View style={{ flex: 1 }}>
                                  <Text style={[st.txt, cloud.model.openrouter === m.id && { fontWeight: '700' }]} numberOfLines={1}>{m.name}</Text>
                                  <Text style={st.val} numberOfLines={1}>{m.id}</Text>
                                </View>
                                {cloud.model.openrouter === m.id && <Icon n="check" size={16} color={C.ok} />}
                              </TouchableOpacity>))}
                          </ScrollView>
                        </View>)}
                    </>)}
                </>)}
              <View style={[st.keyRow, { flexWrap: 'wrap' }]}>
                <TouchableOpacity style={[st.miniBtn, { backgroundColor: C.acc, opacity: (prov === 'gemini' ? keyDraft.trim() : (keyDraft.trim() || modelDraft.trim() || urlDraft.trim())) ? 1 : 0.4 }]}
                  disabled={!(prov === 'gemini' ? keyDraft.trim() : (keyDraft.trim() || modelDraft.trim() || urlDraft.trim()))} onPress={saveKey}>
                  <Text style={[st.txt, { color: '#fff', fontWeight: '600' }]}>{prov === 'gemini' ? 'Save key' : 'Save'}</Text>
                </TouchableOpacity>
                {!!(prov === 'gemini' ? gem.key : cloud.key[prov as 'openrouter' | 'openai' | 'custom']) && <TouchableOpacity style={st.miniBtn} onPress={removeKey}><Text style={[st.txt, { color: C.bad }]}>Remove</Text></TouchableOpacity>}
                {!!KEY_LINK[prov] && <TouchableOpacity style={st.miniBtn} onPress={() => Linking.openURL(KEY_LINK[prov]).catch(() => {})}><Text style={st.txt}>Get a free key</Text></TouchableOpacity>}
              </View>
            </View>
            {prov === 'gemini' && (
              <>
                <View style={st.sep} />
                <View style={{ paddingVertical: 12, gap: 8 }}>
                  <Text style={st.txt}>Model</Text>
                  <View style={st.seg}>
                    {GEMINI_MODELS.map((m) => (
                      <TouchableOpacity key={m.id} style={[st.segI, gemModel === m.id && st.segOn]} onPress={() => pickGemModel(m.id)}>
                        <Text style={[st.segT, gemModel === m.id && { color: '#fff' }]} numberOfLines={1}>{m.label}</Text>
                      </TouchableOpacity>))}
                  </View>
                  <Text style={st.val}>{GEMINI_MODELS.find((m) => m.id === gemModel)?.note}. If a model's free limit is used up or Google retires it, the next model is used automatically. Finished searches are saved and reused without using any limit.</Text>
                </View>
              </>)}
            <View style={st.sep} />
            <View style={{ paddingVertical: 12, gap: 6 }}>
              <Text style={st.val}>Say or type “search sickle cell anemia” for a short answer (2-3 points), or “search long sickle cell anemia” for a full exam answer (add “5 marks” or “10 marks” if you like). Needs internet; each search is sent to the provider through your own key.</Text>
              {prov !== 'gemini' && <Text style={st.val}>{PROVIDERS.find((x) => x.id === prov)?.label} answers from the model's own knowledge, not live Google. If it fails or its free limit is used up, your Gemini key (if saved) is tried next, then the offline model.</Text>}
            </View>
          </View>
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
                    ? `${VOICES.find((v) => v.id === ttsState.selectedVoice)?.engine === 'pocket' ? 'Pocket' : 'Piper'}: ${VOICES.find((v) => v.id === ttsState.selectedVoice)?.label || ttsState.selectedVoice}`
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
            <View style={st.sep} />
            <StepRow icon="timer" label="Pause between words" value={s.wordGap > 0 ? `${s.wordGap.toFixed(1)}s between words` : 'off (normal speech)'} onMinus={() => R.setWordGap(-0.1)} onPlus={() => R.setWordGap(0.1)} />
            <View style={st.sep} />
            <View style={st.line}>
              <Icon n="timer" size={20} />
              <View style={{ flex: 1 }}><Text style={st.txt}>Repeat lines</Text><Text style={st.val}>{s.repeatOn ? `each line ${s.repeatN} times` : 'off'}</Text></View>
              {s.repeatOn && <>
                <TouchableOpacity style={st.step} onPress={() => R.setRepeatN(-1)}><Icon n="minus" size={18} /></TouchableOpacity>
                <TouchableOpacity style={st.step} onPress={() => R.setRepeatN(1)}><Icon n="plus" size={18} /></TouchableOpacity>
              </>}
              <Switch value={s.repeatOn} onValueChange={R.setRepeat} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" style={{ marginLeft: 8 }} />
            </View>
            <View style={st.sep} />
            <StepRow icon="speed" label="Sound boost (offline voice)" value={ttsState.boost <= 1 ? 'off' : `${ttsState.boost.toFixed(1)}x louder`} onMinus={() => setBoost(-0.5)} onPlus={() => setBoost(0.5)} />
            <View style={st.sep} />
            <View style={st.line}>
              <Icon n="mic" size={20} />
              <View style={{ flex: 1 }}><Text style={st.txt}>Wake word “tuik”</Text><Text style={st.val}>{s.wakeOn ? 'background / locked: say “tuik”, then the command' : 'off: every sound is a command'}</Text></View>
              <Switch value={s.wakeOn} onValueChange={R.setWake} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <Icon n="timer" size={20} />
              <View style={{ flex: 1 }}><Text style={st.txt}>Keep listening when locked</Text><Text style={st.val}>{batteryUnrestricted() ? 'allowed' : 'tap Allow, or the phone may stop the mic'}</Text></View>
              {!batteryUnrestricted() && <TouchableOpacity style={[st.step, { width: 'auto', paddingHorizontal: 14, borderRadius: 18 }]} onPress={askBatteryUnrestricted}><Text style={[st.txt, { fontSize: 13, fontWeight: '600' }]}>Allow</Text></TouchableOpacity>}
            </View>
          </View>

          {/* Language selector */}
          <Text style={st.secT}>Language</Text>
          <View style={st.seg}>
            {(['auto', 'en', 'bn'] as const).map((l) => (
              <TouchableOpacity key={l} style={[st.segI, s.lang === l && st.segOn]} onPress={() => R.setLang(l)}>
                <Text style={[st.segT, s.lang === l && { color: '#fff' }]}>{LANG_LABEL[l]}</Text>
              </TouchableOpacity>))}
          </View>

          {/* English voices (Piper catalog grouped by US / GB / Indian accent, plus Pocket) */}
          <Text style={st.secT}>English offline voices</Text>
          {(['US', 'GB', 'IN', 'PK'] as const).map((accent) => {
            const list = VOICES.filter((v) => v.accent === accent);
            return (
              <View key={accent} style={st.group}>
                <Text style={[st.sub, { paddingTop: 10, fontWeight: '700' }]}>{accent === 'US' ? 'United States (Piper)' : accent === 'GB' ? 'British (UK) (Piper)' : accent === 'IN' ? 'Indian-accent English (Piper, multi-speaker: one download per group)' : 'Pocket TTS - natural + voice cloning (one ~190 MB download, heavier: needs a strong phone)'}</Text>
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

                  const needsWav = v.ref === 'custom' && !ttsState.customVoice;
                  const onPickWav = async () => {
                    const r = await pickCustomVoice();
                    if (!r.ok) { if (r.msg) Alert.alert('Voice file', r.msg); return; }
                    if (R.state.status === 'reading') { R.pause(); await selectVoice(v.id); R.resume(); } else { await selectVoice(v.id); }
                  };

                  const onSelect = async () => {
                    if (!isReady) return;
                    if (needsWav) { await onPickWav(); return; }
                    if (R.state.status === 'reading') {
                      R.pause();
                      await selectVoice(v.id);
                      R.resume();
                    } else {
                      await selectVoice(v.id);
                    }
                  };

                  const onPreview = async () => {
                    if (needsWav) { await onPickWav(); return; }
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
                    Alert.alert('Delete voice?', v.pack ? 'All voices of this group share one download. It will be removed from private storage.' : `${v.label} will be removed from private storage.`, [
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
                          <Text style={st.sub}>{v.gender === 'female' ? 'Female' : v.gender === 'male' ? 'Male' : 'Your own sample'} · {v.approx ? '~' : ''}{mb(v.bytes)} MB{v.note ? ` · ${v.note}` : ''}</Text>
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
                          {isReady && v.ref === 'custom' && (
                            <TouchableOpacity style={[st.miniBtn, { height: 34, paddingHorizontal: 10 }]} onPress={onPickWav}>
                              <Text style={[st.txt, { fontSize: 12, fontWeight: '600' }]}>{ttsState.customVoice ? 'Change WAV' : 'Choose WAV'}</Text>
                            </TouchableOpacity>
                          )}
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

          <Text style={st.secT}>Topic speed</Text>
          <View style={st.group}>
            <View style={st.line}>
              <View style={{ flex: 1 }}><Text style={st.txt}>Fast topics</Text><Text style={st.val}>{fastTopic ? 'On: topic starts reading at once from your source' : 'Off: AI rewrites the notes first (slow on the phone)'}</Text></View>
              <Switch value={fastTopic} onValueChange={toggleFast} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
          </View>

          <Text style={st.secT}>Assistant</Text>
          <View style={st.group}>
            <View style={st.line}>
              <Icon n="mic" size={20} />
              <View style={{ flex: 1 }}><Text style={st.txt}>Assistant mode</Text><Text style={st.val}>{assistOn ? 'bubble on: tap it to talk, hold it to open the app' : 'a floating bubble that does things on your phone'}</Text></View>
              <Switch value={assistOn} onValueChange={toggleAssistant} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <View style={{ flex: 1 }}><Text style={st.txt}>Display over other apps</Text><Text style={st.val}>{overlayOk ? 'allowed' : 'needed for the bubble'}</Text></View>
              {!overlayOk && <TouchableOpacity style={[st.step, { width: 'auto', paddingHorizontal: 14, borderRadius: 18 }]} onPress={askOverlay}><Text style={[st.txt, { fontSize: 13, fontWeight: '600' }]}>Allow</Text></TouchableOpacity>}
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <View style={{ flex: 1 }}><Text style={st.txt}>Assistant model</Text><Text style={st.val}>{agentMsg || (agentReady() ? `${providerLabel()} · tap Check to test tools` : 'add a key in Models first')}</Text></View>
              <TouchableOpacity style={[st.step, { width: 'auto', paddingHorizontal: 14, borderRadius: 18 }]} onPress={() => { setAgentMsg('Checking…'); checkProvider().then(setAgentMsg).catch(() => setAgentMsg('Check failed.')); }}><Text style={[st.txt, { fontSize: 13, fontWeight: '600' }]}>Check</Text></TouchableOpacity>
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <View style={{ flex: 1 }}><Text style={st.txt}>Announce notifications</Text><Text style={st.val}>{announceOn ? (notifOk ? 'on: new notifications of the apps below are read once, never while reading' : 'on, but Notification access is not allowed yet') : 'off: say “notification gulo poro” to hear them'}</Text></View>
              <Switch value={announceOn} onValueChange={toggleAnnounce} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            <View style={{ paddingVertical: 8, gap: 6 }}>
              <Text style={st.val}>Apps to announce (names, comma separated; empty = none)</Text>
              <TextInput style={st.tpSearch} value={announceApps} onChangeText={saveAnnounceApps} placeholder="WhatsApp, Messages" placeholderTextColor="#000000" autoCapitalize="none" autoCorrect={false} />
            </View>
            {!notifOk && <TouchableOpacity style={st.line} onPress={notifOpenSettings}><Text style={[st.txt, { flex: 1 }]}>Allow notification access</Text></TouchableOpacity>}
            <View style={st.sep} />
            <View style={{ paddingVertical: 10, gap: 4 }}>
              <Text style={st.txt}>Memory · {facts.length}/50</Text>
              {facts.length === 0 && <Text style={st.val}>Nothing saved. Say “mone rakho …” or “remember …”.</Text>}
              {facts.map((f) => (
                <View key={f.id} style={[st.line, { minHeight: 36 }]}>
                  <Text style={[st.val, { flex: 1 }]} numberOfLines={2}>{f.text}</Text>
                  <TouchableOpacity style={st.hBtn} onPress={() => { removeFact(f.id).then(() => listFacts().then(setFacts)).catch(() => {}); }}><Icon n="trash" size={18} color={C.sec} /></TouchableOpacity>
                </View>))}
            </View>
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

          <Text style={st.secT}>Listening</Text>
          <View style={st.group}>
            <View style={st.line}>
              <View style={{ flex: 1 }}>
                <Text style={st.txt}>Use Google speech</Text>
                <Text style={st.sub}>{sttState.google ? 'ON: the phone\'s Google recognizer listens.' : 'OFF: the offline model listens (download it below first).'}</Text>
              </View>
              <Switch value={sttState.google} onValueChange={(v) => { if (listening) stopListening(); setSttGoogle(v); }} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
            </View>
            <View style={st.sep} />
            <View style={st.line}>
              <View style={{ flex: 1 }}>
                <Text style={st.txt}>Offline English model</Text>
                <Text style={st.sub}>{!Stt ? 'Not in this build.' : sttState.ready ? 'Ready. Works with no internet.' : sttState.downloading ? 'Downloading… ' + Math.round(sttState.progress * 100) + '%' : sttState.downloaded ? 'Loading…' : 'About 75 MB, downloaded once.'}{sttState.error ? '\n' + sttState.error : ''}</Text>
              </View>
              {sttState.downloading ? <ActivityIndicator color={C.acc} />
                : sttState.downloaded ? (
                  <TouchableOpacity onPress={() => Alert.alert('Delete offline model?', 'Turn Google speech on to keep using voice commands.', [{ text: 'Cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { if (listening) stopListening(); deleteStt(); } }])}>
                    <Icon n="trash" size={20} />
                  </TouchableOpacity>)
                  : !!Stt && (
                    <TouchableOpacity onPress={() => { downloadStt(); }}>
                      <Text style={[st.txt, { color: C.acc, fontWeight: '700' }]}>Download</Text>
                    </TouchableOpacity>)}
            </View>
            {sttState.ready && !sttState.google && (<>
              <View style={st.sep} />
              <View style={st.line}>
                <View style={{ flex: 1 }}>
                  <Text style={st.txt}>Ignore the app's own voice</Text>
                  <Text style={st.sub}>Phone-call style echo cancel. If reading stops hearing you or sounds quiet, turn it off.</Text>
                </View>
                <Switch value={sttState.aec} onValueChange={(v) => { if (listening) stopListening(); setSttAec(v); }} trackColor={{ false: '#D4D4D4', true: C.acc }} thumbColor="#fff" />
              </View>
              <View style={st.sep} />
              <View style={st.line}>
                <View style={{ flex: 1 }}>
                  <Text style={st.txt}>Soft voice boost: {sttState.gain}x</Text>
                  <Text style={st.sub}>Higher hears a quieter voice. Too high adds noise.</Text>
                </View>
                <TouchableOpacity onPress={() => { setSttGain(Math.max(1, sttState.gain - 1)); }} style={{ padding: 8 }}><Icon n="minus" size={20} /></TouchableOpacity>
                <TouchableOpacity onPress={() => { setSttGain(Math.min(12, sttState.gain + 1)); }} style={{ padding: 8 }}><Icon n="plus" size={20} /></TouchableOpacity>
              </View>
            </>)}
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

// Bars that move. mic = driven by the real loudness of your voice; otherwise a soft moving pattern while the app is reading.
const BARS = 18;
function Wave({ active, mic, color, height = 28 }: { active: boolean; mic?: boolean; color: string; height?: number }) {
  const vals = useRef(Array.from({ length: BARS }, () => new Animated.Value(0.1))).current;
  const level = useRef(0);
  useEffect(() => {
    if (!mic) return;
    return subscribeLevel((v) => { level.current = Math.max(v, level.current * 0.55); });     // quick up, soft down
  }, [mic]);
  useEffect(() => {
    if (!active) { vals.forEach((v) => v.setValue(0.1)); return; }
    const id = setInterval(() => {
      const base = mic ? level.current : 0.35 + Math.random() * 0.4;
      if (mic) level.current *= 0.8;
      const t = Date.now() / 220;
      vals.forEach((v, i) => {
        const shape = 0.55 + 0.45 * Math.sin(i * 0.8 + t);
        const to = Math.min(1, 0.1 + base * shape * (0.6 + Math.random() * 0.5));
        Animated.timing(v, { toValue: to, duration: 90, easing: Easing.linear, useNativeDriver: false }).start();
      });
    }, 100);
    return () => clearInterval(id);
  }, [active, mic]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height, gap: 3 }}>
      {vals.map((v, i) => (
        <Animated.View key={i} style={{ width: 3, borderRadius: 2, backgroundColor: color, height: v.interpolate({ inputRange: [0, 1], outputRange: [3, height] }) }} />))}
    </View>
  );
}

// Lottie loader (assets/animations/writing_animation.json) at the start of the reply while it is being written. Small, like the old dot:
// make WRITING_SIZE bigger / smaller if you want.
const WRITING_ANIM = require('./assets/animations/writing_animation.json');
const WRITING_SIZE = 22;
function WritingAnim() {
  return <LottieView source={WRITING_ANIM} autoPlay loop style={{ width: WRITING_SIZE, height: WRITING_SIZE }} />;
}

// Three dots that rise one after the other (shown while notes are being written)
function Dots() {
  const v = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const loops = v.map((x, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 140),
      Animated.timing(x, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(x, { toValue: 0, duration: 320, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay((2 - i) * 140 + 200),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 18, width: 30 }}>
      {v.map((x, i) => (
        <Animated.View key={i} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.tx,
          opacity: x.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          transform: [{ translateY: x.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] }} />))}
    </View>
  );
}

// What the mic hears right now (updates while you speak); when you stop, the last heard command stays for a few seconds.
function LiveText({ heard, status, hide }: { heard: string; status: string; hide: (t: string) => boolean }) {
  const [live, setLive] = useState('');
  useEffect(() => subscribeLive(setLive), []);
  const raw = live || heard;
  const text = raw && hide(raw) ? '' : raw;                           // the app's own voice picked up by the mic is not shown
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={st.liveS} numberOfLines={1}>{status}</Text>
      <Text style={[st.liveT, !text && { color: C.disI }]} numberOfLines={1}>{text ? `“${text}”` : 'Say a command…'}</Text>
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

// One point of the open topic. Memoised: while reading, only the point that changed re-renders (the whole screen used to re-render on every spoken line -> lag, heat, battery).
const PointBlock = React.memo(function PointBlock({ p, k, line, sent, onGo, onY }: { p: Point; k: number; line: number; sent: number; onGo: (k: number) => void; onY: (k: number, y: number) => void }) {
  const lines = p.bullets?.length ? p.bullets : p.text ? [p.text] : [];
  return (
    <TouchableOpacity activeOpacity={0.8} style={st.ptBlock} onLayout={(e) => onY(k, e.nativeEvent.layout.y)} onPress={() => onGo(k)}>
      <View style={st.ptItem}>
        <Text style={st.ptNum}>{p.n}.</Text>
        <View style={st.ptBody}>
          {!!p.title && <Text style={st.ptTitle}>{p.title}</Text>}
          {p.bullets ? lines.map((ln, j) => <Text key={j} style={[st.ptLine, line === j && st.sentOn]}>{ln}</Text>) : lines.length ? (
            <Text style={st.ptLine}>{splitSentences(lines.join(' ')).map((c, j) => <Text key={j} style={j === sent ? st.sentOn : undefined}>{c + ' '}</Text>)}</Text>
          ) : null}
          {!!p.hint && <Text style={st.hint}>Banglish: {p.hint}</Text>}
        </View>
      </View>
    </TouchableOpacity>);
});

const noY = () => {};
// Copy / Play / Share / Like under a finished reply. Small, close together, always black (icons: assets/icons/*.png)
const ACT_SIZE = 16;
const CardActions = React.memo(function CardActions({ id, playing, liked, onPlay, onCopy, onShare, onLike }: { id: number; playing: boolean; liked: boolean; onPlay: (id: number) => void; onCopy: (id: number) => void; onShare: (id: number) => void; onLike: (id: number) => void }) {
  const hit = { top: 8, bottom: 8, left: 2, right: 2 };
  return (
    <View style={st.actRow}>
      <TouchableOpacity style={st.actBtn} activeOpacity={0.6} hitSlop={hit} onPress={() => onCopy(id)}><Icon n="copy" size={ACT_SIZE} color={C.tx} /></TouchableOpacity>
      <TouchableOpacity style={st.actBtn} activeOpacity={0.6} hitSlop={hit} onPress={() => onPlay(id)}><Icon n={playing ? 'pause' : 'play'} size={ACT_SIZE} color={C.tx} /></TouchableOpacity>
      <TouchableOpacity style={st.actBtn} activeOpacity={0.6} hitSlop={hit} onPress={() => onShare(id)}><Icon n="share" size={ACT_SIZE} color={C.tx} /></TouchableOpacity>
      <TouchableOpacity style={[st.actBtn, liked && st.actOn]} activeOpacity={0.6} hitSlop={hit} onPress={() => onLike(id)}><Icon n="like" size={ACT_SIZE} color={C.tx} /></TouchableOpacity>
    </View>);
});

// A saved reply that is not being read now: the complete text, nothing collapsed. Memoised, so the reading highlight on another card never re-renders it.
const TopicCard = React.memo(function TopicCard({ id, name, pts, liked, writing, onPlay, onGo, onCopy, onShare, onLike }: { id: number; name: string; pts: Point[]; liked: boolean; writing: boolean; onPlay: (id: number) => void; onGo: (id: number, k: number) => void; onCopy: (id: number) => void; onShare: (id: number) => void; onLike: (id: number) => void }) {
  return (
    <View style={st.card}>
      <Text style={st.topicT}>{name}</Text>
      {pts.map((p, k) => <PointBlock key={p.n} p={p} k={k} line={-1} sent={-1} onGo={(kk) => onGo(id, kk)} onY={noY} />)}
      {!writing && <CardActions id={id} playing={false} liked={liked} onPlay={onPlay} onCopy={onCopy} onShare={onShare} onLike={onLike} />}
    </View>);
});

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 6 },
  hBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hSide: { width: 84, flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: C.tx },
  brand: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 34, height: 24 },
  sub: { color: C.sec, fontSize: 12 },
  txt: { color: C.tx, fontSize: 15 },
  youT: { color: '#fff', fontSize: 14 },
  reply: { color: C.tx, fontSize: 14, lineHeight: 20, alignSelf: 'flex-start', maxWidth: '92%', paddingHorizontal: 2 },
  you: { backgroundColor: C.acc, alignSelf: 'flex-end', borderRadius: 18, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 9, maxWidth: '80%' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingHorizontal: 2 },
  statusT: { color: C.sec, fontSize: 14 },
  statusRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, paddingVertical: 2, paddingHorizontal: 0 },
  empty: { borderWidth: 1, borderColor: C.bd, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 40, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  emptyT: { color: C.tx, fontSize: 16 },

  card: { backgroundColor: 'transparent', borderRadius: 1, paddingVertical: 4 },
  topicT: { fontWeight: '700', fontSize: 18, lineHeight: 26, color: C.tx, marginBottom: 6 },
  ptBlock: { paddingVertical: 10 },
  ptItem: { flexDirection: 'row', alignItems: 'flex-start' },
  ptNum: { width: 30, fontWeight: '700', fontSize: 16, lineHeight: 24, color: C.sec },
  ptBody: { flex: 1 },
  ptTitle: { fontWeight: '700', fontSize: 16, lineHeight: 24, color: C.tx, marginBottom: 3 },
  ptLine: { color: C.tx, fontSize: 15.5, lineHeight: 24, marginBottom: 4 },
  actRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingTop: 4, paddingLeft: 0 },
  actBtn: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  actOn: { borderWidth: 1.5, borderColor: C.tx },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  cardT: { flex: 1, fontWeight: '700', fontSize: 16, color: C.tx },
  ptRow: { flexDirection: 'row', gap: 10, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 10 },
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

  tpWrap: { alignItems: 'flex-end', marginBottom: 8 },
  tpBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 19, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.tx,
    elevation: 5, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  tpBtnT: { fontSize: 14, fontWeight: '700', color: C.tx },
  tpPanel: { width: '86%', backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.tx, borderRadius: 20, padding: 10, marginBottom: 8, gap: 8,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 3 } },
  tpSearch: { height: 40, borderWidth: 1.5, borderColor: C.tx, borderRadius: 14, paddingHorizontal: 12, fontSize: 15, color: C.tx, backgroundColor: C.bg },
  tpRow: { paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12 },
  tpRowT: { fontSize: 15, fontWeight: '600', color: C.tx },
  tpEmpty: { fontSize: 14, color: C.tx, padding: 12 },
  dock: { paddingHorizontal: 12, paddingTop: 6 },
  box: {
    borderWidth: 1, borderColor: '#E1DFD9', borderRadius: 30, backgroundColor: C.bg, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 8,
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 14, shadowOffset: { width: 0, height: 3 },
  },
  boxInput: { minHeight: 46, maxHeight: 130, fontSize: 16, color: C.tx, paddingHorizontal: 8, paddingVertical: 8, textAlignVertical: 'top' },
  boxRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  boxPlus: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 12, height: 40 },
  pillT: { fontSize: 14, fontWeight: '600', color: C.tx },
  circle: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1EFEA' },

  // the card on top of the input (same place as Claude's "Start interview" card)
  tcard: { backgroundColor: '#F1EFEA', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, marginBottom: 7 },
  tsep: { height: 1, backgroundColor: '#E1DFD9', marginVertical: 8 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveS: { fontSize: 12, color: C.sec },
  liveT: { fontSize: 15, fontWeight: '600', color: C.tx },
  playRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  playInfo: { flex: 1, minWidth: 0, gap: 3 },
  playBtns: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  pBtnMain: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.acc },
  promoHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  promoT: { flex: 1, fontSize: 16, fontWeight: '700', color: C.tx },
  promoX: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  promoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  promoBtn: { flex: 1, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: '#CFCDC6', backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  promoBtnT: { fontSize: 16, fontWeight: '600', color: C.tx },
  promoGhost: { height: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },

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
  segI: { flex: 1, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.acc },
  segT: { fontSize: 14, fontWeight: '600', color: C.tx },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11 },
  opt: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, backgroundColor: C.surf, marginTop: 6 },
  optT: { flex: 1, fontSize: 15, fontWeight: '600', color: C.tx },
  barBg: { height: 6, borderRadius: 3, backgroundColor: C.bd, overflow: 'hidden', marginBottom: 12 },
  barFg: { height: 6, borderRadius: 3, backgroundColor: C.acc },
  mHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  mTile: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  badge: { paddingHorizontal: 10, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  badgeT: { fontSize: 12, fontWeight: '700' },
  dd: { height: 46, borderWidth: 1.5, borderColor: C.tx, borderRadius: 14, paddingHorizontal: 14, backgroundColor: C.bg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ddT: { flex: 1, fontSize: 15, fontWeight: '600', color: C.tx },
  ddList: { borderWidth: 1.5, borderColor: C.tx, borderRadius: 14, backgroundColor: C.bg, overflow: 'hidden' },
  ddItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 14 },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyInput: { flex: 1, height: 46, borderWidth: 1.5, borderColor: C.bd, borderRadius: 12, paddingHorizontal: 12, fontSize: 15, color: C.tx, backgroundColor: C.bg },
  miniBtn: { height: 40, paddingHorizontal: 18, borderRadius: 20, borderWidth: 1.5, borderColor: C.bd, alignItems: 'center', justifyContent: 'center' },
  dlgBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', paddingHorizontal: 24 },
  dlg: { backgroundColor: C.bg, borderRadius: 20, padding: 18, gap: 14, elevation: 16 },
  dlgInput: { borderWidth: 1.5, borderColor: C.bd, borderRadius: 12, paddingHorizontal: 12, height: 48, fontSize: 16, color: C.tx },
  dlgRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  dlgBtn: { height: 42, paddingHorizontal: 20, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surf },
  cmdRow: { paddingVertical: 10 },
  cmd: { fontSize: 15, fontWeight: '600', color: C.tx },
  cmdD: { fontSize: 13, color: C.sec, marginTop: 1 },
});
