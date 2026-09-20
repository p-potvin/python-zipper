/**
 * Network media log.
 *
 * The single highest-value addition to the harvest. The sniffer already watches
 * every request on `<all_urls>` for stream manifests; this records the *media
 * responses* alongside it. That buys three things a DOM scan cannot have:
 *
 *   - **Byte size.** Content-Length is only knowable from a response. Without
 *     this there is no honest "min size" filter, only a blank one.
 *   - **Reach.** Lazy-loaded, canvas-painted, blob-backed and cross-origin
 *     media never appear as a harvestable attribute, but they are all fetched.
 *   - **Proof.** A logged URL is one the page actually loaded, which is much
 *     stronger evidence than an attribute that may never have been used.
 *
 * Attribution is the part to be careful about. Entries key on the **top-level
 * page's** registrable domain, resolved from the tab — never from the media
 * URL's own host. Viewing example.com while images arrive from cdn.example.net
 * must produce candidates for example.com, not a junk profile for the CDN.
 */

import { ext, IS_FIREFOX } from '../common/api';
import { getStreams } from './sniffer';
import { registrableDomain, hostOf } from '../common/domain';
import {
  type MediaCandidate, kindFromMime, kindFromUrl, isRejectedExtension,
  dedupKey, makeCandidate,
} from '../common/harvest';
import { explainCandidate, SCORE } from '../common/scoring';

/** Per tab, keyed by dedupKey so token-rotated re-requests collapse. */
const log = new Map<number, Map<string, MediaCandidate>>();

/**
 * Request headers the browser actually sent, per tab and asset host.
 *
 * This is what makes a server-side re-fetch work. The server gets a bare URL
 * and no session, so a host that checks Referer or requires a login cookie
 * answers 403 — which is exactly the "access denied on the first file" failure.
 * Keyed by host rather than per candidate because Referer/Cookie/UA are
 * effectively per-origin, and hanging a header bag off every one of a thousand
 * candidates would bloat every message to the sidebar for no gain.
 */
const headerBank = new Map<number, Map<string, Record<string, string>>>();

/** Hop-by-hop and transport noise — same exclusions the stream sniffer uses. */
const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'upgrade', 'accept-encoding',
]);

function bankHeaders(tabId: number, url: string, list: any[] = []): void {
  const host = hostOf(url);
  if (!host) return;
  const out: Record<string, string> = {};
  for (const h of list) {
    const n = h?.name?.toLowerCase();
    if (n && !SKIP_HEADERS.has(n)) out[h.name] = h.value ?? '';
  }
  if (!Object.keys(out).length) return;
  let m = headerBank.get(tabId);
  if (!m) { m = new Map(); headerBank.set(tabId, m); }
  m.set(host, out);
}

/**
 * Headers to replay for a set of URLs, merged host-first.
 * `pageUrl` supplies the Referer when a host was never observed directly.
 */
export function headersFor(tabId: number, urls: string[], pageUrl: string): Record<string, string> {
  const m = headerBank.get(tabId);
  const out: Record<string, string> = {};
  if (m) {
    // Most selections are same-host; when they aren't, the first host's headers
    // are still a better starting point than none.
    for (const u of urls) {
      const h = m.get(hostOf(u));
      if (h) { Object.assign(out, h); break; }
    }
  }
  if (pageUrl && !out['Referer'] && !out['referer']) out['Referer'] = pageUrl;
  return out;
}

/**
 * Is this one chunk of a stream rather than a file?
 *
 * The single worst thing in the list on any livestream page. A playing HLS
 * stream fetches a `.ts` segment every few seconds, each one arrives as a
 * `video/mp2t` response, and the classifier — correctly, in isolation — calls
 * every one of them a video. The result is hundreds of "videos" that are two
 * seconds long, cannot be downloaded on their own, and bury everything real on
 * the page. Fetching one succeeds and produces a file that plays for a moment,
 * which is why it reads as a broken download rather than a wrong candidate.
 *
 * The sniffer has `isSegmentOrChunkUrl`, but it answers a different question —
 * "is this worth tracking as a stream?" — and rejects `.jpg`, `.png` and `.mp3`
 * outright. Reusing it here would delete every image and audio file from the
 * harvest.
 *
 * Three tests, cheapest first, and the last is the one that actually
 * generalises: a URL sitting in the same directory as a manifest we are already
 * tracking on this tab is a segment of it, whatever it happens to be called.
 */
function isStreamSegment(tabId: number, url: string, mime: string): boolean {
  const m = mime.toLowerCase();
  // MPEG-TS and CMAF/fMP4 segments have their own content types and are never
  // a standalone download.
  if (m.startsWith('video/mp2t') || m.startsWith('video/iso.segment')
      || m === 'application/vnd.apple.mpegurl') return true;

  let path = '';
  let dir = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    dir = u.origin + path.slice(0, path.lastIndexOf('/') + 1);
  } catch {
    return false;
  }

  // Extensions that only ever exist as part of a stream.
  if (/\.(ts|m4s|cmfv|cmfa)(?:$|\?)/.test(path)) return true;

  // Numbered fragments: seg-12.mp4, chunk_003.m4a, frag5.aac, init.mp4.
  if (/(^|[/_-])(seg|segment|chunk|frag|fragment|part)[_.-]?\d+\./.test(path)) return true;
  if (/(^|\/)init[_.-]?\d*\.(mp4|m4s)$/.test(path)) return true;

  // Living in a tracked manifest's directory. This is what catches the hosts
  // that number their segments in a query string, or name them nothing at all.
  try {
    for (const s of getStreams(tabId)) {
      const su = new URL(s.url);
      const sdir = su.origin + su.pathname.toLowerCase().slice(0, su.pathname.lastIndexOf('/') + 1);
      if (sdir && dir === sdir) return true;
    }
  } catch { /* no streams on this tab */ }

  return false;
}

/** Cap per tab. A media-heavy feed can fire thousands of requests. */
const MAX_PER_TAB = 3000;

/** Below this we assume UI chrome rather than content. */
const MIN_INTERESTING_BYTES = 10 * 1024;

function tabLog(tabId: number): Map<string, MediaCandidate> {
  let m = log.get(tabId);
  if (!m) { m = new Map(); log.set(tabId, m); }
  return m;
}

/**
 * Top-level page URL per tab.
 *
 * This used to be an `await ext.tabs.get()` on *every* media response — one
 * async round trip per image on a page that fires hundreds, which both slowed
 * ingest and, worse, dropped the candidate entirely whenever the lookup failed
 * or raced a navigation. Cached and updated from the navigation hook instead.
 */
const tabUrls = new Map<number, string>();

function notePageUrl(tabId: number, url: string): void {
  if (/^https?:/i.test(url)) tabUrls.set(tabId, url);
}

function resolvePageUrl(d: any): string {
  const cached = tabUrls.get(d.tabId);
  if (cached) return cached;
  // Not seen yet (extension started mid-session). documentUrl is the issuing
  // frame — for a sub-frame that isn't the profile key, but it beats dropping
  // the candidate, and the merge re-attributes against the tab anyway.
  const fallback = d.documentUrl || d.originUrl || '';
  if (/^https?:/i.test(fallback)) {
    // Refresh lazily so the next few hundred requests hit the cache.
    void ext.tabs.get(d.tabId).then(
      (t: any) => { if (t?.url) notePageUrl(d.tabId, t.url); },
    ).catch(() => { /* tab gone */ });
    return fallback;
  }
  return '';
}

function headerValue(headers: any[], name: string): string {
  const h = headers?.find((x) => x?.name?.toLowerCase() === name);
  return h?.value ?? '';
}

export function installMediaLog(): void {
  // Record what the browser sent, so a server-side re-fetch can replay it.
  ext.webRequest.onSendHeaders.addListener(
    (d: any) => {
      if (d.tabId < 0) return;
      bankHeaders(d.tabId, d.url, d.requestHeaders);
    },
    { urls: ['<all_urls>'] },
    IS_FIREFOX ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders'],
  );

  ext.webRequest.onHeadersReceived.addListener(
    (d: any) => {
      if (d.tabId < 0) return;
      void record(d);
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders'],
  );

  // Flush on every top-level navigation.
  //
  // This previously hung off tabs.onUpdated with `info.url` set — which never
  // fires on a reload, because the URL doesn't change. The result was that F5
  // kept the whole previous feed in the log and the next scan returned a mix of
  // old and new. main_frame requests fire on reloads, back/forward, and normal
  // navigation alike, so this catches all of them.
  ext.webRequest.onBeforeRequest.addListener(
    (d: any) => {
      if (d.tabId < 0 || d.type !== 'main_frame' || d.frameId !== 0) return;
      clearTab(d.tabId);
      // Seed the attribution cache from the navigation itself, so the very
      // first media response already knows which page it belongs to.
      notePageUrl(d.tabId, d.url);
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  ext.tabs.onRemoved.addListener((tabId: number) => clearTab(tabId));
}

function clearTab(tabId: number): void {
  log.delete(tabId);
  headerBank.delete(tabId);
  tabUrls.delete(tabId);
}

async function record(d: any): Promise<void> {
  const headers = d.responseHeaders || [];
  const ct = headerValue(headers, 'content-type');
  const len = parseInt(headerValue(headers, 'content-length') || '0', 10) || undefined;

  // Classify by MIME first — a URL with no extension is common on CDNs, and the
  // server's own content-type is more reliable than guessing from the path.
  let kind = kindFromMime(ct);
  if (!kind) kind = kindFromUrl(d.url);
  if (!kind || kind === 'other') return;
  if (isRejectedExtension(d.url)) return;

  // Streams are the sniffer's job; it already handles variant folding and
  // header capture. Logging them here too would double-list them.
  if (kind === 'stream') return;

  // ...and neither are the segments the stream is made of. Dropped at ingest
  // rather than scored down: a chunk is not a weak candidate, it is not a
  // candidate at all, and a thousand of them would blow the per-tab cap and
  // push out the real media before anything got the chance to rank it.
  if (isStreamSegment(d.tabId, d.url, ct)) return;

  // Skip obvious chrome so the cap isn't spent on tracking pixels. Only when we
  // actually know the size — an absent Content-Length must never mean "drop".
  if (len !== undefined && len > 0 && len < MIN_INTERESTING_BYTES) return;

  const m = tabLog(d.tabId);
  if (m.size >= MAX_PER_TAB) return;

  const pageUrl = resolvePageUrl(d);
  if (!pageUrl) return;

  const key = dedupKey(d.url);
  const existing = m.get(key);
  if (existing) {
    // Re-request of the same asset: keep the freshest URL (tokens rotate) and
    // fill in a size if we didn't have one.
    existing.url = d.url;
    if (existing.bytes === undefined && len !== undefined) existing.bytes = len;
    return;
  }

  const c = makeCandidate(d.url, kind, 'network', pageUrl, {
    bytes: len,
    mime: ct.split(';')[0].trim() || undefined,
    frameId: d.frameId,
  });
  const s = explainCandidate(c);
  c.score = s.score;
  c.reasons = s.rules;

  // Deliberately NOT filtered by score here. A network sighting has no
  // dimensions and no repeat count yet, so its score is the least informed it
  // will ever be — and dropping at ingest is permanent, because the merge can
  // only work with what was stored. A carousel image whose URL happens to
  // contain "cover" or "/users/" was being discarded outright this way. The
  // floor is applied at read time instead, where the DOM pass has contributed
  // real dimensions and the candidate can be judged properly.
  m.set(key, c);
  notifyLogged(d.tabId);
}

/**
 * Everything logged for a tab, best first.
 *
 * `includeWeak` returns entries below the score floor too — the merge wants
 * those, because a candidate the DOM also saw gains dimensions and a repeat
 * count and may well clear the floor once merged.
 */
export function getMediaLog(tabId: number, includeWeak = false): MediaCandidate[] {
  const all = Array.from(log.get(tabId)?.values() ?? []);
  const kept = includeWeak ? all : all.filter((c) => c.score >= SCORE.FLOOR);
  return kept.sort((a, b) => b.score - a.score);
}

// ---- live updates -----------------------------------------------------------

type LogListener = (tabId: number) => void;
const listeners = new Set<LogListener>();

export function onMediaLogged(fn: LogListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Coalesced: a loading feed fires these in bursts of dozens. */
const pendingNotify = new Map<number, ReturnType<typeof setTimeout>>();
function notifyLogged(tabId: number): void {
  if (pendingNotify.has(tabId)) return;
  pendingNotify.set(tabId, setTimeout(() => {
    pendingNotify.delete(tabId);
    for (const fn of listeners) { try { fn(tabId); } catch { /* ignore */ } }
  }, 600));
}

export function clearMediaLog(tabId: number): void {
  clearTab(tabId);
}

export function mediaLogSize(tabId: number): number {
  return log.get(tabId)?.size ?? 0;
}

/**
 * Candidates whose page attribution matches the tab's current domain.
 *
 * Guards a real race: a request can land after the user has navigated away, and
 * without this the new page inherits the old page's tail of in-flight media.
 */
export function getMediaLogForPage(tabId: number, pageUrl: string): MediaCandidate[] {
  const domain = registrableDomain(hostOf(pageUrl));
  if (!domain) return [];
  // includeWeak: the merge is where a weak network sighting gets its dimensions
  // and repeat count from the DOM pass, so it must see them.
  return getMediaLog(tabId, true).filter((c) => c.pageDomain === domain);
}
