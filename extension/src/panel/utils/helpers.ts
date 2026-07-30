// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked

    /** Safely set HTML content on an element without using .innerHTML directly. */
    export function setElementHTML(el, html) {
        if (!el || html == null) return;
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const nodes = [...parsed.body.childNodes];
        el.replaceChildren(...nodes);
    }

    /** Safely insert HTML adjacent to an element without using insertAdjacentHTML. */
    export function insertElementHTML(el, position, html) {
        if (!el || html == null) return;
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const nodes = [...parsed.body.childNodes];
        if (position === 'beforebegin') el.before(...nodes);
        else if (position === 'afterbegin') el.prepend(...nodes);
        else if (position === 'beforeend') el.append(...nodes);
        else if (position === 'afterend') el.after(...nodes);
    }

    /** Create an element from an HTML string. Returns first child element. */
    export function htmlToElement(html) {
        const parsed = new DOMParser().parseFromString(html.trim(), 'text/html');
        return parsed.body.firstElementChild || null;
    }

    export function fetchAsArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                onload: (res) => res.status >= 200 && res.status < 300 ? resolve(res.response) : reject(res.status),
                onerror: reject
            });
        });
    }

    export async function clientSideFallback(urls, btn, logToConsole) {
        logToConsole("[Local] Falling back to browser-side zipping...", "info");
        btn.textContent = 'Fallback Zipping...';
        let zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
        let count = 0;
        let zipBlob;
        let blob = new Blob();

        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            try {
                let rawBuffer = await fetchAsArrayBuffer(url);
                let ext = url.split('.').pop().split(new RegExp('[?#]'))[0];
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi'].includes(ext.toLowerCase())) ext = 'jpg';

                blob = new Blob([rawBuffer]);
                await zipWriter.add(window.location.pathname + `_${String(i + 1).padStart(3, '0')}.${ext}`, new zip.BlobReader(blob), { level: 0 });
                count++;
                btn.textContent = `Zipping (${count}/${urls.length})...`;
            } catch (error) {
                logToConsole(`[Local] Error processing media ${i + 1}: ${error.message || error}`, "error");
            }

            await new Promise(r => setTimeout(r, 80));

            if (count > 0 && count % 100 == 0) {
                try {
                    zipBlob = await zipWriter.close();
                    saveAs(zipBlob, window.location.pathname + '_' + getRandomInt(9) + '.zip');
                    logToConsole(`[Local] Downloaded batch ZIP of 100 media files!`, "success");
                    zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
                } catch (error) {
                    logToConsole(`[Local] Batch generation failed: ${error}`, "error");
                    break;
                }
            }
        }

        if (count > 0) {
            try {
                zipBlob = await zipWriter.close();
                saveAs(zipBlob, window.location.pathname + '_' + getRandomInt(9) + '.zip');
                logToConsole(`[Local] Final ZIP downloaded successfully!`, "success");
            } catch (error) {
                logToConsole(`[Local] Final ZIP generation failed: ${error}`, "error");
            }
        }

        btn.textContent = 'Send Selected Media';
        btn.disabled = false;
    }

    export function getRandomInt(max) {
        return Math.floor(Math.random() * 1000 * max);
    }

    export const cloudDomains = [
        "linkvertise.com", "rentry.co", "rentry.org", "pasterix.net", "mega.nz",
        "real-debrid.com", "trw.lat", "direct-link.net", "fileboom.me", "keep2share.cc",
        "k2s.cc", "rapidgator.net", "rg.to", "tezfiles.com", "katfile.com",
        "link-center.net", "link-hub.net", "link-target.net", "pastebin.com",
        "fboom.me", "gofile.io", "cyberfile.me", "pixeldrain.com", "patreon.com",
        "x.com", "twitter.com", "fanbox.cc", "bunkr.cr", "balbums.st", "1fichier.com", "gofile.io", "terabytez.org"
    ];

    export const mediaDomains = [
        "bunkr.la", "bunkrr.su", "onlyfans.com", "fansly.com", "manyvids.com",
        "coomer.st", "coomer.su", "pixiv.net", "subscribestar.com",
        "subscribestar.adult", "kemono.cr", "kemono.su", "bunkr.cr", "balbums.st",
        "linkvertise.com", "rentry.co", "rentry.org", "pasterix.net", "mega.nz",
        "real-debrid.com", "trw.lat", "direct-link.net", "fileboom.me", "keep2share.cc",
        "k2s.cc", "rapidgator.net", "rg.to", "tezfiles.com", "katfile.com",
        "link-center.net", "link-hub.net", "link-target.net", "pastebin.com",
        "fboom.me", "gofile.io", "cyberfile.me", "pixeldrain.com", "patreon.com",
        "x.com", "twitter.com", "fanbox.cc", "1fichier.com", "gofile.io", "terabytez.org"
    ];

    export function normalizeUrl(url, baseUrl = window.location.href) {
        if (!url) return "";
        let value = String(url).trim();
        if (!value || value.startsWith("data:") || value.startsWith("blob:")) return "";
        if (value.includes(",")) {
            value = value.split(",").pop().trim().split(/\s+/)[0];
        }
        value = value.replace(/[)\].,;'"<>]+$/g, "");
        try {
            return new URL(value, baseUrl).href;
        } catch (_e) {
            return "";
        }
    }

    export function extractUrlsFromText(text, baseUrl = window.location.href) {
        const matched = String(text || "").match(/(?:https?:)?\/\/[^\s"'<>\(\)]+/gi) || [];
        return [...new Set(matched.map(url => normalizeUrl(url, baseUrl)).filter(Boolean))];
    }

    export function getElementUrl(el) {
        if (!el) return "";
        const srcset = el.getAttribute('srcset') || el.srcset || '';
        if (srcset) {
            const candidates = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
            if (candidates.length > 0) return normalizeUrl(candidates[candidates.length - 1], window.location.href);
        }
        return normalizeUrl(el.currentSrc || el.src || el.getAttribute('data-src') || el.href || el.getAttribute('href') || '', window.location.href);
    }

    export function isCloudUrl(url) {
        const lower = url.toLowerCase();
        return cloudDomains.some(domain => lower.includes(domain));
    }

    export function isMediaUrl(url) {
        const lower = url.toLowerCase();
        return /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)(?:[?#].*)?$/i.test(lower) ||
            mediaDomains.some(domain => lower.includes(domain));
    }
