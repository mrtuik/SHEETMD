import { requireNativeModule } from 'expo';
const M: any = (() => { try { return requireNativeModule('SheetService'); } catch { return null; } })();

export const updateService = (title: string, text: string, playing: boolean, mic: boolean) => {
  try { M?.update(title, text, playing, mic); } catch {}
};
export const stopService = () => { try { M?.stop(); } catch {} };
export const onServiceAction = (cb: (a: string) => void) => {
  const sub = M?.addListener?.('onAction', (e: any) => cb(e.action));
  return () => { try { sub?.remove?.(); } catch {} };
};
