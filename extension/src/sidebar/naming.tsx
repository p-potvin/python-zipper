/**
 * "Name this recording" cards.
 *
 * Shown above every tab rather than inside Downloads, because the sidebar is
 * usually opened *because* of the notification, and whichever tab it happens
 * to open on is the one that has to show the question.
 *
 * The file already exists under its automatic name. Save renames it; Keep
 * accepts the automatic name at once rather than waiting out the deadline.
 * Doing nothing is also an answer: the worker keeps the automatic name when
 * the auto-save time runs out.
 */

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { ext } from '../common/api';

interface PendingName {
  jobId: string;
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
  seenAt: number;
}

const pending = signal<PendingName[]>([]);
const drafts = new Map<string, string>();
const busy = signal<Record<string, string>>({});

export async function loadNaming(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'naming:list' });
    if (res?.ok) pending.value = res.pending || [];
  } catch { /* background asleep; the next change message will fill it */ }
}

try {
  ext.runtime.onMessage.addListener((msg: any) => {
    if (msg?.kind === 'naming:changed') pending.value = msg.pending || [];
  });
} catch { /* ignore */ }

// The background's list only refreshes while something is being watched, and
// a sidebar left open is a reason to watch. Released when the sidebar closes.
try {
  window.addEventListener('unload', () => {
    try { void ext.runtime.sendMessage({ kind: 'naming:unwatch' }); } catch { /* ignore */ }
  });
} catch { /* ignore */ }

function fmtDuration(s?: number | null): string {
  if (!s || s <= 0) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(t % 60).padStart(2, '0')}s`;
  return `${t}s`;
}

function fmtBytes(n?: number | null): string {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/**
 * Seconds left, measured on this browser's clock from when the prompt was
 * first seen. The worker's absolute deadline is in its own clock, and the two
 * machines need not agree; `timeout` is the same interval in either.
 */
function secondsLeft(p: PendingName, now: number): number | null {
  if (!p.autoSave) return null;
  const local = p.seenAt + p.timeout * 1000;
  const remote = p.deadline || local;
  return Math.max(0, Math.round((Math.min(local, remote + 2000) - now) / 1000));
}

async function answer(p: PendingName, name: string): Promise<void> {
  busy.value = { ...busy.value, [p.jobId]: 'saving…' };
  try {
    const res = await ext.runtime.sendMessage({ kind: 'naming:choose', jobId: p.jobId, name });
    if (res?.ok) {
      drafts.delete(p.jobId);
      pending.value = pending.value.filter((x) => x.jobId !== p.jobId);
    } else {
      busy.value = { ...busy.value, [p.jobId]: res?.error || 'could not save' };
      return;
    }
  } catch (e: any) {
    busy.value = { ...busy.value, [p.jobId]: String(e?.message || e) };
    return;
  }
  const { [p.jobId]: _, ...rest } = busy.value;
  busy.value = rest;
}

function Card({ p, now }: { p: PendingName; now: number }) {
  const [value, setValue] = useState(drafts.get(p.jobId) ?? p.proposed);
  const left = secondsLeft(p, now);
  const facts = [
    p.reason === 'stopped' ? 'stopped' : 'finished',
    fmtDuration(p.duration),
    p.height ? `${p.height}p` : '',
    fmtBytes(p.bytes),
    p.resumes ? `resumed ${p.resumes}×` : '',
  ].filter(Boolean).join(' · ');
  const state = busy.value[p.jobId];

  return (
    <form class="nm-card" onSubmit={(e) => { e.preventDefault(); void answer(p, value); }}>
      <div class="nm-head">
        <span class="nm-who">{p.label || p.username || p.site || 'Recording'}</span>
        <span class="nm-facts">{facts}</span>
      </div>
      <div class="nm-row">
        <input class="inp nm-inp" value={value} spellcheck={false}
               aria-label="File name"
               onInput={(e) => {
                 const v = (e.currentTarget as HTMLInputElement).value;
                 drafts.set(p.jobId, v);
                 setValue(v);
               }} />
        <span class="nm-ext">{p.ext}</span>
      </div>
      <div class="nm-actions">
        <button class="btn" type="submit" disabled={!!state && state === 'saving…'}>Save</button>
        <button class="btn btn-alt" type="button" onClick={() => void answer(p, '')}>
          Keep automatic name
        </button>
        <span class="nm-left">
          {state || (left === null ? 'waiting for you' : `auto-save in ${left}s`)}
        </span>
      </div>
    </form>
  );
}

export function NamingCards() {
  const [now, setNow] = useState(Date.now());
  const list = pending.value;
  useEffect(() => {
    if (!list.length) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [list.length]);
  if (!list.length) return null;
  return (
    <section class="nm" aria-label="Recordings waiting for a name">
      {list.map((p) => <Card key={p.jobId} p={p} now={now} />)}
    </section>
  );
}
