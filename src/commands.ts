export type Cmd =
  | { t: 'topic'; q: string } | { t: 'repeat'; arg?: string }
  | { t: 'continue' | 'pause' | 'stop' | 'next' | 'prev' | 'slower' | 'faster' | 'unknown' };

const NUM: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

export function parse(s: string): Cmd {
  const x = s.trim().toLowerCase().replace(/[.!?]+$/, '');
  let m = x.match(/^topic\s+(.+)$/);
  if (m) return { t: 'topic', q: m[1] };
  m = x.match(/^repeat(?:\s+(?:point\s+)?(.+))?$/);
  if (m) return { t: 'repeat', arg: m[1] ? (NUM[m[1]] ?? m[1]) : undefined };
  if (/^(continue|resume)$/.test(x)) return { t: 'continue' };
  if (x === 'pause') return { t: 'pause' };
  if (x === 'stop') return { t: 'stop' };
  if (x === 'next') return { t: 'next' };
  if (/^(previous|back)$/.test(x)) return { t: 'prev' };
  if (x === 'slower') return { t: 'slower' };
  if (x === 'faster') return { t: 'faster' };
  return { t: 'unknown' };
}
