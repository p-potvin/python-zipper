/**
 * Page-relative ranking: the pass that can only run once the whole page is in.
 *
 * `scoring.ts` sees one candidate at a time, so every rule in it is an absolute
 * threshold. That is why it discriminates on some pages and not others: where
 * everything is 800KB the byte tiers separate nothing, and on a thumbnail-only
 * page everything is punished equally. This pass ranks the page against itself,
 * which works whatever the page's absolute numbers happen to be.
 *
 * Two signals, both of which the operator named as how they actually judge a
 * page:
 *
 *   1. **The largest thing on the page is usually the post.** Especially video.
 *      Awarded on percentile, not on a fixed pixel count.
 *   2. **An ensemble is content.** Columns and rows of same-sized thumbnails
 *      under a shared path are a gallery, and a gallery is the point of the
 *      page. Crucially this is credited *without* displacing the largest
 *      element — a grid page usually has both, and both should rank.
 *
 * Note the asymmetry with the repetition penalty in `scoring.ts`: that punishes
 * one URL appearing thirty times (chrome), this credits thirty *different* URLs
 * of the same shape under one path (a gallery). Same page, opposite meaning.
 *
 * Runs in the background after the merge, so it sees DOM candidates, network
 * candidates and every frame at once — which is the only point at which "the
 * largest on the page" is a knowable fact.
 */

import type { MediaCandidate, ScoreRule } from './harvest';
import { SCORE } from './scoring';

export const PAGE = {
  /** Fewer than this is a coincidence, not an ensemble. */
  MIN_CLUSTER: 3,
  /** Below this many measurable candidates a percentile means nothing. */
  MIN_SAMPLE: 8,
  /** Cluster members must be within this factor of the cluster's median size. */
  SIZE_TOLERANCE: 2.5,
  /** Never pre-tick more than this, however big the gallery. */
  MAX_PRESELECT: 200,
};

/** Rules this pass adds. Prefixed so they can be stripped and recomputed. */
const PAGE_RULE = /^page\./;

// ---- signatures -------------------------------------------------------------

/**
 * The directory a candidate lives in, generalised.
 *
 * Digit runs and hash-looking segments collapse, so `/media/2024/03/a1b2/x.jpg`
 * and `/media/2024/03/c3d4/y.jpg` share a signature. Sharding by hash is the
 * normal way a CDN lays a gallery out, and without this every item in that
 * gallery would look unrelated to every other.
 */
export function pathSignature(c: MediaCandidate): string {
  try {
    const u = new URL(c.url);
    const segs = u.pathname.split('/').filter(Boolean);
    segs.pop(); // the filename itself is the part that must differ
    const dir = segs
      .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) ? '#' : s))
      .join('/');
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    return `${u.host}/${dir}|${ext.length <= 5 ? ext : ''}`;
  } catch {
    return c.url;
  }
}

/**
 * A single comparable "how big is it" number.
 *
 * Area where the DOM measured it, bytes otherwise. The two are never compared
 * against each other — each ranking below is built from one or the other — but
 * a candidate needs one of them to take part at all. A video with neither (no
 * intrinsic size before play, no Content-Length on a streamed response) simply
 * sits out rather than being ranked last, which is the bug that made real
 * videos lose to large JPEGs.
 */
function area(c: MediaCandidate): number | undefined {
  const a = (c.width ?? 0) * (c.height ?? 0);
  return a > 0 ? a : undefined;
}

function magnitude(c: MediaCandidate): number | undefined {
  return area(c) ?? (c.bytes && c.bytes > 0 ? c.bytes : undefined);
}

// ---- clustering -------------------------------------------------------------

export interface Cluster {
  id: string;
  members: MediaCandidate[];
  /** Median magnitude of the members that had one. */
  median: number;
}

function groupBy(
  all: MediaCandidate[],
  key: (c: MediaCandidate) => string | undefined,
): Map<string, MediaCandidate[]> {
  const groups = new Map<string, MediaCandidate[]>();
  for (const c of all) {
    const k = key(c);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(c); else groups.set(k, [c]);
  }
  return groups;
}

/**
 * Trim a group to the members that are actually the same size as each other.
 *
 * One directory routinely holds both a gallery and that gallery's own
 * thumbnails; those are two ensembles, not one, and lumping them together would
 * hand the thumbnails the full-size images' credit. A member whose size is
 * simply unknown stays in — sharing a container or a directory with twenty
 * siblings is already decent evidence, and dropping it would penalise exactly
 * the network-only candidates the merge exists to rescue.
 */
function tighten(id: string, members: MediaCandidate[]): Cluster | null {
  if (members.length < PAGE.MIN_CLUSTER) return null;
  const sizes = members
    .map(magnitude)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  if (!sizes.length) return { id, members, median: 0 };

  const median = sizes[Math.floor(sizes.length / 2)];
  const kept = members.filter((c) => {
    const m = magnitude(c);
    if (m === undefined) return true;
    return m >= median / PAGE.SIZE_TOLERANCE && m <= median * PAGE.SIZE_TOLERANCE;
  });
  return kept.length >= PAGE.MIN_CLUSTER ? { id, members: kept, median } : null;
}

/**
 * Group candidates into ensembles.
 *
 * Two independent keyings, because neither alone covers the sites in use:
 *
 *   - **Path signature.** The one signal both the DOM pass and the network log
 *     can supply, and the only one available for a candidate that was never an
 *     element on the page.
 *   - **Container signature.** Catches the gallery whose assets are sharded
 *     across hashed directories, where no two members share a path at all, but
 *     every one of them is a cell in the same grid.
 *
 * Clusters are then assigned greedily largest-first so they come out disjoint:
 * a candidate belongs to the biggest ensemble it is a member of, and is
 * credited for it exactly once.
 */
export function findClusters(all: MediaCandidate[]): Cluster[] {
  const found: Cluster[] = [];
  for (const [id, members] of groupBy(all, pathSignature)) {
    const cl = tighten(id, members);
    if (cl) found.push(cl);
  }
  for (const [id, members] of groupBy(all, (c) => (c.container ? 'dom:' + c.container : undefined))) {
    const cl = tighten(id, members);
    if (cl) found.push(cl);
  }

  found.sort((a, b) => b.members.length - a.members.length);

  const taken = new Set<MediaCandidate>();
  const out: Cluster[] = [];
  for (const cl of found) {
    const members = cl.members.filter((c) => !taken.has(c));
    if (members.length < PAGE.MIN_CLUSTER) continue;
    for (const c of members) taken.add(c);
    out.push({ ...cl, members });
  }
  return out;
}

// ---- the pass ---------------------------------------------------------------

/**
 * Percentile rank of every measured value, by candidate identity.
 *
 * Ties take the midpoint of their own block rather than consecutive positions,
 * which matters far more here than it looks. A gallery page is twenty
 * identically-sized thumbnails and one hero: ranked naively, those twenty
 * spread across the whole scale, so the ones that happened to sort first were
 * punished as the page's smallest and the ones that sorted last were rewarded
 * as its largest — the same asset, a 240-point swing, decided by array order.
 * Sharing the midpoint says the honest thing instead: every one of them is
 * typical for this page, and neither big nor small for it.
 *
 * It also makes the pass deterministic, which is what lets it be idempotent.
 */
function percentiles(
  all: MediaCandidate[],
  of: (c: MediaCandidate) => number | undefined,
): Map<MediaCandidate, number> {
  const measured = all.filter((c) => of(c) !== undefined);
  const out = new Map<MediaCandidate, number>();
  const n = measured.length;
  if (n < PAGE.MIN_SAMPLE) return out;

  const sorted = [...measured].sort((a, b) => (of(a) as number) - (of(b) as number));
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && of(sorted[j + 1]) === of(sorted[i])) j++;
    const p = ((i + j) / 2) / (n - 1);
    for (let k = i; k <= j; k++) out.set(sorted[k], p);
    i = j + 1;
  }
  return out;
}

/**
 * Apply every page-relative rule, in place.
 *
 * Idempotent: previously-added `page.*` rules are stripped and their
 * contribution refunded before anything new is added, so re-running on a
 * growing list (a deep scan reports in waves) can't compound its own bonuses.
 */
export function applyPageContext(all: MediaCandidate[]): MediaCandidate[] {
  // --- refund any earlier run ---
  for (const c of all) {
    if (!c.reasons?.length) continue;
    let refund = 0;
    const base: ScoreRule[] = [];
    for (const r of c.reasons) {
      if (PAGE_RULE.test(r[0])) refund += r[1];
      else base.push(r);
    }
    if (refund) c.score -= refund;
    c.reasons = base;
    c.cluster = undefined;
  }

  const add = (c: MediaCandidate, rule: string, delta: number) => {
    if (!delta) return;
    c.score += delta;
    (c.reasons ??= []).push([rule, delta]);
  };

  // --- 1. size relative to this page, not to a fixed tier ------------------
  const byArea = percentiles(all, area);
  for (const [c, p] of byArea) {
    if (p >= 0.9) add(c, 'page.area.p90', 140);
    else if (p >= 0.7) add(c, 'page.area.p70', 70);
    else if (p <= 0.2) add(c, 'page.area.p20', -100);
  }

  const byBytes = percentiles(all, (c) => (c.bytes && c.bytes > 0 ? c.bytes : undefined));
  for (const [c, p] of byBytes) {
    if (p >= 0.9) add(c, 'page.bytes.p90', 120);
    else if (p >= 0.7) add(c, 'page.bytes.p70', 60);
    else if (p <= 0.2) add(c, 'page.bytes.p20', -80);
  }

  // --- 2. the largest thing on the page ------------------------------------
  //
  // "A good post is almost always the largest of the page." Awarded outright
  // rather than through the percentile tiers, because on a page of near-
  // identical thumbnails the top percentile holds dozens of items and the one
  // genuinely biggest asset still needs to win.
  //
  // Video gets its own award rather than competing with images for the single
  // slot: a real video routinely exposes neither intrinsic dimensions nor a
  // Content-Length, so it loses a page-wide size contest to any large JPEG.
  const biggest = leader(all, (c) => c.score >= SCORE.FLOOR);
  if (biggest) add(biggest, 'page.largest', 200);

  const biggestVideo = leader(all, (c) => c.kind === 'video' || c.kind === 'stream');
  if (biggestVideo && biggestVideo !== biggest) add(biggestVideo, 'page.largest.video', 200);

  // --- 3. ensembles ---------------------------------------------------------
  //
  // Deliberately additive with the rule above rather than competing with it: a
  // grid page normally has both a hero and a grid, and the operator wants both.
  const clusters = findClusters(all);
  for (const cl of clusters) {
    const n = cl.members.length;
    const bonus = n >= 12 ? 300 : n >= 6 ? 220 : 140;
    for (const c of cl.members) {
      c.cluster = { id: cl.id, size: n };
      add(c, `page.cluster.${n >= 12 ? 12 : n >= 6 ? 6 : 3}`, bonus);

      // A square, smallish image on its own is probably an avatar, which is
      // what `shape.avatar` is for. One of twenty *distinct* siblings in the
      // same grid is not one: avatars repeat a single image down a feed,
      // gallery cells are all different from each other. Membership here is
      // direct evidence against that rule, so refund exactly what it took —
      // otherwise a square-thumbnail gallery, which is a very ordinary layout,
      // is penalised for the shape of its own cells.
      //
      // A grid of genuine avatars is not rescued by this: it still carries
      // url.avatar and url.derivative, which are far larger than the refund.
      const shape = (c.reasons ?? []).find(([r]) => r === 'shape.avatar');
      if (shape) add(c, 'page.cluster.not-avatar', -shape[1]);
    }
  }

  return all;
}

/**
 * The single biggest candidate matching a predicate.
 *
 * Area decides where it is known, because it measures the asset; bytes decide
 * between candidates that have no dimensions, because bytes also encode
 * compression and the two are not comparable. Where nothing in the set is
 * measurable at all, score decides — without that last step a lone video with
 * no intrinsic size and no Content-Length is not merely ranked last, it is not
 * returned at all, and "the biggest video on the page" silently becomes "no
 * video on the page".
 */
function leader(
  all: MediaCandidate[],
  where: (c: MediaCandidate) => boolean,
): MediaCandidate | undefined {
  const matching = all.filter(where);
  if (!matching.length) return undefined;

  const best = (
    of: (c: MediaCandidate) => number | undefined,
  ): MediaCandidate | undefined => {
    let win: MediaCandidate | undefined;
    let top = 0;
    for (const c of matching) {
      const v = of(c) ?? 0;
      if (v > top) { top = v; win = c; }
    }
    return win;
  };

  return best(area)
    ?? best((c) => (c.bytes && c.bytes > 0 ? c.bytes : undefined))
    ?? matching.reduce((a, b) => (b.score > a.score ? b : a));
}

// ---- pre-selection ----------------------------------------------------------

/**
 * What to tick by default.
 *
 * Split from ranking on purpose. They used to be the same number, and the
 * result was that a scan pre-ticked most of the list and the first action on
 * every page was to clear it — a pre-selection you always undo is worse than
 * none. Ranking can be generous because a wrong guess just costs a scroll;
 * selection has to be conservative because a wrong guess costs a download.
 *
 * So this is a *rule*, not a threshold: the biggest thing on the page, and the
 * ensembles — nothing else, however high it ranked.
 */
export function defaultSelection(all: MediaCandidate[]): Set<string> {
  const pick = new Set<string>();
  // Streams are excluded outright. A manifest is not a file to bundle — it is
  // recorded over time — and the "biggest video" rule below would otherwise
  // tick it on exactly the pages where it is the only video, leaving a ticked
  // item the download buttons then have to skip.
  const eligible = all.filter((c) => c.score >= SCORE.FLOOR && c.kind !== 'stream');
  if (!eligible.length) return pick;

  // The biggest thing on the page, and the biggest video if that isn't it.
  const biggest = leader(eligible, () => true);
  if (biggest) pick.add(biggest.url);
  const biggestVideo = leader(eligible, (c) => c.kind === 'video' || c.kind === 'stream');
  if (biggestVideo) pick.add(biggestVideo.url);

  // Every ensemble that looks like content. The median gate is what keeps a
  // grid of interface furniture out: a real gallery's members clear
  // INTERESTING on their own merits, an icon set's members never do.
  for (const cl of findClusters(eligible)) {
    const scores = cl.members.map((c) => c.score).sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)];
    if (median < SCORE.INTERESTING) continue;
    for (const c of cl.members) {
      if (pick.size >= PAGE.MAX_PRESELECT) break;
      if (c.score >= SCORE.FLOOR) pick.add(c.url);
    }
  }

  return pick;
}
