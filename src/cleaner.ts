// FR-9: strip everything that should never be spoken
export function cleanForSpeech(t: string): string {
  return t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|/g, ', ')
    .replace(/^\s*([-•▪◦*]|\d+[.)])\s+/gm, '')
    .replace(/[-=_*~]{3,}/g, ' ')
    .replace(/[#*_>~`]/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/\s=\s/g, ' equals ')
    .replace(/[\/\\]{2,}/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?,;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
