/**
 * Gallery archive naming — the Pornpics userscript's rules, shared.
 *
 * Every archive that feeds a face gallery is named `<model>__________<hash8>.zip`
 * and holds `<model>_<NNN>.<ext>`. ColONEL-KFC's importer parses exactly that
 * (`dataset_archives.ARCHIVE_PATTERN`): the part before the ten underscores is
 * the identity, so it has to be the bare model name and nothing else. The OF
 * script used to write `_user_media_batch_2_final.zip`, which is why those
 * archives needed renaming by hand before they could be imported.
 */

export const BATCH_SIZE = 80;
export const BATCH_SEPARATOR = '_'.repeat(10);

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Lowercase alphanumerics only — `Zoe.N` and `zoe_n` are the same person. */
export function normalizeModelName(raw: string): string {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First 8 bytes of a digest as 8 base62 characters, most significant first. */
function toBase62(buffer: ArrayBuffer, length = 8): string {
  const bytes = new Uint8Array(buffer);
  let val = 0n;
  for (let i = 0; i < 8; i++) val = (val << 8n) | BigInt(bytes[i]);
  let res = '';
  for (let i = 0; i < length; i++) {
    res = B62[Number(val % 62n)] + res;
    val /= 62n;
  }
  return res;
}

/** SHA-256 over the concatenated file digests: the archive's identity. */
export async function batchHash(fileDigests: Uint8Array[]): Promise<string> {
  if (!fileDigests.length) return '00000000';
  const merged = new Uint8Array(fileDigests.length * 32);
  fileDigests.forEach((h, i) => merged.set(h, i * 32));
  return toBase62(await crypto.subtle.digest('SHA-256', merged), 8);
}

export function archiveName(model: string, hash: string): string {
  return `${model}${BATCH_SEPARATOR}${hash}.zip`;
}

export function memberName(model: string, index: number, ext: string): string {
  return `${model}_${String(index).padStart(3, '0')}.${ext}`;
}

/** The file extension a URL claims, or `jpg` when it claims nothing usable. */
export function imageExt(url: string, allowed = ['jpg', 'jpeg', 'png', 'webp', 'gif']): string {
  const ext = (url.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
  return allowed.includes(ext) ? ext : 'jpg';
}
