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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
