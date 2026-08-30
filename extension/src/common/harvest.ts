/**
 * The harvest record and the pure helpers around it.
 *
 * The old `harvestLinks()` collapsed every candidate to `{url, isInteresting}`,
 * which is why a working "min size" or "min width" filter couldn't be built on
 * it — the scorer knew things it then threw away. A candidate now carries the
 * facts it was scored on, so the UI filters on fields instead of re-deriving.
 */

import { registrableDomain, hostOf } from './domain';

export type MediaKind = 'image' | 'video' | 'audio' | 'stream' | 'document' | 'other';

/** Where a candidate came from. Used for ranking and for explaining the result. */
export type CandidateOrigin =
  | 'dom'       // an element's src/href/srcset
  | 'network'   // observed response — the only origin that knows byte size
  | 'carousel'  // lightbox/slider internals
  | 'meta'      // og: tags, JSON-LD
  | 'text';     // scraped out of page text

export interface MediaCandidate {
  url: string;
  kind: MediaKind;
  origin: CandidateOrigin;
  /** Intrinsic pixels where known. DOM gives these; the network log doesn't. */
  width?: number;
  height?: number;
  /** Content-Length. Only the network log can supply it. */
  bytes?: number;
  mime?: string;
  /** Which frame produced it — 0 is the top document. */
  frameId?: number;
  /** Profile key: the registrable domain of the *page*, never of the asset. */
  pageDomain: string;
  /** Connection-policy key: the host that actually served the bytes. */
  assetHost: string;
  score: number;
  /**
   * How many separate elements on the page produced this URL. Content appears
   * once; chrome (avatars, logos, badges) repeats down a feed. This is the
   * signal that actually demotes avatars — see scoring.ts.
   */
  domHits?: number;
  /** Set when a thumbnail URL was rewritten to a full-size one. */
  upgradedFrom?: string;
  /** Nearby text, alt, or title — seeds the filename. */
  label?: string;
}

// ---- classification ---------------------------------------------------------

const EXT_KIND: Record<string, MediaKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  avif: 'image', bmp: 'image', jxl: 'image', heic: 'image', tiff: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video',
  avi: 'video', flv: 'video', wmv: 'video', ogv: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  opus: 'audio', oga: 'audio', ogg: 'audio', wma: 'audio',
  m3u8: 'stream', mpd: 'stream', f4m: 'stream', ism: 'stream',
  pdf: 'document', epub: 'document', zip: 'document', rar: 'document',
  '7z': 'document', cbz: 'document', cbr: 'document', txt: 'document',
};

/** Never worth harvesting: chrome, tracking pixels, vector UI furniture. */
const EXT_REJECT = new Set(['svg', 'ico', 'cur', 'css', 'js', 'json', 'xml', 'woff', 'woff2', 'ttf', 'eot']);

export function extensionOf(url: string): string {
  try {
    const path = new URL(url, 'https://x.invalid').pathname;
    const dot = path.lastIndexOf('.');
    if (dot < 0 || dot < path.lastIndexOf('/')) return '';
    return path.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

export function isRejectedExtension(url: string): boolean {
  return EXT_REJECT.has(extensionOf(url));
}

export function kindFromUrl(url: string): MediaKind | null {
  return EXT_KIND[extensionOf(url)] ?? null;
}

export function kindFromMime(mime: string): MediaKind | null {
  if (!mime) return null;
  const m = mime.toLowerCase().split(';')[0].trim();
  if (/^application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-sstr\+xml)/.test(m)) return 'stream';
  if (m === 'audio/mpegurl' || m === 'audio/x-mpegurl') return 'stream';
  if (m.startsWith('image/')) return m === 'image/svg+xml' ? null : 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/^application\/(pdf|epub|zip|x-rar|x-7z)/.test(m)) return 'document';
  return null;
}

// ---- srcset -----------------------------------------------------------------

/**
 * Pick the largest candidate out of a `srcset`.
 *
 * We didn't read srcset at all before, which on any responsive site meant
 * harvesting whatever the layout picked — usually the small one. Handles both
 * `w` descriptors (`img.jpg 1600w`) and `x` densities (`img.jpg 2x`).
 */
export function largestFromSrcset(srcset: string, base?: string): { url: string; width?: number } | null {
  if (!srcset) return null;
  let best: { url: string; width?: number; weight: number } | null = null;

  // Split on commas that separate candidates, not commas inside a URL.
  for (const raw of srcset.split(/\s*,\s*(?=[^\s,]+(?:\s+\d|\s*,|\s*$))/)) {
    const part = raw.trim();
    if (!part) continue;
    const sp = part.split(/\s+/);
    const url = sp[0];
    if (!url) continue;
    const desc = sp[1] || '';
    let weight = 1;
    let width: number | undefined;
    const w = /^(\d+(?:\.\d+)?)w$/.exec(desc);
    const x = /^(\d+(?:\.\d+)?)x$/.exec(desc);
    if (w) { width = Math.round(parseFloat(w[1])); weight = width; }
    else if (x) { weight = parseFloat(x[1]) * 1000; }
    if (!best || weight > best.weight) best = { url, width, weight };
  }
  if (!best) return null;
  return { url: absolutize(best.url, base), width: best.width };
}

/** Pull the URL out of `url(...)`, `image-set(...)`, or a bare value. */
export function urlsFromCssValue(value: string, base?: string): string[] {
  if (!value || value === 'none') return [];
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const u = m[2].trim();
    if (u && !u.startsWith('data:')) out.push(absolutize(u, base));
  }
  return out;
}

export function absolutize(url: string, base?: string): string {
  try {
    return new URL(url, base || (typeof location !== 'undefined' ? location.href : undefined)).href;
  } catch {
    return url;
  }
}

// ---- dedup ------------------------------------------------------------------

/** Params that vary per request without changing the bytes. */
const CACHE_BUST = /^(_|v|ver|version|t|ts|time|cb|cache|rand|r|nocache|__cf|fbclid|utm_[a-z]+)$/i;

/**
 * Identity for deduplication. Strips cache-busting params but keeps auth-ish
 * ones — dropping a `token` would collapse two genuinely different URLs and
 * leave us holding the one that 403s.
 */
export function dedupKey(url: string): string {
  try {
    const u = new URL(url);
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) {
      if (!CACHE_BUST.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = keep.map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${qs ? '?' + qs : ''}`;
  } catch {
    return url;
  }
}

/**
 * Second dedup pass: the same asset mirrored across CDN hosts produces
 * different origins but identical size and filename.
 */
export function contentKey(c: MediaCandidate): string | null {
  if (!c.bytes) return null;
  try {
    const name = new URL(c.url).pathname.split('/').pop() || '';
    if (!name) return null;
    return `${c.bytes}:${name.toLowerCase()}`;
  } catch {
    return null;
  }
}

// ---- merge ------------------------------------------------------------------

const ORIGIN_RANK: Record<CandidateOrigin, number> = {
  network: 5, carousel: 4, dom: 3, meta: 2, text: 1,
};

/**
 * Fold two sightings of the same asset into one record. Field-wise rather than
 * whole-record: the network log knows `bytes` and the DOM knows `width`, and a
 * merged candidate should end up with both.
 */
export function mergeCandidate(a: MediaCandidate, b: MediaCandidate): MediaCandidate {
  const primary = ORIGIN_RANK[b.origin] > ORIGIN_RANK[a.origin] ? b : a;
  const other = primary === a ? b : a;
  return {
    ...primary,
    width: primary.width ?? other.width,
    height: primary.height ?? other.height,
    bytes: primary.bytes ?? other.bytes,
    mime: primary.mime ?? other.mime,
    label: primary.label ?? other.label,
    domHits: Math.max(a.domHits ?? 0, b.domHits ?? 0) || undefined,
    upgradedFrom: primary.upgradedFrom ?? other.upgradedFrom,
    // A URL seen by two independent paths is more likely to be real content.
    score: Math.max(a.score, b.score) + (a.origin !== b.origin ? 40 : 0),
  };
}

export function makeCandidate(
  url: string,
  kind: MediaKind,
  origin: CandidateOrigin,
  pageUrl: string,
  extra: Partial<MediaCandidate> = {},
): MediaCandidate {
  return {
    url,
    kind,
    origin,
    pageDomain: registrableDomain(hostOf(pageUrl)),
    assetHost: hostOf(url),
    score: 0,
    ...extra,
  };
}

// ---- naming -----------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'oga',
  'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};

/** Large enough that an unlabelled binary is almost certainly video. */
const VIDEO_SIZE_HINT = 3 * 1024 * 1024;

/**
 * The extension a candidate should be saved with.
 *
 * CDNs routinely serve media from extension-less URLs, which previously meant
 * files landing on disk with no extension at all — unopenable without renaming.
 * Order of trust: a real extension in the URL, then the server's Content-Type,
 * then the classified kind, and finally a size heuristic, because a multi-
 * megabyte blob with no other clue is far more likely to be video than an image.
 */
export function extForCandidate(c: MediaCandidate): string {
  const urlExt = extensionOf(c.url);
  if (urlExt && EXT_KIND[urlExt]) return urlExt;

  if (c.mime) {
    const m = MIME_EXT[c.mime.toLowerCase().split(';')[0].trim()];
    if (m) return m;
  }

  switch (c.kind) {
    case 'video': return 'mp4';
    case 'audio': return 'mp3';
    case 'image': return 'jpg';
    case 'document': return 'bin';
    default:
      return (c.bytes ?? 0) >= VIDEO_SIZE_HINT ? 'mp4' : 'jpg';
  }
}

/** Filename to save a candidate as, always carrying a usable extension. */
export function suggestedName(c: MediaCandidate): string {
  let base = '';
  try {
    const p = new URL(c.url).pathname;
    base = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
  } catch { /* fall through */ }
  if (!base) base = (c.label || 'file').slice(0, 60);

  // Strip anything illegal in a Windows filename, backslash included.
  base = base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'file';

  const want = extForCandidate(c);
  const has = extensionOf(base);
  if (has && EXT_KIND[has]) return base;
  return `${base.replace(/\.$/, '')}.${want}`;
}
