import type { DetectedStream, StreamVariant } from '../common/types';
import { foldVariants, touch } from './sniffer';
import { serverPost } from './server';
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
    const meta = await serverPost('/api/stream/probe', { url: s.url, headers: s.headers, proxy: getProxy() || undefined }, 50000);
    if (meta) {
      s.meta = meta;
      s.probed = true;
      if (meta.ok && meta.title) {
        const lowerTitle = (s.title || '').toLowerCase().trim();
        if (!lowerTitle || lowerTitle === 'stream' || lowerTitle === 'video' || lowerTitle === 'audio') {
          s.title = meta.title;
        }
      }
    }
  }
  touch(s.tabId);
}
