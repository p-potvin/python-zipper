import { Api } from '../api';
import { getZipperSetting, setZipperSetting, logToConsole, setLogToConsole } from '../utils/config';
import { globalState } from '../utils/state';
import { harvestLinks, runSmartGalleryZip } from '../utils/scraper';
import { showBrowserNotification } from '../main';
import { isCloudUrl, isMediaUrl, clientSideFallback, normalizeUrl, getElementUrl, fetchAsArrayBuffer, extractUrlsFromText } from '../utils/helpers';
import { resolveBestMediaUrl } from '../media/extractor';

import { createHeader, createTabs, createImagesSection, createLinksSection, createSmartGallerySection, createDashboardSection, createDropOverlay, isHighlightEnabled } from './panel_sections';
import { refreshJobs, setupJobsListClickHandler } from './panel_jobs';
import { createRefreshHarvestedLinks, addDroppedLinks } from './panel_harvest';
import { handleScrape, handleSend, handleDrop } from './panel_actions';
import { startElementPicker } from './gallery';

export function initUI(_pal: any) {
    // --- 1. Fab Button ---
    const fab = document.createElement('div');
    fab.id = 'zipper-fab';
    fab.innerHTML = `
        <svg viewBox="0 0 24 24">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
        <div id='zipper-status-dot'></div>
    `;
    document.body.appendChild(fab);
    const savedFabRight = GM_getValue('zipper-fab-right', '');
    const savedFabBottom = GM_getValue('zipper-fab-bottom', '');
    if (savedFabRight) fab.style.right = savedFabRight;
    if (savedFabBottom) fab.style.bottom = savedFabBottom;

    // --- 1.5 Floating Download Button ---
    const floatBtn = document.createElement('div');
    floatBtn.id = 'zipper-float-download-btn';
    floatBtn.title = 'Download this item';
    floatBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
        </svg>
    `;
    document.body.appendChild(floatBtn);

    // --- 2. Main Sliding Panel ---
    const panel = document.createElement('div');
    panel.id = 'zipper-panel';
    document.body.appendChild(panel);

    ['keydown', 'keyup', 'keypress'].forEach(evt => {
        panel.addEventListener(evt, e => e.stopPropagation(), true);
    });

    const savedPanelRight = GM_getValue('zipper-panel-right', '');
    const savedPanelBottom = GM_getValue('zipper-panel-bottom', '');
    if (savedPanelRight) panel.style.right = savedPanelRight;
    if (savedPanelBottom) panel.style.bottom = savedPanelBottom;

    panel.addEventListener('mousedown', (e) => { if (!isDragging) e.stopPropagation(); });
    panel.addEventListener('mouseup', (e) => { if (!isDragging) e.stopPropagation(); });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('paste', (e) => e.stopPropagation());

    // --- Header ---
    const header = createHeader();
    panel.appendChild(header);

    // --- Tabs ---
    const tabs = createTabs();
    panel.appendChild(tabs);

    // --- Main Content Area ---
    const content = document.createElement('div');
    content.className = 'zipper-content';
    panel.appendChild(content);

    // --- Console ---
    const consolePanel = document.createElement('div');
    consolePanel.id = 'zipper-console';
    consolePanel.style.display = 'none';
    panel.appendChild(consolePanel);

    setLogToConsole(function (message, type = '') {
        const line = document.createElement('div');
        line.className = `console-line ${type ? 'console-' + type : ''}`;
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.textContent = `[${time}] ${message}`;
        consolePanel.appendChild(line);
        consolePanel.scrollTop = consolePanel.scrollHeight;
    });

    function flashFab() {
        fab.classList.remove('zipper-fab-flash');
        void fab.offsetWidth;
        fab.classList.add('zipper-fab-flash');
        setTimeout(() => fab.classList.remove('zipper-fab-flash'), 1600);
    }

    function setFloatBtnStatus(status) {
        floatBtn.classList.remove('dl-success', 'dl-error');
        if (status) floatBtn.classList.add(status);
        if (status) setTimeout(() => floatBtn.classList.remove(status), 2000);
    }

    async function downloadSingleFile(url) {
        try {
            const filename = url.split('/').pop().split('?')[0] || 'download';
            logToConsole(`[Download] Starting download for: ${filename}`, 'info');

            const extAPI = (globalThis as any).browser ?? (globalThis as any).chrome;
            if (extAPI && extAPI.runtime) {
                const resp = await extAPI.runtime.sendMessage({
                    kind: 'downloads:start',
                    url: url,
                    filename: filename,
                    saveAs: true
                });
                if (resp && resp.ok) {
                    logToConsole(`[Extension] Download started via browser downloads API: ${filename}`, 'success');
                    setFloatBtnStatus('dl-success');
                    flashFab();
                    return;
                }
            }

            if (globalState.serverOnline) {
                const response = await Api.sendWithFallback("download", "POST", {
                    url: window.location.href,
                    links: [url],
                    batch_size: 1
                });
                if (response.ok) {
                    logToConsole(`[Server] Success: Sent single file to pipeline.`, 'success');
                    setFloatBtnStatus('dl-success');
                    flashFab();
                    return;
                }
            }
            const buffer = await fetchAsArrayBuffer(url);
            const blob = new Blob([buffer]);
            saveAs(blob, filename);
            logToConsole(`[Local] Downloaded: ${filename}`, 'success');
            setFloatBtnStatus('dl-success');
            flashFab();
        } catch (e) {
            logToConsole(`Failed to download file: ${e.message || e}`, 'error');
            setFloatBtnStatus('dl-error');
            const a = document.createElement('a');
            a.href = url;
            a.download = url.split('/').pop().split('?')[0] || '';
            a.target = '_blank';
            a.click();
        }
    }

    // --- Hover highlighting for float download button ---
    let activeHoveredElement = null;
    let activeHoveredUrl = null;

    window.addEventListener('mouseover', (e) => {
        const highlightEnabled = getZipperSetting('highlight-enabled', 'true') !== 'false';
        if (!highlightEnabled) {
            floatBtn.style.display = 'none';
            return;
        }
        const target = e.target.closest('.zipper-captured-highlight') || (
            (e.target.tagName && /^(img|video|audio|picture)$/i.test(e.target.tagName)) ? e.target : null
        );
        if (target && !target.closest('#zipper-panel') && !target.closest('#zipper-fab') && !target.closest('#zipper-float-download-btn')) {
            activeHoveredElement = target;
            let url = getElementUrl(target);
            if (!url && target.tagName.toLowerCase() === 'picture') {
                const imgOrSrc = target.querySelector('img') || target.querySelector('source');
                if (imgOrSrc) url = getElementUrl(imgOrSrc);
            }
            if (!url && (target.tagName.toLowerCase() === 'video' || target.tagName.toLowerCase() === 'audio')) {
                const srcEl = target.querySelector('source');
                if (srcEl) url = getElementUrl(srcEl);
            }
            if (url) {
                activeHoveredUrl = url;
                const rect = target.getBoundingClientRect();
                const buttonSize = 18;
                floatBtn.style.top = `${rect.top + window.scrollY + 4}px`;
                floatBtn.style.left = `${rect.right + window.scrollX - buttonSize - 4}px`;
                floatBtn.style.display = 'flex';
            }
        } else {
            if (e.target !== floatBtn && !floatBtn.closest('#zipper-float-download-btn')) {
                floatBtn.style.display = 'none';
                activeHoveredElement = null;
                activeHoveredUrl = null;
            }
        }
    });

    window.addEventListener('scroll', () => {
        if (activeHoveredElement && floatBtn.style.display === 'flex') {
            const rect = activeHoveredElement.getBoundingClientRect();
            const buttonSize = 18;
            floatBtn.style.top = `${rect.top + window.scrollY + 4}px`;
            floatBtn.style.left = `${rect.right + window.scrollX - buttonSize - 4}px`;
        }
    }, { passive: true });

    floatBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (activeHoveredUrl) {
            await downloadSingleFile(activeHoveredUrl);
        }
    });

    // --- Panel Sections ---
    const imagesSection = createImagesSection();
    content.appendChild(imagesSection);

    const linksSection = createLinksSection();
    content.appendChild(linksSection);

    const smartGallerySection = createSmartGallerySection();
    content.appendChild(smartGallerySection);

    const dashboardSection = createDashboardSection();
    content.appendChild(dashboardSection);

    // --- Smart Gallery Button & Element Picker ---
    const smartGalleryBtn = smartGallerySection.querySelector('#zipper-smart-gallery-btn');
    const gallerySelectorInput = smartGallerySection.querySelector('#zipper-gallery-selector');
    const galleryPickerBtn = smartGallerySection.querySelector('#zipper-gallery-picker-btn');

    if (galleryPickerBtn && gallerySelectorInput) {
        galleryPickerBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            startElementPicker((selector) => {
                gallerySelectorInput.value = selector;
                gallerySelectorInput.dispatchEvent(new Event('input', { bubbles: true }));
                gallerySelectorInput.dispatchEvent(new Event('change', { bubbles: true }));
                logToConsole(`[Gallery] Selected container: ${selector}`, 'success');
                gallerySelectorInput.style.borderColor = '#22c55e';
                gallerySelectorInput.style.boxShadow = '0 0 6px #22c55e';
                setTimeout(() => {
                    gallerySelectorInput.style.borderColor = '';
                    gallerySelectorInput.style.boxShadow = '';
                }, 1200);
            });
        };
    }

    smartGalleryBtn.onclick = async () => {
        smartGalleryBtn.disabled = true;
        try {
            await runSmartGalleryZip();
        } catch (err) {
            logToConsole(`[SmartZip] Error: ${err.message || err}`, 'error');
        }
        smartGalleryBtn.disabled = false;
    };

    // --- Jobs List ---
    const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');
    setupJobsListClickHandler(jobsListContainer);

    // --- Drag and Drop Overlay ---
    const dropOverlay = createDropOverlay();
    panel.appendChild(dropOverlay);

    // --- Harvested Links ---
    const mediaListContainer = imagesSection.querySelector('#zipper-media-list');
    const mediaCountSpan = imagesSection.querySelector('#zipper-media-count');
    const cloudListContainer = linksSection.querySelector('#zipper-cloud-list');
    const cloudCountSpan = linksSection.querySelector('#zipper-cloud-count');

    const { refreshHarvestedLinks, resetHarvestCache } = createRefreshHarvestedLinks(
        mediaListContainer, cloudListContainer, mediaCountSpan, cloudCountSpan
    );

    refreshHarvestedLinks();

    // --- Select All handlers ---
    const mediaSelectAll = imagesSection.querySelector('#zipper-media-select-all');
    mediaSelectAll.onchange = () => {
        const val = mediaSelectAll.checked;
        imagesSection.querySelectorAll('.zipper-media-checkbox').forEach(cb => cb.checked = val);
    };

    const cloudSelectAll = linksSection.querySelector('#zipper-cloud-select-all');
    cloudSelectAll.onchange = () => {
        const val = cloudSelectAll.checked;
        linksSection.querySelectorAll('.zipper-cloud-checkbox').forEach(cb => cb.checked = val);
    };

    // --- Selector input filter ---
    const selectorInput = imagesSection.querySelector('#zipper-selector');
    selectorInput.addEventListener('input', () => {
        const query = selectorInput.value.trim();
        const items = mediaListContainer.querySelectorAll('.zipper-link-item');
        if (!query) {
            items.forEach(item => item.style.display = '');
            return;
        }
        let selectorMatchedUrls = null;
        try {
            const matched = document.querySelectorAll(query);
            if (matched.length > 0) {
                selectorMatchedUrls = new Set();
                matched.forEach(el => {
                    const src = getElementUrl(el);
                    if (src) selectorMatchedUrls.add(src);
                });
            }
        } catch (_e) { }
        const lowerQuery = query.toLowerCase();
        items.forEach(item => {
            const cb = item.querySelector('.zipper-media-checkbox');
            const url = cb ? cb.getAttribute('data-url') : '';
            let visible = false;
            if (selectorMatchedUrls) {
                visible = selectorMatchedUrls.has(url);
            } else {
                visible = url.toLowerCase().includes(lowerQuery);
            }
            item.style.display = visible ? '' : 'none';
        });
    });

    // --- FAB click ---
    let fabDragged = false;
    fab.addEventListener('click', () => {
        if (fabDragged) {
            fabDragged = false;
            return;
        }
        const isVisible = panel.classList.toggle('visible');
        if (isVisible) {
            refreshHarvestedLinks();
        }
    });

    header.querySelector('#zipper-close-btn').onclick = () => {
        panel.classList.remove('visible');
    };

    header.querySelector('#zipper-abort-btn').onclick = async () => {
        if (globalState.serverOnline) {
            const response = await Api.send("abort", "POST");
            if (response.ok) {
                logToConsole("[Server] Cancellation command sent.", "info");
            } else {
                logToConsole("[Server] Failed to send abort command.", "error");
            }
        } else {
            logToConsole("[Server] Server offline. Cannot abort remote task.", "warning");
        }
    };

    // --- Toggle Highlights ---
    const toggleHighlightsBtn = header.querySelector('#zipper-toggle-highlights-btn');
    toggleHighlightsBtn.onclick = () => {
        const enabled = !toggleHighlightsBtn.classList.contains('active');
        toggleHighlightsBtn.classList.toggle('active', enabled);
        setZipperSetting('highlight-enabled', String(enabled));
        if (enabled) {
            resetHarvestCache();
            refreshHarvestedLinks();
        } else {
            document.querySelectorAll('.zipper-captured-highlight').forEach(el => {
                el.classList.remove('zipper-captured-highlight');
            });
        }
    };

    // --- Upscale toggle ---
    const savedUpscaleModel = getZipperSetting('upscale-model', '4xNomos8k_atd') || '4xNomos8k_atd';
    const savedUpscaleEnabled = getZipperSetting('upscale-enabled', 'false') === 'true';
    const upscaleBtnInit = header.querySelector('#zipper-upscale-toggle-btn');
    const upscaleModelSelectInit = header.querySelector('#zipper-upscale-model');

    if (upscaleModelSelectInit && upscaleBtnInit) {
        upscaleModelSelectInit.value = savedUpscaleEnabled ? savedUpscaleModel : 'off';
        if (savedUpscaleEnabled) {
            upscaleBtnInit.classList.add('active');
        }
        upscaleModelSelectInit.onchange = (e) => {
            const val = e.target.value;
            if (val === 'off') {
                upscaleBtnInit.classList.remove('active');
                setZipperSetting('upscale-enabled', 'false');
            } else {
                upscaleBtnInit.classList.add('active');
                setZipperSetting('upscale-enabled', 'true');
                setZipperSetting('upscale-model', val);
            }
        };
    }

    // --- Dashboard polling ---
    let dashboardPollInterval = null;
    let previousJobStatuses = {};

    dashboardSection.querySelector('#zipper-refresh-jobs').onclick = () => refreshJobs(dashboardSection, previousJobStatuses);

    // --- Tab switching ---
    const tabBtns = tabs.querySelectorAll('.zipper-tab-btn');
    tabBtns.forEach(btn => {
        btn.onclick = () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const targetTab = btn.getAttribute('data-tab');
            document.querySelectorAll('.zipper-panel-section').forEach(sec => {
                sec.style.display = sec.id === `section-${targetTab}` ? 'flex' : 'none';
            });
            if (targetTab === 'dashboard') {
                consolePanel.style.display = 'flex';
                refreshJobs(dashboardSection, previousJobStatuses);
                if (!dashboardPollInterval) {
                    dashboardPollInterval = setInterval(() => refreshJobs(dashboardSection, previousJobStatuses), 3000);
                }
            } else {
                if (dashboardPollInterval) {
                    clearInterval(dashboardPollInterval);
                    dashboardPollInterval = null;
                }
            }
        };
    });

    // --- DOM Observer + throttled scan ---
    let scanThrottleTimeout = null;
    let lastScanTime = 0;

    function scheduleScan() {
        const now = Date.now();
        const timeSinceLastScan = now - lastScanTime;
        if (scanThrottleTimeout) return;
        if (timeSinceLastScan >= 2000) {
            lastScanTime = now;
            refreshHarvestedLinks();
        } else {
            const delay = Math.max(500, 2000 - timeSinceLastScan);
            scanThrottleTimeout = setTimeout(() => {
                lastScanTime = Date.now();
                scanThrottleTimeout = null;
                refreshHarvestedLinks();
            }, delay);
        }
    }

    const domObserver = new MutationObserver((mutations) => {
        let externalMutation = false;
        for (let mutation of mutations) {
            let target = mutation.target;
            if (!panel.contains(target) && (!fab || !fab.contains(target))) {
                externalMutation = true;
                break;
            }
        }
        if (externalMutation) {
            scheduleScan();
        }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // --- Drag and Drop for panel/FAB ---
    let isDragging = false;
    let dragTarget = null;
    let startX, startY, startRight, startBottom;

    function stopDrag() {
        if (isDragging) {
            const _target = dragTarget;
            const _panelRight = panel.style.right || '20px';
            const _panelBottom = panel.style.bottom || '80px';
            const _fabRight = fab.style.right || '20px';
            const _fabBottom = fab.style.bottom || '20px';
            isDragging = false;
            dragTarget = null;
            document.body.style.userSelect = '';
            try {
                if (_target === 'panel') {
                    GM_setValue('zipper-panel-right', _panelRight);
                    GM_setValue('zipper-panel-bottom', _panelBottom);
                } else if (_target === 'fab') {
                    GM_setValue('zipper-fab-right', _fabRight);
                    GM_setValue('zipper-fab-bottom', _fabBottom);
                }
            } catch (e) {
                console.warn('[Zipper] Could not persist drag position:', e);
            }
        }
    }

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label') || e.target.closest('.zipper-switch') || e.target.closest('.zipper-slider')) {
            return;
        }
        e.preventDefault();
        isDragging = true;
        dragTarget = 'panel';
        startX = e.clientX;
        startY = e.clientY;
        startRight = parseInt(window.getComputedStyle(panel).right) || 20;
        startBottom = parseInt(window.getComputedStyle(panel).bottom) || 80;
        document.body.style.userSelect = 'none';
    });

    fab.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDragging = true;
        dragTarget = 'fab';
        fabDragged = false;
        startX = e.clientX;
        startY = e.clientY;
        startRight = parseInt(window.getComputedStyle(fab).right) || 20;
        startBottom = parseInt(window.getComputedStyle(fab).bottom) || 20;
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (moveEvent) => {
        if (!isDragging) return;
        let dx = moveEvent.clientX - startX;
        let dy = moveEvent.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
            fabDragged = true;
        }
        const margin = 10;
        if (dragTarget === 'panel') {
            let right = startRight - dx;
            let bottom = startBottom - dy;
            const panelWidth = panel.offsetWidth || 350;
            const panelHeight = panel.offsetHeight || 520;
            if (right < margin) right = margin;
            if (right > window.innerWidth - panelWidth - margin) right = window.innerWidth - panelWidth - margin;
            if (bottom < margin) bottom = margin;
            if (bottom > window.innerHeight - panelHeight - margin) bottom = window.innerHeight - panelHeight - margin;
            panel.style.right = `${right}px`;
            panel.style.bottom = `${bottom}px`;
        } else if (dragTarget === 'fab') {
            let right = startRight - dx;
            let bottom = startBottom - dy;
            const fabSize = fab.offsetWidth || 48;
            if (right < margin) right = margin;
            if (right > window.innerWidth - fabSize - margin) right = window.innerWidth - fabSize - margin;
            if (bottom < margin) bottom = margin;
            if (bottom > window.innerHeight - fabSize - margin) bottom = window.innerHeight - fabSize - margin;
            fab.style.right = `${right}px`;
            fab.style.bottom = `${bottom}px`;
        }
    });

    document.addEventListener('mouseup', stopDrag, true);
    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('blur', stopDrag);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isDragging) {
            stopDrag();
        }
    }, true);

    // --- Status polling ---
    const statusDot = fab.querySelector('#zipper-status-dot');
    let upscalerAvailable = false;

    async function updateStatus() {
        const online = await Api.checkServerStatus();
        globalState.serverOnline = online;
        const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
        if (online) {
            statusDot.classList.add('online');
            const onlineTitle = `Server Online (${Api.origin})`;
            if (statusDot.title !== onlineTitle) {
                statusDot.title = onlineTitle;
                logToConsole(`Connected to download server: ${Api.origin}`, 'success');
            }
            const upscalerRes = await Api.sendWithFallback("upscalerStatus", "GET", null, ["local", "localhost"]);
            if (upscalerRes.ok) {
                let upscalerData;
                try { upscalerData = upscalerRes.json(); } catch (e) { upscalerData = {}; }
                upscalerAvailable = upscalerData.available;
                if (upscaleBtn) {
                    if (upscalerAvailable) {
                        upscaleBtn.removeAttribute('disabled');
                        const savedEnabled = getZipperSetting('upscale-enabled', 'false') === 'true';
                        upscaleBtn.classList.toggle('active', savedEnabled);
                        upscaleBtn.title = `Toggle Image Upscaling (4x AI — ${(upscalerData.models || []).join(', ')})`;
                        const sel = document.getElementById('zipper-upscale-model');
                        if (sel) sel.removeAttribute('disabled');
                    } else {
                        upscaleBtn.classList.remove('active');
                        upscaleBtn.setAttribute('disabled', 'true');
                        upscaleBtn.title = `Upscaler unavailable: ${upscalerData.error || 'No models found'}`;
                        const sel = document.getElementById('zipper-upscale-model');
                        if (sel) sel.setAttribute('disabled', 'true');
                    }
                }
            }
        } else {
            statusDot.classList.remove('online');
            if (statusDot.title !== 'Server Offline') {
                statusDot.title = 'Server Offline';
                logToConsole('python-zipper server offline on port 5171. Using browser-side fallback.', 'error');
            }
            upscalerAvailable = false;
            if (upscaleBtn) {
                upscaleBtn.classList.remove('active');
                upscaleBtn.setAttribute('disabled', 'true');
                upscaleBtn.title = 'Upscaler unavailable (server offline)';
                const sel = document.getElementById('zipper-upscale-model');
                if (sel) sel.setAttribute('disabled', 'true');
            }
        }
    }
    updateStatus();
    setInterval(updateStatus, 5000);

    // --- Drag and Drop link handling ---
    window.addEventListener('dragenter', () => {
        if (panel.classList.contains('visible')) {
            dropOverlay.style.display = 'flex';
        }
    });

    panel.addEventListener('dragleave', (e) => {
        const rect = panel.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            dropOverlay.style.display = 'none';
        }
    });

    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('dragend', () => { dropOverlay.style.display = 'none'; });
    window.addEventListener('drop', () => { dropOverlay.style.display = 'none'; });
    window.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
            dropOverlay.style.display = 'none';
        }
    });
    dropOverlay.addEventListener('click', (e) => {
        e.stopPropagation();
        dropOverlay.style.display = 'none';
    });

    panel.addEventListener('drop', async (e) => {
        await handleDrop(e, (links) => addDroppedLinks(links, imagesSection, linksSection, mediaListContainer, cloudListContainer, mediaCountSpan, cloudCountSpan), tabBtns);
        dropOverlay.style.display = 'none';
    });

    // --- Scrape button ---
    const scrapeBtn = imagesSection.querySelector('#zipper-scrape-btn');
    scrapeBtn.onclick = () => handleScrape(imagesSection, selectorInput, flashFab);

    // --- Send button ---
    const sendBtn = linksSection.querySelector('#zipper-send-btn');
    const linksInput = linksSection.querySelector('#zipper-links-input');
    sendBtn.onclick = () => handleSend(linksSection, linksInput);

    // --- Keyboard shortcut ---
    window.addEventListener("keydown", (e) => {
        const activeElement = document.activeElement;
        const isTyping = activeElement && (
            activeElement.tagName === 'INPUT' ||
            activeElement.tagName === 'TEXTAREA' ||
            activeElement.isContentEditable
        );
        if (isTyping) return;
        if (e.shiftKey && (e.key === "Q" || e.key === "q")) {
            fab.click();
        }
    }, true);
}