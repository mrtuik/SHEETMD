// The floating assistant bubble: JS only tells the Kotlin overlay which state to draw, what text to show, and what the MENU contains.
// The base state follows the mic (idle / listening); thinking and speaking are temporary overrides on top of it.
import { dev } from './device';
import { toolByName } from './tools';

export type BubbleState = 'idle' | 'listening' | 'thinking' | 'speaking';
let base: BubbleState = 'idle';
let over: BubbleState | null = null;
let heard = '';
const draw = () => { try { dev?.bubbleState(over || base); } catch {} };

export const bubbleListening = (on: boolean) => { base = on ? 'listening' : 'idle'; draw(); };
export const bubbleOverride = (s: BubbleState | null) => { over = s; draw(); };
export const bubbleHeard = (t: string) => { heard = t; try { dev?.bubbleToast(heard, ''); } catch {} };
export const bubbleReply = (t: string) => { try { dev?.bubbleToast(heard, t); } catch {} };

// tap on the bubble (long-press opens the app natively, no JS needed)
export const onBubbleTap = (cb: () => void) => {
  const sub = dev?.addListener?.('onBubble', (e: any) => { if (e?.type === 'tap') cb(); });
  return () => { try { sub?.remove?.(); } catch {} };
};

// ---- bubble menu (chevron on the bubble). "open" and "type" are handled natively; everything else arrives here as {type:'action', id} ----
export type MenuHandlers = {
  talk: () => void;                     // same as a bubble tap
  exec: (text: string) => void;         // run text like typed input
  stopAll: () => void;                  // reader + generation + agent + speech + pending
  pause: () => void; resume: () => void; next: () => void; prev: () => void;
  playing: () => boolean;
  topics: () => Promise<string[]>;
  last: () => string[];                 // last chat messages, newest last
  hide: () => void;                     // Assistant mode off
};
type Item = { id: string; label: string; glyph: string; open?: boolean };
let H: MenuHandlers | null = null;
let torchOn = false;
let timer: any = null;

const menu = (): Item[] => [
  { id: 'talk', label: 'Talk', glyph: '●' },
  { id: 'type', label: 'Type a command', glyph: '✎' },
  { id: 'stop', label: 'Stop everything', glyph: '■' },
  { id: 'pp', label: H?.playing() ? 'Pause' : 'Play', glyph: H?.playing() ? '❚❚' : '▶' },
  { id: 'next', label: 'Next', glyph: '»' },
  { id: 'prev', label: 'Previous', glyph: '«' },
  { id: 'topics', label: 'Topics', glyph: '☰', open: true },
  { id: 'quick', label: 'Quick actions', glyph: '⚡', open: true },
  { id: 'last', label: 'Last messages', glyph: '≡', open: true },
  { id: 'open', label: 'Open Sheet.md', glyph: '↗' },
  { id: 'hide', label: 'Hide bubble', glyph: '✕' },
];
const list = (title: string, items: Item[]) => { try { dev?.bubbleList(title, JSON.stringify(items)); } catch {} };
const pushMenu = () => { try { dev?.setBubbleMenu(JSON.stringify(menu())); } catch {} };
// debounced: the play/pause label follows the reader status
export const refreshBubbleMenu = () => { if (!H) return; clearTimeout(timer); timer = setTimeout(pushMenu, 300); };

// quick actions run the SAME tools as the assistant (src/agent/tools.ts), no new logic
const tool = async (name: string, args: any) => {
  const r = await toolByName(name)?.run(args, { exec: () => {}, askNotes: () => {} });
  bubbleReply(r?.result || 'Not available.');
  return !!r?.ok;
};

const onAction = async (e: any) => {
  if (!H || e?.type !== 'action') return;
  const id = String(e.id || '');
  if (id.startsWith('topic:')) { H.exec('exact ' + id.slice(6)); return; }
  switch (id) {
    case 'talk': H.talk(); break;
    case 'type': if (e.text) H.exec(String(e.text)); break;
    case 'stop': H.stopAll(); break;
    case 'pp': H.playing() ? H.pause() : H.resume(); refreshBubbleMenu(); break;
    case 'next': H.next(); break;
    case 'prev': H.prev(); break;
    case 'hide': H.hide(); break;
    case 'topics': {
      let n: string[] = []; try { n = await H.topics(); } catch {}
      list('Topics', n.slice(0, 8).map((x) => ({ id: 'topic:' + x, label: x, glyph: '☰' })));
      break;
    }
    case 'last': list('Last messages', H.last().map((t) => ({ id: '', label: t, glyph: '' }))); break;
    case 'quick': list('Quick', [
      { id: 'q:torch', label: torchOn ? 'Flashlight off' : 'Flashlight on', glyph: '☀' },
      { id: 'q:volup', label: 'Volume up', glyph: '+' },
      { id: 'q:voldown', label: 'Volume down', glyph: '−' },
      { id: 'q:timer', label: '5 minute timer', glyph: '◷' },
    ]); break;
    case 'q:torch': if (await tool('torch', { on: !torchOn })) torchOn = !torchOn; break;
    case 'q:volup': await tool('set_volume', { level: 'up' }); break;
    case 'q:voldown': await tool('set_volume', { level: 'down' }); break;
    case 'q:timer': await tool('set_timer', { seconds: 300, label: '5 min' }); break;
  }
};

// registered once; returns the cleanup
export const registerBubbleMenu = (h: MenuHandlers) => {
  H = h; pushMenu();
  const sub = dev?.addListener?.('onBubble', onAction);
  return () => { try { sub?.remove?.(); } catch {} clearTimeout(timer); H = null; };
};

// ---- Assistant mode (the bubble is shown only while this is on) ----
export const assistantOn = (): boolean => { try { return !!dev?.isAssistantOn(); } catch { return false; } };
export const setAssistantMode = (on: boolean) => { try { dev?.setAssistantMode(on); } catch {} };
export const overlayGranted = (): boolean => { try { return !!dev?.hasOverlayPermission(); } catch { return false; } };
export const askOverlay = () => { try { dev?.requestOverlayPermission(); } catch {} };
