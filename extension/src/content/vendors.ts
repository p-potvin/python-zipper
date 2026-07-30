import * as zip from '@zip.js/zip.js';
import { ext } from '../common/api';

// The userscript pulled zip.js and FileSaver in as @require globals. Provide the
// same `zip` / `saveAs` / `unsafeWindow` globals the ported panel expects.
export function setupVendors(): void {
  // Disable web workers: their blob: worker scripts are blocked by many pages' CSP
  // when spawned from a content script. In-thread is fine for our zip sizes.
  try { (zip as any).configure?.({ useWebWorkers: false }); } catch { /* noop */ }
  (globalThis as any).zip = zip;
  
  (globalThis as any).saveAs = (blob: Blob | string, filename: string) => {
    let url: string;
    if (typeof blob === 'string') {
      url = blob;
    } else {
      url = URL.createObjectURL(blob);
    }
    console.log(`[saveAs Redirect] Requesting background download of ${filename} from ${url.substring(0, 100)}`);
    ext.runtime.sendMessage({
      kind: 'downloads:start',
      url: url,
      filename: filename
    });
  };

  // No real unsafeWindow in the isolated content world; the page-context Vue path
  // (OnlyFans) degrades gracefully behind its try/catch.
  if (!(globalThis as any).unsafeWindow) (globalThis as any).unsafeWindow = window;
}
