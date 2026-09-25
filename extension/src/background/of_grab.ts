/**
 * The download half of the OnlyFans grabber (content/onlyfans.ts).
 *
 * Same behaviour as the userscript — one file at a time, a short pause
 * between requests, an archive every batch — with the Pornpics naming, so the
 * archives drop straight into a gallery's `.dataset` folder:
 *
 *   `<model>__________<hash8>.zip` holding `<model>_001.jpg`, `<model>_002.jpg`…
 *
 * The hash is over the files' own SHA-256 digests, so the same photos always
 * produce the same archive name, and a byte-identical file seen twice (OF
 * repeats an image across posts) is packed once.
 */

import { ext } from '../common/api';
import {
  BATCH_SIZE, archiveName, batchHash, imageExt, memberName, normalizeModelName,
} from '../common/gallery_naming';
import { createZip, type ZipEntry } from './zip';
import { fetchOne, releaseWhenDone } from './zip_download';

/** The userscript's pacing: sequential, with a breath between requests. */
const PAUSE_MS = 80;

export interface OfGrabResult {
  ok: boolean;
  error?: string;
  count?: number;
  archives?: number;
  duplicates?: number;
  failed?: number;
}

function progress(tabId: number | undefined, pct: number, label: string): void {
  if (tabId === undefined) return;
  try {
    void ext.tabs.sendMessage(tabId, { kind: 'of:progress', pct, label }, { frameId: 0 })
      .catch(() => { /* tab closed */ });
  } catch { /* ignore */ }
}

async function saveArchive(model: string, entries: ZipEntry[], digests: Uint8Array[]): Promise<void> {
  const blob = createZip(entries);
  const filename = archiveName(model, await batchHash(digests));
  const url = URL.createObjectURL(blob);
  try {
    await ext.downloads.download({ url, filename, saveAs: false });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  releaseWhenDone(url);
}

export async function grabOnlyFans(
  urls: string[], rawModel: string, tabId?: number,
): Promise<OfGrabResult> {
  const model = normalizeModelName(rawModel) || 'onlyfans';
  const list = [...new Set((urls || []).filter((u) => /^https?:/i.test(u)))];
  if (!list.length) return { ok: false, error: 'no photo URLs' };

  const totalBatches = Math.ceil(list.length / BATCH_SIZE);
  const seen = new Set<string>();
  let entries: ZipEntry[] = [];
  let digests: Uint8Array[] = [];
  let count = 0;
  let duplicates = 0;
  let failed = 0;
  let archives = 0;

  const flush = async () => {
    if (!entries.length) return;
    progress(tabId, (count / list.length) * 100, `Packing ZIP batch ${archives + 1}/${totalBatches}...`);
    await saveArchive(model, entries, digests);
    archives++;
    entries = [];
    digests = [];
  };

  for (let i = 0; i < list.length; i++) {
    progress(tabId, (i / list.length) * 100,
      `Batch ${archives + 1}/${totalBatches} — Fetching item ${i + 1}/${list.length}`);
    try {
      const data = await fetchOne(list[i], {});
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
      const key = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
      if (seen.has(key)) {
        duplicates++;
      } else {
        seen.add(key);
        count++;
        entries.push({ name: memberName(model, count, imageExt(list[i])), data });
        digests.push(digest);
      }
    } catch (e) {
      console.error('[Zipper] OF fetch failed', list[i], e);
      failed++;
    }
    if (entries.length >= BATCH_SIZE) {
      try { await flush(); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  try { await flush(); } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }

  if (!count) return { ok: false, error: 'every photo failed to download', failed };
  return { ok: true, count, archives, duplicates, failed };
}
