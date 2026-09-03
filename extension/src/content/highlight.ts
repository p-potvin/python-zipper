/**
 * In-page highlighting.
 *
 * Two modes that share one stylesheet:
 *
 *   - **Global.** Driven by the extension setting, not by a scan. Every
 *     grabbable element on the page is outlined, continuously, for as long as
 *     the switch is on. This is the mode that got lost with the panel: it used
 *     to be a toggle you flipped once and forgot, and turning it back on after
 *     every scan meant in practice it was never on.
 *   - **Result overlay.** The sidebar pushes the current result set so the
 *     filtered list, the ticked subset and the already-downloaded files are
 *     each marked differently. Layered on top of global mode rather than
 *     replacing it.
 *
 * Matching is on `dedupKey`, not raw string equality — the harvest may have
 * rewritten a thumbnail to its full-size URL, and the element still holds the
 * thumbnail. Both forms are accepted so the outline lands on the right node.
 */

import { dedupKey } from '../common/harvest';
import { eligibleElements, elementMediaUrl, isOwnUi } from './eligible';

const STYLE_ID = 'zipper-highlight-style';
const MARK_ATTR = 'data-zipper-mark';

/**
 * Short dashes, drawn inside the element's own box, with a dark ring behind
 * them.
 *
 * Legibility over looks, deliberately. A 3px dash with a soft glow reads as
 * part of a well-designed page and disappears against busy imagery, which is
 * exactly the wrong outcome for a marker whose entire job is to be countable at
 * a glance. 2px dashes are visibly shorter and denser, `outline-offset: -2px`
 * keeps them on the image rather than floating outside it (so adjacent grid
 * cells stay distinguishable), and the 1px dark ring guarantees contrast on a
 * white page as well as a black one.
 */
const CSS = `
[${MARK_ATTR}] {
  outline: 2px dashed #6E7BF2 !important;
  outline-offset: -2px !important;
  box-shadow: 0 0 0 1px rgba(0,0,0,.72), inset 0 0 0 1px rgba(0,0,0,.72) !important;
}
[${MARK_ATTR}="picked"] {
  outline-color: #FF8A6B !important;
}
[${MARK_ATTR}="done"] {
  outline-color: #56D98D !important;
}
[${MARK_ATTR}="reveal"] {
  outline: 3px dashed #FF8A6B !important;
  outline-offset: 1px !important;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}

export function clearHighlights(): void {
  document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
}

// ---- global mode ------------------------------------------------------------

let globalOn = false;

/**
 * Outline every grabbable element on the page.
 *
 * Idempotent and cheap enough to re-run on mutation: it re-marks what is there
 * now and clears what no longer qualifies, so a feed that loads more content
 * stays fully marked without the caller tracking anything.
 */
export function markEligible(): number {
  if (!globalOn) return 0;
  ensureStyle();
  const want = new Set<Element>(eligibleElements());
  // Drop marks that are no longer earned, but leave the sidebar's own
  // picked/done marks alone — those are a different statement.
  document.querySelectorAll(`[${MARK_ATTR}="on"]`).forEach((el) => {
    if (!want.has(el)) el.removeAttribute(MARK_ATTR);
  });
  for (const el of want) {
    if (!el.hasAttribute(MARK_ATTR)) el.setAttribute(MARK_ATTR, 'on');
  }
  return want.size;
}

/**
 * Re-mark on scroll, throttled.
 *
 * Global mode has to stay true as a feed loads, and lazy images arrive with no
 * user event attached to them, so the live-scan observer alone would leave
 * later content unmarked. Scroll is the cheap, always-available proxy for "more
 * of the page is on screen now" — and unlike the live scanner this only reads
 * the DOM and sets an attribute, so running it often costs nothing.
 */
let scrollMark: ReturnType<typeof setTimeout> | null = null;
function onScroll(): void {
  if (!globalOn || scrollMark) return;
  scrollMark = setTimeout(() => { scrollMark = null; markEligible(); }, 300);
}

export function setGlobalHighlight(on: boolean): number {
  globalOn = on;
  if (!on) {
    try { window.removeEventListener('scroll', onScroll, true); } catch { /* ignore */ }
    if (scrollMark) { clearTimeout(scrollMark); scrollMark = null; }
    clearHighlights();
    return 0;
  }
  try { window.addEventListener('scroll', onScroll, { capture: true, passive: true }); }
  catch { /* ignore */ }
  return markEligible();
}

export function isGlobalHighlight(): boolean { return globalOn; }

// ---- result overlay ---------------------------------------------------------

/**
 * Mark the current result set.
 * `picked` is the ticked subset; `done` is what has already been downloaded.
 */
export function applyHighlights(urls: string[], picked: string[] = [], done: string[] = []): number {
  ensureStyle();
  clearHighlights();
  if (!urls.length) return globalOn ? markEligible() : 0;

  const want = new Set(urls.map(dedupKey));
  const hot = new Set(picked.map(dedupKey));
  const grabbed = new Set(done.map(dedupKey));
  let hits = 0;

  let nodes: Element[] = [];
  try {
    nodes = Array.from(document.querySelectorAll(
      'img,video,audio,a[href],picture,[style*="background"],[data-src],[data-original],[data-lazy]',
    ));
  } catch { nodes = []; }

  for (const el of nodes) {
    if (isOwnUi(el)) continue;
    const u = elementMediaUrl(el);
    if (!u) continue;
    const k = dedupKey(u);
    if (!want.has(k)) continue;
    // Already-downloaded wins over selected: knowing you have it matters more
    // than knowing you ticked it.
    el.setAttribute(MARK_ATTR, grabbed.has(k) ? 'done' : hot.has(k) ? 'picked' : 'on');
    hits++;
  }

  // Anything grabbable the result set didn't cover still gets the plain mark,
  // so global mode stays true to its name while a result is on screen.
  if (globalOn) {
    for (const el of eligibleElements()) {
      if (!el.hasAttribute(MARK_ATTR)) el.setAttribute(MARK_ATTR, 'on');
    }
  }
  return hits;
}

/** Scroll the first element matching `url` into view and flash it. */
export function revealUrl(url: string): boolean {
  const k = dedupKey(url);
  let nodes: Element[] = [];
  try {
    nodes = Array.from(document.querySelectorAll(
      'img,video,audio,a[href],picture,[style*="background"],[data-src]',
    ));
  } catch { return false; }

  for (const el of nodes) {
    if (isOwnUi(el)) continue;
    const u = elementMediaUrl(el);
    if (!u || dedupKey(u) !== k) continue;
    ensureStyle();
    el.setAttribute(MARK_ATTR, 'reveal');
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      el.scrollIntoView();
    }
    return true;
  }
  return false;
}
