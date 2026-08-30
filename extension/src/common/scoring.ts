/**
 * Candidate scoring.
 *
 * The previous scorer was one long cascade of magic numbers inline in the DOM
 * walk, which made it impossible to tell why something ranked where it did.
 * Same heuristics, but pulled out, named, and additive — so a bad result can be
 * traced to a rule instead of guessed at.
 *
 * Score is a *ranking* signal, not a filter. The UI filters on real fields
 * (kind, bytes, width); score only decides order and what gets pre-selected.
 */

import type { MediaCandidate, MediaKind } from './harvest';

export const SCORE = {
  /** Below this, a candidate is noise and never reaches the list. */
  FLOOR: 40,
  /** At or above this, it is pre-selected and worth highlighting in-page. */
  INTERESTING: 200,
};

const KIND_BASE: Record<MediaKind, number> = {
  video: 340, stream: 320, audio: 250, image: 240, document: 160, other: 40,
};

/** Terms that mark a full-size or high-quality asset. */
const QUALITY_RE = /(1080p?|1440p?|2160p?|4k|uhd|720p?|hd|full|orig(inal)?|source|master|large|orig|raw|lossless|flac|320k)/i;

/** Path segments that mark a derivative, not the asset itself. */
const DERIVATIVE_RE = /\/(thumb|thumbs|thumbnail|thumbnails|preview|previews|small|tiny|mini|icon|icons|avatar|avatars|profile|sprite|placeholder|blur)\//i;

/** Chrome, tracking, and UI furniture. */
const FURNITURE_RE = /(sprite|logo|favicon|emoji|badge|watermark|loading|spinner|spacer|pixel|beacon|analytics|tracking|1x1|blank)/i;

/**
 * Profile pictures. Split out from FURNITURE_RE because it needs to be
 * aggressive and because these were coming back as the top three results on a
 * feed: an avatar is a real image at a real size served from a real CDN, so
 * nothing in the generic scoring was pushing it down.
 */
const AVATAR_RE = /(avatar|profile[-_/]?(pic|photo|image)?|userpic|pfp|\/users?\/|headshot|thumb_?user|account[-_]?img|gravatar)/i;

/**
 * Profile banners and cover art. Separate from AVATAR_RE because demoting
 * avatars just promoted these into the top slots instead — same problem, same
 * cause: a banner is a large, well-served, legitimately big image, so nothing
 * generic pushes it down. It is page furniture regardless of its size.
 */
const BANNER_RE = /(\bheader\b|header[-_]?img|header[-_]?image|\bbanner\b|\bcover\b|cover[-_]?(photo|image)|\bhero\b|backdrop|masthead)/i;

/** Square-ish and small is the avatar shape, whatever the URL says. */
function looksLikeAvatar(w?: number, h?: number): boolean {
  if (!w || !h) return false;
  const ratio = w / h;
  return ratio > 0.85 && ratio < 1.18 && w <= 512;
}

/** Container classes that mark real content vs. page chrome. */
const CONTENT_ZONE_RE = /(post|gallery|article|main|content|media|photo|video|feed|carousel|slider|swiper|pswp|lightbox|attachment)/i;
const CHROME_ZONE_RE = /(header|footer|nav|sidebar|menu|widget|toolbar|banner|advert|promo|related|recommend|comment)/i;

export interface ElementHints {
  /** Combined class + id text of the ancestor chain, lowercased. */
  ancestry?: string;
  /** False when computed style hides it. */
  visible?: boolean;
  /** True for <img>/<video> that the page is actually displaying. */
  rendered?: boolean;
}

export function scoreCandidate(c: MediaCandidate, hints: ElementHints = {}): number {
  let score = KIND_BASE[c.kind] ?? 40;
  const url = c.url.toLowerCase();

  // --- hard facts first. Real dimensions and real bytes beat every guess. ---
  const area = (c.width ?? 0) * (c.height ?? 0);
  if (area > 0) {
    if (area >= 1920 * 1080) score += 300;
    else if (area >= 1280 * 720) score += 180;
    else if (area >= 640 * 480) score += 60;
    else if (c.width! < 120 || c.height! < 120) score -= 500; // icon-sized
    else score -= 120;
  }

  if (c.bytes !== undefined) {
    if (c.bytes >= 5_000_000) score += 260;
    else if (c.bytes >= 1_000_000) score += 180;
    else if (c.bytes >= 200_000) score += 90;
    else if (c.bytes < 15_000) score -= 400;   // tracking pixels, UI chrome
    else if (c.bytes < 50_000) score -= 120;
  }

  // --- URL-shape signals ---------------------------------------------------
  if (QUALITY_RE.test(url)) score += 120;
  if (DERIVATIVE_RE.test(url)) score -= 260;
  if (FURNITURE_RE.test(url)) score -= 450;
  if (AVATAR_RE.test(url)) score -= 700;
  if (BANNER_RE.test(url)) score -= 650;
  if (/\/files?\//.test(url)) score += 120;

  // A very wide, short image is a banner whatever it's called — content is
  // rarely wider than 3:1. Checked on real dimensions so it can't misfire on a
  // candidate whose shape we don't know. Graduated, because 3.5:1 is suggestive
  // while 6:1 is conclusive.
  if (c.width && c.height) {
    const ratio = c.width / c.height;
    if (ratio >= 5) score -= 550;
    else if (ratio >= 3.5) score -= 400;
    else if (ratio >= 2.8) score -= 150;
  }

  // --- repetition: the strongest chrome signal we have ---------------------
  //
  // One avatar is indistinguishable from one photo. Thirty copies of the same
  // avatar down a feed is not — content appears once, chrome repeats. This is
  // what actually demotes avatars reliably, since a URL pattern only catches
  // the hosts that happen to name things helpfully.
  const repeats = c.domHits ?? 1;
  if (repeats >= 10) score -= 600;
  else if (repeats >= 5) score -= 350;
  else if (repeats >= 3) score -= 150;

  // Square and small, wherever it came from.
  if (c.kind === 'image' && looksLikeAvatar(c.width, c.height)) score -= 250;

  // An upgraded URL was proven better by a rewrite rule that matched.
  if (c.upgradedFrom) score += 150;

  // --- DOM context ---------------------------------------------------------
  if (hints.ancestry) {
    if (CONTENT_ZONE_RE.test(hints.ancestry)) score += 110;
    if (CHROME_ZONE_RE.test(hints.ancestry)) score -= 240;
  }
  if (hints.visible === false) score -= 300;
  if (hints.rendered) score += 60;

  // --- origin --------------------------------------------------------------
  // A network sighting means the page genuinely fetched it, which is stronger
  // evidence than an attribute that may never have been used.
  if (c.origin === 'network') score += 90;
  if (c.origin === 'carousel') score += 130;
  if (c.origin === 'text') score -= 60;

  return Math.round(score);
}

export function isInteresting(c: MediaCandidate): boolean {
  return c.score >= SCORE.INTERESTING;
}
