/**
 * Sidebar-driven element highlighting.
 *
 * The old highlighter was called from inside the DOM walk and depended on the
 * injected panel's stylesheet and its toggle button. Now the sidebar owns the
 * selection, so highlighting is a separate, self-contained pass: it takes a set
 * of URLs and outlines whatever on the page produced them.
 *
 * Matching is on `dedupKey`, not raw string equality — the harvest may have
 * rewritten a thumbnail to its full-size URL, and the element still holds the
 * thumbnail. Both forms are accepted so the outline lands on the right node.
 */

import { dedupKey, largestFromSrcset, urlsFromCssValue, absolutize } from '../common/harvest';

const STYLE_ID = 'zipper-highlight-style';
const MARK_ATTR = 'data-zipper-mark';

/* Dashed rather than solid: a dashed edge stays legible over busy imagery,
 * where a solid line reads as part of the page's own chrome. */
const CSS = `
[${MARK_ATTR}] {
  outline: 3px dashed #6E7BF2 !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(110,123,242,.20) !important;
  transition: outline-color 90ms ease, box-shadow 90ms ease !important;
}
[${MARK_ATTR}="picked"] {
  outline: 3px dashed #FF8A6B !important;
  box-shadow: 0 0 0 4px rgba(255,138,107,.26) !important;
}
[${MARK_ATTR}="done"] {
  outline: 3px dashed #56D98D !important;
  box-shadow: 0 0 0 4px rgba(86,217,141,.22) !important;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}

/** Every URL an element could be responsible for, absolutised. */
function elementUrls(el: Element): string[] {
  const out: string[] = [];
  const base = el.ownerDocument?.baseURI || location.href;
  const push = (u: string | null | undefined) => {
    if (!u || u.startsWith('data:')) return;
    out.push(absolutize(u, base));
  };

  const tag = el.tagName.toLowerCase();
  if (tag === 'img') {
    const img = el as HTMLImageElement;
    push(img.currentSrc || img.src);
  } else if (tag === 'video') {
    const v = el as HTMLVideoElement;
    push(v.currentSrc || v.src);
    push(v.poster);
  } else if (tag === 'audio') {
    push((el as HTMLAudioElement).currentSrc || (el as HTMLAudioElement).src);
  } else if (tag === 'a') {
    push(el.getAttribute('href'));
  }

  const srcset = el.getAttribute('srcset');
  if (srcset) push(largestFromSrcset(srcset, base)?.url);

  for (const a of ['data-src', 'data-original', 'data-lazy', 'data-full', 'data-image']) {
    push(el.getAttribute(a));
  }

  if ((el as HTMLElement).style?.backgroundImage) {
    for (const u of urlsFromCssValue((el as HTMLElement).style.backgroundImage, base)) push(u);
  }

  return out;
}

export function clearHighlights(): void {
  document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
}

/**
 * Outline every element matching one of `urls`.
 * `picked` marks the currently-selected subset in the accent's counterweight.
 */
export function applyHighlights(urls: string[], picked: string[] = [], done: string[] = []): number {
  ensureStyle();
  clearHighlights();
  if (!urls.length) return 0;

  const want = new Set(urls.map(dedupKey));
  const hot = new Set(picked.map(dedupKey));
  const grabbed = new Set(done.map(dedupKey));
  let hits = 0;

  const nodes = document.querySelectorAll(
    'img,video,audio,a[href],picture,[style*="background"],[data-src],[data-original],[data-lazy]',
  );
  for (const el of nodes) {
    for (const u of elementUrls(el)) {
      const k = dedupKey(u);
      if (!want.has(k)) continue;
      // An <img> inside an <a> should mark the image, not the whole link box.
      // Already-downloaded wins over selected: knowing you have it matters more
      // than knowing you ticked it.
      el.setAttribute(MARK_ATTR, grabbed.has(k) ? 'done' : hot.has(k) ? 'picked' : 'on');
      hits++;
      break;
    }
  }
  return hits;
}

/** Scroll the first element matching `url` into view and flash it. */
export function revealUrl(url: string): boolean {
  const k = dedupKey(url);
  const nodes = document.querySelectorAll('img,video,audio,a[href],[style*="background"],[data-src]');
  for (const el of nodes) {
    if (!elementUrls(el).some((u) => dedupKey(u) === k)) continue;
    ensureStyle();
    el.setAttribute(MARK_ATTR, 'picked');
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      el.scrollIntoView();
    }
    return true;
  }
  return false;
}
