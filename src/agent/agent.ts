// The assistant brain: an LLM function-calling loop (max 5 tool rounds per request) over the tools in tools.ts.
// Provider-agnostic: Gemini (functionDeclarations) or any OpenAI-compatible API (tools / tool_calls: OpenAI, OpenRouter, Groq, Mistral, Custom).
// The provider / key / model are the SAME ones the Models screen saves (llm.ts) - there is no second config.
// Calls and SMS are never run at once: the loop stops, asks "...? yes", and the next yes / no decides (pending action, 15 s).
import { cloud, cloudReady, gem, GEMINI_MODELS, providerBase, providerKey, providerLabel, providerModel } from '../llm';
import { listFacts } from '../db';
import { isGreeting } from '../commands';
import { TOOLS, toolByName, Tool, ToolResult } from './tools';

export type AgentCtx = {
  history: () => { who: 'you' | 'app'; text: string }[];   // the current chat (the last 8 are sent)
  exec: (t: string) => void;                                // study mode (App.exec)
  askNotes: (q: string) => void;                            // question answered from the user's sources
  reply: (text: string) => void;                            // show in chat AND speak
  state: (s: 'thinking' | 'idle') => void;                  // bubble animation
};
export const agentReady = () => cloudReady();

// ---------------------------------------------------------------------------------------------------------------------
// language of the user's words: Bangla script, Banglish (Bangla in Latin letters) or English
type Lang = 'en' | 'bn' | 'bl';
const BANGLISH = /\b(koro|korbo|kore|korun|kholo|ke|amar|ami|tumi|bolo|dao|daw|achhe|ache|nai|ekta|ekhon|ki|kemon|jao|thako|pathao|rakho|dekhao|bondho|chalu|ta|ta[ra]|tomar|nam|ghonta|minute er|por)\b/i;
const langOf = (t: string): Lang => (/[\u0980-\u09FF]/.test(t) ? 'bn' : BANGLISH.test(t) ? 'bl' : 'en');

// ---------------------------------------------------------------------------------------------------------------------
// gates used by App before a SPOKEN sentence may reach the agent (typed text always may)
const toks = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
export function looksLikeRequest(t: string): boolean {
  const n = toks(t).length;
  return n >= 2 && n <= 30 && !isGreeting(t);                 // one stray word / room noise is not a request
}
let lastReply = { tok: new Set<string>(), at: 0 };
// the mic hears the app's OWN spoken reply: never feed it back as a question
export function echoOfReply(t: string): boolean {
  if (Date.now() - lastReply.at > 30000) return false;
  const h = toks(t);
  if (h.length < 2) return false;
  const sp = new Set([...lastReply.tok].map((w) => w.slice(0, 5)));
  return h.filter((w) => sp.has(w.slice(0, 5))).length / h.length >= 0.6;
}
const noteReply = (t: string) => { lastReply = { tok: new Set(toks(t)), at: Date.now() }; };
export const noteSpoken = noteReply;          // spoken announcements (notifications) must not be mistaken for the user's voice either

// ---------------------------------------------------------------------------------------------------------------------
// confirmation layer
type Pending = { tool: Tool; args: any; label: string; expires: number; lang: Lang };
let pending: Pending | null = null;
const CONFIRM_MS = 15000;
export function hasPending(): boolean {
  if (pending && Date.now() > pending.expires) pending = null;       // 15 s with no answer = dropped
  return !!pending;
}
export const armPending = () => { if (pending) pending.expires = Date.now() + CONFIRM_MS; };   // the 15 s start when the question has been spoken
export const dropPending = () => { pending = null; };
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'haan', 'han', 'ha', 'haa', 'hya', 'hyan', 'kor', 'koro', 'korun', 'kore', 'dao', 'confirm', 'হ্যাঁ', 'হাঁ', 'হ্যা', 'হা', 'হ্যাঁ।', 'করো', 'কর', 'ঠিক', 'আছে', 'ওকে']);
const NO = new Set(['no', 'nope', 'nah', 'na', 'naa', 'cancel', 'thak', 'thaak', 'thako', 'dorkar', 'nei', 'না', 'থাক', 'থাকুক', 'বাদ', 'ক্যান্সেল']);
// "haan" / "na" ...: only a SHORT answer made of those words counts (the app's own long question can never match)
export function confirmVerdict(text: string, speaking = false): 'yes' | 'no' | null {
  if (speaking || !hasPending()) return null;
  const w = toks(text);
  if (!w.length || w.length > 3) return null;
  const y = w.some((x) => YES.has(x)), n = w.some((x) => NO.has(x));
  return n && !y ? 'no' : y && !n && w.every((x) => YES.has(x) || x === 'please' || x === 'bolo') ? 'yes' : null;
}
const T = {
  cancelled: { en: 'Okay, cancelled.', bl: 'Thik ache, cancel korlam.', bn: 'ঠিক আছে, বাতিল করলাম।' },
};
function question(tool: string, label: string, text: string | undefined, lang: Lang): string {
  if (tool === 'send_sms') {
    return lang === 'bn' ? `${label}-কে মেসেজ পাঠাব: "${text}"? হ্যাঁ বলো।` : lang === 'bl' ? `${label} ke message pathabo: "${text}"? Haan bolo.` : `Send "${text}" to ${label}? Say yes.`;
  }
  return lang === 'bn' ? `${label}-কে কল করব? হ্যাঁ বলো।` : lang === 'bl' ? `${label} ke call korbo? Haan bolo.` : `Call ${label}? Say yes.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// provider adapters. Turn = what the model said: text and/or tool calls.
type Call = { id: string; name: string; args: any };
type Turn = { text: string; calls: Call[] };
type Res = { call: Call; r: ToolResult };
interface Adapter { call(signal: AbortSignal): Promise<Turn>; addResults(turn: Turn, res: Res[]): void }
class AgentError extends Error {}
const resultJson = (r: ToolResult) => JSON.stringify({ ok: r.ok, result: r.result });

function httpError(status: number, body: string): AgentError {
  const b = body.slice(0, 400);
  if (status === 401 || status === 403 || (status === 400 && /api[ _]?key[^"]{0,40}(not valid|invalid)|API_KEY_INVALID/i.test(b))) return new AgentError('The API key was rejected. Check it in Models.');
  if (status === 429 || status === 402) return new AgentError('The model\'s free limit is used up for now. Try again later or pick another model in Models.');
  if (/tool|function/i.test(b) && (status === 404 || status === 400)) return new AgentError('This model cannot use tools. Pick another model in Models.');
  if (status === 404) return new AgentError('That model was not found. Check the model name in Models.');
  return new AgentError(`The model service answered with an error (${status}).`);
}
async function post(url: string, headers: Record<string, string>, body: any, signal: AbortSignal): Promise<{ status: number; json: any; text: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  signal.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text().catch(() => '');
    let json: any = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e: any) {
    if (signal.aborted) throw e;
    throw new AgentError(ctl.signal.aborted ? 'The model took too long to answer.' : 'I cannot reach the internet.');
  } finally { clearTimeout(timer); }
}

// merge consecutive same-role turns and start with the user (both APIs are stricter than they look)
function tidyHistory(h: { role: 'user' | 'assistant'; text: string }[]) {
  const out: typeof h = [];
  for (const m of h) { if (!m.text.trim()) continue; const l = out[out.length - 1]; if (l && l.role === m.role) l.text += '\n' + m.text; else out.push({ ...m }); }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

class GeminiAdapter implements Adapter {
  contents: any[] = [];
  constructor(private sys: string, hist: { role: 'user' | 'assistant'; text: string }[], user: string) {
    for (const m of tidyHistory([...hist, { role: 'user', text: user }])) this.contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] });
  }
  private decls() {
    return TOOLS.map((t) => {
      const has = Object.keys(t.parameters.properties).length > 0;
      return has ? { name: t.name, description: t.description, parameters: { ...t.parameters, required: t.parameters.required.length ? t.parameters.required : undefined } } : { name: t.name, description: t.description };
    });
  }
  async call(signal: AbortSignal): Promise<Turn> {
    // each Gemini model has its own free limit: a used-up / retired one falls through to the next, like search does
    const order = Array.from(new Set<string>([gem.model, ...GEMINI_MODELS.map((m) => m.id)]));
    let err: AgentError = new AgentError('The model did not answer.');
    for (const m of order) {
      const r = await post(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { 'x-goog-api-key': gem.key }, {
        systemInstruction: { parts: [{ text: this.sys }] },
        contents: this.contents,
        tools: [{ functionDeclarations: this.decls() }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { maxOutputTokens: 1024 },
      }, signal);
      if (r.status !== 200) { err = httpError(r.status, r.text); if (r.status === 401 || r.status === 403) throw err; continue; }
      const content = r.json?.candidates?.[0]?.content;
      const parts: any[] = content?.parts || [];
      if (!parts.length) { err = new AgentError('The model gave an empty answer. Try again.'); continue; }
      this.contents.push(content);                               // kept exactly as sent (Gemini 3 needs its thought signatures back)
      const calls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: 'g' + i, name: String(p.functionCall.name), args: p.functionCall.args || {} }));
      return { text: parts.filter((p) => p.text && !p.thought).map((p) => String(p.text)).join('').trim(), calls };
    }
    throw err;
  }
  addResults(_t: Turn, res: Res[]) {
    this.contents.push({ role: 'user', parts: res.map((x) => ({ functionResponse: { name: x.call.name, response: { ok: x.r.ok, result: x.r.result } } })) });
  }
}

class ChatAdapter implements Adapter {
  messages: any[] = [];
  constructor(sys: string, hist: { role: 'user' | 'assistant'; text: string }[], user: string) {
    this.messages.push({ role: 'system', content: sys });
    for (const m of tidyHistory([...hist, { role: 'user', text: user }])) this.messages.push({ role: m.role, content: m.text });
  }
  async call(signal: AbortSignal): Promise<Turn> {
    const id = cloud.provider, model = providerModel();
    const headers: Record<string, string> = {};
    if (providerKey()) headers.Authorization = 'Bearer ' + providerKey();
    if (id === 'openrouter') headers['X-Title'] = 'Sheet.md';
    const body: any = {
      model, messages: this.messages, tool_choice: 'auto',
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    };
    if (id === 'openai') body.max_completion_tokens = 1024; else body.max_tokens = 1024;     // newer OpenAI models reject max_tokens
    const r = await post(providerBase().replace(/\/+$/, '') + '/chat/completions', headers, body, signal);
    if (r.status !== 200) throw httpError(r.status, r.text);
    const msg = r.json?.choices?.[0]?.message;
    if (!msg) throw new AgentError('The model gave an empty answer. Try again.');
    const raw = Array.isArray(msg.content) ? msg.content.map((x: any) => x?.text || '').join('') : String(msg.content || '');
    const calls: Call[] = (msg.tool_calls || []).map((c: any, i: number) => {
      let args: any = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      return { id: String(c.id || 'c' + i), name: String(c.function?.name || ''), args };
    });
    this.messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    return { text: raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(), calls };
  }
  addResults(_t: Turn, res: Res[]) { for (const x of res) this.messages.push({ role: 'tool', tool_call_id: x.call.id, content: resultJson(x.r) }); }
}
const makeAdapter = (sys: string, hist: { role: 'user' | 'assistant'; text: string }[], user: string): Adapter =>
  cloud.provider === 'gemini' ? new GeminiAdapter(sys, hist, user) : new ChatAdapter(sys, hist, user);

// ---------------------------------------------------------------------------------------------------------------------
const systemPrompt = (facts: string[]) => `You are Sheet.md's voice assistant on the user's Android phone. Reply in the user's language: English, Bangla, or Banglish (Bangla in Latin letters) - match theirs.
Your reply is SPOKEN aloud: at most 2 short sentences unless the user asks for more. Plain text only: no markdown, no lists, no emoji.
Use the tools to act on the phone. Never invent a tool result and never say an action worked unless the tool returned ok. If a tool fails, say so clearly in one sentence and say why.
For calls and SMS just call the tool; the app asks the user to confirm. When the user says "mone rakho ..." or "remember ...", call remember with a short fact.
To do something inside another app (send a WhatsApp message, search or play on YouTube, change a setting) call run_screen_task with the whole goal in the user's words; screen_read only to tell the user what is on screen. Never say it worked unless the tool returned ok.\nTo hear notifications call read_notifications; to answer one call reply_notification (the app asks the user first); dismiss_notification clears one. Never read out one-time codes.\nTo read a study topic aloud use start_study. For a study or lab question that their notes may answer use ask_notes. For facts you are unsure of or anything current use web_search.
Now: ${new Date().toString()}.${facts.length ? '\nKnown facts about the user:\n- ' + facts.join('\n- ') : ''}`;

const MAX_ROUNDS = 5;
let job = 0;
let abort: AbortController | null = null;
export function cancelAgent() { job++; try { abort?.abort(); } catch {} abort = null; }

async function safeRun(tool: Tool, args: any, ctx: AgentCtx, signal: AbortSignal): Promise<ToolResult> {
  try {
    return await tool.run(args || {}, { exec: ctx.exec, askNotes: ctx.askNotes, signal });
  } catch (e: any) { return { ok: false, result: String(e?.message || e || 'failed').slice(0, 160) }; }   // a tool never throws into the loop
}

// returns the text to say ('' = say nothing)
async function converse(text: string, ctx: AgentCtx, signal: AbortSignal): Promise<string> {
  const facts = (await listFacts().catch(() => [])).map((f) => f.text);
  let h = ctx.history().filter((m) => !m.text.startsWith('\u2063')).slice(-9);          // topic / option cards carry a hidden marker: not chat
  if (h.length && h[h.length - 1].who === 'you' && h[h.length - 1].text.trim() === text.trim()) h = h.slice(0, -1);   // the current message is sent separately
  const hist = h.slice(-8).map((m) => ({ role: (m.who === 'you' ? 'user' : 'assistant') as 'user' | 'assistant', text: m.text }));
  const ad = makeAdapter(systemPrompt(facts), hist, text);
  const lang = langOf(text);
  let lastOk = '';
  for (let round = 0; ; round++) {
    const turn = await ad.call(signal);
    if (!turn.calls.length) return turn.text || lastOk || 'Done.';
    if (round >= MAX_ROUNDS) return lastOk || 'I could not finish that. Please try a simpler request.';
    const res: Res[] = [];
    let final: string | null = null;
    for (const c of turn.calls) {
      const tool = toolByName(c.name);
      if (!tool) { res.push({ call: c, r: { ok: false, result: 'Unknown tool ' + c.name } }); continue; }
      if (tool.prepare) {                                                                    // call / SMS: ask first, never run now
        const p = await tool.prepare(c.args || {}).catch((e: any): ToolResult => ({ ok: false, result: String(e?.message || e).slice(0, 160) }));
        if (p.ok && 'args' in p) {
          pending = { tool, args: p.args, label: p.label, expires: Date.now() + CONFIRM_MS + 6000, lang };
          return p.ask || question(tool.name, p.label, p.text, lang);
        }
        res.push({ call: c, r: p as ToolResult });
        continue;
      }
      const r = await safeRun(tool, c.args, ctx, signal);
      if (r.confirm) { pending = { tool, args: r.confirm.args, label: '', expires: Date.now() + CONFIRM_MS + 6000, lang }; return r.confirm.question; }   // a step inside a tool needs a yes (screen tasks)
      res.push({ call: c, r });
      if (r.ok) lastOk = r.result;
      if (r.final !== undefined) final = r.final;
    }
    if (final !== null) return final;
    ad.addResults(turn, res);
  }
}

export async function runAgent(text: string, ctx: AgentCtx): Promise<void> {
  cancelAgent();
  const my = ++job, ctl = new AbortController();
  abort = ctl;
  ctx.state('thinking');
  let out = '';
  try { out = await converse(text, ctx, ctl.signal); }
  catch (e: any) { if (my !== job) return; out = e instanceof AgentError ? e.message : 'Something went wrong. Please try again.'; }
  if (my !== job) return;                                                                    // stopped, or a newer request took over
  ctx.state('idle');
  if (out) { noteReply(out); ctx.reply(out); }
}

// the user answered yes / no to the pending question
export async function resolvePending(v: 'yes' | 'no', ctx: AgentCtx): Promise<void> {
  const p = pending; pending = null;
  if (!p) return;
  if (v === 'no') { const m = T.cancelled[p.lang]; noteReply(m); ctx.reply(m); return; }
  cancelAgent();
  const my = ++job, ctl = new AbortController(); abort = ctl;
  ctx.state('thinking');
  const r = await safeRun(p.tool, p.args, ctx, ctl.signal);
  if (my !== job) return;
  ctx.state('idle');
  if (r.confirm) { pending = { tool: p.tool, args: r.confirm.args, label: '', expires: Date.now() + CONFIRM_MS + 6000, lang: p.lang }; noteReply(r.confirm.question); ctx.reply(r.confirm.question); return; }   // the next risky step
  noteReply(r.result); ctx.reply(r.result);
}

// Settings > Assistant > "Check": one tiny request with the tools attached, so a model that cannot use tools is found here, not in the middle of a command
export async function checkProvider(): Promise<string> {
  if (!cloudReady()) return 'Not ready: pick a provider and add its key in Models.';
  const ctl = new AbortController();
  try {
    const t = await makeAdapter('Reply with the single word OK.', [], 'Say OK.').call(ctl.signal);
    return `${providerLabel()} works with tools${t.text || t.calls.length ? '' : ' (empty answer)'}.`;
  } catch (e: any) { return e instanceof AgentError ? e.message : 'Check failed. Try again.'; }
}
