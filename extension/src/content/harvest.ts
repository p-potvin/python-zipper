/**
 * DOM harvest pass.
 *
 * Runs in every frame (`all_frames: true`). Each frame reports its own
 * candidates; the background merges them with the network log and dedups.
 *
 * Three things the old scanner got wrong, fixed here:
 *   1. It queried `div, span` across the whole document synchronously, which
 *      janks visibly on a long feed. This walks in idle-time batches.
 *   2. It never read `srcset`, so on responsive sites it harvested whatever the
 *      layout picked — usually the small one.
 *   3. It scored inline and then discarded everything except a boolean.
 */

import {
  type MediaCandidate, type MediaKind,
  kindFromUrl, isRejectedExtension, largestFromSrcset, urlsFromCssValue,
  absolutize, makeCandidate,
} from '../common/harvest';
import { scoreCandidate, SCORE, type ElementHints } from '../common/scoring';
import { upgradeUrl } from '../common/upgrade_rules';
import { extractCarouselMediaUrls } from './carousel';

/** Attributes lazy-loaders stash real URLs in before swapping them into src. */
const LAZY_ATTRS = [
  'data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-url',
  'data-image', 'data-bg', 'data-background', 'data-full', 'data-large',
  'data-hi-res', 'data-highres', 'data-zoom', 'data-zoom-image', 'data-poster',
];
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

/** Elements worth looking at directly. Broad `div, span` sweeps are handled
 *  separately and only for computed backgrounds, which is far cheaper. */
const DIRECT_SELECTOR = [
  'img', 'video', 'audio', 'source', 'picture', 'embed', 'object',
  'a[href]', 'link[rel~="preload"][as="image"]',
  ...LAZY_ATTRS.map((a) => `[${a}]`),
].join(',');

const BATCH_SIZE = 250;

// ---- element readers --------------------------------------------------------

function ancestryText(el: Element, depth = 5): string {
  let out = '';
  let p: Element | null = el.parentElement;
  for (let i = 0; i < depth && p; i++) {
    out += ' ' + (p.className || '') + ' ' + (p.id || '');
    p = p.parentElement;
  }
  return out.toLowerCase();
}

function isVisible(el: Element): boolean {
  try {
    const s = getComputedStyle(el as HTMLElement);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  } catch {
    return true;
  }
}

/** Everything a single element offers, with the best variant preferred. */
function readElement(el: Element, pageUrl: string): { url: string; width?: number; height?: number; kind?: MediaKind; label?: string }[] {
  const out: { url: string; width?: number; height?: number; kind?: MediaKind; label?: string }[] = [];
  const tag = el.tagName.toLowerCase();
  const base = (el.ownerDocument?.baseURI) || pageUrl;

  const push = (u: string | null | undefined, extra: any = {}) => {
    if (!u) return;
    const abs = absolutize(u, base);
    if (!/^https?:/i.test(abs)) return;
    out.push({ url: abs, ...extra });
  };

  // srcset first — it carries the largest variant the page knows about.
  const srcset = el.getAttribute('srcset');
  if (srcset) {
    const best = largestFromSrcset(srcset, base);
    if (best) push(best.url, { width: best.width });
  }
  for (const a of LAZY_SRCSET_ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const best = largestFromSrcset(v, base);
      if (best) push(best.url, { width: best.width });
    }
  }

  if (tag === 'img') {
    const img = el as HTMLImageElement;
    push(img.currentSrc || img.src, {
      width: img.naturalWidth || undefined,
      height: img.naturalHeight || undefined,
      kind: 'image' as MediaKind,
      label: img.alt || img.title || undefined,
    });
  } else if (tag === 'video') {
    const v = el as HTMLVideoElement;
    push(v.currentSrc || v.src, {
      width: v.videoWidth || undefined,
      height: v.videoHeight || undefined,
      kind: 'video' as MediaKind,
      label: v.title || undefined,
    });
    push(v.poster, { kind: 'image' as MediaKind });
  } else if (tag === 'audio') {
    const a = el as HTMLAudioElement;
    push(a.currentSrc || a.src, { kind: 'audio' as MediaKind, label: a.title || undefined });
  } else if (tag === 'source') {
    push(el.getAttribute('src'), { mime: el.getAttribute('type') || undefined });
  } else if (tag === 'a') {
    // Only links that point at media. A same-page link is navigation, not content.
    const href = el.getAttribute('href');
    if (href && kindFromUrl(absolutize(href, base))) {
      push(href, { label: (el.textContent || '').trim().slice(0, 120) || undefined });
    }
  } else if (tag === 'embed' || tag === 'object') {
    push(el.getAttribute('src') || el.getAttribute('data'));
  } else if (tag === 'link') {
    push(el.getAttribute('href'), { kind: 'image' as MediaKind });
  }

  for (const a of LAZY_ATTRS) {
    const v = el.getAttribute(a);
    if (v && !v.startsWith('data:')) push(v);
  }

  return out;
}

// ---- the pass ---------------------------------------------------------------

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as any).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });
}

export interface HarvestResult {
  candidates: MediaCandidate[];
  frameId: number;
  pageUrl: string;
  scanned: number;
  truncated: boolean;
}

/**
 * Walk the document and emit candidates. Yields to the event loop between
 * batches so a long feed doesn't lock the page.
 */
export async function harvestDom(
  pageUrl: string,
  frameId = 0,
  scopeSelector = '',
): Promise<HarvestResult> {
  // A picked container narrows every pass. An invalid or unmatched selector
  // falls back to the whole document rather than silently returning nothing.
  let root: ParentNode = document;
  if (scopeSelector) {
    try {
      const el = document.querySelector(scopeSelector);
      if (el) root = el;
    } catch { /* invalid selector — scan everything */ }
  }
  const found = new Map<string, MediaCandidate>();
  /** url -> how many distinct elements produced it. Feeds the repeat penalty. */
  const hits = new Map<string, number>();
  let scanned = 0;
  let truncated = false;

  const add = (
    url: string,
    kind: MediaKind,
    origin: 'dom' | 'meta',
    extra: Partial<MediaCandidate>,
    hints: ElementHints,
  ) => {
    if (isRejectedExtension(url)) return;
    const up = upgradeUrl(url);
    const c = makeCandidate(up.url, kind, origin, pageUrl, {
      ...extra,
      upgradedFrom: up.changed ? url : undefined,
    });
    // Count first: the same URL arriving from many elements is the repeat
    // signal, and it has to be tallied before the score means anything.
    const n = (hits.get(c.url) ?? 0) + 1;
    hits.set(c.url, n);
    c.domHits = n;
    c.score = scoreCandidate(c, hints);
    const prev = found.get(c.url);
    if (!prev || c.score > prev.score) found.set(c.url, c);
  };

  // --- pass 1: elements that directly declare media ------------------------
  const direct = Array.from(root.querySelectorAll(DIRECT_SELECTOR));
  for (let i = 0; i < direct.length; i += BATCH_SIZE) {
    const batch = direct.slice(i, i + BATCH_SIZE);
    for (const el of batch) {
      if (isOwnUi(el)) continue;
      scanned++;
      const hints: ElementHints = {
        ancestry: ancestryText(el),
        visible: isVisible(el),
        rendered: el.tagName === 'IMG' || el.tagName === 'VIDEO',
      };
      for (const hit of readElement(el, pageUrl)) {
        const kind = hit.kind ?? kindFromUrl(hit.url);
        if (!kind) continue;
        add(hit.url, kind, 'dom', {
          width: hit.width, height: hit.height, label: hit.label, frameId,
        }, hints);
      }
    }
    await idle();
  }

  // --- pass 2: CSS backgrounds --------------------------------------------
  // Restricted to elements that actually declare a background in their inline
  // style or a background-ish data attribute. Calling getComputedStyle on every
  // div on the page is what made the old scan expensive.
  const bgEls = Array.from(root.querySelectorAll('[style*="background"],[data-bg],[data-background]'));
  for (let i = 0; i < bgEls.length; i += BATCH_SIZE) {
    for (const el of bgEls.slice(i, i + BATCH_SIZE)) {
      if (isOwnUi(el)) continue;
      scanned++;
      let value = '';
      try {
        const s = getComputedStyle(el as HTMLElement);
        value = `${s.backgroundImage} ${(s as any).content || ''}`;
      } catch { /* detached node */ }
      const hints: ElementHints = { ancestry: ancestryText(el), visible: isVisible(el) };
      for (const u of urlsFromCssValue(value, document.baseURI)) {
        const kind = kindFromUrl(u) ?? 'image';
        add(u, kind, 'dom', { frameId }, hints);
      }
    }
    await idle();
  }

  // --- pass 3: carousels and lightboxes ------------------------------------
  // Runs before the metadata pass because these are the highest-value hits on a
  // gallery: full-size URLs that live in a viewer's internal state and appear
  // in no attribute the DOM walk above can reach.
  try {
    for (const url of extractCarouselMediaUrls(root)) {
      if (isRejectedExtension(url)) continue;
      const kind = kindFromUrl(url) ?? 'image';
      const up = upgradeUrl(url);
      const c = makeCandidate(up.url, kind, 'carousel', pageUrl, {
        frameId,
        upgradedFrom: up.changed ? url : undefined,
      });
      const n = (hits.get(c.url) ?? 0) + 1;
      hits.set(c.url, n);
      c.domHits = n;
      c.score = scoreCandidate(c, {});
      const prev = found.get(c.url);
      // A carousel sighting outranks a DOM one for the same URL — it came from
      // the viewer's own list, so it is the variant the site intends to show.
      if (!prev || c.score > prev.score || prev.origin === 'dom') found.set(c.url, c);
    }
  } catch (e) {
    console.warn('[Zipper] carousel scan failed', e);
  }

  await idle();

  // --- pass 4: declared metadata ------------------------------------------
  for (const c of metaCandidates(pageUrl, frameId)) {
    if (isRejectedExtension(c.url)) continue;
    c.score = scoreCandidate(c, {});
    if (c.score < SCORE.FLOOR) continue;
    const prev = found.get(c.url);
    if (!prev || c.score > prev.score) found.set(c.url, c);
  }

  // Rescore with the final repeat counts — an element seen early had a hit
  // count of 1 at the time, which understates a URL that turned up 30 times.
  const finished: MediaCandidate[] = [];
  for (const c of found.values()) {
    c.domHits = hits.get(c.url) ?? 1;
    c.score = scoreCandidate(c, {});
    if (c.score >= SCORE.FLOOR) finished.push(c);
  }

  return {
    candidates: finished.sort((a, b) => b.score - a.score),
    frameId,
    pageUrl,
    scanned,
    truncated,
  };
}

/** Our own injected UI must never harvest itself. */
function isOwnUi(el: Element): boolean {
  return !!el.closest?.('#zipper-panel,#zipper-fab,#zipper-float-download-btn,#zipper-gallery-ui');
}

/** og:/twitter: tags and JSON-LD — cheap, and often the canonical full-size URL. */
function metaCandidates(pageUrl: string, frameId: number): MediaCandidate[] {
  const out: MediaCandidate[] = [];
  const seen = new Set<string>();

  const push = (url: string | null | undefined, kind: MediaKind) => {
    if (!url) return;
    const abs = absolutize(url, document.baseURI);
    if (!/^https?:/i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    out.push(makeCandidate(abs, kind, 'meta', pageUrl, { frameId }));
  };

  const metaMap: [string, MediaKind][] = [
    ['meta[property="og:image:secure_url"]', 'image'],
    ['meta[property="og:image"]', 'image'],
    ['meta[name="twitter:image"]', 'image'],
    ['meta[property="og:video:secure_url"]', 'video'],
    ['meta[property="og:video:url"]', 'video'],
    ['meta[property="og:video"]', 'video'],
    ['meta[property="og:audio"]', 'audio'],
  ];
  for (const [sel, kind] of metaMap) {
    document.querySelectorAll(sel).forEach((m) => push(m.getAttribute('content'), kind));
  }

  // JSON-LD: walk any nested object for the media fields schema.org defines.
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let data: any;
    try { data = JSON.parse(s.textContent || ''); } catch { return; }
    const visit = (node: any, depth = 0) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
      if (typeof node !== 'object') return;
      const t = String(node['@type'] || '');
      if (/VideoObject/i.test(t)) {
        push(node.contentUrl, 'video');
        push(node.embedUrl, 'video');
        push(node.thumbnailUrl, 'image');
      } else if (/(ImageObject|Photograph)/i.test(t)) {
        push(node.contentUrl || node.url, 'image');
      } else if (/AudioObject/i.test(t)) {
        push(node.contentUrl, 'audio');
      }
      for (const k of Object.keys(node)) visit(node[k], depth + 1);
    };
    visit(data);
  });

  return out;
}
