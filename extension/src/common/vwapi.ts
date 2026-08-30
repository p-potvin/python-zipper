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

export const Api = {
  health: () => call('/api/zipper/health'),

  submitJob: (job: JobSubmit) => call<{ job_id: string }>('/api/zipper/jobs', 'POST', job),
  listJobs: (limit = 50) => call<{ jobs: any[] }>(`/api/zipper/jobs?limit=${limit}`),
  getJob: (id: string) => call<{ job: any }>(`/api/zipper/jobs/${encodeURIComponent(id)}`),
  deleteJob: (id: string) => call(`/api/zipper/jobs/${encodeURIComponent(id)}`, 'DELETE'),

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

  // ---- quotas ----
  quota: () => call('/api/zipper/quota'),
  checkQuota: (provider: string, grabs = 1, bytes = 0) =>
    call<{ allowed: boolean; reason: string | null; resets?: string }>(
      '/api/zipper/quota/check', 'POST', { provider, grabs, bytes },
    ),
};
