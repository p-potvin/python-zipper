// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { extractUrlFromBg } from '../utils/helpers';

export function isHighQualityMedia(url: string): boolean {
    const lower = url.toLowerCase();
    const qualityPatterns = [
        '480', '360', '1080', '720', 'source', 'original', 'origin'
    ];
    return qualityPatterns.some(pat => lower.includes(pat));
}

export async function resolveBestMediaUrl(url: string): Promise<string> {
    let resolved = url;
    if (url.includes('onlyfans.com') && url.includes('/thumbs/')) {
        resolved = url.replace('/thumbs/', '/files/');
    } else if ((url.includes('coomer.su') || url.includes('kemono.su')) && url.includes('/thumbnail/')) {
        resolved = url.replace('/thumbnail/', '/');
    } else if (url.includes('bunkr') && url.includes('/thumbs/')) {
        resolved = url.replace('/thumbs/', '/images/');
    }
    const ext = url.split('.').pop()?.split(/[?#]/)[0].toLowerCase() || '';
    const isDirectMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav'].includes(ext);

    if (!isDirectMedia && (url.startsWith('http://') || url.startsWith('https://'))) {
        try {
            const htmlText = await new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => resolve(''), 3500);
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    timeout: 3500,
                    onload: (res) => {
                        clearTimeout(timer);
                        resolve(res.responseText || '');
                    },
                    onerror: () => {
                        clearTimeout(timer);
                        resolve('');
                    },
                    ontimeout: () => {
                        clearTimeout(timer);
                        resolve('');
                    }
                });
            });
            if (!htmlText) return resolved;
            const doc = new DOMParser().parseFromString(htmlText, 'text/html');
            const ogVideo = doc.querySelector('meta[property="og:video"]') as HTMLMetaElement;
            if (ogVideo && ogVideo.content) return ogVideo.content;
            const ogAudio = doc.querySelector('meta[property="og:audio"]') as HTMLMetaElement;
            if (ogAudio && ogAudio.content) return ogAudio.content;
            const ogImage = doc.querySelector('meta[property="og:image"]') as HTMLMetaElement;
            if (ogImage && ogImage.content) return ogImage.content;
            const videoTag = doc.querySelector('video source') as HTMLSourceElement || doc.querySelector('video') as HTMLVideoElement;
            if (videoTag) {
                const src = videoTag.src || videoTag.getAttribute('src');
                if (src) return new URL(src, url).href;
            }
            const audioTag = doc.querySelector('audio source') as HTMLSourceElement || doc.querySelector('audio') as HTMLAudioElement;
            if (audioTag) {
                const src = audioTag.src || audioTag.getAttribute('src');
                if (src) return new URL(src, url).href;
            }
            const imgTag = doc.querySelector('img#image') as HTMLImageElement || doc.querySelector('img.main-image') as HTMLImageElement || doc.querySelector('div.image-container img') as HTMLImageElement;
            if (imgTag && imgTag.src) return new URL(imgTag.src, url).href;

            const bgEl = doc.querySelector('div[data-src], span[data-src], div[data-image], span[data-image], div[data-bg], span[data-bg], [style*="background-image"]') as HTMLElement;
            if (bgEl) {
                const styleAttr = bgEl.getAttribute('style') || '';
                const bgUrl = extractUrlFromBg(styleAttr);
                if (bgUrl) {
                    return new URL(bgUrl, url).href;
                }
                const dataSrc = bgEl.getAttribute('data-src') || bgEl.getAttribute('data-image') || bgEl.getAttribute('data-url') || bgEl.getAttribute('data-bg') || bgEl.getAttribute('data-original');
                if (dataSrc) {
                    return new URL(dataSrc, url).href;
                }
            }
        } catch (e) {
            console.error('[Resolver] Failed background resolution:', e);
        }
    }
    return resolved;
}
