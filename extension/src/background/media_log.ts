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
import { registrableDomain, hostOf } from '../common/domain';
import {
  type MediaCandidate, kindFromMime, kindFromUrl, isRejectedExtension,
  dedupKey, makeCandidate,
} from '../common/harvest';
import { scoreCandidate, SCORE } from '../common/scoring';

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
  c.score = scoreCandidate(c);

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
