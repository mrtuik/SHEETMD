import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, PermissionsAndroid, StatusBar,
} from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { parse } from './src/commands';
import { makeNotes } from './src/notes';
import * as R from './src/reader';
import { findTopic, getNotes, saveNotes, listSources, removeSource, loadSession, topicName, Source } from './src/db';
import { pickAndImport } from './src/importer';

let Voice: any = null;
try { Voice = require('@react-native-voice/voice').default; } catch {}

type Msg = { id: number; who: 'you' | 'app'; text: string };

export default function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const [showSet, setShowSet] = useState(false);
  const [listening, setListening] = useState(false);
  const [awake, setAwake] = useState(true);
  const [, force] = useState(0);
  const idRef = useRef(1);
  const push = (who: Msg['who'], text: string) => setMsgs((m) => [...m, { id: idRef.current++, who, text }]);
  const refresh = useCallback(async () => setSources(await listSources()), []);

  useEffect(() => {
    const un = R.subscribe(() => force((x) => x + 1));
    refresh();
    (async () => {
      const s = await loadSession();
      if (s) {
        const pts = await getNotes(s.topic_id);
        if (pts) R.restore(s.topic_id, await topicName(s.topic_id), pts, s.point_n, s.speed);
      }
    })();
    return un;
  }, []);
  useEffect(() => { awake ? activateKeepAwakeAsync() : deactivateKeepAwake(); }, [awake]);

  const exec = async (text: string) => {
    if (!text.trim()) return;
    push('you', text);
    const c = parse(text);
    switch (c.t) {
      case 'topic': {
        const f = await findTopic(c.q);
        if (!f || !f.found) { push('app', 'Topic not found.' + (f?.alts.length ? ` Closest: ${f.alts.join(', ')}` : '')); break; }
        let pts = await getNotes(f.id);
        if (!pts) { pts = makeNotes(f.name, f.body); await saveNotes(f.id, pts); }
        push('app', `Topic: ${f.name}`);
        R.startTopic(f.id, f.name, pts, f.alts.length > 0);
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
      default: push('app', 'Try: Topic <name>, Repeat <point>, Continue.');
    }
  };
  const send = () => { const t = input; setInput(''); exec(t); };

  const addFiles = async () => {
    setBusy(true);
    try { const r = await pickAndImport(); if (r) push('app', r); } catch (e: any) { push('app', 'Import failed: ' + e.message); }
    setBusy(false); refresh();
  };

  const mic = async () => {
    if (!Voice) return push('app', 'Voice module not available.');
    if (listening) { await Voice.stop(); setListening(false); return; }
    const g = await PermissionsAndroid.request('android.permission.RECORD_AUDIO' as any);
    if (g !== 'granted') return;
    R.pause();
    Voice.onSpeechResults = (e: any) => { const t = e.value?.[0]; if (t) exec(t); };
    Voice.onSpeechEnd = () => setListening(false);
    Voice.onSpeechError = () => setListening(false);
    try { await Voice.start('en-US'); setListening(true); } catch {}
  };

  const s = R.state;
  const ready = sources.filter((x) => x.status === 'ready').length;
  const indexing = sources.some((x) => x.status === 'indexing') || busy;

  return (
    <KeyboardAvoidingView style={st.root} behavior="padding">
      <StatusBar barStyle="dark-content" />
      <View style={st.header}>
        <TouchableOpacity onPress={() => setShowSrc(true)}><Text style={st.hb}>▤</Text></TouchableOpacity>
        <Text style={st.title}>Sheet.md</Text>
        <TouchableOpacity onPress={() => setShowSet(true)}><Text style={st.hb}>⚙</Text></TouchableOpacity>
      </View>
      <View style={st.chip}><Text style={st.sub}>{indexing ? 'Indexing…' : `${ready} sources ready`}</Text></View>

      <FlatList
        style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}
        data={msgs} keyExtractor={(m) => String(m.id)}
        ListEmptyComponent={!sources.length ? (
          <TouchableOpacity style={st.empty} onPress={addFiles}><Text style={st.emptyT}>Add a source to begin  ＋</Text></TouchableOpacity>) : null}
        renderItem={({ item }) => (
          <View style={[st.bubble, item.who === 'you' && st.you]}><Text style={item.who === 'you' ? st.youT : st.txt}>{item.text}</Text></View>
        )}
        ListFooterComponent={s.points.length ? (
          <View style={st.card}>
            <Text style={st.cardT}>Topic: {s.topic}</Text>
            {s.points.map((p, i) => (
              <Text key={p.n} style={[st.pt, i === s.idx && s.status !== 'idle' && st.ptActive]}>{p.n}. {p.title}</Text>
            ))}
          </View>) : null}
      />

      {s.points.length > 0 && (
        <View style={st.bar}>
          <TouchableOpacity onPress={R.prev}><Text style={st.bb}>◀ Prev</Text></TouchableOpacity>
          <TouchableOpacity onPress={s.status === 'reading' ? R.pause : R.resume}>
            <Text style={[st.bb, { fontWeight: '700' }]}>{s.status === 'reading' ? '❚❚ Pause' : '▶ Play'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={R.next}><Text style={st.bb}>Next ▶</Text></TouchableOpacity>
          <Text style={st.sub}>{s.rate.toFixed(1)}x</Text>
        </View>
      )}

      <View style={st.inputRow}>
        <TouchableOpacity onPress={() => setShowSrc(true)}><Text style={st.plus}>＋</Text></TouchableOpacity>
        <TextInput style={st.input} value={input} onChangeText={setInput} placeholder="Type or speak…"
          placeholderTextColor="#737373" onSubmitEditing={send} returnKeyType="send" />
        <TouchableOpacity style={[st.mic, listening && { backgroundColor: '#4338ca' }]} onPress={mic}><Text style={{ color: '#fff' }}>🎙</Text></TouchableOpacity>
      </View>

      <Modal visible={showSrc} transparent animationType="slide" onRequestClose={() => setShowSrc(false)}>
        <View style={st.sheetBg}><View style={st.sheet}>
          <View style={st.sheetH}><Text style={st.title}>Sources</Text><TouchableOpacity onPress={() => setShowSrc(false)}><Text style={st.hb}>✕</Text></TouchableOpacity></View>
          <TouchableOpacity style={st.addBtn} onPress={addFiles}><Text style={st.youT}>＋ Add files (.md .txt .zip)</Text></TouchableOpacity>
          <ScrollView style={{ maxHeight: 320 }}>
            {sources.map((x) => (
              <View key={x.id} style={st.row}>
                <Text style={[st.txt, { flex: 1 }]} numberOfLines={1}>{x.name}</Text>
                <Text style={st.sub}>{x.status === 'ready' ? `✓ ${x.info}` : x.info || x.status}</Text>
                <TouchableOpacity onPress={async () => { await removeSource(x.id); refresh(); }}><Text style={[st.hb, { marginLeft: 12 }]}>✕</Text></TouchableOpacity>
              </View>))}
          </ScrollView>
        </View></View>
      </Modal>

      <Modal visible={showSet} transparent animationType="slide" onRequestClose={() => setShowSet(false)}>
        <View style={st.sheetBg}><View style={st.sheet}>
          <View style={st.sheetH}><Text style={st.title}>Voice settings</Text><TouchableOpacity onPress={() => setShowSet(false)}><Text style={st.hb}>✕</Text></TouchableOpacity></View>
          <Stepper label={`Speed ${s.rate.toFixed(1)}x`} onMinus={() => R.setRate(-0.1)} onPlus={() => R.setRate(0.1)} />
          <Stepper label={`Pause between points ${s.pauseSec}s`} onMinus={() => R.setPause(-1)} onPlus={() => R.setPause(1)} />
          <View style={st.row}>
            {(['auto', 'en', 'bn'] as const).map((l) => (
              <TouchableOpacity key={l} style={[st.opt, s.lang === l && st.optOn]} onPress={() => R.setLang(l)}>
                <Text style={s.lang === l ? st.youT : st.txt}>{l === 'auto' ? 'Auto' : l === 'en' ? 'English' : 'Bangla'}</Text>
              </TouchableOpacity>))}
          </View>
          <TouchableOpacity style={st.row} onPress={() => setAwake(!awake)}><Text style={st.txt}>Keep screen awake: {awake ? 'ON' : 'OFF'}</Text></TouchableOpacity>
        </View></View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const Stepper = ({ label, onMinus, onPlus }: { label: string; onMinus: () => void; onPlus: () => void }) => (
  <View style={st.row}>
    <Text style={[st.txt, { flex: 1 }]}>{label}</Text>
    <TouchableOpacity style={st.opt} onPress={onMinus}><Text style={st.txt}>−</Text></TouchableOpacity>
    <TouchableOpacity style={st.opt} onPress={onPlus}><Text style={st.txt}>＋</Text></TouchableOpacity>
  </View>
);

const C = { bg: '#FFFFFF', surf: '#F8F8F8', bd: '#E5E5E5', tx: '#0A0A0A', sec: '#737373', acc: '#0A0A0A' };
const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: (StatusBar.currentHeight || 30) + 4 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 18, fontWeight: '600', color: C.tx },
  hb: { fontSize: 20, color: C.tx },
  chip: { alignSelf: 'center', backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
  sub: { color: C.sec, fontSize: 12 },
  txt: { color: C.tx, fontSize: 15 },
  youT: { color: '#fff', fontSize: 15 },
  bubble: { backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 14, padding: 12, alignSelf: 'flex-start', maxWidth: '90%' },
  you: { backgroundColor: C.acc, alignSelf: 'flex-end' },
  empty: { borderWidth: 1, borderColor: C.bd, borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 40 },
  emptyT: { color: C.tx, fontSize: 16 },
  card: { backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 16, padding: 14, gap: 6 },
  cardT: { fontWeight: '600', color: C.tx, marginBottom: 4 },
  pt: { color: C.sec, fontSize: 15, paddingVertical: 2 },
  ptActive: { color: C.tx, fontWeight: '700', backgroundColor: '#E5E5E5', borderRadius: 8, paddingHorizontal: 6 },
  bar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderColor: C.bd },
  bb: { fontSize: 15, color: C.tx },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, paddingBottom: 18, borderTopWidth: 1, borderColor: C.bd },
  plus: { fontSize: 26, color: C.tx, paddingHorizontal: 6 },
  input: { flex: 1, backgroundColor: C.surf, borderColor: C.bd, borderWidth: 1, borderRadius: 16, paddingHorizontal: 14, height: 42, color: C.tx },
  mic: { backgroundColor: C.acc, width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10, elevation: 12 },
  sheetH: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  addBtn: { backgroundColor: C.acc, borderRadius: 12, padding: 12, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: C.bd },
  opt: { borderWidth: 1, borderColor: C.bd, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  optOn: { backgroundColor: C.acc },
});
