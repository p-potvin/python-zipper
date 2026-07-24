// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { getZipperSetting } from '../utils/config';

export function isHighlightEnabled(): boolean {
    const toggleBtn = document.querySelector('#zipper-toggle-highlights-btn');
    if (toggleBtn) {
        return toggleBtn.classList.contains('active');
    }
    return getZipperSetting('highlight-enabled', 'true') !== 'false';
}

export function highlightElement(el: Element): void {
    if (!isHighlightEnabled()) return;
    let target = el;
    if (el.tagName.toLowerCase() === 'source' && el.parentElement) {
        target = el.parentElement;
    }
    target.classList.add('zipper-captured-highlight');
}
