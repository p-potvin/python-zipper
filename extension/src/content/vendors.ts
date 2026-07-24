import * as zip from '@zip.js/zip.js';
import { saveAs } from 'file-saver';

// The userscript pulled zip.js and FileSaver in as @require globals. Provide the
// same `zip` / `saveAs` / `unsafeWindow` globals the ported panel expects.
export function setupVendors(): void {
  // Disable web workers: their blob: worker scripts are blocked by many pages' CSP
  // when spawned from a content script. In-thread is fine for our zip sizes.
  try { (zip as any).configure?.({ useWebWorkers: false }); } catch { /* noop */ }
  (globalThis as any).zip = zip;
  (globalThis as any).saveAs = saveAs;
  // No real unsafeWindow in the isolated content world; the page-context Vue path
  // (OnlyFans) degrades gracefully behind its try/catch.
  if (!(globalThis as any).unsafeWindow) (globalThis as any).unsafeWindow = window;
}
