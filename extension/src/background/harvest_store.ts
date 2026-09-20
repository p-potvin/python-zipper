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
  type MediaCandidate, dedupKey, contentKey, mergeCandidate, makeCandidate,
} from '../common/harvest';
import { SCORE } from '../common/scoring';
import { applyPageContext } from '../common/page_rank';
import { getMediaLogForPage } from './media_log';
import { getStreams } from './sniffer';
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
  /** What the top frame said about PhotoSwipe, so the sidebar can offer the
   *  deep run that is the only way to reach the gallery. */
  photoSwipe?: { present: boolean; open: boolean; slides: number; via: string };
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
  photoSwipe?: HarvestSnapshot['photoSwipe'];
}

const collectors = new Map<string, Collector>();

/** Frames that answer after this are ignored — they'd land in the next run. */
const SETTLE_MS = 900;
const HARD_TIMEOUT_MS = 6000;
/**
 * A deep run scrolls a whole feed before it reports, so it needs real room —
 * and the scroll now waits ~5s of no growth before calling the bottom the
 * bottom, so the ceiling has to clear that by a wide margin or the timeout
 * becomes the thing that ends the scan.
 */
const DEEP_TIMEOUT_MS = 240_000;

/** Called from the message router when a frame pushes its scan back. */
export function acceptFrameResult(
  runId: string,
  candidates: MediaCandidate[],
  isTop = true,
  photoSwipe?: HarvestSnapshot['photoSwipe'],
): void {
  const c = collectors.get(runId);
  if (!c) return;
  c.results.push(...candidates);
  c.frames += 1;
  if (isTop) c.topDone = true;
  // Any frame may hold the gallery — an embedded viewer is a real case — but a
  // frame that found slides outranks one that merely saw the library.
  if (photoSwipe?.present && (!c.photoSwipe?.slides || photoSwipe.slides > c.photoSwipe.slides)) {
    c.photoSwipe = photoSwipe;
  }

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

  // Held out here rather than read back from the map afterwards. `finish()`
  // deletes the entry *before* it resolves, so the old `collectors.get(runId)`
  // after the await always came back undefined — which is why every snapshot
  // has been reporting `frames: 0` regardless of how many frames answered.
  let collector: Collector | null = null;

  await new Promise<void>((resolve) => {
    collector = {
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
          ? { kind: 'harvest:deep', runId, pageUrl, scope, maxMs: 180_000, openViewer: true }
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

  const c: Collector | null = collector;
  const frames = c?.frames ?? 0;
  collectors.delete(runId);

  const network = getMediaLogForPage(tabId, pageUrl);
  const merged = mergeAll([...network, ...domFound, ...streamCandidates(tabId, pageUrl)]);

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
    photoSwipe: c?.photoSwipe,
  };
  snapshots.set(tabId, snapshot);
  return snapshot;
}

/**
 * The tab's detected livestreams, as candidates.
 *
 * A stream is one thing — a manifest — not the thousands of segments it is
 * assembled from, and the media log now drops those segments outright. But that
 * left livestreams invisible in the list entirely, which is its own problem on a
 * page whose only worthwhile media *is* the stream.
 *
 * So the manifest itself is listed, once, carrying the title and quality count
 * the sniffer worked out. Scored high and deliberately not through the normal
 * scorer: none of its signals apply to a playlist, which has no bytes, no
 * dimensions and no siblings, and would score as junk on every one of them.
 */
function streamCandidates(tabId: number, pageUrl: string): MediaCandidate[] {
  try {
    return getStreams(tabId).map((s) => {
      const c = makeCandidate(s.url, 'stream', 'network', pageUrl, {
        label: s.title || undefined,
        mime: s.contentType,
      });
      // Above INTERESTING so a stream is never buried under the page's images,
      // and never floored away for having no measurable properties.
      c.score = 900;
      c.reasons = [['stream.detected', 900]];
      // Carried so the UI can offer the recorder rather than a download.
      c.streamKey = s.key;
      c.streamType = s.type;
      return c;
    });
  } catch {
    return [];
  }
}

/**
 * Two-pass dedup, then the page-relative pass, then the floor.
 *
 * Pass one folds URL variants — cache-busted query strings, token rotation.
 * Pass two folds the same asset mirrored across CDN hosts, which pass one
 * cannot catch because the origins genuinely differ. Only candidates with a
 * known byte size take part in pass two; without it the identity is a guess.
 *
 * The order matters and is the whole point of doing it here. This is the first
 * and only moment at which a candidate is fully informed: the network log has
 * contributed bytes, the DOM has contributed dimensions and its container, and
 * every frame is present, so "the largest thing on this page" and "one of a
 * grid of twenty" are finally knowable. Judging anything before this — which is
 * what the DOM pass and the media log both used to do — meant judging it at its
 * least-informed moment and throwing the loser away permanently.
 *
 * So the floor is applied exactly once, here, at the end.
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

  applyPageContext(out);

  return out
    .filter((c) => c.score >= SCORE.FLOOR)
    .sort((a, b) => b.score - a.score);
}

/**
 * Fold candidates found by live scanning into the tab's standing snapshot.
 *
 * Runs the full merge again rather than appending, which matters more than it
 * looks: the page-relative pass has to see the new items to know whether one of
 * them is now the largest thing on the page, or whether four arrivals just
 * turned three siblings into a seven-member grid. `applyPageContext` is
 * idempotent precisely so this can re-run on every burst.
 */
export function addLiveCandidates(
  tabId: number,
  incoming: MediaCandidate[],
): HarvestSnapshot | null {
  const snap = snapshots.get(tabId);
  if (!snap || !incoming.length) return null;

  const before = new Set(snap.candidates.map((c) => c.url));
  const merged = mergeAll([...snap.candidates, ...incoming]);
  const added = merged.filter((c) => !before.has(c.url)).length;

  const next: HarvestSnapshot = {
    ...snap,
    candidates: merged,
    fromDom: snap.fromDom + incoming.length,
    finishedAt: Date.now(),
  };
  snapshots.set(tabId, next);
  // Nothing genuinely new: the mutation was a re-render of what we already had.
  // Reporting it would make the list flicker for no reason.
  return added ? next : null;
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
