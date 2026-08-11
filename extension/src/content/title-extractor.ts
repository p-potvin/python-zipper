/**
 * DOM-based stream title extraction.
 *
 * Strategy (in priority order):
 *  1. Find the media element whose src matches the stream URL, then search
 *     ancestors/siblings for elements with title classes, IDs, attributes.
 *  2. Fallback: find the biggest <video> on the page and do the same search.
 *  3. Fallback: <meta property="og:title"> / <meta name="title">.
 *  4. Fallback: document.title.
 *
 * Returns the raw title — cleaning and hostname prefixing are the caller's job.
 */

export interface TitleResult {
  title: string;
  source: 'element' | 'biggest-video' | 'meta' | 'page-title' | 'not-found';
}

// ── URL matching ────────────────────────────────────────────────────────────

function urlPathMatch(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

// ── Media element discovery ─────────────────────────────────────────────────

/** Recursively collect <video>/<audio> from the document and same-origin iframes. */
function collectMediaElements(doc: Document | HTMLIFrameElement = document): HTMLMediaElement[] {
  const out: HTMLMediaElement[] = [];
  doc.querySelectorAll('video, audio').forEach((el) => out.push(el as HTMLMediaElement));
  doc.querySelectorAll('iframe').forEach((iframe) => {
    try {
      const d = iframe.contentDocument;
      if (d) out.push(...collectMediaElements(d));
    } catch { /* cross-origin */ }
  });
  return out;
}

/** Find the media element whose src/currentSrc matches the stream URL. */
function findMediaElementForUrl(streamUrl: string): HTMLMediaElement | null {
  const medias = collectMediaElements(document);
  for (const el of medias) {
    const src = el.src || el.currentSrc || el.querySelector('source')?.src || '';
    if (src && urlPathMatch(src, streamUrl)) return el;
  }
  // Also check <source> elements directly
  const sources = document.querySelectorAll('source');
  for (const s of sources) {
    if (s.src && urlPathMatch(s.src, streamUrl)) {
      const parent = s.closest('video, audio') as HTMLMediaElement | null;
      if (parent) return parent;
    }
  }
  return null;
}

/** Find the biggest <video> on the page (by videoWidth × videoHeight). */
function findBiggestVideo(): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;

  function search(doc: Document | HTMLIFrameElement) {
    doc.querySelectorAll('video').forEach((v) => {
      const area =
        (v.videoWidth || v.clientWidth || 0) * (v.videoHeight || v.clientHeight || 0);
      if (area > bestArea) { bestArea = area; best = v as HTMLVideoElement; }
    });
    doc.querySelectorAll('iframe').forEach((iframe) => {
      try { if (iframe.contentDocument) search(iframe.contentDocument); } catch { /* cross-origin */ }
    });
  }

  search(document);
  return best;
}

// ── Title extraction ────────────────────────────────────────────────────────

/** Attributes that commonly carry a human-readable title. */
const TITLE_ATTRS = ['data-title', 'aria-label', 'title', 'data-name', 'data-video-title'];

/** Specific class/ID patterns that strongly indicate a video title element. */
const TITLE_CLASS_PATTERNS = [
  'video-title', 'stream-title', 'media-title', 'post-title',
  'entry-title', 'article-title', 'content-title', 'item-title',
  'clip-title', 'episode-title', 'movie-title', 'show-title',
  'player-title', 'now-playing', 'current-title', 'video-name',
  'media-name', 'stream-name', 'watch-title', 'title-area',
  'videoinfo', 'video-info', 'media-info',
];

/** CSS selector for elements whose class or ID contains "title" (case-insensitive). */
const TITLE_EL_SELECTOR = [
  ...TITLE_CLASS_PATTERNS.map((p) => `[class*="${p}" i]`),
  ...TITLE_CLASS_PATTERNS.map((p) => `[id*="${p}" i]`),
  '[class*="title" i]',
  '[id*="title" i]',
  '[data-title]',
  'h1', 'h2', 'h3',
].join(', ');

/** Extract a title from the attributes of a single element. */
function extractTitleFromAttrs(el: Element): string | null {
  for (const attr of TITLE_ATTRS) {
    const val = el.getAttribute(attr);
    if (val && val.trim().length > 2) return val.trim();
  }
  return null;
}

/** Check if an element's class/id matches specific title patterns (high-confidence). */
function hasSpecificTitleClass(el: Element): boolean {
  const cls = ((el.className?.toString?.() || '') + ' ' + (el.id || '')).toLowerCase();
  return TITLE_CLASS_PATTERNS.some((p) => cls.includes(p));
}

/**
 * Search for a title-like element near the given root.
 * Walks up to 6 ancestors, at each level searching descendants for title elements.
 * Prefers specific title classes, then generic "title" matches, then headings.
 */
function extractTitleFromNearby(root: Element): string | null {
  // 1. Check the media element itself
  const selfTitle = extractTitleFromAttrs(root);
  if (selfTitle) return selfTitle;

  // 2. Walk up ancestors
  let ancestor: Element | null = root.parentElement;
  for (let depth = 0; depth < 6 && ancestor; depth++) {
    // Check ancestor's own attributes
    const attrTitle = extractTitleFromAttrs(ancestor);
    if (attrTitle) return attrTitle;

    // Search for title-like elements within this ancestor
    const candidates = ancestor.querySelectorAll(TITLE_EL_SELECTOR);
    const specificMatches: string[] = [];
    const genericMatches: string[] = [];
    const headingMatches: string[] = [];

    for (const cand of candidates) {
      // Skip the media element itself and its descendants
      if (cand === root || root.contains(cand) || cand.contains(root)) continue;
      // Skip elements inside nested media containers
      const nestedMedia = cand.closest('video, audio');
      if (nestedMedia && nestedMedia !== ancestor && root.contains(nestedMedia)) continue;

      // Check attributes first
      const attrTitle = extractTitleFromAttrs(cand);
      if (attrTitle) return attrTitle;

      const text = cand.textContent?.trim();
      if (!text || text.length < 3 || text.length > 300) continue;

      if (hasSpecificTitleClass(cand)) specificMatches.push(text);
      else if (/title/i.test(cand.className + ' ' + cand.id)) genericMatches.push(text);
      else if (cand.tagName === 'H1' || cand.tagName === 'H2' || cand.tagName === 'H3')
        headingMatches.push(text);
    }

    if (specificMatches.length) return specificMatches[0];
    if (genericMatches.length) return genericMatches[0];
    if (headingMatches.length) return headingMatches[0];

    ancestor = ancestor.parentElement;
  }

  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Extract a meaningful title for a detected stream by searching the DOM. */
export function extractStreamTitle(streamUrl: string): TitleResult {
  // Strategy 1: Find the media element associated with the stream URL
  const mediaEl = findMediaElementForUrl(streamUrl);
  if (mediaEl) {
    const title = extractTitleFromNearby(mediaEl);
    if (title) return { title, source: 'element' };
  }

  // Strategy 2: Find the biggest video element and search around it
  const biggest = findBiggestVideo();
  if (biggest && biggest !== mediaEl) {
    const title = extractTitleFromNearby(biggest);
    if (title) return { title, source: 'biggest-video' };
  }

  // Strategy 3: Meta tags (already checked in extractTitleFromNearby, but try
  // again here in case the media element wasn't found at all)
  const ogTitle = document
    .querySelector('meta[property="og:title"]')
    ?.getAttribute('content')
    ?.trim();
  if (ogTitle && ogTitle.length > 2) return { title: ogTitle, source: 'meta' };

  // Strategy 4: Page title
  const pageTitle = document.title?.trim();
  if (pageTitle) return { title: pageTitle, source: 'page-title' };

  return { title: '', source: 'not-found' };
}
