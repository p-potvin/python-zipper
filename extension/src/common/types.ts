export type StreamType = 'hls' | 'dash' | 'smooth' | 'video';

/** Provenance of a stream title, used to decide precedence. */
export type TitleSource =
  | 'element'        // DOM: media element matching stream URL found, title extracted nearby
  | 'biggest-video'  // DOM: fell back to biggest <video> on the page
  | 'ytdlp'          // yt-dlp probe returned a title
  | 'meta'           // DOM: <meta og:title> / <meta name="title">
  | 'page-title'     // DOM: document.title
  | 'tab-title'      // initial: browser tab title
  | 'not-found';     // no title could be extracted

export interface StreamFormat {
  format_id: string;
  height?: number | null;
  width?: number | null;
  ext?: string;
  tbr?: number | null;
  fps?: number | null;
  filesize?: number | null;
  note?: string;
  vcodec?: string;
  acodec?: string;
}

export interface StreamMeta {
  ok?: boolean;
  error?: string;
  title?: string;
  id?: string;
  ext?: string;
  duration?: number | null;
  thumbnail?: string | null;
  uploader?: string | null;
  is_live?: boolean;
  filesize?: number | null;
  formats?: StreamFormat[];
}

export interface StreamVariant {
  url: string;
  height?: number | null;
  bandwidth?: number | null;
  label: string;
}

export interface DetectedStream {
  /** Stable identity — origin + pathname, so token-rotated re-requests collapse. */
  key: string;
  id: string;
  /** Freshest full URL seen for this key (query/token included). */
  url: string;
  type: StreamType;
  tabId: number;
  pageUrl: string;
  title: string;
  headers: Record<string, string>;
  contentType?: string;
  firstSeen: number;
  lastSeen: number;
  hits: number;
  isMaster?: boolean;
  variants?: StreamVariant[];
  meta?: StreamMeta;
  probed?: boolean;
  /** yt-dlp format_id chosen in the quality dropdown. */
  selectedFormat?: string;
  /** Set once the user starts a download; correlates to a Jobs-tab entry. */
  jobId?: string;
  started?: boolean;
  /** Where `title` came from — controls precedence when multiple sources compete. */
  titleSource?: TitleSource;
}

export type BgMessage =
  | { kind: 'streams:get'; tabId?: number }
  | { kind: 'streams:clear'; tabId?: number }
  | { kind: 'streams:remove'; key: string; tabId?: number }
  | { kind: 'streams:recapture'; tabId?: number }
  | { kind: 'streams:start'; key: string; formatId?: string; title?: string; tabId?: number }
  | { kind: 'jobs:get' }
  | { kind: 'jobs:stop'; jobId: string }
  | { kind: 'jobs:delete'; jobId: string }
  | { kind: 'open:folder' }
  | { kind: 'open:path'; path: string }
  | { kind: 'config:get' }
  | { kind: 'config:set'; proxy: string }
  | { kind: 'downloads:start'; url: string; filename: string; referer?: string; saveAs?: boolean }
  | { kind: 'downloads:list' }
  | { kind: 'downloads:reveal'; downloadId?: number; path?: string }
  | { kind: 'gm:xhr'; req: { url: string; method?: string; headers?: Record<string, string>; data?: any } }
  // ---- harvest ----------------------------------------------------------
  | { kind: 'harvest:run'; mode?: 'quick' | 'deep'; scope?: string; tabId?: number }
  /** Scroll the feed out and open the viewer, then harvest. Manual only. */
  | { kind: 'harvest:deep-abort'; tabId?: number }
  | { kind: 'harvest:get'; tabId?: number }
  /** What the passive network log already holds — no scan, no page contact. */
  | { kind: 'harvest:peek'; tabId?: number }
  /** Pushed by each frame in response to the background's broadcast. */
  | { kind: 'harvest:frame-result'; runId: string; isTop?: boolean; candidates: import('./harvest').MediaCandidate[]; scanned?: number; photoSwipe?: any }
  /** Live scanning: a trusted user action revealed media outside any scan. */
  | { kind: 'harvest:live'; candidates: import('./harvest').MediaCandidate[]; pageUrl?: string; tabId?: number }
  /** Background -> sidebar: the standing snapshot grew. */
  | { kind: 'harvest:updated'; snapshot: any }
  /** One decoded frame of a stream, for the preview thumbnail. */
  | { kind: 'stream:preview'; url: string; headers?: Record<string, string> }
  /** Is this a PhotoSwipe page? Answered by the top frame. */
  | { kind: 'pswp:detect' }
  /** Disk headroom, what is still staged locally, and each rclone remote. */
  | { kind: 'storage:get' }
  /** Aggregated download history: by day, by domain, by kind. */
  | { kind: 'insights:get'; days?: number }
  /** Addressed to a worker by name: rclone runs where the files land, not on
   *  the API, and the worker applies this on its next heartbeat. */
  | { kind: 'rclone:config:set'; worker: string; remotes?: string[]; enabled?: boolean }
  /** Fetch a selection, archive it in the background, download the one file. */
  | { kind: 'downloads:zip'; items: { url: string; filename: string }[]; archiveName?: string; pageUrl?: string; facts?: Record<string, any>; tabId?: number }
  | { kind: 'harvest:send-server'; links: string[]; kinds?: Record<string, string>; pageUrl?: string; pageDomain?: string; facts?: Record<string, any>; tabId?: number }
  /** Which of these URLs have already been downloaded, and under what filename. */
  | { kind: 'grabbed:lookup'; urls: string[] }
  | { kind: 'grabbed:clear' }
  /** Background -> sidebar: the passive network log grew for this tab. */
  | { kind: 'media:logged'; tabId: number; logged: number }
  // ---- container picker --------------------------------------------------
  | { kind: 'picker:start' }
  | { kind: 'picker:stop' }
  | { kind: 'picker:count'; selector: string }
  | { kind: 'picker:result'; selector: string }
  // ---- VaultWares API ----------------------------------------------------
  | { kind: 'api:config:get' }
  | { kind: 'api:config:set'; baseUrl?: string; apiKey?: string }
  | { kind: 'api:health' };

/**
 * A row from zipper.jobs.
 *
 * Renamed from the local server's shape, which is worth stating because the
 * fields moved rather than merely being added to: bytes are `bytes_done` /
 * `bytes_total` now, the job type is `kind`, and per-stream details like
 * quality and the source URL live under `options` because the table is shared
 * with batch and probe jobs. `archive_paths` is gone entirely — paths on a
 * worker's disk mean nothing to the browser.
 */
export interface StreamJob {
  id: string;
  kind?: string;
  status: string;
  title?: string;
  page_url?: string;
  page_domain?: string;
  progress?: number;
  speed?: number | null;
  eta?: number | null;
  bytes_done?: number;
  bytes_total?: number;
  total_links?: number;
  processed_links?: number;
  save_dir?: string | null;
  archives?: string[];
  /** Which rclone remotes took the files. Empty means still on the worker. */
  rclone_remotes?: string[];
  /** Answer-shaped jobs (a stream probe) return their payload here. */
  result?: any;
  /** Per-kind extras: format_id, quality, stream_url, thumbnail, sink. */
  options?: Record<string, any>;
  error?: string;
  claimed_by?: string;
  created_at?: string;
}

export type ContentMessage = { kind: 'streams:updated'; tabId: number; count: number };

// Background → Content script: request DOM-based title extraction for a stream
export type TitleExtractRequest = { kind: 'title:extract'; streamUrl: string };
export type TitleExtractResponse = {
  title: string;
  source: 'element' | 'biggest-video' | 'meta' | 'page-title' | 'not-found';
  error?: string;
};
