// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { harvestLinks } from '../utils/scraper';
import { isCloudUrl, isMediaUrl, normalizeUrl } from '../utils/helpers';

export function createRefreshHarvestedLinks(
    mediaListContainer: HTMLElement,
    mediaCountSpan: HTMLElement
) {
    let lastHarvestedMediaSerialized = "";

    function refreshHarvestedLinks() {
        const harvested = harvestLinks();
        if (mediaCountSpan) {
            mediaCountSpan.textContent = harvested.mediaLinks.length;
        }

        const mediaUrls = harvested.mediaLinks.map(item => item.url);
        const currentMediaSerialized = JSON.stringify(mediaUrls);

        if (currentMediaSerialized !== lastHarvestedMediaSerialized) {
            lastHarvestedMediaSerialized = currentMediaSerialized;
            if (harvested.mediaLinks.length === 0) {
                mediaListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No harvested media links found on this page.</div>';
            } else {
                const checkedUrls = new Set(
                    Array.from(mediaListContainer.querySelectorAll('.zipper-media-checkbox:checked'))
                        .map(cb => cb.getAttribute('data-url'))
                );
                const renderedUrls = new Set(
                    Array.from(mediaListContainer.querySelectorAll('.zipper-media-checkbox'))
                        .map(cb => cb.getAttribute('data-url'))
                );

                mediaListContainer.innerHTML = harvested.mediaLinks.map((item, idx) => {
                    const url = item.url;
                    const isChecked = renderedUrls.has(url) ? checkedUrls.has(url) : item.isInteresting;
                    return `
                        <div class="zipper-link-item" data-url="${url}">
                            <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" ${isChecked ? 'checked' : ''}>
                            <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    function resetHarvestCache() {
        lastHarvestedMediaSerialized = "";
    }

    return { refreshHarvestedLinks, resetHarvestCache };
}

export function addDroppedLinks(
    links: string[],
    imagesSection: HTMLElement,
    mediaListContainer: HTMLElement,
    mediaCountSpan: HTMLElement
) {
    links.forEach(url => {
        url = normalizeUrl(url, window.location.href);
        if (!url) return;

        const exists = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox')).some(cb => cb.getAttribute('data-url') === url);
        if (!exists) {
            const idx = imagesSection.querySelectorAll('.zipper-media-checkbox').length;
            const itemHtml = `
                <div class="zipper-link-item" data-url="${url}">
                    <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" checked>
                    <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                </div>
            `;
            if (mediaListContainer.querySelector('.zipper-text-muted') || mediaListContainer.textContent.includes('No harvested')) {
                mediaListContainer.innerHTML = '';
            }
            mediaListContainer.insertAdjacentHTML('beforeend', itemHtml);
            if (mediaCountSpan) {
                mediaCountSpan.textContent = String(parseInt(mediaCountSpan.textContent || '0') + 1);
            }
        }
    });
}
