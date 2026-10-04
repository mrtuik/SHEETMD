// JS side of the Kotlin module modules/sheet-device. Every call is guarded: no module (iOS / old build) = a clear "not available", never a crash.
import { requireNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

export const dev: any = (() => { try { return requireNativeModule('SheetDevice'); } catch { return null; } })();
export const hasDevice = () => !!dev && Platform.OS === 'android';

// the native side answers with a string; "ERR:..." is a failure, anything else is the result text
export const isErr = (s: any) => typeof s === 'string' && s.startsWith('ERR:');
export const errText = (s: string) => s.replace(/^ERR:\s*/, '');

// Asks for the permission the first time a tool needs it. Returns null when granted, or a sentence for the user when not.
export async function need(perms: string[], why: string): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const r = await PermissionsAndroid.requestMultiple(perms as any);
    const vals = Object.values(r);
    if (vals.every((v) => v === 'granted')) return null;
    const never = vals.some((v) => v === 'never_ask_again');
    return `Permission needed: ${why}. ${never ? 'Turn it on in Android Settings > Apps > Sheet.md > Permissions.' : 'Please allow it and ask again.'}`;
  } catch { return `Permission needed: ${why}.`; }
}
