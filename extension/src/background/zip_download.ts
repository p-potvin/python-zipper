/**
 * Fetch a selection, archive it, hand over one file.
 *
 * This is what makes "zip by default" true on every route rather than only the
 * one that goes through the python server. The background is the right place
 * for it: it already holds the request headers the browser really sent for each
 * host (see media_log's header bank), so a host that checks Referer or needs a
 * session cookie is fetched exactly as the page fetched it — the same reason
 * the server-side path replays them.
 *
 * Everything is held in memory, because that is what building an archive means.
 * The cap below is the honest limit of that approach, and it is enforced up
 * front rather than discovered by the tab dying halfway through.
 */

import { ext } from '../common/api';
import { createZip, uniqueNames, type ZipEntry } from './zip';

/**
 * Total bytes we are willing to hold at once.
 *
 * A background page has no special memory allowance, and an archive needs the
 * whole payload plus the assembled blob live at the same time. 1.5GB of source
 * material is a very large gallery and still leaves room; past it, the server
 * route is the honest answer and the caller says so.
 */
const MAX_TOTAL_BYTES = 1_500_000_000;

/** Concurrency. High enough to saturate a link, low enough not to look like an
 *  attack to the host we are fetching from. */
const PARALLEL = 4;

export interface ZipRequest {
  items: { url: string; filename: string }[];
  headers?: Record<string, string>;
  archiveName?: string;
}

export interface ZipResult {
  ok: boolean;
  error?: string;
  /** Files that could not be fetched, with the reason. Partial success is
   *  reported, never silently dropped. */
  failed?: { url: string; error: string }[];
  count?: number;
  bytes?: number;
  filename?: string;
}

async function fetchOne(
  url: string,
  headers: Record<string, string>,
): Promise<Uint8Array> {
  // Referer and Cookie are forbidden header names for fetch() in a background
  // context; they are applied by the browser from the request context instead.
  // Sending the rest still matters — User-Agent quirks and Origin checks are
  // common on the CDNs this touches.
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(referer|cookie|host|origin|user-agent|sec-|proxy-)/i.test(k)) continue;
    safe[k] = v;
  }

  const res = await fetch(url, { headers: safe, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Fetch everything, build the archive, start the download.
 *
 * Failures are collected rather than thrown: on a gallery of eighty, two files
 * that 403 should not cost the other seventy-eight. The caller is told what was
 * lost so it can say so.
 */
export async function zipAndDownload(req: ZipRequest): Promise<ZipResult> {
  const items = req.items || [];
  if (!items.length) return { ok: false, error: 'nothing selected' };

  const headers = req.headers || {};
  const names = uniqueNames(items.map((i) => i.filename));
  const entries: (ZipEntry | null)[] = new Array(items.length).fill(null);
  const failed: { url: string; error: string }[] = [];
  let total = 0;
  let stoppedForSize = false;

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length || stoppedForSize) return;
      try {
        const data = await fetchOne(items[i].url, headers);
        total += data.length;
        if (total > MAX_TOTAL_BYTES) { stoppedForSize = true; return; }
        // Index-keyed rather than pushed, so the archive keeps the order the
        // list was in. A gallery that comes out shuffled is hard to check.
        entries[i] = { name: names[i], data };
      } catch (e: any) {
        failed.push({ url: items[i].url, error: String(e?.message || e) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));

  if (stoppedForSize) {
    return {
      ok: false,
      error: `selection exceeds ${Math.round(MAX_TOTAL_BYTES / 1e9)}GB — send it to the server instead`,
    };
  }

  const got = entries.filter((e): e is ZipEntry => !!e);
  if (!got.length) {
    return { ok: false, error: 'every file failed to download', failed };
  }

  let blob: Blob;
  try {
    blob = createZip(got);
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), failed };
  }

  const filename = req.archiveName || defaultArchiveName();
  // A blob: URL, not a data: URL. A data URL of a 400MB archive is a ~540MB
  // base64 string that has to exist as one contiguous JS string first, which is
  // where this used to fall over on exactly the selections worth zipping.
  const url = URL.createObjectURL(blob);
  try {
    await ext.downloads.download({ url, filename, saveAs: false });
  } catch (e: any) {
    URL.revokeObjectURL(url);
    return { ok: false, error: String(e?.message || e), failed };
  }

  // The download reads from the blob asynchronously, so revoking immediately
  // races it. Released once the browser reports it settled, with a timer as the
  // backstop for the case where no event ever arrives.
  releaseWhenDone(url);

  return { ok: true, count: got.length, bytes: blob.size, filename, failed: failed.length ? failed : undefined };
}

function defaultArchiveName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `zipper-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

function releaseWhenDone(url: string): void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
    try { ext.downloads.onChanged.removeListener(onChanged); } catch { /* ignore */ }
  };
  const onChanged = (delta: any) => {
    if (delta?.state?.current === 'complete' || delta?.state?.current === 'interrupted') release();
  };
  try { ext.downloads.onChanged.addListener(onChanged); } catch { /* ignore */ }
  setTimeout(release, 120_000);
}
