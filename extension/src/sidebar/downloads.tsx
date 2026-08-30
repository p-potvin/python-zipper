/**
 * Downloads tab.
 *
 * Two queues live here because they genuinely behave differently:
 *
 *   - **Server jobs** (`/api/jobs`) — batched, zipped, progress-tracked. A
 *     gallery sent here becomes one job with one archive.
 *   - **Browser downloads** — one entry per file, no batching, no zip. Fine for
 *     a handful; sending eighty of these is what floods the download history.
 *
 * Showing them side by side is deliberate: the difference between the two
 * routes is the thing that was invisible before, and it is exactly what makes
 * "why didn't it zip?" answerable at a glance.
 */

import { signal } from '@preact/signals';
import { ext } from '../common/api';
import type { StreamJob } from '../common/types';

export const serverOnline = signal<boolean | null>(null);
export const jobs = signal<StreamJob[]>([]);
export const browserDls = signal<any[]>([]);

let timer: ReturnType<typeof setTimeout> | null = null;
let visible = false;

export function setDownloadsVisible(v: boolean): void {
  visible = v;
  if (v) void refreshJobs();
}

export async function refreshJobs(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'jobs:get' });
    if (res && !res.error && res.jobs !== undefined) {
      serverOnline.value = true;
      jobs.value = Object.values(res.jobs || {}) as StreamJob[];
    } else {
      serverOnline.value = false;
      jobs.value = [];
    }
  } catch {
    serverOnline.value = false;
    jobs.value = [];
  }

  try {
    const res = await ext.runtime.sendMessage({ kind: 'downloads:list' });
    browserDls.value = (res?.downloads || []).slice(0, 20);
  } catch { browserDls.value = []; }
}

/**
 * Adaptive polling. A sidebar can sit open all day, so a flat 2s poll against
 * the server would run tens of thousands of times for nothing. Fast only when
 * you're looking at the tab or something is actually running; otherwise slow
 * enough to keep the header LED honest without the traffic.
 */
function tick(): void {
  const hasActive = jobs.value.some(
    (j: any) => j.status === 'running' || j.status === 'queued');
  const period = (visible || hasActive) ? 2000 : 12000;
  timer = setTimeout(() => { void refreshJobs().then(tick); }, period);
}

export function startJobPolling(): void {
  if (timer) return;
  void refreshJobs().then(tick);
}

export function stopJobPolling(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

// ---- formatting -------------------------------------------------------------

function fmtBytes(n?: number | null): string {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function fmtSpeed(n?: number | null): string {
  return n ? `${fmtBytes(n)}/s` : '';
}

function fmtEta(s?: number | null): string {
  if (!s || s < 0) return '';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function ledFor(status: string): string {
  if (status === 'running') return 'relay';
  if (status === 'queued') return 'sync';
  if (status === 'completed') return 'online';
  if (status === 'failed') return 'alert';
  if (status === 'aborted') return 'warning';
  return 'idle';
}

/** Batch jobs report link counts; stream jobs report a percentage. */
function jobProgress(j: any): number {
  if (typeof j.progress === 'number' && j.progress > 0) return j.progress;
  if (j.total_links) return Math.round((j.processed_links || 0) / j.total_links * 100);
  return 0;
}

function jobLabel(j: any): string {
  if (j.title) return j.title;
  if (j.url) {
    try { return new URL(j.url).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
  }
  return j.id || 'job';
}

// ---- actions ----------------------------------------------------------------

async function stopJob(id: string): Promise<void> {
  try { await ext.runtime.sendMessage({ kind: 'jobs:stop', jobId: id }); } catch { /* ignore */ }
  void refreshJobs();
}

async function deleteJob(id: string): Promise<void> {
  try { await ext.runtime.sendMessage({ kind: 'jobs:delete', jobId: id }); } catch { /* ignore */ }
  void refreshJobs();
}

async function revealPath(path: string): Promise<void> {
  try { await ext.runtime.sendMessage({ kind: 'open:path', path }); } catch { /* ignore */ }
}

async function openFolder(): Promise<void> {
  try { await ext.runtime.sendMessage({ kind: 'open:folder' }); } catch { /* ignore */ }
}

// ---- view -------------------------------------------------------------------

function ServerJob({ j }: { j: any }) {
  const pct = jobProgress(j);
  const running = j.status === 'running' || j.status === 'queued';
  const archives: string[] = j.archives || [];

  return (
    <li class="job">
      <div class="job-top">
        <span class={`led led-${ledFor(j.status)}`}>{j.status}</span>
        <span class="job-name" title={j.url || ''}>{jobLabel(j)}</span>
      </div>

      {running ? (
        <div class="job-bar"><div class="job-fill" style={`width:${Math.max(2, pct)}%`} /></div>
      ) : null}

      <div class="job-meta">
        {j.total_links ? <span>{j.processed_links || 0}/{j.total_links} links</span> : null}
        {j.images_count ? <span>{j.images_count} img</span> : null}
        {j.downloaded_bytes ? <span>{fmtBytes(j.downloaded_bytes)}</span> : null}
        {fmtSpeed(j.speed) ? <span>{fmtSpeed(j.speed)}</span> : null}
        {fmtEta(j.eta) ? <span>{fmtEta(j.eta)}</span> : null}
        {running ? <span>{pct}%</span> : null}
        <span class="cell-spring" />
        {running ? <button class="lnk" onClick={() => void stopJob(j.id)}>Stop</button> : null}
        {!running ? <button class="lnk" onClick={() => void deleteJob(j.id)}>Clear</button> : null}
      </div>

      {archives.length ? (
        <div class="job-archives">
          {archives.map((a: string, i: number) => (
            <button key={a} class="archive" title="Reveal in Explorer"
                    onClick={() => void revealPath((j.archive_paths || [])[i] || a)}>
              {a}
            </button>
          ))}
        </div>
      ) : null}

      {j.error ? <div class="job-err">{j.error}</div> : null}
    </li>
  );
}

function BrowserDl({ d }: { d: any }) {
  const pct = d.totalBytes ? Math.round((d.bytesReceived / d.totalBytes) * 100) : 0;
  const name = (d.filename || '').split(/[\\/]/).pop() || d.filename || 'file';
  return (
    <li class="job job-thin">
      <div class="job-top">
        <span class={`led led-${d.state === 'complete' ? 'online' : d.state === 'interrupted' ? 'alert' : 'relay'}`}>
          {d.state === 'in_progress' ? `${pct}%` : d.state}
        </span>
        <span class="job-name" title={d.filename}>{name}</span>
      </div>
    </li>
  );
}

export function DownloadsTab() {
  const js = jobs.value.slice().sort((a: any, b: any) => (b.created_at || 0) - (a.created_at || 0));
  const active = js.filter((j: any) => j.status === 'running' || j.status === 'queued');
  const done = js.filter((j: any) => j.status !== 'running' && j.status !== 'queued');
  const dls = browserDls.value;

  return (
    <div class="cap">
      <div class="cap-bar">
        <span class={`led led-${serverOnline.value === null ? 'idle' : serverOnline.value ? 'online' : 'alert'}`}>
          {serverOnline.value === null ? 'checking' : serverOnline.value ? 'server up' : 'server down'}
        </span>
        <span class="cell-spring" />
        <button class="lnk" onClick={() => void openFolder()}>Folder</button>
        <button class="lnk" onClick={() => void refreshJobs()}>Refresh</button>
      </div>

      {serverOnline.value === false ? (
        <div class="cap-err">
          Server unreachable on :5171. Sending to Server will fail, and nothing
          will be zipped or tracked until it's back.
        </div>
      ) : null}

      {active.length ? (
        <>
          <div class="sect">Server &middot; active</div>
          <ul class="jobs">{active.map((j: any) => <ServerJob key={j.id} j={j} />)}</ul>
        </>
      ) : null}

      {done.length ? (
        <>
          <div class="sect">Server &middot; recent</div>
          <ul class="jobs">{done.slice(0, 12).map((j: any) => <ServerJob key={j.id} j={j} />)}</ul>
        </>
      ) : null}

      {dls.length ? (
        <>
          <div class="sect">
            Browser &middot; {dls.length}
            <span class="sect-note">one entry per file, never zipped</span>
          </div>
          <ul class="jobs">{dls.map((d: any) => <BrowserDl key={d.id} d={d} />)}</ul>
        </>
      ) : null}

      {!active.length && !done.length && !dls.length ? (
        <div class="empty">
          <h2>Nothing downloading</h2>
          <p>Server jobs and browser downloads both show up here once something is running.</p>
        </div>
      ) : null}
    </div>
  );
}
