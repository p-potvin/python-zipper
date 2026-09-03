/**
 * Page-world hook.
 *
 * Runs in the page's own JavaScript world (`"world": "MAIN"` in the manifest),
 * which is the only way to see the page's globals. A normal content script is
 * isolated: it shares the DOM but gets a different `window`, so `window.pswp`
 * there is always undefined no matter what the page has done. That is why the
 * old carousel detector's `(window as any).pswp` check never fired outside a
 * userscript, where everything ran in the page world by default.
 *
 * The contract is deliberately tiny and one-directional in intent: the isolated
 * content script asks a fixed question by id, this answers with plain JSON.
 * Nothing here evaluates anything the page or the content script sends, and no
 * capability is exposed to the page — a page that posts one of these messages
 * to itself only learns what it already knows about its own gallery.
 */

const CHANNEL_REQ = 'zipper:page-probe';
const CHANNEL_RES = 'zipper:page-probe-result';

/** Ops this hook answers. Anything else is ignored. */
type Op = 'pswp:detect' | 'pswp:data';

interface SlideRecord {
  src?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  label?: string;
  html?: boolean;
}

const w = window as any;

// ---- finding the viewer -----------------------------------------------------

/**
 * PhotoSwipe v5 keeps the gallery on `instance.options.dataSource`; v4 kept it
 * on `instance.items`. Accept either, and require the array so a half-built
 * object is never mistaken for a live viewer.
 */
function isPswp(o: any): boolean {
  if (!o || typeof o !== 'object') return false;
  try {
    if (Array.isArray(o.options?.dataSource)) return true;
    if (Array.isArray(o.options?.dataSource?.items)) return true;
    return Array.isArray(o.items) && o.items.length > 0;
  } catch {
    return false;   // a getter that throws is not our viewer
  }
}

/** Known globals first, then a bounded sweep. */
function findPswp(): any {
  const direct = ['pswp', 'photoswipe', 'PhotoSwipe', '__pswp__', 'lightbox', 'gallery'];
  for (const k of direct) {
    try {
      const v = w[k];
      if (isPswp(v)) return v;
      // A lightbox holds the open viewer on `.pswp`.
      if (v && typeof v === 'object' && isPswp(v.pswp)) return v.pswp;
    } catch { /* getter threw */ }
  }

  // Sites bundle their viewer under an app-specific name — OnlyFans reaches it
  // through its own globals rather than a documented one. Rather than chase
  // each site's naming, look for the shape: any own global holding something
  // with a dataSource array. Bounded so a page with a huge global namespace
  // can't turn this into a stall.
  let seen = 0;
  let keys: string[] = [];
  try { keys = Object.keys(w); } catch { return null; }
  for (const k of keys) {
    if (++seen > 500) break;
    let v: any;
    try { v = w[k]; } catch { continue; }
    if (isPswp(v)) return v;
    if (!v || typeof v !== 'object') continue;
    try {
      if (isPswp(v.pswp)) return v.pswp;
      if (isPswp(v.instance)) return v.instance;
    } catch { /* keep going */ }
  }
  return null;
}

// ---- reading it -------------------------------------------------------------

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function str(v: any): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Flatten one dataSource entry to the fields we use.
 *
 * Everything else in the record — like counts, post ids, timestamps — is real
 * and occasionally interesting, but carrying it would mean shipping the page's
 * arbitrary objects across the boundary. The one piece of metadata kept is a
 * post id, because it is the only thing that makes a downloaded file traceable
 * back to where it came from.
 */
function readSlide(item: any): SlideRecord | null {
  if (!item || typeof item !== 'object') return null;
  const src = str(item.src) || str(item.originalUrl) || str(item.url);
  const thumbnail = str(item.thumbnail) || str(item.msrc) || str(item.thumb);
  if (!src && !thumbnail) return null;

  const postId = item.postId ?? item.post_id ?? item.id;
  return {
    src,
    thumbnail,
    width: num(item.width) || num(item.w),
    height: num(item.height) || num(item.h),
    label: postId !== undefined && postId !== null ? String(postId).slice(0, 40) : undefined,
    // A slide whose payload is markup rather than a file is a promo or a
    // paywall notice, not media. Flagged so the caller can drop it.
    html: !src && !!str(item.html),
  };
}

function slidesFrom(pswp: any): SlideRecord[] {
  let raw: any[] = [];
  try {
    const ds = pswp?.options?.dataSource;
    if (Array.isArray(ds)) raw = ds;
    else if (Array.isArray(ds?.items)) raw = ds.items;
    else if (Array.isArray(pswp?.items)) raw = pswp.items;
  } catch { return []; }

  const out: SlideRecord[] = [];
  for (const item of raw.slice(0, 5000)) {
    const s = readSlide(item);
    if (s && !s.html) out.push(s);
  }
  return out;
}

// ---- detection --------------------------------------------------------------

/** Is PhotoSwipe present at all, whether or not a viewer is currently open? */
function detect(): { present: boolean; open: boolean; slides: number; via: string } {
  const inst = findPswp();
  const slides = inst ? slidesFrom(inst).length : 0;

  let via = '';
  if (inst) via = 'instance';
  else {
    for (const k of ['PhotoSwipe', 'PhotoSwipeLightbox', 'pswp', 'PhotoSwipeUI_Default']) {
      try { if (w[k]) { via = 'global:' + k; break; } } catch { /* getter threw */ }
    }
  }

  return {
    present: !!inst || !!via,
    // `pswp` only exists on the page while the viewer is actually open in v5,
    // so an instance carrying slides is the strongest "it is open right now".
    open: !!inst && slides > 0,
    slides,
    via,
  };
}

// ---- wire -------------------------------------------------------------------

function reply(id: string, ok: boolean, data: any): void {
  try {
    window.postMessage({ source: CHANNEL_RES, id, ok, data }, window.location.origin || '*');
  } catch { /* structured clone failed — nothing sensible to send */ }
}

/**
 * Announce that this hook is live.
 *
 * Without a marker the isolated side has no way to tell "no PhotoSwipe here"
 * from "nothing is listening", so every probe in every frame would have to sit
 * out its full timeout before concluding the same thing. On a page with a dozen
 * iframes that turns a quick scan into a visibly slow one, purely to discover
 * that a hook was never injected.
 */
function mark(): void {
  try {
    (document.documentElement || document.body)?.setAttribute('data-zipper-hook', '1');
  } catch { /* pre-render document */ }
}
mark();
// Re-marked once the document is built: this runs at document_start, and a page
// that rewrites its root element between then and now would otherwise take the
// marker with it, silently turning PhotoSwipe reading off.
try { document.addEventListener('DOMContentLoaded', mark, { once: true }); } catch { /* ignore */ }

window.addEventListener('message', (e: MessageEvent) => {
  // Same-window only. This channel exists to cross the isolated/main boundary
  // inside one document, never between documents.
  if (e.source !== window) return;
  const msg: any = e.data;
  if (!msg || msg.source !== CHANNEL_REQ || typeof msg.id !== 'string') return;

  const op: Op = msg.op;
  try {
    if (op === 'pswp:detect') { reply(msg.id, true, detect()); return; }
    if (op === 'pswp:data') {
      const inst = findPswp();
      reply(msg.id, true, { slides: inst ? slidesFrom(inst) : [], found: !!inst });
      return;
    }
  } catch (err) {
    reply(msg.id, false, { error: String(err) });
  }
});
