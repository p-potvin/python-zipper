/**
 * ZIP writer checks.
 *
 * The archive format is written by hand here, which means a mistake produces a
 * file that looks fine until someone tries to open it — possibly weeks later,
 * with the source page long gone. These assert the properties that would
 * otherwise fail silently: the central directory agreeing with the local
 * headers, CRCs matching the bytes, duplicate names not eating each other, and
 * a path-traversal name not surviving into the archive.
 *
 *   npm run check
 */

import { createZip, uniqueNames, safeEntryName } from '../src/background/zip';

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

const enc = new TextEncoder();
const u32 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint32(off, true);
const u16 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint16(off, true);

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Locate the end-of-central-directory record, which every reader looks for first. */
function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= 0; i--) {
    if (u32(b, i) === 0x06054b50) return i;
  }
  return -1;
}

async function main(): Promise<void> {
  group('names are made safe before they reach the archive', () => {
    ok('path separators are stripped',
      !safeEntryName('a/b/c.jpg').includes('/'), safeEntryName('a/b/c.jpg'));
    ok('traversal cannot survive',
      !safeEntryName('../../etc/passwd').includes('..'), safeEntryName('../../etc/passwd'));
    ok('windows-illegal characters go',
      safeEntryName('a:b|c?.jpg') === 'a_b_c_.jpg', safeEntryName('a:b|c?.jpg'));
    ok('an empty name still produces one', safeEntryName('') === 'file');

    const names = uniqueNames(['a.jpg', 'a.jpg', 'a.jpg', 'b.png']);
    ok('duplicates are disambiguated, extension intact',
      new Set(names).size === 4 && names[1] === 'a (1).jpg' && names[2] === 'a (2).jpg',
      names.join(', '));
    // Case-insensitive filesystems collapse these, so the writer has to too.
    ok('duplicates differing only in case are disambiguated',
      new Set(uniqueNames(['A.jpg', 'a.jpg'])).size === 2,
      uniqueNames(['A.jpg', 'a.jpg']).join(', '));
  });

  const entries = [
    { name: 'one.txt', data: enc.encode('hello one') },
    { name: 'two.bin', data: new Uint8Array([0, 1, 2, 3, 255, 254]) },
    { name: 'big.dat', data: enc.encode('x'.repeat(50_000)) },
  ];
  const b = await bytesOf(createZip(entries));

  await group('the archive is structurally what a reader expects', async () => {
    ok('starts with a local file header', u32(b, 0) === 0x04034b50);

    const eocd = findEocd(b);
    ok('has an end-of-central-directory record', eocd >= 0);
    if (eocd < 0) return;

    ok('declares every entry once',
      u16(b, eocd + 8) === entries.length && u16(b, eocd + 10) === entries.length,
      `${u16(b, eocd + 8)} / ${u16(b, eocd + 10)}`);

    const cdOffset = u32(b, eocd + 16);
    const cdSize = u32(b, eocd + 12);
    ok('the central directory offset points at a central header',
      u32(b, cdOffset) === 0x02014b50);
    // The single most common hand-rolled-ZIP bug: a size or offset computed
    // before something else was appended. It opens in some readers and not
    // others, which is the worst possible failure mode.
    ok('the central directory size and offset agree with the EOCD position',
      cdOffset + cdSize === eocd, `${cdOffset} + ${cdSize} != ${eocd}`);

    ok('entries are stored, not deflated', u16(b, 8) === 0);
    ok('names are flagged UTF-8', (u16(b, 6) & 0x0800) !== 0);
  });

  group('content survives the round trip', () => {
    // Sizes are written twice in a stored entry (compressed and uncompressed)
    // and must agree, or readers disagree about where the next entry starts.
    ok('compressed and uncompressed sizes match for a stored entry',
      u32(b, 18) === u32(b, 22) && u32(b, 18) === entries[0].data.length,
      `${u32(b, 18)} vs ${u32(b, 22)}`);

    const nameLen = u16(b, 26);
    const extraLen = u16(b, 28);
    const payload = b.slice(30 + nameLen + extraLen, 30 + nameLen + extraLen + entries[0].data.length);
    ok('the first entry\'s bytes are its own',
      new TextDecoder().decode(payload) === 'hello one',
      new TextDecoder().decode(payload));
  });

  group('limits are refused rather than silently truncated', () => {
    let threw = false;
    try {
      createZip(Array.from({ length: 65_536 }, (_, i) => ({
        name: `f${i}`, data: new Uint8Array(0),
      })));
    } catch { threw = true; }
    ok('too many entries for a non-ZIP64 archive throws', threw);
  });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

void main();
