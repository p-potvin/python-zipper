/**
 * Capture tab.
 *
 * The filter row is built directly on the candidate record's fields — kind,
 * width, bytes — rather than re-deriving anything, which is the whole reason
 * the harvest emits typed records instead of a boolean. "Min size" in
 * particular only works because the network log supplies Content-Length.
 */

import { signal, computed, effect } from '@preact/signals';
import { ext } from '../common/api';
import { type MediaCandidate, type MediaKind, type ScoreRule, suggestedName } from '../common/harvest';
import type { GrabFacts } from '../background/grabbed';
import { SCORE } from '../common/scoring';
import { defaultSelection } from '../common/page_rank';
import { loadSettings, onSettingsChanged } from '../common/settings';
import { serverOnline, jobs } from './downloads';
import type { DetectedStream } from '../common/types';
import { qualities, hasSelectableQuality, activeJobFor, progressLabel } from '../common/streams';

interface Snapshot {
  candidates: MediaCandidate[];
  pageUrl: string;
  pageDomain: string;
  path: 'full' | 'network-only' | 'deep';
  frames: number;
  fromNetwork: number;
  fromDom: number;
  photoSwipe?: PswpStatus;
}

interface PswpStatus {
  present: boolean;
  open: boolean;
  slides: number;
  via: string;
}

type SortKey = 'score' | 'size' | 'resolution' | 'name';
type ViewMode = 'grid' | 'list';

export const snapshot = signal<Snapshot | null>(null);
export const scanning = signal(false);
export const scanError = signal('');
export const loggedCount = signal(0);
export const toast = signal('');
/** Live phase readout while a deep scan is scrolling the page. */
export const deepStatus = signal<{ phase: string; passes: number; elapsedMs: number } | null>(null);

const query = signal('');
const kindFilter = signal<MediaKind | 'all'>('all');
const minWidth = signal(0);
const minKb = signal(0);
const sortKey = signal<SortKey>('score');
/** Sort direction is explicit. Locking it to one order means scrolling to
 *  reach the other end of the list, which is the complaint. */
const sortDesc = signal(true);
/** url -> filename it was saved under, for the already-got mark. */
const grabbed = signal<Record<string, string>>({});
const view = signal<ViewMode>('grid');
const selected = signal<Set<string>>(new Set());
const shown = signal(120);
/** url whose score breakdown is expanded. One at a time — this is for reading
 *  a single surprising result, not for scanning. */
const explaining = signal('');
/** CSS selector limiting the scan to one container. '' = whole page. */
export const scope = signal('');
export const scopeMatches = signal<number | null>(null);
export const picking = signal(false);
/**
 * What the page said about PhotoSwipe, whether or not a scan has run.
 *
 * Surfaced before scanning on purpose: on a PhotoSwipe page a quick scan sees
 * the thumbnails in the markup and nothing else, because the full-size URLs
 * live in the viewer's own state and it has to be opened once before they
 * exist. Knowing that up front is the difference between one deep run and a
 * confusing quick one followed by wondering where the originals went.
 */
export const pswp = signal<PswpStatus | null>(null);

export async function detectPswp(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'pswp:detect' });
    pswp.value = res?.ok ? res.status : null;
  } catch { pswp.value = null; }
}

// ---- livestreams --------------------------------------------------------------

/**
 * The sniffer's detected streams for the active tab.
 *
 * The candidate list carries a stream as a handle — a key and a type — because
 * that is all the harvest knows about it. Everything the recorder needs (the
 * probed format list, whether a job is already running) lives on the sniffer's
 * own record, so it is fetched alongside rather than crammed into the
 * candidate.
 */
export const pageStreams = signal<DetectedStream[]>([]);

/** format_id chosen per stream key, before it is started. */
const pickedQuality = signal<Record<string, string>>({});

/**
 * One decoded frame per stream, and why there isn't one.
 *
 * The thumbnail is the smaller half of what this is for. Producing a frame at
 * all requires the manifest to parse, a segment to be fetched with our headers,
 * any key to be retrievable and the codec to decode — the entire surface on
 * which a stream later fails. So the preview doubles as a check: a picture
 * means the recording will almost certainly start, and a failure carries the
 * reason ffmpeg gave.
 *
 * Streams that cannot produce one are *not* hidden. That would be filtering on
 * an untested proxy for validity, and a false negative would silently remove a
 * stream that was fine.
 */
type Preview =
  | { state: 'loading' }
  | { state: 'ok'; image: string }
  | { state: 'failed'; error: string };

const previews = signal<Record<string, Preview>>({});

/**
 * Ask for a frame, once per stream.
 *
 * Not on hover. Hover works for VDH because its helper is local and hot; ours
 * goes through the job queue, where the worker's idle poll alone is seconds —
 * a preview that appears well after the pointer has moved on is worse than one
 * that was simply there. A page carries a handful of streams, not hundreds of
 * rows, so fetching for the ones on screen costs little and answers the
 * question ("which of these is dead?") before you go looking.
 */
async function loadPreview(key: string, url: string, headers: Record<string, string>): Promise<void> {
  if (previews.value[key]) return;   // already asked; retry is explicit
  previews.value = { ...previews.value, [key]: { state: 'loading' } };
  try {
    const res = await ext.runtime.sendMessage({ kind: 'stream:preview', url, headers });
    previews.value = {
      ...previews.value,
      [key]: res?.ok && res.image
        ? { state: 'ok', image: res.image }
        : { state: 'failed', error: res?.error || 'no frame' },
    };
  } catch (e: any) {
    previews.value = {
      ...previews.value, [key]: { state: 'failed', error: String(e?.message || e) },
    };
  }
}

function retryPreview(key: string, url: string, headers: Record<string, string>): void {
  const next = { ...previews.value };
  delete next[key];
  previews.value = next;
  void loadPreview(key, url, headers);
}

export async function refreshStreams(): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'streams:get' });
    pageStreams.value = res?.streams || [];
  } catch { pageStreams.value = []; }
}

async function recordStream(key: string): Promise<void> {
  flash('Starting the recording…');
  try {
    const res = await ext.runtime.sendMessage({
      kind: 'streams:start', key, formatId: pickedQuality.value[key] || undefined,
    });
    flash(res?.ok ? 'Recording' : (res?.error || 'Could not start it'));
  } catch (e: any) {
    flash(String(e?.message || e));
  }
  void refreshStreams();
}

async function stopRecording(jobId: string): Promise<void> {
  try {
    const res = await ext.runtime.sendMessage({ kind: 'jobs:stop', jobId });
    flash(res?.ok ? 'Stopped' : (res?.error || 'Could not stop it'));
  } catch (e: any) {
    flash(String(e?.message || e));
  }
  void refreshStreams();
}

// ---- persisted view preferences ---------------------------------------------

/**
 * How you last had the list arranged, remembered.
 *
 * Not a setting with a screen — just the last value, restored. Sort order and
 * the size floors are the sort of thing you pick once because of how you work,
 * and re-picking them after every scan (and again after every browser restart)
 * is pure friction.
 *
 * The search box is deliberately NOT remembered. It is a question about the
 * page in front of you, and restoring it onto a different page would silently
 * hide most of a fresh result set with no visible cause — the one persisted
 * value that would cost more than it saved.
 */
const PREFS_KEY = 'zipper-view-prefs';

interface ViewPrefs {
  sortKey: SortKey;
  sortDesc: boolean;
  kind: MediaKind | 'all';
  minWidth: number;
  minKb: number;
  view: ViewMode;
}

/** Nothing is written until the stored values have been read, or the first
 *  render would persist the defaults over them. */
let prefsReady = false;

export async function loadViewPrefs(): Promise<void> {
  try {
    const got = await ext.storage.local.get(PREFS_KEY);
    const v = got?.[PREFS_KEY] as Partial<ViewPrefs> | undefined;
    if (v && typeof v === 'object') {
      if (v.sortKey) sortKey.value = v.sortKey;
      if (typeof v.sortDesc === 'boolean') sortDesc.value = v.sortDesc;
      if (v.kind) kindFilter.value = v.kind;
      if (Number.isFinite(v.minWidth)) minWidth.value = Number(v.minWidth);
      if (Number.isFinite(v.minKb)) minKb.value = Number(v.minKb);
      if (v.view) view.value = v.view;
    }
  } catch { /* storage unavailable — defaults are fine */ } finally {
    prefsReady = true;
  }
}

effect(() => {
  const prefs: ViewPrefs = {
    sortKey: sortKey.value,
    sortDesc: sortDesc.value,
    kind: kindFilter.value,
    minWidth: minWidth.value,
    minKb: minKb.value,
    view: view.value,
  };
  if (!prefsReady) return;
  try { void ext.storage.local.set({ [PREFS_KEY]: prefs }); } catch { /* ignore */ }
});

// ---- derived ----------------------------------------------------------------

const filtered = computed(() => {
  const s = snapshot.value;
  if (!s) return [];
  const q = query.value.trim().toLowerCase();
  const k = kindFilter.value;
  const mw = minWidth.value;
  const mb = minKb.value * 1024;

  const out = s.candidates.filter((c) => {
    if (k !== 'all' && c.kind !== k) return false;
    // An unknown width/size must not be silently dropped by a filter the user
    // didn't aim at it — only exclude when we actually know it falls short.
    if (mw > 0 && c.width !== undefined && c.width < mw) return false;
    if (mb > 0 && c.bytes !== undefined && c.bytes < mb) return false;
    if (q && !c.url.toLowerCase().includes(q) && !(c.label || '').toLowerCase().includes(q)) return false;
    return true;
  });

  const by = sortKey.value;
  const dir = sortDesc.value ? 1 : -1;
  return out.sort((a, b) => {
    let d: number;
    if (by === 'size') d = (b.bytes ?? -1) - (a.bytes ?? -1);
    else if (by === 'resolution') d = ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0));
    else if (by === 'name') d = fileName(b.url).localeCompare(fileName(a.url));
    else d = b.score - a.score;
    return d * dir;
  });
});

const selectedList = computed(() =>
  filtered.value.filter((c) => selected.value.has(c.url)));

/**
 * The selection, minus anything that cannot be fetched as a file.
 *
 * A stream is a manifest: fetching it yields a few kilobytes of playlist text,
 * not the broadcast. Recording one is the recorder's job, so the file routes
 * skip them and say how many they skipped rather than silently producing an
 * archive full of `.m3u8` stubs.
 */
const downloadableList = computed(() =>
  selectedList.value.filter((c) => c.kind !== 'stream'));

/**
 * What is worth recording about a file we are taking.
 *
 * The background knows the URL and the name it saved under; everything else
 * that makes the history useful — kind, size, dimensions, how it was found and
 * what it scored — is only here, on the candidate. Sending it along is what
 * turns the history from a list of URLs into something the Insights tab and the
 * per-domain profile can actually work with.
 */
function factsFor(items: MediaCandidate[]): Record<string, GrabFacts> {
  const out: Record<string, GrabFacts> = {};
  for (const c of items) {
    out[c.url] = {
      kind: c.kind,
      mime: c.mime,
      bytes: c.bytes,
      width: c.width,
      height: c.height,
      origin: c.origin,
      score: c.score,
      assetHost: c.assetHost,
      pageTitle: c.label,
    };
  }
  return out;
}

// ---- actions ----------------------------------------------------------------

function flash(msg: string): void {
  toast.value = msg;
  setTimeout(() => { if (toast.value === msg) toast.value = ''; }, 3200);
}

/** Ask the background which of these we already have, and under what name. */
async function refreshGrabbed(urls: string[]): Promise<void> {
  if (!urls.length) { grabbed.value = {}; return; }
  try {
    const res = await ext.runtime.sendMessage({ kind: 'grabbed:lookup', urls });
    grabbed.value = res?.grabbed || {};
  } catch { grabbed.value = {}; }
}

export async function refreshPeek(): Promise<void> {
  // Piggy-backed on the peek, which already runs whenever the sidebar looks at
  // the tab. A stream that appears mid-browse then shows up without its own
  // polling loop.
  void refreshStreams();
  try {
    const res = await ext.runtime.sendMessage({ kind: 'harvest:peek' });
    loggedCount.value = res?.logged ?? 0;
  } catch { loggedCount.value = 0; }
}

export async function runScan(mode: 'quick' | 'deep' = 'quick'): Promise<void> {
  if (scanning.value) return;
  scanning.value = true;
  scanError.value = '';
  if (mode === 'deep') deepStatus.value = { phase: 'starting', passes: 0, elapsedMs: 0 };
  try {
    const res = await ext.runtime.sendMessage({ kind: 'harvest:run', mode, scope: scope.value });
    if (!res?.ok) {
      scanError.value = res?.error || 'scan failed';
      snapshot.value = null;
    } else {
      const hadSelection = selected.value.size > 0;
      snapshot.value = res.snapshot;
      // Awaited, not fired off: the default selection below has to know what is
      // already downloaded, and racing it would tick files we already have on
      // roughly half of all scans.
      await refreshGrabbed(res.snapshot.candidates.map((c: MediaCandidate) => c.url));

      if (hadSelection) {
        // A re-scan must not throw away what you had ticked. Keep the existing
        // selection, narrowed to URLs that still exist in the new results —
        // auto-selecting again here is how a careful selection gets wiped by
        // one click.
        const live = new Set(res.snapshot.candidates.map((c: MediaCandidate) => c.url));
        selected.value = new Set([...selected.value].filter((u) => live.has(u)));
      } else {
        // Pre-selection is a rule now, not a score threshold. Ticking
        // everything above INTERESTING meant most of the list arrived
        // selected, and the first action on every page was to clear it — a
        // default you always undo is worse than no default. This ticks the
        // biggest thing on the page and any grid it found, and nothing else.
        const pick = defaultSelection(res.snapshot.candidates);
        // ...and never something already on disk. It still shows with its green
        // tick so you can re-tick it deliberately, but a second pass down a
        // feed should not quietly re-download what the first pass took.
        for (const url of Object.keys(grabbed.value)) pick.delete(url);
        selected.value = pick;
      }
      if (res.snapshot.photoSwipe) pswp.value = res.snapshot.photoSwipe;
      // The candidates carry stream *handles*; this fetches what those handles
      // point at, so a stream row can offer qualities straight after a scan.
      void refreshStreams();
      if (highlightOn.value) void pushHighlights();
      shown.value = 120;
    }
  } catch (e: any) {
    scanError.value = String(e?.message || e);
  } finally {
    scanning.value = false;
    deepStatus.value = null;
    void refreshPeek();
  }
}

export async function abortDeep(): Promise<void> {
  try { await ext.runtime.sendMessage({ kind: 'harvest:deep-abort' }); } catch { /* ignore */ }
}

// Progress arrives as its own message while the content script scrolls.
ext.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind === 'harvest:deep-progress') {
    deepStatus.value = { phase: msg.phase, passes: msg.passes, elapsedMs: msg.elapsedMs };
    return;
  }

  // The passive log grew — a feed is still loading. Update the "seen" counter
  // always, and fold the new items into an existing snapshot so the list fills
  // in place. Deliberately additive: it never re-sorts away from under you and
  // never touches the selection.
  // Live scanning found something after a trusted user action. Replaced
  // wholesale rather than merged here because the background already did the
  // merge — and the selection is keyed by URL in its own signal, so nothing
  // the user ticked is disturbed by the list growing underneath it.
  if (msg?.kind === 'harvest:updated') {
    if (snapshot.value && !scanning.value && msg.snapshot) {
      snapshot.value = msg.snapshot;
      if (msg.snapshot.photoSwipe) pswp.value = msg.snapshot.photoSwipe;
    }
    return;
  }

  if (msg?.kind === 'media:logged') {
    loggedCount.value = msg.logged ?? loggedCount.value;
    if (snapshot.value && !scanning.value) void mergeNewlySeen();
  }
});

// ---- container picker -------------------------------------------------------

export async function startPicking(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) return;
  picking.value = true;
  try { await ext.tabs.sendMessage(tabId, { kind: 'picker:start' }); }
  catch { picking.value = false; flash('Cannot pick on this page'); }
}

export async function clearScope(): Promise<void> {
  scope.value = '';
  scopeMatches.value = null;
}

async function countScope(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null || !scope.value) { scopeMatches.value = null; return; }
  try {
    const res = await ext.tabs.sendMessage(tabId, { kind: 'picker:count', selector: scope.value });
    scopeMatches.value = res?.count ?? null;
  } catch { scopeMatches.value = null; }
}

ext.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind !== 'picker:result') return;
  picking.value = false;
  if (msg.selector) {
    scope.value = msg.selector;
    void countScope();
    flash(`Scoped to ${msg.selector}`);
  }
});

let mergeQueued = false;
async function mergeNewlySeen(): Promise<void> {
  if (mergeQueued) return;
  mergeQueued = true;
  try {
    const res = await ext.runtime.sendMessage({ kind: 'harvest:peek' });
    const fresh: MediaCandidate[] = res?.candidates || [];
    const snap = snapshot.value;
    if (!snap || !fresh.length) return;
    const known = new Set(snap.candidates.map((c) => c.url));
    const added = fresh.filter((c) => !known.has(c.url));
    if (!added.length) return;
    snapshot.value = {
      ...snap,
      candidates: [...snap.candidates, ...added],
      fromNetwork: snap.fromNetwork + added.length,
    };
  } catch { /* background unavailable */ } finally {
    mergeQueued = false;
  }
}

export function resetCapture(): void {
  // Outlines belong to the page that was scanned — clear them before the
  // snapshot goes, or they linger on a page whose results we've discarded.
  // Clear the *result* overlay; the page keeps drawing its own plain marks if
  // the global option is on, which is correct — those describe the page, not
  // the snapshot we just discarded.
  if (highlightOn.value) void clearHighlightsOnPage();
  snapshot.value = null;
  scanError.value = '';
  // Frames belong to the streams that were on the page we just discarded. A
  // live stream's frame is also stale within seconds, so there is nothing worth
  // keeping here across a reset.
  previews.value = {};
  pageStreams.value = [];
  selected.value = new Set();
  grabbed.value = {};
  query.value = '';
  shown.value = 120;
  void refreshPeek();
}

function toggle(url: string): void {
  const next = new Set(selected.value);
  next.has(url) ? next.delete(url) : next.add(url);
  selected.value = next;
  if (highlightOn.value) void pushHighlights();
}

/**
 * "All" means everything not already on disk.
 *
 * Same reasoning as the automatic pre-selection: a second pass down a feed
 * should not re-download what the first pass took. Already-grabbed items keep
 * their green tick and can still be ticked individually — that is a deliberate
 * statement about one file, where All is a bulk convenience.
 *
 * The count in the bar makes the difference visible ("14 of 16") rather than
 * silent, which is what stops this from being a surprise.
 */
function selectAll(on: boolean): void {
  selected.value = on
    ? new Set(filtered.value.filter((c) => !grabbed.value[c.url]).map((c) => c.url))
    : new Set();
  if (highlightOn.value) void pushHighlights();
}

// ---- highlighting -----------------------------------------------------------

/**
 * Mirrors the global "Outline media" option; it is not a control of its own.
 *
 * The per-result toggle that used to live on this tab is gone. Outlining is a
 * property of how you browse, not of a result set, and a switch that reset
 * every time you scanned was one that in practice stayed off. What remains here
 * is the *overlay*: when outlining is on, the sidebar pushes the current
 * result set so the ticked subset and the already-downloaded files get their
 * own colours on top of the plain marks the page is drawing anyway.
 */
export const highlightOn = signal(false);

void loadSettings().then((s) => { highlightOn.value = s.highlight; });
onSettingsChanged((s) => {
  highlightOn.value = s.highlight;
  if (s.highlight) void pushHighlights();
});

async function activeTabId(): Promise<number | null> {
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0]?.id ?? null;
  } catch { return null; }
}

/** Outline the filtered set on the page, with the selection marked separately. */
async function pushHighlights(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) return;
  try {
    await ext.tabs.sendMessage(tabId, {
      kind: 'highlight:show',
      urls: filtered.value.map((c) => c.url),
      picked: Array.from(selected.value),
      done: Object.keys(grabbed.value),
    });
  } catch { /* no content script on this page */ }
}

async function clearHighlightsOnPage(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId === null) return;
  try { await ext.tabs.sendMessage(tabId, { kind: 'highlight:clear' }); } catch { /* ignore */ }
}

async function downloadSelected(): Promise<void> {
  const items = downloadableList.value;
  const skipped = selectedList.value.length - items.length;
  if (!items.length) {
    flash(skipped ? 'Streams are recorded, not downloaded — use the popup' : '');
    return;
  }

  // More than one file is an archive by default. Zipping used to mean handing
  // the job to the python server, which made the archive conditional on a
  // server being up and put the result on that machine rather than this one —
  // so in practice a multi-file download arrived as loose entries. The
  // background can build the archive itself now; the server route is still
  // there and still better for very large jobs.
  const wantZip = (await loadSettings()).zipMultiple;
  if (wantZip && items.length > 1) {
    flash(`Fetching ${items.length} files…`);
    try {
      const res = await ext.runtime.sendMessage({
        kind: 'downloads:zip',
        items: items.map((c) => ({ url: c.url, filename: suggestedName(c) })),
        pageUrl: snapshot.value?.pageUrl || '',
        archiveName: archiveNameFor(),
        facts: factsFor(items),
      });
      if (res?.ok) {
        const missed = res.failed?.length ?? 0;
        flash(missed
          ? `Zipped ${res.count} — ${missed} could not be fetched`
          : `Zipped ${res.count} into ${res.filename}`);
        void refreshGrabbed(filtered.value.map((c) => c.url));
      } else {
        flash(res?.error || 'Could not build the archive');
      }
    } catch (e: any) {
      flash(String(e?.message || e));
    }
    return;
  }

  const referer = snapshot.value?.pageUrl;
  let ok = 0;
  for (const c of items) {
    try {
      const res = await ext.runtime.sendMessage({
        kind: 'downloads:start',
        url: c.url,
        filename: suggestedName(c),
        referer,
      });
      if (res?.ok) ok++;
    } catch { /* counted as failed below */ }
  }
  flash(ok === items.length
    ? `Sent ${ok} to the browser${skipped ? ` (${skipped} stream skipped)` : ''}`
    : `Sent ${ok} of ${items.length} — ${items.length - ok} refused`);
  void refreshGrabbed(filtered.value.map((c) => c.url));
}

async function sendToServer(): Promise<void> {
  const items = downloadableList.value;
  if (!items.length) {
    flash(selectedList.value.length ? 'Streams are recorded, not queued — use the popup' : '');
    return;
  }
  try {
    const kinds: Record<string, string> = {};
    for (const c of items) kinds[c.url] = c.kind;
    const res = await ext.runtime.sendMessage({
      kind: 'harvest:send-server',
      links: items.map((c) => c.url),
      kinds,
      pageUrl: snapshot.value?.pageUrl || '',
      // The profile key. Without it every job lands with an empty domain and
      // the whole per-domain learning layer has nothing to attach to.
      pageDomain: snapshot.value?.pageDomain || '',
      facts: factsFor(items),
    });
    flash(res?.ok ? `Queued ${items.length} on the server` : (res?.error || 'server unreachable'));
    if (res?.ok) void refreshGrabbed(filtered.value.map((c) => c.url));
  } catch (e: any) {
    flash(String(e?.message || e));
  }
}

async function copySelected(): Promise<void> {
  const items = selectedList.value;
  if (!items.length) return;
  try {
    await navigator.clipboard.writeText(items.map((c) => c.url).join('\n'));
    flash(`Copied ${items.length} URLs`);
  } catch { flash('Clipboard blocked'); }
}

// ---- formatting -------------------------------------------------------------

function fmtBytes(n?: number): string {
  if (n === undefined) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function fmtDims(c: MediaCandidate): string {
  if (c.width && c.height) return `${c.width}×${c.height}`;
  if (c.width) return `${c.width}w`;
  return '—';
}

function fileName(url: string): string {
  try {
    const p = new URL(url).pathname;
    return decodeURIComponent(p.split('/').filter(Boolean).pop() || p) || 'file';
  } catch { return 'file'; }
}

/**
 * `stream` is its own pill, and `video` no longer means it.
 *
 * They were lumped together, which was wrong in both directions: picking Video
 * on a livestream page returned hundreds of chunks and no file, and a page with
 * a real video plus a stream gave no way to look at one without the other. They
 * are different objects — a stream is recorded over time, a video is fetched —
 * and `kind` already distinguished them, so the filter just had to stop
 * flattening it.
 */
const KINDS: (MediaKind | 'all')[] = ['all', 'image', 'video', 'stream', 'audio', 'document'];

/**
 * A name that says where the archive came from.
 *
 * The page's domain and the date, because an archive called `download.zip` in
 * a folder of archives called `download.zip` is the problem this is meant to
 * solve, not a smaller version of it.
 */
function archiveNameFor(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const domain = (snapshot.value?.pageDomain || 'zipper').replace(/[^a-z0-9.-]+/gi, '_');
  return `${domain}-${stamp}.zip`;
}

// ---- cells ------------------------------------------------------------------

function Thumb({ c }: { c: MediaCandidate }) {
  // Images preview from their own URL. Video/audio/documents have nothing cheap
  // to show, so they get a kind glyph rather than a broken image frame.
  if (c.kind !== 'image') {
    return <div class="thumb-ph" data-kind={c.kind}>{c.kind.slice(0, 3)}</div>;
  }
  return (
    <img
      class="thumb-img"
      src={c.url}
      loading="lazy"
      decoding="async"
      alt=""
      onError={(e) => {
        // Hotlink-protected hosts 403 here. Degrade rather than showing the
        // browser's broken-image icon.
        const el = e.currentTarget as HTMLImageElement;
        el.style.display = 'none';
        (el.parentElement?.querySelector('.thumb-ph-fallback') as HTMLElement)?.
          style.setProperty('display', 'flex');
      }}
    />
  );
}

function Cell({ c }: { c: MediaCandidate }) {
  const on = selected.value.has(c.url);
  const got = grabbed.value[c.url];
  return (
    <button
      class={`cell${on ? ' cell-on' : ''}${got ? ' cell-got' : ''}`}
      onClick={() => toggle(c.url)}
      title={c.url}
      aria-pressed={on}
    >
      <div class="cell-thumb">
        <Thumb c={c} />
        <div class="thumb-ph-fallback" style="display:none">{c.kind.slice(0, 3)}</div>
        <span class={`kind kind-${c.kind}`}>{c.kind}</span>
        {got ? <span class="cell-got-badge" title={`already saved as ${got}`}>✓</span>
             : on ? <span class="cell-check">✓</span> : null}
      </div>
      <div class="cell-name" title={got ? `saved as ${got}` : c.url}>
        {got || suggestedName(c)}
      </div>
      <div class="cell-meta">
        <span>{fmtBytes(c.bytes)}</span>
        <span class="cell-spring" />
        <span>{fmtDims(c)}</span>
      </div>
    </button>
  );
}

/**
 * A livestream, with its recorder.
 *
 * Rendered instead of the normal row, because none of the normal row applies: a
 * stream has no size, no dimensions, and cannot be ticked into an archive. What
 * it has is a quality to choose and a recording to start or stop, which is
 * exactly what this shows.
 */
function StreamRow({ c }: { c: MediaCandidate }) {
  const s = pageStreams.value.find((x) => x.key === c.streamKey);
  const qs = s ? qualities(s) : [];
  const job = s ? activeJobFor(s, jobs.value) : undefined;
  const pick = c.streamKey ? pickedQuality.value[c.streamKey] : '';
  const prev = c.streamKey ? previews.value[c.streamKey] : undefined;

  // Kicked off after this render, never during it: loadPreview writes the
  // 'loading' state synchronously, and setting a signal mid-render re-enters
  // the component. The guard inside makes it idempotent, so queueing it on
  // every render of an unpreviewed row costs a map lookup.
  if (s && c.streamKey && !prev) {
    const key = c.streamKey;
    queueMicrotask(() => void loadPreview(key, s.url, s.headers || {}));
  }

  return (
    <li class={`cand cand-stream${job ? ' cand-rec' : ''}`}>
      {prev ? (
        <div class="stream-prev">
          {prev.state === 'ok' ? (
            <img src={prev.image} alt="" loading="lazy" />
          ) : prev.state === 'loading' ? (
            <div class="stream-prev-note">decoding a frame…</div>
          ) : (
            <div class="stream-prev-note stream-prev-bad" title={prev.error}>
              <span class="led led-alert">no frame</span>
              <span class="stream-prev-err">{prev.error}</span>
              <button class="q" onClick={() => c.streamKey && s
                && retryPreview(c.streamKey, s.url, s.headers || {})}>Retry</button>
            </div>
          )}
        </div>
      ) : null}

      <div class="cand-top">
        <span class={`kind kind-stream`}>{c.streamType || 'stream'}</span>
        <span class="cand-name" title={c.url}>{c.label || fileName(c.url)}</span>
        {s?.meta?.is_live ? <span class="led led-alert">live</span> : null}
      </div>

      {qs.length ? (
        <div class="stream-q">
          {qs.map((q) => (
            <button
              key={q.label}
              class={`q${q.id && pick === q.id ? ' q-on' : ''}`}
              disabled={!q.id}
              title={q.id
                ? `Record at ${q.label}`
                : `${q.label} — advertised by the playlist, selectable once the probe returns`}
              onClick={() => {
                if (!c.streamKey) return;
                pickedQuality.value = { ...pickedQuality.value, [c.streamKey]: q.id };
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      ) : (
        <div class="cand-meta">
          <span>{s?.probed ? 'no quality list' : 'reading qualities…'}</span>
        </div>
      )}

      {job ? (
        <>
          <div class="job-bar">
            {/* Indeterminate whenever the job has no total to measure against,
                which for a live capture is always. A VOD recording does have
                one and still gets a real percentage. */}
            {job.bytes_total ? (
              <div class="job-fill" style={`width:${Math.max(2, Math.round(job.progress || 0))}%`} />
            ) : (
              <div class="job-fill job-fill-live" />
            )}
          </div>
          <div class="cand-meta">
            <span>{progressLabel(job)}</span>
            <span class="cand-spring" />
            <button class="q q-stop" onClick={() => void stopRecording(job.id)}>Stop</button>
          </div>
        </>
      ) : (
        <button class="stream-go" disabled={!c.streamKey}
                onClick={() => c.streamKey && void recordStream(c.streamKey)}>
          Record{pick ? ' selected' : hasSelectableQuality(qs) ? ' best' : ''}
        </button>
      )}
    </li>
  );
}

function Row({ c }: { c: MediaCandidate }) {
  const on = selected.value.has(c.url);
  const got = grabbed.value[c.url];
  return (
    <li
      class={`cand${on ? ' cand-on' : ''}${got ? ' cand-got' : ''}${c.score >= SCORE.INTERESTING ? ' cand-hot' : ''}`}
      onClick={() => toggle(c.url)}
    >
      <div class="cand-top">
        <span class={`kind kind-${c.kind}`}>{c.kind}</span>
        <span class="cand-name" title={got ? `saved as ${got}` : c.url}>
          {got || suggestedName(c)}
        </span>
        {got ? <span class="cand-got-tag">got</span>
             : on ? <span class="cand-check">✓</span> : null}
      </div>
      <div class="cand-meta">
        <span>{fmtBytes(c.bytes)}</span>
        <span>{fmtDims(c)}</span>
        <span class="cand-origin">{c.origin}</span>
        {c.upgradedFrom ? <span class="cand-up">upgraded</span> : null}
        {c.cluster ? <span class="cand-clu" title={`one of ${c.cluster.size} in the same grid`}>
          grid ×{c.cluster.size}
        </span> : null}
        <span class="cand-spring" />
        <span class="cand-score">{c.score}</span>
        {c.reasons?.length ? (
          <button
            class="cand-why"
            title="Why this score"
            aria-label="Why this score"
            aria-expanded={explaining.value === c.url}
            onClick={(e) => {
              e.stopPropagation();   // the row itself toggles selection
              explaining.value = explaining.value === c.url ? '' : c.url;
            }}
          >?</button>
        ) : null}
      </div>
      {explaining.value === c.url && c.reasons?.length ? <Why rules={c.reasons} /> : null}
    </li>
  );
}

/**
 * The rules that produced a score, biggest contribution first.
 *
 * The only way to know why something ranked where it did used to be to read
 * scoring.ts and simulate it by hand — which is exactly the failure the old
 * inline scorer had, just better organised. Sorted by magnitude rather than by
 * order of firing: the question being asked is always "what did this to it?"
 */
function Why({ rules }: { rules: ScoreRule[] }) {
  const sorted = [...rules].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return (
    <ul class="why" onClick={(e) => e.stopPropagation()}>
      {sorted.map(([rule, delta]) => (
        <li key={rule} class={delta > 0 ? 'why-up' : 'why-down'}>
          <span class="why-rule">{rule}</span>
          <span class="why-delta">{delta > 0 ? '+' : ''}{delta}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tell the user the gallery is reachable, and that it takes a deep run.
 *
 * This is the one case where a quick scan is actively misleading rather than
 * merely incomplete: the page's markup holds thumbnails, and the full-size URLs
 * exist only inside the viewer's own state, which is constructed the first time
 * something is clicked. So the honest thing is to say so before the scan rather
 * than after, and point at the button that actually works.
 */
function PswpBanner({ s }: { s: PswpStatus }) {
  const got = s.slides > 0;
  return (
    <div class="pswp-note">
      <span class={`led led-${got ? 'online' : 'sync'}`}>photoswipe</span>
      <div class="pswp-note-body">
        {got ? (
          <p>
            Read {s.slides} slide{s.slides === 1 ? '' : 's'} straight from the
            gallery — full-size URLs with their real dimensions.
          </p>
        ) : (
          <p>
            This page uses a PhotoSwipe gallery. A quick scan only sees the
            thumbnails in the markup; <strong>Scroll</strong> loads the whole
            feed, opens the viewer once, and takes every full-size URL from it.
          </p>
        )}
      </div>
    </div>
  );
}

// ---- view -------------------------------------------------------------------

export function CaptureTab() {
  const s = snapshot.value;
  const list = filtered.value;
  const nSel = selectedList.value.length;
  // The buttons act on files, so they count files. A stream still counts in the
  // bar above ("3 of 40") because it is genuinely ticked — it just is not
  // something these two buttons can do anything with.
  const nFiles = downloadableList.value.length;
  const streamRows = list.filter((c) => c.kind === 'stream');
  const fileRows = list.filter((c) => c.kind !== 'stream');

  return (
    <div class="cap">
      <div class="scoperow">
        <button class={`btn-quiet${picking.value ? ' btn-quiet-on' : ''}`}
                disabled={scanning.value}
                title="Click an element on the page to limit the scan to it"
                onClick={() => void startPicking()}>
          {picking.value ? 'Picking…' : 'Pick'}
        </button>
        {scope.value ? (
          <>
            <code class="scope-sel" title={scope.value}>{scope.value}</code>
            <span class="scope-n">
              {scopeMatches.value === null ? '' :
               scopeMatches.value < 0 ? 'invalid' : `${scopeMatches.value}`}
            </span>
            <button class="lnk" onClick={() => void clearScope()}>Clear</button>
          </>
        ) : (
          <span class="scope-none">whole page</span>
        )}
      </div>

      <div class="cap-bar">
        <button class="btn" onClick={() => void runScan('quick')} disabled={scanning.value}>
          {scanning.value ? 'Scanning…' : s ? 'Re-scan' : 'Scan page'}
        </button>
        <button class="btn-quiet" disabled={scanning.value}
                title="Scroll the whole feed and open the gallery viewer before scanning. Slower, but reaches lazy-loaded media."
                onClick={() => void runScan('deep')}>
          Scroll
        </button>
        <span class="cap-count">{s ? `${s.candidates.length} found` : `${loggedCount.value} seen`}</span>
      </div>

      {deepStatus.value ? (
        <div class="deep">
          <span class="led led-relay">{deepStatus.value.phase}</span>
          <span>{deepStatus.value.passes} scrolls</span>
          <span>{Math.round(deepStatus.value.elapsedMs / 1000)}s</span>
          <span class="cell-spring" />
          <button class="lnk" onClick={() => void abortDeep()}>Stop</button>
        </div>
      ) : null}

      {s ? (
        <div class="cap-prov">
          <span class="led led-relay">{s.path === 'full' ? 'full scan' : 'network only'}</span>
          <span>{s.fromNetwork} net</span>
          <span>{s.fromDom} dom</span>
          <span>{s.frames} frame{s.frames === 1 ? '' : 's'}</span>
        </div>
      ) : null}

      {scanError.value ? <div class="cap-err">{scanError.value}</div> : null}

      {s && s.candidates.length > 0 ? (
        <>
          <input
            class="inp" type="search" placeholder="Filter by name or URL…"
            value={query.value}
            onInput={(e) => { query.value = (e.currentTarget as HTMLInputElement).value; }}
          />

          <div class="chips">
            {KINDS.map((k) => {
              const n = k === 'all'
                ? s.candidates.length
                : s.candidates.filter((c) => c.kind === k).length;
              if (k !== 'all' && n === 0) return null;
              return (
                <button key={k} class={`chip${kindFilter.value === k ? ' chip-on' : ''}`}
                        onClick={() => { kindFilter.value = k; }}>
                  {k} <span class="chip-n">{n}</span>
                </button>
              );
            })}
          </div>

          <div class="fields">
            <label class="field">
              <span>Min width</span>
              <input class="inp inp-sm" type="number" min="0" step="100" value={minWidth.value}
                     onInput={(e) => { minWidth.value = +(e.currentTarget as HTMLInputElement).value || 0; }} />
            </label>
            <label class="field">
              <span>Min size KB</span>
              <input class="inp inp-sm" type="number" min="0" step="50" value={minKb.value}
                     onInput={(e) => { minKb.value = +(e.currentTarget as HTMLInputElement).value || 0; }} />
            </label>
            <label class="field">
              <span>Sort</span>
              <div class="sortrow">
                <select class="inp inp-sm" value={sortKey.value}
                        onChange={(e) => { sortKey.value = (e.currentTarget as HTMLSelectElement).value as SortKey; }}>
                  <option value="score">Best match</option>
                  <option value="size">Size</option>
                  <option value="resolution">Resolution</option>
                  <option value="name">Name</option>
                </select>
                <button class="iconbtn" onClick={() => { sortDesc.value = !sortDesc.value; }}
                        title={sortDesc.value ? 'Descending — click for ascending' : 'Ascending — click for descending'}
                        aria-label="Reverse sort order">
                  {sortDesc.value ? '↓' : '↑'}
                </button>
              </div>
            </label>
          </div>

          <div class="selbar">
            <span class="selbar-n">{nSel} of {list.length}</span>
            <button class="lnk" title="Select everything not already downloaded"
                    onClick={() => selectAll(true)}>All</button>
            <button class="lnk" onClick={() => selectAll(false)}>None</button>
            <span class="cell-spring" />
            <button class="iconbtn" title={view.value === 'grid' ? 'List view' : 'Grid view'}
                    onClick={() => { view.value = view.value === 'grid' ? 'list' : 'grid'; }}>
              {view.value === 'grid' ? '☰' : '▦'}
            </button>
          </div>

          {/* Streams always render as rows, in both views. A grid cell is a
              thumbnail with a tick, and a stream has neither — it needs a
              quality picker and a Record button, which is a row-shaped thing
              whichever way the rest of the list is laid out. */}
          {streamRows.length ? (
            <ul class="cands cands-streams">
              {streamRows.map((c) => <StreamRow key={c.url} c={c} />)}
            </ul>
          ) : null}

          {view.value === 'grid' ? (
            <div class="grid">
              {fileRows.slice(0, shown.value).map((c) => <Cell key={c.url} c={c} />)}
            </div>
          ) : (
            <ul class="cands">
              {fileRows.slice(0, shown.value).map((c) => <Row key={c.url} c={c} />)}
            </ul>
          )}

          {fileRows.length > shown.value ? (
            <button class="lnk lnk-more" onClick={() => { shown.value += 200; }}>
              Show {Math.min(200, fileRows.length - shown.value)} more of {fileRows.length}
            </button>
          ) : null}

          {nSel > 0 ? (
            <div class="actions-wrap">
              <div class="actions">
                <button class="btn"
                        disabled={serverOnline.value === false}
                        title={serverOnline.value === false
                          ? 'The API is unreachable — check Settings'
                          : `Queue ${nFiles} on the API. The python worker downloads, zips and tracks them — normally on this machine.`}
                        onClick={() => void sendToServer()}>
                  Queue
                </button>
                <button class="btn btn-alt"
                        title={nFiles > 1
                          ? `Fetch ${nFiles} files here and save them as one archive`
                          : 'Save this file'}
                        onClick={() => void downloadSelected()}>
                  {nFiles > 1 ? 'Zip here' : 'Download'}
                </button>
                <button class="btn btn-alt"
                        title={`Copy ${nSel} URL${nSel === 1 ? '' : 's'} to the clipboard`}
                        onClick={() => void copySelected()}>
                  Copy
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {pswp.value?.present ? <PswpBanner s={pswp.value} /> : null}

      {s && s.candidates.length === 0 ? (
        <div class="empty">
          <h2>Nothing found</h2>
          <p>No media cleared the score floor. Play a video or scroll once, then re-scan.</p>
        </div>
      ) : null}

      {!s && !scanError.value ? (
        <div class="empty">
          <h2>Harvest this page</h2>
          <p>Scans every frame and merges it with what the page already fetched — which is where byte sizes come from.</p>
        </div>
      ) : null}

      {toast.value ? <div class="toast">{toast.value}</div> : null}
    </div>
  );
}
