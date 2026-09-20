import type { DetectedStream, StreamVariant } from '../common/types';
import { foldVariants, touch } from './sniffer';
import { Api, awaitJobResult } from '../common/vwapi';
import { getProxy } from './config';

// Parse an HLS master playlist into its variant streams (for dedup folding and
// a quick quality readout even when the server is offline).
function parseHlsMaster(text: string, baseUrl: string): StreamVariant[] {
  const lines = text.split(/\r?\n/);
  const out: StreamVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attr = lines[i];
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(attr);
    const bw = /BANDWIDTH=(\d+)/i.exec(attr);
    let uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    try { uri = new URL(uri, baseUrl).href; } catch { /* keep relative */ }
    const height = res ? parseInt(res[2], 10) : null;
    const bandwidth = bw ? parseInt(bw[1], 10) : null;
    out.push({
      url: uri, height, bandwidth,
      label: height ? `${height}p` : (bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : 'variant'),
    });
  }
  out.sort((a, b) => (b.height || 0) - (a.height || 0));
  return out;
}

// Probing spawns yt-dlp server-side, so guard against concurrent/rapid repeats.
// Enrichment is now triggered lazily (when the popup asks for streams), not on
// every detected request.
const inFlight = new Set<string>();
const lastAttempt = new Map<string, number>();

export function enrichIfNeeded(s: DetectedStream): void {
  if (s.probed) return;
  // Key by URL, not stream key: when a ?key=null URL upgrades to a real keyed
  // one the id changes, so the re-probe fires immediately instead of waiting.
  const id = `${s.tabId}:${s.url}`;
  if (inFlight.has(id)) return;
  if (Date.now() - (lastAttempt.get(id) || 0) < 15000) return;
  inFlight.add(id);
  lastAttempt.set(id, Date.now());
  void enrichStream(s).finally(() => inFlight.delete(id));
}

// Mutates the stored stream object in place, then re-notifies listeners.
export async function enrichStream(s: DetectedStream): Promise<void> {
  if (s.type === 'hls') {
    try {
      const res = await fetch(s.url, { headers: s.headers as any });
      if (res.ok) {
        const variants = parseHlsMaster(await res.text(), s.url);
        if (variants.length) {
          s.isMaster = true;
          s.variants = variants;
          foldVariants(s.tabId, variants.map((v) => v.url));
        }
      }
    } catch { /* CORS/network — server probe still runs */ }
  }

  if (!s.probed) {
    // Queued and waited on, rather than posted to a local server. The wait is a
    // worker poll interval, which is the price of the workstation not having to
    // listen on a port — and of a probe still being possible when the browser
    // and the machine that runs yt-dlp are not the same box.
    const queued = await Api.probeStream(s.url, s.headers || {}, getProxy() || undefined);
    const meta = queued.ok && queued.data?.job_id
      ? await awaitJobResult(queued.data.job_id, 60_000)
      : null;
    if (meta) {
      s.meta = meta;
      s.probed = true;
      if (meta.ok && meta.title) {
        // yt-dlp title (priority 4) only overrides weaker title sources.
        // 'element' (6) and 'biggest-video' (5) are kept — they're more contextual.
        const currentSrc = s.titleSource || 'tab-title';
        const PRIORITY: Record<string, number> = {
          'element': 6, 'biggest-video': 5, 'ytdlp': 4, 'meta': 3, 'page-title': 2, 'tab-title': 1, 'not-found': 0,
        };
        if (PRIORITY['ytdlp'] > PRIORITY[currentSrc]) {
          let hostname = '';
          try { hostname = new URL(s.pageUrl).hostname; } catch { /* bad url */ }
          s.title = hostname ? `[${hostname}] ${meta.title}` : meta.title;
          s.titleSource = 'ytdlp';
        }
      }
    }
  }
  touch(s.tabId);
}
