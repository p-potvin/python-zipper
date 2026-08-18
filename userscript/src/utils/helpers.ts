declare const GM_xmlhttpRequest: any;
declare const zip: any;
declare const saveAs: any;

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
            if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext.toLowerCase())) ext = 'jpg';

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
    "fanbox.cc", "bunkr.cr", "balbums.st", "1fichier.com", "terabytez.org"
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
    "fanbox.cc", "1fichier.com", "terabytez.org"
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
    let directUrl = el.currentSrc || el.src ||
        el.getAttribute('data-src') || el.getAttribute('data-url') ||
        el.getAttribute('data-bg') || el.getAttribute('data-background') ||
        el.getAttribute('data-image') || el.getAttribute('data-original') ||
        el.getAttribute('data-highres') || el.getAttribute('data-full') ||
        el.poster || el.href || el.getAttribute('href') || '';

    if (!directUrl && typeof window !== 'undefined' && el instanceof Element) {
        try {
            const style = window.getComputedStyle(el);
            const bg = style ? style.backgroundImage : '';
            if (bg && bg !== 'none') {
                const match = bg.match(/url\(['"]?([^'")]+)['"]?\)/i);
                if (match && match[1]) {
                    directUrl = match[1];
                }
            }
        } catch (_) { }

        if (!directUrl) {
            const inlineStyle = el.getAttribute('style') || '';
            const match = inlineStyle.match(/background(?:-image)?\s*:\s*[^;]*url\(['"]?([^'")]+)['"]?\)/i);
            if (match && match[1]) {
                directUrl = match[1];
            }
        }
    }
    return normalizeUrl(directUrl, window.location.href);
}

function matchesDomain(url, domainList) {
    if (!url) return false;
    let hostname = '';
    try {
        const parsed = new URL(url.startsWith('http') ? url : 'http://' + url);
        hostname = parsed.hostname.toLowerCase();
    } catch {
        const m = url.toLowerCase().match(/(?:https?:\/\/)?([a-z0-9.-]+)/i);
        hostname = m ? m[1] : url.toLowerCase();
    }
    return domainList.some(d => {
        const domain = d.toLowerCase();
        return hostname === domain || hostname.endsWith('.' + domain);
    });
}

export function isCloudUrl(url) {
    return matchesDomain(url, cloudDomains);
}

export function isMediaUrl(url) {
    const lower = url.toLowerCase();
    return /\.(jpg|jpeg|png|gif|webp|svg|ico|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv|mp3|wav|flac|m4a|aac)(?:[?#].*)?$/i.test(lower) ||
        matchesDomain(url, mediaDomains);
}
