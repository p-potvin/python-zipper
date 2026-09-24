/**
 * Page-world hook, OnlyFans only.
 *
 * Runs in the page's own JavaScript world (`"world": "MAIN"` in the manifest),
 * which is the only way to see what the page's framework hangs on its DOM. A
 * normal content script is isolated: it shares the DOM but not expando
 * properties, so `element.__vue__` there is always undefined. The userscript
 * reached it through `unsafeWindow`; this is the extension's equivalent.
 *
 * The contract is deliberately tiny: the isolated content script asks a fixed
 * question by id, this answers with plain JSON. Nothing here evaluates anything
 * the page or the content script sends, and a page that posts the question to
 * itself only learns what it already knows about its own gallery.
 */

const CHANNEL_REQ = 'zipper:page-probe';
const CHANNEL_RES = 'zipper:page-probe-result';

/**
 * The full-size URLs of the open photo viewer.
 *
 * OnlyFans mounts PhotoSwipe inside a Vue component on `div.photoswipe`, and
 * the component's `dataSource` prop is the whole grid — every item the feed
 * has loaded, not just the ones on screen. That is the entire trick the
 * userscript relied on, and why it scrolls to the bottom first.
 */
function onlyFansDataSource(): string[] {
  const el: any = document.querySelector('div.photoswipe');
  const vue = el?.__vue__;
  const ds = vue ? (vue.dataSource || vue._props?.dataSource) : null;
  if (!ds) return [];
  return Array.from(ds as ArrayLike<any>)
    .map((item: any) => (item && typeof item.src === 'string' ? item.src : ''))
    .filter(Boolean);
}

function reply(id: string, ok: boolean, data: any): void {
  try {
    window.postMessage({ source: CHANNEL_RES, id, ok, data }, window.location.origin || '*');
  } catch { /* structured clone failed — nothing sensible to send */ }
}

window.addEventListener('message', (e: MessageEvent) => {
  // Same-window only. This channel exists to cross the isolated/main boundary
  // inside one document, never between documents.
  if (e.source !== window) return;
  const msg: any = e.data;
  if (!msg || msg.source !== CHANNEL_REQ || typeof msg.id !== 'string') return;
  try {
    if (msg.op === 'of:datasource') reply(msg.id, true, { urls: onlyFansDataSource() });
  } catch (err) {
    reply(msg.id, false, { error: String(err) });
  }
});
