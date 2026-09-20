# Zip it — Live Stream Grabber (extension)

Firefox-first (Chrome as an afterthought) MV3 extension that gives the VaultWares
zipper true **Video-DownloadHelper-style** live-stream detection. It sniffs the
browser's network layer via `webRequest`, catches HLS/DASH/MSS manifests (and
large progressive MP4s) across **every frame**, captures each request's real
headers (Referer/Cookie/User-Agent), and forwards captures to the existing local
pipeline at `http://127.0.0.1:5171/download`.

_Scaffolded: Fri, 24 Jul 2026 03:39_
_Userscript retired: Thu, 27 Aug 2026 20:41_

> **The Tampermonkey userscript is gone.** `../userscript/` and the generated
> `../tampermonkey_script.js` were removed — this extension is now the only
> track, and `src/panel/` no longer has an upstream to stay in sync with. The
> sidebar rebuild in `src/sidebar/` is what replaces it.

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
| `src/content/index.ts` | message endpoint in every frame — harvest, highlight, title extraction |
| `src/content/vendors.ts` | *(unused)* zip/saveAs globals for the retired panel |
| `src/shim/gm-shim.ts` | *(unused)* `GM_*` → `browser.*` adapter for the retired panel |
| `src/panel/**` | legacy in-page panel — **no longer injected**, kept only until the picker is ported |
| `src/popup/popup.tsx` + `popup.css` | the access point — sidebar launcher, server/job status, per-tab streams |
| `src/content/harvest.ts` | all-frames DOM pass — srcset, picture, lazy attrs, backgrounds, og/JSON-LD |
| `src/content/highlight.ts` | sidebar-driven element outlining |
| `src/background/media_log.ts` | network media log — the only source of byte size |
| `src/background/harvest_store.ts` | frame collection, two-pass dedup, per-tab snapshot |
| `src/common/harvest.ts` | the `MediaCandidate` record + srcset/dedup/merge helpers |
| `src/common/scoring.ts` | named additive scoring rules |
| `src/common/upgrade_rules.ts` | thumbnail→original table, and rule derivation |
| `src/background/enrich.ts` | HLS master parse + lazy yt-dlp probe (only while popup is open) |
| `src/sidebar/index.tsx` | **the sidebar** — Preact + Signals shell, per-window tab tracking |
| `src/sidebar/tokens.css` | vaultsqware tokens + the console/warm surface toggle |
| `src/common/domain.ts` | registrable-domain helpers — the site-profile attribution key |

## Sidebar is the workspace, popup is the access point

The **sidebar** (`sidebar_action`) carries Capture, Downloads, Insights and
Settings. It is per-window, not per-tab — it stays mounted across tab switches,
so the active tab is tracked in `watchActiveTab()` and a snapshot is dropped the
moment the page changes.

The **popup** is what you actually see most of the time, since browsing normally
happens with the sidebar closed. It answers what you'd open it to find out —
server reachable, downloads running, streams on this tab, media seen — and
offers one action: open the sidebar. `sidebarAction.open()` needs a live user
gesture, so it is called synchronously in the click handler.

Streams are still queried only while a UI surface is open, and yt-dlp probing is
still deferred, so idle browsing costs nothing beyond the passive sniff.

## Panel (legacy, being replaced)

`src/panel/` began as a copy of the Tampermonkey userscript's `src/`, carried
across with three environment seams changed: `GM_*` globals from `gm-shim.ts`,
`zip`/`saveAs` from `vendors.ts`, and `main.ts` slimmed to export `start()`.

**It is no longer injected.** Nothing imports it, so esbuild drops it from the
bundle — which took `content.js` from 515 KB to 27 KB, on every frame of every
page. The FAB and floating download button are gone with it.

What the panel uniquely did still has a home:

| Was | Now |
|---|---|
| element highlighting | `src/content/highlight.ts`, driven from the sidebar |
| gallery zip | the server already batches and zips via `/download` |
| container picker | to be re-added as a sidebar-initiated mode |

The one real loss is the **in-browser** zip fallback that worked with the server
offline. The directory stays until the picker is ported, then it goes.

## Build & run (Firefox)

```bash
cd extension
npm install
npm run build          # -> dist/
npm run start:firefox  # launches Firefox with the extension loaded (web-ext)
```

Then open the sidebar from the toolbar button and hit **Scan page**. Playing a
video first makes streams appear in the popup.

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
quality/format list. Detected streams show this in the popup; once started,
the **Jobs tab** shows a live progress bar, %, downloaded/total, speed, ETA, and
the thumbnail — driven by yt-dlp's `--progress-template` parsed line-by-line in
`ds_streams.download_stream`.

**3. Controls.**
- Popup, per stream: click to grab with the captured headers.
- Popup, footer: **Clear** (drop detections), **Folder**, **Refresh**.
- Sidebar → Downloads: quality selection, stop, reveal, retry. *(in progress)*
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
- `web-ext lint` reports 2 `UNSAFE_VAR_ASSIGNMENT` (innerHTML) warnings from
  Preact's `dangerouslySetInnerHTML` support. 0 errors. Retiring the in-page
  panel removed the other four.
- Content scripts run with `all_frames: true` so the harvest can reach embedded
  players and gallery iframes. Everything UI-shaped in `src/content/index.ts` is
  gated behind `IS_TOP_FRAME` — without that gate, a page with ten iframes gets
  ten panels and ten competing replies to one `title:extract` request.
