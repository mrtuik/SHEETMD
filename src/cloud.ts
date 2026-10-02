// Cloud API providers for "search ...". Gemini stays in llm.ts (it has real Google Search grounding).
// Every other provider here talks the OpenAI "chat/completions" format, so ONE small function serves OpenRouter, OpenAI and any Custom one.
// NOTE: OpenRouter / OpenAI / Custom answer from the model's own knowledge (no live Google). The app says so in the chat.
import { getMeta, setMeta } from './db';

export type ProviderId = 'gemini' | 'openrouter' | 'openai' | 'custom';
export const PROVIDERS: { id: ProviderId; label: string; note: string }[] = [
  { id: 'gemini', label: 'Google (Gemini)', note: 'Live Google search. Free key.' },
  { id: 'openrouter', label: 'OpenRouter', note: 'Many free models with one free key.' },
  { id: 'openai', label: 'OpenAI', note: 'Your OpenAI key (paid).' },
  { id: 'custom', label: 'Custom', note: 'Any OpenAI-compatible API: Groq, Together, Mistral, DeepSeek, LM Studio...' },
];
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENAI_BASE = 'https://api.openai.com/v1';
export const KEY_LINK: Record<ProviderId, string> = {
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  custom: '',
};
// sensible starting models (the box can be edited, and OpenRouter has a "Free models" list that is read live)
export const DEFAULT_MODEL: Record<'openrouter' | 'openai' | 'custom', string> = {
  openrouter: 'openrouter/free',
  openai: 'gpt-4o-mini',
  custom: '',
};

export type CloudCfg = {
  provider: ProviderId;
  key: Record<'openrouter' | 'openai' | 'custom', string>;
  model: Record<'openrouter' | 'openai' | 'custom', string>;
  customUrl: string;
};
export const cloud: CloudCfg = {
  provider: 'gemini',
  key: { openrouter: '', openai: '', custom: '' },
  model: { openrouter: DEFAULT_MODEL.openrouter, openai: DEFAULT_MODEL.openai, custom: '' },
  customUrl: '',
};

export async function loadCloud() {
  const g = async (k: string) => ((await getMeta(k).catch(() => '')) || '').trim();
  const p = (await g('cl_provider')) as ProviderId;
  if (PROVIDERS.some((x) => x.id === p)) cloud.provider = p;
  for (const id of ['openrouter', 'openai', 'custom'] as const) {
    cloud.key[id] = await g('cl_key_' + id);
    cloud.model[id] = (await g('cl_model_' + id)) || DEFAULT_MODEL[id];
  }
  cloud.customUrl = await g('cl_custom_url');
}
export const saveProvider = async (p: ProviderId) => { cloud.provider = p; await setMeta('cl_provider', p).catch(() => {}); };
export const saveCloudKey = async (id: 'openrouter' | 'openai' | 'custom', k: string) => { cloud.key[id] = k.trim(); await setMeta('cl_key_' + id, cloud.key[id]).catch(() => {}); };
export const saveCloudModel = async (id: 'openrouter' | 'openai' | 'custom', m: string) => { cloud.model[id] = m.trim(); await setMeta('cl_model_' + id, cloud.model[id]).catch(() => {}); };
export const saveCustomUrl = async (u: string) => { cloud.customUrl = u.trim(); await setMeta('cl_custom_url', cloud.customUrl).catch(() => {}); };

// is this provider ready to be used? (Gemini is checked by the caller: it also has the key built into the build)
export function cloudReady(id: ProviderId): boolean {
  if (id === 'gemini') return false;
  if (id === 'custom') return !!(cloud.customUrl && cloud.model.custom);        // a local server may need no key
  return !!cloud.key[id] && !!cloud.model[id];
}
export const baseOf = (id: 'openrouter' | 'openai' | 'custom'): string => {
  if (id === 'openrouter') return OPENROUTER_BASE;
  if (id === 'openai') return OPENAI_BASE;
  return cloud.customUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
};

// ---- one chat-completions call -------------------------------------------------------------------------------------
export async function chatCall(id: 'openrouter' | 'openai' | 'custom', model: string, prompt: string, signal: AbortSignal, maxTokens: number): Promise<{ status: number; text: string; err: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cloud.key[id]) headers.Authorization = 'Bearer ' + cloud.key[id];
  if (id === 'openrouter') { headers['HTTP-Referer'] = 'https://tuik.app'; headers['X-Title'] = 'Sheet.md'; }
  const body: any = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 };
  // newer OpenAI models want max_completion_tokens, everything else max_tokens
  if (id === 'openai' && /^(o\d|gpt-5)/i.test(model)) body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
  if (id === 'openai' && /^(o\d|gpt-5)/i.test(model)) delete body.temperature;
  const r = await fetch(baseOf(id) + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!r.ok) return { status: r.status, text: '', err: ((await r.text().catch(() => '')) || '').slice(0, 1200) };
  const data: any = await r.json().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content;
  let text = Array.isArray(raw) ? raw.map((x: any) => x?.text || '').join('') : String(raw || '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { status: 200, text, err: data?.error ? JSON.stringify(data.error).slice(0, 300) : '' };
}

// ---- OpenRouter: the models that cost nothing, read live (so the list never goes stale) -----------------------------
export type OrModel = { id: string; name: string };
export async function openRouterFreeModels(): Promise<OrModel[]> {
  const r = await fetch(OPENROUTER_BASE + '/models');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j: any = await r.json();
  const list: any[] = Array.isArray(j?.data) ? j.data : [];
  return list
    .filter((m) => m && typeof m.id === 'string' && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && /text/i.test(String(m.architecture?.modality || 'text')))
    .map((m) => ({ id: String(m.id), name: String(m.name || m.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
