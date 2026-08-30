/**
 * Capture tab.
 *
 * The filter row is built directly on the candidate record's fields — kind,
 * width, bytes — rather than re-deriving anything, which is the whole reason
 * the harvest emits typed records instead of a boolean. "Min size" in
 * particular only works because the network log supplies Content-Length.
 */

import { signal, computed } from '@preact/signals';
import { ext } from '../common/api';
import { type MediaCandidate, type MediaKind, suggestedName } from '../common/harvest';
import { SCORE } from '../common/scoring';
import { serverOnline } from './downloads';

interface Snapshot {
  candidates: MediaCandidate[];
  pageUrl: string;
  pageDomain: string;
  path: 'full' | 'network-only';
  frames: number;
  fromNetwork: number;
  fromDom: number;
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
/** CSS selector limiting the scan to one container. '' = whole page. */
export const scope = signal('');
export const scopeMatches = signal<number | null>(null);
export const picking = signal(false);

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
      void refreshGrabbed(res.snapshot.candidates.map((c: MediaCandidate) => c.url));

      if (hadSelection) {
        // A re-scan must not throw away what you had ticked. Keep the existing
        // selection, narrowed to URLs that still exist in the new results —
        // auto-selecting again here is how a careful selection gets wiped by
        // one click.
        const live = new Set(res.snapshot.candidates.map((c: MediaCandidate) => c.url));
        selected.value = new Set([...selected.value].filter((u) => live.has(u)));
      } else {
        selected.value = new Set<string>(
          res.snapshot.candidates
            .filter((c: MediaCandidate) => c.score >= SCORE.INTERESTING)
            .map((c: MediaCandidate) => c.url));
      }
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
  if (highlightOn.value) { void clearHighlightsOnPage(); highlightOn.value = false; }
  snapshot.value = null;
  scanError.value = '';
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

function selectAll(on: boolean): void {
  selected.value = on ? new Set(filtered.value.map((c) => c.url)) : new Set();
  if (highlightOn.value) void pushHighlights();
}

// ---- highlighting -----------------------------------------------------------

export const highlightOn = signal(false);

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

async function toggleHighlight(): Promise<void> {
  highlightOn.value = !highlightOn.value;
  if (highlightOn.value) await pushHighlights();
  else await clearHighlightsOnPage();
}

async function downloadSelected(): Promise<void> {
  const items = selectedList.value;
  if (!items.length) return;
  if (items.length >= BULK_THRESHOLD) {
    // Deliberately a confirm: this is the path that floods the download
    // history, and it is irreversible once eighty entries are in there.
    const go = confirm(
      `Download ${items.length} files directly?

` +
      `That's ${items.length} separate entries in your browser download history, ` +
      `with no archive and no progress tracking.

` +
      `"Zip on server" batches them into one job instead.`);
    if (!go) return;
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
    ? `Sent ${ok} to the browser`
    : `Sent ${ok} of ${items.length} — ${items.length - ok} refused`);
  void refreshGrabbed(filtered.value.map((c) => c.url));
}

async function sendToServer(): Promise<void> {
  const items = selectedList.value;
  if (!items.length) return;
  try {
    const kinds: Record<string, string> = {};
    for (const c of items) kinds[c.url] = c.kind;
    const res = await ext.runtime.sendMessage({
      kind: 'harvest:send-server',
      links: items.map((c) => c.url),
      kinds,
      pageUrl: snapshot.value?.pageUrl || '',
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

const KINDS: (MediaKind | 'all')[] = ['all', 'image', 'video', 'audio', 'document'];

/** Above this, a direct browser download stops being reasonable. */
const BULK_THRESHOLD = 8;

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
        <span class="cand-spring" />
        <span class="cand-score">{c.score}</span>
      </div>
    </li>
  );
}

// ---- view -------------------------------------------------------------------

export function CaptureTab() {
  const s = snapshot.value;
  const list = filtered.value;
  const nSel = selectedList.value.length;

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
            <button class="lnk" onClick={() => selectAll(true)}>All</button>
            <button class="lnk" onClick={() => selectAll(false)}>None</button>
            <span class="cell-spring" />
            <button class={`iconbtn${highlightOn.value ? ' iconbtn-on' : ''}`}
                    title={highlightOn.value ? 'Stop outlining on the page' : 'Outline these on the page'}
                    onClick={() => void toggleHighlight()}>
              ◎
            </button>
            <button class="iconbtn" title={view.value === 'grid' ? 'List view' : 'Grid view'}
                    onClick={() => { view.value = view.value === 'grid' ? 'list' : 'grid'; }}>
              {view.value === 'grid' ? '☰' : '▦'}
            </button>
          </div>

          {view.value === 'grid' ? (
            <div class="grid">
              {list.slice(0, shown.value).map((c) => <Cell key={c.url} c={c} />)}
            </div>
          ) : (
            <ul class="cands">
              {list.slice(0, shown.value).map((c) => <Row key={c.url} c={c} />)}
            </ul>
          )}

          {list.length > shown.value ? (
            <button class="lnk lnk-more" onClick={() => { shown.value += 200; }}>
              Show {Math.min(200, list.length - shown.value)} more of {list.length}
            </button>
          ) : null}

          {nSel > 0 ? (
            <div class="actions-wrap">
              {nSel >= BULK_THRESHOLD && serverOnline.value !== false ? (
                <div class="hint">
                  {nSel} files direct to the browser means {nSel} entries in your
                  download history and no archive. Server zips them into one.
                </div>
              ) : null}
              <div class="actions">
                <button class="btn"
                        disabled={serverOnline.value === false}
                        title={serverOnline.value === false
                          ? 'Server is unreachable'
                          : 'Batch, zip and track on the server'}
                        onClick={() => void sendToServer()}>
                  Zip {nSel} on server
                </button>
                <button class="btn btn-alt"
                        title="One browser download per file — no archive, no tracking"
                        onClick={() => void downloadSelected()}>
                  Direct
                </button>
                <button class="btn btn-alt" onClick={() => void copySelected()}>Copy</button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

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
