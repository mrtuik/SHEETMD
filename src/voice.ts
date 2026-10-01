// Picks the clearest voice the phone has. expo-speech uses the phone's own text-to-speech engine,
// so clarity depends on the installed voices: "network" / "enhanced" voices sound far more natural than the default one.
import * as Speech from 'expo-speech';

export type Vc = { identifier: string; name: string; language: string; quality: string };
let cache: Vc[] | null = null;

export async function loadVoices(force = false): Promise<Vc[]> {
  if (cache && !force) return cache;
  try { cache = ((await Speech.getAvailableVoicesAsync()) as Vc[]) || []; } catch { cache = []; }
  return cache;
}

const rank = (v: Vc, lang: 'en' | 'bn') => {
  const id = `${v.identifier} ${v.name}`.toLowerCase();
  let s = 0;
  if (String(v.quality).toLowerCase() === 'enhanced') s += 100;
  if (/network|neural|wavenet|studio|premium|enhanced/.test(id)) s += 40;
  if (/-x-/.test(id)) s += 5;                                   // Google voices
  const l = v.language.replace('_', '-').toLowerCase();
  if (lang === 'en') s += l === 'en-us' ? 10 : l === 'en-gb' ? 8 : l === 'en-in' ? 6 : l.startsWith('en') ? 2 : -1000;
  else s += l === 'bn-bd' ? 10 : l === 'bn-in' ? 8 : l.startsWith('bn') ? 2 : -1000;
  return s;
};

export const voicesFor = (all: Vc[], lang: 'en' | 'bn') =>
  all.filter((v) => rank(v, lang) > -500).sort((a, b) => rank(b, lang) - rank(a, lang));

export const bestFor = (all: Vc[], lang: 'en' | 'bn') => voicesFor(all, lang)[0]?.identifier || '';
