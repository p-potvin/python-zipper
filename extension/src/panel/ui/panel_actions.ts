// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { Api } from '../api';
import { globalState } from '../utils/state';
import { logToConsole, getZipperSetting } from '../utils/config';
import { normalizeUrl, clientSideFallback, extractUrlsFromText, getElementUrl } from '../utils/helpers';
import { resolveBestMediaUrl } from '../media/extractor';

export async function handleScrape(
    imagesSection: HTMLElement,
    selectorInput: HTMLInputElement,
    flashFab: () => void
) {
    const scrapeBtn = imagesSection.querySelector('#zipper-scrape-btn') as HTMLButtonElement;
    const checkedBoxes = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox:checked'));
    let urls = checkedBoxes.map(cb => normalizeUrl(cb.getAttribute('data-url'), window.location.href)).filter(Boolean);

    let selVal = selectorInput.value.trim();
    if (selVal) {
        let container = document;
        if (document.querySelector(selVal)) {
            container = document.querySelector(selVal);
            logToConsole(`[Media] Scrape targeted to container: "${selVal}"`);
        }
        let nodes = container.querySelectorAll('img, video, source');
        let rawUrls = Array.from(nodes).map(el => getElementUrl(el));
        let extraUrls = [...new Set(rawUrls.map(url => normalizeUrl(url, window.location.href)).filter(Boolean))];
        urls = [...new Set([...urls, ...extraUrls])];
    }

    if (urls.length === 0) {
        logToConsole('[Media] No media links selected.', 'error');
        return;
    }

    scrapeBtn.disabled = true;
    logToConsole(`[Media] Resolving quality and gated media links...`, 'info');
    const resolvedUrls = [];
    for (const u of urls) {
        const bestUrl = await resolveBestMediaUrl(u);
        resolvedUrls.push(bestUrl);
    }
    const finalUrls = [...new Set(resolvedUrls.filter(Boolean))].filter(u => u !== window.location.href);

    logToConsole(`[Media] Sending ${finalUrls.length} media files to local server...`, 'info');

    const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
    const upscaleEnabled = upscaleBtn ? upscaleBtn.classList.contains('active') : false;
    const selectVal = (document.getElementById('zipper-upscale-model') as HTMLSelectElement).value;
    const upscaleModel = selectVal === 'off' ? getZipperSetting('upscale-model', '4xNomos8k_atd') : selectVal;

    if (globalState.serverOnline) {
        try {
            const response = await Api.sendWithFallback("download", "POST", {
                url: window.location.href,
                links: finalUrls,
                batch_size: 5,
                upscale_enabled: upscaleEnabled,
                upscale_model: upscaleModel,
                rclone_enabled: getZipperSetting('rclone-enabled', 'false') === 'true'
            });

            if (response.ok) {
                let data;
                try {
                    data = await response.json();
                    logToConsole(`[Server] Success: Sent ${finalUrls.length} media files to pipeline.`, 'success');
                    if (data.correlationId) {
                        logToConsole(`[Server] Job ID: ${data.correlationId}`, 'info');
                    }
                } catch (e) {
                    logToConsole(`[Server] Success: Sent ${finalUrls.length} media files to pipeline.`, 'success');
                }
                flashFab();
            } else {
                throw new Error(`Server returned ${response.status}`);
            }
        } catch (err) {
            logToConsole(`[Server] Failed to send links: ${err.message}`, 'error');
            await clientSideFallback(finalUrls, scrapeBtn, logToConsole);
        }
    } else {
        await clientSideFallback(finalUrls, scrapeBtn, logToConsole);
    }
    scrapeBtn.disabled = false;
}

export async function handleSend(
    linksSection: HTMLElement,
    linksInput: HTMLTextAreaElement
) {
    const sendBtn = linksSection.querySelector('#zipper-send-btn') as HTMLButtonElement;
    const checkedBoxes = Array.from(linksSection.querySelectorAll('.zipper-cloud-checkbox:checked'));
    let urls = checkedBoxes.map(cb => normalizeUrl(cb.getAttribute('data-url'), window.location.href)).filter(Boolean);

    const rawText = linksInput.value.trim();
    if (rawText) {
        const manualLinks = extractUrlsFromText(rawText, window.location.href);
        urls = [...new Set([...urls, ...manualLinks])];
    }

    if (urls.length === 0) {
        logToConsole('[Upload] No cloud links selected or manually input.', 'error');
        return;
    }

    sendBtn.disabled = true;
    logToConsole(`[Upload] Resolving quality and media links for ${urls.length} target(s)...`, 'info');

    const resolvedUrls = [];
    for (const u of urls) {
        const bestUrl = await resolveBestMediaUrl(u);
        resolvedUrls.push(bestUrl);
    }
    const finalUrls = [...new Set(resolvedUrls.filter(Boolean))].filter(u => u !== window.location.href);

    if (finalUrls.length === 0) {
        logToConsole('[Upload] No valid links remaining after resolution.', 'error');
        sendBtn.disabled = false;
        return;
    }

    logToConsole(`[Upload] Sending ${finalUrls.length} link(s) to pipeline...`, 'info');

    const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
    const upscaleEnabled = upscaleBtn ? upscaleBtn.classList.contains('active') : false;
    const selectVal = (document.getElementById('zipper-upscale-model') as HTMLSelectElement).value;
    const upscaleModel = selectVal === 'off' ? getZipperSetting('upscale-model', '4xNomos8k_atd') : selectVal;

    if (globalState.serverOnline) {
        try {
            const response = await Api.sendWithFallback("download", "POST", {
                url: window.location.href,
                links: finalUrls,
                batch_size: 100,
                upscale_enabled: upscaleEnabled,
                upscale_model: upscaleModel,
                rclone_enabled: getZipperSetting('rclone-enabled', 'false') === 'true'
            });

            if (response.ok) {
                logToConsole(`[Server] Successfully forwarded ${finalUrls.length} links to pipeline!`, 'success');
                linksInput.value = '';
            } else {
                throw new Error(`Server error: ${response.status}`);
            }
        } catch (err) {
            logToConsole(`[Server] Failed to contact server: ${err.message}`, 'error');
        }
    } else {
        logToConsole('[Server] Error: Local server offline.', 'error');
    }
    sendBtn.disabled = false;
}

export async function handleDrop(
    e: DragEvent,
    addDroppedLinksFn: (links: string[]) => void,
    tabBtns: NodeListOf<Element>
) {
    e.preventDefault();
    let links: string[] = [];

    if (e.dataTransfer.files.length > 0) {
        logToConsole(`[Drop] Processing ${e.dataTransfer.files.length} dropped file(s)...`);
        for (let file of e.dataTransfer.files) {
            if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.json') || file.name.endsWith('.html')) {
                try {
                    const text = await file.text();
                    links = links.concat(extractUrlsFromText(text, window.location.href));
                } catch (err) {
                    logToConsole(`Failed to read file: ${err.message}`, 'error');
                }
            }
        }
    }

    const html = e.dataTransfer.getData('text/html');
    const text = e.dataTransfer.getData('text/plain');

    if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('a').forEach(a => { if (a.href) links.push(normalizeUrl(a.href, window.location.href)); });
        doc.querySelectorAll('img').forEach(img => { if (img.src) links.push(normalizeUrl(img.src, window.location.href)); });
    }

    if (text) {
        links = links.concat(extractUrlsFromText(text, window.location.href));
    }

    links = [...new Set(links.map(url => normalizeUrl(url, window.location.href)).filter(Boolean))];

    if (links.length > 0) {
        logToConsole(`[Drop] Extracted ${links.length} unique URLs!`, 'info');
        addDroppedLinksFn(links);
        (tabBtns[1] as HTMLElement).click();
    } else {
        logToConsole('[Drop] No valid URLs found in dropped data.', 'error');
    }
}
