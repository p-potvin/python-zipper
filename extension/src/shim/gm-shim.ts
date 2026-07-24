import { ext } from '../common/api';

// Bridges the userscript's synchronous GM_* API onto WebExtension APIs so the
// existing panel/UI code can be ported with near-zero edits. GM_getValue is
// synchronous in Tampermonkey; we hydrate a cache up front, then serve reads
// synchronously and persist writes asynchronously (write-through).

const cache = new Map<string, any>();

// Keys the ported panel reads synchronously at startup. Add more as the port grows.
const PRELOAD_KEYS = [
  'zipper-fab-right', 'zipper-fab-bottom',
  'zipper-panel-right', 'zipper-panel-bottom',
];

export async function initGmShim(): Promise<void> {
  try {
    const stored = await ext.storage.local.get(PRELOAD_KEYS);
    for (const k of Object.keys(stored || {})) cache.set(k, stored[k]);
  } catch { /* storage unavailable */ }

  const g = globalThis as any;
  g.GM_getValue = GM_getValue;
  g.GM_setValue = GM_setValue;
  g.GM_deleteValue = GM_deleteValue;
  g.GM_xmlhttpRequest = GM_xmlhttpRequest;
  g.GM_setClipboard = GM_setClipboard;
  g.GM_addStyle = GM_addStyle;
  g.GM_notification = GM_notification;
}

export function GM_getValue(key: string, def?: any): any {
  return cache.has(key) ? cache.get(key) : def;
}

export function GM_setValue(key: string, val: any): void {
  cache.set(key, val);
  ext.storage.local.set({ [key]: val }).catch(() => {});
}

export function GM_deleteValue(key: string): void {
  cache.delete(key);
  ext.storage.local.remove(key).catch(() => {});
}

// Mirrors Tampermonkey's callback-style GM_xmlhttpRequest, routed through the
// background service worker for true cross-origin / mixed-content bypass.
export function GM_xmlhttpRequest(details: any): void {
  const req = {
    url: details.url,
    method: details.method || 'GET',
    headers: details.headers || {},
    data: details.data ?? null,
  };
  ext.runtime
    .sendMessage({ kind: 'gm:xhr', req })
    .then((res: any) => {
      if (res && res.ok) details.onload?.({ status: res.status, responseText: res.responseText });
      else details.onerror?.({ status: res?.status ?? 0 });
    })
    .catch(() => details.onerror?.({ status: 0 }));
}

export function GM_setClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export function GM_addStyle(css: string): HTMLStyleElement {
  const s = document.createElement('style');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
  return s;
}

export function GM_notification(opts: any): void {
  const o = typeof opts === 'string' ? { text: opts } : opts;
  ext.notifications?.create?.({
    type: 'basic',
    iconUrl: ext.runtime.getURL('icon.svg'),
    title: o.title || 'Zipper',
    message: o.text || '',
  });
}
