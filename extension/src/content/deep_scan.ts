/**
 * Smart scroll ("Scroll" in the UI), then open the viewer.
 *
 * Manually triggered, never automatic. A lazy feed only puts media in the DOM
 * (and on the wire) once it scrolls into view, so a plain scan of an unscrolled
 * timeline sees the first screenful and nothing else. This drives the page to
 * the bottom, waits for it to settle, and optionally opens the site's own
 * lightbox so the carousel detector can read the viewer's internal slide list.
 *
 * Three things the old panel version got wrong:
 *
 *   1. **No time cap.** It stopped on "at bottom and quiet for 1.5s", which on
 *      an infinite feed is never — it would scroll until the tab died.
 *   2. **No growth check.** Mutation activity isn't the same as new content; a
 *      feed with a spinner or a live counter mutates forever without growing.
 *   3. **It left you at the bottom.** The viewport was yanked and never
 *      restored, so finishing a scan lost your place on the page.
 *
 * Scrolling steps by roughly a viewport at a time rather than jumping to the
 * bottom. That is partly cosmetic, but mostly correctness: most lazy loaders
 * hang off IntersectionObserver, and a jump never intersects the content it
 * skips over — so the middle of a long feed would silently never load.
 */

export interface DeepScanOptions {
  /** Hard ceiling. Reached = stop and report, not an error. */
  maxMs?: number;
  /** Stop early once this many items are on the page. 0 = no limit. */
  maxHeightPx?: number;
  /** Try to open the site's lightbox at the end. */
  openViewer?: boolean;
}

export interface DeepScanProgress {
  phase: 'scrolling' | 'settling' | 'viewer' | 'done' | 'aborted';
  passes: number;
  height: number;
  elapsedMs: number;
}

const DEFAULTS = { maxMs: 180_000, maxHeightPx: 0, openViewer: true };

/**
 * How long the bottom of the page has to stay quiet before we believe it.
 *
 * Six checks half a second apart, so roughly five seconds of no growth after
 * the last scroll step. The previous three-at-500ms gave up after about a
 * second and a half, which is inside the normal round trip of a feed that
 * fetches its next page on reaching the bottom — so a slow site looked
 * identical to a finished one, and the scan stopped one page short of the end
 * without ever saying so. Waiting longer costs seconds on an already-slow
 * operation; stopping early costs content, silently.
 */
const STABLE_CHECKS = 6;
const SETTLE_MS = 800;

/** Neither the page nor the scroll position moving means something is holding
 *  us — a scroll lock, a modal. Worth a few more tries than the old 4 before
 *  concluding that, for the same reason. */
const STUCK_CHECKS = 6;

let aborted = false;
export function abortDeepScan(): void { aborted = true; }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function atBottom(): boolean {
  return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 80;
}

function pageHeight(): number {
  return Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  );
}

/**
 * Thumbnails worth clicking to open a viewer, most specific first.
 * Site-specific entries are fine here — a wrong click just does nothing useful,
 * and the generic fallbacks cover everything else.
 */
const VIEWER_TRIGGERS = [
  '.user_posts .b-photos__item',        // OnlyFans timeline
  '.b-post__media__item',               // OnlyFans post media
  '[data-pswp-src]',                    // PhotoSwipe, declarative
  '.pswp-gallery a',
  'a[data-fancybox]',                   // Fancybox
  '.swiper-slide img',                  // Swiper
  '[data-lightbox]',
  'figure a > img',
  '.gallery a > img',
];

const VIEWER_CLOSERS = [
  '.pswp__button--close',
  '.fancybox__button--close',
  '[data-fancybox-close]',
  '.lightbox-close',
  '[aria-label="Close"]',
];

/** Did a lightbox actually appear? */
function viewerIsOpen(): boolean {
  return !!document.querySelector(
    '.pswp--open, .pswp--visible, .fancybox__container, .lightbox.open, [role="dialog"] img',
  );
}

/**
 * Scroll until the page stops growing, then optionally open the viewer.
 * Restores the original scroll position before returning.
 */
export async function deepScan(
  onProgress: (p: DeepScanProgress) => void,
  options: DeepScanOptions = {},
): Promise<DeepScanProgress> {
  const opts = { ...DEFAULTS, ...options };
  aborted = false;

  const started = Date.now();
  const originalY = window.scrollY;
  let passes = 0;
  let stableChecks = 0;   // consecutive no-growth checks while at the bottom
  let stuckChecks = 0;    // consecutive passes where neither page nor scroll moved
  let lastHeight = pageHeight();
  let lastY = window.scrollY;

  const report = (phase: DeepScanProgress['phase']): DeepScanProgress => {
    const p: DeepScanProgress = {
      phase, passes, height: pageHeight(), elapsedMs: Date.now() - started,
    };
    try { onProgress(p); } catch { /* reporting must never break the scan */ }
    return p;
  };

  report('scrolling');

  while (!aborted) {
    if (Date.now() - started > opts.maxMs) break;
    if (opts.maxHeightPx && pageHeight() >= opts.maxHeightPx) break;

    // Step by roughly a viewport at a time, smoothly, rather than teleporting
    // to the bottom. Two reasons: it's far less jarring to watch, and most lazy
    // loaders hang off IntersectionObserver — a jump to the bottom never
    // intersects the content in between, so the middle of a feed silently never
    // loads. Stepping guarantees everything passes through the viewport.
    const step = Math.max(400, Math.round(window.innerHeight * 0.85));
    window.scrollBy({ top: step, behavior: 'smooth' });
    passes++;
    await sleep(450);

    const h = pageHeight();
    const y = window.scrollY;
    const grew = h > lastHeight + 40;
    const moved = y > lastY + 40;

    if (grew) lastHeight = h;
    if (moved) lastY = y;

    if (!atBottom()) {
      // Still descending. Height not growing is expected here — the page may
      // simply already be tall. What matters is that we're still making
      // progress; if neither the page nor the scroll position moves, something
      // is holding us (a scroll lock, a modal) and there's no point continuing.
      if (grew || moved) {
        stuckChecks = 0;
        report('scrolling');
        continue;
      }
      stuckChecks++;
      if (stuckChecks >= STUCK_CHECKS) break;
      report('settling');
      await sleep(SETTLE_MS);
      continue;
    }

    // At the bottom. Now growth is the only thing worth waiting for — give lazy
    // loaders a few beats, since a slow request can land after the scroll stops.
    if (grew) {
      stableChecks = 0;
      report('scrolling');
      continue;
    }
    stableChecks++;
    report('settling');
    if (stableChecks >= STABLE_CHECKS) break;
    await sleep(SETTLE_MS);
  }

  if (aborted) {
    window.scrollTo({ top: originalY, behavior: 'smooth' });
    return report('aborted');
  }

  // --- open the viewer so the carousel detector can read its slide list ----
  let opened = false;
  if (opts.openViewer && !viewerIsOpen()) {
    report('viewer');
    for (const sel of VIEWER_TRIGGERS) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      try {
        el.click();
        await sleep(900);
        if (viewerIsOpen()) { opened = true; break; }
      } catch { /* try the next trigger */ }
    }
  } else if (viewerIsOpen()) {
    opened = true;
  }

  // The caller harvests while this is still open; closing happens after.
  if (opened) await sleep(400);

  window.scrollTo({ top: originalY, behavior: 'smooth' });
  return report('done');
}

/** Close whatever viewer we opened, so the page is left as we found it. */
export function closeViewer(): void {
  for (const sel of VIEWER_CLOSERS) {
    const btn = document.querySelector(sel) as HTMLElement | null;
    if (btn) { try { btn.click(); return; } catch { /* ignore */ } }
  }
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } catch { /* ignore */ }
}
