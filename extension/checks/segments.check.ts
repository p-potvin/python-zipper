/**
 * Stream-segment rejection checks.
 *
 * The failure this guards against is loud and specific: a livestream page fills
 * the list with hundreds of two-second `.ts` chunks classified as videos, none
 * of which can be downloaded on their own. Equally important is the other
 * direction — the sniffer's own segment test rejects `.jpg` and `.mp3`, so a
 * naive reuse of it would silently delete every image on the page.
 *
 *   npm run check
 */

import { kindFromMime, kindFromUrl, isRejectedExtension } from '../src/common/harvest';
import { stripDeliveryDirectives } from '../src/common/streams';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
}

// Mirrors isStreamSegment in media_log.ts, minus the tab lookup (exercised
// separately below by passing the manifest directories in directly).
function segmentTest(url: string, mime: string, manifests: string[] = []): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith('video/mp2t') || m.startsWith('video/iso.segment')
      || m === 'application/vnd.apple.mpegurl') return true;

  let path = '';
  let dir = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    dir = u.origin + path.slice(0, path.lastIndexOf('/') + 1);
  } catch { return false; }

  if (/\.(ts|m4s|cmfv|cmfa)(?:$|\?)/.test(path)) return true;
  if (/(^|[/_-])(seg|segment|chunk|frag|fragment|part)[_.-]?\d+\./.test(path)) return true;
  if (/(^|\/)init[_.-]?\d*\.(mp4|m4s)$/.test(path)) return true;

  for (const man of manifests) {
    const su = new URL(man);
    const sdir = su.origin + su.pathname.toLowerCase().slice(0, su.pathname.lastIndexOf('/') + 1);
    if (sdir && dir === sdir) return true;
  }
  return false;
}

console.log('\nsegments are rejected');
for (const [url, mime] of [
  ['https://cdn.example.com/live/abc/seg-1024.ts', 'video/mp2t'],
  ['https://cdn.example.com/live/abc/1024.ts', ''],
  ['https://cdn.example.com/live/abc/chunk_003.m4s', ''],
  ['https://cdn.example.com/live/abc/frag5.mp4', ''],
  ['https://cdn.example.com/live/abc/init.mp4', ''],
  ['https://cdn.example.com/live/abc/init-2.m4s', ''],
  ['https://cdn.example.com/x/opaque', 'video/mp2t'],
  ['https://cdn.example.com/live/abc/segment-7.aac', ''],
] as [string, string][]) {
  ok(`reject ${url.split('/').pop()}`, segmentTest(url, mime), url);
}

console.log('\nreal media is kept');
for (const [url, mime] of [
  ['https://cdn.example.com/media/photo.jpg', 'image/jpeg'],
  ['https://cdn.example.com/media/photo-2.png', 'image/png'],
  ['https://cdn.example.com/audio/track.mp3', 'audio/mpeg'],
  ['https://cdn.example.com/audio/song.m4a', 'audio/mp4'],
  ['https://cdn.example.com/video/movie.mp4', 'video/mp4'],
  // A numbered *file* is not a numbered fragment: the keyword has to be there.
  ['https://cdn.example.com/gallery/2024/0007.jpg', 'image/jpeg'],
  ['https://cdn.example.com/gallery/image_12.jpg', 'image/jpeg'],
  ['https://cdn.example.com/v/full-episode.mp4', 'video/mp4'],
] as [string, string][]) {
  ok(`keep ${url.split('/').pop()}`, !segmentTest(url, mime), url);
}

console.log('\nsiblings of a tracked manifest are segments whatever they are called');
{
  const manifest = 'https://cdn.example.com/hls/xyz/master.m3u8';
  ok('an opaque sibling is rejected',
    segmentTest('https://cdn.example.com/hls/xyz/00042', '', [manifest]));
  ok('a query-numbered sibling is rejected',
    segmentTest('https://cdn.example.com/hls/xyz/media?n=42', '', [manifest]));
  // ...but only its own directory. A photo elsewhere on the same CDN stays.
  ok('an unrelated directory is untouched',
    !segmentTest('https://cdn.example.com/images/pic.jpg', 'image/jpeg', [manifest]));
}

console.log('\na name is not evidence when the server has spoken');
{
  // Some hosts serve their media — and the segments of a stream — as .js, .css
  // or .woff with nothing else changed. The ingest gate used to reject on the
  // extension before the Content-Type was consulted, so a `video/mp4` served
  // as `player.js` was thrown away while the server sat there saying what it
  // was.
  //
  // Mirrors the gate in media_log.record: the blocklist applies only when the
  // MIME told us nothing.
  const admitted = (url: string, mime: string, manifests: string[] = []): boolean => {
    const byMime = kindFromMime(mime);
    const kind = byMime ?? kindFromUrl(url);
    if (!kind || kind === 'other') return false;
    if (!byMime && isRejectedExtension(url)) return false;
    if (kind === 'stream') return false;
    return !segmentTest(url, mime, manifests);
  };

  ok('an mp4 served as .js is admitted',
    admitted('https://cdn.example.com/assets/clip.js', 'video/mp4'));
  ok('a jpeg served as .woff2 is admitted',
    admitted('https://cdn.example.com/assets/photo.woff2', 'image/jpeg'));
  ok('a real script is still refused',
    !admitted('https://cdn.example.com/assets/app.js', 'application/javascript'));
  ok('a stylesheet is still refused',
    !admitted('https://cdn.example.com/assets/site.css', 'text/css'));
  ok('a real font is still refused',
    !admitted('https://cdn.example.com/assets/inter.woff2', 'font/woff2'));

  // The point is not to let disguised *segments* through with them.
  ok('a disguised segment is still rejected on its MIME',
    !admitted('https://cdn.example.com/live/abc/00042.js', 'video/mp2t'));
  ok('...and on its manifest directory when the MIME is unhelpful',
    !admitted('https://cdn.example.com/hls/xyz/00042.css', 'video/mp4',
      ['https://cdn.example.com/hls/xyz/master.m3u8']));
}

console.log('\na request for "part 0 of sequence 10176" is not the stream');
{
  // The chaturbate failure, exactly as reported: a recording that ran, retried
  // fifteen times against a sequence number frozen at capture time, and was
  // answered 403 about five minutes later — then the ffmpeg fallback got the
  // same URL and failed the same way.
  const ct = 'https://edge26-ash.live.mmcdn.com/v1/edge/streams/origin.x.01M2/chunklist_3_video_827_llhls.m3u8?sn=10176&_HLS_part=0';
  ok('the directives are gone',
    !stripDeliveryDirectives(ct).includes('_HLS_part'), stripDeliveryDirectives(ct));
  ok('...and the host companion with them',
    !stripDeliveryDirectives(ct).includes('sn='), stripDeliveryDirectives(ct));
  ok('the playlist itself is untouched',
    stripDeliveryDirectives(ct).startsWith(
      'https://edge26-ash.live.mmcdn.com/v1/edge/streams/origin.x.01M2/chunklist_3_video_827_llhls.m3u8'));

  const signed = 'https://cdn.example.com/live/chunklist.m3u8?token=abc123&expires=999&_HLS_msn=44&_HLS_part=1';
  const cleaned = stripDeliveryDirectives(signed);
  ok('a signature survives', cleaned.includes('token=abc123'), cleaned);
  ok('an expiry survives', cleaned.includes('expires=999'), cleaned);
  ok('the blocking hints do not', !/_HLS_/i.test(cleaned), cleaned);

  // Nothing is stripped without a directive present to justify it.
  const bare = 'https://cdn.example.com/live/master.m3u8?sn=5&token=z';
  ok('a bare sn is left alone', stripDeliveryDirectives(bare) === bare, stripDeliveryDirectives(bare));
  const plain = 'https://cdn.example.com/live/master.m3u8';
  ok('a URL with no query is returned as-is', stripDeliveryDirectives(plain) === plain);
  ok('rubbish does not throw', stripDeliveryDirectives('not a url?_HLS_part=0').length > 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
