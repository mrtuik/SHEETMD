// Everything that should never be spoken is removed, and symbols are turned into words.
// stripMarkdown = light cleanup (keeps symbols) | cleanForSpeech = full cleanup for the voice + screen.

const NUM: Record<string, string> = {
  g: 'grams', mg: 'milligrams', 'µg': 'micrograms', 'μg': 'micrograms', mcg: 'micrograms', ng: 'nanograms', pg: 'picograms',
  mmol: 'millimoles', mEq: 'milliequivalents', IU: 'international units', U: 'units', cell: 'cells', cells: 'cells', mL: 'milliliters', L: 'liters',
};
const DEN: Record<string, string> = {
  dL: 'deciliter', mL: 'milliliter', L: 'liter', 'µL': 'microliter', 'μL': 'microliter', kg: 'kilogram', min: 'minute', hr: 'hour', h: 'hour',
  cmm: 'cubic millimeter', mm3: 'cubic millimeter', HPF: 'high power field', LPF: 'low power field', hpf: 'high power field', lpf: 'low power field',
};
const UNIT = /(^|[^A-Za-z])(g|mg|µg|μg|mcg|ng|pg|mmol|mEq|IU|U|cells?|mL|L)\s?\/\s?(dL|mL|µL|μL|L|kg|min|hr|h|cmm|mm3|HPF|LPF|hpf|lpf)(?![A-Za-z])/g;

const ICONS_RX = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{2500}-\u{27BF}\u{2900}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu;

// Markdown / box characters only. Symbols such as arrows stay so cleanForSpeech can turn them into words.
export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/`+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(\S[^_]*?)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[\u2500-\u257F]/g, ' ')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanForSpeech(input: string): string {
  const lines = input
    .replace(/\r/g, '')
    .replace(/```[^\n]*/g, '')
    .split('\n')
    .map((l) => l
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s*>+\s?/, '')
      .replace(/^\s*([-*+•▪◦●○■□✓✔➤►▶]|\d+[.)])\s+/, '')
      .trim())
    .filter((l) => l && !/^[\s|:\-=_*~]{3,}$/.test(l));            // rules + table separator rows

  let t = lines.map((l) => stripMarkdown(l.replace(/\|/g, ', ')))
    .map((l) => l.replace(/^[,\s]+|[,\s]+$/g, '').replace(/(,\s*){2,}/g, ', '))
    .filter(Boolean)
    .map((l) => (/[.!?।:;,]$/.test(l) ? l : l + '.'))
    .join(' ');

  t = t
    .replace(UNIT, (_m, pre, a, b) => `${pre}${NUM[a] ?? a} per ${DEN[b] ?? b}`)
    .replace(/\/\s?[µμ]L\b/g, ' per microliter')
    .replace(/[↑⬆⇧]/g, ' increased ')
    .replace(/[↓⬇⇩]/g, ' decreased ')
    .replace(/→|➔|➜|⇒|⟶|➡|->|=>/g, ' leads to ')
    .replace(/[↔⇄⇔]/g, ' and ')
    .replace(/≥|>=/g, ' greater than or equal to ')
    .replace(/≤|<=/g, ' less than or equal to ')
    .replace(/±/g, ' plus or minus ')
    .replace(/≈/g, ' approximately ')
    .replace(/×/g, ' times ')
    .replace(/(\d)\s?\^\s?(-?\d+)/g, '$1 to the power $2')
    .replace(/(\d)\s?[–—-]\s?(\d)/g, '$1 to $2')
    .replace(/°\s?C\b/g, ' degree Celsius ')
    .replace(/°\s?F\b/g, ' degree Fahrenheit ')
    .replace(/°/g, ' degree ')
    .replace(/[µμ](?=[A-Za-z])/g, 'micro')
    .replace(/%/g, ' percent ')
    .replace(/\s&\s/g, ' and ')
    .replace(/\s>\s?|>(?=\d)/g, ' greater than ')
    .replace(/\s<\s?|<(?=\d)/g, ' less than ')
    .replace(/(\d)\+/g, '$1 plus ')
    .replace(/\s\+\s/g, ' plus ')
    .replace(/\s=\s/g, ' equals ')
    .replace(/~(?=\d)/g, 'about ')
    .replace(/•/g, ', ')
    .replace(ICONS_RX, ' ')
    .replace(/[<>=+~#@^|\\*_]/g, ' ')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?,;:])\1+/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/([.!?।])\s*\./g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

// Sentence splitter: a full stop inside a number (12.5) is not a sentence end.
export function splitSentences(t: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    cur += t[i];
    if (/[.!?।]/.test(t[i]) && (i === t.length - 1 || /\s/.test(t[i + 1]))) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function splitLong(s: string, max: number): string[] {
  const out: string[] = [];
  while (s.length > max) {
    let cut = s.lastIndexOf(',', max);
    if (cut < 40) cut = s.lastIndexOf(' ', max);
    if (cut < 40) cut = max;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

// Short utterances queued one after another = speech that starts fast, can be paused mid-point, and can be highlighted live.
export function speechChunks(text: string, max = 220): string[] {
  const t = cleanForSpeech(text);
  if (!t) return [];
  const out: string[] = [];
  let buf = '';
  for (const s of splitSentences(t).flatMap((x) => splitLong(x, max))) {
    if (buf && buf.length + s.length > max) { out.push(buf); buf = ''; }
    buf = buf ? buf + ' ' + s : s;
    if (buf.length >= 18) { out.push(buf); buf = ''; }
  }
  if (buf) { if (out.length) out[out.length - 1] += ' ' + buf; else out.push(buf); }
  return out;
}
