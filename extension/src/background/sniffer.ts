import { ext, IS_FIREFOX } from '../common/api';
import type { DetectedStream, StreamType, TitleSource } from '../common/types';

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

let lastPanelOpenTime = Date.now();
let hasActiveDownloads = false;
let activeDownloadsCount = 0;

export function updatePanelOpenTime(): void {
  lastPanelOpenTime = Date.now();
}

export function setHasActiveDownloads(countOrActive: boolean | number): void {
  if (typeof countOrActive === 'number') {
    activeDownloadsCount = countOrActive;
    hasActiveDownloads = countOrActive > 0;
  } else {
    hasActiveDownloads = countOrActive;
    activeDownloadsCount = countOrActive ? (activeDownloadsCount || 1) : 0;
  }
  refreshAllBadges();
}

export function isSnifferIdle(): boolean {
  return false;
}

// ---- Identity / dedup -------------------------------------------------------

// Two URLs are "the same stream" when their origin + path match; query strings
// carry rotating auth tokens/timestamps that must not create duplicates.
export function streamKey(url: string): string {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/\/+$/, '');
    return u.origin + p;
  } catch {
    return url;
  }
}

export function isSegmentOrChunkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const search = u.search.toLowerCase();

    // Discard variant playlists and llhls streams
    if (/(chunklist|llhls|variant-list|stream-inf|rendition|subtitles|audio-track|video-track)/i.test(path) ||
        /(chunklist|llhls|variant-list|stream-inf|rendition|subtitles|audio-track|video-track)/i.test(search)) {
      return true;
    }

    // Discard common media segment extensions
    if (/\.(ts|m4s|aac|mp3|m4a|m4v|png|jpg|jpeg|webp|css|js|vtt|srt)(?:\?|$)/i.test(path)) {
      return true;
    }
    // Discard HLS chunks, segments, fragments, parts, keys
    const chunkKeywords = /(chunk|segment|fragment|frag|part|sec|index|media|track|layer|level|variant|quality|hls-)[_.-]?[0-9]/i;
    if (chunkKeywords.test(path) || chunkKeywords.test(search)) {
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

/** Higher number = higher priority. When two title sources compete, the higher one wins. */
const TITLE_PRIORITY: Record<TitleSource, number> = {
  'element': 6,
  'biggest-video': 5,
  'ytdlp': 4,
  'meta': 3,
  'page-title': 2,
  'tab-title': 1,
  'not-found': 0,
};

export function cleanStreamTitle(title: string): string {
  if (!title) return '';
  let t = title.trim();
  t = t.replace(/\s*[-|•·]\s*\b(pornxp|1porn|fullvideos|xvideos|xhamster|spankbang|pornhub|youtube|vimeo|redtube)\b[a-z0-9.]*/gi, '');
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

export function updateBadge(tabId: number): void {
  try {
    if (hasActiveDownloads) {
      const text = activeDownloadsCount > 1 ? `DL${activeDownloadsCount}` : 'DL';
      ext.action.setBadgeText({ text });
      ext.action.setBadgeText({ tabId, text });
      ext.action.setBadgeBackgroundColor?.({ color: '#2563eb' });
      ext.action.setBadgeBackgroundColor?.({ tabId, color: '#2563eb' });
    } else {
      const n = store.get(tabId)?.size ?? 0;
      ext.action.setBadgeText({ text: '' });
      ext.action.setBadgeText({ tabId, text: n ? String(n) : '' });
      ext.action.setBadgeBackgroundColor?.({ tabId, color: '#e11d48' });
    }
  } catch { /* action unavailable on some pages */ }
}

export function refreshAllBadges(): void {
  try {
    if (hasActiveDownloads) {
      const text = activeDownloadsCount > 1 ? `DL${activeDownloadsCount}` : 'DL';
      ext.action.setBadgeText({ text });
      ext.action.setBadgeBackgroundColor?.({ color: '#2563eb' });
    }
    ext.tabs.query({}, (tabs: any[]) => {
      for (const t of tabs || []) {
        if (t.id !== undefined) updateBadge(t.id);
      }
    });
  } catch { /* ignore */ }
}

function notify(tabId: number): void {
  updateBadge(tabId);
}

async function register(
  tabId: number,
  url: string,
  type: StreamType,
  headers: Record<string, string>,
  contentType?: string,
): Promise<void> {
  if (isSnifferIdle()) return;
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

  // Prepend hostname to the initial tab-title fallback
  if (title && pageUrl) {
    try { title = `[${new URL(pageUrl).hostname}] ${title}`; } catch { /* bad url */ }
  }

  const s: DetectedStream = {
    key, id: key, url, type, tabId, pageUrl, title, headers, contentType,
    firstSeen: Date.now(), lastSeen: Date.now(), hits: 1,
    titleSource: 'tab-title',
  };
  m.set(key, s);
  notify(tabId);
  onNewStream?.(s);

  // Ask the content script to extract a better title from the DOM.
  // This runs after the stream is already registered so the popup shows
  // immediately with the tab title, then updates when the DOM title arrives.
  if (pageUrl && pageUrl.startsWith('http')) {
    void enrichTitleFromDOM(tabId, s, url, pageUrl);
  }
}

/** Ask the content script to extract a title from the page DOM. */
async function enrichTitleFromDOM(
  tabId: number,
  s: DetectedStream,
  streamUrl: string,
  pageUrl: string,
): Promise<void> {
  try {
    const response = await ext.tabs.sendMessage(tabId, {
      kind: 'title:extract',
      streamUrl,
    });
    if (!response?.title) return;

    const source = (response.source as TitleSource) || 'not-found';
    if (TITLE_PRIORITY[source] <= TITLE_PRIORITY[s.titleSource || 'tab-title']) return;

    const cleaned = cleanStreamTitle(response.title);
    if (!cleaned || cleaned === 'stream') return;

    let hostname = '';
    try { hostname = new URL(pageUrl).hostname; } catch { /* bad url */ }

    const newTitle = hostname ? `[${hostname}] ${cleaned}` : cleaned;

    // Skip if the current title already contains the cleaned text.
    const currentStripped = s.title.replace(/^\[[^\]]+\]\s*/, '');
    if (currentStripped.toLowerCase() === cleaned.toLowerCase()) return;

    s.title = newTitle;
    s.titleSource = source;
    notify(tabId);
  } catch {
    // Content script not available (chrome:// pages, PDF viewer, not yet loaded, etc.)
  }
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
    if (isSnifferIdle()) return;
    if (isSegmentOrChunkUrl(d.url)) return;
    const headers = pickHeaders(d.requestHeaders);
    pending.set(d.requestId, { tabId: d.tabId, headers });
    for (const p of URL_PATTERNS) {
      if (p.re.test(d.url)) { void register(d.tabId, d.url, p.type, headers); break; }
    }
  }, filter, reqSpec);

  ext.webRequest.onHeadersReceived.addListener((d: any) => {
    if (isSnifferIdle()) return;
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
  ext.tabs.onActivated.addListener((activeInfo: any) => {
    if (activeInfo?.tabId) updateBadge(activeInfo.tabId);
  });
}
