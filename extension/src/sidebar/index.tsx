/**
 * Sidebar shell.
 *
 * The one structural difference from the popup this replaces: a Firefox sidebar
 * is **per-window, not per-tab**. It stays mounted while you switch tabs, so
 * nothing can be captured at mount time — the active tab has to be tracked and
 * the view re-pointed on every switch. The popup got this for free by dying on
 * close; here it's the main source of stale-state bugs, so it lives in one place
 * (`watchActiveTab`) and everything else reads `page`.
 */

import { render } from 'preact';
import { signal, computed } from '@preact/signals';
import { ext } from '../common/api';
import { displayDomain, profileKey } from '../common/domain';
import {
  CaptureTab, resetCapture, refreshPeek, loggedCount, detectPswp, loadViewPrefs,
} from './capture';
import { DownloadsTab, startJobPolling, setDownloadsVisible, serverOnline, jobs } from './downloads';
import { SettingsTab, loadApiConfig, loadOptions } from './settings';
import { InsightsTab, refreshInsights } from './insights';
import './sidebar.css';

// ---- state ------------------------------------------------------------------

type TabId = 'downloads' | 'capture' | 'insights' | 'settings';
type Surface = 'console' | 'warm';

interface PageCtx {
  tabId: number | null;
  url: string;
  title: string;
}

const activeTab = signal<TabId>('capture');
const surface = signal<Surface>('console');
const page = signal<PageCtx>({ tabId: null, url: '', title: '' });

/** The profile key for whatever is in the active tab. '' on non-http pages. */
const pageDomain = computed(() => profileKey(page.value.url));
const pageLabel = computed(() => displayDomain(page.value.url));

// ---- surface toggle ---------------------------------------------------------

const SURFACE_KEY = 'zipper-sidebar-surface';

function applySurface(next: Surface): void {
  surface.value = next;
  document.documentElement.setAttribute('data-surface', next);
  try {
    void ext.storage.local.set({ [SURFACE_KEY]: next });
  } catch { /* storage unavailable — the toggle still works for this session */ }
}

async function loadSurface(): Promise<void> {
  try {
    const stored = await ext.storage.local.get([SURFACE_KEY]);
    const value = stored?.[SURFACE_KEY];
    applySurface(value === 'warm' ? 'warm' : 'console');
  } catch {
    applySurface('console');
  }
}

// ---- active tab tracking ----------------------------------------------------

async function readActiveTab(): Promise<void> {
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const t = tabs?.[0];
    if (!t) return;
    const next = { tabId: t.id ?? null, url: t.url ?? '', title: t.title ?? '' };
    const moved = next.url !== page.value.url || next.tabId !== page.value.tabId;
    page.value = next;
    // A snapshot belongs to the page it was taken on. Holding it across a tab
    // switch is the classic per-window sidebar bug — you'd act on stale results.
    if (moved) resetCapture();
  } catch {
    page.value = { tabId: null, url: '', title: '' };
    resetCapture();
  }
}

function watchActiveTab(): void {
  void readActiveTab();

  ext.tabs.onActivated.addListener(() => { void readActiveTab(); });

  // Fires for same-tab navigation. Only react when something we display moved —
  // onUpdated is noisy (favicons, audible, discarded) and re-reading on every
  // event would thrash the harvest request once that's wired in.
  ext.tabs.onUpdated.addListener((tabId: number, info: any) => {
    if (tabId !== page.value.tabId) return;
    if (info.url === undefined && info.title === undefined) return;
    void readActiveTab();
  });

  // Sidebars are per-window, and a window switch doesn't fire onActivated.
  ext.windows?.onFocusChanged?.addListener(() => { void readActiveTab(); });
}

// ---- icons ------------------------------------------------------------------

const Icon = {
  downloads: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  capture: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  insights: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="9" />
    </svg>
  ),
  settings: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  contrast: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
    </svg>
  ),
};

// ---- pieces -----------------------------------------------------------------

function Led({ kind, label }: { kind: string; label: string }) {
  return <span class={`led led-${kind}`}>{label}</span>;
}

function WorkerLed() {
  const n = jobs.value.filter(
    (j: any) => j.status === 'running' || j.status === 'queued').length;
  if (n > 0) return <Led kind="relay" label={`${n} running`} />;
  if (serverOnline.value === null) return <Led kind="idle" label="checking" />;
  return serverOnline.value
    ? <Led kind="online" label="server" />
    : <Led kind="alert" label="server down" />;
}

function ContextStrip() {
  const label = pageLabel.value;
  if (!label) {
    return (
      <div class="ctx">
        <span class="ctx-domain">no page</span>
        <span class="hdr-spring" />
        <span class="ctx-note">nothing to capture here</span>
      </div>
    );
  }
  // pageDomain is what a profile would key on; showing it makes the attribution
  // visible rather than something you have to trust.
  return (
    <div class="ctx">
      <span class="ctx-domain" title={page.value.url}>{label}</span>
      <span class="hdr-spring" />
      <span class="ctx-note">
        {pageDomain.value ? `key: ${pageDomain.value}` : 'no profile'}
        {loggedCount.value ? ` · ${loggedCount.value} seen` : ''}
      </span>
    </div>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div class="empty">
      <div class="empty-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">
          <circle cx="12" cy="12" r="9" stroke-dasharray="3 3" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

const TABS: { id: TabId; label: string; icon: () => any }[] = [
  { id: 'downloads', label: 'Downloads', icon: Icon.downloads },
  { id: 'capture', label: 'Capture', icon: Icon.capture },
  { id: 'insights', label: 'Insights', icon: Icon.insights },
  { id: 'settings', label: 'Settings', icon: Icon.settings },
];

function Rail() {
  return (
    <nav class="rail" role="tablist" aria-label="Sidebar sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          class="rail-tab"
          role="tab"
          aria-selected={activeTab.value === t.id}
          aria-controls="sb-panel"
          onClick={() => {
            activeTab.value = t.id;
            setDownloadsVisible(t.id === 'downloads');
            // Fetched on open rather than polled: history changes when you
            // download, which is not something worth asking about every few
            // seconds in the background.
            if (t.id === 'insights') void refreshInsights();
          }}
        >
          <t.icon />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Body() {
  switch (activeTab.value) {
    case 'downloads':
      return <DownloadsTab />;
    case 'capture':
      return <CaptureTab />;
    case 'insights':
      return <InsightsTab />;
    case 'settings':
      return <SettingsTab />;
  }
}

function App() {
  return (
    <div class="shell">
      <header class="hdr">
        <span class="brand">Zipper</span>
        <span class="hdr-spring" />
        <div class="leds"><WorkerLed /></div>
        <button
          class="iconbtn"
          title={surface.value === 'console' ? 'Switch to warm surface' : 'Switch to console surface'}
          aria-label="Toggle surface"
          onClick={() => applySurface(surface.value === 'console' ? 'warm' : 'console')}
        >
          <Icon.contrast />
        </button>
      </header>

      <ContextStrip />

      <main class="body" id="sb-panel" role="tabpanel">
        <Body />
      </main>

      <Rail />
    </div>
  );
}

// ---- boot -------------------------------------------------------------------

void loadSurface();
void refreshPeek();
void loadApiConfig();
void loadOptions();
void loadViewPrefs();
// Asked before anything is scanned: on a PhotoSwipe page the quick scan is the
// misleading option, and saying so up front is the point of the banner.
void detectPswp();
startJobPolling();
watchActiveTab();

const root = document.getElementById('root');
if (root) render(<App />, root);
