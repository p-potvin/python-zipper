import { ext } from '../common/api';
import { loadSettings, onSettingsChanged, type ZipperSettings } from '../common/settings';
import { extractStreamTitle } from './title-extractor';
import { harvestDom } from './harvest';
import {
  applyHighlights, clearHighlights, revealUrl, setGlobalHighlight, markEligible,
} from './highlight';
import { setInjectButton } from './inject_button';
import { setLiveScan } from './live_scan';
import { startPicker, stopPicker, selectorMatchCount } from './picker';
import { installOnlyFansGrabber } from './onlyfans';

// The manifest now injects into every frame, so the harvest can see embedded
// players and gallery iframes. Everything UI-shaped below must therefore be
// gated to the top frame — otherwise a page with ten iframes gets ten panels,
// and ten competing replies to a single title:extract request.
const IS_TOP_FRAME = (() => {
  try { return window.top === window.self; } catch { return false; }
})();

// Harvest runs in EVERY frame — that's the point of all_frames. The background
// broadcasts `harvest:run`; each frame scans and pushes its own result back,
// because tabs.sendMessage only returns the first frame's response.
ext.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind !== 'harvest:run') return;
  void (async () => {
    try {
      const result = await harvestDom(msg.pageUrl || location.href, 0, msg.scope || '');
      await ext.runtime.sendMessage({
        kind: 'harvest:frame-result',
        runId: msg.runId,
        candidates: result.candidates,
        scanned: result.scanned,
      });
    } catch (e) {
      // A frame that can't scan (cross-origin quirk, torn down mid-scan) must
      // not stall the run — report empty so the collector still counts it.
      try {
        await ext.runtime.sendMessage({
          kind: 'harvest:frame-result', runId: msg.runId, candidates: [], scanned: 0,
        });
      } catch { /* background gone */ }
    }
  })();
  // No sendResponse: results travel back as their own message.
});

// Listen for title extraction requests from the background sniffer.
// Registered immediately (outside the async IIFE) so it works even if the
// panel fails to initialise.
if (IS_TOP_FRAME) ext.runtime.onMessage.addListener(
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

// Highlighting is now driven by the sidebar rather than by the DOM walk, so it
// runs on demand against a set of URLs. Every frame answers: a highlighted
// element may well live inside an embedded gallery.
ext.runtime.onMessage.addListener(
  (msg: any, _sender: any, sendResponse: (r: any) => void) => {
    try {
      if (msg?.kind === 'highlight:show') {
        sendResponse({
          ok: true,
          hits: applyHighlights(msg.urls || [], msg.picked || [], msg.done || []),
        });
        return true;
      }
      if (msg?.kind === 'highlight:clear') {
        clearHighlights();
        sendResponse({ ok: true });
        return true;
      }
      if (msg?.kind === 'highlight:refresh') {
        sendResponse({ ok: true, hits: markEligible() });
        return true;
      }
      if (msg?.kind === 'highlight:reveal') {
        sendResponse({ ok: true, found: revealUrl(msg.url || '') });
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return true;
    }
    return undefined;
  },
);

// Container picker — top frame only; picking inside a sub-frame would produce
// a selector the top-level harvest can't resolve.
if (IS_TOP_FRAME) ext.runtime.onMessage.addListener(
  (msg: any, _sender: any, sendResponse: (r: any) => void) => {
    if (msg?.kind === 'picker:start') {
      void startPicker().then((selector) => {
        try { void ext.runtime.sendMessage({ kind: 'picker:result', selector }); }
        catch { /* sidebar closed mid-pick */ }
      });
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.kind === 'picker:stop') { stopPicker(); sendResponse({ ok: true }); return true; }
    if (msg?.kind === 'picker:count') {
      sendResponse({ ok: true, count: selectorMatchCount(msg.selector || '') });
      return true;
    }
    return undefined;
  },
);

// OnlyFans: Alt+Q grabs the whole media grid, exactly as the userscript did.
if (IS_TOP_FRAME && /(^|\.)onlyfans\.com$/i.test(location.hostname)) installOnlyFansGrabber();

// ---- global options ---------------------------------------------------------
//
// Highlighting, the download button and live scanning are browsing-session
// preferences, not per-scan state — see common/settings.ts. Applied on load and
// re-applied whenever the switch moves, in every frame, so an embedded gallery
// behaves the same as the top document.
function applySettings(s: ZipperSettings): void {
  try { setGlobalHighlight(s.highlight); } catch { /* pre-render document */ }
  try { setInjectButton(s.injectButton, s.minButtonPx); } catch { /* ignore */ }
  try { setLiveScan(s.liveScan); } catch { /* ignore */ }
}

void loadSettings().then(applySettings).catch(() => { /* storage unavailable */ });
onSettingsChanged(applySettings);

// NOTE: the legacy in-page panel and its FAB are no longer injected. The
// sidebar replaces them, and the floating button was the specific thing that
// made browsing worse. What the panel uniquely did still has a home:
//   - highlighting  -> ./highlight.ts, driven from the sidebar
//   - gallery zip   -> the server already batches and zips via /download
//   - element picker-> to be re-added as a sidebar-initiated mode
// The panel source stays in src/panel/ until the picker is ported, but nothing
// imports it, so esbuild drops it from the bundle.
