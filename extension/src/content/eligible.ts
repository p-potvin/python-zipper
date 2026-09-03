/**
 * What counts as a grabbable element on the page.
 *
 * One definition, shared by the highlighter and the in-page download button,
 * because they answer the same question and a user who sees an outline and then
 * gets no button has been told two different things about the same image.
 *
 * Deliberately permissive. This is not the scorer — the scorer decides what is
 * *worth* having and lives in common/scoring.ts, working on a full record with
 * bytes and page context. This decides only whether an element on the page has
 * a file behind it that could be fetched. A false positive here costs a glance
 * at an outline you didn't want; a false negative costs a file you can't reach
 * at all, which is much worse.
 *
 * The one hard rejection is size, and only for the button — see `canHostButton`.
 */

import { isRejectedExtension, largestFromSrcset, absolutize } from '../common/harvest';

/** Our own injected UI must never offer to download itself. */
export const OWN_UI = '#zipper-panel,#zipper-fab,#zipper-dl-btn,#zipper-picker-box,#zipper-picker-tip,#zipper-gallery-ui';

export function isOwnUi(el: Element): boolean {
  try { return !!el.closest?.(OWN_UI); } catch { return false; }
}

/** Elements worth considering at all. */
export const MEDIA_SELECTOR = [
  'img', 'video', 'audio', 'picture',
  'a[href]',
  '[style*="background-image"]',
  '[data-src]', '[data-original]', '[data-lazy]', '[data-full]', '[data-image]',
].join(',');

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-full', 'data-image', 'data-zoom-image'];

/** Anything a link must end in before it counts as media rather than navigation. */
const DIRECT_MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|bmp|jxl|heic|tiff|mp4|webm|mkv|mov|m4v|avi|mp3|wav|flac|m4a|aac|opus|ogg)(?:[?#]|$)/i;

/**
 * The single best URL this element is responsible for.
 *
 * `srcset` first for the same reason the harvest reads it first: on a
 * responsive site the attribute holds a larger variant than whatever the layout
 * happened to pick, and offering the small one is offering the wrong file.
 */
export function elementMediaUrl(el: Element): string {
  const base = el.ownerDocument?.baseURI || location.href;
  const abs = (u: string | null | undefined): string => {
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return '';
    const a = absolutize(u, base);
    return /^https?:/i.test(a) ? a : '';
  };

  const tag = el.tagName.toLowerCase();

  const srcset = el.getAttribute('srcset');
  if (srcset) {
    const best = largestFromSrcset(srcset, base);
    if (best?.url) { const u = abs(best.url); if (u) return u; }
  }

  if (tag === 'img') {
    const img = el as HTMLImageElement;
    const u = abs(img.currentSrc || img.src);
    if (u) return u;
  } else if (tag === 'video') {
    const v = el as HTMLVideoElement;
    const u = abs(v.currentSrc || v.src) || abs(v.querySelector('source')?.getAttribute('src'));
    if (u) return u;
    const p = abs(v.poster);
    if (p) return p;
  } else if (tag === 'audio') {
    const a = el as HTMLAudioElement;
    const u = abs(a.currentSrc || a.src) || abs(a.querySelector('source')?.getAttribute('src'));
    if (u) return u;
  } else if (tag === 'picture') {
    const inner = el.querySelector('img,source');
    if (inner) return elementMediaUrl(inner);
  } else if (tag === 'a') {
    // A link is media only when it points at a file. Everything else is
    // navigation, and outlining the page's whole nav is noise, not permissive.
    const href = el.getAttribute('href') || '';
    const u = abs(href);
    if (u && DIRECT_MEDIA_RE.test(u)) return u;
    // A link wrapping an image stands in for that image.
    const inner = el.querySelector('img,video,picture');
    if (inner) return elementMediaUrl(inner);
    return '';
  }

  for (const a of LAZY_ATTRS) {
    const u = abs(el.getAttribute(a));
    if (u) return u;
  }

  const bg = (el as HTMLElement).style?.backgroundImage;
  if (bg && bg !== 'none') {
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(bg);
    if (m) { const u = abs(m[2]); if (u) return u; }
  }

  return '';
}

/** Rendered size, which is what decides whether a button would cover it. */
export function renderedSize(el: Element): { w: number; h: number } {
  const e = el as HTMLElement;
  let w = e.offsetWidth || e.clientWidth || 0;
  let h = e.offsetHeight || e.clientHeight || 0;
  if (!w || !h) {
    try {
      const r = el.getBoundingClientRect();
      w = w || Math.round(r.width);
      h = h || Math.round(r.height);
    } catch { /* detached */ }
  }
  return { w, h };
}

function isVisible(el: Element): boolean {
  try {
    const s = getComputedStyle(el as HTMLElement);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (s.opacity === '0') return false;
    return true;
  } catch {
    return true;   // a node we can't measure is not a node we should hide
  }
}

/**
 * Is there a file behind this element that we could go and fetch?
 *
 * No class-name blacklist, unlike the old highlighter. That list rejected
 * anything whose markup mentioned `avatar`, `icon`, `profile` or `banner`, and
 * on a site that names its content containers unhelpfully it silently removed
 * real media from the page overlay entirely — the same failure the `/users/`
 * token caused in the scorer. Judging what is *worth* grabbing is the scorer's
 * job, on a record with bytes and page context; this only decides what is
 * grabbable.
 */
export function isEligible(el: Element): boolean {
  if (!el || !(el instanceof Element)) return false;
  if (isOwnUi(el)) return false;
  if (!isVisible(el)) return false;

  const url = elementMediaUrl(el);
  if (!url || isRejectedExtension(url)) return false;

  // Tracking pixels and spacers: not a judgement call, they have no content.
  const { w, h } = renderedSize(el);
  if (w > 0 && h > 0 && w <= 2 && h <= 2) return false;

  return true;
}

/**
 * Can this element host a download button?
 *
 * The only place the shared rules get stricter, and it is not about quality.
 * A button pinned to a 16px thumbnail covers the entire thing and swallows the
 * click that would have opened it — the page stops working, which is a worse
 * outcome than not offering the file. So it is an automatic rejection at a
 * fixed size rather than anything weighed against other signals.
 */
export function canHostButton(el: Element, minPx: number): boolean {
  const { w, h } = renderedSize(el);
  // An element we cannot measure gets the benefit of the doubt: it is usually
  // one that hasn't laid out yet, not one that is genuinely tiny.
  if (!w || !h) return true;
  return w >= minPx && h >= minPx;
}

/** Every eligible element under `root`, in document order. */
export function eligibleElements(root: ParentNode = document): Element[] {
  let nodes: Element[] = [];
  try { nodes = Array.from(root.querySelectorAll(MEDIA_SELECTOR)); } catch { return []; }
  return nodes.filter(isEligible);
}
