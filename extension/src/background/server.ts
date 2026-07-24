// All calls to the local python-zipper server go through the background service
// worker (exempt from page mixed-content blocking) with a generous timeout —
// yt-dlp probe/start can take several seconds.
export const SERVER_ENDPOINTS = ['http://127.0.0.1:5171', 'http://localhost:5171'];

export async function serverGet(path: string, timeoutMs = 8000): Promise<any | null> {
  for (const base of SERVER_ENDPOINTS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) { try { return await res.json(); } catch { return null; } }
    } catch {
      clearTimeout(t);
    }
  }
  return null;
}

export async function serverPost(path: string, body: any, timeoutMs = 60000): Promise<any | null> {
  for (const base of SERVER_ENDPOINTS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        try { return await res.json(); } catch { return { ok: true }; }
      }
    } catch {
      clearTimeout(t);
    }
  }
  return null;
}
