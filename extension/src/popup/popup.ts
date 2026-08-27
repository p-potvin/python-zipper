import { ext } from '../common/api';
import type { DetectedStream, StreamFormat, StreamJob } from '../common/types';

// ---- icons ------------------------------------------------------------------
const P: Record<string, string> = {
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  x: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  pencil: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  help: 'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
  stop: 'M6 6h12v12H6z',
  external: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  chevron: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  film: 'M18 4v1h-2V4c0-.55-.45-1-1-1H9c-.55 0-1 .45-1 1v1H6V4c0-.55-.45-1-1-1s-1 .45-1 1v16c0 .55.45 1 1 1s1-.45 1-1v-1h2v1c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-1h2v1c0 .55.45 1 1 1s1-.45 1-1V4c0-.55-.45-1-1-1s-1 .45-1 1zM8 17H6v-2h2v2zm0-4H6v-2h2v2zm0-4H6V7h2v2zm10 8h-2v-2h2v2zm0-4h-2v-2h2v2zm0-4h-2V7h2v2z',
};
function icon(name: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="${P[name]}"/></svg>`;
}

// ---- helpers ----------------------------------------------------------------
function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c] as string));
}
function safeHTML(container: HTMLElement, html: string): void {
  if (!html) { container.replaceChildren(); return; }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const nodes = [...parsed.body.childNodes];
  container.replaceChildren(...nodes);
}
function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${u[i]}`;
}
function fmtDuration(sec?: number | null): string {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (x: number) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}
function badgeFor(s: DetectedStream): { cls: string; label: string } {
  if (s.type === 'video') return { cls: 'b-http', label: 'HTTP' };
  if (s.type === 'dash') return { cls: 'b-dash', label: 'DASH' };
  if (s.type === 'smooth') return { cls: 'b-mss', label: 'MSS' };
  if (/\.m3u8(?:[?#]|$)/i.test(s.url) && !s.isMaster) return { cls: 'b-m3u8', label: 'M3U8' };
  return { cls: 'b-hls', label: 'HLS' };
}
function fileName(s: DetectedStream): string {
  const t = s.title || s.meta?.title;
  if (t) return t;
  try { return decodeURIComponent(s.url.split('/').pop()!.split(/[?#]/)[0]) || s.url; } catch { return s.url; }
}
function shortErr(e?: string): string {
  if (!e) return 'unknown';
  const http = e.match(/HTTP Error \d{3}[^\n]*/i);
  let m = http ? http[0] : e.split('\n').pop() || e;
  m = m.replace(/^ERROR:\s*/i, '').replace(/\[[^\]]+\]\s*/g, '').trim();
  return m.length > 64 ? m.slice(0, 63) + '…' : m;
}

function formatLabel(f: StreamFormat): string {
  const head = f.height ? `${f.height}p` : (f.vcodec && f.vcodec !== 'none' ? 'video' : 'audio');
  const size = f.filesize ? ` · ${fmtBytes(f.filesize)}` : '';
  return `${head} · ${f.ext || '?'}${size}`;
}

// ---- state ------------------------------------------------------------------
const cardsEl = document.getElementById('cards')!;
const selectedFormat = new Map<string, string>();
const customTitle = new Map<string, string>();
let tabId: number | undefined;
let lastSig = '';
let openMenu: HTMLElement | null = null;
let serverOnline = false;
let lastJobs: Record<string, StreamJob> = {};

function closeMenu() { openMenu?.remove(); openMenu = null; }

async function send(msg: any): Promise<any> {
  try { return await ext.runtime.sendMessage(msg); } catch { return null; }
}

function toast(text: string, kind: '' | 'ok' | 'err' = '') {
  const el = document.getElementById('toast')!;
  el.textContent = text;
  el.className = kind;
  requestAnimationFrame(() => el.classList.add('show'));
  window.clearTimeout((toast as any)._t);
  (toast as any)._t = window.setTimeout(() => el.classList.remove('show'), 2600);
}

function flashRevealError(element: Element | null) {
  if (!element) return;
  element.classList.remove('reveal-error');
  void (element as HTMLElement).offsetWidth;
  element.classList.add('reveal-error');
  window.setTimeout(() => element.classList.remove('reveal-error'), 1600);
}

async function requestReveal(message: any, trigger: Element | null) {
  const resp = await send(message);
  if (resp?.ok) {
    toast('Revealed in File Explorer', 'ok');
  } else {
    flashRevealError(trigger);
  }
  return resp;
}

async function openLocal(path: string, trigger: Element | null) {
  return await requestReveal({ kind: 'open:path', path }, trigger);
}

// ---- rendering --------------------------------------------------------------
function emptyState() {
  safeHTML(cardsEl,
    `<div class="empty">${icon('film', 34)}<div>No streams detected on this tab.</div>` +
    `<div style="margin-top:6px;font-size:11px;">Play the video, then hit <b>refresh</b> or <b>No video?</b></div></div>`);
}

function detectedCard(s: DetectedStream): string {
  const b = badgeFor(s);
  const live = s.meta?.is_live;
  const hasHeaders = Object.keys(s.headers || {}).length > 0;
  const name = esc(customTitle.get(s.key) || fileName(s));
  const thumb = s.meta?.thumbnail
    ? `<img src="${esc(s.meta.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="ph">${icon('film', 28)}</div>`;
  const dur = fmtDuration(s.meta?.duration);
  const vids = (s.meta?.formats || []).filter((f) => f.height);
  const ext = s.meta?.ext ? s.meta.ext.toUpperCase() : 'MP4';

  const metaBits: string[] = [];
  if (dur) metaBits.push(`${dur}`);
  if (live) metaBits.push('live');
  if (s.hits > 1) metaBits.push(`seen ×${s.hits}`);
  if (!s.probed) metaBits.push('probing…');
  else if (s.meta && s.meta.ok === false) metaBits.push(`probe failed: ${shortErr(s.meta.error)}`);

  const fmt = vids.length > 1
    ? `<div class="fmt"><span class="ext">${ext}</span><select data-fmt="${s.key}">
         <option value="">Best</option>
         ${vids.map((f) => `<option value="${esc(f.format_id)}" ${selectedFormat.get(s.key) === f.format_id ? 'selected' : ''}>${esc(formatLabel(f))}</option>`).join('')}
       </select></div>`
    : `<div class="fmt"><span class="ext">${ext}</span></div>`;

  return `
  <div class="card" data-key="${esc(s.key)}">
    <div class="thumb-wrap">${thumb}${live ? '<div class="live"><span class="dot"></span>live</div>' : ''}</div>
    <div class="body">
      <button class="close" data-act="remove" aria-label="Remove">${icon('x', 18)}</button>
      <div class="titlerow">
        <span class="badge ${b.cls}">${b.label}</span>
        <span class="title">${name}${hasHeaders ? ' <span class="keyicon" title="request headers captured">&#128273;</span>' : ''}</span>
      </div>
      <div class="meta">${metaBits.map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      <div class="controls">
        <button class="iconbtn" data-act="rename" title="Rename">${icon('pencil', 16)}</button>
        ${fmt}
        <span class="spring"></span>
        <div class="dl">
          <button class="main" data-act="start">${icon('download', 16)}<span>Download</span></button>
          <button class="chev" data-act="menu" aria-label="More">${icon('chevron', 14)}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function jobCard(job: StreamJob, s?: DetectedStream): string {
  const running = job.status === 'running' || job.status === 'queued';
  const color = job.status === 'completed' ? '#22c55e' : job.status === 'failed' ? '#ef4444' : job.status === 'aborted' ? '#f59e0b' : '#60a5fa';
  const pct = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const live = job.is_live;
  const b = s ? badgeFor(s) : { cls: 'b-http', label: 'HLS' };
  const name = esc(job.title || (s ? fileName(s) : job.stream_url) || job.id);
  const thumb = job.thumbnail
    ? `<img src="${esc(job.thumbnail)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
    : `<div class="ph">${icon('film', 28)}</div>`;

  const dl = fmtBytes(job.downloaded_bytes), total = fmtBytes(job.total_bytes);
  const speed = job.speed ? `${fmtBytes(job.speed)}/s` : '';
  const eta = (job.eta && running) ? `ETA ${fmtDuration(job.eta)}` : '';
  const stat = [dl, total].filter(Boolean).join(' / ');
  const elapsed = fmtDuration((Date.now() - (job.created_at || Date.now())) / 1000) || '0:00';

  // Live recording: blue pill with a pulsing red dot + elapsed & speed, and a
  // red Cancel — no percentage (total is unknown for a live stream).
  let bottom: string;
  if (running && live) {
    bottom = `
      <div class="recrow">
        <div class="recbar"><span class="rleft"><span class="rdot"></span>${esc(elapsed)}</span><span>${esc(speed || '—')}</span></div>
        <button class="cancel" data-act="stop" data-job="${esc(job.id)}">Cancel</button>
      </div>`;
  } else if (running) {
    const isPulse = pct === 0 ? 'pulse' : '';
    const displayPct = pct === 0
      ? (job.downloaded_bytes ? `${dl} (${speed || '—'})` : 'starting…')
      : `${pct}%`;
    bottom = `
      <div class="prog"><div class="track"><div class="fill ${isPulse}" style="width:${pct || 5}%"></div></div><span class="pct">${displayPct}</span></div>
      <div class="controls"><span class="spring"></span><div class="dl stop"><button class="main" data-act="stop" data-job="${esc(job.id)}">${icon('stop', 16)}<span>Stop</span></button></div></div>`;
  } else if (job.status === 'completed') {
    bottom = `
      <div class="prog"><div class="track"><div class="fill" style="width:100%;background:#22c55e"></div></div><span class="pct">done</span></div>
      <div class="controls"><span class="spring"></span>${job.save_path ? `<div class="dl open"><button class="main" data-act="open" data-path="${esc(job.save_path)}">${icon('folder', 16)}<span>Open</span></button></div>` : ''}</div>`;
  } else {
    bottom = `<div class="err">${esc(job.error || job.status)}</div>`;
  }

  return `
  <div class="card">
    <div class="thumb-wrap">${thumb}${live ? '<div class="live"><span class="dot"></span>live</div>' : ''}</div>
    <div class="body">
      <button class="close" data-act="jobdelete" data-job="${esc(job.id)}" aria-label="Delete">${icon('x', 18)}</button>
      <div class="titlerow">
        <span class="badge ${b.cls}">${b.label}</span>
        <span class="title">${name}</span>
      </div>
      ${bottom}
    </div>
  </div>`;
}

let currentTabUrl = '';

function render(streams: DetectedStream[], jobs: Record<string, StreamJob>) {
  const jobList = Object.values(jobs).filter((j) => j.type === 'stream');
  const byStreamJobId = new Set<string>();

  let html = '';
  // Active/recent jobs whose stream is tied to a card render inside that card;
  // start with detected streams (may show as jobs if started).
  for (const s of streams) {
    if (s.jobId && jobs[s.jobId]) { html += jobCard(jobs[s.jobId], s); byStreamJobId.add(s.jobId); }
    else html += detectedCard(s);
  }
  // Active running jobs or jobs belonging to the current page
  for (const j of jobList.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))) {
    if (!byStreamJobId.has(j.id)) {
      const isRunning = j.status === 'running' || j.status === 'queued';
      const isCurrentPage = Boolean(currentTabUrl && j.page_url && (j.page_url === currentTabUrl));
      if (isRunning || isCurrentPage) {
        html += jobCard(j);
      }
    }
  }

  safeHTML(cardsEl, html || '');
  if (!html) emptyState();
}

// ---- polling ----------------------------------------------------------------
async function poll() {
  const [sres, jres] = await Promise.all([
    send({ kind: 'streams:get', tabId }),
    send({ kind: 'jobs:get' }),
  ]);
  const streams: DetectedStream[] = sres?.streams ?? [];
  const jobs: Record<string, StreamJob> = jres?.jobs ?? {};
  serverOnline = jres !== null;
  lastJobs = jobs;

  const hasRunning = Object.values(jobs).some((j) => j.status === 'running' || j.status === 'queued');
  const sig = JSON.stringify([
    streams.map((s) => [s.key, s.started, s.jobId, s.probed, (s.meta?.formats || []).length, s.meta?.is_live, !!s.meta?.thumbnail, s.meta?.title, s.hits, s.title]),
    Object.values(jobs).map((j) => [j.id, j.status, Math.round(j.progress || 0), j.downloaded_bytes, j.save_path]),
    hasRunning ? Math.floor(Date.now() / 1000) : 0, // tick the live elapsed clock each second
  ]);
  if (sig === lastSig && openMenu === null) return; // avoid rebuilds (keeps dropdowns stable)
  lastSig = sig;
  render(streams, jobs);
}

// ---- interactions -----------------------------------------------------------
cardsEl.addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest('select[data-fmt]') as HTMLSelectElement | null;
  if (sel) selectedFormat.set(sel.getAttribute('data-fmt')!, sel.value);
});

cardsEl.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const card = btn.closest('.card') as HTMLElement | null;
  const key = card?.getAttribute('data-key') || '';
  closeMenu();

  if (act === 'remove') { await send({ kind: 'streams:remove', key, tabId }); lastSig = ''; poll(); }
  else if (act === 'rename') {
    const cur = customTitle.get(key) || '';
    const v = window.prompt('Rename this download', cur);
    if (v != null) { customTitle.set(key, v.trim()); lastSig = ''; poll(); }
  }
  else if (act === 'start') {
    const main = btn as HTMLButtonElement;
    main.disabled = true; main.querySelector('span')!.textContent = 'Starting…';
    const res = await send({ kind: 'streams:start', key, tabId, formatId: selectedFormat.get(key) || undefined, title: customTitle.get(key) });
    if (!res?.ok) {
      main.disabled = false; main.querySelector('span')!.textContent = 'Retry'; main.style.background = '#b91c1c';
      toast(`Download failed: ${res?.error || 'unknown error'}`, 'err');
    }
    lastSig = ''; setTimeout(poll, 300);
  }
  else if (act === 'stop') {
    // Cancel (live) has no inner <span>; Stop (VOD) does — handle both.
    const sp = btn.querySelector('span');
    if (sp) sp.textContent = 'Stopping…'; else (btn as HTMLElement).textContent = 'Stopping…';
    (btn as HTMLButtonElement).disabled = true;
    const r = await send({ kind: 'jobs:stop', jobId: btn.getAttribute('data-job')! });
    toast(r?.stopped ? 'Stopping — finalizing the recording…' : 'Stop sent', 'ok');
    lastSig = ''; setTimeout(poll, 600);
  }
  else if (act === 'jobdelete') { await send({ kind: 'jobs:delete', jobId: btn.getAttribute('data-job')! }); lastSig = ''; poll(); }
  else if (act === 'open') {
    const p = btn.getAttribute('data-path')!;
    await openLocal(p, btn);
  }
  else if (act === 'menu') {
    const s = key;
    const menu = document.createElement('div');
    menu.className = 'menu';
    safeHTML(menu,
      `<button data-m="copy">${icon('copy', 14)} Copy stream URL</button>` +
      `<button data-m="open">${icon('external', 14)} Open in new tab</button>`);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - r.right}px`;
    document.body.appendChild(menu);
    openMenu = menu;
    menu.addEventListener('click', async (ev) => {
      const m = (ev.target as HTMLElement).closest('[data-m]')?.getAttribute('data-m');
      const streams: DetectedStream[] = (await send({ kind: 'streams:get', tabId }))?.streams ?? [];
      const st = streams.find((x) => x.key === s);
      if (st) {
        if (m === 'copy') await navigator.clipboard.writeText(st.url).catch(() => { });
        else if (m === 'open') ext.tabs.create({ url: st.url });
      }
      closeMenu();
    });
  }
});
document.addEventListener('click', (e) => {
  if (openMenu && !(e.target as HTMLElement).closest('.menu') && !(e.target as HTMLElement).closest('[data-act="menu"]')) closeMenu();
});

// ---- toolbar ----------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
safeHTML($('tb-gear'), icon('gear', 18));
safeHTML($('tb-refresh'), icon('refresh', 18));
safeHTML($('tb-folder'), icon('folder', 18));
safeHTML($('tb-clear'), icon('trash', 18));
safeHTML($('tb-help'), icon('help', 18));

let openPop: HTMLElement | null = null;
function closePop() { openPop?.remove(); openPop = null; }
function showPop(anchor: HTMLElement, html: string): HTMLElement {
  closePop();
  const pop = document.createElement('div');
  pop.className = 'pop';
  safeHTML(pop, html);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8));
  pop.style.left = `${left}px`;
  openPop = pop;
  return pop;
}
document.addEventListener('click', (e) => {
  if (openPop && !(e.target as HTMLElement).closest('.pop') && !(e.target as HTMLElement).closest('.tb')) closePop();
});

// Refresh — spin + immediate re-poll
$('tb-refresh').addEventListener('click', () => {
  const b = $('tb-refresh'); b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  lastSig = ''; poll();
});

// Open downloads folder
$('tb-folder').addEventListener('click', async () => {
  await requestReveal({ kind: 'open:folder' }, $('tb-folder'));
});

// Clear — detections on this tab + finished jobs
$('tb-clear').addEventListener('click', async () => {
  await send({ kind: 'streams:clear', tabId });
  const finished = Object.values(lastJobs).filter((j) => j.type === 'stream' && ['completed', 'failed', 'aborted'].includes(j.status));
  for (const j of finished) await send({ kind: 'jobs:delete', jobId: j.id });
  lastSig = ''; poll();
  toast(finished.length ? `Cleared detections + ${finished.length} finished job(s)` : 'Cleared detections', 'ok');
});

// No video? — re-capture (reloads the tab so its media requests fire again)
$('tb-novideo').addEventListener('click', async () => {
  toast('Re-capturing — reloading the tab…');
  await send({ kind: 'streams:recapture', tabId });
  setTimeout(() => window.close(), 400);
});

// Settings
$('tb-gear').addEventListener('click', async () => {
  if (openPop) return closePop();
  const dot = serverOnline ? '#22c55e' : '#ef4444';
  const cfg = await send({ kind: 'config:get' });
  const proxy = esc(cfg?.proxy || '');

  const keys = await ext.storage.local.get([
    'zipper-server-download-enabled',
    'zipper-rclone-enabled',
    'zipper-highlight-enabled',
    'zipper-upscale-enabled',
    'zipper-upscale-model'
  ]);
  const rcloneEnabled = keys['zipper-rclone-enabled'] === 'true';
  const serverDownloadEnabled = keys['zipper-server-download-enabled'] === 'true';
  const highlightEnabled = keys['zipper-highlight-enabled'] !== 'false';
  const upscaleEnabled = keys['zipper-upscale-enabled'] === 'true';
  const upscaleModel = keys['zipper-upscale-model'] || '4xNomos8k_atd';

  const pop = showPop($('tb-gear'),
    `<h4>Settings</h4>
     <div style="display:flex;gap:16px;">
       <div class="kv" style="flex:1;margin:0;"><span>Server</span><b><span class="dotc" style="background:${dot}"></span> ${serverOnline ? 'online' : 'offline'}</b></div>
       <div class="kv" style="flex:1;margin:0;"><span>Endpoint</span><b>127.0.0.1:5171</b></div>
     </div>
     <div style="display:flex;gap:16px;margin-top:4px;">
       <div class="kv" style="flex:1;margin:0;"><span>Version</span><b>${ext.runtime.getManifest().version}</b></div>
       <div class="kv" style="flex:1;margin:0;"><span>Saves to</span><b>.downloaded/</b></div>
     </div>
     
     <div style="display:flex;gap:16px;margin-top:8px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">
       <div class="kv" style="flex:1;margin:0;align-items:center;">
         <span>Server Downloads</span>
         <input type="checkbox" id="cfg-server-download" ${serverDownloadEnabled ? 'checked' : ''} style="cursor:pointer;" />
       </div>
       <div class="kv" style="flex:1;margin:0;align-items:center;">
         <span>Cloud Handoff (rclone)</span>
         <input type="checkbox" id="cfg-rclone" ${rcloneEnabled ? 'checked' : ''} style="cursor:pointer;" />
       </div>
     </div>
     <div style="display:flex;gap:16px;margin-top:4px;">
       <div class="kv" style="flex:1;margin:0;align-items:center;">
         <span>DOM Highlights</span>
         <input type="checkbox" id="cfg-highlights" ${highlightEnabled ? 'checked' : ''} style="cursor:pointer;" />
       </div>
       <div class="kv" style="flex:1;margin:0;align-items:center;">
         <span>AI Upscaling (4x)</span>
         <input type="checkbox" id="cfg-upscale" ${upscaleEnabled ? 'checked' : ''} style="cursor:pointer;" />
       </div>
     </div>
     <div style="display:flex;gap:16px;margin-top:4px;">
       <div class="kv" style="flex:1;margin:0;align-items:center;">
         <span>Upscale Model</span>
         <select id="cfg-upscale-model" style="background:#2a2a2e;color:#e6e6e8;border:1px solid #3f3f46;border-radius:4px;padding:2px 4px;font-size:10px;cursor:pointer;">
           <option value="4xNomos8k_atd" ${upscaleModel === '4xNomos8k_atd' ? 'selected' : ''}>Nomos8k</option>
           <option value="pillow-lanczos" ${upscaleModel === 'pillow-lanczos' ? 'selected' : ''}>Pillow 4x</option>
         </select>
       </div>
       <div style="flex:1;"></div>
     </div>

     <label style="display:block;margin-top:10px;color:#a1a1aa;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">Download proxy (yt-dlp)</label>
     <div class="row" style="margin-top:4px;">
       <input id="cfg-proxy" type="text" placeholder="socks5h://10.64.0.1:1080" value="${proxy}"
         style="flex:1;background:#2a2a2e;border:1px solid #3f3f46;color:#e6e6e8;border-radius:7px;padding:6px 8px;font-size:11px;" />
       <button class="pbtn" data-p="saveproxy" style="flex:0 0 auto;">Save</button>
     </div>
     <div class="row">
       <button class="pbtn" data-p="folder">Open downloads</button>
       <button class="pbtn" data-p="clearjobs">Clear finished jobs</button>
     </div>`);

  pop.addEventListener('change', async (ev) => {
    const target = ev.target as HTMLElement;
    if (target.id === 'cfg-server-download') {
      const checked = (target as HTMLInputElement).checked;
      await ext.storage.local.set({ 'zipper-server-download-enabled': String(checked) });
      toast(checked ? 'Server downloads enabled' : 'Server downloads disabled (Standalone)', 'ok');
    } else if (target.id === 'cfg-rclone') {
      const checked = (target as HTMLInputElement).checked;
      await ext.storage.local.set({ 'zipper-rclone-enabled': String(checked) });
      toast(checked ? 'RClone handoff enabled' : 'RClone handoff disabled', 'ok');
    } else if (target.id === 'cfg-highlights') {
      const checked = (target as HTMLInputElement).checked;
      await ext.storage.local.set({ 'zipper-highlight-enabled': String(checked) });
      toast(checked ? 'DOM Highlights enabled' : 'DOM Highlights disabled', 'ok');
    } else if (target.id === 'cfg-upscale') {
      const checked = (target as HTMLInputElement).checked;
      await ext.storage.local.set({ 'zipper-upscale-enabled': String(checked) });
      toast(checked ? 'Upscaling enabled' : 'Upscaling disabled', 'ok');
    } else if (target.id === 'cfg-upscale-model') {
      const val = (target as HTMLSelectElement).value;
      await ext.storage.local.set({ 'zipper-upscale-model': val });
      toast(`Upscale model: ${val}`, 'ok');
    }
  });

  pop.addEventListener('click', async (ev) => {
    const p = (ev.target as HTMLElement).closest('[data-p]')?.getAttribute('data-p');
    if (!p) return;
    if (p === 'saveproxy') {
      const val = (pop.querySelector('#cfg-proxy') as HTMLInputElement).value.trim();
      await send({ kind: 'config:set', proxy: val });
      toast(val ? `Proxy set — ${val}` : 'Proxy cleared', 'ok');
      closePop();
      return;
    }
    if (p === 'folder') {
      const trigger = (ev.target as HTMLElement).closest('[data-p]');
      await requestReveal({ kind: 'open:folder' }, trigger);
    }
    else if (p === 'clearjobs') {
      const finished = Object.values(lastJobs).filter((j) => j.type === 'stream' && ['completed', 'failed', 'aborted'].includes(j.status));
      for (const j of finished) await send({ kind: 'jobs:delete', jobId: j.id });
      lastSig = ''; poll(); toast(`Cleared ${finished.length} job(s)`, 'ok');
    }
    closePop();
  });
});

// Help
$('tb-help').addEventListener('click', () => {
  if (openPop) return closePop();
  showPop($('tb-help'),
    `<h4>How to use</h4>
     <ol>
       <li>Play the video on the page.</li>
       <li>Pick a quality, then hit Download.</li>
       <li>Live streams: Cancel finalizes &amp; saves the recording.</li>
       <li>Nothing showing? Hit “No video?” to re-capture.</li>
     </ol>
     <div class="kv" style="margin-top:8px;"><span>Downloads land in</span><b>.downloaded/streams</b></div>`);
});

// ---- boot -------------------------------------------------------------------
(async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  currentTabUrl = tab?.url || '';
  await poll();
  setInterval(poll, 1000); // only runs while the popup is open
})();
