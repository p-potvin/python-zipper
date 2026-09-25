/**
 * OnlyFans grabber — the "OF images downloader ALT+Q" userscript, ported as-is.
 *
 * Alt+Q scrolls the profile's media grid to the bottom (until the DOM stops
 * changing), opens the last photo so the site builds its PhotoSwipe viewer,
 * reads the viewer's Vue `dataSource` — every loaded item's full-size URL —
 * closes it again, and hands the list to the background to fetch and zip.
 * STOP & DOWNLOAD ends the scroll early and downloads what has loaded so far.
 *
 * What changed from the userscript is only the naming: archives follow the
 * Pornpics convention (`<model>__________<hash>.zip`, `<model>_<NNN>.jpg`,
 * batches of 80) so they import into a gallery without renaming. The fetching
 * moved to the background, which has the host permission the userscript got
 * from GM_xmlhttpRequest.
 */

import { ext } from '../common/api';
import { normalizeModelName } from '../common/gallery_naming';

let ui: HTMLDivElement | null = null;
let bar: HTMLDivElement | null = null;
let status: HTMLDivElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let abortScroll = false;
let running = false;

// ---- UI: the userscript's bottom bar, unchanged ------------------------------

function createUI(): void {
  if (ui) return;
  ui = document.createElement('div');
  Object.assign(ui.style, {
    position: 'fixed', bottom: '0', left: '0', width: '100%', height: '40px',
    backgroundColor: 'rgba(15, 12, 24, 0.95)', borderTop: '1px solid #3c2a61',
    zIndex: '9999999', fontFamily: '"Jetbrains Mono", Roboto, Helvetica, monospace',
    display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
    boxShadow: '0 -5px 25px rgba(0,0,0,0.8)', pointerEvents: 'none',
    transition: 'opacity 0.4s ease', opacity: '1',
  } as Partial<CSSStyleDeclaration>);

  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '0 15px 4px 15px',
  } as Partial<CSSStyleDeclaration>);

  status = document.createElement('div');
  Object.assign(status.style, {
    color: '#dcd3ff', fontSize: '12px', fontWeight: '600', letterSpacing: '0.5px',
    textShadow: '0 2px 4px rgba(0,0,0,0.5)', flexGrow: '1',
  } as Partial<CSSStyleDeclaration>);
  status.textContent = 'Initializing Pipeline... | 0%';

  stopBtn = document.createElement('button');
  stopBtn.textContent = 'STOP & DOWNLOAD';
  Object.assign(stopBtn.style, {
    backgroundColor: '#ef4444', color: '#ffffff', border: 'none', borderRadius: '4px',
    padding: '4px 12px', fontSize: '11px', fontWeight: '700', cursor: 'pointer',
    pointerEvents: 'auto', boxShadow: '0 0 8px rgba(239, 68, 68, 0.5)',
    transition: 'background-color 0.2s', marginLeft: '15px',
  } as Partial<CSSStyleDeclaration>);
  stopBtn.addEventListener('mouseenter', () => { if (stopBtn) stopBtn.style.backgroundColor = '#dc2626'; });
  stopBtn.addEventListener('mouseleave', () => { if (stopBtn) stopBtn.style.backgroundColor = '#ef4444'; });
  stopBtn.addEventListener('click', () => {
    abortScroll = true;
    if (!stopBtn) return;
    stopBtn.disabled = true;
    stopBtn.style.backgroundColor = '#4b5563';
    stopBtn.textContent = 'HALTING...';
  });

  row.appendChild(status);
  row.appendChild(stopBtn);

  const track = document.createElement('div');
  Object.assign(track.style, {
    width: '100%', height: '6px', backgroundColor: '#1b162b', overflow: 'hidden',
  } as Partial<CSSStyleDeclaration>);
  bar = document.createElement('div');
  Object.assign(bar.style, {
    width: '0%', height: '100%',
    background: 'linear-gradient(90deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)',
    boxShadow: '0 0 12px #a855f7', transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
    willChange: 'width',
  } as Partial<CSSStyleDeclaration>);
  track.appendChild(bar);
  ui.appendChild(row);
  ui.appendChild(track);
  document.body.appendChild(ui);
}

function updateUI(pct: number, label: string): void {
  if (!ui) createUI();
  if (!ui || !bar || !status) return;
  ui.style.opacity = '1';
  bar.style.width = `${pct}%`;
  status.textContent = `${label} | ${Math.round(pct)}%`;
}

function removeUIWithDelay(): void {
  const el = ui;
  if (!el) return;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      if (ui === el) { ui = null; bar = null; status = null; stopBtn = null; }
    }, 400);
  }, 3000);
}

// ---- the pipeline ----------------------------------------------------------

function scrollToBottomSmart(): Promise<void> {
  return new Promise((resolve) => {
    createUI();
    updateUI(0, 'Scanning timeline and caching pages...');
    let lastMutation = Date.now();
    const observer = new MutationObserver(() => { lastMutation = Date.now(); });
    observer.observe(document.body, { childList: true, subtree: true });

    const done = () => {
      clearInterval(scroller);
      clearInterval(checker);
      observer.disconnect();
      resolve();
    };
    const scroller = setInterval(() => {
      if (abortScroll) { done(); return; }
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }, 300);
    const checker = setInterval(() => {
      const idle = Date.now() - lastMutation;
      const hitBottom = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 50;
      if ((hitBottom && idle > 1500) || abortScroll) done();
    }, 500);
  });
}

/** Ask the page-world hook for the viewer's dataSource. */
function readDataSource(timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const id = `of${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const onMsg = (e: MessageEvent) => {
      const m: any = e.data;
      if (e.source !== window || !m || m.source !== 'zipper:page-probe-result' || m.id !== id) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(m.ok && Array.isArray(m.data?.urls) ? m.data.urls : []);
    };
    const timer = setTimeout(() => { window.removeEventListener('message', onMsg); resolve([]); }, timeoutMs);
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'zipper:page-probe', id, op: 'of:datasource' }, window.location.origin);
  });
}

/**
 * The model the page belongs to. The userscript used the whole pathname,
 * which is where `_user_media_batch_1.zip` came from; the first segment is
 * the username on every profile tab (`/user`, `/user/media`, `/user/photos`).
 */
function modelName(): string {
  const first = location.pathname.split('/').filter(Boolean)[0] || '';
  if (first && first !== 'my') return normalizeModelName(first);
  const handle = document.querySelector('.g-user-username')?.textContent || '';
  return normalizeModelName(handle.replace(/^@/, '')) || 'onlyfans';
}

async function runPipeline(): Promise<void> {
  abortScroll = false;
  await scrollToBottomSmart();

  const last = document.querySelector<HTMLElement>('.b-photos__item:last-of-type');
  if (!last) {
    updateUI(0, 'Error: Could not locate entry thumbnail node.');
    removeUIWithDelay();
    return;
  }
  updateUI(0, 'Opening the viewer...');
  last.click();
  await new Promise((r) => setTimeout(r, 600));

  if (!document.querySelector('div.photoswipe')) {
    updateUI(0, 'Error: the photo viewer did not open.');
    removeUIWithDelay();
    return;
  }
  const urls = await readDataSource();
  document.querySelector<HTMLElement>('.pswp__button--close')?.click();
  if (!urls.length) {
    updateUI(0, 'Error: the viewer listed no photos.');
    removeUIWithDelay();
    return;
  }

  if (stopBtn) stopBtn.style.display = 'none';
  const model = modelName();
  updateUI(0, `${urls.length} photos for ${model} — downloading...`);
  try {
    const res = await ext.runtime.sendMessage({ kind: 'of:grab', urls, model });
    updateUI(100, res?.ok
      ? `Done! ${res.count}/${urls.length} saved in ${res.archives} archive(s)${res.duplicates ? `, ${res.duplicates} duplicate(s) skipped` : ''}${res.failed ? `, ${res.failed} failed` : ''}.`
      : `Error: ${res?.error || 'download failed'}`);
  } catch (e: any) {
    updateUI(0, `Error: ${String(e?.message || e)}`);
  }
  removeUIWithDelay();
}

export function installOnlyFansGrabber(): void {
  // Progress from the background while it fetches and zips.
  ext.runtime.onMessage.addListener((msg: any) => {
    if (msg?.kind === 'of:progress') updateUI(msg.pct, msg.label);
  });
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.code !== 'KeyQ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (running) return;
    running = true;
    void runPipeline().finally(() => { running = false; });
  }, true);
}
