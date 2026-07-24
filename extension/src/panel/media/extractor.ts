// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
export function isHighQualityMedia(url: string): boolean {
    const lower = url.toLowerCase();
    const qualityPatterns = [
        '1080p', '720p', '4k', '2160p', '1440p', '1080', '720', '1920', '3840', '2560',
        'highres', 'hd', 'full', 'source', 'original', 'origin'
    ];
    return qualityPatterns.some(pat => lower.includes(pat));
}

export async function resolveBestMediaUrl(url: string): Promise<string> {
    let resolved = url;
    if (url.includes('onlyfans.com') && url.includes('/thumbs/')) {
        resolved = url.replace('/thumbs/', '/files/');
    }
    const ext = url.split('.').pop()?.split(/[?#]/)[0].toLowerCase() || '';
    const isDirectMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'ogg'].includes(ext);

    if (!isDirectMedia && (url.startsWith('http://') || url.startsWith('https://'))) {
        try {
            const htmlText = await new Promise<string>((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    onload: (res) => resolve(res.responseText),
                    onerror: reject
                });
            });
            const doc = new DOMParser().parseFromString(htmlText, 'text/html');
            const ogVideo = doc.querySelector('meta[property="og:video"]') as HTMLMetaElement;
            if (ogVideo && ogVideo.content) return ogVideo.content;
            const ogImage = doc.querySelector('meta[property="og:image"]') as HTMLMetaElement;
            if (ogImage && ogImage.content) return ogImage.content;
            const videoTag = doc.querySelector('video source') as HTMLSourceElement || doc.querySelector('video') as HTMLVideoElement;
            if (videoTag) {
                const src = videoTag.src || videoTag.getAttribute('src');
                if (src) return new URL(src, url).href;
            }
            const imgTag = doc.querySelector('img#image') as HTMLImageElement || doc.querySelector('img.main-image') as HTMLImageElement || doc.querySelector('div.image-container img') as HTMLImageElement;
            if (imgTag && imgTag.src) return new URL(imgTag.src, url).href;
        } catch (e) {
            console.error('[Resolver] Failed background resolution:', e);
        }
    }
    return resolved;
}
