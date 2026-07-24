import { ext } from '../common/api';
import {
  installSniffer, getStreams, getStream, removeStream, clearTab, touch,
} from './sniffer';
import { enrichIfNeeded } from './enrich';
import { serverGet, serverPost } from './server';
import { getProxy, setProxy, loadConfig } from './config';
import type { BgMessage } from '../common/types';

installSniffer();
void loadConfig();
// Note: enrichment (yt-dlp probe) is triggered lazily from streams:get — i.e.
// only while the popup is open — not on every detected request.

async function startStream(tabId: number, key: string, formatId?: string, title?: string) {
  const s = getStream(tabId, key);
  if (!s) return { ok: false, error: 'stream not found' };
  const res = await serverPost('/api/stream/start', {
    url: s.url,
    headers: s.headers,
    format_id: formatId || s.selectedFormat || null,
    page_url: s.pageUrl,
    title: title || s.meta?.title || s.title,
    thumbnail: s.meta?.thumbnail || null,
    duration: s.meta?.duration ?? null,
    is_live: s.meta?.is_live ?? false,
    quality: formatId || s.selectedFormat || 'best',
    proxy: getProxy() || undefined,
  });
  if (res?.ok || res?.correlationId) {
    s.jobId = res.correlationId;
    s.started = true;
    touch(tabId);
    return { ok: true, jobId: res.correlationId };
  }
  return { ok: false, error: res?.error || 'server offline — is python-zipper running on :5171?' };
}

async function gmXhr(req: { url: string; method?: string; headers?: Record<string, string>; data?: any }) {
  try {
    const res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers || {}, body: req.data ?? null });
    return { ok: res.ok, status: res.status, responseText: await res.text() };
  } catch (e: any) {
    return { ok: false, status: 0, responseText: '', error: String(e) };
  }
}

async function handle(msg: BgMessage, sender: any) {
  const tabId = (msg as any).tabId ?? sender?.tab?.id;
  switch (msg?.kind) {
    case 'streams:get': {
      const streams = getStreams(tabId);
      for (const s of streams) enrichIfNeeded(s); // lazy probe while popup is open
      return { streams };
    }
    case 'streams:clear':     clearTab(tabId); return { ok: true };
    case 'streams:remove':    removeStream(tabId, (msg as any).key); return { ok: true };
    case 'streams:recapture': {
      clearTab(tabId);
      try { await ext.tabs.reload(tabId); } catch { /* ignore */ }
      return { ok: true };
    }
    case 'streams:start':     return await startStream(tabId, (msg as any).key, (msg as any).formatId, (msg as any).title);

    // Jobs / files — proxied to the local server from the popup.
    case 'jobs:get':          return await serverGet('/api/jobs');
    case 'jobs:stop':         return await serverPost('/api/stream/stop', { job_id: (msg as any).jobId });
    case 'jobs:delete':       return await serverPost('/api/stream/delete', { job_id: (msg as any).jobId });
    case 'open:folder':       return await serverPost('/api/open-downloaded', { folder: true, which: 'streams' });
    case 'open:path':         return await serverPost('/api/open-downloaded', { path: (msg as any).path });

    case 'config:get':        return { proxy: getProxy() };
    case 'config:set':        await setProxy((msg as any).proxy || ''); return { ok: true };

    case 'gm:xhr':            return await gmXhr((msg as any).req);
    default:                  return { ok: false, error: 'unknown message' };
  }
}

ext.runtime.onMessage.addListener((msg: BgMessage, sender: any, sendResponse: (r: any) => void) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
