import { isHighQualityMedia, resolveBestMediaUrl } from '../media/extractor';
import { getElementUrl, isMediaUrl, isCloudUrl, extractUrlsFromText, fetchAsArrayBuffer } from './helpers';
import { highlightElement } from '../ui/highlighter';
import { globalState } from './state';
import { updateGalleryUI, removeGalleryUIWithDelay, scrollToBottomSmartForGallery } from '../ui/gallery';
import { logToConsole, getZipperSetting } from './config';
import { Api } from '../api';

declare const zip: any;
declare const saveAs: any;
declare const unsafeWindow: any;

export function harvestLinks() {
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.wmv'];
    const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];

    const mediaCandidates: { url: string; score: number }[] = [];
    const cloudLinks = new Set<string>();

    // Gather media elements
    document.querySelectorAll('img, video, audio, source, a, picture, div, span, [style*="background"], [data-src], [data-image], [data-bg]').forEach(el => {
        const tagName = el.tagName.toLowerCase();
        const url = getElementUrl(el);
        if (!url) return;

        const lowerUrl = url.toLowerCase();

        // Cloud domains check
        const isCloudDomain = isCloudUrl(url);

        // Base detection
        const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'video' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'video') || lowerUrl.includes('bunkr') || lowerUrl.includes('bunkrr');
        const isAudio = audioExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'audio' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'audio');
        const isImage = imageExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'img' || tagName === 'picture' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'picture');

        // Cloud links should contain all cloud domain links and all videos from media
        if (isCloudDomain || isVideo) {
            cloudLinks.add(url);
        }

        // Scoring Algorithm
        let score = 0;

        if (isVideo) {
            score += 350;
        } else if (isAudio) {
            score += 260;
        } else if (isImage) {
            score += 250;
        } else if (isMediaUrl(lowerUrl)) {
            score += 150;
        }

        // Quality terms in URL
        const qualityKeywords = ['1080p', '720p', '4k', '2160p', '1440p', '1080', '720', '1920', '3840', '2560', 'hd', 'full', 'source', 'original', '320kbps', 'flac', 'lossless', 'master'];
        if (qualityKeywords.some(kw => lowerUrl.includes(kw))) {
            score += 150;
        }

        // Platform quality boosters
        if (lowerUrl.includes('/files/')) {
            score += 200;
        } else if (['/thumb/', '/preview/', '/thumbnails/', '/thumbs/'].some(kw => lowerUrl.includes(kw))) {
            score -= 200;
        }

        // Element Dimensions scoring (supports img, video, and background-image divs/spans)
        if (tagName === 'img' || tagName === 'video' || tagName === 'div' || tagName === 'span') {
            const imgEl = el as any;
            const width = imgEl.naturalWidth || imgEl.videoWidth || imgEl.offsetWidth || imgEl.clientWidth || parseInt(el.style?.width) || 0;
            const height = imgEl.naturalHeight || imgEl.videoHeight || imgEl.offsetHeight || imgEl.clientHeight || parseInt(el.style?.height) || 0;
            const area = width * height;

            if (area > 0) {
                if (area >= 1920 * 1080) {
                    score += 300;
                } else if (area >= 1280 * 720) {
                    score += 150;
                } else if (area < 100 * 100) {
                    score -= 500; // Tiny icons/spacers
                } else if (area < 200 * 200) {
                    score -= 150; // Very small
                }
            }

            // Visibility
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') {
                score -= 400;
            }
        }

        // Parent layout context checking
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 5) {
            const classIdStr = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();

            // Header/Footer/Nav/Avatar are lower priority zones
            if (/(header|footer|nav|sidebar|menu|widget|button|btn|avatar|profile-header)/i.test(classIdStr)) {
                score -= 300;
            }
            // Post media or main containers are premium zones
            if (/(post-media|gallery|main-content|article|video-container|audio-container|content-wrapper|photos|feed)/i.test(classIdStr)) {
                score += 100;
            }
            parent = parent.parentElement;
            depth++;
        }

        // Keyword blacklist check
        const blacklistKeywords = [
            'avatar', 'sprite', 'logo', 'button', 'icon', 'emoji',
            'font', 'loading', 'spacer', 'ad-', 'track', 'analytics', 'pixel', 'favicon'
        ];
        if (blacklistKeywords.some(kw => lowerUrl.includes(kw))) {
            score -= 500;
        }

        // Highlight in UI if element is media and score is positive
        if (score >= 100 && (tagName === 'img' || tagName === 'video' || tagName === 'audio' || tagName === 'source' || tagName === 'a' || tagName === 'picture' || tagName === 'div' || tagName === 'span')) {
            highlightElement(el);
            if (el.parentElement && (el.parentElement.tagName.toLowerCase() === 'a' || el.parentElement.tagName.toLowerCase() === 'picture' || el.parentElement.tagName.toLowerCase() === 'audio')) {
                highlightElement(el.parentElement);
            }
        }

        // Only keep in media list if net score >= 50
        if (score >= 50) {
            mediaCandidates.push({ url, score });
        }
    });

    // Parse body text for links too
    const text = document.body.innerText || "";
    const textUrls = extractUrlsFromText(text, window.location.href);
    textUrls.forEach(url => {
        const lowerUrl = url.toLowerCase();
        const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext)) || lowerUrl.includes("bunkr") || lowerUrl.includes("bunkrr");
        const isAudio = audioExtensions.some(ext => lowerUrl.includes(ext));
        const isCloudDomain = isCloudUrl(url);

        if (isCloudDomain || isVideo) {
            cloudLinks.add(url);
        }

        const hasMediaExt = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv|mp3|wav|flac|m4a|aac)(?:[?#].*)?$/i.test(lowerUrl);
        if (!hasMediaExt && !isMediaUrl(url)) return;

        let score = 120; // default medium score for plain text urls
        if (isVideo) {
            score += 200;
        } else if (isAudio) {
            score += 160;
        }
        const qualityKeywords = ['1080p', '720p', '4k', '2160p', '1440p', '1080', '720', '1920', '3840', '2560', 'hd', 'full', 'source', 'original', '320kbps', 'flac', 'lossless', 'master'];
        if (qualityKeywords.some(kw => lowerUrl.includes(kw))) {
            score += 100;
        }

        const blacklistKeywords = ['avatar', 'sprite', 'logo', 'button', 'icon', 'emoji', 'font', 'loading', 'spacer'];
        if (blacklistKeywords.some(kw => lowerUrl.includes(kw))) {
            score -= 400;
        }

        if (score >= 50) {
            mediaCandidates.push({ url, score });
        }
    });

    // Dedup by URL, keeping the highest score
    const uniqueCandidates = new Map<string, number>();
    for (const cand of mediaCandidates) {
        const existing = uniqueCandidates.get(cand.url);
        if (existing === undefined || cand.score > existing) {
            uniqueCandidates.set(cand.url, cand.score);
        }
    }

    // Convert to sorted list based on score
    const sortedMedia = Array.from(uniqueCandidates.entries())
        .map(([url, score]) => ({
            url: url,
            isInteresting: score >= 150 // score threshold for showing as pre-selected/interesting
        }))
        .sort((a, b) => {
            const aScore = uniqueCandidates.get(a.url) || 0;
            const bScore = uniqueCandidates.get(b.url) || 0;
            return bScore - aScore;
        });

    return {
        cloudLinks: Array.from(cloudLinks),
        mediaLinks: sortedMedia
    };
}

function localDownloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function processAndZipGallery(urls: string[]) {
    const totalFiles = urls.length;
    if (totalFiles === 0) {
        updateGalleryUI(0, "No files collected to pack.");
        removeGalleryUIWithDelay();
        return;
    }

    let zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
    let count = 0;
    let batchIndex = 1;
    const totalBatches = Math.ceil(totalFiles / 50);

    for (let i = 0; i < totalFiles; i++) {
        if (globalState.abortScraping) break;
        const url = urls[i];
        if (!url) continue;

        const currentPct = (i / totalFiles) * 100;
        updateGalleryUI(currentPct, `Batch ${batchIndex}/${totalBatches} — Fetching item ${i + 1}/${totalFiles}`);

        try {
            const rawBuffer = await fetchAsArrayBuffer(url);
            let ext = url.split('.').pop()?.split(/[\?#]/)[0] || 'jpg';
            if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext.toLowerCase())) ext = 'jpg';

            const blob = new Blob([rawBuffer as any]);
            const cleanPath = window.location.pathname.replace(/\//g, '_') || 'gallery';
            const filename = `${cleanPath}_file_${String(i + 1).padStart(4, '0')}.${ext}`;
            await zipWriter.add(filename, new zip.BlobReader(blob), { level: 0 });

            count++;
        } catch (err) {
            console.error(`Fetch execution failed on target file node: ${url}`, err);
        }

        if (count > 0 && count % 50 === 0) {
            updateGalleryUI(currentPct, `Packing and downloading ZIP Batch ${batchIndex}...`);
            try {
                const zipBlob = await zipWriter.close();
                const cleanPath = window.location.pathname.replace(/\//g, '_') || 'gallery';
                localDownloadBlob(zipBlob, `${cleanPath}_batch_${batchIndex}.zip`);
                zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
                batchIndex++;
            } catch (error) {
                console.error('Failed processing isolated batch closure:', error);
            }
        }
    }

    if (count % 50 !== 0 || batchIndex === 1) {
        updateGalleryUI(95, "Wrapping up the remaining files...");
        try {
            const zipBlob = await zipWriter.close();
            const cleanPath = window.location.pathname.replace(/\//g, '_') || 'gallery';
            localDownloadBlob(zipBlob, `${cleanPath}_batch_${batchIndex}_final.zip`);
        } catch (error) {
            console.error('Final segment cleanup container execution failed:', error);
        }
    }

    updateGalleryUI(100, `Done! Downloaded ${count} files.`);
    removeGalleryUIWithDelay();
}

export async function runSmartGalleryZip() {
    globalState.abortScraping = false;
    const gallerySelectorInput = document.getElementById('zipper-gallery-selector') as HTMLInputElement | null;
    const customSelector = gallerySelectorInput ? gallerySelectorInput.value.trim() : '';

    let container = document;
    if (customSelector) {
        const el = document.querySelector(customSelector);
        if (el) {
            container = el;
            logToConsole(`[SmartZip] Restricting search to container: "${customSelector}"`, 'info');
        } else {
            logToConsole(`[SmartZip] Container "${customSelector}" not found, using document`, 'error');
        }
    }

    await scrollToBottomSmartForGallery();

    let extractedUrls = [];

    if (container === document && window.location.hostname.includes('onlyfans.com')) {
        const firstThumbnail = document.querySelector(".user_posts .b-photos__item");
        if (firstThumbnail) {
            logToConsole("[SmartZip] OnlyFans timeline item detected. Opening Vue photoswipe viewer...", "info");
            firstThumbnail.click();
            await new Promise(r => setTimeout(r, 800));
            try {
                const pswpContainer = document.querySelector("div.photoswipe");
                if (pswpContainer) {
                    const vueInstance = pswpContainer.__vue__ || (typeof unsafeWindow !== 'undefined' && unsafeWindow.document.querySelector("div.photoswipe").__vue__);
                    const dataSource = vueInstance ? (vueInstance.dataSource || (vueInstance._props && vueInstance._props.dataSource)) : null;
                    if (dataSource) {
                        extractedUrls = Array.from(dataSource).map(item => item.src).filter(Boolean);
                        logToConsole(`[SmartZip] Extracted ${extractedUrls.length} links via Vue Photoswipe`, "success");
                        const closeBtn = document.querySelector('.pswp__button--close');
                        if (closeBtn) closeBtn.click();
                    }
                }
            } catch (e) {
                console.error("[SmartZip] Vue photoswipe extraction failed:", e);
            }
        }
    }

    if (extractedUrls.length === 0) {
        logToConsole("[SmartZip] Scanning DOM for media nodes...", "info");
        const nodes = container.querySelectorAll('img, video, audio, source, a, picture, div, span, [style*="background"], [data-src], [data-image], [data-bg]');
        const urlSet = new Set();
        for (const el of nodes) {
            const url = getElementUrl(el);
            if (url) {
                const resolved = await resolveBestMediaUrl(url);
                const ext = resolved.split('.').pop().split(/[?#]/)[0].toLowerCase();
                const isMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext);
                if (isMedia) {
                    urlSet.add(resolved);
                }
            }
        }
        extractedUrls = Array.from(urlSet);
        logToConsole(`[SmartZip] Found ${extractedUrls.length} media links in DOM.`, "success");
    }

    if (extractedUrls.length === 0) {
        logToConsole("[SmartZip] No media files found.", "error");
        removeGalleryUIWithDelay();
        return;
    }

    // Filter out the base document page URL
    extractedUrls = extractedUrls.filter(u => u !== window.location.href);

    const rcloneEnabled = getZipperSetting('rclone-enabled', 'false') === 'true';
    if (globalState.serverOnline) {
        logToConsole(`[SmartZip] Forwarding ${extractedUrls.length} media files to local server...`, "info");
        const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
        const upscaleEnabled = upscaleBtn ? upscaleBtn.classList.contains('active') : false;
        const selectVal = (document.getElementById('zipper-upscale-model') as HTMLSelectElement).value;
        const upscaleModel = selectVal === 'off' ? getZipperSetting('upscale-model', '4xNomos8k_atd') : selectVal;

        await Api.sendWithFallback("download", "POST", {
            url: window.location.href,
            links: extractedUrls,
            batch_size: 50,
            upscale_enabled: upscaleEnabled,
            upscale_model: upscaleModel,
            rclone_enabled: rcloneEnabled
        });
        logToConsole("[SmartZip] Job successfully queued on local server.", "success");
        removeGalleryUIWithDelay();
        return;
    }

    logToConsole(`[SmartZip] Initiating zipping workflow for ${extractedUrls.length} items...`, "info");
    await processAndZipGallery(extractedUrls);
    logToConsole("[SmartZip] Zipping workflow complete!", "success");
}
