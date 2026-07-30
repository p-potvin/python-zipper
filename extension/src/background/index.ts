import { ext } from '../common/api';
import {
  installSniffer, getStreams, getStream, removeStream, clearTab, touch,
  updatePanelOpenTime, setHasActiveDownloads,
} from './sniffer';
import { enrichIfNeeded } from './enrich';
import { serverGet, serverPost, SERVER_ENDPOINTS } from './server';
import { getProxy, setProxy, loadConfig } from './config';
import type { BgMessage } from '../common/types';

installSniffer();
void loadConfig();
// Note: enrichment (yt-dlp probe) is triggered lazily from streams:get — i.e.
// only while the popup is open — not on every detected request.

function parseQualityHeight(q: string | null | undefined): number {
  if (!q) return 0;
  if (q === 'best') return 99999;
  const m = /(\d+)p/.exec(q);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(q, 10);
  return isNaN(n) ? 0 : n;
}

async function startStream(tabId: number, key: string, formatId?: string, title?: string) {
  const s = getStream(tabId, key);
  if (!s) return { ok: false, error: 'stream not found' };

  // Fetch active jobs
  const jobsRes = await serverGet('/api/jobs');
  const activeJobs = Object.values(jobsRes?.jobs || {}).filter(
    (j: any) => j.type === 'stream' && (j.status === 'running' || j.status === 'queued')
  );

  const newQualityStr = formatId || s.selectedFormat || 'best';
  const newQualityHeight = parseQualityHeight(newQualityStr);

  // Check if there is already an active job for the same stream URL, or same pageURL
  for (const job of activeJobs as any[]) {
    const isSameStream = job.stream_url === s.url || job.page_url === s.pageUrl;
    if (isSameStream) {
      const existingQualityHeight = parseQualityHeight(job.quality);
      if (newQualityHeight > existingQualityHeight) {
        // Stop the existing lower quality job
        console.log(`Stopping lower quality job ${job.id} (${job.quality}) in favor of ${newQualityStr}`);
        await serverPost('/api/stream/stop', { job_id: job.id });
      } else {
        // Prevent starting this lower quality download
        return { ok: false, error: `A higher quality download (${job.quality}) is already in progress.` };
      }
    }
  }

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
      updatePanelOpenTime();
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
    case 'open:path':      {
        console.log(msg);
        return await openFolderWithFallback((msg as any).path);
      }

    case 'config:get':        return { proxy: getProxy() };
    case 'config:set':        await setProxy((msg as any).proxy || ''); return { ok: true };

    case 'downloads:start': {
        const dUrl = (msg as any).url;
        const dFilename = (msg as any).filename || 'file';
        return await startBrowserDownload(dUrl, dFilename);
    }

    case 'gm:xhr':            return await gmXhr((msg as any).req);
    default:                  return { ok: false, error: 'unknown message' };
  }
}

ext.runtime.onMessage.addListener((msg: BgMessage, sender: any, sendResponse: (r: any) => void) => {
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});


const downloadedJobIds = new Set<string>();

// Load from storage on startup
try {
  ext.storage.local.get(['downloadedJobIds'], (res: any) => {
    if (Array.isArray(res?.downloadedJobIds)) {
      res.downloadedJobIds.forEach((id: string) => downloadedJobIds.add(id));
    }
  });
} catch (e) {
  console.warn("Could not read downloadedJobIds from storage", e);
}

async function saveDownloadedJobs() {
  try {
    await ext.storage.local.set({ downloadedJobIds: Array.from(downloadedJobIds) });
  } catch (e) {
    console.warn("Could not save downloadedJobIds to storage", e);
  }
}

async function startBrowserDownload(url: string, filename: string) {
  try {
    const cleanName = filename.replace(/^[/\\]+/, '').replace(/[?:*|"<>]/g, '_');
    const downloadId = await ext.downloads.download({
      url: url,
      filename: `python-zipper/${cleanName}`,
      conflictAction: 'uniquify',
      saveAs: false
    });
    return { ok: true, downloadId };
  } catch (e: any) {
    console.error("Browser download failed:", e);
    return { ok: false, error: String(e) };
  }
}

// Background observer loop for completed jobs (streams and media/scrape jobs)
async function observeCompletedJobs() {
  try {
    const res = await serverGet('/api/jobs');
    const jobs = Object.values(res?.jobs || {});
    
    // Track active downloads state in the sniffer
    const activeStreamJobs = jobs.filter((j: any) => j.type === 'stream' && (j.status === 'running' || j.status === 'queued'));
    setHasActiveDownloads(activeStreamJobs.length > 0);

    for (const job of jobs as any[]) {
      if (job.status === 'completed') {
        if (job.type === 'stream' && job.save_path) {
          // Stream job
          if (!downloadedJobIds.has(job.id)) {
            downloadedJobIds.add(job.id);
            await saveDownloadedJobs();
            
            let filename = job.save_path.replace(/\\/g, '/').split('/').pop() || `${job.id}.mp4`;
            // Strip pzstream_<id>_ prefix
            const prefixMatch = /^pzstream_[a-zA-Z0-9-]+_(.*)$/.exec(filename);
            if (prefixMatch) {
              filename = prefixMatch[1];
            }
            // Strip [id] brackets
            filename = filename.replace(/\s*\[[a-zA-Z0-9_-]+\](?=\.[^.]+$)/, '');

            const activeBase = SERVER_ENDPOINTS[0] || 'http://127.0.0.1:5171';
            const downloadUrl = `${activeBase}/api/download-file?path=${encodeURIComponent(job.save_path)}`;
            console.log(`Triggering browser download for completed stream job ${job.id}: ${downloadUrl}`);
            await startBrowserDownload(downloadUrl, filename);
          }
        } else if (Array.isArray(job.archives) && job.archives.length > 0) {
          // Media / Scrape / Batch job
          if (!downloadedJobIds.has(job.id)) {
            downloadedJobIds.add(job.id);
            await saveDownloadedJobs();
            
            const activeBase = SERVER_ENDPOINTS[0] || 'http://127.0.0.1:5171';
            for (const archiveFilename of job.archives) {
              const downloadUrl = `${activeBase}/api/download-file?path=${encodeURIComponent(archiveFilename)}`;
              console.log(`Triggering browser download for completed batch archive ${archiveFilename}: ${downloadUrl}`);
              await startBrowserDownload(downloadUrl, archiveFilename);
            }
          }
        }
      }
    }
  } catch (err) {
    // server offline
  }
}

// Start polling observer
setInterval(observeCompletedJobs, 2000);


async function openFolderWithFallback(folderPath: string) {
  console.log("[Background] openFolderWithFallback target path:", folderPath);
  // Attempt 1: Firefox Native Messaging
  try {
    console.log("[Background] Trying Native Messaging to com.pythonzipper.flmgr...");
    const response = await (ext as any).runtime.sendNativeMessage(
      "com.pythonzipper.flmgr",
      { folderPath }
    );
    console.log("[Background] Explorer opened via Native Host, response:", response);
    return { ok: true, method: 'native', response };
  } catch (err: any) {
    console.warn("[Background] Native Messaging failed:", err.message || err);
  }

  // Attempt 2: Local Python Server Fallback
  try {
    console.log("[Background] Falling back to Local Python Server API /api/open-downloaded...");
    const res = await serverPost('/api/open-downloaded', { path: folderPath });
    console.log("[Background] Local Python Server response:", res);
    if (!res?.ok && res?.status !== 'opened file' && res?.status !== 'opened folder') {
      throw new Error(`Server response not ok: ${JSON.stringify(res)}`);
    }
    return { ok: true, method: 'server', response: res };
  } catch (err: any) {
    console.error("[Background] Both opening methods failed:", err);
    return { ok: false, error: String(err.message || err) };
  }
}