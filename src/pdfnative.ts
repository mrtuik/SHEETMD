import { requireNativeModule } from 'expo';
const M: any = (() => { try { return requireNativeModule('SheetPdf'); } catch { return null; } })();
const need = () => { if (!M) throw new Error('PDF module missing in this build'); return M; };
export const open = (p: string): Promise<number> => need().open(p);
export const readPages = (s: number, e: number): Promise<string[]> => need().readPages(s, e);
export const close = (): Promise<void> => need().close();
export const ocrPdfPage = (p: string, n: number): Promise<string> => need().ocrPdfPage(p, n);
export const ocrImage = (p: string): Promise<string> => need().ocrImage(p);
