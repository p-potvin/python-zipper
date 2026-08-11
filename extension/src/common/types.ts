export type StreamType = 'hls' | 'dash' | 'smooth' | 'video';

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
  | { kind: 'gm:xhr'; req: { url: string; method?: string; headers?: Record<string, string>; data?: any } };

export interface StreamJob {
  id: string;
  type?: string;
  status: string;
  title?: string;
  stream_url?: string;
  quality?: string;
  thumbnail?: string | null;
  duration?: number | null;
  is_live?: boolean;
  progress?: number;
  speed?: number | null;
  eta?: number | null;
  downloaded_bytes?: number;
  total_bytes?: number;
  save_path?: string | null;
  error?: string;
  created_at?: number;
}

export type ContentMessage = { kind: 'streams:updated'; tabId: number; count: number };

// Background → Content script: request DOM-based title extraction for a stream
export type TitleExtractRequest = { kind: 'title:extract'; streamUrl: string };
export type TitleExtractResponse = {
  title: string;
  source: 'element' | 'biggest-video' | 'meta' | 'page-title' | 'not-found';
  error?: string;
};
