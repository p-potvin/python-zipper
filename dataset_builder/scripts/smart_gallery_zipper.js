(function () {
    'use strict';

    const pathname = window.location.pathname;
    const BATCH_SIZE = 50;

    // UI Elements Managed at Runtime
    let uiContainer = null;
    let progressBar = null;
    let statusText = null;
    let stopButton = null;

    // Global control flag for early termination
    let abortScraping = false;

    // Helper to bypass CORS using Tampermonkey's network layer
    function fetchAsArrayBuffer(url) {
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

    // Native browser blob downlod handling
    function saveBlobNative(blob, filename) {
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
    }

    // --- UI ENGINE ---
    function createUI() {
        if (uiContainer) return;

        // Container Context Panel
        uiContainer = document.createElement('div');
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
            pointerEvents: 'none',
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

        statusText = document.createElement('div');
        Object.assign(statusText.style, {
            color: '#dcd3ff',
            fontSize: '12px',
            fontWeight: '600',
            letterSpacing: '0.5px',
            textShadow: '0 2px 4px rgba(0,0,0,0.5)',
            flexGrow: '1'
        });
        statusText.innerHTML = '<span>Initializing Pipeline...</span><span>0%</span>';

        stopButton = document.createElement('button');
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
            pointerEvents: 'auto',
            boxShadow: '0 0 8px rgba(239, 68, 68, 0.5)',
            transition: 'background-color 0.2s',
            marginLeft: '15px'
        });

        stopButton.addEventListener('mouseenter', () => stopButton.style.backgroundColor = '#dc2626');
        stopButton.addEventListener('mouseleave', () => stopButton.style.backgroundColor = '#ef4444');
        stopButton.addEventListener('click', () => {
            abortScraping = true;
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

        progressBar = document.createElement('div');
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

    function updateUI(percentage, label) {
        if (!uiContainer) createUI();
        uiContainer.style.opacity = '1';
        progressBar.style.width = `${percentage}%`;
        statusText.innerHTML = `<span>${label}</span><span>${Math.round(percentage)}%</span>`;
    }

    function removeUIWithDelay() {
        if (!uiContainer) return;
        setTimeout(() => {
            uiContainer.style.opacity = '0';
            setTimeout(() => {
                if (uiContainer && uiContainer.parentNode) {
                    uiContainer.parentNode.removeChild(uiContainer);
                    uiContainer = null;
                }
            }, 400);
        }, 3000); // Retain visibility 3 seconds post-completion
    }

    // --- AUTOMATION AND COMPRESSION ENGINE ---
    function scrollToBottomSmart() {
        return new Promise((resolve) => {
            createUI();
            updateUI(0, "Scanning timeline and caching pages...");

            let lastMutationTime = Date.now();
            let checkInterval;

            const observer = new MutationObserver(() => {
                lastMutationTime = Date.now();
            });
            observer.observe(document.body, { childList: true, subtree: true });

            const scrollRunner = setInterval(() => {
                if (abortScraping) {
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

                if ((hitBottom && idleTime > 1500) || abortScraping) {
                    clearInterval(scrollRunner);
                    clearInterval(checkInterval);
                    observer.disconnect();
                    resolve();
                }
            }, 500);
        });
    }

    async function processAndZip(urls) {
        const totalFiles = urls.length;
        if (totalFiles === 0) {
            updateUI(0, "No files collected to pack.");
            removeUIWithDelay();
            return;
        }

        let zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
        let count = 0;
        let batchIndex = 1;
        const totalBatches = Math.ceil(totalFiles / BATCH_SIZE);

        for (let i = 0; i < totalFiles; i++) {
            const url = urls[i];
            if (!url) continue;

            const currentPct = (i / totalFiles) * 100;
            updateUI(currentPct, `Batch ${batchIndex}/${totalBatches} — Fetching item ${i + 1}/${totalFiles}`);

            try {
                const rawBuffer = await fetchAsArrayBuffer(url);
                let ext = url.split('.').pop().split(/[\?#]/)[0];
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4'].includes(ext.toLowerCase())) ext = 'jpg';

                const blob = new Blob([rawBuffer]);
                const filename = `${pathname.replace(/\//g, '_')}_file_${String(i + 1).padStart(4, '0')}.${ext}`;
                await zipWriter.add(filename, new zip.BlobReader(blob), { level: 0 });

                count++;
            } catch (err) {
                console.error(`Fetch execution failed on target file node: ${url}`, err);
            }

            // Fire sequential segment boundaries every 50 targets
            if (count > 0 && count % BATCH_SIZE === 0) {
                updateUI(currentPct, `Packing and downloading ZIP Batch ${batchIndex}...`);
                try {
                    const zipBlob = await zipWriter.close();
                    saveBlobNative(zipBlob, `${pathname.replace(/\//g, '_')}_batch_${batchIndex}.zip`);
                    zipWriter = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
                    batchIndex++;
                } catch (error) {
                    console.error('Failed processing isolated batch closure:', error);
                }
            }
        }

        // Catch leftovers
        if (count % BATCH_SIZE !== 0 || batchIndex === 1) {
            updateUI(95, "Wrapping up the remaining files...");
            try {
                const zipBlob = await zipWriter.close();
                saveBlobNative(zipBlob, `${pathname.replace(/\//g, '_')}_batch_${batchIndex}_final.zip`);
            } catch (error) {
                console.error('Final segment cleanup container execution failed:', error);
            }
        }

        updateUI(100, `Done! Downloaded ${count} files across ${batchIndex} archive partitions.`);
        removeUIWithDelay();
    }

    async function runAutomationPipeline() {
        await scrollToBottomSmart();

        const firstThumbnail = document.querySelector(".user_posts .b-photos__item");
        if (!firstThumbnail) {
            updateUI(0, "Error: Could not locate entry thumbnail node.");
            removeUIWithDelay();
            return;
        }

        updateUI(0, "Mounting target framework view bindings...");
        firstThumbnail.click();

        await new Promise(r => setTimeout(r, 600));

        try {
            const pswpContainer = document.querySelector("div.photoswipe");
            if (!pswpContainer) {
                updateUI(0, "Error: DOM Container missing parsing layers.");
                removeUIWithDelay();
                return;
            }

            // Unpack directly through verified unsafeWindow scope
            const vueInstance = pswpContainer.__vue__ || unsafeWindow.document.querySelector("div.photoswipe").__vue__;
            const dataSource = vueInstance ? (vueInstance.dataSource || (vueInstance._props && vueInstance._props.dataSource)) : null;

            if (!dataSource) {
                updateUI(0, "Error: Target Vue instance was unreachable.");
                removeUIWithDelay();
                return;
            }

            const extractedUrls = Array.from(dataSource).map(item => item.src).filter(Boolean);

            if (extractedUrls.length === 0) {
                updateUI(0, "Error: Extracted dataSource map contains zero entries.");
                removeUIWithDelay();
                return;
            }

            // Immediately destroy/hide the background modal view loop
            const closeBtn = document.querySelector('.pswp__button--close');
            if (closeBtn) closeBtn.click();

            // Run the main async background zip cycle
            await processAndZip(extractedUrls);

        } catch (e) {
            console.error("Fatal structure parse failure:", e);
            updateUI(0, "Fatal runtime structure error.");
            removeUIWithDelay();
        }
    }

    // Capturing execution window event mapping Matrix
    window.addEventListener('keydown', function (e) {
        if (e.altKey && e.code === 'KeyQ') {
            e.preventDefault();
            e.stopImmediatePropagation();
            runAutomationPipeline();
        }
    }, true);

})();