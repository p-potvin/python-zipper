/**
 * Extension-wide options.
 *
 * These are *global* preferences, not per-scan state. That distinction is the
 * point: highlighting and the in-page download button used to be things you
 * turned on again after every scan, from the panel that no longer exists, which
 * meant that in practice they were off. They belong to the browsing session,
 * not to a result set.
 *
 * Read straight from `storage.local` in every context rather than routed
 * through the background. Content scripts run in every frame, and asking the
 * background for a boolean on load is a round trip per frame that can lose a
 * race with the first paint. `storage.onChanged` then gives every frame live
 * updates for free — flip a switch in the sidebar and the page reacts.
 */

import { ext } from './api';

export interface ZipperSettings {
  /** Outline harvestable media on the page, always, not per scan. */
  highlight: boolean;
  /** Show the hover download button over media on the page. */
  injectButton: boolean;
  /**
   * Elements smaller than this in either axis never get a button.
   *
   * The button is deliberately permissive about *what* it offers itself on —
   * a false positive costs a glance. It cannot be permissive about size: a
   * button pinned over a 16px thumbnail covers the whole thing and eats the
   * click that would have opened it, so the page stops working. That is an
   * automatic rejection rather than a judgement call.
   */
  minButtonPx: number;
  /**
   * Re-scan on DOM changes that follow a real user action.
   *
   * Only ever armed by an `isTrusted` event, which is what makes it useful
   * rather than noisy: clicking through a carousel, scrolling a feed, opening
   * a larger version of an image are all moments where the user has told us
   * where to look, and the observer then picks up what that revealed.
   */
  liveScan: boolean;
  /** Archive whenever a download covers more than one file. */
  zipMultiple: boolean;
  /**
   * Offer a rename when a recording ends — finished, stopped by you, or
   * stopped on its own.
   *
   * Not the browser's save dialog: that is switched off here, and when it is
   * on it can open somewhere nobody is looking. The file is always written
   * under its automatic name first; this only keeps a rename on offer, via a
   * notification and a card at the top of the sidebar.
   */
  askNameOnFinish: boolean;
  /**
   * Keep the automatic name after this many seconds without an answer.
   * 0 means wait until you choose (the worker still gives up after 12 hours).
   */
  autoSaveAfterSec: number;
}

export const DEFAULT_SETTINGS: ZipperSettings = {
  highlight: false,
  injectButton: true,
  minButtonPx: 22,
  liveScan: true,
  zipMultiple: true,
  askNameOnFinish: false,
  autoSaveAfterSec: 120,
};

const KEY = 'zipper-settings';

function coerce(raw: any): ZipperSettings {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  // A stored value from an older build can be any shape at all. Clamp rather
  // than trust: a NaN threshold would reject every element on the page and look
  // exactly like the feature being broken.
  const px = Number(s.minButtonPx);
  s.minButtonPx = Number.isFinite(px) ? Math.min(200, Math.max(0, Math.round(px))) : DEFAULT_SETTINGS.minButtonPx;
  s.highlight = !!s.highlight;
  s.injectButton = !!s.injectButton;
  s.liveScan = !!s.liveScan;
  s.zipMultiple = !!s.zipMultiple;
  s.askNameOnFinish = !!s.askNameOnFinish;
  const wait = Number(s.autoSaveAfterSec);
  s.autoSaveAfterSec = Number.isFinite(wait)
    ? Math.min(86_400, Math.max(0, Math.round(wait)))
    : DEFAULT_SETTINGS.autoSaveAfterSec;
  return s;
}

export async function loadSettings(): Promise<ZipperSettings> {
  try {
    const got = await ext.storage.local.get(KEY);
    return coerce(got?.[KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<ZipperSettings>): Promise<ZipperSettings> {
  const next = coerce({ ...(await loadSettings()), ...patch });
  try { await ext.storage.local.set({ [KEY]: next }); } catch { /* storage unavailable */ }
  return next;
}

/**
 * Subscribe to changes. Fires in whichever context registers it, including
 * every frame of a content script, so a toggle in the sidebar reaches the page
 * without the sidebar having to know which tabs exist.
 */
export function onSettingsChanged(fn: (s: ZipperSettings) => void): () => void {
  const listener = (changes: any, area: string) => {
    if (area !== 'local' || !changes?.[KEY]) return;
    try { fn(coerce(changes[KEY].newValue)); } catch { /* listener threw; not ours to fix */ }
  };
  try { ext.storage.onChanged.addListener(listener); } catch { return () => {}; }
  return () => { try { ext.storage.onChanged.removeListener(listener); } catch { /* ignore */ } };
}
