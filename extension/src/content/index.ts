import { ext } from '../common/api';
import { extractStreamTitle } from './title-extractor';
import { harvestDom } from './harvest';
import { applyHighlights, clearHighlights, revealUrl } from './highlight';
import { deepScan, abortDeepScan, closeViewer } from './deep_scan';
import { startPicker, stopPicker, selectorMatchCount } from './picker';

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
// Deep scan: scroll the feed out, open the viewer, then harvest with it open.
// Top frame only — scrolling a sub-frame is meaningless and would fight the
// parent for the viewport.
ext.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind === 'harvest:deep-abort') { abortDeepScan(); return; }
  if (msg?.kind !== 'harvest:deep') return;

  // Sub-frames can't scroll the top document, but they still hold media — an
  // embedded gallery is exactly where the good stuff hides. They skip the
  // scroll and just scan, so a deep run is never *narrower* than a quick one.
  if (!IS_TOP_FRAME) {
    void (async () => {
      try {
        const r = await harvestDom(msg.pageUrl || location.href);
        await ext.runtime.sendMessage({
          kind: 'harvest:frame-result', runId: msg.runId, isTop: false,
          candidates: r.candidates, scanned: r.scanned,
        });
      } catch { /* frame torn down mid-scan */ }
    })();
    return;
  }

  void (async () => {
    let opened = false;
    try {
      const result = await deepScan(
        (p) => {
          // Fire-and-forget progress; the sidebar renders it live.
          try { void ext.runtime.sendMessage({ kind: 'harvest:deep-progress', runId: msg.runId, ...p }); }
          catch { /* sidebar closed */ }
        },
        { maxMs: msg.maxMs || 90_000, openViewer: msg.openViewer !== false },
      );
      opened = result.phase === 'done';
      const harvested = await harvestDom(msg.pageUrl || location.href, 0, msg.scope || '');
      await ext.runtime.sendMessage({
        kind: 'harvest:frame-result',
        runId: msg.runId,
        isTop: true,
        candidates: harvested.candidates,
        scanned: harvested.scanned,
      });
    } catch (e) {
      try {
        await ext.runtime.sendMessage({
          kind: 'harvest:frame-result', runId: msg.runId, isTop: true, candidates: [], scanned: 0,
        });
      } catch { /* background gone */ }
    } finally {
      // Always put the page back the way we found it, even on failure.
      if (opened) { try { closeViewer(); } catch { /* ignore */ } }
    }
  })();
});

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

// NOTE: the legacy in-page panel and its FAB are no longer injected. The
// sidebar replaces them, and the floating button was the specific thing that
// made browsing worse. What the panel uniquely did still has a home:
//   - highlighting  -> ./highlight.ts, driven from the sidebar
//   - gallery zip   -> the server already batches and zips via /download
//   - element picker-> to be re-added as a sidebar-initiated mode
// The panel source stays in src/panel/ until the picker is ported, but nothing
// imports it, so esbuild drops it from the bundle.
