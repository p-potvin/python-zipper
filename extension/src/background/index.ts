import { ext } from '../common/api';
import {
  installSniffer, getStreams, getStream, removeStream, clearTab, touch,
  updatePanelOpenTime, setHasActiveDownloads,
} from './sniffer';
import { enrichIfNeeded } from './enrich';
import { installMediaLog, getMediaLog, mediaLogSize, headersFor, onMediaLogged } from './media_log';
import {
  installHarvestStore, runHarvest, getSnapshot, acceptFrameResult, addLiveCandidates,
} from './harvest_store';
import { loadGrabbed, markGrabbed, markManyGrabbed, lookupGrabbed, clearGrabbed } from './grabbed';

import { zipAndDownload } from './zip_download';
import {
  Api as VwApi, awaitJobResult, getConfig as getApiConfig, setConfig as setApiConfig,
} from '../common/vwapi';
import { getProxy, setProxy, loadConfig } from './config';
import { registrableDomain, hostOf } from '../common/domain';
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

  const listed = await VwApi.listJobs(100);
  const activeJobs = (listed.data?.jobs || []).filter(
    (j: any) => j.kind === 'stream'
      && (j.status === 'running' || j.status === 'queued' || j.status === 'claimed'),
  );

  const newQualityStr = formatId || s.selectedFormat || 'best';
  const newQualityHeight = parseQualityHeight(newQualityStr);

  // Already recording this stream? Keep the better quality and stop the other.
  // The comparison is on the job's own recorded quality, which now lives in
  // options rather than a top-level column.
  for (const job of activeJobs as any[]) {
    const opts = job.options || {};
    const isSameStream = opts.stream_url === s.url || job.page_url === s.pageUrl;
    if (!isSameStream) continue;
    const existingQualityHeight = parseQualityHeight(opts.quality);
    if (newQualityHeight > existingQualityHeight) {
      console.log(`Stopping lower quality job ${job.id} (${opts.quality}) in favor of ${newQualityStr}`);
      await VwApi.abortJob(job.id);
    } else {
      return { ok: false, error: `A higher quality download (${opts.quality}) is already in progress.` };
    }
  }

  const res = await VwApi.submitJob({
    kind: 'stream',
    links: [s.url],
    headers: s.headers || {},
    page_url: s.pageUrl,
    page_domain: registrableDomain(hostOf(s.pageUrl)),
    title: title || s.title || s.meta?.title,
    options: {
      format_id: formatId || s.selectedFormat || null,
      quality: newQualityStr,
      stream_url: s.url,
      thumbnail: s.meta?.thumbnail || null,
      duration: s.meta?.duration ?? null,
      is_live: s.meta?.is_live ?? false,
      proxy: getProxy() || undefined,
      // 'auto' lands the recording locally while there is room and pipes it
      // straight to the remote when there is not — see _pick_sink in the
      // worker. Piping gives up salvage, so it is not the choice to make while
      // the disk is comfortable.
      sink: 'auto',
    },
  });
  if (res.ok && res.data?.job_id) {
    s.jobId = res.data.job_id;
    s.started = true;
    let set = tabJobMap.get(tabId);
    if (!set) { set = new Set(); tabJobMap.set(tabId, set); }
    set.add(res.data.job_id);
    touch(tabId);
    return { ok: true, jobId: res.data.job_id };
  }
  return { ok: false, error: res.error || 'could not queue the recording' };
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
      const listed = await VwApi.listJobs(100);
      const byId: Record<string, any> = {};
      for (const j of listed.data?.jobs || []) byId[j.id] = j;
      for (const jobId of jobs) {
        const job = byId[jobId];
        if (job && (job.status === 'completed' || job.status === 'aborted' || job.status === 'failed')) {
          await VwApi.deleteJob(jobId);
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
    case 'jobs:get': {
      // Jobs live in the API now. The local server is only consulted if the
      // API is unreachable, so the Downloads tab keeps working during the
      // transition instead of going blank the moment the old service stops.
      const api = await VwApi.listJobs(50);
      if (api.ok && api.data?.jobs) {
        // Normalise to the shape the UI already renders. The API returns an
        // array; the legacy server returned a map keyed by id.
        const jobs: Record<string, any> = {};
        for (const j of api.data.jobs) jobs[j.id] = j;
        return { jobs, source: 'vaultwares-api' };
      }
      // The API is the only source of job state now. It returns an array;
      // the sidebar and the legacy local server both spoke a keyed object, so
      // convert here rather than making every consumer handle both.
      const res = await VwApi.listJobs(100);
      if (!res.ok) return { error: res.error || 'API unreachable' };
      const byId: Record<string, any> = {};
      for (const j of res.data?.jobs || []) byId[j.id] = j;
      return { jobs: byId };
    }
    case 'jobs:stop': {
      const id = (msg as any).jobId as string;
      if (id?.startsWith('z-')) {
        // An API job: mark it aborted rather than killing a local process.
        const r = await VwApi.abortJob(id);
        if (r.ok) return { ok: true };
      }
      const res = await VwApi.abortJob(id);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    case 'jobs:delete': {
      const id = (msg as any).jobId as string;
      if (id?.startsWith('z-')) {
        const r = await VwApi.deleteJob(id);
        if (r.ok) return { ok: true };
      }
      const res = await VwApi.deleteJob(id);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
    // Storage lives on the server because that is where the files land and
    // where rclone runs; the sidebar only renders it.
    // A preview is a queued job whose answer is an image. Waited on here so the
    // sidebar gets one call and one result rather than owning the poll itself.
    case 'stream:preview': {
      const queued = await VwApi.previewStream(
        (msg as any).url, (msg as any).headers || {}, getProxy() || undefined,
      );
      if (!queued.ok || !queued.data?.job_id) {
        return { ok: false, error: queued.error || 'could not queue the preview' };
      }
      // Longer than a probe's window: the worker's own ffmpeg timeout is 25s,
      // and it still has to be claimed before that starts.
      const out = await awaitJobResult(queued.data.job_id, 90_000, 1500);
      if (!out) return { ok: false, error: 'no answer from a worker' };
      return out.ok
        ? { ok: true, image: out.image }
        : { ok: false, error: out.error || 'no frame' };
    }
    case 'insights:get': {
      const res = await VwApi.insights((msg as any).days || 30);
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    }
    case 'storage:get': {
      const res = await VwApi.storage();
      return res.ok
        ? { ok: true, workers: res.data?.workers || [], staleAfter: res.data?.stale_after ?? 300 }
        : { ok: false, error: res.error };
    }
    case 'rclone:config:set': {
      const res = await VwApi.setWorkerRclone((msg as any).worker, {
        remotes: (msg as any).remotes,
        enabled: (msg as any).enabled,
      });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    }
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
    // Zip on this side of the wire. The server route is still there and still
    // better for very large jobs, but an archive should not require a server to
    // be running — that was the whole reason multi-file downloads arrived as
    // eighty loose entries in the download history.
    case 'downloads:zip': {
      const zItems = (msg as any).items || [];
      const zPage = (msg as any).pageUrl || '';
      const zUrls = zItems.map((i: any) => i.url);
      const zHeaders = tabId !== undefined ? headersFor(tabId, zUrls, zPage) : {};
      const res = await zipAndDownload({
        items: zItems,
        headers: zHeaders,
        archiveName: (msg as any).archiveName,
      });
      if (res.ok) {
        // Recorded against the archive rather than each URL's own filename:
        // that is where the bytes actually are, and the grid's "got" mark
        // should point at something that exists on disk.
        const zFacts = (msg as any).facts || {};
        markManyGrabbed(
          zItems.map((i: any) => ({
            url: i.url,
            savedAs: res.filename || 'archive.zip',
            facts: zFacts[i.url],
          })),
          zPage,
          'browser',
        );
      }
      return res;
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
    // Live scanning: a user action changed the page and the content script
    // found something new. Folded into the standing snapshot and pushed to the
    // sidebar, which updates in place rather than re-sorting under the cursor.
    case 'harvest:live': {
      if (tabId === undefined) return { ok: false };
      const next = addLiveCandidates(tabId, (msg as any).candidates || []);
      if (next) {
        try { void ext.runtime.sendMessage({ kind: 'harvest:updated', snapshot: next }); }
        catch { /* sidebar closed */ }
      }
      return { ok: true, added: !!next };
    }
    case 'harvest:frame-result': {
      acceptFrameResult(
        (msg as any).runId,
        (msg as any).candidates || [],
        (msg as any).isTop !== false,
        (msg as any).photoSwipe,
      );
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
    // Asked before any scan, so the banner can offer the deep run up front —
    // the whole point being that on a PhotoSwipe page a quick scan sees
    // thumbnails and the gallery is only reachable by opening the viewer.
    case 'pswp:detect': {
      if (tabId === undefined) return { ok: false };
      try {
        const r = await ext.tabs.sendMessage(tabId, { kind: 'pswp:detect' });
        return { ok: true, status: r?.status ?? null };
      } catch {
        return { ok: false };
      }
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
        const sFacts = (msg as any).facts || {};
        markManyGrabbed(
          links.map((u) => ({ url: u, savedAs: savedNameFor(u), facts: sFacts[u] })),
          pageUrl,
          'server',
        );
        return { ok: true, jobId: api.data.job_id, via: 'api' };
      }

      // No local fallback any more. It existed while the API rollout settled,
      // and it was actively harmful once the API worked: a job that quietly
      // took the old path landed on this machine's disk, outside the queue,
      // invisible to every other client — and looked identical to success.
      return { ok: false, error: api.error || 'could not queue the job on the API' };
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
    const res = await VwApi.listJobs(100);
    const jobs = res.data?.jobs || [];

    // Track active downloads state for toolbar badge across tabs
    const activeStreamJobs = jobs.filter((j: any) => j.kind === 'stream'
      && (j.status === 'running' || j.status === 'queued' || j.status === 'claimed'));
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
// Every 2s was fine against a server on localhost. It is not fine now that
// this is a request to api.vaultwares.ca over the tailnet — that was 30 calls a
// minute, forever, from every browser running the extension, purely to keep a
// toolbar badge current. The Downloads tab still polls fast while you are
// looking at it; the badge does not need to.
setInterval(observeCompletedJobs, 20_000);


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

/**
 * Open the folder downloads land in.
 *
 * I removed this outright when the local server went away, reasoning that files
 * land on a worker that might be another machine. That was half right and
 * wholly wrong as a decision: the worker normally *is* this machine, so the
 * common case went from working to a permanent error — and the popup's Folder
 * button became a button that could only fail.
 *
 * Workers report their landing directory on every heartbeat, so ask the API and
 * try them. The native host runs here, so a path belonging to another machine
 * simply fails to resolve and we move on to the next — which is a probe for
 * "which of these is local" that costs nothing and needs no hostname matching.
 */
async function revealDefaultDownloadFolder() {
  const res = await VwApi.storage();
  const dirs = (res.data?.workers || [])
    .map((w: any) => w.dest_dir || w.storage?.disk?.path)
    .filter((d: any): d is string => !!d);

  if (!dirs.length) {
    return {
      ok: false,
      code: 'download_folder_unknown',
      error: res.ok
        ? 'No worker has reported a download folder yet'
        : `Could not ask the API where downloads land: ${res.error}`,
    };
  }

  let last: any = null;
  for (const dir of dirs) {
    last = await revealPath(dir);
    if (last?.ok) return last;
  }
  return {
    ok: false,
    code: last?.code || 'download_folder_unreachable',
    error: dirs.length === 1
      ? `${dirs[0]} could not be opened here — that worker is another machine`
      : 'None of the reported download folders exist on this machine',
  };
}

