// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { isHighQualityMedia, resolveBestMediaUrl } from '../media/extractor';
import { extractCarouselMediaUrls } from '../media/carousel_detector';
import { getElementUrl, isMediaUrl, isCloudUrl, isSameDomain, extractUrlsFromText, fetchAsArrayBuffer } from './helpers';
import { highlightElement, canHighlightElement } from '../ui/highlighter';
import { globalState } from './state';
import { updateGalleryUI, removeGalleryUIWithDelay, scrollToBottomSmartForGallery } from '../ui/gallery';
import { logToConsole, getZipperSetting } from './config';
import { Api } from '../api';
import { createLocalJob, updateLocalJob, completeLocalJob, failLocalJob } from '../ui/local_jobs';


export function harvestLinks() {
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.flv'];
    const audioExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

    const mediaCandidates: { url: string; score: number }[] = [];
    const cloudLinks = new Set<string>();
    const currentHref = window.location.href;

    // 1. Scan universal JS Carousel & Lightbox modules first for high-res slide URLs
    try {
        const carouselUrls = extractCarouselMediaUrls(document);
        carouselUrls.forEach(url => {
            const lowerUrl = url.toLowerCase();
            const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext));
            if (isVideo) {
                cloudLinks.add(url);
            }
            mediaCandidates.push({ url, score: isVideo ? 400 : 350 });
        });
    } catch (e) {
        console.warn('[Zipper] Carousel scanning error:', e);
    }

    // 2. Gather DOM elements
    document.querySelectorAll('img, video, audio, source, a, picture, div, span, [style*="background"], [data-src], [data-image], [data-bg]').forEach(el => {
        if (el.closest('#zipper-panel') || el.closest('#zipper-fab') || el.closest('#zipper-float-download-btn')) {
            return;
        }
        const tagName = el.tagName.toLowerCase();
        const url = getElementUrl(el);
        if (!url) return;

        const lowerUrl = url.toLowerCase();

        // Reject .svg, .ico, and cursors completely
        if (lowerUrl.includes('.svg') || lowerUrl.includes('.ico') || lowerUrl.includes('.cur') || lowerUrl.includes('.bmp')) {
            return;
        }

        // Same domain check
        const isSameHost = isSameDomain(url, currentHref);

        // If it's an <a> link on the same domain and NOT a direct media file, skip it
        if (tagName === 'a' && isSameHost) {
            const hasDirectMedia = videoExtensions.some(ext => lowerUrl.includes(ext)) ||
                imageExtensions.some(ext => lowerUrl.includes(ext)) ||
                audioExtensions.some(ext => lowerUrl.includes(ext));
            if (!hasDirectMedia && !el.querySelector('img, video, picture')) {
                return;
            }
        }

        // Cloud domains check (same-domain is rejected by isCloudUrl)
        const isCloudDomain = isCloudUrl(url, currentHref);

        // Base detection
        const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'video' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'video') || lowerUrl.includes('bunkr') || lowerUrl.includes('bunkrr');
        const isAudio = audioExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'audio' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'audio');
        const isImage = imageExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'img' || tagName === 'picture' || (tagName === 'source' && el.parentElement?.tagName.toLowerCase() === 'picture');

        // Cloud links should contain all cloud domain links and all videos from media
        if (isCloudDomain || (isVideo && !isSameHost)) {
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
        } else if (isMediaUrl(lowerUrl, currentHref)) {
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
                } else if (area < 100 * 100 || width < 120 || height < 120) {
                    score -= 500; // Tiny icons/spacers
                } else if (area < 200 * 200) {
                    score -= 150; // Very small
                }
            }

            // Visibility
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
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
            if (/(post-media|gallery|main-content|article|video-container|audio-container|content-wrapper|photos|feed|carousel|slider|pswp|swiper)/i.test(classIdStr)) {
                score += 100;
            }
            parent = parent.parentElement;
            depth++;
        }

        // Keyword blacklist check
        const blacklistKeywords = [
            'avatar', 'sprite', 'logo', 'button', 'icon', 'emoji',
            'font', 'loading', 'spacer', 'ad-', 'track', 'analytics', 'pixel', 'favicon', 'profile-pic'
        ];
        if (blacklistKeywords.some(kw => lowerUrl.includes(kw))) {
            score -= 500;
        }

        // Strict highlight in UI if element is media, score is high, and passes strict highlight filters
        if (score >= 160 && canHighlightElement(el, url)) {
            highlightElement(el, url);
            if (el.parentElement && (el.parentElement.tagName.toLowerCase() === 'a' || el.parentElement.tagName.toLowerCase() === 'picture')) {
                highlightElement(el.parentElement, url);
            }
        }

        // Only keep in media list if net score >= 50
        if (score >= 50) {
            mediaCandidates.push({ url, score });
        }
    });

    // 3. Parse body text for links too
    const text = document.body.innerText || "";
    const textUrls = extractUrlsFromText(text, currentHref);
    textUrls.forEach(url => {
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('.svg') || lowerUrl.includes('.ico') || lowerUrl.includes('.cur')) return;

        const isSameHost = isSameDomain(url, currentHref);
        const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext)) || lowerUrl.includes("bunkr") || lowerUrl.includes("bunkrr");
        const isAudio = audioExtensions.some(ext => lowerUrl.includes(ext));
        const isCloudDomain = isCloudUrl(url, currentHref);

        if (isCloudDomain || (isVideo && !isSameHost)) {
            cloudLinks.add(url);
        }

        const hasMediaExt = /\.(jpg|jpeg|png|gif|webp|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv|mp3|wav|flac|m4a|aac)(?:[?#].*)?$/i.test(lowerUrl);
        if (!hasMediaExt && !isMediaUrl(url, currentHref)) return;

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

        const blacklistKeywords = ['avatar', 'sprite', 'logo', 'button', 'icon', 'emoji', 'font', 'loading', 'spacer', 'favicon'];
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

    const localJobId = createLocalJob(totalFiles, window.location.href);
    const archivesCreated: string[] = [];

    let zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
    let count = 0;
    let batchIndex = 1;
    const totalBatches = Math.ceil(totalFiles / 50);

    for (let i = 0; i < totalFiles; i++) {
        if (globalState.abortScraping) {
            updateLocalJob(localJobId, { status: 'aborted' });
            break;
        }
        const url = urls[i];
        if (!url) continue;

        const currentPct = Math.round((i / totalFiles) * 100);
        updateGalleryUI(currentPct, `Batch ${batchIndex}/${totalBatches} — Fetching item ${i + 1}/${totalFiles}`);
        updateLocalJob(localJobId, { processed_links: i + 1, total_links: totalFiles });

        try {
            const rawBuffer = await fetchAsArrayBuffer(url);
            let ext = url.split('.').pop()?.split(/[\?#]/)[0] || 'jpg';
            if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext.toLowerCase())) ext = 'jpg';

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
                const archiveName = `${cleanPath}_batch_${batchIndex}.zip`;
                localDownloadBlob(zipBlob, archiveName);
                archivesCreated.push(archiveName);
                updateLocalJob(localJobId, { archives: [...archivesCreated] });
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
            const archiveName = `${cleanPath}_batch_${batchIndex}_final.zip`;
            localDownloadBlob(zipBlob, archiveName);
            archivesCreated.push(archiveName);
        } catch (error) {
            console.error('Final segment cleanup container execution failed:', error);
        }
    }

    completeLocalJob(localJobId, archivesCreated);
    updateGalleryUI(100, `Done! Downloaded ${count} files.`);
    removeGalleryUIWithDelay();
}

export async function runSmartGalleryZip() {
    globalState.abortScraping = false;
    const gallerySelectorInput = document.getElementById('zipper-gallery-selector') as HTMLInputElement | null;
    const customSelector = gallerySelectorInput ? gallerySelectorInput.value.trim() : '';

    let container: ParentNode = document;
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

    let extractedUrls: string[] = [];

    // 1. Check for universal JS carousel / lightbox modules in container
    try {
        const carouselUrls = extractCarouselMediaUrls(container);
        if (carouselUrls.length > 0) {
            extractedUrls = carouselUrls;
            logToConsole(`[SmartZip] Extracted ${extractedUrls.length} media links from active JS carousels/lightboxes.`, "success");
        }
    } catch (e) {
        console.warn('[SmartZip] Carousel detector error:', e);
    }

    // 2. Specific fallback for OnlyFans timeline item if viewer not open yet
    if (extractedUrls.length === 0 && container === document && window.location.hostname.includes('onlyfans.com')) {
        const firstThumbnail = document.querySelector(".user_posts .b-photos__item");
        if (firstThumbnail) {
            logToConsole("[SmartZip] OnlyFans timeline item detected. Opening Vue photoswipe viewer...", "info");
            firstThumbnail.click();
            await new Promise(r => setTimeout(r, 800));
            try {
                const pswpUrls = extractCarouselMediaUrls(document);
                if (pswpUrls.length > 0) {
                    extractedUrls = pswpUrls;
                    logToConsole(`[SmartZip] Extracted ${extractedUrls.length} links via Photoswipe`, "success");
                    const closeBtn = document.querySelector('.pswp__button--close');
                    if (closeBtn) closeBtn.click();
                }
            } catch (e) {
                console.error("[SmartZip] Photoswipe extraction failed:", e);
            }
        }
    }

    // 3. Fallback: scan DOM nodes in container
    if (extractedUrls.length === 0) {
        logToConsole("[SmartZip] Scanning DOM for media nodes...", "info");
        const nodes = container.querySelectorAll('img, video, audio, source, a, picture, div, span, [style*="background"], [data-src], [data-image], [data-bg]');
        const urlSet = new Set<string>();
        for (const el of nodes) {
            const url = getElementUrl(el);
            if (url) {
                const lower = url.toLowerCase();
                if (lower.includes('.svg') || lower.includes('.ico') || lower.includes('.cur')) continue;
                const resolved = await resolveBestMediaUrl(url);
                const ext = resolved.split('.').pop()?.split(/[?#]/)[0].toLowerCase() || '';
                const isMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext);
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

    // Filter out the base document page URL and non-media svgs
    extractedUrls = extractedUrls
        .filter(u => u !== window.location.href && u !== `${window.location.href}#`)
        .filter(u => !u.toLowerCase().includes('.svg') && !u.toLowerCase().includes('.ico'));

    const serverDownloadEnabled = getZipperSetting('server-download-enabled', 'false') === 'true';
    const rcloneEnabled = getZipperSetting('rclone-enabled', 'false') === 'true';

    if (serverDownloadEnabled && globalState.serverOnline) {
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

    logToConsole(`[SmartZip] Initiating direct browser zipping for ${extractedUrls.length} items...`, "info");
    await processAndZipGallery(extractedUrls);
    logToConsole("[SmartZip] Zipping workflow complete!", "success");
}


