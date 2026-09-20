/**
 * Toolbar popup — the access point.
 *
 * Since browsing normally happens with the sidebar closed, this is the surface
 * seen most often. It answers what you'd open it to find out and then gets out
 * of the way: is the stack reachable, is anything downloading, is there
 * anything on this page, and open the sidebar.
 *
 * Opening the sidebar has to happen in the click handler itself —
 * `sidebarAction.open()` requires a user gesture, and awaiting anything first
 * loses it.
 */

import { render } from 'preact';
import { signal } from '@preact/signals';
import { ext } from '../common/api';
import type { DetectedStream, StreamJob } from '../common/types';
import { qualities, activeJobFor, progressLabel } from '../common/streams';
import './popup.css';

const streams = signal<DetectedStream[]>([]);
const jobs = signal<StreamJob[]>([]);
const serverUp = signal<boolean | null>(null);
const logged = signal(0);
const busy = signal('');

// ---- data -------------------------------------------------------------------

async function load(): Promise<void> {
  try {
    const s = await ext.runtime.sendMessage({ kind: 'streams:get' });
    streams.value = s?.streams || [];
  } catch { streams.value = []; }

  try {
    const j = await ext.runtime.sendMessage({ kind: 'jobs:get' });
    const all = Object.values(j?.jobs || {}) as StreamJob[];
    serverUp.value = !!j && !j.error;
    // 'claimed' too: a worker that has taken a job but not yet reported
    // progress is running it, and leaving that state out made a just-started
    // recording briefly look like it had not started at all.
    jobs.value = all.filter((x) => (x.status === 'running' || x.status === 'queued'
      || x.status === 'claimed')
      // Probes and previews are bookkeeping, not downloads — see downloads.tsx.
      && x.kind !== 'probe' && x.kind !== 'preview');
  } catch {
    serverUp.value = false;
    jobs.value = [];
  }

  try {
    const p = await ext.runtime.sendMessage({ kind: 'harvest:peek' });
    logged.value = p?.logged ?? 0;
  } catch { logged.value = 0; }
}

function openSidebar(): void {
  // No await before this call — the gesture must still be live.
  try {
    (ext as any).sidebarAction?.open?.();
    window.close();
  } catch {
    busy.value = 'Could not open the sidebar';
  }
}

/** format_id chosen per stream key, before it is started. */
const picked = signal<Record<string, string>>({});

async function grabStream(key: string): Promise<void> {
  busy.value = 'Starting…';
  try {
    const res = await ext.runtime.sendMessage({
      kind: 'streams:start', key, formatId: picked.value[key] || undefined,
    });
    busy.value = res?.ok ? 'Recording' : (res?.error || 'Failed to start');
  } catch (e: any) {
    busy.value = String(e?.message || e);
  }
  void load();
}

async function stopStream(jobId: string): Promise<void> {
  busy.value = 'Stopping…';
  try {
    const res = await ext.runtime.sendMessage({ kind: 'jobs:stop', jobId });
    busy.value = res?.ok ? 'Stopped' : (res?.error || 'Could not stop it');
  } catch (e: any) {
    busy.value = String(e?.message || e);
  }
  void load();
}

// ---- view -------------------------------------------------------------------

function fmtPct(j: StreamJob): string {
  if (typeof j.progress === 'number') return `${Math.round(j.progress)}%`;
  return j.status;
}

/**
 * One stream, with its qualities and its recording state.
 *
 * The whole point of grouping here: a livestream is one row, not the hundreds
 * of segments it is made of. The sniffer folds variant playlists into their
 * master, and the segments themselves never reach a list at all now — see
 * `isStreamSegment` in the media log.
 */
function Stream({ s }: { s: DetectedStream }) {
  const qs = qualities(s);
  const job = activeJobFor(s, jobs.value);
  const running = !!job;

  return (
    <div class="stream">
      <div class="stream-top">
        <span class="stream-tag">{s.type}</span>
        <span class="stream-title" title={s.url}>{s.title || s.url}</span>
        {s.meta?.is_live ? <span class="led led-alert">live</span> : null}
      </div>

      {qs.length ? (
        <div class="stream-q">
          {qs.map((q) => (
            <button
              key={q.label}
              class={`q${picked.value[s.key] === q.id && q.id ? ' q-on' : ''}`}
              disabled={!q.id}
              title={q.id ? `Record at ${q.label}` : `${q.label} — available once the probe returns`}
              onClick={() => { picked.value = { ...picked.value, [s.key]: q.id }; }}
            >
              {q.label}
            </button>
          ))}
        </div>
      ) : (
        <div class="stream-note">
          {s.probed ? 'no quality list' : 'reading qualities…'}
        </div>
      )}

      {running ? (
        <>
          <div class="bar">
            {job!.bytes_total ? (
              <div class="bar-fill" style={`width:${Math.max(2, Math.round(job!.progress || 0))}%`} />
            ) : (
              <div class="bar-fill bar-fill-live" />
            )}
          </div>
          <div class="stream-foot">
            <span class="row-val">{progressLabel(job!)}</span>
            <span class="pop-spring" />
            <button class="q q-stop" onClick={() => void stopStream(job!.id)}>Stop</button>
          </div>
        </>
      ) : (
        <button class="stream-go" onClick={() => void grabStream(s.key)}>
          Record{picked.value[s.key] ? ' selected' : qs.some((q) => q.id) ? ' best' : ''}
        </button>
      )}
    </div>
  );
}

function ServerLed() {
  if (serverUp.value === null) return <span class="led led-idle">checking</span>;
  return serverUp.value
    ? <span class="led led-online">server</span>
    : <span class="led led-alert">offline</span>;
}

function App() {
  const active = jobs.value;
  const st = streams.value;

  return (
    <div class="pop">
      <div class="pop-hdr">
        <span class="pop-brand">Zipper</span>
        <span class="pop-spring" />
        {active.length ? <span class="led led-relay">{active.length} running</span> : null}
        <ServerLed />
      </div>

      <button class="pop-open" onClick={openSidebar}>Open sidebar</button>

      {active.length ? (
        <div class="pop-rows">
          {active.slice(0, 3).map((j) => (
            <div key={j.id}>
              <div class="row">
                <span class="row-label">{j.title || 'download'}</span>
                <span class="row-val">{fmtPct(j)}</span>
              </div>
              <div class="bar">
                <div class="bar-fill" style={`width:${Math.max(2, Math.round(j.progress || 0))}%`} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {st.length ? (
        <div class="streams">
          {st.map((s) => <Stream key={s.key} s={s} />)}
        </div>
      ) : null}

      <div class="pop-rows">
        <div class="row">
          <span class="row-label">Media seen on this tab</span>
          <span class="row-val">{logged.value}</span>
        </div>
      </div>

      {busy.value ? <div class="muted">{busy.value}</div> : null}

      <div class="pop-foot">
        <button class="foot-btn" onClick={() => void ext.runtime.sendMessage({ kind: 'open:folder' })}>
          Folder
        </button>
        <button class="foot-btn" onClick={() => void ext.runtime.sendMessage({ kind: 'streams:clear' })
          .then(() => load())}>
          Clear
        </button>
        <button class="foot-btn" onClick={() => void load()}>Refresh</button>
      </div>
    </div>
  );
}

void load();
// The popup is short-lived; a slow 2s poll is enough to keep a running download
// ticking while it happens to be open.
setInterval(() => void load(), 2000);

const root = document.getElementById('root');
if (root) render(<App />, root);
