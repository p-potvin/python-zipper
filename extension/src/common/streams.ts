/**
 * Stream presentation helpers, shared by the popup and the sidebar.
 *
 * Both surfaces answer the same two questions about a detected stream — what
 * qualities can I pick, and is it recording right now — and they were about to
 * answer them with two copies of the same logic. The quality rules in
 * particular are subtle enough that two copies would drift.
 */

import type { DetectedStream, StreamJob } from './types';

// ---- telling one stream from another ----------------------------------------

/**
 * Titles that describe the player rather than what is playing.
 *
 * The DOM title extractor reads the label nearest the media element and
 * outranks every other source, so on a page whose tab title, hostname and
 * stream URL all name the broadcaster, the stream was still called "Video
 * Player" — and so was the file it recorded.
 */
const GENERIC_TITLES = new Set([
  'video player', 'media player', 'player', 'html5 video player', 'jwplayer',
  'videojs', 'video js', 'video', 'live', 'livestream', 'live stream',
  'stream', 'watch', 'untitled', 'loading',
]);

export function isGenericTitle(title: string): boolean {
  return GENERIC_TITLES.has((title || '').trim().toLowerCase());
}

/**
 * The broadcaster's name where the host writes it into the stream path.
 *
 * Chaturbate publishes under `/v1/edge/streams/origin.<username>.<id>/`, which
 * makes the URL the most reliable source on that host: it is the performer's
 * own name, it cannot be a player's label, and it is there before any title
 * has been extracted.
 */
export function nameFromStreamUrl(url: string): string {
  try {
    for (const seg of new URL(url).pathname.split('/')) {
      const m = /^origin\.([A-Za-z0-9][A-Za-z0-9_-]{1,39})\.[A-Za-z0-9]{8,}$/.exec(seg);
      if (m) return m[1];
    }
  } catch { /* not a URL we can read */ }
  return '';
}

export interface StreamDescription {
  /** Who or what this is: a username from the URL, or the cleaned title. */
  name: string;
  /** master | video | audio | chunklist — what kind of playlist it is. */
  role: string;
  /** The edge host serving it, which is how you tell two sessions apart. */
  host: string;
}

/**
 * What to show for a stream, when the title tells you nothing.
 *
 * The complaint this answers: every row on a live site had the same generic
 * title, so choosing between them meant hovering each one and reading the URL
 * in the status bar — master or chunk, audio or video, which edge, whose
 * stream. All of that is in the URL; none of it was on screen.
 */
export function describeStream(s: DetectedStream): StreamDescription {
  let host = '';
  let file = '';
  try {
    const u = new URL(s.url);
    host = u.hostname.split('.')[0];
    const path = u.pathname;
    file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  } catch { /* leave blank */ }

  const role = s.isMaster ? 'master'
    : /(^|[_.-])audio([_.-]|$)/.test(file) ? 'audio'
      : /(^|[_.-])video([_.-]|$)/.test(file) ? 'video'
        : /chunklist|llhls/.test(file) ? 'chunklist'
          : /master|playlist|index/.test(file) ? 'master'
            : '';

  const titled = (s.title || '').replace(/^\[[^\]]*\]\s*/, '').trim();
  const name = nameFromStreamUrl(s.url)
    || (titled && !isGenericTitle(titled) ? titled : '')
    || host
    || 'stream';

  return { name, role, host };
}

// ---- streams published as two playlists -------------------------------------

/**
 * The role and group of a media playlist, from its filename.
 *
 * Some hosts publish a stream as two unrelated media playlists and no master:
 * chaturbate serves `chunklist_3_video_<id>_llhls.m3u8` and
 * `chunklist_5_audio_<id>_llhls.m3u8`, where `<id>` is the only thing tying
 * them together — the leading index differs, and they may even arrive from
 * different edge hosts. With no master, nothing downstream can know the audio
 * exists, so a recording of the video playlist is silent and the audio one
 * shows up in the list as a second, pointless "stream".
 */
export interface PlaylistRole {
  role: 'video' | 'audio';
  /** The long id shared by both halves. */
  group: string;
  /** Path directory, host excluded — the two halves can be on different edges. */
  dir: string;
}

export function playlistRole(url: string): PlaylistRole | null {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    const role = /(^|[_.-])video([_.-]|$)/.test(file) ? 'video'
      : /(^|[_.-])audio([_.-]|$)/.test(file) ? 'audio'
        : null;
    if (!role) return null;
    // The longest digit run in the name. Short numbers are the rendition index
    // and the track number, which differ between the two halves.
    const runs = file.match(/\d{8,}/g);
    if (!runs || !runs.length) return null;
    const group = runs.reduce((a, b) => (b.length >= a.length ? b : a));
    return { role, group, dir: path.slice(0, path.lastIndexOf('/') + 1) };
  } catch {
    return null;
  }
}

/** Do these two playlists describe one stream? */
export function arePaired(a: PlaylistRole, b: PlaylistRole): boolean {
  return a.group === b.group && a.dir === b.dir && a.role !== b.role;
}

/**
 * Parameters a client adds to one *request* for a playlist, rather than ones
 * that identify the playlist.
 *
 * RFC 8216bis calls these Delivery Directives. `_HLS_msn` and `_HLS_part` ask
 * the server to block until a given media sequence and part exist; `_HLS_skip`
 * asks for a delta update. Hosts add their own alongside — chaturbate sends
 * `sn`, its own sequence number.
 */
const HLS_DIRECTIVES = new Set(['_hls_msn', '_hls_part', '_hls_skip', '_hls_report']);
/** Only dropped in the company of a real directive; a bare `sn` elsewhere may
 *  well be part of the identity. */
const HLS_COMPANIONS = new Set(['sn']);

/**
 * The playlist URL, without the part of it that means "right now".
 *
 * A low-latency player asks for the next part — `?sn=10176&_HLS_part=0` — and
 * that is the request the sniffer sees, so that is the URL we store. Handing
 * it to a recorder minutes later asks the edge for a part that left the live
 * window long ago, and the answer is 403. Stripped, the same URL means "the
 * playlist as it stands", which is what both a probe and a recording want.
 *
 * Tokens, signatures and expiries are left exactly as captured — this removes
 * only what the client itself added.
 */
export function stripDeliveryDirectives(url: string): string {
  if (!url || !url.includes('?')) return url;
  try {
    const u = new URL(url);
    let sawDirective = false;
    for (const k of u.searchParams.keys()) {
      if (HLS_DIRECTIVES.has(k.toLowerCase())) { sawDirective = true; break; }
    }
    if (!sawDirective) return url;
    for (const k of [...u.searchParams.keys()]) {
      const lower = k.toLowerCase();
      if (HLS_DIRECTIVES.has(lower) || HLS_COMPANIONS.has(lower)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * How long a stream goes unrequested before it counts as idle.
 *
 * A live player re-requests its media playlist every few seconds, so a stream
 * nothing has asked for in two minutes is finished, switched away from, or
 * belongs to a player that has been closed.
 */
export const IDLE_AFTER_MS = 120_000;

/**
 * Is this stream still being served?
 *
 * Idle streams are kept, not deleted — the URL is often still recordable, and
 * deleting on a timer would make a stream vanish while you were reading it.
 * The list folds them away instead, behind a count, because a silent filter on
 * a heuristic is how a working stream disappears with nowhere to look for it.
 */
export function isIdleStream(s: DetectedStream, now = Date.now()): boolean {
  if (s.jobId) return false;              // recording: never idle
  return now - s.lastSeen > IDLE_AFTER_MS;
}

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

/**
 * Should this capture show an indeterminate bar rather than a percentage?
 *
 * "No total" alone is not a reliable test. yt-dlp's progress template falls
 * back to `total_bytes_estimate`, and an estimate is often non-zero even for a
 * broadcast with no end — which put a live capture on the determinate branch,
 * creeping towards a finish line that does not exist.
 *
 * The stream's own `is_live`, recorded in the job's options when the recording
 * was started, is the fact; the missing total is only the fallback for a job
 * that predates it.
 */
export function isIndeterminate(j: StreamJob): boolean {
  if (j.options?.is_live === true) return true;
  return !j.bytes_total;
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
