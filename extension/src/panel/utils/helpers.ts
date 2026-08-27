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

export async function fetchAsArrayBuffer(url: string): Promise<ArrayBuffer> {
    // 1. Try direct fetch first (fastest, no IPC overhead for same-origin or CORS-enabled assets)
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            if (buf && buf.byteLength > 0) return buf;
        }
    } catch {
        // Direct fetch failed (CORS or network); fall back to privileged GM_xmlhttpRequest
    }

    // 2. Privileged background XHR fetch
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            timeout: 25000,
            onload: (res: any) => {
                if (res.status >= 200 && res.status < 300 && res.response instanceof ArrayBuffer && res.response.byteLength > 0) {
                    resolve(res.response);
                } else if (res.response && res.response.byteLength > 0) {
                    resolve(res.response);
                } else {
                    reject(new Error(`Failed to fetch media: HTTP ${res.status}`));
                }
            },
            onerror: (err: any) => reject(new Error(err?.error || 'Network error')),
            ontimeout: () => reject(new Error('Fetch timed out'))
        });
    });
}

import { createLocalJob, updateLocalJob, completeLocalJob, failLocalJob } from '../ui/local_jobs';

export async function clientSideFallback(urls, btn, logToConsole) {
    logToConsole("[Local] Falling back to browser-side zipping...", "info");
    btn.textContent = 'Fallback Zipping...';
    let zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
    let count = 0;
    let zipBlob;
    let blob = new Blob();

    const localJobId = createLocalJob(urls.length, window.location.href);
    const archivesCreated: string[] = [];

    for (let i = 0; i < urls.length; i++) {
        let url = urls[i];
        btn.textContent = `Fetching (${i + 1}/${urls.length})...`;
        try {
            let rawBuffer = await fetchAsArrayBuffer(url);
            if (!rawBuffer || rawBuffer.byteLength === 0) {
                throw new Error("Empty binary data received");
            }
            let ext = url.split('.').pop().split(new RegExp('[?#]'))[0];
            if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', 'mp3', 'wav', 'flac', 'm4a', 'aac'].includes(ext.toLowerCase())) ext = 'ukwn';

            blob = new Blob([rawBuffer]);
            await zipWriter.add(window.location.pathname.replace(/\//g, '_') + `_${String(count + 1).padStart(3, '0')}.${ext}`, new zip.BlobReader(blob), { level: 0 });
            count++;
            btn.textContent = `Zipping (${count}/${urls.length})...`;
            updateLocalJob(localJobId, { processed_links: count, total_links: urls.length });
        } catch (error) {
            logToConsole(`[Local] Error processing media ${i + 1}: ${error.message || error}`, "error");
        }

        await new Promise(r => setTimeout(r, 80));

        if (count > 0 && count % 100 == 0) {
            try {
                zipBlob = await zipWriter.close();
                const archiveName = window.location.pathname.replace(/\//g, '_') + '_' + getRandomInt(9) + '.zip';
                saveAs(zipBlob, archiveName);
                archivesCreated.push(archiveName);
                updateLocalJob(localJobId, { archives: [...archivesCreated] });
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
            const archiveName = window.location.pathname.replace(/\//g, '_') + '_' + getRandomInt(9) + '.zip';
            saveAs(zipBlob, archiveName);
            archivesCreated.push(archiveName);
            completeLocalJob(localJobId, archivesCreated);
            logToConsole(`[Local] Final ZIP downloaded successfully!`, "success");
        } catch (error) {
            logToConsole(`[Local] Final ZIP generation failed: ${error}`, "error");
            failLocalJob(localJobId, String(error));
        }
    } else {
        failLocalJob(localJobId, 'No files could be downloaded');
    }

    btn.textContent = 'Send Selected Media';
    btn.disabled = false;
}

export function getRandomInt(max) {
    return Math.floor(Math.random() * 1000 * max);
}

export const mediaDomains = [
    "bunkr.la", "bunkrr.su", "onlyfans.com", "fansly.com", "manyvids.com",
    "coomer.st", "coomer.su", "subscribestar.com",
    "subscribestar.adult", "kemono.cr", "kemono.su", "bunkr.cr", "balbums.st",
    "linkvertise.com", "rentry.co", "rentry.org", "pasterix.net", "mega.nz",
    "direct-link.net", "fileboom.me", "keep2share.cc",
    "k2s.cc", "rapidgator.net", "rg.to", "tezfiles.com", "katfile.com",
    "link-center.net", "link-hub.net", "link-target.net", "pastebin.com",
    "fboom.me", "gofile.io", "cyberfile.me", "pixeldrain.com",
    "1fichier.com", "terabytez.org",
    "nitroflare.com", "mediafire.com", "4shared.com", "filefactory.com", "hitfile.net",
    "clicknupload.to", "depositfiles.com", "easybytez.com", "file.al", "filerio.in", "gigapeta.com", "dailymotion.com", "drive.google.com",
    "turbobit.net", "hitfile.net", "uptobox.com", "ddl.to", "alphafile.cc", "drop.download", "filer.net", "wdupload.com"
];

export function extractUrlFromBg(bgStr) {
    if (!bgStr || bgStr === 'none' || typeof bgStr !== 'string') return '';
    // 1. Quoted url("...") or url('...')
    const quotedMatch = bgStr.match(/url\(\s*(["'])(.+?)\1\s*\)/i);
    if (quotedMatch && quotedMatch[2]) {
        return quotedMatch[2].trim();
    }
    // 2. Unquoted url(...)
    const unquotedMatch = bgStr.match(/url\(\s*([^"')\s]+)\s*\)/i);
    if (unquotedMatch && unquotedMatch[1]) {
        return unquotedMatch[1].trim();
    }
    // 3. Fallback anything inside url(...)
    const generalMatch = bgStr.match(/url\((.+?)\)/i);
    if (generalMatch && generalMatch[1]) {
        return generalMatch[1].replace(/^["']|["']$/g, '').trim();
    }
    return '';
}

export function normalizeUrl(url, baseUrl = (typeof window !== 'undefined' ? window.location.href : '')) {
    if (!url) return "";
    let value = String(url).trim();
    if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("javascript:")) return "";

    // Strip surrounding quotes or angle brackets if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).trim();
    }
    if (value.startsWith('<') && value.endsWith('>')) {
        value = value.slice(1, -1).trim();
    }

    try {
        return new URL(value, baseUrl || undefined).href;
    } catch (_e) {
        if (value.startsWith('//') && typeof window !== 'undefined') {
            try {
                return new URL(window.location.protocol + value).href;
            } catch { }
        }
        return value;
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
                directUrl = extractUrlFromBg(bg);
            }
        } catch (_) { }

        if (!directUrl) {
            const inlineStyle = el.getAttribute('style') || '';
            if (inlineStyle) {
                directUrl = extractUrlFromBg(inlineStyle);
            }
        }
    }
    return normalizeUrl(directUrl, window.location.href);
}

export function getDomain(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url.startsWith('http') ? url : 'http://' + url);
        return parsed.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        const m = url.toLowerCase().match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+)/i);
        return m ? m[1] : '';
    }
}

export function isSameDomain(url, currentUrl = (typeof window !== 'undefined' ? window.location.href : '')) {
    if (!url || !currentUrl) return false;
    const d1 = getDomain(url);
    const d2 = getDomain(currentUrl);
    if (!d1 || !d2) return false;
    return d1 === d2 || d1.endsWith('.' + d2) || d2.endsWith('.' + d1);
}

function matchesDomain(url, domainList) {
    if (!url) return false;
    const hostname = getDomain(url);
    if (!hostname) return false;
    return domainList.some(d => {
        const domain = d.toLowerCase().replace(/^www\./, '');
        return hostname === domain || hostname.endsWith('.' + domain);
    });
}

export function isCloudUrl(url, currentUrl = (typeof window !== 'undefined' ? window.location.href : '')) {
    if (!url) return false;
    // If the link is on the same domain as the current page, do NOT treat it as a cloud link
    if (isSameDomain(url, currentUrl)) {
        return false;
    }
    return matchesDomain(url, mediaDomains);
}

export function isMediaUrl(url, currentUrl = (typeof window !== 'undefined' ? window.location.href : '')) {
    if (!url) return false;
    const lower = url.toLowerCase();
    const isDirectMediaExt = /\.(jpg|jpeg|png|gif|webp|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv|mp3|wav|flac|m4a|aac)(?:[?#].*)?$/i.test(lower);
    if (isDirectMediaExt) return true;

    // If on same domain, require direct media extension (do not accept arbitrary page links)
    if (isSameDomain(url, currentUrl)) {
        return false;
    }

    return matchesDomain(url, mediaDomains);
}

