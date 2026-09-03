/**
 * PhotoSwipe extraction.
 *
 * The single highest-value source on a gallery site, and the one a DOM walk
 * structurally cannot reach. PhotoSwipe holds its whole gallery — every
 * full-size URL, its real intrinsic dimensions, and the post it belongs to — in
 * `pswp.options.dataSource`, a JavaScript array that appears in no attribute
 * and on no element. The page markup carries thumbnails; the viewer carries the
 * originals.
 *
 * Two things have to be true before that array exists:
 *
 *   1. The gallery has to have been scrolled, or the array only holds the
 *      slides the feed has loaded so far.
 *   2. The viewer has to have been *opened once*. In PhotoSwipe v5 the global
 *      instance is constructed on first open and torn down on close, so a page
 *      that has never been clicked has no instance to read.
 *
 * Hence the flow: detect, tell the user, let them run the scroll, click one
 * item to construct the instance, read the array, close it again. The click is
 * the part that cannot be skipped, which is also why this is manual rather than
 * automatic — it moves the page under the user, and that should be their call.
 *
 * The page's globals are invisible from here (isolated world), so every read
 * goes through the MAIN-world hook in src/pagehook.
 */

import {
  type MediaCandidate, type MediaKind,
  kindFromUrl, isRejectedExtension, absolutize, makeCandidate, dedupKey,
} from '../common/harvest';
import { explainCandidate } from '../common/scoring';
import { upgradeUrl } from '../common/upgrade_rules';

const CHANNEL_REQ = 'zipper:page-probe';
const CHANNEL_RES = 'zipper:page-probe-result';
const PROBE_TIMEOUT_MS = 800;

export interface PswpSlide {
  src?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  label?: string;
}

export interface PswpStatus {
  present: boolean;
  open: boolean;
  slides: number;
  via: string;
}

let probeSeq = 0;

/**
 * Ask the page-world hook one question.
 *
 * Resolves null rather than rejecting when the hook is absent — an older
 * browser, a page where MAIN-world injection was refused, or a frame that was
 * torn down. Every caller treats "no answer" as "no PhotoSwipe", which is the
 * correct degradation: the DOM walk still runs.
 */
function hookPresent(): boolean {
  try { return !!document.documentElement?.hasAttribute('data-zipper-hook'); }
  catch { return false; }
}

function probe<T>(op: string): Promise<T | null> {
  // No hook in this frame — an older browser, or MAIN-world injection refused.
  // Answer immediately rather than burning the timeout to learn it.
  if (!hookPresent()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `p${Date.now().toString(36)}${probeSeq++}`;
    let done = false;

    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(v);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      const msg: any = e.data;
      if (!msg || msg.source !== CHANNEL_RES || msg.id !== id) return;
      finish(msg.ok ? (msg.data as T) : null);
    };

    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    try {
      window.postMessage({ source: CHANNEL_REQ, id, op }, window.location.origin || '*');
    } catch {
      finish(null);
    }
  });
}

// ---- detection --------------------------------------------------------------

/** Markers in the page itself, for the case where the script has loaded but
 *  nothing has constructed an instance yet. */
const DOM_MARKERS = [
  '.pswp', '.pswp-gallery', '[data-pswp-gallery]', '[data-pswp-src]',
  '[data-pswp-width]', 'div.photoswipe', 'a.photoswipe-item',
];

function domSaysPhotoSwipe(): string {
  for (const sel of DOM_MARKERS) {
    try { if (document.querySelector(sel)) return sel; } catch { /* bad selector */ }
  }
  // The library itself, before it has drawn anything.
  try {
    for (const s of document.querySelectorAll('script[src]')) {
      const src = (s.getAttribute('src') || '').toLowerCase();
      if (src.includes('photoswipe') || /\bpswp\b/.test(src)) return 'script';
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Is this a PhotoSwipe page?
 *
 * Merges what the DOM shows with what the page's globals say, because either
 * alone misses a real case: a gallery that has not rendered its markup yet is
 * only visible as a global, and a site that renames its bundle is only visible
 * in the DOM.
 */
export async function detectPhotoSwipe(): Promise<PswpStatus> {
  const marker = domSaysPhotoSwipe();
  const fromPage = await probe<PswpStatus>('pswp:detect');
  return {
    present: !!marker || !!fromPage?.present,
    open: !!fromPage?.open,
    slides: fromPage?.slides ?? 0,
    via: fromPage?.via || (marker ? 'dom:' + marker : ''),
  };
}

// ---- opening it -------------------------------------------------------------

/**
 * Clicks that construct a PhotoSwipe instance, most specific first.
 *
 * A wrong click costs nothing useful — it either does nothing or opens
 * something that isn't PhotoSwipe, and the check afterwards rejects it. Site
 * entries are fine here for the same reason.
 */
const OPEN_TRIGGERS = [
  '[data-pswp-src]',
  '.pswp-gallery a',
  '[data-pswp-gallery] a',
  'a.photoswipe-item',
  '.user_posts .b-photos__item',    // OnlyFans timeline
  '.b-post__media__item',           // OnlyFans post media
  'div.photoswipe img',
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Did a PhotoSwipe viewer actually appear? */
function viewerOpen(): boolean {
  try { return !!document.querySelector('.pswp--open, .pswp--visible, .pswp'); }
  catch { return false; }
}

function closeViewer(): void {
  try {
    const btn = document.querySelector('.pswp__button--close') as HTMLElement | null;
    if (btn) { btn.click(); return; }
  } catch { /* fall through to Escape */ }
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } catch { /* ignore */ }
}

/**
 * Open the viewer, read the gallery, close it again.
 *
 * The instance is constructed by the click and destroyed by the close, so the
 * read has to happen in between — and the page is left exactly as it was found,
 * which matters because this runs on a page the user is still browsing.
 */
export async function readPhotoSwipeGallery(allowOpen: boolean): Promise<PswpSlide[]> {
  // Already open — read it without touching anything. This path is safe on a
  // quick scan: it moves nothing, it just reads an array that already exists.
  let data = await probe<{ slides: PswpSlide[]; found: boolean }>('pswp:data');
  if (data?.found && data.slides.length) return data.slides;

  // Constructing the instance means clicking something, which scrolls the page
  // and covers it with a viewer. That is only ever done on an explicit deep
  // run — a quick scan must never rearrange the page underneath the user.
  if (!allowOpen) return [];

  let openedByUs = false;
  for (const sel of OPEN_TRIGGERS) {
    let el: HTMLElement | null = null;
    try { el = document.querySelector(sel) as HTMLElement | null; } catch { continue; }
    if (!el) continue;
    try {
      el.click();
      await sleep(700);
      if (!viewerOpen()) continue;
      openedByUs = true;
      data = await probe<{ slides: PswpSlide[]; found: boolean }>('pswp:data');
      if (data?.found && data.slides.length) break;
    } catch { /* try the next trigger */ }
  }

  if (openedByUs) {
    closeViewer();
    await sleep(200);
  }
  return data?.slides ?? [];
}

// ---- candidates -------------------------------------------------------------

export interface PswpHarvest {
  candidates: MediaCandidate[];
  /**
   * Thumbnail URLs the gallery itself declared as derivatives.
   *
   * Worth carrying separately rather than just scoring them low: the DOM walk
   * will have harvested exactly these off the page's own markup, and here we
   * have the gallery's word that each one is a smaller copy of a full-size URL
   * we already hold. That is a stronger statement than any heuristic, so the
   * caller drops them outright.
   */
  thumbnails: string[];
}

/**
 * Turn a read gallery into candidates.
 *
 * These arrive better-informed than anything else the page produces: a real
 * URL, real intrinsic dimensions, and the viewer's own assertion that this is
 * the item being displayed. Recorded as `carousel` origin, which already
 * outranks a DOM sighting in the merge.
 */
export function slidesToCandidates(
  slides: PswpSlide[],
  pageUrl: string,
  frameId = 0,
): PswpHarvest {
  const candidates: MediaCandidate[] = [];
  const thumbnails: string[] = [];
  const seen = new Set<string>();

  for (const s of slides) {
    if (s.thumbnail) {
      const t = absolutize(s.thumbnail, document.baseURI);
      if (/^https?:/i.test(t) && s.src) thumbnails.push(t);
    }
    if (!s.src) continue;

    const abs = absolutize(s.src, document.baseURI);
    if (!/^https?:/i.test(abs) || isRejectedExtension(abs)) continue;
    const key = dedupKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);

    const up = upgradeUrl(abs);
    // The gallery does not label kind. Fall back to image rather than 'other':
    // a PhotoSwipe slide is an image unless the URL says otherwise, and
    // 'other' would drag the base score down for no reason.
    const kind: MediaKind = kindFromUrl(up.url) ?? 'image';
    const c = makeCandidate(up.url, kind, 'carousel', pageUrl, {
      width: s.width,
      height: s.height,
      label: s.label,
      frameId,
      upgradedFrom: up.changed ? abs : undefined,
      // Every slide in one gallery is one ensemble by definition. Naming the
      // container here means the page-relative pass clusters them without
      // having to infer it from paths that may be hash-sharded.
      container: 'pswp:gallery',
    });
    const scored = explainCandidate(c, {});
    c.score = scored.score;
    c.reasons = scored.rules;
    candidates.push(c);
  }

  return { candidates, thumbnails };
}
