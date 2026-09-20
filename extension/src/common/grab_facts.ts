/**
 * Merging what a download path knows about an asset with what the network saw.
 *
 * Kept pure and separate from the background so it can be checked: this merge
 * is the whole reason the Insights tab had byte totals of zero for three of
 * its four domains, and a rule that subtle should not live only inside a
 * message handler.
 *
 * The sender wins wherever it spoke. A DOM sighting is a deliberate statement
 * about the asset — the in-page button knows it is looking at a video and how
 * large the decoded frame is — while the log knows only what the response
 * headers carried. So the log fills gaps and never overwrites.
 *
 * `null` counts as unknown, not as an answer: the sidebar builds facts from a
 * candidate whose `bytes` may legitimately be null, and treating that as a
 * stated zero is how a real Content-Length gets thrown away.
 */

import type { GrabFactsLike } from './types';

const FILLABLE = [
  'kind', 'mime', 'bytes', 'width', 'height', 'score', 'assetHost',
] as const;

export function mergeGrabFacts(
  sent?: GrabFactsLike | null,
  logged?: GrabFactsLike | null,
): GrabFactsLike {
  const out: GrabFactsLike = { ...(sent || {}) };
  if (!logged) return out;
  for (const k of FILLABLE) {
    if (out[k] === undefined || out[k] === null) {
      const v = logged[k];
      // Per-key assignment across a union of value types; the keys are a fixed
      // literal list, so the cast is on the write, not on what is written.
      if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
