/**
 * In-page download button.
 *
 * One button, moved to whatever media you are hovering, rather than one button
 * per element. That was the old panel's design and it was the right one: a page
 * with two hundred images gets two hundred absolutely-positioned nodes
 * otherwise, all of which have to be repositioned on every scroll and resize.
 *
 * Eligibility is `eligible.ts`, shared with the highlighter, so an outlined
 * element always offers a button and vice versa — with exactly one extra rule.
 * Below `minButtonPx` the button is refused outright, because at that size it
 * covers the element completely and eats the click that would have opened it.
 * Being permissive about what to offer is good; being permissive about that
 * breaks the page.
 */

import { ext } from '../common/api';
import { suggestedName, makeCandidate, kindFromUrl } from '../common/harvest';
import {
  elementMediaUrl, isEligible, canHostButton, isOwnUi, MEDIA_SELECTOR,
} from './eligible';

const BTN_ID = 'zipper-dl-btn';
const STYLE_ID = 'zipper-dl-btn-style';

/** Matches the button box in CSS; used to position it inside the element. */
const SIZE = 20;
const PAD = 4;

/**
 * How far to lift the button above the bottom edge of a `<video>`.
 *
 * A player's control bar lives there, and it is the one piece of page furniture
 * whose position is predictable enough to dodge by a fixed amount — roughly
 * 40px across the players this runs into. Nothing else gets the lift: images,
 * links and backgrounds have no controls, so the corner is simply free.
 */
const VIDEO_CONTROLS_HEIGHT = 40;

const CSS = `
#${BTN_ID} {
  position: absolute;
  z-index: 2147483646;
  width: ${SIZE}px;
  height: ${SIZE}px;
  display: none;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  margin: 0;
  border: 1px solid #6E7BF2;
  border-radius: 4px;
  background: rgba(17,20,27,.94);
  color: #E6EAF2;
  cursor: pointer;
  line-height: 0;
  box-shadow: 0 2px 8px rgba(0,0,0,.55);
  transition: background 120ms ease, transform 90ms ease;
}
#${BTN_ID}:hover { background: #6E7BF2; transform: scale(1.08); }
#${BTN_ID}[data-state="busy"] { border-color: #E9B054; color: #E9B054; }
#${BTN_ID}[data-state="ok"]   { border-color: #56D98D; color: #56D98D; }
#${BTN_ID}[data-state="err"]  { border-color: #F45D6B; color: #F45D6B; }
#${BTN_ID} svg { width: 12px; height: 12px; fill: currentColor; display: block; }
`;

const ICON = 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 '
  + '2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z';

let btn: HTMLButtonElement | null = null;
let target: Element | null = null;
let targetUrl = '';
let enabled = false;
let minPx = 22;
let resetTimer: ReturnType<typeof setTimeout> | null = null;

function ensureButton(): HTMLButtonElement {
  if (btn && btn.isConnected) return btn;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const b = document.createElement('button');
  b.id = BTN_ID;
  b.type = 'button';
  b.title = 'Download this file';
  b.setAttribute('aria-label', 'Download this file');

  // Built as nodes rather than innerHTML: a page with a strict Trusted Types
  // policy rejects the string assignment outright, and the button then never
  // appears on exactly the sites most worth having it on.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON);
  svg.appendChild(path);
  b.appendChild(svg);

  // Capture phase and full suppression: on a gallery the element underneath is
  // a link that would navigate, and a download that also opens a lightbox is
  // not what was asked for.
  b.addEventListener('click', onClick, true);
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); }, true);

  (document.body || document.documentElement).appendChild(b);
  btn = b;
  return b;
}

function hide(): void {
  target = null;
  targetUrl = '';
  if (btn) btn.style.display = 'none';
}

/**
 * Pin the button in the element's bottom-right corner.
 *
 * The top-right was the wrong corner. That is where sites put their close
 * button, and covering an X that is smaller than our own minimum made it
 * unreachable: moving the pointer toward it left the media, the button hid
 * itself mid-reach, and the control underneath could never be clicked. Nudging
 * it down by a proportion of the height only made the button harder to aim at
 * without freeing the corner reliably.
 *
 * Bottom-right has almost nothing in it — except on a `<video>`, where the
 * control bar sits along the bottom. That one case is worth a fixed lift, since
 * a player's controls are consistently about 40px tall; everything else takes
 * the corner as-is.
 */
function place(el: Element): void {
  const b = ensureButton();
  let r: DOMRect;
  try { r = el.getBoundingClientRect(); } catch { hide(); return; }
  if (!r.width || !r.height) { hide(); return; }

  const isVideo = el.tagName === 'VIDEO' || !!el.querySelector?.('video');
  // Never lift by more than a third of the element: on a short player the
  // controls overlap the whole thing anyway, and pushing the button out of the
  // box entirely would be worse than overlapping them.
  const lift = isVideo ? Math.min(VIDEO_CONTROLS_HEIGHT, r.height / 3) : 0;

  b.style.top = `${Math.round(r.bottom + window.scrollY - SIZE - PAD - lift)}px`;
  b.style.left = `${Math.round(r.right + window.scrollX - SIZE - PAD)}px`;
  b.style.display = 'flex';
}

function flash(state: 'ok' | 'err'): void {
  const b = ensureButton();
  b.setAttribute('data-state', state);
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => { b.removeAttribute('data-state'); }, 1600);
}

async function onClick(e: Event): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  (e as any).stopImmediatePropagation?.();
  if (!targetUrl) return;

  const b = ensureButton();
  b.setAttribute('data-state', 'busy');
  try {
    const c = makeCandidate(targetUrl, kindFromUrl(targetUrl) ?? 'image', 'dom', location.href);
    const res = await ext.runtime.sendMessage({
      kind: 'downloads:start',
      url: targetUrl,
      filename: suggestedName(c),
      referer: location.href,
    });
    flash(res?.ok ? 'ok' : 'err');
  } catch {
    flash('err');
  }
}

// ---- hover tracking ---------------------------------------------------------

/**
 * The nearest ancestor (including the node itself) that is worth offering.
 *
 * Walks up a few levels because the element under the cursor is often a
 * caption, an overlay or a play badge sitting on top of the image rather than
 * the image itself — and refusing to look up is how a button fails to appear on
 * media that is plainly right there.
 */
function resolveTarget(from: Element | null): Element | null {
  let el: Element | null = from;
  for (let i = 0; el && i < 4; i++) {
    if (isOwnUi(el)) return null;
    if (el.matches?.(MEDIA_SELECTOR) && isEligible(el) && canHostButton(el, minPx)) return el;
    el = el.parentElement;
  }
  return null;
}

function onOver(e: MouseEvent): void {
  if (!enabled) return;
  const from = e.target as Element | null;
  if (!from || !(from instanceof Element)) return;
  if (btn && (from === btn || btn.contains(from))) return;   // hovering the button itself

  const el = resolveTarget(from);
  if (!el) { hide(); return; }

  const url = elementMediaUrl(el);
  if (!url) { hide(); return; }

  target = el;
  targetUrl = url;
  place(el);
}

/** The page moves under a pinned button, so it has to be re-pinned. */
function reposition(): void {
  if (!enabled || !target) return;
  if (!target.isConnected) { hide(); return; }
  place(target);
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  window.addEventListener('mouseover', onOver, true);
  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });
}

// ---- control ----------------------------------------------------------------

export function setInjectButton(on: boolean, minButtonPx = 22): void {
  minPx = Math.max(0, minButtonPx | 0);
  enabled = on;
  if (!on) { hide(); return; }
  wire();
  ensureButton();
}

export function isInjectButtonOn(): boolean { return enabled; }
