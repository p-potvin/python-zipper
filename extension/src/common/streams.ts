/**
 * Stream presentation helpers, shared by the popup and the sidebar.
 *
 * Both surfaces answer the same two questions about a detected stream — what
 * qualities can I pick, and is it recording right now — and they were about to
 * answer them with two copies of the same logic. The quality rules in
 * particular are subtle enough that two copies would drift.
 */

import type { DetectedStream, StreamJob } from './types';

export interface Quality {
  /** yt-dlp format id. Empty means "advertised but not selectable" — see below. */
  id: string;
  label: string;
}

/**
 * Qualities that can be offered for a stream.
 *
 * Two sources, and they are not interchangeable:
 *
 *   - **The probe.** yt-dlp returns real `format_id`s, which is the only thing
 *     a recording can actually be started with.
 *   - **The HLS master.** Parsed locally the moment the manifest is seen, so it
 *     is available immediately — but it carries no format id. Those entries are
 *     shown so you can see what the stream offers while the probe is still
 *     queued, and are deliberately not selectable rather than being hidden:
 *     "1080p exists, not yet pickable" is more useful than an empty list that
 *     looks like a failure.
 */
export function qualities(s: DetectedStream): Quality[] {
  const fmts = s.meta?.formats || [];
  if (fmts.length) {
    return fmts
      .filter((f) => f.height)
      .slice(0, 12)
      .map((f) => ({
        id: f.format_id,
        label: `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}`,
      }));
  }
  return (s.variants || [])
    .filter((v) => v.height)
    .map((v) => ({ id: '', label: v.label || `${v.height}p` }));
}

/** True once a quality list can actually be acted on. */
export function hasSelectableQuality(qs: Quality[]): boolean {
  return qs.some((q) => !!q.id);
}

/**
 * The job recording this stream, if one is.
 *
 * `claimed` counts: a worker that has taken the job but not yet reported
 * progress is running it, and leaving that state out makes a just-started
 * recording look for a few seconds like it never started.
 */
export function activeJobFor(s: DetectedStream, jobs: StreamJob[]): StreamJob | undefined {
  if (!s.jobId) return undefined;
  const j = jobs.find((x) => x.id === s.jobId);
  if (!j) return undefined;
  return j.status === 'running' || j.status === 'queued' || j.status === 'claimed' ? j : undefined;
}

export function progressLabel(j: StreamJob): string {
  if (j.status === 'queued') return 'queued';
  if (j.status === 'claimed') return 'starting';
  if (typeof j.progress === 'number' && j.progress > 0) return `${Math.round(j.progress)}%`;
  // A live broadcast has no total, so a percentage never moves off zero.
  // Showing the bytes taken so far is the honest readout for that case.
  if (j.bytes_done) {
    const n = j.bytes_done;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
    return `${Math.round(n / 1e3)} KB`;
  }
  return j.status;
}
