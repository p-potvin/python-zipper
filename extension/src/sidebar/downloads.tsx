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

interface RemoteInfo {
  remote: string;
  name: string;
  priority: number;
  /** null when rclone itself is missing, so "unknown" and "wrong" stay apart. */
  configured: boolean | null;
  about: { total?: number; used?: number; free?: number; trashed?: number } | null;
}

/** One worker's last storage report — the shape ds_storage.storage_report() builds. */
interface Report {
  disk: { path: string; total: number; used: number; free: number; error?: string };
  staged: { bytes: number; files: number };
  rclone: {
    available: boolean;
    enabled: boolean;
    remotes: RemoteInfo[];
    known: string[];
    config_path: string;
  };
}

/**
 * A machine that does downloads.
 *
 * Storage is per worker rather than per server because that is where files
 * actually land, and there is more than one: the workstation and the OVH box
 * have entirely different disks, and the 50GB SSD on the VPS is the one that
 * fills up. Reports arrive on the worker's own heartbeat, so a machine that is
 * currently off still has a last-known state here — labelled with its age
 * rather than presented as current.
 */
interface Worker {
  name: string;
  host?: string;
  platform?: string;
  dest_dir?: string;
  storage: Report;
  seen_at: string;
  age_seconds: number;
  stale: boolean;
}

export const workers = signal<Worker[]>([]);
export const storageError = signal('');

let timer: ReturnType<typeof setTimeout> | null = null;
let visible = false;

export function setDownloadsVisible(v: boolean): void {
  visible = v;
  if (v) {
    void refreshJobs();
    if (!workers.value.length) void refreshStorage();
  }
}

export async function refreshJobs(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'jobs:get' });
    if (res && !res.error && res.jobs !== undefined) {
      serverOnline.value = true;
      // Probes and previews are internal errands, not downloads. They share the
      // jobs table because they share the worker, but listing them here meant
      // that opening a stream page instantly showed two failed "downloads" that
      // nobody had asked for — and a probe failing is not a download failing.
      jobs.value = (Object.values(res.jobs || {}) as StreamJob[])
        .filter((j) => j.kind !== 'probe' && j.kind !== 'preview');
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
 * Storage is polled far more slowly than jobs.
 *
 * Each refresh asks every remote how full it is, which is a network round trip
 * per provider. Free space on a 5TB drive is not a live number and does not
 * deserve to be treated as one — the server caches for a minute and this asks
 * roughly that often.
 */
export async function refreshStorage(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'storage:get' });
    if (res?.ok) {
      workers.value = res.workers || [];
      storageError.value = '';
    } else {
      workers.value = [];
      storageError.value = res?.error || 'could not reach the API';
    }
  } catch (e: any) {
    workers.value = [];
    storageError.value = String(e?.message || e);
  }
}

async function reorderRemote(worker: Worker, name: string, delta: number): Promise<void> {
  const list = worker.storage.rclone.remotes.map((r) => r.remote);
  const i = list.findIndex((r) => r.split(':')[0] === name);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await pushRclone(worker.name, { remotes: list });
}

async function setRcloneEnabled(worker: Worker, on: boolean): Promise<void> {
  await pushRclone(worker.name, { enabled: on });
}

/**
 * Config travels to the worker through the API, not directly.
 *
 * So it does not take effect on the spot — the worker applies it on its next
 * heartbeat, which is also why a change made while that machine is off is kept
 * rather than lost. Saying so is the honest thing: the panel would otherwise
 * look broken for the minute before the numbers move.
 */
async function pushRclone(
  worker: string,
  patch: { remotes?: string[]; enabled?: boolean },
): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'rclone:config:set', worker, ...patch });
    pending.value = res?.ok
      ? `Saved — ${worker} applies it on its next heartbeat`
      : (res?.error || 'could not save');
  } catch (e: any) {
    pending.value = String(e?.message || e);
  }
  setTimeout(() => { pending.value = ''; }, 6000);
  await refreshStorage();
}

const pending = signal('');

/**
 * Adaptive polling. A sidebar can sit open all day, so a flat 2s poll against
 * the server would run tens of thousands of times for nothing. Fast only when
 * you're looking at the tab or something is actually running; otherwise slow
 * enough to keep the header LED honest without the traffic.
 */
let storageAt = 0;

function tick(): void {
  const hasActive = jobs.value.some(
    (j: any) => j.status === 'running' || j.status === 'queued');
  const period = (visible || hasActive) ? 2000 : 12000;
  timer = setTimeout(() => {
    void refreshJobs().then(() => {
      // Piggy-backed on the job poll rather than given its own timer, but on
      // its own much slower clock.
      if (visible && Date.now() - storageAt > 60_000) {
        storageAt = Date.now();
        void refreshStorage();
      }
      tick();
    });
  }, period);
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
  // page_url, not url: the API row records the page a job came from, and the
  // links themselves live in an array rather than a single field.
  if (j.page_domain) return j.page_domain;
  if (j.page_url) {
    try { return new URL(j.page_url).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
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

function pct(used?: number, total?: number): number {
  if (!used || !total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

/** Join a worker's directory with a filename, in that directory's own style. */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

/**
 * Open a finished file in Explorer.
 *
 * The native host runs on this machine, so a job that ran on another worker
 * simply fails to resolve — and that failure is the useful answer, reported
 * rather than swallowed. Which is why the button is offered whenever there is a
 * local path to try, instead of being hidden behind a guess about where the job
 * ran.
 */
async function reveal(path: string): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'open:path', path });
    revealError.value = res?.ok ? '' : (res?.error || 'Could not open that location');
  } catch (e: any) {
    revealError.value = String(e?.message || e);
  }
  if (revealError.value) setTimeout(() => { revealError.value = ''; }, 6000);
}

export const revealError = signal('');

async function openFolder(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'open:folder' });
    revealError.value = res?.ok ? '' : (res?.error || 'Could not open the download folder');
  } catch (e: any) {
    revealError.value = String(e?.message || e);
  }
  if (revealError.value) setTimeout(() => { revealError.value = ''; }, 6000);
}

// ---- view -------------------------------------------------------------------

function ServerJob({ j }: { j: any }) {
  const pct = jobProgress(j);
  const running = j.status === 'running' || j.status === 'queued';
  const archives: string[] = j.archives || [];
  // Only offer to open it if there is still something on a disk to open. Once
  // rclone has moved the files, the local path is gone and the destination tag
  // below is the honest answer instead.
  const local = !!j.save_dir && !(j.rclone_remotes || []).length;

  return (
    <li class="job">
      <div class="job-top">
        <span class={`led led-${ledFor(j.status)}`}>{j.status}</span>
        <span class="job-name" title={j.page_url || ''}>{jobLabel(j)}</span>
      </div>

      {running ? (
        <div class="job-bar"><div class="job-fill" style={`width:${Math.max(2, pct)}%`} /></div>
      ) : null}

      <div class="job-meta">
        {j.total_links ? <span>{j.processed_links || 0}/{j.total_links} links</span> : null}
        {j.bytes_done ? <span>{fmtBytes(j.bytes_done)}</span> : null}
        {j.claimed_by ? <span title="worker that ran this">{j.claimed_by}</span> : null}
        {fmtSpeed(j.speed) ? <span>{fmtSpeed(j.speed)}</span> : null}
        {fmtEta(j.eta) ? <span>{fmtEta(j.eta)}</span> : null}
        {running ? <span>{pct}%</span> : null}
        <span class="cell-spring" />
        {running ? <button class="lnk" onClick={() => void stopJob(j.id)}>Stop</button> : null}
        {!running ? <button class="lnk" onClick={() => void deleteJob(j.id)}>Clear</button> : null}
      </div>

      {archives.length ? (
        <div class="job-archives">
          {archives.map((a: string) => (
            local ? (
              <button key={a} class="archive archive-open" title={`Show ${a} in Explorer`}
                      onClick={() => void reveal(joinPath(j.save_dir, a))}>
                {a}
              </button>
            ) : <span key={a} class="archive">{a}</span>
          ))}
        </div>
      ) : null}

      {j.status === 'completed' ? <Landed j={j} /> : null}

      {j.error ? <div class="job-err">{j.error}</div> : null}
    </li>
  );
}

/**
 * Where a finished job's files actually are.
 *
 * "Server" was the wrong word and it did real damage. Queuing a job runs it on
 * the python worker, which is normally *this machine* — so labelling every
 * queued job "on server disk" while printing a local drive path was both
 * self-contradictory and the reason the files stopped being openable: the UI
 * had talked itself out of offering a reveal for paths that were sitting right
 * there.
 *
 * The only thing that genuinely moves a file off this machine is a confirmed
 * rclone handoff, so that is the only thing treated as remote. No handoff
 * recorded means local — which is also the right default when the rclone
 * setting is off and no handoff was ever going to happen.
 */
function Landed({ j }: { j: any }) {
  const remotes: string[] = j.rclone_remotes || [];
  const local: string = j.local_dir || j.save_dir || '';
  return (
    <div class="job-dest">
      {remotes.length ? (
        <>
          <span class="dest-tag dest-remote">moved</span>
          <span class="dest-where">
            {remotes.map((r) => r.split(':')[0]).join(' + ')}
          </span>
        </>
      ) : (
        <>
          <span class="dest-tag dest-local">on disk</span>
          {local ? (
            <button class="dest-where dest-open" title={`Open ${local} in Explorer`}
                    onClick={() => void reveal(local)}>{local}</button>
          ) : null}
        </>
      )}
    </div>
  );
}

function fmtAge(seconds: number): string {
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function Remote({ r, w }: { r: RemoteInfo; w: Worker }) {
  const a = r.about;
  const used = pct(a?.used, a?.total);
  return (
    <li class="remote">
      <div class="remote-top">
        <span class="remote-order">{r.priority + 1}</span>
        <span class="remote-name">{r.name}</span>
        {r.configured === false
          ? <span class="led led-alert">unknown to rclone</span>
          : null}
        <span class="cell-spring" />
        <button class="lnk" title="Higher priority"
                disabled={r.priority === 0}
                onClick={() => void reorderRemote(w, r.name, -1)}>↑</button>
        <button class="lnk" title="Lower priority"
                disabled={r.priority === w.storage.rclone.remotes.length - 1}
                onClick={() => void reorderRemote(w, r.name, 1)}>↓</button>
      </div>
      {a ? (
        <>
          <div class="job-bar"><div class="job-fill" style={`width:${Math.max(2, used)}%`} /></div>
          <div class="job-meta">
            <span>{fmtBytes(a.free)} free</span>
            <span>of {fmtBytes(a.total)}</span>
            {a.trashed ? <span>{fmtBytes(a.trashed)} trashed</span> : null}
            <span class="cell-spring" />
            <span>{used}%</span>
          </div>
        </>
      ) : (
        <div class="job-meta">
          <span>{r.configured === false
            ? 'not in rclone.conf — files will never reach it'
            : 'this backend does not report free space'}</span>
        </div>
      )}
    </li>
  );
}

/**
 * The storage panel.
 *
 * Answers the question a download raises and the job list never could: is
 * there room for the next one, and where is it going to go.
 */
/** One machine: its landing disk, what is staged on it, and its remotes. */
function WorkerCard({ w }: { w: Worker }) {
  const r = w.storage || ({} as Report);
  const d = r.disk;
  const used = d ? pct(d.used, d.total) : 0;
  const rc = r.rclone;

  return (
    <div class="worker">
      <div class="worker-head">
        <span class={`led led-${w.stale ? 'warning' : 'online'}`}>
          {w.stale ? 'quiet' : 'live'}
        </span>
        <span class="remote-name">{w.name}</span>
        <span class="cell-spring" />
        <span class="store-note" title={w.seen_at}>{fmtAge(w.age_seconds)}</span>
      </div>

      {d ? (
        <div class="store">
          <div class="job-top">
            <span class="remote-name">landing disk</span>
            <span class="cell-spring" />
            <span class="store-path" title={d.path}>{d.path}</span>
          </div>
          <div class="job-bar"><div class="job-fill" style={`width:${Math.max(2, used)}%`} /></div>
          <div class="job-meta">
            <span>{fmtBytes(d.free)} free</span>
            <span>of {fmtBytes(d.total)}</span>
            <span class="cell-spring" />
            <span>{used}%</span>
          </div>
          {r.staged?.files ? (
            <div class="job-meta">
              <span>{r.staged.files} file(s) staged</span>
              <span>{fmtBytes(r.staged.bytes)}</span>
              <span class="cell-spring" />
              <span class="store-note">
                {rc?.enabled ? 'waiting on rclone' : 'rclone handoff is off'}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {rc ? (
        <>
          <label class="opt">
            <input type="checkbox" checked={rc.enabled}
                   onChange={(e) => void setRcloneEnabled(w, (e.currentTarget as HTMLInputElement).checked)} />
            <span class="opt-text">
              <span class="opt-label">Hand finished files to rclone</span>
              <span class="opt-hint">
                {rc.available
                  ? "Off keeps everything on this machine's own disk."
                  : 'rclone is not installed here — files stay local regardless.'}
              </span>
            </span>
          </label>

          {rc.remotes?.length ? (
            <ul class="remotes">
              {rc.remotes.map((x) => <Remote key={x.remote} r={x} w={w} />)}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Storage, per machine.
 *
 * There is no single "the disk" any more, and there never really was: the
 * workstation and the VPS have different volumes, different rclone configs and
 * very different amounts of room. The VPS's 50GB SSD is the one that filled up
 * and froze the box, and it is about a seventh the size of the workstation's —
 * an average across both would have hidden exactly the problem worth seeing.
 */
function StoragePanel() {
  const ws = workers.value;
  const err = storageError.value;

  return (
    <>
      <div class="sect">
        Storage
        <span class="sect-note">
          {ws.length ? `${ws.length} worker${ws.length === 1 ? '' : 's'}` : 'per worker'}
        </span>
      </div>

      {pending.value ? <div class="hint">{pending.value}</div> : null}

      {err ? <div class="cap-err">{err}</div> : null}

      {!err && !ws.length ? (
        <div class="hint">
          No worker has reported yet. Storage arrives on a worker's heartbeat, so
          this fills in once one is running and pointed at the API.
        </div>
      ) : null}

      {ws.map((w) => <WorkerCard key={w.name} w={w} />)}
    </>
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
  // created_at arrives as an ISO string from Postgres, not the epoch number
  // the local server used. Subtracting strings yields NaN and leaves the list
  // in whatever order it came in, which looked like the sort simply not working.
  const ts = (j: any) => Date.parse(j.created_at || '') || 0;
  const js = jobs.value.slice().sort((a: any, b: any) => ts(b) - ts(a));
  const active = js.filter((j: any) => j.status === 'running' || j.status === 'queued');
  const done = js.filter((j: any) => j.status !== 'running' && j.status !== 'queued');
  const dls = browserDls.value;

  return (
    <div class="cap">
      <div class="cap-bar">
        <span class={`led led-${serverOnline.value === null ? 'idle' : serverOnline.value ? 'online' : 'alert'}`}>
          {serverOnline.value === null ? 'checking' : serverOnline.value ? 'api up' : 'api down'}
        </span>
        <span class="cell-spring" />
        <button class="lnk" title="Open the download folder in Explorer"
                onClick={() => void openFolder()}>Folder</button>
        <button class="lnk" onClick={() => { void refreshJobs(); void refreshStorage(); }}>
          Refresh
        </button>
      </div>

      {revealError.value ? <div class="cap-err">{revealError.value}</div> : null}

      {serverOnline.value === false ? (
        <div class="cap-err">
          The VaultWares API is unreachable. Queuing work will fail, and no job
          state is visible until it's back — check the key and that this machine
          is on the tailnet (Settings).
        </div>
      ) : null}

      {active.length ? (
        <>
          <div class="sect">Active<span class="sect-note">on the worker</span></div>
          <ul class="jobs">{active.map((j: any) => <ServerJob key={j.id} j={j} />)}</ul>
        </>
      ) : null}

      {done.length ? (
        <>
          <div class="sect">Recent<span class="sect-note">on the worker</span></div>
          <ul class="jobs">{done.slice(0, 12).map((j: any) => <ServerJob key={j.id} j={j} />)}</ul>
        </>
      ) : null}

      {dls.length ? (
        <>
          <div class="sect">
            Saved by the browser &middot; {dls.length}
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

      <StoragePanel />
    </div>
  );
}
