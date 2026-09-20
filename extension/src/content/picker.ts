/**
 * Container picker.
 *
 * Sidebar-initiated: you click "Pick", the page enters crosshair mode, and the
 * element you click becomes a CSS selector the harvest can be scoped to. The
 * last thing the retired in-page panel did that nothing else covered.
 *
 * `optimalSelector` is ported from the panel largely intact — it is the useful
 * part, and its ordering (stable id, then meaningful classes, then test
 * attributes, then a parent chain) reflects real wear on real sites. The
 * overlay around it is rewritten in vaultsqware colours and no longer has to
 * dodge the panel's own DOM.
 */

const BOX_ID = 'zipper-picker-box';
const TIP_ID = 'zipper-picker-tip';

/** Framework noise and state classes that make a brittle selector. */
const IGNORED_CLASS = /^(zipper-|active|hover|focus|show|hide|hidden|selected|open|closed|is-|has-|ng-|v-|style-|css-|sc-|_)/i;

export function optimalSelector(el: Element): string {
  if (!el || el === document.body || el === document.documentElement) return '';

  // 1. A stable, unique id.
  if (el.id && typeof el.id === 'string') {
    const id = el.id.trim();
    if (id && !/^[0-9]+$/.test(id) && !id.includes('zipper-') && !id.includes('ember') && !id.includes(':')) {
      try {
        if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
      } catch { /* invalid id for a selector */ }
    }
  }

  // 2. Meaningful classes, preferring the narrowest combination that still
  //    matches a plausible container-sized set rather than one element.
  const cls = typeof el.className === 'string' ? el.className : '';
  if (cls) {
    const valid = cls.split(/\s+/).filter(Boolean)
      .filter((c) => !IGNORED_CLASS.test(c) && !/^[0-9a-f]{8,}$/i.test(c));
    if (valid.length) {
      for (let len = 1; len <= Math.min(3, valid.length); len++) {
        const sel = '.' + valid.slice(0, len).map((c) => CSS.escape(c)).join('.');
        try {
          const n = document.querySelectorAll(sel).length;
          if (n > 0 && n <= 15) return sel;
        } catch { /* keep trying */ }
      }
      return '.' + CSS.escape(valid[0]);
    }
  }

  // 3. Test/semantic attributes are usually the most stable thing on the page.
  for (const attr of ['data-test', 'data-testid', 'data-qa', 'name', 'role']) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${CSS.escape(val)}"]`;
  }

  // 4. Fall back to a parent chain.
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent && parent !== document.body) {
    const parentSel = optimalSelector(parent);
    if (parentSel) return `${parentSel} > ${tag}`;
  }
  return tag;
}

// ---- overlay ----------------------------------------------------------------

let active = false;
let box: HTMLElement | null = null;
let tip: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

function makeOverlay(): void {
  if (!box) {
    box = document.createElement('div');
    box.id = BOX_ID;
    Object.assign(box.style, {
      position: 'absolute', pointerEvents: 'none', display: 'none',
      border: '2px solid #6E7BF2',
      background: 'rgba(110,123,242,0.14)',
      boxShadow: '0 0 0 3px rgba(110,123,242,0.28)',
      borderRadius: '4px',
      zIndex: '2147483640',
      transition: 'all 60ms ease-out',
    } as CSSStyleDeclaration);
    document.body.appendChild(box);
  }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = TIP_ID;
    Object.assign(tip.style, {
      position: 'absolute', pointerEvents: 'none', display: 'none',
      background: '#11141B', color: '#E6EAF2',
      padding: '4px 8px', borderRadius: '4px',
      border: '1px solid rgba(255,255,255,0.12)',
      fontFamily: '"JetBrains Mono", Consolas, ui-monospace, monospace',
      fontSize: '11px', maxWidth: '60vw',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      zIndex: '2147483641',
      boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
    } as CSSStyleDeclaration);
    document.body.appendChild(tip);
  }
}

function teardown(): void {
  active = false;
  document.body.style.cursor = '';
  if (box) box.style.display = 'none';
  if (tip) tip.style.display = 'none';
  if (cleanup) { cleanup(); cleanup = null; }
}

export function stopPicker(): void {
  if (active) teardown();
}

export function isPickerActive(): boolean {
  return active;
}

/**
 * Enter picking mode. Resolves with the chosen selector, or '' if cancelled
 * with Escape or by right-clicking.
 */
export function startPicker(): Promise<string> {
  if (active) { teardown(); return Promise.resolve(''); }
  active = true;
  makeOverlay();
  document.body.style.cursor = 'crosshair';

  return new Promise<string>((resolve) => {
    let current = '';

    const onMove = (e: MouseEvent) => {
      if (!active) return;
      const target = e.target as HTMLElement | null;
      if (!target || target === box || target === tip) return;

      const rect = target.getBoundingClientRect();
      current = optimalSelector(target);

      if (box) {
        box.style.display = 'block';
        box.style.top = `${rect.top + window.scrollY}px`;
        box.style.left = `${rect.left + window.scrollX}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      }
      if (tip) {
        let n = 0;
        try { n = document.querySelectorAll(current).length; } catch { /* bad selector */ }
        tip.style.display = 'block';
        tip.textContent = `${current}  ·  ${n} match${n === 1 ? '' : 'es'}`;
        // Sit above the element, or below it when there's no room up top.
        const top = rect.top + window.scrollY - 26;
        tip.style.top = `${top < window.scrollY ? rect.bottom + window.scrollY + 6 : top}px`;
        tip.style.left = `${rect.left + window.scrollX}px`;
      }
    };

    const finish = (value: string) => { teardown(); resolve(value); };

    const onClick = (e: MouseEvent) => {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      finish(current);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(''); }
    };

    const onContext = (e: MouseEvent) => { e.preventDefault(); finish(''); };

    // Capture phase throughout: pages bind their own handlers and would
    // otherwise swallow the click before we ever see it.
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', onContext, true);

    cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', onContext, true);
    };
  });
}

/** Count how many elements a selector currently matches. -1 if it's invalid. */
export function selectorMatchCount(selector: string): number {
  if (!selector) return 0;
  try { return document.querySelectorAll(selector).length; } catch { return -1; }
}
