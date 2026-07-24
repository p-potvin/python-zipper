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
