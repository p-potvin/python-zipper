/**
 * Harvest orchestration and the merged candidate store.
 *
 * Three sources feed one list: the DOM pass (every frame), the network media
 * log, and — once wired — the carousel detector. The background owns the merge
 * because it is the only place that sees all frames plus the request stream.
 *
 * Frame collection uses a push model rather than `webNavigation.getAllFrames`,
 * which would mean asking for another permission at install time. The
 * background broadcasts `harvest:run` with a run id; every frame that receives
 * it scans and pushes its result back. We settle when results stop arriving.
 */

import { ext } from '../common/api';
import {
  type MediaCandidate, dedupKey, contentKey, mergeCandidate,
} from '../common/harvest';
import { getMediaLogForPage } from './media_log';
import { registrableDomain, hostOf } from '../common/domain';

export interface HarvestSnapshot {
  tabId: number;
  pageUrl: string;
  pageDomain: string;
  candidates: MediaCandidate[];
  /** How the list was produced — surfaced in the UI so a cheap scan is visible. */
  path: 'full' | 'network-only' | 'deep';
  frames: number;
  fromNetwork: number;
  fromDom: number;
  finishedAt: number;
}

const snapshots = new Map<number, HarvestSnapshot>();

// ---- frame collection -------------------------------------------------------

interface Collector {
  runId: string;
  tabId: number;
  results: MediaCandidate[];
  frames: number;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  mode: 'quick' | 'deep';
  /** Deep runs only: has the scrolling frame reported yet? */
  topDone: boolean;
}

const collectors = new Map<string, Collector>();

/** Frames that answer after this are ignored — they'd land in the next run. */
const SETTLE_MS = 900;
const HARD_TIMEOUT_MS = 6000;
/** A deep run scrolls a whole feed before it reports, so it needs real room. */
const DEEP_TIMEOUT_MS = 150_000;

/** Called from the message router when a frame pushes its scan back. */
export function acceptFrameResult(
  runId: string,
  candidates: MediaCandidate[],
  isTop = true,
): void {
  const c = collectors.get(runId);
  if (!c) return;
  c.results.push(...candidates);
  c.frames += 1;
  if (isTop) c.topDone = true;

  // On a deep run the top frame is still scrolling — for up to 90s — while
  // sub-frames answer almost immediately. Collapsing to the short settle window
  // on those early replies would end the run before the scroll ever finished,
  // which is the whole point of it. Hold the long timer until the scrolling
  // frame reports.
  if (c.mode === 'deep' && !c.topDone) return;

  // Each arrival extends the settle window a little — a slow iframe shouldn't
  // be dropped just because the top frame answered instantly.
  clearTimeout(c.timer);
  c.timer = setTimeout(() => finish(runId), SETTLE_MS);
}

function finish(runId: string): void {
  const c = collectors.get(runId);
  if (!c) return;
  collectors.delete(runId);
  clearTimeout(c.timer);
  c.resolve();
}

// ---- the run ----------------------------------------------------------------

export async function runHarvest(
  tabId: number,
  pageUrl: string,
  mode: 'quick' | 'deep' = 'quick',
  scope = '',
): Promise<HarvestSnapshot> {
  const runId = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const domFound: MediaCandidate[] = [];
  let frames = 0;

  await new Promise<void>((resolve) => {
    const collector: Collector = {
      runId, tabId, results: domFound, frames: 0, resolve, mode, topDone: false,
      timer: setTimeout(() => finish(runId), mode === 'deep' ? DEEP_TIMEOUT_MS : HARD_TIMEOUT_MS),
    };
    collectors.set(runId, collector);

    try {
      // Broadcast: delivered to every frame. Only the first sendResponse comes
      // back here, which is why frames push their results separately.
      ext.tabs.sendMessage(
        tabId,
        mode === 'deep'
          ? { kind: 'harvest:deep', runId, pageUrl, scope, maxMs: 90_000, openViewer: true }
          : { kind: 'harvest:run', runId, pageUrl, scope },
      ).catch(() => { /* no content script on this page */ });
    } catch {
      finish(runId);
    }

    // Nothing answered at all — settle early rather than burning the hard
    // timeout. Skipped for deep runs, where silence is expected while scrolling.
    if (mode !== 'deep') {
      setTimeout(() => {
        const c = collectors.get(runId);
        if (c && c.frames === 0) finish(runId);
      }, 1200);
    }
  });

  const c = collectors.get(runId);
  frames = c?.frames ?? 0;
  collectors.delete(runId);

  const network = getMediaLogForPage(tabId, pageUrl);
  const merged = mergeAll([...network, ...domFound]);

  const snapshot: HarvestSnapshot = {
    tabId,
    pageUrl,
    pageDomain: registrableDomain(hostOf(pageUrl)),
    candidates: merged,
    path: mode === 'deep' ? 'deep' : domFound.length ? 'full' : 'network-only',
    frames,
    fromNetwork: network.length,
    fromDom: domFound.length,
    finishedAt: Date.now(),
  };
  snapshots.set(tabId, snapshot);
  return snapshot;
}

/**
 * Two-pass dedup.
 *
 * Pass one folds URL variants — cache-busted query strings, token rotation.
 * Pass two folds the same asset mirrored across CDN hosts, which pass one
 * cannot catch because the origins genuinely differ. Only candidates with a
 * known byte size take part in pass two; without it the identity is a guess.
 */
function mergeAll(all: MediaCandidate[]): MediaCandidate[] {
  const byUrl = new Map<string, MediaCandidate>();
  for (const c of all) {
    const k = dedupKey(c.url);
    const prev = byUrl.get(k);
    byUrl.set(k, prev ? mergeCandidate(prev, c) : c);
  }

  const byContent = new Map<string, MediaCandidate>();
  const out: MediaCandidate[] = [];
  for (const c of byUrl.values()) {
    const ck = contentKey(c);
    if (!ck) { out.push(c); continue; }
    const prev = byContent.get(ck);
    if (prev) {
      byContent.set(ck, mergeCandidate(prev, c));
    } else {
      byContent.set(ck, c);
    }
  }
  out.push(...byContent.values());

  return out.sort((a, b) => b.score - a.score);
}

// ---- access -----------------------------------------------------------------

export function getSnapshot(tabId: number): HarvestSnapshot | undefined {
  return snapshots.get(tabId);
}

export function clearSnapshot(tabId: number): void {
  snapshots.delete(tabId);
}

export function installHarvestStore(): void {
  ext.tabs.onRemoved.addListener((tabId: number) => clearSnapshot(tabId));
  // Same reason as the media log: tabs.onUpdated with `info.url` never fires on
  // a reload, so a stale snapshot survived F5. main_frame catches reloads too.
  ext.webRequest.onBeforeRequest.addListener(
    (d: any) => {
      if (d.tabId < 0 || d.type !== 'main_frame' || d.frameId !== 0) return;
      clearSnapshot(d.tabId);
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );
}
