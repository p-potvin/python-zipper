/**
 * What has already been downloaded.
 *
 * Two jobs. First, mark it in the grid so you don't re-grab the same thing on a
 * second pass down a feed. Second, remember the *name it was saved under*, so
 * the sidebar can show the on-disk filename rather than a URL basename —
 * matching what you'd see in Explorer makes the two views comparable at a
 * glance, which is the whole point of asking for it.
 *
 * Keyed by `dedupKey` so a cache-busted re-request of the same asset still
 * reads as already-grabbed. Persisted, so it survives a browser restart.
 *
 * This is the first slice of the site-profile store: `savedAs` and `domain` are
 * exactly what the learned layer needs later, so the shape is chosen with that
 * in mind rather than as a throwaway set.
 */

import { ext } from '../common/api';
import { dedupKey } from '../common/harvest';
import { registrableDomain, hostOf } from '../common/domain';

export interface GrabRecord {
  /** Filename it was saved under — what you'd see on disk. */
  savedAs: string;
  /** Page domain it was grabbed from, for the future per-domain profile. */
  domain: string;
  at: number;
  route: 'browser' | 'server';
}

const STORE_KEY = 'zipper-grabbed';
/** Bounded: this is a convenience index, not an archive. */
const MAX_RECORDS = 5000;

const grabbed = new Map<string, GrabRecord>();
let loaded = false;

export async function loadGrabbed(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await ext.storage.local.get([STORE_KEY]);
    const raw = stored?.[STORE_KEY];
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, GrabRecord>)) {
        grabbed.set(k, v);
      }
    }
  } catch { /* storage unavailable; marks just won't persist */ }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  // Grabs arrive in bursts of a hundred; coalesce rather than writing per item.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persist();
  }, 800);
}

async function persist(): Promise<void> {
  try {
    if (grabbed.size > MAX_RECORDS) {
      const sorted = Array.from(grabbed.entries()).sort((a, b) => a[1].at - b[1].at);
      for (const [k] of sorted.slice(0, grabbed.size - MAX_RECORDS)) grabbed.delete(k);
    }
    await ext.storage.local.set({ [STORE_KEY]: Object.fromEntries(grabbed) });
  } catch { /* ignore */ }
}

export function markGrabbed(
  url: string,
  savedAs: string,
  pageUrl: string,
  route: 'browser' | 'server',
): void {
  grabbed.set(dedupKey(url), {
    savedAs,
    domain: registrableDomain(hostOf(pageUrl)),
    at: Date.now(),
    route,
  });
  scheduleSave();
}

export function markManyGrabbed(
  entries: { url: string; savedAs: string }[],
  pageUrl: string,
  route: 'browser' | 'server',
): void {
  const domain = registrableDomain(hostOf(pageUrl));
  const at = Date.now();
  for (const e of entries) {
    grabbed.set(dedupKey(e.url), { savedAs: e.savedAs, domain, at, route });
  }
  scheduleSave();
}

/** The subset of `urls` already downloaded, as url -> saved filename. */
export function lookupGrabbed(urls: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of urls) {
    const rec = grabbed.get(dedupKey(u));
    if (rec) out[u] = rec.savedAs;
  }
  return out;
}

export function grabbedCount(): number {
  return grabbed.size;
}

export async function clearGrabbed(): Promise<void> {
  grabbed.clear();
  await persist();
}
