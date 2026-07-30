// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { isHighQualityMedia, resolveBestMediaUrl } from '../media/extractor';
import { getElementUrl, isMediaUrl, isCloudUrl, extractUrlsFromText, fetchAsArrayBuffer } from './helpers';
import { highlightElement } from '../ui/highlighter';
import { globalState } from './state';
import { updateGalleryUI, removeGalleryUIWithDelay, scrollToBottomSmartForGallery } from '../ui/gallery';
import { logToConsole } from './config';


    export function harvestLinks() {
        const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.wmv'];
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bmp'];
        
        const mediaCandidates: { url: string; score: number }[] = [];
        const cloudLinks = new Set<string>();

        // Gather all elements
        document.querySelectorAll('*').forEach(el => {
            const tagName = el.tagName.toLowerCase();
            let url = '';
            
            // Extract URL based on tag type
            if (tagName === 'img') {
                url = el.currentSrc || el.src || el.getAttribute('data-src') || '';
            } else if (tagName === 'video') {
                url = el.currentSrc || el.src || el.getAttribute('data-src') || el.poster || '';
            } else if (tagName === 'source') {
                url = el.srcset || el.src || el.getAttribute('data-src') || '';
                // Resolve srcset candidates
                if (url.includes(',')) {
                    url = url.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
                }
            } else if (tagName === 'a') {
                url = el.href || el.getAttribute('href') || '';
            }

            url = getElementUrl(el);
            if (!url) return;

            const lowerUrl = url.toLowerCase();

            // Cloud links checking
            if (isCloudUrl(url)) {
                cloudLinks.add(url);
                return;
            }

            // Standard media checking
            const hasMediaExt = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)(?:[?#].*)?$/i.test(lowerUrl);
            
            // Check if it is a platform page instead of raw profiles
            const isPlatformMediaPage = /onlyfans\.com\/posts\/\d+/i.test(lowerUrl) || 
                                        /coomer\.(st|su)\/onlyfans\/user\/[^/]+\/post\/\w+/i.test(lowerUrl) ||
                                        /kemono\.(cr|su)\/[^/]+\/user\/[^/]+\/post\/\w+/i.test(lowerUrl);

            // Ignore profiles, status feeds, index pages, generic homepages
            const isProfileOrFeed = /twitter\.com\/[^/]+$/i.test(lowerUrl) ||
                                    /x\.com\/[^/]+$/i.test(lowerUrl) ||
                                    /onlyfans\.com\/[^/]+$/i.test(lowerUrl) ||
                                    /patreon\.com\/[^/]+$/i.test(lowerUrl) ||
                                    /fansly\.com\/[^/]+$/i.test(lowerUrl) ||
                                    (lowerUrl.includes('/status/') && !hasMediaExt);

            if (isProfileOrFeed) {
                return; // Discard profiles and statuses
            }

            if (!hasMediaExt && !isPlatformMediaPage && !isMediaUrl(url)) {
                // If it doesn't have a direct media extension, isn't a platform post page, and isn't a media domain, discard
                return;
            }

            // Scoring Algorithm
            let score = 0;

            // Base score based on extension/type
            const isVideo = videoExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'video';
            const isImage = imageExtensions.some(ext => lowerUrl.includes(ext)) || tagName === 'img';

            if (isVideo) {
                score += 500;
            } else if (isImage) {
                score += 100;
            }

            // Quality terms in URL
            const qualityKeywords = ['1080p', '720p', '4k', '2160p', '1440p', '1080', '720', '1920', '3840', '2560', 'hd', 'full', 'source', 'original'];
            if (qualityKeywords.some(kw => lowerUrl.includes(kw))) {
                score += 150;
            }

            // Platform quality boosters
            if (lowerUrl.includes('/files/')) {
                score += 200; // OnlyFans full size file vs thumb
            }

            // Element Dimensions scoring
            if (tagName === 'img' || tagName === 'video') {
                const imgEl = el as any;
                const width = imgEl.naturalWidth || imgEl.videoWidth || imgEl.width || parseInt(el.style.width) || 0;
                const height = imgEl.naturalHeight || imgEl.videoHeight || imgEl.height || parseInt(el.style.height) || 0;
                const area = width * height;

                if (area > 0) {
                    if (area >= 1920 * 1080) {
                        score += 300;
                    } else if (area >= 1280 * 720) {
                        score += 150;
                    } else if (area < 150 * 150) {
                        score -= 600; // Trash thumbnails
                    } else if (area < 300 * 300) {
                        score -= 300; // Low quality
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
                
                // Header/Footer/Nav are garbage zones
                if (/(header|footer|nav|sidebar|menu|widget|button|btn|avatar|profile-header)/i.test(classIdStr)) {
                    score -= 400;
                }
                // Post media or main containers are premium zones
                if (/(post-media|gallery|main-content|article|video-container|content-wrapper)/i.test(classIdStr)) {
                    score += 100;
                }
                parent = parent.parentElement;
                depth++;
            }

            // Keyword blacklist check
            const blacklistKeywords = [
                'avatar', 'sprite', 'logo', 'banner', 'button', 'icon', 'emoji',
                'font', 'loading', 'spacer', 'ad-', 'track', 'analytics', 'pixel'
            ];
            if (blacklistKeywords.some(kw => lowerUrl.includes(kw))) {
                score -= 600;
            }

            // Highlight in UI if score is high enough to be interesting
            if (score >= 200 && (tagName === 'img' || tagName === 'video' || tagName === 'a')) {
                highlightElement(el);
            }

            // Only keep if the net score is interesting (i.e. >= 50)
            if (score >= 50) {
                mediaCandidates.push({ url, score });
            }
        });

        // Parse body text for links too
        const text = document.body.innerText || "";
        const textUrls = extractUrlsFromText(text, window.location.href);
        textUrls.forEach(url => {
            const lowerUrl = url.toLowerCase();
            if (isCloudUrl(url)) {
                cloudLinks.add(url);
                return;
            }

            const hasMediaExt = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)(?:[?#].*)?$/i.test(lowerUrl);
            if (!hasMediaExt && !isMediaUrl(url)) return;

            let score = 80; // default medium score for plain text urls
            if (videoExtensions.some(ext => lowerUrl.includes(ext))) {
                score += 200;
            }
            const qualityKeywords = ['1080p', '720p', '4k', '2160p', '1440p', '1080', '720', '1920', '3840', '2560', 'hd', 'full', 'source', 'original'];
            if (qualityKeywords.some(kw => lowerUrl.includes(kw))) {
                score += 100;
            }

            const blacklistKeywords = ['avatar', 'sprite', 'logo', 'banner', 'button', 'icon', 'emoji', 'font', 'loading', 'spacer'];
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
                isInteresting: score >= 200 // score threshold for showing as pre-selected/interesting
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
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'].includes(ext.toLowerCase())) ext = 'jpg';

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
                    saveAs(zipBlob, `${cleanPath}_batch_${batchIndex}.zip`);
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
                saveAs(zipBlob, `${cleanPath}_batch_${batchIndex}_final.zip`);
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
            const nodes = container.querySelectorAll('img, video, source, a');
            const urlSet = new Set();
            for (const el of nodes) {
                const url = getElementUrl(el);
                if (url) {
                    const resolved = await resolveBestMediaUrl(url);
                    const ext = resolved.split('.').pop().split(/[?#]/)[0].toLowerCase();
                    const isMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'].includes(ext);
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

        logToConsole(`[SmartZip] Initiating zipping workflow for ${extractedUrls.length} items...`, "info");
        await processAndZipGallery(extractedUrls);
        logToConsole("[SmartZip] Zipping workflow complete!", "success");
    }

