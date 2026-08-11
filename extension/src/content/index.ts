import { ext } from '../common/api';
import { initGmShim } from '../shim/gm-shim';
import { setupVendors } from './vendors';
import { start } from '../panel/main';
import { extractStreamTitle } from './title-extractor';

// Listen for title extraction requests from the background sniffer.
// Registered immediately (outside the async IIFE) so it works even if the
// panel fails to initialise.
ext.runtime.onMessage.addListener(
  (msg: any, _sender: any, sendResponse: (r: any) => void) => {
    if (msg?.kind === 'title:extract') {
      try {
        const result = extractStreamTitle(msg.streamUrl);
        sendResponse(result);
      } catch (e) {
        sendResponse({ title: '', source: 'not-found', error: String(e) });
      }
    }
    return true; // keep the channel open for async sendResponse
  },
);

// The content script now only hosts the VaultWares image-harvest panel. All
// stream detection/download UI lives in the toolbar popup (streams are queried
// only while the popup is open), so nothing stream-related is injected here.
(async () => {
  await initGmShim();
  setupVendors();
  try {
    await start();
  } catch (e) {
    console.error('[Zipper] panel init failed', e);
  }
})();
