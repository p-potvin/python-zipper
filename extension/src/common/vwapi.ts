/**
 * VaultWares API client.
 *
 * The extension talks to the API and nothing else — no localhost, no fallback
 * chain across 127.0.0.1/localhost ports, none of the mixed-content or CORS
 * workarounds that existed only because the browser was calling a local server.
 * Work is queued through here and a worker on the workstation claims it, so a
 * job survives the workstation being off.
 *
 * The API key lives in extension storage. That is a deliberate call: keys are
 * IP-gated on the API side and everything stays inside the tailnet, so the
 * exposure is meaningfully smaller than for a provider token — which is why
 * debrid credentials still stay server-side and never come near the browser.
 */

import { ext } from './api';

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

const KEY_BASE = 'vw-api-base';
const KEY_KEY = 'vw-api-key';

const DEFAULT_BASE = 'https://api.vaultwares.ca';

let cached: ApiConfig | null = null;

export async function getConfig(): Promise<ApiConfig> {
  if (cached) return cached;
  try {
    const s = await ext.storage.local.get([KEY_BASE, KEY_KEY]);
    cached = {
      baseUrl: (s?.[KEY_BASE] || DEFAULT_BASE).replace(/\/+$/, ''),
      apiKey: s?.[KEY_KEY] || '',
    };
  } catch {
    cached = { baseUrl: DEFAULT_BASE, apiKey: '' };
  }
  return cached;
}

export async function setConfig(patch: Partial<ApiConfig>): Promise<void> {
  const cur = await getConfig();
  const next: ApiConfig = {
    baseUrl: (patch.baseUrl ?? cur.baseUrl).replace(/\/+$/, ''),
    apiKey: patch.apiKey ?? cur.apiKey,
  };
  cached = next;
  try {
    await ext.storage.local.set({ [KEY_BASE]: next.baseUrl, [KEY_KEY]: next.apiKey });
  } catch { /* storage unavailable — config holds for this session */ }
}

export interface ApiResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function call<T = any>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: any,
  timeoutMs = 20000,
): Promise<ApiResult<T>> {
  const cfg = await getConfig();
  if (!cfg.apiKey) {
    return { ok: false, status: 0, error: 'No API key set — Settings → VaultWares API' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 403) {
      // Worth spelling out: the key is only honoured from a trusted IP, so this
      // is as likely to be "not on the tailnet" as "wrong key".
      return {
        ok: false, status: 403,
        error: 'Rejected (403) — check the API key, and that this machine is on the tailnet',
      };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `API returned ${res.status}` };
    }
    return { ok: true, status: res.status, data: await res.json() as T };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return {
      ok: false, status: 0,
      error: aborted ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- jobs -------------------------------------------------------------------

export interface JobSubmit {
  kind?: 'batch' | 'stream' | 'handoff';
  page_url?: string;
  page_domain?: string;
  title?: string;
  route?: string;
  links: string[];
  link_kinds?: Record<string, string>;
  headers?: Record<string, string>;
  options?: Record<string, any>;
}

/**
 * Wait for an answer-shaped job to finish.
 *
 * Polling rather than a socket: a probe is answered within a worker's poll
 * interval, so the wait is seconds, and a persistent connection for a
 * once-per-stream question is not worth the machinery. Resolves null on
 * timeout instead of throwing — a probe that never came back means "no
 * metadata", which every caller already handles.
 */
export async function awaitJobResult(
  jobId: string,
  timeoutMs = 60_000,
  everyMs = 1200,
): Promise<any | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    const res = await Api.getJob(jobId);
    const job = res.data?.job;
    if (!job) continue;
    if (job.status === 'completed') return job.result ?? null;
    if (job.status === 'failed' || job.status === 'aborted') {
      return { ok: false, error: job.error || `probe ${job.status}` };
    }
  }
  return null;
}

export interface WorkerRow {
  name: string;
  host?: string;
  platform?: string;
  dest_dir?: string;
  storage: any;
  rclone_desired?: { remotes?: string[]; enabled?: boolean } | null;
  seen_at: string;
  age_seconds: number;
  /** The worker has not reported recently. Shown, never hidden — a machine that
   *  went quiet is the one worth looking at. */
  stale: boolean;
}

export const Api = {
  health: () => call('/api/zipper/health'),

  submitJob: (job: JobSubmit) => call<{ job_id: string }>('/api/zipper/jobs', 'POST', job),
  listJobs: (limit = 50) => call<{ jobs: any[] }>(`/api/zipper/jobs?limit=${limit}`),
  getJob: (id: string) => call<{ job: any }>(`/api/zipper/jobs/${encodeURIComponent(id)}`),
  deleteJob: (id: string) => call(`/api/zipper/jobs/${encodeURIComponent(id)}`, 'DELETE'),
  /** Progress is also how a job is stopped — status is just another field. */
  updateJob: (id: string, patch: Record<string, any>) =>
    call(`/api/zipper/jobs/${encodeURIComponent(id)}/progress`, 'POST', patch),
  abortJob: (id: string) =>
    call(`/api/zipper/jobs/${encodeURIComponent(id)}/progress`, 'POST', { status: 'aborted' }),

  // ---- history / already-downloaded ----
  recordGrabs: (records: any[]) => call('/api/zipper/history', 'POST', records),
  lookupGrabs: (urlKeys: string[], domain?: string) =>
    call<{ grabbed: Record<string, string> }>(
      '/api/zipper/history/lookup', 'POST', { url_keys: urlKeys, domain },
    ),
  insights: (days = 30) => call(`/api/zipper/insights?days=${days}`),

  // ---- site profiles ----
  getProfile: (domain: string) =>
    call<{ profile: any }>(`/api/zipper/profile/${encodeURIComponent(domain)}`),
  patchProfile: (domain: string, patch: Record<string, any>) =>
    call(`/api/zipper/profile/${encodeURIComponent(domain)}`, 'PATCH', patch),
  resetProfile: (domain: string) =>
    call(`/api/zipper/profile/${encodeURIComponent(domain)}`, 'DELETE'),

  // ---- streams ----
  //
  // A probe is a job like any other, because yt-dlp has to run where the
  // captured headers and the browser's session are. The API cannot do it and
  // neither can the extension, so it goes on the queue and the answer comes
  // back on the job row.
  probeStream: (url: string, headers: Record<string, string>, proxy?: string) =>
    call<{ job_id: string }>('/api/zipper/jobs', 'POST', {
      kind: 'probe',
      links: [url],
      headers,
      options: proxy ? { proxy } : {},
    }),

  /**
   * One decoded frame of a stream.
   *
   * Queued like a probe, and for a reason that is not about convenience: a
   * cross-origin video drawn onto a canvas taints it, so the browser cannot
   * read the pixels back. The frame has to be produced where ffmpeg and the
   * captured headers are.
   */
  previewStream: (url: string, headers: Record<string, string>, proxy?: string) =>
    call<{ job_id: string }>('/api/zipper/jobs', 'POST', {
      kind: 'preview',
      links: [url],
      headers,
      options: proxy ? { proxy } : {},
    }),

  // ---- workers and storage ----
  //
  // Storage is per *worker*, not per server, because that is where files
  // actually land. Workers report inward on their own heartbeat, so this reads
  // a last-known state that exists even when the machine is off — with the age
  // of the report attached, rather than a number pretending to be current.
  storage: () => call<{ workers: WorkerRow[]; stale_after: number }>('/api/zipper/storage'),
  /** Ask a worker to change its rclone remote priority. Applied on its next
   *  heartbeat — nothing here reaches into the worker. */
  setWorkerRclone: (name: string, patch: { remotes?: string[]; enabled?: boolean }) =>
    call(`/api/zipper/workers/${encodeURIComponent(name)}/rclone`, 'PATCH', patch),

  // ---- quotas ----
  quota: () => call('/api/zipper/quota'),
  checkQuota: (provider: string, grabs = 1, bytes = 0) =>
    call<{ allowed: boolean; reason: string | null; resets?: string }>(
      '/api/zipper/quota/check', 'POST', { provider, grabs, bytes },
    ),
};
