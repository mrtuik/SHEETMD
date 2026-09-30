import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, StyleSheet, ScrollView, Pressable, Switch,
  Platform, PermissionsAndroid, StatusBar, Linking, Image, Keyboard, Alert,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { parse } from './src/commands';
import { makeNotes } from './src/notes';
import * as R from './src/reader';
import {
  findTopic, getNotes, saveNotes, listSources, removeSource, loadSession, clearSession, topicName, cleanupStuck,
  listChats, newChat, deleteChat, loadMsgs, addMsg, Source, Chat,
} from './src/db';
import { pickAndImport } from './src/importer';
import { startListening, stopListening } from './src/listener';
import { updateService, stopService, onServiceAction } from './src/service';
import { ICONS, IconName } from './src/icons';

type Msg = { id: number; who: 'you' | 'app'; text: string };

const C = { bg: '#FFFFFF', surf: '#F6F6F5', bd: '#E4E4E2', tx: '#0A0A0A', sec: '#737373', acc: '#0A0A0A', on: '#4338ca', ok: '#16a34a', bad: '#dc2626', dis: '#EDEDEB', disI: '#A3A3A3' };
const LANG_LABEL = { auto: 'Auto', en: 'English', bn: 'Bangla' } as const;
const COMMANDS: [string, string][] = [
  ['topic <name>', 'Say the topic, then read it point by point'],
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
  const [awake, setAwake] = useState(true);
  const [, force] = useState(0);
  const idRef = useRef(1);
  const list = useRef<FlatList<Msg>>(null);
  const follow = useRef(true);
  const rowY = useRef<Record<number, number>>({});
  const cardH = useRef(0);
  const contentH = useRef(0);
  const refresh = useCallback(async () => { try { setSources(await listSources()); } catch {} }, []);
  const refreshChats = useCallback(async () => { try { setChats(await listChats()); } catch {} }, []);
  // every message is saved to the current chat
  const push = (who: Msg['who'], text: string) => {
    setMsgs((m) => [...m, { id: idRef.current++, who, text }]);
    if (chatRef.current) addMsg(chatRef.current, who, text).then(refreshChats).catch(() => {});
  };
  const showChat = async (id: number) => {
    chatRef.current = id; setChatId(id); rowY.current = {};
    const m = await loadMsgs(id);
    idRef.current = (m.length ? Math.max(...m.map((x) => x.id)) : 0) + 1;
    setMsgs(m);
  };
  const resetReader = async () => { R.reset(); await clearSession().catch(() => {}); };
  const startNew = async () => {
    setShowMenu(false);
    await resetReader();
    if (chatRef.current && msgs.length === 0) return;          // already on an empty chat
    const id = await newChat();
    await showChat(id); refreshChats();
  };
  const openChat = async (id: number) => {
    setShowMenu(false);
    if (id === chatRef.current) return;
    await resetReader(); await showChat(id);
  };
  const removeChat = (c: Chat) => Alert.alert('Delete chat?', c.title, [
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

  useEffect(() => {
    const un = R.subscribe(() => force((x) => x + 1));
    (async () => {
      await cleanupStuck().catch(() => {});
      refresh();
      let cs = await listChats();
      const id = cs.length ? cs[0].id : await newChat();
      await showChat(id);
      refreshChats();
      const s = await loadSession();
      if (s) {
        const pts = await getNotes(s.topic_id);
        if (pts) R.restore(s.topic_id, await topicName(s.topic_id), pts, s.point_n, s.speed);
      }
    })().catch(() => {});
    return un;
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

  const exec = async (text: string) => {
    if (!text.trim()) return;
    push('you', text);
    const c = parse(text);
    follow.current = true;
    switch (c.t) {
      case 'topic': {
        const f = await findTopic(c.q);
        if (!f || !f.found) { push('app', 'Topic not found.' + (f?.alts.length ? ` Closest: ${f.alts.join(', ')}` : '')); break; }
        let pts = await getNotes(f.id);            // id 0 (part of a big file) is never cached
        if (!pts) { pts = makeNotes(f.name, f.body); await saveNotes(f.id, pts); }
        rowY.current = {};
        push('app', `Topic: ${f.name}`);
        R.startTopic(f.id, f.name, pts);
        break;
      }
      case 'repeat': R.repeat(c.arg); break;
      case 'continue': R.resume(); break;
      case 'pause': R.pause(); break;
      case 'stop': R.stop(); break;
      case 'next': R.next(); break;
      case 'prev': R.prev(); break;
      case 'slower': R.setRate(-0.1); break;
      case 'faster': R.setRate(0.1); break;
      default: push('app', 'Try: topic <name>, pause, next, repeat 2, continue.');
    }
  };
  const send = () => { const t = input.trim(); if (!t) return; setInput(''); exec(t); };

  const addFiles = async () => {
    setBusy(true);
    try { const r = await pickAndImport(refresh); if (r) push('app', r); } catch (e: any) { push('app', 'Import failed: ' + e.message); }
    setBusy(false); refresh();
  };

  const execRef = useRef(exec);
  execRef.current = exec;
  // Mic stays on; only real commands are accepted, and anything the app is itself speaking is ignored
  const onVoice = (t: string) => {
    if (parse(t).t === 'unknown') return;
    if (R.state.status === 'reading' && R.getSpoken().toLowerCase().includes(t.toLowerCase().trim())) return;
    execRef.current(t);
  };
  const mic = async () => {
    if (listening) { await stopListening(); return; }
    const g = await PermissionsAndroid.request('android.permission.RECORD_AUDIO' as any);
    if (g !== 'granted') return;
    const ok = await startListening(onVoice, () => (R.state.lang === 'bn' ? 'bn-BD' : 'en-US'), setListening);
    if (!ok) push('app', 'Voice module not available.');
  };
  useEffect(() => () => { stopListening(); }, []);

  const s = R.state;
  const ready = sources.filter((x) => x.status === 'ready').length;
  const indexing = sources.some((x) => x.status === 'indexing') || busy;
  const cycleLang = () => R.setLang(s.lang === 'auto' ? 'en' : s.lang === 'en' ? 'bn' : 'auto');
  const hasText = input.trim().length > 0;
  const playing = s.status === 'reading';

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
    if (y == null) return;
    const tm = setTimeout(() => {
      const top = contentH.current - 16 - cardH.current;
      list.current?.scrollToOffset({ offset: Math.max(0, top + y - 90), animated: true });
    }, 180);
    return () => clearTimeout(tm);
  }, [s.idx, s.status]);

  return (
    <View ref={rootRef} collapsable={false} style={[st.root, { paddingTop: ins.top + 4, paddingBottom: kbPad }]}>
      <StatusBar barStyle="dark-content" />
      <View style={st.header}>
        <TouchableOpacity style={st.hBtn} onPress={() => { refreshChats(); setShowMenu(true); }}><Icon n="menu" size={24} /></TouchableOpacity>
        <View style={st.brand}><Image source={require('./assets/logo.png')} style={st.logo} resizeMode="contain" /><Text style={st.title}>Sheet.md</Text></View>
        <TouchableOpacity style={st.hBtn} onPress={() => setShowSet(true)}><Icon n="settings" size={24} /></TouchableOpacity>
      </View>
      <View style={st.chip}><Text style={st.sub}>{indexing ? 'Indexing…' : `${ready} sources ready`}{listening ? '  •  listening' : ''}</Text></View>

      <FlatList
        ref={list}
        style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}
        data={msgs} keyExtractor={(m) => String(m.id)}
        onScrollBeginDrag={() => { follow.current = false; }}
        onContentSizeChange={(_w, h) => { contentH.current = h; }}
        ListEmptyComponent={!sources.length ? (
          <TouchableOpacity style={st.empty} onPress={addFiles}>
            <Icon n="plus" size={22} /><Text style={st.emptyT}>Add a source to begin</Text>
          </TouchableOpacity>) : null}
        renderItem={({ item }) => (
          <View style={[st.bubble, item.who === 'you' && st.you]}><Text style={item.who === 'you' ? st.youT : st.txt}>{item.text}</Text></View>
        )}
        ListFooterComponent={s.points.length ? (
          <View style={st.card} onLayout={(e) => { cardH.current = e.nativeEvent.layout.height; }}>
            <Text style={st.cardT}>{s.topic}</Text>
            <Text style={[st.sub, { marginBottom: 6 }]}>{s.points.length} points · tap one to jump</Text>
            {s.points.map((p, i) => {
              const act = i === s.idx && s.status !== 'idle';
              const parts = act ? R.pointChunks(p).slice(1) : [];
              return (
                <TouchableOpacity key={p.n} activeOpacity={0.7} style={[st.ptRow, act && st.ptRowOn]}
                  onLayout={(e) => { rowY.current[i] = e.nativeEvent.layout.y; }}
                  onPress={() => { follow.current = true; R.goto(i); }}>
                  <Text style={[st.ptN, act && st.ptNOn]}>{p.n}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[st.pt, act && st.ptActive]}>{p.title}</Text>
                    {act && (
                      <Text style={st.sentBox}>
                        {parts.map((c, k) => <Text key={k} style={k === s.chunk - 1 ? st.sentOn : st.sent}>{c + ' '}</Text>)}
                      </Text>)}
                  </View>
                </TouchableOpacity>);
            })}
          </View>) : null}
      />

      <View style={[st.dock, { paddingBottom: kbPad > 0 ? 10 : ins.bottom + 12 }]}>
        <View style={st.box}>
          <TextInput style={st.boxInput} value={input} onChangeText={setInput} multiline
            placeholder="Type or speak · e.g. topic anemia" placeholderTextColor="#8A8A8A" />
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
        </View>

        {s.points.length > 0 && (
          <View style={st.ctrl}>
            <TouchableOpacity style={st.ctrlSq} onPress={() => { follow.current = true; R.prev(); }}><Icon n="prev" size={22} /></TouchableOpacity>
            <TouchableOpacity style={st.ctrlWide} onPress={() => { follow.current = true; playing ? R.pause() : R.resume(); }}>
              <Icon n={playing ? 'pause' : 'play'} size={20} />
              <Text style={st.ctrlT}>{playing ? 'Pause' : s.status === 'idle' ? 'Play again' : 'Play'}</Text>
              <Text style={st.sub}>{s.rate.toFixed(1)}x</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.ctrlSq} onPress={() => { follow.current = true; R.next(); }}><Icon n="next" size={22} /></TouchableOpacity>
          </View>)}
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
                  <TouchableOpacity style={{ flex: 1, paddingVertical: 12 }} onPress={() => openChat(c.id)}>
                    <Text style={[st.txt, c.id === chatId && { fontWeight: '700' }]} numberOfLines={1}>{c.title}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={st.hBtn} onPress={() => removeChat(c)}><Icon n="trash" size={18} color={C.sec} /></TouchableOpacity>
                </View>))}
            </ScrollView>
          </View>
          <Pressable style={{ flex: 1 }} onPress={() => setShowMenu(false)} />
        </View>
      </Modal>

      <Sheet visible={showSrc} onClose={() => setShowSrc(false)} title="Sources" subtitle={`${ready} ready`} bottom={ins.bottom}>
        <TouchableOpacity style={st.addBtn} onPress={addFiles}>
          <Icon n="plus" size={20} color="#fff" /><Text style={st.addT}>Add files</Text>
        </TouchableOpacity>
        <Text style={[st.sub, { textAlign: 'center' }]}>PDF, .md, .txt, .jpg, .zip</Text>
        <ScrollView style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false}>
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
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
          <View style={st.group}>
            <StepRow icon="speed" label="Speed" value={`${s.rate.toFixed(1)}x`} onMinus={() => R.setRate(-0.1)} onPlus={() => R.setRate(0.1)} />
            <View style={st.sep} />
            <StepRow icon="timer" label="Pause between points" value={`${s.pauseSec}s`} onMinus={() => R.setPause(-1)} onPlus={() => R.setPause(1)} />
          </View>

          <Text style={st.secT}>Language</Text>
          <View style={st.seg}>
            {(['auto', 'en', 'bn'] as const).map((l) => (
              <TouchableOpacity key={l} style={[st.segI, s.lang === l && st.segOn]} onPress={() => R.setLang(l)}>
                <Text style={[st.segT, s.lang === l && { color: '#fff' }]}>{LANG_LABEL[l]}</Text>
              </TouchableOpacity>))}
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
          <Text style={[st.sub, { paddingHorizontal: 4 }]}>Bangla mode also understands: থামো, পরের, আগের, আবার, চালু</Text>
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
  chip: { alignSelf: 'center', backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
  sub: { color: C.sec, fontSize: 12 },
  txt: { color: C.tx, fontSize: 15 },
  youT: { color: '#fff', fontSize: 15 },
  bubble: { backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 14, padding: 12, alignSelf: 'flex-start', maxWidth: '90%' },
  you: { backgroundColor: C.acc, alignSelf: 'flex-end' },
  empty: { borderWidth: 1, borderColor: C.bd, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 40, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  emptyT: { color: C.tx, fontSize: 16 },

  card: { backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 18, padding: 14 },
  cardT: { fontWeight: '700', fontSize: 16, color: C.tx, marginBottom: 2 },
  ptRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 12 },
  ptRowOn: { backgroundColor: '#E9E9E7' },
  ptN: { width: 22, color: C.sec, fontSize: 14, textAlign: 'right', paddingTop: 1 },
  ptNOn: { color: C.tx, fontWeight: '700' },
  pt: { color: C.sec, fontSize: 15 },
  ptActive: { color: C.tx, fontWeight: '700' },
  sentBox: { marginTop: 6, fontSize: 15, lineHeight: 22 },
  sent: { color: C.sec },
  sentOn: { color: C.tx, fontWeight: '600', backgroundColor: '#FFF3B0' },

  dock: { paddingHorizontal: 12, paddingTop: 8, gap: 10 },
  box: { borderWidth: 1.5, borderColor: C.bd, borderRadius: 28, backgroundColor: C.bg, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 },
  boxInput: { minHeight: 44, maxHeight: 120, fontSize: 16, color: C.tx, paddingHorizontal: 4, paddingVertical: 6, textAlignVertical: 'top' },
  boxRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  boxPlus: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderColor: C.bd, borderRadius: 14, paddingHorizontal: 12, height: 38 },
  pillT: { fontSize: 14, fontWeight: '600', color: C.tx },
  circle: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.dis, alignItems: 'center', justifyContent: 'center' },

  ctrl: { flexDirection: 'row', gap: 10 },
  ctrlSq: { width: 62, height: 54, borderWidth: 1.5, borderColor: C.bd, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  ctrlWide: { flex: 1, height: 54, borderWidth: 1.5, borderColor: C.bd, borderRadius: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  ctrlT: { fontSize: 16, fontWeight: '600', color: C.tx },

  drawerBg: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.35)' },
  drawer: { width: '80%', maxWidth: 340, backgroundColor: C.bg, paddingHorizontal: 14, gap: 8, elevation: 16 },
  drawerH: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6 },
  drawerBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 50, borderRadius: 16, backgroundColor: C.surf, paddingHorizontal: 14 },
  drawerBtnT: { flex: 1, fontSize: 16, fontWeight: '600', color: C.tx },
  chatRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 12 },
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
  cmdRow: { paddingVertical: 10 },
  cmd: { fontSize: 15, fontWeight: '600', color: C.tx },
  cmdD: { fontSize: 13, color: C.sec, marginTop: 1 },
});
