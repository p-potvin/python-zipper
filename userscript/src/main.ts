import { Api, makeGMRequest } from './api';
import { isHighQualityMedia, resolveBestMediaUrl } from './media/extractor';
import { getZipperSetting, setZipperSetting, logToConsole, setLogToConsole } from './utils/config';
import { rgbToHsl, generatePalette, getAverageColor, injectStyles } from './ui/theme';
import { isHighlightEnabled, highlightElement } from './ui/highlighter';
import { fetchAsArrayBuffer, clientSideFallback, getRandomInt, cloudDomains, mediaDomains, normalizeUrl, extractUrlsFromText, getElementUrl, isCloudUrl, isMediaUrl } from './utils/helpers';
import { getZipperSetting, setZipperSetting, logToConsole, setLogToConsole } from './utils/config';
import { rgbToHsl, generatePalette, getAverageColor, injectStyles } from './ui/theme';
import { isHighlightEnabled, highlightElement } from './ui/highlighter';
import { fetchAsArrayBuffer, clientSideFallback, getRandomInt, cloudDomains, mediaDomains, normalizeUrl, extractUrlsFromText, getElementUrl, isCloudUrl, isMediaUrl } from './utils/helpers';
import { createGalleryUI, updateGalleryUI, removeGalleryUIWithDelay, scrollToBottomSmartForGallery } from './ui/gallery';
import { globalState } from './utils/state';
import { initUI } from './ui/panel';
    let activeApiOrigin: string | null = null;




    export function showBrowserNotification(title: string, body: string) {
        if (typeof Notification !== 'undefined') {
            if (Notification.permission === 'granted') {
                new Notification(title, { body });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        new Notification(title, { body });
                    }
                });
            }
        }
    }









    function harvestLinks() {
        const tagRegex = /^(img|video|source)$/i;
        const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.wmv'];

        const mediaLinks = new Set();
        const cloudLinks = new Set();
        const mediaLinksMetadata = new Map();


        function shouldFilterMedia(url, el) {
            const lowerUrl = url.toLowerCase();
            const filterKeywords = [
                'avatar', 'profile', 'sprite', 'logo', 'banner', 'button', 'icon',
                'loading', 'spacer', 'favicon', 'analytics', 'tracker', 'ad-group',
                'adsense', 'doubleclick', 'pixel', 'advertisement', 'widget'
            ];
            if (filterKeywords.some(keyword => lowerUrl.includes(keyword))) {
                return true;
            }

            if (el) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'img') {
                    if (el.naturalWidth > 0 && el.naturalWidth < 150) return true;
                    if (el.naturalHeight > 0 && el.naturalHeight < 150) return true;
                    if (el.width > 0 && el.width < 150) return true;
                    if (el.height > 0 && el.height < 150) return true;

                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return true;
                }

                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    const classIdStr = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();
                    if (/(header|footer|nav|sidebar|menu|widget|button|btn)/i.test(classIdStr)) {
                        return true;
                    }
                    parent = parent.parentElement;
                    depth++;
                }
            }
            return false;
        }

        function isInterestingMedia(url, el) {
            if (!isHighQualityMedia(url)) return false;

            const lowerUrl = url.toLowerCase();
            const isVideo = videoExtensions.some(ext => lowerUrl.endsWith(ext)) || (el && (el.tagName.toLowerCase() === 'video' || el.tagName.toLowerCase() === 'source'));
            if (isVideo) return true;

            if (lowerUrl.endsWith('.ico') || lowerUrl.endsWith('.svg') || lowerUrl.includes('favicon')) return false;

            const uninterestingKeywords = [
                'avatar', 'sprite', 'logo', 'banner', 'button', 'icon',
                'font', 'loading', 'spacer', 'ad-', 'track', 'analytics', 'pixel',
                'nav', 'footer', 'header', 'sidebar', 'widget', 'profile', 'thumb_small', 'thumbnail_small'
            ];
            if (uninterestingKeywords.some(keyword => lowerUrl.includes(keyword))) {
                return false;
            }

            if (el) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'img') {
                    if (el.naturalWidth > 0 && el.naturalWidth < 300) return false;
                    if (el.naturalHeight > 0 && el.naturalHeight < 300) return false;
                    if (el.width > 0 && el.width < 300) return false;
                    if (el.height > 0 && el.height < 300) return false;
                }
            }

            return true;
        }

        document.querySelectorAll('*').forEach(el => {
            const tagName = el.tagName;

            if (tagRegex.test(tagName)) {
                const url = getElementUrl(el);
                if (url && isMediaUrl(url)) {
                    if (!shouldFilterMedia(url, el)) {
                        mediaLinks.add(url);
                        highlightElement(el);
                        const interesting = isInterestingMedia(url, el);
                        if (!mediaLinksMetadata.has(url) || interesting) {
                            mediaLinksMetadata.set(url, interesting);
                        }
                        const isVideoTag = tagName.toLowerCase() === 'video' || tagName.toLowerCase() === 'source';
                        const isVideoUrl = videoExtensions.some(ext => url.toLowerCase().includes(ext)) || url.toLowerCase().includes("bunkr") || url.toLowerCase().includes("bunkrr");
                        if (isVideoTag || isVideoUrl) {
                            cloudLinks.add(url);
                        }
                    }
                }
            }
            else if (tagName.toLowerCase() === 'a') {
                const href = getElementUrl(el);
                if (href) {
                    const lowerHref = href.toLowerCase();
                    const isMedia = isMediaUrl(href);
                    const isCloud = isCloudUrl(href);

                    if (isMedia) {
                        if (!shouldFilterMedia(href, el)) {
                            mediaLinks.add(href);
                            highlightElement(el);
                            const interesting = isInterestingMedia(href, el);
                            if (!mediaLinksMetadata.has(href) || interesting) {
                                mediaLinksMetadata.set(href, interesting);
                            }
                            const isVideoUrl = videoExtensions.some(ext => lowerHref.includes(ext)) || lowerHref.includes("bunkr") || lowerHref.includes("bunkrr");
                            if (isVideoUrl) {
                                cloudLinks.add(href);
                            }
                        }
                    } else if (isCloud) {
                        cloudLinks.add(href);
                    }
                }
            }
        });

        const text = document.body.innerText || "";
        const textUrls = extractUrlsFromText(text, window.location.href);
        textUrls.forEach(url => {
            const lowerUrl = url.toLowerCase();
            const isMedia = isMediaUrl(url);
            const isCloud = isCloudUrl(url);

            if (isMedia) {
                if (!shouldFilterMedia(url, null)) {
                    mediaLinks.add(url);
                    const interesting = isInterestingMedia(url, null);
                    if (!mediaLinksMetadata.has(url) || interesting) {
                        mediaLinksMetadata.set(url, interesting);
                    }
                    const isVideoUrl = videoExtensions.some(ext => lowerUrl.includes(ext)) || lowerUrl.includes("bunkr") || lowerUrl.includes("bunkrr");
                    if (isVideoUrl) {
                        cloudLinks.add(url);
                    }
                }
            } else if (isCloud) {
                cloudLinks.add(url);
            }
        });

        return {
            cloudLinks: Array.from(cloudLinks),
            mediaLinks: Array.from(mediaLinks).map(url => ({
                url: url,
                isInteresting: mediaLinksMetadata.get(url) ?? true
            }))
        };
    }



    async function processAndZipGallery(urls) {
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
            updateGalleryUI(currentPct, `Batch ${batchIndex}/${totalBatches} â€” Fetching item ${i + 1}/${totalFiles}`);

            try {
                const rawBuffer = await fetchAsArrayBuffer(url);
                let ext = url.split('.').pop().split(/[\?#]/)[0];
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi'].includes(ext.toLowerCase())) ext = 'jpg';

                const blob = new Blob([rawBuffer]);
                const cleanPath = pathname.replace(/\//g, '_') || 'gallery';
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
                    const cleanPath = pathname.replace(/\//g, '_') || 'gallery';
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
                const cleanPath = pathname.replace(/\//g, '_') || 'gallery';
                saveAs(zipBlob, `${cleanPath}_batch_${batchIndex}_final.zip`);
            } catch (error) {
                console.error('Final segment cleanup container execution failed:', error);
            }
        }

        updateGalleryUI(100, `Done! Downloaded ${count} files.`);
        removeGalleryUIWithDelay();
    }

    async function runSmartGalleryZip() {
        globalState.abortScraping = false;
        const gallerySelectorInput = document.getElementById('zipper-gallery-selector');
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

    async function start() {
        const avgColor = await getAverageColor();
        const rgb = avgColor.match(/\d+/g);
        let h = 230, s = 80, l = 55;
        if (rgb && rgb.length >= 3) {
            [h, s, l] = rgbToHsl(Number(rgb[0]), Number(rgb[1]), Number(rgb[2]));
        }

        const pal = generatePalette(h, s, l);
        injectStyles(pal);
        initUI(pal);
    }

    if (document.body) {
        start();
    } else {
        window.addEventListener('DOMContentLoaded', start);
    }

// --- Menu Command: Regex Link Copier ---
if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand("Copy Links by Regex", () => {
        const popup = document.createElement('div');
        popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1c1c1c;color:#eee;padding:20px;border-radius:8px;z-index:999999;box-shadow:0 0 20px rgba(0,0,0,0.8);font-family:sans-serif;display:flex;flex-direction:column;gap:10px;border:1px solid #333;';
        popup.innerHTML = `
                <div style="font-weight:bold;font-size:14px;margin-bottom:5px;">Regex Link Copier (*://...)</div>
                <input type="text" id="zipper-regex-input" placeholder="e.g. .*mp4$" style="background:#2d2d2d;color:#eee;border:1px solid #444;padding:8px;border-radius:4px;outline:none;">
                <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:5px;">
                    <button id="zipper-regex-cancel" style="background:#444;color:#eee;border:none;padding:8px 12px;border-radius:4px;cursor:pointer;">Cancel</button>
                    <button id="zipper-regex-copy" style="background:#4CAF50;color:#fff;border:none;padding:8px 12px;border-radius:4px;cursor:pointer;">Copy Links</button>
                </div>
            `;
        document.body.appendChild(popup);
        const input = popup.querySelector('#zipper-regex-input');
        input.focus();

        ['keydown', 'keyup', 'keypress'].forEach(evt => popup.addEventListener(evt, e => e.stopPropagation(), true));

        popup.querySelector('#zipper-regex-cancel').onclick = () => popup.remove();
        popup.querySelector('#zipper-regex-copy').onclick = () => {
            let rxStr = input.value.trim();
            if (!rxStr) return;
            try {
                let rx = new RegExp(rxStr, 'i');
                let allLinks = Array.from(document.querySelectorAll('a[href], img[src], video[src], source[src]')).map(el => el.href || el.src).filter(Boolean);
                let htmlText = document.documentElement.innerHTML;
                let textLinks = (htmlText.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || []);
                let combinedLinks = [...allLinks, ...textLinks];
                let matches = combinedLinks.filter(l => {
                    let withoutProto = l.replace(/^[^:]+:\/\//, '');
                    return rx.test(withoutProto) || rx.test(l);
                });
                if (matches.length > 0) {
                    navigator.clipboard.writeText(Array.from(new Set(matches)).join('\n')).then(() => {
                        alert(`Copied ${new Set(matches).size} links to clipboard!`);
                    });
                } else {
                    alert('No links matched the regex.');
                }
            } catch (e) {
                alert('Invalid Regex: ' + e.message);
            }
            popup.remove();
        };
    });
}
