/**
 * Thumbnail → original rewrites, as data.
 *
 * These rules used to be an if-chain buried in the media extractor, so adding a
 * host meant editing control flow. As a table, adding one is a line — and more
 * importantly the site-profile store can *append* to it: when a learned rewrite
 * returns 200 with a larger Content-Length than the thumbnail, that pattern is
 * proven and gets persisted per domain.
 *
 * Rules are tried in order; the first match wins. Every rule must be a pure
 * string rewrite — no network, no guessing. A rewrite that 404s costs a
 * download, so `learned` rules only ever come from a verified pair.
 */

export interface UpgradeRule {
  /** Matched against the full URL. */
  test: RegExp;
  /** Applied with String.replace when `test` matches. */
  from: RegExp;
  to: string;
  /** Where the rule came from — built-in, or learned from a verified upgrade. */
  source?: 'builtin' | 'learned';
  note?: string;
}

export const BUILTIN_RULES: UpgradeRule[] = [
  {
    test: /onlyfans\.com/i,
    from: /\/thumbs\//,
    to: '/files/',
    source: 'builtin',
    note: 'OnlyFans CDN serves originals under /files/',
  },
  {
    test: /(coomer|kemono)\.(su|party|st)/i,
    from: /\/(thumbnail|thumbnails)\//,
    to: '/',
    source: 'builtin',
    note: 'coomer/kemono thumbnails mirror the original path',
  },
  {
    test: /bunkr/i,
    from: /\/thumbs\//,
    to: '/images/',
    source: 'builtin',
  },
  {
    test: /redd\.it|redditmedia\.com/i,
    from: /^https?:\/\/preview\.redd\.it\//,
    to: 'https://i.redd.it/',
    source: 'builtin',
    note: 'preview.redd.it is a resized proxy of i.redd.it',
  },
  {
    test: /wp\.com|wordpress\.com/i,
    from: /[?&](w|h|resize|fit|quality)=[^&]*/g,
    to: '',
    source: 'builtin',
    note: 'Photon resizes via query params; dropping them yields the original',
  },
  {
    test: /\.media-amazon\.com/i,
    from: /\._[A-Z]{2}[0-9_,]+_\.(jpg|png|webp)$/i,
    to: '.$1',
    source: 'builtin',
    note: 'Amazon image sizing is encoded in the filename suffix',
  },
  // NOTE: there is deliberately no Imgur rule.
  //
  // Imgur encodes size as a trailing letter (b/m/t/l/h/s) on a 7-character id,
  // so `abcdefgs.jpg` could be a small variant of `abcdefg` — or a legitimate
  // 8-character id that happens to end in `s`. A regex cannot tell them apart,
  // and guessing wrong rewrites a valid URL into a 404. Since a bad rewrite
  // costs a download rather than just a thumbnail, this one has to be learned
  // from a verified pair like any other, not assumed.
];

/** Rules learned per domain at runtime, appended by the profile store. */
let learnedRules: UpgradeRule[] = [];

export function setLearnedRules(rules: UpgradeRule[]): void {
  learnedRules = rules;
}

export interface UpgradeResult {
  url: string;
  changed: boolean;
  rule?: UpgradeRule;
}

/**
 * Apply the first matching rule. Learned rules are tried first — they were
 * verified against this specific domain, so they beat a generic pattern.
 */
export function upgradeUrl(url: string): UpgradeResult {
  for (const rule of [...learnedRules, ...BUILTIN_RULES]) {
    if (!rule.test.test(url)) continue;
    const next = url.replace(rule.from, rule.to);
    if (next && next !== url) return { url: next, changed: true, rule };
  }
  return { url, changed: false };
}

/**
 * Derive a reusable rule from a verified thumbnail/original pair.
 *
 * Called by the profile store once a rewrite has been *proven* — the candidate
 * URL returned 200 and was larger than the thumbnail. Only emits a rule when
 * the difference is a single contiguous path segment, because anything more
 * clever than that generalises badly across a site.
 */
export function deriveRule(thumbUrl: string, fullUrl: string): UpgradeRule | null {
  try {
    const a = new URL(thumbUrl);
    const b = new URL(fullUrl);
    if (a.origin !== b.origin) return null;

    const segA = a.pathname.split('/').filter(Boolean);
    const segB = b.pathname.split('/').filter(Boolean);
    if (segA.length !== segB.length) return null;

    const diff = segA.map((s, i) => (s === segB[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length !== 1) return null;

    const i = diff[0];
    const host = a.hostname.replace(/^www\./, '');
    return {
      test: new RegExp(escapeRe(host), 'i'),
      from: new RegExp(`/${escapeRe(segA[i])}/`),
      to: `/${segB[i]}/`,
      source: 'learned',
      note: `learned on ${host}`,
    };
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
