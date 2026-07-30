import { ext, IS_FIREFOX } from '../common/api';
import type { DetectedStream, StreamType } from '../common/types';

// ---- Detection tables -------------------------------------------------------

const URL_PATTERNS: { re: RegExp; type: StreamType }[] = [
  { re: /\.m3u8(?:[?#]|$)/i, type: 'hls' },
  { re: /\.mpd(?:[?#]|$)/i, type: 'dash' },
  { re: /\.f4m(?:[?#]|$)/i, type: 'hls' },
  { re: /\.ism(?:\/|[?#]|$)|\/manifest\([^)]*\)/i, type: 'smooth' },
];

const CT_PATTERNS: { re: RegExp; type: StreamType }[] = [
  { re: /application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl/i, type: 'hls' },
  { re: /application\/dash\+xml/i, type: 'dash' },
  { re: /application\/vnd\.ms-sstr\+xml/i, type: 'smooth' },
  { re: /video\/(mp4|webm|x-flv|quicktime)/i, type: 'video' },
];

// Capture everything except hop-by-hop / transport noise. Auth lives in headers
// we previously dropped — Authorization, and Proxy-Authorization when the
// browser reaches the CDN through an authenticated proxy.
const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'upgrade', 'accept-encoding',
]);
const MIN_VIDEO_BYTES = 1024 * 1024;

// ---- Identity / dedup -------------------------------------------------------

// Two URLs are "the same stream" when their origin + path match; query strings
// carry rotating auth tokens/timestamps that must not create duplicates.
export function streamKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

export function isSegmentOrChunkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    // Discard common media segment extensions
    if (/\.(ts|m4s|mp4|aac|mp3|m4a|m4v|png|jpg|jpeg|webp|css|js)(?:\?|$)/i.test(path)) {
      return true;
    }
    // Discard HLS chunks, segments, fragments, parts, keys
    const chunkKeywords = /(chunk|segment|fragment|frag|part|sec|index|media|track|layer|level|variant|quality|hls-)[0-9]/i;
    if (chunkKeywords.test(path) || chunkKeywords.test(u.search)) {
      return true;
    }
    // Discard paths with segment index/number at the end
    const endsWithDigits = /[\-_/]\d+\.m3u8$/i;
    if (endsWithDigits.test(path)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function cleanStreamTitle(title: string): string {
  if (!title) return '';
  let t = title.trim();
  t = t.replace(/\s*[-|•·]\s*(pornxp|1porn|fullvideos|xvideos|xhamster|spankbang|pornhub|youtube|vimeo|redtube)[a-z0-9.]*/gi, '');
  t = t.replace(/\s+[-|•·]\s+.*$/g, '');
  t = t.replace(/(free porn video|watch online|download mp4)/gi, '');
  t = t.replace(/[\s\-_|]+$/, '').replace(/^[\s\-_|]+/, '');
  return t || 'stream';
}

// Some players fire a placeholder request (e.g. ?key=null) before the real,
// keyed one. Such a URL must never overwrite a properly-authed URL for the same
// stream, or the download 401s.
const AUTH_PARAM = /(^|[_-])(key|token|sig|signature|auth|hash|expires|policy|hdnts|hdnea|jwt)([_-]|$)/i;
function isBadAuthUrl(url: string): boolean {
  try {
    for (const [k, v] of new URL(url).searchParams) {
      if (AUTH_PARAM.test(k) && (v === '' || v === 'null' || v === 'undefined' || v === 'None')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- Per-tab store ----------------------------------------------------------

type TabStreams = Map<string, DetectedStream>;
const store = new Map<number, TabStreams>();
// Variant playlist keys that belong to a detected master — hidden from the list.
const childKeys = new Map<number, Set<string>>();
const pending = new Map<string, { tabId: number; headers: Record<string, string> }>();

let onNewStream: ((s: DetectedStream) => void) | null = null;
export function setOnNewStream(cb: (s: DetectedStream) => void): void { onNewStream = cb; }

function tabMap(tabId: number): TabStreams {
  let m = store.get(tabId);
  if (!m) { m = new Map(); store.set(tabId, m); }
  return m;
}

function pickHeaders(list: any[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const n = h?.name?.toLowerCase();
    if (n && !SKIP_HEADERS.has(n)) out[h.name] = h.value ?? '';
  }
  return out;
}

function updateBadge(tabId: number): void {
  const n = store.get(tabId)?.size ?? 0;
  try {
    ext.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    ext.action.setBadgeBackgroundColor?.({ tabId, color: '#e11d48' });
  } catch { /* action unavailable on some pages */ }
}

function notify(tabId: number): void {
  // The popup polls for stream state, so there is no content-script listener to
  // push to — just refresh the toolbar badge. (Messaging the tab here caused an
  // unhandled "Receiving end does not exist" rejection on every detection.)
  updateBadge(tabId);
}

async function register(
  tabId: number,
  url: string,
  type: StreamType,
  headers: Record<string, string>,
  contentType?: string,
): Promise<void> {
  if (tabId < 0) return;
  const key = streamKey(url);
  if (childKeys.get(tabId)?.has(key)) return; // folded under a master

  const m = tabMap(tabId);
  const existing = m.get(key);
  if (existing) {
    const newBad = isBadAuthUrl(url);
    const oldBad = isBadAuthUrl(existing.url);
    // Keep a keyed URL; only replace when the new one is no worse. Upgrading
    // from a bad (key=null) URL to a good one re-arms the probe.
    if (!newBad || oldBad) {
      existing.url = url;
      if (Object.keys(headers).length) existing.headers = headers;
      if (oldBad && !newBad) { existing.probed = false; existing.meta = undefined; }
    }
    existing.lastSeen = Date.now();
    existing.hits += 1;
    notify(tabId);
    return;
  }

  let pageUrl = '';
  let title = '';
  try {
    const t = await ext.tabs.get(tabId);
    pageUrl = t?.url ?? '';
    title = cleanStreamTitle(t?.title ?? '');
  } catch { /* tab gone */ }

  const s: DetectedStream = {
    key, id: key, url, type, tabId, pageUrl, title, headers, contentType,
    firstSeen: Date.now(), lastSeen: Date.now(), hits: 1,
  };
  m.set(key, s);
  notify(tabId);
  onNewStream?.(s);
}

// ---- Public API for the message router / enrichment ------------------------

export function getStreams(tabId: number): DetectedStream[] {
  return Array.from(store.get(tabId)?.values() ?? []).sort((a, b) => a.firstSeen - b.firstSeen);
}

export function getStream(tabId: number, key: string): DetectedStream | undefined {
  return store.get(tabId)?.get(key);
}

export function removeStream(tabId: number, key: string): void {
  store.get(tabId)?.delete(key);
  notify(tabId);
}

export function clearTab(tabId: number): void {
  store.delete(tabId);
  childKeys.delete(tabId);
  notify(tabId);
}

// Fold a master's variant playlists: hide any already-listed and block future ones.
export function foldVariants(tabId: number, variantUrls: string[]): void {
  let set = childKeys.get(tabId);
  if (!set) { set = new Set(); childKeys.set(tabId, set); }
  const m = store.get(tabId);
  for (const vu of variantUrls) {
    const k = streamKey(vu);
    set.add(k);
    if (m?.has(k)) m.delete(k);
  }
  notify(tabId);
}

// Re-emit the updated event after enrichment mutates a stream in place.
export function touch(tabId: number): void { notify(tabId); }

// ---- webRequest wiring ------------------------------------------------------

export function installSniffer(): void {
  const filter = { urls: ['<all_urls>'] };
  const reqSpec: string[] = ['requestHeaders'];
  const resSpec: string[] = ['responseHeaders'];
  if (!IS_FIREFOX) { reqSpec.push('extraHeaders'); resSpec.push('extraHeaders'); }

  ext.webRequest.onSendHeaders.addListener((d: any) => {
    if (isSegmentOrChunkUrl(d.url)) return;
    const headers = pickHeaders(d.requestHeaders);
    pending.set(d.requestId, { tabId: d.tabId, headers });
    for (const p of URL_PATTERNS) {
      if (p.re.test(d.url)) { void register(d.tabId, d.url, p.type, headers); break; }
    }
  }, filter, reqSpec);

  ext.webRequest.onHeadersReceived.addListener((d: any) => {
    if (isSegmentOrChunkUrl(d.url)) return;
    const rh = d.responseHeaders || [];
    const ct = rh.find((h: any) => h.name?.toLowerCase() === 'content-type')?.value || '';
    for (const c of CT_PATTERNS) {
      if (!c.re.test(ct)) continue;
      if (c.type === 'video') {
        const len = parseInt(rh.find((h: any) => h.name?.toLowerCase() === 'content-length')?.value || '0', 10);
        if (len && len < MIN_VIDEO_BYTES) break;
      }
      const p = pending.get(d.requestId);
      void register(d.tabId, d.url, c.type, p?.headers ?? {}, ct);
      break;
    }
  }, filter, resSpec);

  const cleanup = (d: any) => pending.delete(d.requestId);
  ext.webRequest.onCompleted.addListener(cleanup, filter);
  ext.webRequest.onErrorOccurred.addListener(cleanup, filter);

  ext.tabs.onRemoved.addListener((tabId: number) => clearTab(tabId));
  ext.tabs.onUpdated.addListener((tabId: number, info: any) => {
    if (info.status === 'loading' && info.url) clearTab(tabId);
  });
}
