// Phase 2 / Part 1: the assistant's hands. Tools that read and operate the phone screen through the AccessibilityService
// (modules/sheet-access). Same Tool contract as tools.ts: run() NEVER throws and returns { ok, result }.
// Safety is enforced in the Kotlin service AND here: banking / payment apps are never read, risky taps always ask "...? Say yes."
import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { Tool, ToolCtx, ToolResult } from './tools';
import { isErr, errText } from './device';
import { cloud, gem, GEMINI_MODELS, providerBase, providerKey, providerModel } from '../llm';
import { bubbleScreen, bubbleReply } from './bubble';

const acc: any = (() => { try { return requireNativeModule('SheetAccess'); } catch { return null; } })();
const has = () => !!acc && Platform.OS === 'android';
export const accEnabled = (): boolean => { try { return has() && !!acc.isEnabled(); } catch { return false; } };
export const accOpenSettings = () => { try { acc?.openSettings(); } catch {} };
export const accOpenAppInfo = () => { try { acc?.openAppInfo(); } catch {} };

const ok = (result: string, final?: string): ToolResult => ({ ok: true, result, final });
const no = (result: string): ToolResult => ({ ok: false, result });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required });
const S = (description: string) => ({ type: 'string', description });
const str = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const OFF = 'Phone screen control is not available in this build.';
const RESTRICTED = 'Accessibility is off. I opened its settings: turn on "Sheet.md assistant". If it is greyed out: App info > the three dots > Allow restricted settings.';

// ---- safety (mirror of the Kotlin guard) ----------------------------------------------------------------------------
const DENY = ['com.google.android.apps.nbu.paisa.user', 'com.phonepe.app', 'net.one97.paytm'];
export const blockedPkg = (p: string) => DENY.includes(p.toLowerCase()) || /bank/i.test(p);
// a tap on something that sounds like send / pay / delete ... is never done before the user says yes
const RISK = /\b(send|pay|buy|delete|remove|post|submit|install|confirm|transfer)/i;
// problems that end a whole task at once (the phone, not the step, is the problem)
const FATAL = /locked|banking|payment|secure|cannot see the screen|accessibility is off/i;

type Node = { i: number; text?: string; desc?: string; id?: string; cls?: string; clickable?: boolean; editable?: boolean; scrollable?: boolean; pw?: boolean };
// plain optional fields (not a union): the project runs with strict:false, where a union would not narrow
type Screen = { ok: boolean; pkg?: string; nodes?: Node[]; error?: string };
let lastNodes: Node[] = [];

async function read(): Promise<Screen> {
  if (!has()) return { ok: false, error: OFF };
  try {
    const raw = await acc.readScreen();
    if (isErr(raw)) return { ok: false, error: errText(raw) };
    const j = JSON.parse(String(raw));
    const pkg = String(j.pkg || '');
    if (blockedPkg(pkg)) return { ok: false, error: 'I do not read or touch banking and payment apps.' };
    lastNodes = Array.isArray(j.nodes) ? j.nodes : [];
    return { ok: true, pkg, nodes: lastNodes };
  } catch (e: any) { return { ok: false, error: String(e?.message || 'I could not read the screen.').slice(0, 160) }; }
}
// compact lines for the model: index | class | text | description | flags
const lines = (nodes: Node[]) => nodes.map((n) =>
  [n.i, n.cls || '', n.pw ? '(password field)' : (n.text || '').slice(0, 70), (n.desc || '').slice(0, 50), (n.clickable ? 'c' : '') + (n.editable ? 'e' : '') + (n.scrollable ? 's' : '')].join('|')).join('\n');
const labelOf = (n?: Node) => (n ? n.text || n.desc || '' : '');
const askRisk = (what: string, args: any): ToolResult => ({ ok: true, result: '', confirm: { question: `${what}? Say yes.`, args: { ...args, approved: true } } });

async function doNative(fn: () => any): Promise<ToolResult> {
  if (!has()) return no(OFF);
  try { const r = await fn(); return isErr(r) ? no(errText(r)) : ok(String(r ?? 'OK')); }
  catch (e: any) { return no(String(e?.message || e || 'failed').slice(0, 160)); }
}
const enabledOrOpen = (): ToolResult | null => {
  if (!has()) return no(OFF);
  if (accEnabled()) return null;
  accOpenSettings();
  return no(RESTRICTED);
};

// ---- one model call that returns a JSON step ------------------------------------------------------------------------
async function askJson(sys: string, user: string, signal?: AbortSignal): Promise<{ ok: boolean; json?: any; err?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, 25000);
  const onAbort = () => { try { ctl.abort(); } catch {} };
  signal?.addEventListener?.('abort', onAbort);
  const parse = (t: string) => { const m = t.replace(/<think>[\s\S]*?<\/think>/gi, '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; };
  try {
    if (cloud.provider === 'gemini') {
      if (!gem.key) return { ok: false, err: 'Add a Gemini key in Models first.' };
      for (const m of Array.from(new Set<string>([gem.model, ...GEMINI_MODELS.map((x) => x.id)]))) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gem.key }, signal: ctl.signal,
          body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' } }),
        });
        if (r.status === 401 || r.status === 403) return { ok: false, err: 'The API key was rejected. Check it in Models.' };
        if (!r.ok) continue;                                             // limit used up / retired model: the next one
        const d: any = await r.json().catch(() => null);
        const txt = (d?.candidates?.[0]?.content?.parts || []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join('');
        try { const j = parse(txt); if (j) return { ok: true, json: j }; } catch {}
      }
      return { ok: false, err: 'The model did not answer. Try again.' };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (providerKey()) headers.Authorization = 'Bearer ' + providerKey();
    const body: any = { model: providerModel(), messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
    if (cloud.provider === 'openai') body.max_completion_tokens = 400; else { body.max_tokens = 400; body.temperature = 0; }
    const r = await fetch(providerBase().replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (r.status === 401 || r.status === 403) return { ok: false, err: 'The API key was rejected. Check it in Models.' };
    if (r.status === 429 || r.status === 402) return { ok: false, err: 'The model\'s free limit is used up for now.' };
    if (!r.ok) return { ok: false, err: `The model service answered with an error (${r.status}).` };
    const d: any = await r.json().catch(() => null);
    const c = d?.choices?.[0]?.message?.content;
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text || '').join('') : '';
    try { const j = parse(txt); if (j) return { ok: true, json: j }; } catch {}
    return { ok: false, err: 'The model did not answer with a usable step.' };
  } catch (e: any) {
    return { ok: false, err: signal?.aborted ? 'Stopped.' : ctl.signal.aborted ? 'The model took too long to answer.' : 'I cannot reach the internet.' };
  } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
}

const STEP_SYS = `You operate an Android phone screen to reach the user's GOAL, ONE step at a time.
You see the visible items as lines: index|class|text|description|flags (c = clickable, e = editable, s = scrollable).
Reply with ONLY one JSON object: {"action":"tap|type|scroll|back|home|wait|done|fail","i":<item index, for tap>,"text":"<text to type>","dir":"up|down|left|right","say":"<one short sentence for the user, only for done or fail>"}
Rules:
- Pick the single best next step. To type, the field must be focused: tap the field first, then type in the next step.
- Open apps through the goal only if they are not already open: use action "home" then tap the app icon, or tap what is on screen.
- Do not touch banking, payment or password screens. Never invent items that are not in the list.
- Use "done" only when the goal is truly finished (the message is sent, the video is playing...). Say in "say" what happened, in the user's language.
- If you are stuck or the screen does not match, use "fail" and say why.`;

const MAX_STEPS = 15, BUDGET_MS = 40000;
const actText = (a: any, n?: Node) => a.action === 'tap' ? `tap "${labelOf(n) || 'item ' + a.i}"` : a.action === 'type' ? `type "${str(a.text).slice(0, 40)}"` : a.action === 'scroll' ? `scroll ${a.dir || 'down'}` : a.action;

// read screen -> ask for ONE next action -> do it -> repeat. A step that must be confirmed ends the run with a question; "yes" runs this tool again with args.act.
async function runTask(a: any, c: ToolCtx): Promise<ToolResult> {
  const goal = str(a.goal);
  if (!goal) return no('What should I do on the screen?');
  const gate = enabledOrOpen(); if (gate) return gate;
  const t0 = Date.now();
  const hist: string[] = Array.isArray(a.hist) ? a.hist.slice(-10).map(String) : [];
  let steps = Number(a.steps) || 0;
  let approved: any = a.act && typeof a.act === 'object' ? a.act : null;       // the step the user just said yes to
  bubbleScreen(true);
  try {
    for (;;) {
      if (c.signal?.aborted) return no('Stopped.');
      if (steps >= MAX_STEPS) return no(`I used all ${MAX_STEPS} steps and did not finish.${hist.length ? ' Last step: ' + hist[hist.length - 1] : ''}`);
      if (Date.now() - t0 > BUDGET_MS) return no('That took too long, so I stopped.');
      const scr = await read();
      if (!scr.ok) return no(scr.error || 'I could not read the screen.');
      let act: any = approved; const wasApproved = !!approved; approved = null;
      if (!act) {
        const r = await askJson(STEP_SYS, `GOAL: ${goal}\nSTEPS SO FAR:\n${hist.length ? hist.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none)'}\nSCREEN (app ${scr.pkg}):\n${lines(scr.nodes || [])}`, c.signal);
        if (c.signal?.aborted) return no('Stopped.');
        if (!r.ok) return no(r.err || 'The model did not answer.');
        act = r.json;
      }
      const kind = str(act?.action).toLowerCase();
      const node = kind === 'tap' ? (scr.nodes || []).find((n) => n.i === Number(act.i)) : undefined;
      if (kind === 'done') { const say = str(act.say) || 'Done.'; return ok(say, say); }
      if (kind === 'fail') return no(str(act.say) || 'I could not do that.');
      if (kind === 'tap' && !node) { hist.push(`tap item ${act.i}: not on the screen`); steps++; continue; }
      // a step that sounds like send / pay / delete ... waits for the user's "yes" (enforced here, not in the prompt)
      if (kind === 'tap' && !wasApproved && RISK.test(labelOf(node))) {
        return askRisk(`${goal.slice(0, 70)}: tap "${labelOf(node)}"`, { goal, hist, steps, act });
      }
      steps++;
      bubbleReply(`Step ${steps}: ${actText(act, node)}`);
      let r: ToolResult;
      if (kind === 'tap') r = await doNative(() => acc.tapIndex(Number(act.i), false));
      else if (kind === 'type') r = await doNative(() => acc.typeText(str(act.text)));
      else if (kind === 'scroll') r = await doNative(() => acc.scroll(str(act.dir) || 'down'));
      else if (kind === 'back' || kind === 'home') r = await doNative(() => acc.global(kind));
      else if (kind === 'wait') r = ok('waited');
      else { hist.push(`unknown action ${kind}`); continue; }
      if (!r.ok && FATAL.test(r.result)) return no(r.result);
      hist.push(`${actText(act, node)}: ${r.ok ? 'ok' : 'FAILED - ' + r.result}`);
      await sleep(kind === 'wait' ? 1200 : 800);                                // let the app draw its next screen
    }
  } finally { bubbleScreen(false); }
}

export const SCREEN_TOOLS: Tool[] = [
  {
    name: 'run_screen_task',
    description: 'Do something INSIDE another app by looking at the screen and tapping / typing step by step (send a WhatsApp message, search and play on YouTube, change an app setting...). Give the whole goal in plain words. Max 15 steps, 40 seconds. Risky steps (send, pay, delete...) are confirmed by the user first.',
    parameters: obj({ goal: S('The complete goal, e.g. "In WhatsApp send Rahul the message: ami ashchi"') }, ['goal']),
    run: (a, c) => runTask(a, c).catch((e: any) => { bubbleScreen(false); return no(String(e?.message || e || 'failed').slice(0, 160)); }),
  },
  {
    name: 'screen_read', description: 'Read what is visible on the phone screen right now (text of the items, which are buttons / fields).', parameters: obj({}),
    run: async () => {
      const g = enabledOrOpen(); if (g) return g;
      const s = await read();
      return s.ok ? ok(`App ${s.pkg}\n${lines(s.nodes || [])}`.slice(0, 6000)) : no(s.error || 'I could not read the screen.');
    },
  },
  {
    name: 'screen_tap', description: 'Tap an item on the screen: by its index from screen_read, or by its visible text. Taps that send / pay / delete are confirmed by the user first.',
    parameters: obj({ index: { type: 'number', description: 'Item index from screen_read' }, text: S('Visible text or description of the item') }),
    run: async (a) => {
      const g = enabledOrOpen(); if (g) return g;
      const idx = a.index === undefined || a.index === null || a.index === '' ? -1 : Number(a.index), txt = str(a.text);
      if (idx < 0 && !txt) return no('Which item should I tap?');
      const label = idx >= 0 ? labelOf(lastNodes.find((n) => n.i === idx)) : txt;
      if (!a.approved && RISK.test(label)) return askRisk(`Tap "${label}"`, a);
      return doNative(() => (idx >= 0 ? acc.tapIndex(idx, false) : acc.tapText(txt, false)));
    },
  },
  {
    name: 'screen_type', description: 'Type text into the focused text field (tap the field first). Never works in password fields.',
    parameters: obj({ text: S('Text to type') }, ['text']),
    run: async (a) => { const g = enabledOrOpen(); if (g) return g; const t = str(a.text); return t ? doNative(() => acc.typeText(t)) : no('What should I type?'); },
  },
  {
    name: 'screen_scroll', description: 'Scroll the current screen.',
    parameters: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'down = see what is further down' } }, ['direction']),
    run: async (a) => { const g = enabledOrOpen(); if (g) return g; return doNative(() => acc.scroll(str(a.direction) || 'down')); },
  },
  {
    name: 'press_key', description: 'Press a system key: back, home, recents, notifications (pull the shade), quickSettings, lockScreen, screenshot.',
    parameters: obj({ key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quickSettings', 'lockScreen', 'screenshot'], description: 'The key' } }, ['key']),
    run: async (a) => { const g = enabledOrOpen(); if (g) return g; return doNative(() => acc.global(str(a.key))); },
  },
];
