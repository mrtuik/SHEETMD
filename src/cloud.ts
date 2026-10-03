// The ONE provider / key / model configuration lives in llm.ts (Gemini + OpenRouter, Groq, Mistral, OpenAI, Custom).
// This file only keeps the names the Models screen already uses, so there is no second list that can drift from the first.
import * as L from './llm';
import type { ProviderId as Pid } from './llm';

export type ProviderId = Pid;
type Other = Exclude<Pid, 'gemini'>;
export const PROVIDERS = L.PROVIDERS;
export const KEY_LINK = Object.fromEntries(L.PROVIDERS.map((p) => [p.id, p.keyUrl])) as Record<Pid, string>;
export const DEFAULT_MODEL = Object.fromEntries(L.PROVIDERS.filter((p) => p.id !== 'gemini').map((p) => [p.id, p.model])) as Record<Other, string>;

// live view of llm.ts's config (getters: nothing is copied, so nothing can go stale)
export const cloud = {
  get provider(): Pid { return L.cloud.provider; },
  get key(): Record<Other, string> { return L.cloud.keys as Record<Other, string>; },
  get model(): Record<Other, string> { return new Proxy(L.cloud.models, { get: (t, k: string) => t[k] || DEFAULT_MODEL[k as Other] || '' }) as Record<Other, string>; },
  get customUrl(): string { return L.cloud.customBase; },
};
export const loadCloud = L.loadCloud;
export const saveProvider = L.setProvider;
export const saveCloudKey = (id: Other, k: string) => L.saveProviderKey(id, k);
export const saveCloudModel = (id: Other, m: string) => L.saveProviderModel(id, m);
export const saveCustomUrl = L.saveCustomBase;
// is this provider ready to be used? (a local custom server may need no key)
export function cloudReady(id: Pid): boolean {
  if (id === 'gemini') return L.hasGeminiKey();
  if (id === 'custom') return !!L.providerBase('custom') && !!L.providerModel('custom');
  return !!L.providerKey(id) && !!L.providerModel(id);
}

// ---- OpenRouter: the models that cost nothing, read live (so the list never goes stale) ----
export type OrModel = { id: string; name: string };
export async function openRouterFreeModels(): Promise<OrModel[]> {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j: any = await r.json();
  const list: any[] = Array.isArray(j?.data) ? j.data : [];
  return list
    .filter((m) => m && typeof m.id === 'string' && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && /text/i.test(String(m.architecture?.modality || 'text')))
    .map((m) => ({ id: String(m.id), name: String(m.name || m.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
