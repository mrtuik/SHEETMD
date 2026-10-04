// Small web lookup used by "explain <topic>": Wikipedia search + intro text (needs internet; nothing is stored).
const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]) as Promise<T | null>;

export async function wikiLookup(query: string, chars = 2500): Promise<{ title: string; text: string } | null> {
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=1'
      + `&gsrsearch=${encodeURIComponent(query)}&prop=extracts&exintro=1&explaintext=1&exchars=${chars}`;
    const r: any = await timeout(fetch(url), 8000);
    if (!r || !r.ok) return null;
    const j = await r.json();
    const pages = j?.query?.pages;
    const p: any = pages ? (Object.values(pages) as any[])[0] : null;
    const text = String(p?.extract || '').trim();
    return text.length > 40 ? { title: String(p.title || query), text } : null;
  } catch { return null; }
}
