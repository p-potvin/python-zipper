/**
 * Naming a recording after it ends.
 *
 * The worker writes the file under its automatic name, then — when the job
 * asked for it — moves the job to status `naming` with a proposal in
 * `result.naming`, and waits for an answer on the same row until the job's
 * auto-save deadline. This module is the browser half of that handshake:
 *
 *   - notice a job entering `naming`, and say so: a desktop notification, a
 *     toast on the page you are looking at, and a card in the sidebar;
 *   - carry the answer back as status `named` with `result.chosen_name`, or
 *     `result.keep` for "the automatic name is fine".
 *
 * Deliberately not the browser's own save dialog. That is switched off on
 * this machine, and when it is on it opens wherever the browser decides —
 * which for a recording that ended at 3am is nowhere anyone is looking.
 *
 * Polling only while there is something to poll for: a recording running or
 * a name being waited on. An idle browser costs nothing.
 */

import { ext } from '../common/api';
import { Api as VwApi } from '../common/vwapi';

export interface PendingName {
  jobId: string;
  title: string;
  pageUrl: string;
  proposed: string;
  ext: string;
  deadline: number;
  autoSave: boolean;
  timeout: number;
  reason: string;
  label: string;
  username: string;
  site: string;
  duration?: number | null;
  height?: number | null;
  bytes?: number | null;
  resumes?: number;
  recorder?: string;
  /** When this browser first saw the prompt, for a deadline that survives clock skew. */
  seenAt: number;
}

const POLL_MS = 4000;
const pending = new Map<string, PendingName>();
/** Last known status per stream job, so the URL refresher can stay out of the way. */
const statuses = new Map<string, string>();
const announced = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let wanted = false;

export function jobStatus(jobId: string): string | undefined {
  return statuses.get(jobId);
}

export function pendingNames(): PendingName[] {
  return [...pending.values()].sort((a, b) => a.seenAt - b.seenAt);
}

function broadcast(): void {
  try {
    void ext.runtime.sendMessage({ kind: 'naming:changed', pending: pendingNames() })
      .catch(() => { /* no sidebar open */ });
  } catch { /* ignore */ }
}

function fmtDuration(s?: number | null): string {
  if (!s || s <= 0) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(t % 60).padStart(2, '0')}s`;
  return `${t}s`;
}

function reasonText(reason: string): string {
  return reason === 'stopped' ? 'stopped' : 'finished';
}

async function announce(p: PendingName): Promise<void> {
  if (announced.has(p.jobId)) return;
  announced.add(p.jobId);
  const who = p.label || p.username || p.site || 'Recording';
  const bits = [fmtDuration(p.duration), p.height ? `${p.height}p` : ''].filter(Boolean).join(' · ');
  const wait = p.autoSave
    ? `Keeps "${p.proposed}" in ${p.timeout}s unless you rename it.`
    : 'Open the Zipper sidebar to name it.';
  const message = `${who} ${reasonText(p.reason)}${bits ? ` (${bits})` : ''}. ${wait}`;

  try {
    await ext.notifications?.create(`zipper-naming:${p.jobId}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icon.svg'),
      title: 'Recording saved — name it?',
      message,
    });
  } catch { /* notifications blocked; the toast and the sidebar still show it */ }

  // Also on the page itself. A Windows notification can be swallowed by
  // focus assist or a full-screen player; a toast in the tab you are
  // actually looking at cannot.
  try {
    const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) {
      await ext.tabs.sendMessage(tab.id, {
        kind: 'zipper:toast',
        text: `${who} ${reasonText(p.reason)}${bits ? ` · ${bits}` : ''} — open the Zipper sidebar to name it`,
      }, { frameId: 0 }).catch(() => { /* no content script on this page */ });
    }
  } catch { /* ignore */ }
}

function fromJob(j: any, previous?: PendingName): PendingName | null {
  const n = j?.result?.naming;
  if (!n || typeof n !== 'object') return null;
  return {
    jobId: j.id,
    title: j.title || '',
    pageUrl: j.page_url || '',
    proposed: String(n.proposed || ''),
    ext: String(n.ext || ''),
    deadline: Number(n.deadline) || 0,
    autoSave: !!n.auto_save,
    timeout: Number(n.timeout) || 0,
    reason: String(n.reason || 'ended'),
    label: String(n.label || ''),
    username: String(n.username || ''),
    site: String(n.site || ''),
    duration: n.duration ?? null,
    height: n.height ?? null,
    bytes: n.bytes ?? null,
    resumes: Number(n.resumes) || 0,
    recorder: String(n.recorder || ''),
    seenAt: previous?.seenAt ?? Date.now(),
  };
}

async function poll(): Promise<boolean> {
  const res = await VwApi.listJobs(60);
  if (!res.ok) return pending.size > 0;
  let changed = false;
  let active = false;
  const seen = new Set<string>();
  for (const j of res.data?.jobs || []) {
    if (j.kind !== 'stream') continue;
    statuses.set(j.id, j.status);
    if (j.status === 'running' || j.status === 'claimed' || j.status === 'queued') active = true;
    if (j.status !== 'naming') continue;
    const p = fromJob(j, pending.get(j.id));
    if (!p) continue;
    seen.add(j.id);
    if (!pending.has(j.id)) changed = true;
    pending.set(j.id, p);
    void announce(p);
  }
  for (const id of [...pending.keys()]) {
    if (!seen.has(id)) {
      pending.delete(id);
      changed = true;
      try { void ext.notifications?.clear(`zipper-naming:${id}`); } catch { /* ignore */ }
    }
  }
  if (changed) broadcast();
  return active || pending.size > 0;
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    let again = false;
    try { again = await poll(); } catch { again = pending.size > 0; }
    if (again || wanted) schedule();
  }, POLL_MS);
}

/**
 * Start watching. Called when a recording starts, when the alarm fires, and
 * when the sidebar opens — any of which may be the first thing to happen
 * after the background was suspended and lost its timer.
 */
export function watchNaming(keepAlive = false): void {
  if (keepAlive) wanted = true;
  schedule();
}

export function stopWanting(): void {
  wanted = false;
}

/** The user's answer. An empty name means "keep the automatic one". */
export async function chooseName(jobId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const p = pending.get(jobId);
  const trimmed = (name || '').trim();
  const keep = !trimmed || (p && trimmed === p.proposed);
  const res = await VwApi.updateJob(jobId, {
    status: 'named',
    result: {
      naming: p ? { proposed: p.proposed, ext: p.ext } : undefined,
      ...(keep ? { keep: true } : { chosen_name: trimmed }),
      at: Date.now(),
    },
  });
  if (!res.ok) return { ok: false, error: res.error || 'could not reach the API' };
  statuses.set(jobId, 'named');
  pending.delete(jobId);
  try { void ext.notifications?.clear(`zipper-naming:${jobId}`); } catch { /* ignore */ }
  broadcast();
  watchNaming();
  return { ok: true };
}

/** Clicking the notification opens the sidebar where the name is chosen. */
try {
  ext.notifications?.onClicked.addListener((id: string) => {
    if (!id.startsWith('zipper-naming:')) return;
    try { void ext.sidebarAction?.open(); } catch { /* needs a user gesture on some versions */ }
  });
} catch { /* no notifications API */ }
