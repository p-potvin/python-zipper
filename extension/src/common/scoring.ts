/**
 * Candidate scoring — the per-candidate pass.
 *
 * The previous scorer was one long cascade of magic numbers inline in the DOM
 * walk, which made it impossible to tell why something ranked where it did.
 * Same heuristics, but pulled out, named, and additive — so a bad result can be
 * traced to a rule instead of guessed at.
 *
 * Every rule now records what it contributed. `explainCandidate` returns that
 * breakdown; `scoreCandidate` throws it away and returns the number. Reading the
 * source and simulating it mentally was the exact failure the old scorer had,
 * just better organised — the breakdown is what makes tuning tractable.
 *
 * This file only ever sees ONE candidate, so it can only use absolute
 * thresholds. Everything that needs to compare a candidate against the rest of
 * the page — largest-on-page, grid membership, size outliers — lives in
 * `page_rank.ts` and runs after the merge.
 *
 * Score is a *ranking* signal, not a filter. The UI filters on real fields
 * (kind, bytes, width); score only decides order and what gets highlighted.
 */

import type { MediaCandidate, MediaKind, ScoreRule } from './harvest';

export type { ScoreRule };

export const SCORE = {
  /** Below this, a candidate is noise and never reaches the list. Applied ONCE,
   *  after the merge, in harvest_store — never at ingest. See page_rank.ts. */
  FLOOR: 40,
  /** At or above this it is worth highlighting in the list. Ranking only:
   *  pre-selection is a separate decision, see `defaultSelection` in page_rank. */
  INTERESTING: 200,
};

export interface Scored {
  score: number;
  rules: ScoreRule[];
}

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
 * nothing in the generic scoring was pushing it down. Confirmed by the
 * operator that avatars are never content, so this stays blunt.
 *
 * `/users/` was removed. It was the most dangerous token in the file — a very
 * common *content* path (a user's own feed, their posts, their uploads), and on
 * a site that stores real media under it this one rule was quietly deleting
 * most of the page. The genuine avatars it caught are still caught by the word
 * tokens below, by the avatar-shape rule, and by repetition.
 */
const AVATAR_RE = /(avatar|profile[-_/]?(pic|photo|image)?|userpic|pfp|headshot|thumb_?user|account[-_]?img|gravatar)/i;

/**
 * Profile banners and cover art. Separate from AVATAR_RE because demoting
 * avatars just promoted these into the top slots instead — same problem, same
 * cause: a banner is a large, well-served, legitimately big image, so nothing
 * generic pushes it down.
 *
 * Bare `cover` was removed for the same reason `/users/` was: it appears in
 * genuine content paths, and a wallpaper or cover-art gallery is exactly the
 * thing being harvested. The compound forms — cover_photo, cover-image — are
 * unambiguous furniture and stay. A real banner that dodges the word list is
 * still caught by the aspect-ratio rule below, which reads shape, not naming.
 */
const BANNER_RE = /(\bheader\b|header[-_]?img|header[-_]?image|\bbanner\b|cover[-_]?(photo|pic|image|img)|\bhero\b|backdrop|masthead)/i;

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

/**
 * Score a candidate and report every rule that fired.
 *
 * Rule names are stable strings — the UI shows them verbatim and the fixture
 * checks assert on them, so renaming one is a breaking change to both.
 */
export function explainCandidate(c: MediaCandidate, hints: ElementHints = {}): Scored {
  const rules: ScoreRule[] = [];
  let score = 0;
  const add = (rule: string, delta: number) => {
    if (!delta) return;
    score += delta;
    rules.push([rule, delta]);
  };

  add('kind.' + c.kind, KIND_BASE[c.kind] ?? 40);
  const url = c.url.toLowerCase();

  // --- hard facts first. Real dimensions and real bytes beat every guess. ---
  const area = (c.width ?? 0) * (c.height ?? 0);
  if (area > 0) {
    if (area >= 1920 * 1080) add('area.4mp', 300);
    else if (area >= 1280 * 720) add('area.1mp', 180);
    else if (area >= 640 * 480) add('area.300kp', 60);
    else if ((c.width ?? 0) < 120 || (c.height ?? 0) < 120) add('area.icon', -500);
    else add('area.small', -120);
  }

  if (c.bytes !== undefined) {
    if (c.bytes >= 5_000_000) add('bytes.5mb', 260);
    else if (c.bytes >= 1_000_000) add('bytes.1mb', 180);
    else if (c.bytes >= 200_000) add('bytes.200kb', 90);
    else if (c.bytes < 15_000) add('bytes.tiny', -400);   // tracking pixels, UI chrome
    else if (c.bytes < 50_000) add('bytes.small', -120);
  }

  // --- URL-shape signals ---------------------------------------------------
  if (QUALITY_RE.test(url)) add('url.quality', 120);
  if (DERIVATIVE_RE.test(url)) add('url.derivative', -260);
  if (FURNITURE_RE.test(url)) add('url.furniture', -450);
  if (AVATAR_RE.test(url)) add('url.avatar', -700);
  if (BANNER_RE.test(url)) add('url.banner', -650);
  if (/\/files?\//.test(url)) add('url.files', 120);

  // A very wide, short image is a banner whatever it's called — content is
  // rarely wider than 3:1. Checked on real dimensions so it can't misfire on a
  // candidate whose shape we don't know. Graduated, because 3.5:1 is suggestive
  // while 6:1 is conclusive.
  if (c.width && c.height) {
    const ratio = c.width / c.height;
    if (ratio >= 5) add('shape.ultrawide', -550);
    else if (ratio >= 3.5) add('shape.wide', -400);
    else if (ratio >= 2.8) add('shape.wideish', -150);
  }

  // --- repetition: the strongest chrome signal we have ---------------------
  //
  // One avatar is indistinguishable from one photo. Thirty copies of the same
  // avatar down a feed is not — content appears once, chrome repeats. This is
  // what actually demotes avatars reliably, since a URL pattern only catches
  // the hosts that happen to name things helpfully.
  //
  // This counts repeats of ONE url. A grid of thirty *different* images at the
  // same size is the opposite signal, and is credited by the cluster rule in
  // page_rank.ts rather than punished here.
  const repeats = c.domHits ?? 1;
  if (repeats >= 10) add('repeat.10', -600);
  else if (repeats >= 5) add('repeat.5', -350);
  else if (repeats >= 3) add('repeat.3', -150);

  // Square and small, wherever it came from.
  if (c.kind === 'image' && looksLikeAvatar(c.width, c.height)) add('shape.avatar', -250);

  // A rewrite rule matched and produced a different URL. Deliberately modest:
  // this is awarded for the rule matching, not for the rewritten URL having
  // been verified to exist, so an over-eager rule would otherwise promote a
  // 404 straight to the top of the list.
  if (c.upgradedFrom) add('url.upgraded', 60);

  // --- DOM context ---------------------------------------------------------
  if (hints.ancestry) {
    if (CONTENT_ZONE_RE.test(hints.ancestry)) add('zone.content', 110);
    if (CHROME_ZONE_RE.test(hints.ancestry)) add('zone.chrome', -240);
  }
  if (hints.visible === false) add('dom.hidden', -300);
  if (hints.rendered) add('dom.rendered', 60);

  // --- origin --------------------------------------------------------------
  // A network sighting means the page genuinely fetched it, which is stronger
  // evidence than an attribute that may never have been used.
  if (c.origin === 'network') add('origin.network', 90);
  if (c.origin === 'carousel') add('origin.carousel', 130);
  if (c.origin === 'text') add('origin.text', -60);

  return { score: Math.round(score), rules };
}

export function scoreCandidate(c: MediaCandidate, hints: ElementHints = {}): number {
  return explainCandidate(c, hints).score;
}

/** Ranking-side only: worth highlighting. Not the pre-selection rule — that is
 *  `defaultSelection` in page_rank.ts, and it is deliberately far stricter. */
export function isInteresting(c: MediaCandidate): boolean {
  return c.score >= SCORE.INTERESTING;
}
