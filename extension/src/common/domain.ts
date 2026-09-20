/**
 * Registrable-domain extraction.
 *
 * This is the attribution primitive the site-profile store keys on. Two rules
 * that matter more than they look:
 *
 *  1. Profiles key on the **top-level page's** registrable domain, taken from
 *     the tab's own URL — never from a media URL. Viewing example.com while
 *     images arrive from cdn.example.net and a player calls videodelivery.net
 *     must produce one profile for example.com, not three junk ones.
 *
 *  2. Connection/rate-limit policy keys on the **asset host** instead, because
 *     a 429 belongs to whoever served the bytes. Different question, different
 *     key — see `assetHost` below.
 *
 * A full Public Suffix List is overkill here; this covers the multi-part
 * suffixes that actually show up and degrades to "last two labels" otherwise.
 * A wrong split only ever means a slightly over- or under-merged profile, which
 * costs one extra scan — never a misrouted download.
 */

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.mx', 'com.ar', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'com.my',
  'com.pl', 'com.ua', 'com.ru', 'co.za', 'co.il', 'co.id', 'co.th',
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'blogspot.com', 'wordpress.com',
]);

/** Hostname of a URL, lowercased, or '' if it isn't parseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The registrable domain for a hostname — `example.co.uk` from
 * `img.cdn.example.co.uk`. Returns '' for IPs, localhost, and junk.
 */
export function registrableDomain(hostname: string): string {
  if (!hostname) return '';
  const host = hostname.toLowerCase().replace(/\.$/, '');

  // IPv4/IPv6 and single-label hosts have no registrable domain worth keying on.
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.length < 2) return '';

  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * The profile key for a page. Pass the **tab's** URL, not a media URL.
 * Non-http pages (about:, moz-extension:, file:) return '' — they get no profile.
 */
export function profileKey(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return registrableDomain(u.hostname);
  } catch {
    return '';
  }
}

/**
 * The connection-policy key for a media URL — the host that actually served it.
 * Deliberately *not* the registrable domain: rate limits are enforced per host,
 * and `img1.cdn.example.com` may throttle independently of `img2.cdn.example.com`.
 */
export function assetHost(mediaUrl: string): string {
  return hostOf(mediaUrl);
}

/** Display form for the context strip — drops a leading `www.`. */
export function displayDomain(pageUrl: string): string {
  const host = hostOf(pageUrl);
  if (!host) return '';
  return host.replace(/^www\./, '');
}
