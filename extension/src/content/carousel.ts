// @ts-nocheck -- ported verbatim from the retired panel; the module table below
// is hard-won and not worth rewriting for type coverage.
/**
 * Carousel and lightbox extraction.
 *
 * Ported out of the panel rather than dropped with it. This is the piece that
 * reaches media a plain DOM walk cannot: slides that only exist inside a
 * viewer's own state (PhotoSwipe's Vue dataSource, Swiper's slide array), which
 * is exactly the OnlyFans-style case where the full-size URLs are never in the
 * page markup until the viewer is opened.
 *
 * `normalizeUrl` and `extractUrlFromBg` are inlined below — importing them from
 * the panel's helpers would drag the whole retired UI chain back into the
 * content bundle.
 */

function normalizeUrl(url, baseUrl = (typeof window !== 'undefined' ? window.location.href : '')) {
    if (!url) return "";
    let value = String(url).trim();
    if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("javascript:") || value.startsWith("vbscript:")) return "";

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

function extractUrlFromBg(bgStr) {
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

export interface KnownModuleDefinition {
    name: string;
    containerSelectors: string[];
    itemSelectors: string[];
    attributeKeys: string[];
    extractCustom?: (container: Element) => string[];
}

export const KNOWN_MODULES: KnownModuleDefinition[] = [
    {
        name: 'PhotoSwipe',
        containerSelectors: ['div.photoswipe', '.pswp', '.pswp--open', '.pswp-gallery', '[data-pswp-gallery]'],
        itemSelectors: [
            '.pswp__item',
            '.pswp__zoom-wrap img',
            '.pswp__img',
            'a[data-pswp-src]',
            '[data-pswp-src]',
            'a.photoswipe-item',
            '.pswp-gallery a'
        ],
        attributeKeys: ['data-pswp-src', 'data-src', 'data-highres', 'data-med', 'href', 'src'],
        extractCustom: (container: Element) => {
            const urls: string[] = [];
            try {
                // Vue instance dataSource inspection (e.g., OnlyFans, various Vue galleries)
                const vue = (container as any).__vue__ ||
                    (typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).document?.querySelector('div.photoswipe')?.__vue__);
                const ds = vue ? (vue.dataSource || (vue._props && vue._props.dataSource)) : null;
                if (ds && Array.isArray(ds)) {
                    ds.forEach((item: any) => {
                        if (item && item.src) urls.push(item.src);
                        if (item && item.msrc && !item.src) urls.push(item.msrc);
                    });
                }
            } catch (_) { }

            try {
                // Global PhotoSwipe instance check
                const pswp = (window as any).pswp || (typeof unsafeWindow !== 'undefined' && (unsafeWindow as any).pswp);
                if (pswp && Array.isArray(pswp.items)) {
                    pswp.items.forEach((item: any) => {
                        if (item?.src) urls.push(item.src);
                    });
                }
            } catch (_) { }
            return urls;
        }
    },
    {
        name: 'Swiper',
        containerSelectors: ['.swiper', '.swiper-container', '.swiper-wrapper'],
        itemSelectors: ['.swiper-slide', '.swiper-slide img', '.swiper-slide video', '.swiper-slide source'],
        attributeKeys: ['data-src', 'data-srcset', 'data-background', 'src', 'href']
    },
    {
        name: 'Slick',
        containerSelectors: ['.slick-slider', '.slick-list', '.slick-track'],
        itemSelectors: ['.slick-slide:not(.slick-cloned)', '.slick-slide img', '.slick-slide video'],
        attributeKeys: ['data-lazy', 'data-src', 'data-original', 'data-srcset', 'src', 'href']
    },
    {
        name: 'LightGallery',
        containerSelectors: ['.lg-container', '.lg-outer', '.lg-item', '[data-lg-id]'],
        itemSelectors: ['.lg-img-wrap img', '.lg-image', '.lg-video video', '[data-src]'],
        attributeKeys: ['data-src', 'data-responsive', 'data-video', 'data-download-url', 'src', 'href']
    },
    {
        name: 'Fancybox',
        containerSelectors: ['.fancybox__container', '.fancybox__carousel', '.fancybox-container', '[data-fancybox]'],
        itemSelectors: ['.fancybox__slide', '.fancybox__content img', '.fancybox-image', 'a[data-fancybox]'],
        attributeKeys: ['data-src', 'data-srcset', 'data-thumb', 'href', 'src']
    },
    {
        name: 'Splide',
        containerSelectors: ['.splide', '.splide__track', '.splide__list'],
        itemSelectors: ['.splide__slide:not(.splide__slide--clone)', '.splide__slide img', '.splide__slide video'],
        attributeKeys: ['data-splide-lazy', 'data-splide-lazy-srcset', 'src', 'data-src']
    },
    {
        name: 'Flickity',
        containerSelectors: ['.flickity-enabled', '.flickity-viewport', '.flickity-slider'],
        itemSelectors: ['.carousel-cell', '.flickity-slider > *', 'img[data-flickity-lazyload]'],
        attributeKeys: ['data-flickity-lazyload', 'data-flickity-lazyload-srcset', 'src', 'data-src']
    },
    {
        name: 'OwlCarousel',
        containerSelectors: ['.owl-carousel', '.owl-stage-outer', '.owl-stage'],
        itemSelectors: ['.owl-item:not(.cloned)', '.owl-item img', '.owl-lazy'],
        attributeKeys: ['data-src', 'data-src-retina', 'src', 'href']
    },
    {
        name: 'Glide',
        containerSelectors: ['.glide', '.glide__track', '.glide__slides'],
        itemSelectors: ['.glide__slide:not(.glide__slide--clone)', '.glide__slide img'],
        attributeKeys: ['data-src', 'src', 'href']
    },
    {
        name: 'GLightbox',
        containerSelectors: ['.glightbox-container', '.gslide', 'a.glightbox', '[data-glightbox]'],
        itemSelectors: ['.gslide-image img', '.gslide-video video', 'a.glightbox', '[data-glightbox]'],
        attributeKeys: ['href', 'data-glightbox', 'data-src', 'src']
    },
    {
        name: 'MagnificPopup',
        containerSelectors: ['.mfp-container', '.mfp-content', '.mfp-wrap', 'a.mfp-image'],
        itemSelectors: ['.mfp-img', '.mfp-figure img', 'a.mfp-image', '[data-mfp-src]'],
        attributeKeys: ['href', 'data-mfp-src', 'src']
    },
    {
        name: 'BlueimpGallery',
        containerSelectors: ['.blueimp-gallery', '.blueimp-gallery-carousel', '[data-gallery]'],
        itemSelectors: ['.slides > *', '[data-gallery] a'],
        attributeKeys: ['href', 'data-href', 'src', 'data-src']
    }
];

const GENERIC_CAROUSEL_SELECTORS = [
    '[class*="carousel" i]',
    '[class*="slider" i]',
    '[class*="slideshow" i]',
    '[class*="lightbox" i]',
    '[class*="gallery-slider" i]',
    '[class*="image-viewer" i]',
    '[class*="photo-viewer" i]',
    '[class*="media-viewer" i]',
    '[id*="carousel" i]',
    '[id*="slider" i]',
    '[id*="slideshow" i]',
    '[id*="lightbox" i]',
    '[id*="viewer" i]'
];

const HIGH_RES_DATA_ATTRS = [
    'data-pswp-src',
    'data-original',
    'data-orig-file',
    'data-highres',
    'data-highres-src',
    'data-full-url',
    'data-full',
    'data-large',
    'data-zoom-image',
    'data-zoom-src',
    'data-actualsrc',
    'data-lazy-src',
    'data-lazy',
    'data-src',
    'data-video',
    'data-splide-lazy',
    'data-flickity-lazyload',
    'data-url',
    'data-image',
    'data-bg',
    'data-background'
];

const MEDIA_EXTENSION_REGEX = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mkv|mov|m4v|avi|flv|wmv|mp3|wav|flac)(?:[?#].*)?$/i;
const REJECT_EXT_REGEX = /\.(svg|ico|cur|bmp)(?:[?#].*)?$/i;

function extractUrlsFromElement(el: Element, baseUrl: string = window.location.href): string[] {
    const urls: string[] = [];
    if (!el || !(el instanceof Element)) return urls;

    // 1. Check high-res data attributes first
    for (const attr of HIGH_RES_DATA_ATTRS) {
        const val = el.getAttribute(attr);
        if (val) {
            const norm = normalizeUrl(val, baseUrl);
            if (norm && !REJECT_EXT_REGEX.test(norm)) {
                urls.push(norm);
            }
        }
    }

    // 2. Check srcset (take the largest/last candidate)
    const srcset = el.getAttribute('srcset') || (el as any).srcset;
    if (srcset) {
        const candidates = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
        if (candidates.length > 0) {
            const bestSrc = candidates[candidates.length - 1];
            const norm = normalizeUrl(bestSrc, baseUrl);
            if (norm && !REJECT_EXT_REGEX.test(norm)) {
                urls.push(norm);
            }
        }
    }

    // 3. Direct src / href
    const src = (el as any).currentSrc || (el as any).src || el.getAttribute('src');
    if (src) {
        const norm = normalizeUrl(src, baseUrl);
        if (norm && !REJECT_EXT_REGEX.test(norm)) {
            urls.push(norm);
        }
    }

    const href = (el as any).href || el.getAttribute('href');
    if (href) {
        const norm = normalizeUrl(href, baseUrl);
        if (norm && MEDIA_EXTENSION_REGEX.test(norm) && !REJECT_EXT_REGEX.test(norm)) {
            urls.push(norm);
        }
    }

    // 4. Background images
    try {
        const style = window.getComputedStyle(el);
        const bg = style ? style.backgroundImage : '';
        if (bg && bg !== 'none') {
            const bgUrl = extractUrlFromBg(bg);
            if (bgUrl) {
                const norm = normalizeUrl(bgUrl, baseUrl);
                if (norm && !REJECT_EXT_REGEX.test(norm)) {
                    urls.push(norm);
                }
            }
        }
    } catch (_) { }

    return urls;
}

/**
 * Scan the document (or container) for known JS gallery/carousel modules and body overlays.
 * Returns an array of clean, unique, full-resolution media URLs.
 */
export function extractCarouselMediaUrls(root: ParentNode = document): string[] {
    const collectedUrls = new Set<string>();
    const baseUrl = window.location.href;

    // 1. Run all known module definitions
    for (const mod of KNOWN_MODULES) {
        for (const containerSel of mod.containerSelectors) {
            const containers = root.querySelectorAll(containerSel);
            containers.forEach(container => {
                // Custom extraction (e.g. Vue data source on PhotoSwipe)
                if (mod.extractCustom) {
                    const customUrls = mod.extractCustom(container);
                    customUrls.forEach(u => {
                        const norm = normalizeUrl(u, baseUrl);
                        if (norm && !REJECT_EXT_REGEX.test(norm)) {
                            collectedUrls.add(norm);
                        }
                    });
                }

                // Check item selectors within the container
                for (const itemSel of mod.itemSelectors) {
                    const items = container.querySelectorAll(itemSel);
                    items.forEach(item => {
                        const urls = extractUrlsFromElement(item, baseUrl);
                        urls.forEach(u => collectedUrls.add(u));
                    });
                }

                // Check direct container attributes
                const containerUrls = extractUrlsFromElement(container, baseUrl);
                containerUrls.forEach(u => collectedUrls.add(u));
            });
        }
    }

    // 2. Scan body-level overlays outside main content (common for lightboxes)
    if (root === document && document.body) {
        const bodyChildren = Array.from(document.body.children);
        for (const child of bodyChildren) {
            // Ignore zipper panel and basic scripts
            if (child.id === 'zipper-panel' || child.id === 'zipper-fab' || child.id === 'zipper-float-download-btn' || child.tagName.toLowerCase() === 'script') {
                continue;
            }

            const classIdStr = `${child.className || ''} ${child.id || ''}`.toLowerCase();
            const isOverlay = /(lightbox|viewer|modal|overlay|popup|pswp|gallery|carousel|slider)/i.test(classIdStr) ||
                child.getAttribute('role') === 'dialog';

            if (isOverlay) {
                const mediaNodes = child.querySelectorAll('img, video, audio, source, a, picture, div, span, [style*="background"], [data-src], [data-image]');
                mediaNodes.forEach(node => {
                    const urls = extractUrlsFromElement(node, baseUrl);
                    urls.forEach(u => collectedUrls.add(u));
                });
            }
        }
    }

    // 3. Generic carousel selectors across root
    for (const selector of GENERIC_CAROUSEL_SELECTORS) {
        const matchingContainers = root.querySelectorAll(selector);
        matchingContainers.forEach(container => {
            if (container.closest('#zipper-panel') || container.closest('#zipper-fab')) return;
            const nodes = container.querySelectorAll('img, video, source, a, div, span');
            nodes.forEach(node => {
                const urls = extractUrlsFromElement(node, baseUrl);
                urls.forEach(u => collectedUrls.add(u));
            });
        });
    }

    // Filter out the base HTML document URL itself
    return Array.from(collectedUrls).filter(u => u !== baseUrl && u !== `${baseUrl}#`);
}
