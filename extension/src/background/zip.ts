/**
 * A ZIP writer, in the background.
 *
 * Until now the only way to get an archive was to hand the selection to the
 * python server, which means an archive is only available when the server is
 * up, on the machine the server runs on, in the server's own download folder.
 * For a browser download of forty images that is the wrong shape entirely — the
 * files were going to the browser anyway, and the only thing missing was the
 * container.
 *
 * Stored, not deflated. Every format this tool touches — JPEG, WebP, MP4, MP3 —
 * is already compressed, so deflate would spend real CPU per megabyte to save
 * low single-digit percentages, and often to *grow* the file. STORE also keeps
 * this small enough to be obviously correct, which matters for a format written
 * by hand.
 *
 * Limits, deliberately not worked around: 65535 entries and 4GB per file, which
 * is where ZIP64 becomes mandatory. Both are far past any plausible selection
 * here, and the callers check rather than producing a subtly corrupt archive.
 */

const MAX_ENTRIES = 65_535;
const MAX_FILE_BYTES = 0xFFFF_FFFF;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// ---- crc32 ------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- names ------------------------------------------------------------------

/**
 * A name that is safe in an archive and on the filesystem it lands on.
 *
 * Path separators and `..` are stripped rather than escaped: an entry called
 * `../../x` is a zip-slip, and no legitimate name from a URL needs a directory
 * component. Windows-illegal characters go too, because the archive is opened
 * on the machine that downloaded it.
 */
export function safeEntryName(name: string): string {
  let n = (name || 'file').replace(/[\\/]+/g, '_').replace(/\.\.+/g, '.');
  n = n.replace(/[\x00-\x1f<>:"|?*]+/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = 'file';
  return n.slice(0, 180);
}

/** Make every entry name unique, because a zip with duplicates loses files. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = safeEntryName(raw);
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (!n) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
      : `${name} (${n})`;
  });
}

// ---- writing ----------------------------------------------------------------

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    // DOS epoch is 1980; a date before that cannot be represented at all.
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;

  push(b: Uint8Array): void { this.parts.push(b); this.length += b.length; }

  /** Little-endian, which is the only byte order the format uses. */
  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.push(b);
  }

  u16(n: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n & 0xFFFF, true);
    this.push(b);
  }

  blob(type: string): Blob { return new Blob(this.parts as BlobPart[], { type }); }
}

/**
 * Build a ZIP archive.
 *
 * Throws rather than truncating when a limit is hit: a partial archive that
 * opens and is missing half the gallery is worse than an error, because nothing
 * afterwards tells you it happened.
 */
export function createZip(entries: ZipEntry[]): Blob {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`too many files for one archive (${entries.length}, limit ${MAX_ENTRIES})`);
  }

  const enc = new TextEncoder();
  const w = new Writer();
  const { time, date } = dosTime(new Date());
  const central: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const e of entries) {
    if (e.data.length > MAX_FILE_BYTES) {
      throw new Error(`"${e.name}" is too large for a non-ZIP64 archive`);
    }
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const offset = w.length;

    w.u32(0x04034b50);        // local file header
    w.u16(20);                // version needed
    w.u16(0x0800);            // UTF-8 names
    w.u16(0);                 // stored
    w.u16(time); w.u16(date);
    w.u32(crc);
    w.u32(e.data.length);     // compressed == uncompressed, stored
    w.u32(e.data.length);
    w.u16(name.length);
    w.u16(0);                 // no extra field
    w.push(name);
    w.push(e.data);

    central.push({ name, crc, size: e.data.length, offset });
  }

  const centralStart = w.length;
  for (const c of central) {
    w.u32(0x02014b50);        // central directory header
    w.u16(20); w.u16(20);
    w.u16(0x0800);
    w.u16(0);
    w.u16(time); w.u16(date);
    w.u32(c.crc);
    w.u32(c.size); w.u32(c.size);
    w.u16(c.name.length);
    w.u16(0); w.u16(0);       // extra, comment
    w.u16(0);                 // disk number
    w.u16(0); w.u32(0);       // internal/external attrs
    w.u32(c.offset);
    w.push(c.name);
  }
  const centralSize = w.length - centralStart;

  w.u32(0x06054b50);          // end of central directory
  w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);                   // no comment

  return w.blob('application/zip');
}
