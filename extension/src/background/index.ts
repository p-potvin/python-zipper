import { ext } from '../common/api';
import {
  installSniffer, getStreams, getStream, removeStream, clearTab, touch,
  updatePanelOpenTime, setHasActiveDownloads,
} from './sniffer';
import { enrichIfNeeded } from './enrich';
import { installMediaLog, getMediaLog, mediaLogSize, headersFor, onMediaLogged } from './media_log';
import { installHarvestStore, runHarvest, getSnapshot, acceptFrameResult } from './harvest_store';
import { loadGrabbed, markGrabbed, markManyGrabbed, lookupGrabbed, clearGrabbed } from './grabbed';
import { serverGet, serverPost, SERVER_ENDPOINTS } from './server';
import { Api as VwApi, getConfig as getApiConfig, setConfig as setApiConfig } from '../common/vwapi';
import { getProxy, setProxy, loadConfig } from './config';
import type { BgMessage } from '../common/types';

installSniffer();
installMediaLog();
installHarvestStore();

// Tell any open sidebar that the passive log grew, so a page still loading
// fills the list in place instead of needing a manual re-scan. Fire-and-forget:
// nobody may be listening, and that is the normal case.
onMediaLogged((tabId: number) => {
  try {
    void ext.runtime.sendMessage({
      kind: 'media:logged', tabId, logged: mediaLogSize(tabId),
    }).catch(() => { /* no sidebar open */ });
  } catch { /* ignore */ }
});
void loadGrabbed();
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
    title: title || s.title || s.meta?.title,
    thumbnail: s.meta?.thumbnail || null,
    duration: s.meta?.duration ?? null,
    is_live: s.meta?.is_live ?? false,
    quality: formatId || s.selectedFormat || 'best',
    proxy: getProxy() || undefined,
  });
  if (res?.ok || res?.correlationId) {
    s.jobId = res.correlationId;
    s.started = true;
    let set = tabJobMap.get(tabId);
    if (!set) { set = new Set(); tabJobMap.set(tabId, set); }
    set.add(res.correlationId);
    touch(tabId);
    return { ok: true, jobId: res.correlationId };
  }
  return { ok: false, error: res?.error || 'server offline — is python-zipper running on :5171?' };
}

/** Best guess at the filename the server will write, for the already-got mark. */
function savedNameFor(url: string): string {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split('/').filter(Boolean).pop() || '') || 'file';
  } catch {
    return 'file';
  }
}

const tabJobMap = new Map<number, Set<string>>();

ext.tabs.onRemoved.addListener(async (closedTabId: number) => {
  const jobs = tabJobMap.get(closedTabId);
  if (jobs && jobs.size > 0) {
    try {
      const jobsRes = await serverGet('/api/jobs');
      const allJobs = jobsRes?.jobs || {};
      for (const jobId of jobs) {
        const job = allJobs[jobId];
        if (job && (job.status === 'completed' || job.status === 'aborted' || job.status === 'failed')) {
          await serverPost('/api/stream/delete', { job_id: jobId });
        }
      }
    } catch { /* ignore */ }
    tabJobMap.delete(closedTabId);
  }
});

async function gmXhr(req: { url: string; method?: string; headers?: Record<string, string>; data?: any; responseType?: string; timeout?: number }) {
  try {
    const controller = new AbortController();
    const timeoutMs = req.timeout && req.timeout > 0 ? req.timeout : 30000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const isGetOrHead = !req.method || req.method.toUpperCase() === 'GET' || req.method.toUpperCase() === 'HEAD';
    const bodyPayload = isGetOrHead ? undefined : (typeof req.data === 'string' ? req.data : (req.data ? JSON.stringify(req.data) : undefined));

    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: req.headers || {},
      body: bodyPayload,
      signal: controller.signal
    });
    clearTimeout(timer);

    if (req.responseType === 'arraybuffer' || req.responseType === 'blob') {
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      return { ok: res.ok, status: res.status, base64Data: base64 };
    }

    return { ok: res.ok, status: res.status, responseText: await res.text() };
  } catch (e: any) {
    return { ok: false, status: 0, responseText: '', error: String(e) };
  }
}

/**
 * Which tab a message is about.
 *
 * Content scripts arrive with `sender.tab`. The popup and the sidebar do not —
 * they are extension pages, so `sender.tab` is undefined and every tab-scoped
 * handler would silently operate on `undefined`. Falling back to the active tab
 * of the current window is what makes the same message work from all three.
 */
async function resolveTabId(msg: any, sender: any): Promise<number | undefined> {
  if (typeof msg?.tabId === 'number') return msg.tabId;
  if (typeof sender?.tab?.id === 'number') return sender.tab.id;
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0]?.id;
  } catch {
    return undefined;
  }
}

async function handle(msg: BgMessage, sender: any) {
  const tabId = await resolveTabId(msg, sender);
  switch (msg?.kind) {
    case 'streams:get': {
      updatePanelOpenTime();
      const streams = getStreams(tabId);
      for (const s of streams) enrichIfNeeded(s); // lazy probe while popup is open
      return { streams };
    }
    case 'streams:clear': clearTab(tabId); return { ok: true };
    case 'streams:remove': removeStream(tabId, (msg as any).key); return { ok: true };
    case 'streams:recapture': {
      clearTab(tabId);
      try { await ext.tabs.reload(tabId); } catch { /* ignore */ }
      return { ok: true };
    }
    case 'streams:start': return await startStream(tabId, (msg as any).key, (msg as any).formatId, (msg as any).title);

    // Jobs remain server-backed; File Explorer actions use Firefox native messaging only.
    case 'jobs:get': return await serverGet('/api/jobs');
    case 'jobs:stop': return await serverPost('/api/stream/stop', { job_id: (msg as any).jobId });
    case 'jobs:delete': return await serverPost('/api/stream/delete', { job_id: (msg as any).jobId });
    case 'open:folder': return await revealDefaultDownloadFolder();
    case 'open:path': return await revealPath((msg as any).path || '');

    case 'config:get': return { proxy: getProxy() };
    case 'config:set': await setProxy((msg as any).proxy || ''); return { ok: true };

    case 'downloads:start': {
      const dUrl = (msg as any).url;
      const dFilename = (msg as any).filename || 'file';
      const dSaveAs = (msg as any).saveAs ?? false;
      const dReferer = (msg as any).referer;
      const started = await startBrowserDownload(dUrl, dFilename, dSaveAs, dReferer);
      if (started?.ok) {
        // Record the name it was actually saved under, not the URL basename —
        // the grid shows this so it matches what's on disk.
        markGrabbed(dUrl, dFilename, dReferer || '', 'browser');
      }
      return started;
    }
    case 'downloads:list': {
      return { ok: true, downloads: await getBrowserDownloadsList() };
    }
    case 'downloads:reveal': {
      const dId = (msg as any).downloadId;
      if (dId && ext.downloads && ext.downloads.show) {
        try {
          await ext.downloads.show(dId);
          return { ok: true };
        } catch (_) { }
      }
      const path = (msg as any).path;
      if (path) return await revealPath(path);
      return { ok: false, error: 'Cannot reveal download' };
    }

    case 'gm:xhr': return await gmXhr((msg as any).req);

    // ---- harvest ----------------------------------------------------------
    // A frame pushing its DOM scan back. Fire-and-forget: the collector in
    // harvest_store owns the settle window, this just hands the results over.
    case 'harvest:frame-result': {
      acceptFrameResult((msg as any).runId, (msg as any).candidates || [], (msg as any).isTop !== false);
      return { ok: true };
    }
    case 'harvest:run': {
      if (tabId === undefined) return { ok: false, error: 'no active tab' };
      const t = await ext.tabs.get(tabId).catch(() => null);
      const pageUrl = t?.url || '';
      if (!/^https?:/i.test(pageUrl)) {
        return { ok: false, error: 'not a web page' };
      }
      const mode = (msg as any).mode === 'deep' ? 'deep' : 'quick';
      return { ok: true, snapshot: await runHarvest(tabId, pageUrl, mode, (msg as any).scope || '') };
    }
    case 'harvest:deep-abort': {
      if (tabId === undefined) return { ok: false };
      try { await ext.tabs.sendMessage(tabId, { kind: 'harvest:deep-abort' }); } catch { /* ignore */ }
      return { ok: true };
    }
    case 'harvest:get': {
      return { ok: true, snapshot: getSnapshot(tabId) ?? null, logged: mediaLogSize(tabId) };
    }
    // What the passive log already holds, with no scan at all — this is what
    // makes a revisit cheap once the profile store lands.
    case 'harvest:peek': {
      return { ok: true, logged: mediaLogSize(tabId), candidates: getMediaLog(tabId).slice(0, 200) };
    }
    // Hands a selection to the local pipeline. This still targets the existing
    // /download contract; it moves to the VaultWares API when the worker flip
    // lands, and the sidebar shouldn't need to change when it does.
    case 'harvest:send-server': {
      const links: string[] = (msg as any).links || [];
      if (!links.length) return { ok: false, error: 'nothing selected' };
      const pageUrl = (msg as any).pageUrl || '';
      // Replay the headers the browser actually sent for these hosts. Without
      // them the server fetches with no Referer and no session, and any host
      // that checks either answers 403 — which is what killed the zip on its
      // very first file.
      const stream_headers = tabId !== undefined ? headersFor(tabId, links, pageUrl) : {};
      // The server otherwise guesses image-vs-file from the path extension,
      // which is wrong on every CDN that serves images from extension-less
      // URLs — and a wrong guess means the file skips the zip batch and gets
      // fetched on its own. We already know the real kind from the response
      // Content-Type, so send it.
      const kinds = (msg as any).kinds || {};

      // Preferred path: queue on the API and let a worker claim it. Survives
      // the workstation being off, and is tracked centrally.
      const api = await VwApi.submitJob({
        kind: 'batch',
        page_url: pageUrl,
        page_domain: (msg as any).pageDomain || '',
        links,
        link_kinds: kinds,
        headers: stream_headers,
        options: { batch_size: 50, rclone_enabled: false, upscale_enabled: false },
      });
      if (api.ok && api.data?.job_id) {
        markManyGrabbed(
          links.map((u) => ({ url: u, savedAs: savedNameFor(u) })),
          pageUrl,
          'server',
        );
        return { ok: true, jobId: api.data.job_id, via: 'api' };
      }

      // Fallback to the local server while the API rollout settles. Reported
      // rather than silent — "it worked" and "it worked the old way" are
      // different facts and the difference matters when debugging.
      const res = await serverPost('/download', {
        url: pageUrl,
        links,
        batch_size: 50,
        stream_headers,
        link_kinds: kinds,
        rclone_enabled: false,
        upscale_enabled: false,
      });
      if (res?.correlationId || res?.status) {
        markManyGrabbed(
          links.map((u) => ({ url: u, savedAs: savedNameFor(u) })),
          pageUrl,
          'server',
        );
        return { ok: true, jobId: res.correlationId, via: 'local' };
      }
      return {
        ok: false,
        error: api.error
          ? `API: ${api.error}; local server also unreachable`
          : 'server offline — is python-zipper running on :5171?',
      };
    }

    case 'grabbed:lookup':
      return { ok: true, grabbed: lookupGrabbed((msg as any).urls || []) };
    case 'grabbed:clear':
      await clearGrabbed();
      return { ok: true };

    case 'api:config:get': {
      const cfg = await getApiConfig();
      // Never hand the key back to the UI in full — it only needs to know
      // whether one is set, and enough to recognise which.
      return {
        ok: true,
        baseUrl: cfg.baseUrl,
        hasKey: !!cfg.apiKey,
        keyHint: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}…` : '',
      };
    }
    case 'api:config:set': {
      await setApiConfig({
        baseUrl: (msg as any).baseUrl,
        apiKey: (msg as any).apiKey,
      });
      return { ok: true };
    }
    case 'api:health': {
      const r = await VwApi.health();
      return { ok: r.ok, error: r.error, data: r.data };
    }

    default: return { ok: false, error: 'unknown message' };
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

interface TrackedBrowserDownload {
  id: number;
  url: string;
  filename: string;
  state: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived: number;
  totalBytes: number;
  startTime: string;
  endTime?: string;
  error?: string;
}

const trackedDownloads = new Map<number, TrackedBrowserDownload>();

if (ext.downloads) {
  if (ext.downloads.onCreated) {
    ext.downloads.onCreated.addListener((item: any) => {
      if (item && item.id) {
        trackedDownloads.set(item.id, {
          id: item.id,
          url: item.url,
          filename: item.filename || 'download',
          state: item.state || 'in_progress',
          bytesReceived: item.bytesReceived || 0,
          totalBytes: item.totalBytes || 0,
          startTime: item.startTime || new Date().toISOString()
        });
      }
    });
  }

  if (ext.downloads.onChanged) {
    ext.downloads.onChanged.addListener((delta: any) => {
      if (!delta || !delta.id) return;
      const existing: TrackedBrowserDownload = trackedDownloads.get(delta.id) || {
        id: delta.id,
        url: '',
        filename: '',
        state: 'in_progress',
        bytesReceived: 0,
        totalBytes: 0,
        startTime: new Date().toISOString()
      };

      if (delta.filename?.current) existing.filename = delta.filename.current;
      if (delta.state?.current) existing.state = delta.state.current;
      if (delta.bytesReceived?.current !== undefined) existing.bytesReceived = delta.bytesReceived.current;
      if (delta.totalBytes?.current !== undefined) existing.totalBytes = delta.totalBytes.current;
      if (delta.error?.current) existing.error = delta.error.current;
      if (existing.state === 'complete') existing.endTime = new Date().toISOString();

      trackedDownloads.set(delta.id, existing);
    });
  }

  if (ext.downloads.onErased) {
    ext.downloads.onErased.addListener((id: number) => {
      trackedDownloads.delete(id);
    });
  }
}

async function getBrowserDownloadsList(): Promise<TrackedBrowserDownload[]> {
  if (ext.downloads && ext.downloads.search) {
    try {
      const items = await ext.downloads.search({
        limit: 30,
        orderBy: ['-startTime']
      });
      // Filter for python-zipper downloads or recently tracked downloads
      const list: TrackedBrowserDownload[] = items.map((item: any) => ({
        id: item.id,
        url: item.url,
        filename: item.filename || '',
        state: item.state || 'in_progress',
        bytesReceived: item.bytesReceived || 0,
        totalBytes: item.totalBytes || 0,
        startTime: item.startTime || '',
        endTime: item.endTime,
        error: item.error
      }));
      return list;
    } catch (_) { }
  }
  return Array.from(trackedDownloads.values());
}

async function startBrowserDownload(url: string, filename: string, saveAs: boolean = false, referer?: string) {
  try {
    const cleanName = filename.replace(/^[/\\]+/, '').replace(/[?:*|"<>]/g, '_');
    const options: any = {
      url: url,
      filename: `python-zipper/${cleanName}`,
      conflictAction: 'uniquify',
      saveAs: saveAs
    };
    if (referer && url.startsWith('http')) {
      options.headers = [
        { name: 'Referer', value: referer },
        { name: 'User-Agent', value: navigator.userAgent }
      ];
    }
    const downloadId = await ext.downloads.download(options);
    const newDownload: TrackedBrowserDownload = {
      id: downloadId,
      url: url,
      filename: `python-zipper/${cleanName}`,
      state: 'in_progress',
      bytesReceived: 0,
      totalBytes: 0,
      startTime: new Date().toISOString()
    };
    trackedDownloads.set(downloadId, newDownload);
    return { ok: true, downloadId };
  } catch (e: any) {
    console.error("Browser download failed:", e);
    return { ok: false, error: String(e) };
  }
}

// Background observer loop for tracking active download states
async function observeCompletedJobs() {
  try {
    const res = await serverGet('/api/jobs');
    const jobs = Object.values(res?.jobs || {});

    // Track active downloads state for toolbar badge across tabs
    const activeStreamJobs = jobs.filter((j: any) => (j.type === 'stream' || j.stream_url) && (j.status === 'running' || j.status === 'queued'));
    setHasActiveDownloads(activeStreamJobs.length);

    for (const job of jobs as any[]) {
      if (job.status === 'completed') {
        if (!downloadedJobIds.has(job.id)) {
          downloadedJobIds.add(job.id);
          await saveDownloadedJobs();
        }
      }
    }
  } catch (err) {
    // server offline
    setHasActiveDownloads(0);
  }
}

// Start polling observer
setInterval(observeCompletedJobs, 2000);


async function revealPath(path: string) {
  if (!path) return { ok: false, code: 'path_required', error: 'No path was supplied' };
  try {
    const response = await (ext as any).runtime.sendNativeMessage(
      "com.pythonzipper.flmgr",
      { action: 'reveal', path }
    );
    if (response?.ok === true && response?.status === 'revealed') {
      return response;
    }
    return { ok: false, code: response?.code || 'native_host_error',
      error: response?.error || 'The native host did not confirm the Explorer reveal' };
  } catch (err: any) {
    return { ok: false, code: 'native_host_unavailable',
      error: String(err?.message || err || 'Firefox could not reach the native host') };
  }
}

async function revealDefaultDownloadFolder() {
  const jobData = await serverGet('/api/jobs');
  // Prioritize download_dir (.downloaded) where batch zips land, then streams_dir
  const path = jobData?.download_dir || jobData?.streams_dir;
  if (!path) {
    return { ok: false, code: 'download_folder_unknown', error: 'The download folder is unavailable' };
  }
  return await revealPath(path);
}

