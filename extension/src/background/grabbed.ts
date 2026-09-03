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
import { Api } from '../common/vwapi';

/**
 * The facts worth keeping about a grab beyond "we have it".
 *
 * Deliberately not stored locally — the local map is a fast index for the
 * already-got tick and stays lean, while these go to the API, where they are
 * the training signal for the per-domain profile and the substance of the
 * Insights tab. A grab with no facts still records; it just contributes a file
 * count rather than a byte total.
 */
export interface GrabFacts {
  kind?: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  origin?: string;
  score?: number;
  assetHost?: string;
  pageTitle?: string;
}

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
  facts: GrabFacts = {},
): void {
  markManyGrabbed([{ url, savedAs, facts }], pageUrl, route);
}

export function markManyGrabbed(
  entries: { url: string; savedAs: string; facts?: GrabFacts }[],
  pageUrl: string,
  route: 'browser' | 'server',
): void {
  const domain = registrableDomain(hostOf(pageUrl));
  const at = Date.now();
  for (const e of entries) {
    grabbed.set(dedupKey(e.url), { savedAs: e.savedAs, domain, at, route });
  }
  scheduleSave();
  queueHistory(entries, domain, pageUrl, route);
}

// ---- history ----------------------------------------------------------------

/**
 * Send what was taken to the API.
 *
 * This was the missing half. The local map above answers "have I got this?" on
 * this browser, but nothing was ever written centrally — so `zipper.history`
 * stayed empty, the Insights tab had nothing to show, and the per-domain
 * profile had no accepted/rejected signal to learn from. `Api.recordGrabs`
 * existed and simply had no caller.
 *
 * Fire-and-forget on purpose: a download that succeeded must not be reported as
 * failed because the bookkeeping call did not land. A dropped record costs a
 * row in a chart.
 */
const pending: any[] = [];
let historyTimer: ReturnType<typeof setTimeout> | null = null;

/** One request per this many records. A gallery send is a hundred at once. */
const HISTORY_CHUNK = 200;

function queueHistory(
  entries: { url: string; savedAs: string; facts?: GrabFacts }[],
  domain: string,
  pageUrl: string,
  route: 'browser' | 'server',
): void {
  for (const e of entries) {
    const f = e.facts || {};
    pending.push({
      domain,
      url: e.url,
      // The API matches "already got" on this, and it has to be the same
      // normalisation the local map uses or the two disagree about the same
      // file.
      url_key: dedupKey(e.url),
      asset_host: f.assetHost || hostOf(e.url),
      page_url: pageUrl || undefined,
      page_title: f.pageTitle,
      kind: f.kind,
      mime: f.mime,
      bytes: f.bytes,
      width: f.width,
      height: f.height,
      origin: f.origin,
      score: typeof f.score === 'number' ? Math.round(f.score) : undefined,
      saved_as: e.savedAs,
      route,
      outcome: 'ok',
      accepted: true,
    });
  }
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => { historyTimer = null; void flushHistory(); }, 1500);
}

async function flushHistory(): Promise<void> {
  while (pending.length) {
    const batch = pending.splice(0, HISTORY_CHUNK);
    try {
      const res = await Api.recordGrabs(batch);
      if (!res.ok) {
        console.warn('[Zipper] history not recorded:', res.error);
        return;   // no point draining the rest into the same failure
      }
    } catch (e) {
      console.warn('[Zipper] history not recorded:', e);
      return;
    }
  }
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
