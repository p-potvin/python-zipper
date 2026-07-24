import { ext } from '../common/api';

// Persisted extension config (currently just the yt-dlp proxy). Loaded once on
// startup and kept in memory so the hot paths (probe/start) read it synchronously.
let proxy = '';

export function getProxy(): string { return proxy; }

export async function loadConfig(): Promise<void> {
  try {
    const s = await ext.storage.local.get('zx-proxy');
    proxy = (s && s['zx-proxy']) || '';
  } catch { /* storage unavailable */ }
}

export async function setProxy(value: string): Promise<void> {
  proxy = (value || '').trim();
  try { await ext.storage.local.set({ 'zx-proxy': proxy }); } catch { /* ignore */ }
}
