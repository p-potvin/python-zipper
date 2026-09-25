/**
 * Ranking checks — a fixture corpus, run as pure logic.
 *
 * Tuning weights by eye across a dozen sites does not converge: a change that
 * fixes today's site quietly breaks last week's, and a manual pass never
 * notices. These are synthetic pages shaped like the real failure modes, with
 * the judgement asserted rather than eyeballed — "no avatar in the top ten" is
 * a claim that survives a refactor and runs in a second.
 *
 * No test runner on purpose; this is the same pure-logic pattern used
 * elsewhere in the repo. Bundle it and run it:
 *
 *   npm run check
 *
 * When a check fails, the fix is usually a weight in scoring.ts or page_rank.ts
 * — but read the breakdown it prints before reaching for one.
 */

import {
  type MediaCandidate, type MediaKind, makeCandidate, dimensionsFromUrl,
} from '../src/common/harvest';
import { explainCandidate, SCORE } from '../src/common/scoring';
import { applyPageContext, findClusters, defaultSelection } from '../src/common/page_rank';

const PAGE_URL = 'https://example.com/post/12345';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`);
}

function group(name: string, fn: () => void): void {
  console.log('\n' + name);
  fn();
}

// ---- fixture helpers --------------------------------------------------------

interface Spec {
  url: string;
  kind?: MediaKind;
  w?: number;
  h?: number;
  bytes?: number;
  origin?: 'dom' | 'network' | 'carousel' | 'meta' | 'text';
  domHits?: number;
  container?: string;
  ancestry?: string;
}

/** Build a page the way the background sees it: scored, then page-ranked. */
function page(specs: Spec[]): MediaCandidate[] {
  const all = specs.map((s) => {
    const c = makeCandidate(s.url, s.kind ?? 'image', s.origin ?? 'dom', PAGE_URL, {
      width: s.w, height: s.h, bytes: s.bytes, domHits: s.domHits, container: s.container,
    });
    const scored = explainCandidate(c, { ancestry: s.ancestry, rendered: true });
    c.score = scored.score;
    c.reasons = scored.rules;
    return c;
  });
  applyPageContext(all);
  return all.sort((a, b) => b.score - a.score);
}

function survives(all: MediaCandidate[]): MediaCandidate[] {
  return all.filter((c) => c.score >= SCORE.FLOOR);
}

function find(all: MediaCandidate[], needle: string): MediaCandidate {
  const c = all.find((x) => x.url.includes(needle));
  if (!c) throw new Error('fixture has no candidate matching ' + needle);
  return c;
}

function rankOf(all: MediaCandidate[], needle: string): number {
  return all.findIndex((x) => x.url.includes(needle));
}

function why(c: MediaCandidate): string {
  return `${c.score} = ${(c.reasons ?? []).map(([r, d]) => `${r}${d > 0 ? '+' : ''}${d}`).join(' ')}`;
}

/** A feed: one big post image, a column of distinct avatars, some furniture. */
function feedPage(): MediaCandidate[] {
  const specs: Spec[] = [
    { url: 'https://cdn.example.com/media/2024/03/post-hero.jpg', w: 1600, h: 1200, bytes: 900_000, ancestry: 'post content' },
  ];
  for (let i = 0; i < 12; i++) {
    specs.push({
      url: `https://cdn.example.com/avatars/u${i}.jpg`,
      w: 150, h: 150, bytes: 8_000, ancestry: 'sidebar widget',
    });
  }
  specs.push({ url: 'https://cdn.example.com/static/logo.png', w: 200, h: 60, bytes: 4_000 });
  specs.push({ url: 'https://cdn.example.com/static/spinner.gif', w: 32, h: 32, bytes: 900 });
  return page(specs);
}

/** A gallery: 20 same-sized thumbnails in one grid, plus one full-size hero. */
function gridPage(): MediaCandidate[] {
  const specs: Spec[] = [
    { url: 'https://cdn.example.com/full/hero-original.jpg', w: 3000, h: 2000, bytes: 4_200_000, ancestry: 'post media' },
  ];
  for (let i = 0; i < 20; i++) {
    specs.push({
      url: `https://cdn.example.com/gallery/2024/item-${i}.jpg`,
      w: 500, h: 500, bytes: 120_000,
      container: 'a.cell>div.grid>section.gallery',
      ancestry: 'gallery',
    });
  }
  return page(specs);
}

// ---- checks -----------------------------------------------------------------

group('avatars are never content', () => {
  const all = feedPage();
  // Against the list the user actually sees — the floor has been applied.
  const top10 = survives(all).slice(0, 10);
  ok('no avatar in the top 10',
    !top10.some((c) => c.url.includes('/avatars/')),
    top10.slice(0, 3).map((c) => c.url).join('\n        '));

  const avatar = find(all, 'avatars/u0');
  ok('an avatar does not clear the floor', avatar.score < SCORE.FLOOR, why(avatar));

  ok('an avatar is never pre-selected',
    !defaultSelection(all).has(avatar.url));
});

group('the largest thing on the page wins', () => {
  const all = feedPage();
  ok('the post image ranks first', rankOf(all, 'post-hero') === 0, why(all[0]));
  ok('the post image is pre-selected', defaultSelection(all).has(find(all, 'post-hero').url));

  // "Especially videos": a video that exposes neither dimensions nor a
  // Content-Length must not lose to a large JPEG just for being unmeasurable.
  const withVideo = page([
    { url: 'https://cdn.example.com/media/photo-big.jpg', w: 4000, h: 3000, bytes: 6_000_000, ancestry: 'post' },
    { url: 'https://cdn.example.com/media/clip.mp4', kind: 'video', origin: 'network', ancestry: 'post' },
  ]);
  ok('an unmeasurable video is still pre-selected',
    defaultSelection(withVideo).has(find(withVideo, 'clip.mp4').url),
    why(find(withVideo, 'clip.mp4')));
});

group('grids are an ensemble, and rank without displacing the largest', () => {
  const all = gridPage();
  const clusters = findClusters(all);
  ok('the grid is detected as one cluster',
    clusters.some((c) => c.members.length >= 20),
    clusters.map((c) => `${c.id} ×${c.members.length}`).join('\n        '));

  const member = find(all, 'item-7');
  ok('a grid member is credited',
    (member.reasons ?? []).some(([r]) => r.startsWith('page.cluster')), why(member));
  ok('a grid member clears the floor', member.score >= SCORE.FLOOR, why(member));

  ok('the hero still outranks the grid',
    rankOf(all, 'hero-original') === 0, why(all[0]));

  const sel = defaultSelection(all);
  ok('the whole grid is pre-selected', sel.size >= 20, `selected ${sel.size}`);
  ok('the hero is pre-selected too', sel.has(find(all, 'hero-original').url));

  // The bare case: square cells, no helpful container class, no alt text, no
  // content-zone ancestry to lean on. A square-thumbnail gallery is an
  // extremely ordinary layout and must not be filtered out by the avatar-shape
  // rule for having the shape of its own cells.
  const bare = page(Array.from({ length: 15 }, (_, i) => ({
    url: `https://cdn.example.com/i/${i}.jpg`, w: 480, h: 480, bytes: 90_000,
  })));
  const cell = find(bare, '/i/7.jpg');
  ok('a bare square grid survives the avatar-shape rule',
    cell.score >= SCORE.FLOOR, why(cell));
  ok('a bare square grid is pre-selected',
    defaultSelection(bare).has(cell.url), why(cell));
});

group('a livestream is never pre-selected', () => {
  // The page a livestream site actually shows: the stream, and nothing else
  // that is a video. Before the guard, "the biggest video on the page" picked
  // the manifest and ticked something no download button could act on.
  const all = page([
    { url: 'https://cdn.example.com/hls/master.m3u8', kind: 'stream', origin: 'network' },
    { url: 'https://cdn.example.com/img/poster.jpg', w: 1280, h: 720, bytes: 300_000 },
  ]);
  const stream = find(all, 'master.m3u8');
  ok('the stream is not ticked', !defaultSelection(all).has(stream.url), why(stream));
});

group('pre-selection is stricter than ranking', () => {
  const all = feedPage();
  const byThreshold = survives(all).filter((c) => c.score >= SCORE.INTERESTING);
  const sel = defaultSelection(all);
  ok('fewer items are ticked than merely rank well',
    sel.size <= byThreshold.length,
    `ticked ${sel.size}, above INTERESTING ${byThreshold.length}`);
  ok('a feed does not arrive with most of the list ticked',
    sel.size <= Math.max(3, survives(all).length / 2),
    `ticked ${sel.size} of ${survives(all).length}`);
});

group('/users/ and cover are content paths again', () => {
  const all = page([
    { url: 'https://cdn.example.com/users/alice/posts/sunset.jpg', w: 2400, h: 1600, bytes: 1_800_000, ancestry: 'post' },
    { url: 'https://cdn.example.com/wallpapers/cover-4k.jpg', w: 3840, h: 2160, bytes: 5_500_000, ancestry: 'gallery' },
    { url: 'https://cdn.example.com/u/cover_photo.jpg', w: 1500, h: 500, bytes: 200_000 },
  ]);
  const userPost = find(all, 'users/alice');
  ok('a post under /users/ survives', userPost.score >= SCORE.INTERESTING, why(userPost));

  const wallpaper = find(all, 'cover-4k');
  ok('a wallpaper named cover survives', wallpaper.score >= SCORE.INTERESTING, why(wallpaper));

  const banner = find(all, 'cover_photo');
  ok('an actual cover_photo is still buried', banner.score < SCORE.FLOOR, why(banner));
});

group('the floor is applied once, after everything is known', () => {
  // A network sighting with no dimensions and a name that looks like chrome.
  // It must survive ingest so the DOM pass can hand it real dimensions.
  const raw = makeCandidate(
    'https://cdn.example.com/users/bob/cover/full.jpg', 'image', 'network', PAGE_URL, { bytes: 3_000_000 });
  raw.score = explainCandidate(raw).score;
  ok('an unmeasured network sighting is above the floor at ingest',
    raw.score >= SCORE.FLOOR, why(raw));
});

group('the page pass is idempotent', () => {
  const all = gridPage();
  const before = all.map((c) => c.score);
  applyPageContext(all);
  applyPageContext(all);
  ok('re-running does not compound its own bonuses',
    all.every((c, i) => c.score === before[i]),
    all.filter((c, i) => c.score !== before[i]).slice(0, 3).map(why).join('\n        '));
});

// ---- facts the URL states about itself --------------------------------------

group('a URL that states its size is believed', () => {
  ok('a sized directory segment is read',
    dimensionsFromUrl('https://cdn5.example.com/images/models/samples-640x480/4732306.jpg').width === 640);
  ok('...and its height with it',
    dimensionsFromUrl('https://cdn5.example.com/images/models/samples-640x480/4732306.jpg').height === 480);
  ok('a filename suffix is read',
    dimensionsFromUrl('https://cdn.example.com/p/photo_1920x1080.jpg').height === 1080);
  ok('the unicode multiplication sign counts too',
    dimensionsFromUrl('https://cdn.example.com/p/photo_800×600.jpg').width === 800);
  ok('resize params are read when there is no WxH token',
    dimensionsFromUrl('https://cdn.example.com/img.jpg?w=1600&h=900').width === 1600);

  ok('an id with an x in it is not a resolution',
    dimensionsFromUrl('https://cdn.example.com/a1x2/file.jpg').width === undefined);
  ok('an implausibly large pair is refused',
    dimensionsFromUrl('https://cdn.example.com/99999x88888/file.jpg').width === undefined);

  const c = makeCandidate(
    'https://cdn5.example.com/images/models/samples-640x480/4732306.jpg',
    'image', 'dom', PAGE_URL);
  ok('a candidate with nothing measured takes the URL at its word', c.width === 640, String(c.width));

  const measured = makeCandidate(
    'https://cdn5.example.com/images/models/samples-640x480/4732306.jpg',
    'image', 'dom', PAGE_URL, { width: 1280, height: 960 });
  ok('a measured element still wins over the path', measured.width === 1280, String(measured.width));
});

group('the absence of evidence is not evidence', () => {
  const unknown = makeCandidate('https://cdn.example.com/media/photo.jpg', 'image', 'dom', PAGE_URL);
  const scored = explainCandidate(unknown);
  ok('an unmeasurable image does not clear INTERESTING on its own',
    scored.score < SCORE.INTERESTING, `${scored.score}`);
  ok('...but stays well above the floor, so it is still listed',
    scored.score >= SCORE.FLOOR, `${scored.score}`);

  const stream = makeCandidate('https://cdn.example.com/live/master.m3u8', 'stream', 'network', PAGE_URL);
  ok('a stream is exempt — a manifest has no size by nature',
    !explainCandidate(stream).rules.some(([r]) => r === 'facts.unknown'));
});

group('a grid nobody can measure is not pre-selected', () => {
  // The reported page: 343 images, 199 of them ticked, none above 640px or
  // 40KB. Every member is a sibling in one container and nothing is known
  // about any of them.
  const specs: Spec[] = [];
  for (let i = 0; i < 40; i++) {
    specs.push({
      url: `https://cdn.example.com/images/models/samples/${1000 + i}.jpg`,
      container: 'a.cell>div.grid>section.list',
      ancestry: 'list',
    });
  }
  const all = page(specs);
  const picked = defaultSelection(all);
  ok('nothing is ticked when nothing can be judged', picked.size === 0, `${picked.size} ticked`);
  ok('...and they are all still listed', survives(all).length === 40, `${survives(all).length}`);
});

group('a grid that can be measured still pre-selects', () => {
  const all = gridPage();
  const picked = defaultSelection(all);
  ok('a real gallery is still ticked', picked.size > 10, `${picked.size} ticked`);
});

// ---- report -----------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
