// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { harvestLinks } from '../utils/scraper';
import { isCloudUrl, isMediaUrl, normalizeUrl } from '../utils/helpers';

export function createRefreshHarvestedLinks(
    mediaListContainer: HTMLElement,
    cloudListContainer: HTMLElement,
    mediaCountSpan: HTMLElement,
    cloudCountSpan: HTMLElement
) {
    let lastHarvestedMediaSerialized = "";
    let lastHarvestedCloudSerialized = "";

    function refreshHarvestedLinks() {
        const harvested = harvestLinks();
        mediaCountSpan.textContent = harvested.mediaLinks.length;
        cloudCountSpan.textContent = harvested.cloudLinks.length;

        const mediaUrls = harvested.mediaLinks.map(item => item.url);
        const currentMediaSerialized = JSON.stringify(mediaUrls);
        const currentCloudSerialized = JSON.stringify(harvested.cloudLinks);

        if (currentMediaSerialized !== lastHarvestedMediaSerialized) {
            lastHarvestedMediaSerialized = currentMediaSerialized;
            if (harvested.mediaLinks.length === 0) {
                mediaListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No harvested media links found.</div>';
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
                        <div class="zipper-link-item">
                            <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" ${isChecked ? 'checked' : ''}>
                            <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                        </div>
                    `;
                }).join('');
            }
        }

        if (currentCloudSerialized !== lastHarvestedCloudSerialized) {
            lastHarvestedCloudSerialized = currentCloudSerialized;
            if (harvested.cloudLinks.length === 0) {
                cloudListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No harvested cloud links found.</div>';
            } else {
                const checkedUrls = new Set(
                    Array.from(cloudListContainer.querySelectorAll('.zipper-cloud-checkbox:checked'))
                        .map(cb => cb.getAttribute('data-url'))
                );
                const renderedUrls = new Set(
                    Array.from(cloudListContainer.querySelectorAll('.zipper-cloud-checkbox'))
                        .map(cb => cb.getAttribute('data-url'))
                );

                cloudListContainer.innerHTML = harvested.cloudLinks.map((url, idx) => {
                    const isChecked = renderedUrls.has(url) ? checkedUrls.has(url) : true;
                    let display = url.split('/').pop() || url;
                    try {
                        const parsed = new URL(url.startsWith('http') ? url : 'http:' + url);
                        const domain = parsed.hostname.replace('www.', '');
                        display = `<strong>[${domain}]</strong> ${display}`;
                    } catch (e) { }
                    return `
                        <div class="zipper-link-item">
                            <input type="checkbox" class="zipper-cloud-checkbox" id="cloud-cb-${idx}" data-url="${url}" ${isChecked ? 'checked' : ''}>
                            <span class="zipper-link-url" title="${url}">${display}</span>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    function resetHarvestCache() {
        lastHarvestedMediaSerialized = "";
        lastHarvestedCloudSerialized = "";
    }

    return { refreshHarvestedLinks, resetHarvestCache };
}

export function addDroppedLinks(
    links: string[],
    imagesSection: HTMLElement,
    linksSection: HTMLElement,
    mediaListContainer: HTMLElement,
    cloudListContainer: HTMLElement,
    mediaCountSpan: HTMLElement,
    cloudCountSpan: HTMLElement
) {
    links.forEach(url => {
        url = normalizeUrl(url, window.location.href);
        if (!url) return;
        const isCloud = isCloudUrl(url);
        const isMedia = isMediaUrl(url);

        if (isCloud) {
            const exists = Array.from(linksSection.querySelectorAll('.zipper-cloud-checkbox')).some(cb => cb.getAttribute('data-url') === url);
            if (!exists) {
                const idx = linksSection.querySelectorAll('.zipper-cloud-checkbox').length;
                let display = url.split('/').pop() || url;
                try {
                    const parsed = new URL(url.startsWith('http') ? url : 'http:' + url);
                    const domain = parsed.hostname.replace('www.', '');
                    display = `<strong>[${domain}]</strong> ${display}`;
                } catch (e) { }
                const itemHtml = `
                    <div class="zipper-link-item">
                        <input type="checkbox" class="zipper-cloud-checkbox" id="cloud-cb-${idx}" data-url="${url}" checked>
                        <span class="zipper-link-url" title="${url}">${display}</span>
                    </div>
                `;
                if (cloudListContainer.querySelector('.zipper-text-muted') || cloudListContainer.textContent.includes('No harvested')) {
                    cloudListContainer.innerHTML = '';
                }
                cloudListContainer.insertAdjacentHTML('beforeend', itemHtml);
                cloudCountSpan.textContent = parseInt(cloudCountSpan.textContent) + 1;
            }
        } else if (isMedia) {
            const exists = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox')).some(cb => cb.getAttribute('data-url') === url);
            if (!exists) {
                const idx = imagesSection.querySelectorAll('.zipper-media-checkbox').length;
                const itemHtml = `
                    <div class="zipper-link-item">
                        <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" checked>
                        <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                    </div>
                `;
                if (mediaListContainer.querySelector('.zipper-text-muted') || mediaListContainer.textContent.includes('No harvested')) {
                    mediaListContainer.innerHTML = '';
                }
                mediaListContainer.insertAdjacentHTML('beforeend', itemHtml);
                mediaCountSpan.textContent = parseInt(mediaCountSpan.textContent) + 1;
            }
        }
    });
}
