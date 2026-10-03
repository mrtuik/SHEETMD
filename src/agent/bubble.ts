// The floating "Jarvis orb": JS only tells the Kotlin overlay which state to draw and what text to show.
// The base state follows the mic (idle / listening); thinking and speaking are temporary overrides on top of it.
import { dev } from './device';

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

// ---- Assistant mode (the bubble is shown only while this is on) ----
export const assistantOn = (): boolean => { try { return !!dev?.isAssistantOn(); } catch { return false; } };
export const setAssistantMode = (on: boolean) => { try { dev?.setAssistantMode(on); } catch {} };
export const overlayGranted = (): boolean => { try { return !!dev?.hasOverlayPermission(); } catch { return false; } };
export const askOverlay = () => { try { dev?.requestOverlayPermission(); } catch {} };
