// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { getZipperSetting } from '../utils/config';

export function isHighlightEnabled(): boolean {
    const toggleBtn = document.querySelector('#zipper-toggle-highlights-btn');
    if (toggleBtn) {
        return toggleBtn.classList.contains('active');
    }
    return getZipperSetting('highlight-enabled', 'true') !== 'false';
}

const REJECTED_EXTENSIONS = ['.svg', '.ico', '.cur', '.bmp'];
const BLACKLIST_CLASS_PATTERN = /(avatar|sprite|logo|badge|icon|button|btn|emoji|favicon|profile-pic|comment-avatar|user-avatar|nav-icon|header-icon)/i;

export function canHighlightElement(el: Element, url: string = ''): boolean {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest('#zipper-panel') || el.closest('#zipper-fab') || el.closest('#zipper-float-download-btn')) return false;

    const lowerUrl = (url || el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('href') || '').toLowerCase();
    if (REJECTED_EXTENSIONS.some(ext => lowerUrl.includes(ext))) {
        return false;
    }

    const tagName = el.tagName.toLowerCase();

    // Blacklist check on class and ID
    const classIdStr = `${el.className || ''} ${el.id || ''} ${el.parentElement ? (el.parentElement.className || '') + ' ' + (el.parentElement.id || '') : ''}`;
    if (BLACKLIST_CLASS_PATTERN.test(classIdStr)) {
        return false;
    }

    // Visibility check
    try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
    } catch (_) { }

    // Dimensions check for images & background containers
    if (tagName === 'img') {
        const img = el as HTMLImageElement;
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (nw > 0 && nh > 0) {
            if (nw < 120 || nh < 120 || (nw * nh) < 15000) return false;
        }
        const w = img.offsetWidth || img.clientWidth || 0;
        const h = img.offsetHeight || img.clientHeight || 0;
        if (w > 0 && h > 0 && (w < 100 || h < 100 || (w * h) < 12000)) return false;
    } else if (tagName === 'div' || tagName === 'span') {
        const w = (el as HTMLElement).offsetWidth || (el as HTMLElement).clientWidth || 0;
        const h = (el as HTMLElement).offsetHeight || (el as HTMLElement).clientHeight || 0;
        if (w > 0 && h > 0 && (w < 120 || h < 120 || (w * h) < 15000)) return false;
    } else if (tagName === 'a') {
        // Only highlight anchor if it directly contains a valid media element
        const childImg = el.querySelector('img, video, picture');
        if (childImg) {
            return canHighlightElement(childImg, url);
        }
        // Direct media links only
        const isDirectMedia = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mkv|mov)(?:[?#].*)?$/i.test(lowerUrl);
        if (!isDirectMedia) return false;
    }

    return true;
}

export function highlightElement(el: Element, url: string = ''): void {
    if (!isHighlightEnabled()) return;
    if (!canHighlightElement(el, url)) return;

    let target = el;
    if (el.tagName.toLowerCase() === 'source' && el.parentElement) {
        target = el.parentElement;
    }
    target.classList.add('zipper-captured-highlight');
}
