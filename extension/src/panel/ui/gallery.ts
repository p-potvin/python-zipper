// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
import { globalState } from '../utils/state';

export function createGalleryUI() {
    const existing = document.getElementById('zipper-gallery-ui');
    if (existing) return;

    const uiContainer = document.createElement('div');
    uiContainer.id = 'zipper-gallery-ui';
    Object.assign(uiContainer.style, {
        position: 'fixed',
        bottom: '0',
        left: '0',
        width: '100%',
        height: '40px',
        backgroundColor: 'rgba(15, 12, 24, 0.95)',
        borderTop: '1px solid #3c2a61',
        zIndex: '9999999',
        fontFamily: '"Segoe UI", Roboto, Helvetica, monospace',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        boxShadow: '0 -5px 25px rgba(0,0,0,0.8)',
        transition: 'opacity 0.4s ease',
        opacity: '1'
    });

    const interfaceRow = document.createElement('div');
    Object.assign(interfaceRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 15px 4px 15px'
    });

    const statusText = document.createElement('div');
    statusText.id = 'zipper-gallery-status';
    Object.assign(statusText.style, {
        color: '#dcd3ff',
        fontSize: '12px',
        fontWeight: '600',
        letterSpacing: '0.5px',
        textShadow: '0 2px 4px rgba(0,0,0,0.5)',
        flexGrow: '1'
    });
    statusText.innerHTML = '<span>Initializing Pipeline...</span><span>0%</span>';

    const stopButton = document.createElement('button');
    stopButton.textContent = 'STOP & DOWNLOAD';
    Object.assign(stopButton.style, {
        backgroundColor: '#ef4444',
        color: '#ffffff',
        border: 'none',
        borderRadius: '4px',
        padding: '4px 12px',
        fontSize: '11px',
        fontWeight: '700',
        cursor: 'pointer',
        boxShadow: '0 0 8px rgba(239, 68, 68, 0.5)',
        transition: 'background-color 0.2s',
        marginLeft: '15px'
    });

    stopButton.addEventListener('mouseenter', () => stopButton.style.backgroundColor = '#dc2626');
    stopButton.addEventListener('mouseleave', () => stopButton.style.backgroundColor = '#ef4444');
    stopButton.addEventListener('click', () => {
        globalState.abortScraping = true;
        stopButton.disabled = true;
        stopButton.style.backgroundColor = '#4b5563';
        stopButton.textContent = 'HALTING...';
    });

    interfaceRow.appendChild(statusText);
    interfaceRow.appendChild(stopButton);

    const track = document.createElement('div');
    Object.assign(track.style, {
        width: '100%',
        height: '6px',
        backgroundColor: '#1b162b',
        overflow: 'hidden'
    });

    const progressBar = document.createElement('div');
    progressBar.id = 'zipper-gallery-progress';
    Object.assign(progressBar.style, {
        width: '0%',
        height: '100%',
        background: 'linear-gradient(90deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)',
        boxShadow: '0 0 12px #a855f7',
        transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        willChange: 'width'
    });

    track.appendChild(progressBar);
    uiContainer.appendChild(interfaceRow);
    uiContainer.appendChild(track);
    document.body.appendChild(uiContainer);
}

export function updateGalleryUI(percentage: number, label: string) {
    createGalleryUI();
    const uiContainer = document.getElementById('zipper-gallery-ui');
    if (uiContainer) uiContainer.style.opacity = '1';
    const progressBar = document.getElementById('zipper-gallery-progress');
    if (progressBar) progressBar.style.width = `${percentage}%`;
    const statusText = document.getElementById('zipper-gallery-status');
    if (statusText) statusText.innerHTML = `<span>${label}</span><span>${Math.round(percentage)}%</span>`;
}

export function removeGalleryUIWithDelay() {
    const uiContainer = document.getElementById('zipper-gallery-ui');
    if (!uiContainer) return;
    setTimeout(() => {
        uiContainer.style.opacity = '0';
        setTimeout(() => {
            if (uiContainer && uiContainer.parentNode) {
                uiContainer.parentNode.removeChild(uiContainer);
            }
        }, 400);
    }, 3000);
}

export function scrollToBottomSmartForGallery() {
    return new Promise<void>((resolve) => {
        createGalleryUI();
        updateGalleryUI(0, "Scanning timeline and caching pages...");

        let lastMutationTime = Date.now();
        let checkInterval: any;

        const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        const scrollRunner = setInterval(() => {
            if (globalState.abortScraping) {
                clearInterval(scrollRunner);
                clearInterval(checkInterval);
                observer.disconnect();
                resolve();
                return;
            }
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        }, 300);

        checkInterval = setInterval(() => {
            const idleTime = Date.now() - lastMutationTime;
            const hitBottom = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 50;

            if ((hitBottom && idleTime > 1500) || globalState.abortScraping) {
                clearInterval(scrollRunner);
                clearInterval(checkInterval);
                observer.disconnect();
                resolve();
            }
        }, 500);
    });
}

let isPickerActive = false;
let pickerHighlightBox: HTMLElement | null = null;
let pickerTooltip: HTMLElement | null = null;

export function getOptimalCssSelector(el: Element): string {
    if (!el || el === document.body || el === document.documentElement) return '';

    // 1. Valid non-dynamic ID
    if (el.id && typeof el.id === 'string') {
        const cleanId = el.id.trim();
        if (cleanId && !/^[0-9]+$/.test(cleanId) && !cleanId.includes('zipper-') && !cleanId.includes('ember') && !cleanId.includes(':')) {
            try {
                if (document.querySelectorAll(`#${CSS.escape(cleanId)}`).length === 1) {
                    return `#${cleanId}`;
                }
            } catch (_) { }
        }
    }

    // 2. Meaningful class names
    if (el.className && typeof el.className === 'string') {
        const rawClasses = el.className.split(/\s+/).filter(Boolean);
        const ignored = /^(zipper-|active|hover|focus|show|hide|hidden|selected|open|closed|is-|has-|ng-|v-|style-|css-|_)/i;
        const validClasses = rawClasses.filter(c => !ignored.test(c) && !/^[0-9a-f]{8,}$/i.test(c));
        
        if (validClasses.length > 0) {
            for (let len = 1; len <= Math.min(3, validClasses.length); len++) {
                const sel = '.' + validClasses.slice(0, len).join('.');
                try {
                    const matches = document.querySelectorAll(sel);
                    if (matches.length > 0 && matches.length <= 15) {
                        return sel;
                    }
                } catch (_) { }
            }
            return '.' + validClasses[0];
        }
    }

    // 3. Meaningful attributes
    for (const attr of ['data-test', 'data-testid', 'data-qa', 'name', 'role']) {
        const val = el.getAttribute(attr);
        if (val) {
            return `[${attr}="${val}"]`;
        }
    }

    // 4. Tag + parent hierarchy
    const tag = el.tagName.toLowerCase();
    let parent = el.parentElement;
    if (parent && parent !== document.body) {
        const parentSel = getOptimalCssSelector(parent);
        if (parentSel) {
            return `${parentSel} > ${tag}`;
        }
    }

    return tag;
}

export function startElementPicker(onSelect: (selector: string) => void) {
    if (isPickerActive) {
        stopElementPicker();
        return;
    }

    isPickerActive = true;

    if (!pickerHighlightBox) {
        pickerHighlightBox = document.createElement('div');
        pickerHighlightBox.id = 'zipper-picker-highlight-box';
        Object.assign(pickerHighlightBox.style, {
            position: 'absolute',
            pointerEvents: 'none',
            border: '2px solid #a855f7',
            background: 'rgba(168, 85, 247, 0.15)',
            boxShadow: '0 0 10px rgba(168, 85, 247, 0.6)',
            borderRadius: '3px',
            zIndex: '2147483640',
            transition: 'all 0.05s ease-out',
            display: 'none'
        });
        document.body.appendChild(pickerHighlightBox);
    }

    if (!pickerTooltip) {
        pickerTooltip = document.createElement('div');
        pickerTooltip.id = 'zipper-picker-tooltip';
        Object.assign(pickerTooltip.style, {
            position: 'absolute',
            pointerEvents: 'none',
            background: '#1b162b',
            color: '#dcd3ff',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid #a855f7',
            fontFamily: 'monospace',
            fontSize: '11px',
            fontWeight: '600',
            zIndex: '2147483641',
            boxShadow: '0 4px 12px rgba(0,0,0,0.7)',
            display: 'none'
        });
        document.body.appendChild(pickerTooltip);
    }

    document.body.style.cursor = 'crosshair';

    function onMouseMove(e: MouseEvent) {
        if (!isPickerActive) return;
        const target = e.target as HTMLElement;
        if (!target || target.closest('#zipper-panel') || target.closest('#zipper-fab') || target.closest('#zipper-gallery-ui') || target.closest('#zipper-float-download-btn') || target === pickerHighlightBox || target === pickerTooltip) {
            if (pickerHighlightBox) pickerHighlightBox.style.display = 'none';
            if (pickerTooltip) pickerTooltip.style.display = 'none';
            return;
        }

        const rect = target.getBoundingClientRect();
        const sel = getOptimalCssSelector(target);

        if (pickerHighlightBox) {
            pickerHighlightBox.style.display = 'block';
            pickerHighlightBox.style.top = `${rect.top + window.scrollY}px`;
            pickerHighlightBox.style.left = `${rect.left + window.scrollX}px`;
            pickerHighlightBox.style.width = `${rect.width}px`;
            pickerHighlightBox.style.height = `${rect.height}px`;
        }

        if (pickerTooltip) {
            pickerTooltip.style.display = 'block';
            pickerTooltip.textContent = sel || target.tagName.toLowerCase();
            const tipTop = Math.max(10, rect.top + window.scrollY - 26);
            const tipLeft = Math.max(10, rect.left + window.scrollX);
            pickerTooltip.style.top = `${tipTop}px`;
            pickerTooltip.style.left = `${tipLeft}px`;
        }
    }

    function onClick(e: MouseEvent) {
        if (!isPickerActive) return;
        const target = e.target as HTMLElement;
        if (!target || target.closest('#zipper-panel') || target.closest('#zipper-fab') || target.closest('#zipper-gallery-ui') || target.closest('#zipper-float-download-btn')) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const sel = getOptimalCssSelector(target);
        stopElementPicker();
        if (sel) {
            onSelect(sel);
        }
    }

    function onKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            stopElementPicker();
        }
    }

    (startElementPicker as any)._cleanup = () => {
        window.removeEventListener('mousemove', onMouseMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKeyDown, true);
        document.body.style.cursor = '';
        if (pickerHighlightBox) pickerHighlightBox.style.display = 'none';
        if (pickerTooltip) pickerTooltip.style.display = 'none';
        isPickerActive = false;
        const btn = document.getElementById('zipper-gallery-picker-btn');
        if (btn) btn.classList.remove('active');
    };

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);

    const btn = document.getElementById('zipper-gallery-picker-btn');
    if (btn) btn.classList.add('active');
}

export function stopElementPicker() {
    if ((startElementPicker as any)._cleanup) {
        (startElementPicker as any)._cleanup();
    }
}
