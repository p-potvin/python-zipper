/**
 * Live scanning.
 *
 * A MutationObserver over a modern feed fires constantly — lazy images swap in,
 * a video counter ticks, an ad rotates, a framework re-renders a list on a
 * timer. Reacting to all of that means re-scanning forever and handing the user
 * a list that reorders itself while they read it.
 *
 * So the observer is armed only by events with `isTrusted === true`: events the
 * browser generated from a real input device, which no script can forge. That
 * one condition turns a noise source into a signal, because the DOM changes
 * worth scanning are precisely the ones a person just caused — clicking to the
 * next slide of a carousel, scrolling a feed far enough to load more, opening
 * the full-size version of an image. The page's own churn arrives with no
 * trusted event behind it and is ignored.
 *
 * It also puts the user in the loop deliberately: interacting with the thing
 * you care about is how you tell the scan where to look, without having to
 * describe it.
 */

import { harvestDom } from './harvest';
import { markEligible, isGlobalHighlight } from './highlight';
import { ext } from '../common/api';

/**
 * How long a trusted event keeps the observer armed.
 *
 * Long enough to cover the network round trip a click causes — a lightbox that
 * fetches its full-size image is not instant — and short enough that the page's
 * background churn a few seconds later isn't attributed to it.
 */
const TRUST_WINDOW_MS = 4000;

/** Wait for the burst to finish before scanning; a render is many mutations. */
const SETTLE_MS = 450;

/** A hard floor on how often a scan can run, however busy the user is. */
const MIN_INTERVAL_MS = 1200;

/**
 * Events the browser only ever generates from real input.
 *
 * `scroll` is deliberately absent: it is dispatched by the browser for
 * programmatic scrolling too, so its `isTrusted` is always true and it would
 * arm the observer on our own deep scan. `wheel`, `pointerdown`, `keydown` and
 * `touchstart` have no such ambiguity.
 */
const TRUST_EVENTS = ['pointerdown', 'mousedown', 'wheel', 'keydown', 'touchstart', 'click'];

/** Attributes whose value changing means new media, not new styling. */
const WATCHED_ATTRS = ['src', 'srcset', 'href', 'poster', 'data-src', 'data-original', 'data-lazy', 'data-full'];

let observer: MutationObserver | null = null;
let enabled = false;
let lastTrusted = 0;
let lastScan = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let pending = new Set<Element>();
let scanning = false;

function noteTrusted(e: Event): void {
  // The whole gate. A synthetic event — including the clicks our own deep scan
  // dispatches to open a viewer — has isTrusted false and must not arm this,
  // or the scan would trigger itself in a loop.
  if (e.isTrusted) lastTrusted = Date.now();
}

function armed(): boolean {
  return Date.now() - lastTrusted <= TRUST_WINDOW_MS;
}

/** Collect the elements a mutation batch actually introduced. */
function collect(records: MutationRecord[]): void {
  for (const r of records) {
    if (r.type === 'attributes') {
      if (r.target instanceof Element) pending.add(r.target);
      continue;
    }
    for (const n of r.addedNodes) {
      if (n instanceof Element) pending.add(n);
    }
  }
  // A burst that adds hundreds of nodes is a whole feed page arriving. Scanning
  // the individual nodes is still cheaper than re-walking the document, but
  // there is no point holding thousands of references — the roots overlap.
  if (pending.size > 400) {
    pending = new Set([document.body].filter(Boolean) as Element[]);
  }
}

async function run(): Promise<void> {
  if (scanning || !enabled) return;
  const roots = Array.from(pending).filter((el) => el.isConnected);
  pending = new Set();
  if (!roots.length) return;

  scanning = true;
  lastScan = Date.now();
  try {
    // 'read' rather than 'open': if the user just opened a lightbox we get its
    // whole gallery for free, but we never click anything ourselves here. A
    // scan that opens viewers in response to browsing would be unusable.
    const result = await harvestDom(location.href, 0, '', { photoSwipe: 'read', roots });
    if (result.candidates.length) {
      try {
        await ext.runtime.sendMessage({
          kind: 'harvest:live',
          candidates: result.candidates,
          pageUrl: location.href,
        });
      } catch { /* sidebar or background gone */ }
    }
    if (isGlobalHighlight()) markEligible();
  } catch { /* page torn down mid-scan */ } finally {
    scanning = false;
  }
}

function schedule(): void {
  if (settleTimer) clearTimeout(settleTimer);
  const since = Date.now() - lastScan;
  const wait = Math.max(SETTLE_MS, MIN_INTERVAL_MS - since);
  settleTimer = setTimeout(() => { settleTimer = null; void run(); }, wait);
}

function onMutations(records: MutationRecord[]): void {
  if (!enabled) return;
  // Cheapest check first: an unarmed observer does no work beyond this line.
  if (!armed()) return;
  collect(records);
  if (pending.size) schedule();
}

export function setLiveScan(on: boolean): void {
  enabled = on;

  if (!on) {
    if (observer) { observer.disconnect(); observer = null; }
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    pending = new Set();
    for (const t of TRUST_EVENTS) {
      try { window.removeEventListener(t, noteTrusted, true); } catch { /* ignore */ }
    }
    return;
  }

  for (const t of TRUST_EVENTS) {
    try { window.addEventListener(t, noteTrusted, { capture: true, passive: true }); }
    catch { /* ignore */ }
  }

  if (observer) return;
  try {
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRS,
    });
  } catch {
    observer = null;   // pre-render document; the next settings change retries
  }
}
