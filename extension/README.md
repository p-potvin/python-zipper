# Zip it — Live Stream Grabber (extension)

Firefox-first (Chrome as an afterthought) MV3 extension that gives the VaultWares
zipper true **Video-DownloadHelper-style** live-stream detection. It sniffs the
browser's network layer via `webRequest`, catches HLS/DASH/MSS manifests (and
large progressive MP4s) across **every frame**, captures each request's real
headers (Referer/Cookie/User-Agent), and forwards captures to the existing local
pipeline at `http://127.0.0.1:5171/download`.

The Tampermonkey userscript in `../userscript/` is **untouched** and keeps
working. This extension is a parallel track.

_Scaffolded: Fri, 24 Jul 2026 03:39_

## Why an extension (vs the userscript)

- `webRequest` sees requests a userscript never can — including cross-origin
  `<iframe>` players (embeds).
- Captures the real request headers, so the server-side `yt-dlp` no longer 403s
  on authenticated streams (this was the main failure mode of the userscript's
  in-page sniffing).

## Layout

| File | Role |
|---|---|
| `public/manifest.json` | MV3 manifest (Firefox `background.scripts` event page) |
| `src/background/sniffer.ts` | `webRequest` detection + per-tab store + header capture |
| `src/background/index.ts` | message router + server forwarding + `gm:xhr` backend |
| `src/content/index.ts` | boots the GM shim + vendors, then builds the image-harvest panel |
| `src/content/vendors.ts` | installs `zip` / `saveAs` / `unsafeWindow` globals the panel expects |
| `src/shim/gm-shim.ts` | `GM_*` → `browser.*` adapter (cache-backed sync reads) |
| `src/panel/**` | the full userscript UI (image harvesting), vendored (`// @ts-nocheck`) |
| `src/popup/popup.ts` + `popup.html` | **the stream UI** — VDH-style cards, download/progress, controls |
| `src/background/enrich.ts` | HLS master parse + lazy yt-dlp probe (only while popup is open) |

## Popup is the stream home (v1.2)

All stream detection/download UI lives in the **toolbar popup** (Video-Download­Helper-style
cards): thumbnail with a `live` badge, protocol badge (HLS/M3U8/HTTP/DASH),
title, rename, a quality dropdown, and a blue Download split-button. Started
downloads turn into progress cards in the same list — live %/speed/ETA, a **Stop**
that finalizes the recording, **Open**, and delete. A bottom toolbar carries
refresh, open-downloads-folder, clear, and “No video?” (re-capture).

Streams are queried **only while the popup is open** (1s poll); the content
script no longer injects anything stream-related, and yt-dlp probing is deferred
to when the popup asks — so browsing with the popup closed costs nothing beyond
the passive `webRequest` sniff.

## Panel port

`src/panel/` is a copy of `../userscript/src` (kept in sync manually — the
userscript remains the upstream source of truth). Only three environment seams
were changed: the `GM_*` globals now come from `gm-shim.ts`, the `zip`/`saveAs`
globals from `vendors.ts`, and `main.ts` was slimmed to export `start()` instead
of auto-running (its dead duplicate harvest/zip code and the Tampermonkey menu
command were dropped). Everything else — Media/Cloud/Smart/Jobs tabs, theming,
drag, upscale toggle, server status, gallery zipping — runs unchanged.

Detected live streams appear at the top of the **Cloud tab** with a red
`[HLS]/[DASH]` tag and a 🔑 marker when request headers were captured. Each has a
header-aware **Grab** button (routes through the background so Referer/Cookie
travel with it) and a checkbox that also feeds the panel's existing
"Send Selected to Cloud" batch.

## Build & run (Firefox)

```bash
cd extension
npm install
npm run build          # -> dist/
npm run start:firefox  # launches Firefox with the extension loaded (web-ext)
```

Then play a video anywhere; the red **N streams** pill appears bottom-right.
Click a stream's **Send to Cloud** to push it (with headers) to the local server.

Live-reload while developing: `npm run dev` (esbuild watch) in one terminal,
`npm run start:firefox` in another (web-ext reloads on `dist/` changes).

## Chrome (afterthought)

MV3 in Chrome needs a service-worker background instead of `background.scripts`.
Swap the manifest's `background` block to:

```json
"background": { "service_worker": "background.js" }
```

Everything else (webRequest observation, messaging) is written cross-browser via
`src/common/api.ts`. Note: Chrome requires the `"extraHeaders"` opt-in to read
Cookie/Referer — already handled in `sniffer.ts` via the `IS_FIREFOX` check.

## Stream lifecycle (v1.1)

**1. Dedup.** The sniffer keys streams by `origin + pathname` (`streamKey`), so a
manifest re-requested with a rotated auth token updates the existing entry (bumps
`hits`, refreshes headers/URL) instead of piling up duplicates. HLS master
playlists are fetched and parsed; their variant playlists are folded away so the
list shows one entry per actual stream.

**2. Metadata in the Jobs tab.** On detection the background probes each stream
via `yt-dlp -j` (`/api/stream/probe`) → title, thumbnail, duration, and the full
quality/format list. Detected streams show this in the Cloud tab; once started,
the **Jobs tab** shows a live progress bar, %, downloaded/total, speed, ETA, and
the thumbnail — driven by yt-dlp's `--progress-template` parsed line-by-line in
`ds_streams.download_stream`.

**3. Controls.**
- Cloud tab, per stream: quality dropdown (yt-dlp formats), **Start**, **✕** (remove detection).
- Cloud tab, section: **Clear** (drop detections) and **↻ Re-capture** (clears + reloads the tab so network requests fire again).
- Jobs tab, per stream job: **Stop** (kills the yt-dlp process), **Delete** (stop + remove job), **📂 Open** (reveal the saved file).

**Proxy / auth headers.** The sniffer captures *all* request headers except
hop-by-hop noise — including `Authorization` and `Proxy-Authorization` — and
forwards them to yt-dlp, so token-gated CDNs resolve.

If the browser reaches the CDN through a proxy (e.g. a WireGuard SOCKS proxy),
point yt-dlp at the same one. Two ways, per-request wins over the env default:
- **Popup → ⚙ Settings → Download proxy**, e.g. `socks5h://10.64.0.1:1080`
  (persisted; sent with every probe/start). `socks5h` resolves DNS through the
  proxy, matching the browser.
- Or `set PYTHON_ZIPPER_PROXY=socks5h://10.64.0.1:1080` before launching the server.

yt-dlp `--proxy` supports `socks5`/`socks5h`/`http(s)` and Basic auth
(`scheme://user:pass@host:port`); a **Bearer**-authenticated proxy can't be
expressed there.

**4. Saving.** Streams are written to `STREAMS_DIR` — default
`.downloaded/streams/`, override with `PYTHON_ZIPPER_STREAMS_DIR`. Unlike the
image pipeline they are **not** rclone-moved off by default (set
`PYTHON_ZIPPER_STREAM_RCLONE=1` to opt in), so the file persists locally; the
job records the absolute `save_path` and **📂 Open** reveals it in Explorer.

### Native File Explorer integration

- Run `native-host\install-native-host.ps1` once to install or update the
  current-user Firefox native messaging host.
- File and folder reveal actions go directly from Firefox to the native host.
  The localhost server supplies download/job metadata but does not launch Explorer.
- Missing or invalid paths fail without opening a substitute folder. The
  initiating reveal control briefly gets a red border and remains retryable.

### Fixed in v1.2

- **Downloads silently did nothing.** Almost always a **stale server** that
  predates `/api/stream/*` (start 404s). Restart the server after pulling. The
  popup now surfaces a failed start instead of flashing briefly.
- **Live recordings are now kept.** Stopping a live stream sends CTRL_BREAK to
  yt-dlp's process group so it finalizes/muxes the partial file; a produced file
  counts as completed (`ds_streams.stop_stream` / `download_stream`).

> **After updating, restart the python-zipper server** so the new endpoints load:
> ```
> .venv\Scripts\python.exe dataset_builder\server.py
> ```

### Server endpoints (all local, bypass the proxy prefixes)

| Endpoint | Purpose |
|---|---|
| `POST /api/stream/probe` | `{url, headers}` → metadata + formats (yt-dlp -j) |
| `POST /api/stream/start` | `{url, headers, format_id?, page_url, title, thumbnail, duration}` → spawns a tracked download, returns `correlationId` |
| `POST /api/stream/stop` | `{job_id}` → terminate the running yt-dlp process |
| `POST /api/stream/delete` | `{job_id}` → stop + drop the job |

`stream_headers`/`headers` (Referer/Cookie/User-Agent) are mapped to yt-dlp via
`ds_helpers.build_ytdlp_header_args` (`--referer`/`--user-agent`/`--add-header`).
`.m3u8`/`.mpd`/`.f4m`/`.ism`/`dash` all route to yt-dlp.

## Known limits (same ceiling as VDH)

- DRM / Widevine (EME) streams cannot be grabbed.
- Non-persistent background may unload when idle; active playback keeps it alive
  and the content script re-polls every 4s, so detected streams are re-surfaced.
- `web-ext lint` reports `UNSAFE_VAR_ASSIGNMENT` (innerHTML) warnings from the
  vendored panel markup. These are AMO-submission advisories only — they don't
  block loading unpacked or self-signing — and are inherited unchanged from the
  userscript.
- The panel port is a manual copy of `../userscript/src`; changes upstream must
  be re-copied (see the "Panel port" section).
