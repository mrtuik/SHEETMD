// Phase 2 / Part 2: notifications. Tools to read / reply to / dismiss notifications, and the "announce" listener that speaks new ones.
// Native side: modules/sheet-access (SheetNotificationListener). Same Tool contract as tools.ts: run() NEVER throws, returns { ok, result }.
// Banking / payment notifications are filtered natively AND here (they carry OTPs).
import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { Tool, ToolResult } from './tools';
import { isErr, errText } from './device';
import { blockedPkg } from './screen';

const acc: any = (() => { try { return requireNativeModule('SheetAccess'); } catch { return null; } })();
const has = () => !!acc && Platform.OS === 'android';
export const notifEnabled = (): boolean => { try { return has() && !!acc.notifEnabled(); } catch { return false; } };
export const notifOpenSettings = () => { try { acc?.notifOpenSettings(); } catch {} };

const ok = (result: string): ToolResult => ({ ok: true, result });
const no = (result: string): ToolResult => ({ ok: false, result });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required });
const S = (description: string) => ({ type: 'string', description });
const str = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const OFF = 'Notification control is not available in this build.';
const RESTRICTED = 'Notification access is off. I opened its settings: turn on "Sheet.md assistant". If it is greyed out: App info > the three dots > Allow restricted settings.';

type Notif = { key: string; pkg: string; app: string; title: string; text: string; time: number; canReply: boolean };
let last: Notif[] = [];                                         // the list the user last heard: "1", "2" ... refer to it

const gate = (): ToolResult | null => {
  if (!has()) return no(OFF);
  if (notifEnabled()) return null;
  notifOpenSettings();
  return no(RESTRICTED);
};

async function fetchList(n: number): Promise<{ list?: Notif[]; err?: string }> {
  try {
    const raw = await acc.notifList(n);
    if (isErr(raw)) return { err: errText(raw) };
    const l: Notif[] = (JSON.parse(String(raw)) as Notif[]).filter((x) => x && x.key && !blockedPkg(x.pkg || ''));
    last = l;
    return { list: l };
  } catch (e: any) { return { err: String(e?.message || 'I could not read the notifications.').slice(0, 160) }; }
}

// "ref" (1 = newest in the last list) or an app name; with neither, the newest one that can be replied to / dismissed
async function pick(a: any, needReply: boolean): Promise<{ n?: Notif; err?: string }> {
  if (!last.length) { const r = await fetchList(10); if (r.err) return { err: r.err }; }
  const ref = Number(a.ref), app = str(a.app).toLowerCase();
  let pool = last;
  if (ref >= 1 && ref <= last.length) pool = [last[ref - 1]];
  else if (app) pool = last.filter((x) => x.app.toLowerCase().includes(app) || app.includes(x.app.toLowerCase()));
  if (needReply) pool = pool.filter((x) => x.canReply);
  const n = pool[0];
  if (!n) return { err: needReply ? 'There is no notification I can reply to. Ask me to read them first.' : 'I could not find that notification.' };
  return { n };
}

export const NOTIFY_TOOLS: Tool[] = [
  {
    name: 'read_notifications', description: 'Read the newest notifications on the phone (app, who, text). Use when the user asks to hear / read their notifications or messages.',
    parameters: obj({ count: { type: 'number', description: 'How many (1-10, default 5)' } }),
    run: async (a) => {
      const g = gate(); if (g) return g;
      const n = Math.min(10, Math.max(1, Math.round(Number(a.count)) || 5));
      const r = await fetchList(n);
      if (r.err) return no(r.err);
      if (!r.list!.length) return ok('No new notifications.');
      return ok(r.list!.map((x, i) => `${i + 1}. ${x.app}${x.title ? ', ' + x.title : ''}: ${x.text}${x.canReply ? ' (can reply)' : ''}`).join('\n'));
    },
  },
  {
    name: 'reply_notification', description: 'Reply to a chat / SMS notification (WhatsApp, Messages...) with text. The user is asked to confirm first. ref = the number from read_notifications, or app = the app name.',
    parameters: obj({ text: S('The reply text'), ref: { type: 'number', description: 'Number from read_notifications (1 = first)' }, app: S('App name, when no number') }, ['text']),
    prepare: async (a) => {
      const text = str(a.text);
      if (!text) return no('What should I reply?');
      const g = gate(); if (g) return g;
      const p = await pick(a, true);
      if (!p.n) return no(p.err || 'I could not find that notification.');
      const n = p.n;
      return { ok: true, args: { key: n.key, text }, label: `${n.app}${n.title ? ', ' + n.title : ''}`, text, ask: `Reply "${text}" to ${n.title || n.app} on ${n.app}? Say yes.` };
    },
    run: async (a) => {
      if (!has()) return no(OFF);
      try { const r = await acc.notifReply(str(a.key), str(a.text)); return isErr(r) ? no(errText(r)) : ok('Reply sent.'); }
      catch (e: any) { return no(String(e?.message || 'failed').slice(0, 160)); }
    },
  },
  {
    name: 'dismiss_notification', description: 'Clear (swipe away) a notification. ref = number from read_notifications, or app = the app name.',
    parameters: obj({ ref: { type: 'number', description: 'Number from read_notifications (1 = first)' }, app: S('App name, when no number') }),
    run: async (a) => {
      const g = gate(); if (g) return g;
      const p = await pick(a, false);
      if (!p.n) return no(p.err || 'I could not find that notification.');
      try { const r = await acc.notifDismiss(p.n.key); if (isErr(r)) return no(errText(r)); last = last.filter((x) => x.key !== p.n!.key); return ok(`Cleared ${p.n.app}.`); }
      catch (e: any) { return no(String(e?.message || 'failed').slice(0, 160)); }
    },
  },
];

// ---- announce: a NEW notification of an allowed app is spoken once, only when the app is not already speaking and not in reading mode ----
export const parseAllow = (s: string): string[] => s.split(/[,\n;]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
export type Announcer = { enabled: () => boolean; apps: () => string[]; canSpeak: () => boolean; say: (text: string) => void };
export function startAnnouncer(h: Announcer): () => void {
  const seen = new Map<string, string>();
  const sub = acc?.addListener?.('onNotification', (e: any) => {
    try {
      if (!h.enabled() || !h.canSpeak()) return;
      const n = JSON.parse(String(e?.json || '{}')) as Notif;
      if (!n.key || blockedPkg(n.pkg || '')) return;
      const app = (n.app || '').toLowerCase(), pkg = (n.pkg || '').toLowerCase();
      if (!h.apps().some((a) => app.includes(a) || pkg.includes(a))) return;       // only the apps the user allowed
      const sig = (n.title || '') + '|' + (n.text || '');
      if (seen.get(n.key) === sig) return;                                          // the same notification updating itself: once only
      seen.set(n.key, sig); if (seen.size > 60) seen.delete(seen.keys().next().value as string);
      h.say(`${n.app}${n.title ? ', ' + n.title : ''}: ${n.text || ''}`.slice(0, 180));
    } catch {}
  });
  return () => { try { sub?.remove?.(); } catch {} };
}
