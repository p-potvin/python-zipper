import { initGmShim } from '../shim/gm-shim';
import { setupVendors } from './vendors';
import { start } from '../panel/main';

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
