/**
 * Gallery archive naming checks.
 *
 * The extension, the Pornpics userscript and the gallery rebuild in Python all
 * have to agree on `<model>__________<hash8>.zip` to the character: ColONEL-KFC
 * takes the identity from the name, and the hash is what makes the same photos
 * produce the same archive twice instead of two archives of one batch.
 * `wcZltlQX` is what the Python side produces for the digests of "a", "b", "c".
 *
 *   npm run check
 */

import {
  archiveName, batchHash, imageExt, memberName, normalizeModelName,
} from '../src/common/gallery_naming';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`);
}

(async () => {
  console.log('\nnames are lowercase alphanumerics');
  ok('dots and underscores go', normalizeModelName('Zoe.N_x') === 'zoenx');
  ok('an empty name stays empty', normalizeModelName('') === '');

  console.log('\nthe batch hash matches the Python rebuild');
  const enc = new TextEncoder();
  const digests = await Promise.all(['a', 'b', 'c'].map(async (x) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(x)))));
  const h = await batchHash(digests);
  ok('same digests, same hash', h === 'wcZltlQX', `got ${h}`);
  ok('no digests is all zeros', (await batchHash([])) === '00000000');

  console.log('\narchive and member names');
  ok('ten underscores', archiveName('ada', 'wcZltlQX') === 'ada__________wcZltlQX.zip');
  ok('three-digit index', memberName('ada', 7, 'jpg') === 'ada_007.jpg');
  ok('signed CDN URL keeps its extension', imageExt('https://cdn2.onlyfans.com/x/abc.jpeg?Policy=x&Signature=y') === 'jpeg');
  ok('an unknown extension becomes jpg', imageExt('https://x/y.php?id=1') === 'jpg');

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
})();
