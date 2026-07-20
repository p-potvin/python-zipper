import { Api } from '../api';
import { getZipperSetting, setZipperSetting, logToConsole, setLogToConsole } from '../utils/config';
import { globalState } from '../utils/state';
import { harvestLinks, runSmartGalleryZip } from '../utils/scraper';
import { showBrowserNotification } from '../main';
import { isCloudUrl, isMediaUrl, clientSideFallback, normalizeUrl } from '../utils/helpers';

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
        // Restore saved FAB position (after DOM insertion so CSS is resolved first)
        const savedFabRight = GM_getValue('zipper-fab-right', '');
        const savedFabBottom = GM_getValue('zipper-fab-bottom', '');
        if (savedFabRight) fab.style.right = savedFabRight;
        if (savedFabBottom) fab.style.bottom = savedFabBottom;

        // --- 1.5 Floating Download Button next to highlighted items ---
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

        // Restore saved panel position (after DOM insertion so CSS is resolved first)
        const savedPanelRight = GM_getValue('zipper-panel-right', '');
        const savedPanelBottom = GM_getValue('zipper-panel-bottom', '');
        if (savedPanelRight) panel.style.right = savedPanelRight;
        if (savedPanelBottom) panel.style.bottom = savedPanelBottom;

        panel.addEventListener('mousedown', (e) => {
            if (!isDragging) e.stopPropagation();
        });
        panel.addEventListener('mouseup', (e) => {
            if (!isDragging) e.stopPropagation();
        });
        panel.addEventListener('click', (e) => e.stopPropagation());
        panel.addEventListener('paste', (e) => e.stopPropagation());

        // --- Header ---
        // --- Header ---
        const header = document.createElement('div');
        header.id = 'zipper-header';
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <h3 style="font-size: 13px; margin-right: 4px;">VaultWares Zipper</h3>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <button id="zipper-toggle-highlights-btn" class="zipper-icon-toggle ${isHighlightEnabled() ? 'active' : ''}" title="Toggle DOM Highlights">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                        </svg>
                    </button>
                    <div style="position: relative; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; vertical-align: middle;">
                        <button id="zipper-upscale-toggle-btn" class="zipper-icon-toggle" title="Toggle Image Upscaling (4x AI)" disabled style="margin:0;">
                            <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                                <path d="M8 1a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1zm3.293 2.293a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 1 1-1.414 1.414L11.293 4.707a1 1 0 0 1 0-1.414zM14 8a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1zm-3.293 4.293a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 1 1-1.414 1.414L11.293 12.293a1 1 0 0 1 0-1.414zM8 14a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm-4.707-1.707a1 1 0 0 1 0 1.414l-1.414 1.414a1 1 0 1 1-1.414-1.414l1.414-1.414a1 1 0 0 1 1.414 0zM1 8a1 1 0 0 1 1-1v2a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm2.293-4.707a1 1 0 0 1 0 1.414L1.879 6.121A1 1 0 1 1 .464 4.707l1.414-1.414a1 1 0 0 1 1.414 0zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>
                            </svg>
                        </button>
                        <select id="zipper-upscale-model" style="position: absolute; top:0; left:0; width:100%; height:100%; opacity:0; cursor:pointer;" disabled>
                            <option value="off">Off</option>
                            <option value="4xNomos8k_atd">Nomos8k</option>
                            <option value="pillow-lanczos">Pillow 4x</option>
                        </select>
                    </div>
                </div>
            </div>
            <div style="display: flex; align-items: center;">
                <button id="zipper-abort-btn">ABORT</button>
                <button id="zipper-close-btn">&times;</button>
            </div>
        `;
        panel.appendChild(header);

        // --- Tabs ---
        const tabs = document.createElement('div');
        tabs.className = 'zipper-tabs';
        tabs.innerHTML = `
            <button class="zipper-tab-btn active" data-tab="images">Media</button>
            <button class="zipper-tab-btn" data-tab="links">Cloud</button>
            <button class="zipper-tab-btn" data-tab="smart-gallery">Smart</button>
            <button class="zipper-tab-btn" data-tab="dashboard">Jobs</button>
        `;
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
                logToConsole(`[Download] Starting download for: ${url.split('/').pop()}`, 'info');
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
                const filename = url.split('/').pop().split('?')[0] || 'download';
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

        let activeHoveredElement = null;
        let activeHoveredUrl = null;

        window.addEventListener('mouseover', (e) => {
            const highlightEnabled = getZipperSetting('highlight-enabled', 'true') !== 'false';
            if (!highlightEnabled) {
                floatBtn.style.display = 'none';
                return;
            }

            const target = e.target.closest('.zipper-captured-highlight');
            if (target) {
                activeHoveredElement = target;
                let url = getElementUrl(target);
                if (!url && target.tagName.toLowerCase() === 'video') {
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

        // --- Images Section ---
        const imagesSection = document.createElement('div');
        imagesSection.className = 'zipper-panel-section active';
        imagesSection.id = 'section-images';
        imagesSection.innerHTML = `
            <div class="zipper-select-all-group" style="display: flex; justify-content: space-between; align-items: center;">
                <label><input type="checkbox" id="zipper-media-select-all" checked> Media Links (<span id="zipper-media-count">0</span>)</label>
                <input type="text" id="zipper-selector" class="zipper-input" placeholder="CSS Selector..." style="width: 120px; box-sizing: border-box; height: 20px; padding: 0 4px; font-size: 10px;">
            </div>
            <div id="zipper-media-list" class="zipper-link-list"></div>
            <button id="zipper-scrape-btn" class="zipper-btn" style="margin-top: 4px; height: 28px; padding: 4px;">
                <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                    <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                </svg>
                <span>Send Selected Media</span>
            </button>
        `;
        content.appendChild(imagesSection);

        // --- Links/Cloud Section ---
        const linksSection = document.createElement('div');
        linksSection.className = 'zipper-panel-section';
        linksSection.id = 'section-links';
        linksSection.style.display = 'none';
        linksSection.innerHTML = `
            <div class="zipper-select-all-group">
                <label><input type="checkbox" id="zipper-cloud-select-all" checked> Cloud Links (<span id="zipper-cloud-count">0</span>)</label>
            </div>
            <div id="zipper-cloud-list" class="zipper-link-list"></div>
            <div class="zipper-input-group">
                <label>Or Paste Manual Links</label>
                <textarea id="zipper-links-input" class="zipper-input zipper-textarea" placeholder="Paste links, one per line..."></textarea>
            </div>
            <button id="zipper-send-btn" class="zipper-btn">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855H.766l-.452.18a.5.5 0 0 0-.082.887l.41.26.001.002 4.995 3.178 3.178 4.995.002.002.26.41a.5.5 0 0 0 .886-.083l6-15Zm-1.833 1.89L6.637 10.07l-.215-.338a.5.5 0 0 0-.154-.154l-.338-.215 7.494-7.494 1.178-.471-.47 1.178Z"/>
                </svg>
                <span>Send Selected to Cloud</span>
            </button>
        `;
        content.appendChild(linksSection);

        // --- Smart Gallery Section ---
        const smartGallerySection = document.createElement('div');
        smartGallerySection.className = 'zipper-panel-section';
        smartGallerySection.id = 'section-smart-gallery';
        smartGallerySection.style.display = 'none';
        smartGallerySection.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 4px;">
                <div class="zipper-input-group" style="flex: 1; margin: 0; min-width: 0;">
                    <label style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Gallery Container Selector</label>
                    <input type="text" id="zipper-gallery-selector" class="zipper-input" placeholder="e.g. .user_posts" style="width: 100%; box-sizing: border-box; height: 26px; padding: 2px 6px; font-size: 11px;">
                </div>
                <button id="zipper-smart-gallery-btn" class="zipper-btn" style="height: 26px; padding: 2px 8px; font-size: 11px; flex-shrink: 0; background: var(--zipper-secondary);">
                    Smart Gallery Zip
                </button>
            </div>
        `;
        content.appendChild(smartGallerySection);

        // --- Dashboard Section ---
        const dashboardSection = document.createElement('div');
        dashboardSection.className = 'zipper-panel-section';
        dashboardSection.id = 'section-dashboard';
        dashboardSection.style.display = 'none';
        dashboardSection.innerHTML = `
            <div class="zipper-select-all-group">
                <label>Active Pipeline Jobs</label>
                <button id="zipper-refresh-jobs" class="zipper-btn" style="padding: 2px 6px; font-size: 10px;">Refresh</button>
            </div>
            <div id="zipper-jobs-list" class="zipper-link-list" style="max-height: 250px; flex: 1;">
                <div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>
            </div>
        `;
        content.appendChild(dashboardSection);

        const smartGalleryBtn = smartGallerySection.querySelector('#zipper-smart-gallery-btn');
        smartGalleryBtn.onclick = async () => {
            smartGalleryBtn.disabled = true;
            try {
                await runSmartGalleryZip();
            } catch (err) {
                logToConsole(`[SmartZip] Error: ${err.message || err}`, 'error');
            }
            smartGalleryBtn.disabled = false;
        };

        const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');
        jobsListContainer.onclick = async (e) => {
            const openFileBtn = e.target.closest('.zipper-open-btn');
            const openFolderBtn = e.target.closest('.zipper-open-folder-btn');
            const viewLink = e.target.closest('.zipper-view-link');

            if (viewLink) {
                e.preventDefault();
                const filename = viewLink.getAttribute('data-file');
                const jobOrigin = viewLink.getAttribute('data-origin') || Api.origin;
                viewLink.style.opacity = '0.5';
                const response = await Api.send("openDownloaded", "POST", { filename });
                viewLink.style.opacity = '1';
                let success = false;
                let filePath = null;
                if (response.ok) {
                    try {
                        const data = await response.json();
                        if (data.status === 'opened file') success = true;
                        if (data.path) filePath = data.path;
                    } catch (_) { }
                }
                if (!success) {
                    if (filePath) {
                        window.open('file:///' + filePath.replace(/\\/g, '/'), '_blank');
                    } else {
                        window.open(`${jobOrigin}/downloaded/${encodeURIComponent(filename)}`, '_blank');
                    }
                }
            } else if (openFileBtn) {
                e.preventDefault();
                const filename = openFileBtn.getAttribute('data-file');
                openFileBtn.style.opacity = '0.5';
                const response = await Api.send("openDownloaded", "POST", { filename });
                openFileBtn.style.opacity = '1';
                let success = false;
                let filePath = null;
                if (response.ok) {
                    try {
                        const data = await response.json();
                        if (data.status === 'opened file') success = true;
                        if (data.path) filePath = data.path;
                    } catch (_) { }
                }
                if (!success && filePath) {
                    window.open('file:///' + filePath.replace(/\\/g, '/'), '_blank');
                }
            } else if (openFolderBtn) {
                e.preventDefault();
                openFolderBtn.style.opacity = '0.5';
                const response = await Api.send("openDownloaded", "POST", { folder: true });
                openFolderBtn.style.opacity = '1';
                let success = false;
                let folderPath = null;
                if (response.ok) {
                    try {
                        const data = await response.json();
                        if (data.status === 'opened folder') success = true;
                        if (data.path) folderPath = data.path;
                    } catch (_) { }
                }
                if (!success && folderPath) {
                    window.open('file:///' + folderPath.replace(/\\/g, '/'), '_blank');
                }
            }
        };

        // --- Drag and Drop Overlay ---
        const dropOverlay = document.createElement('div');
        dropOverlay.id = 'zipper-drop-overlay';
        dropOverlay.innerHTML = `
            <svg viewBox="0 0 24 24">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
            <div style="font-weight: bold; font-size: 14px;">Drop links to queue</div>
        `;
        panel.appendChild(dropOverlay);

        // --- Populate harvested links ---
        const mediaListContainer = imagesSection.querySelector('#zipper-media-list');
        const mediaCountSpan = imagesSection.querySelector('#zipper-media-count');
        const cloudListContainer = linksSection.querySelector('#zipper-cloud-list');
        const cloudCountSpan = linksSection.querySelector('#zipper-cloud-count');

        let lastHarvestedMediaSerialized = "";
        let lastHarvestedCloudSerialized = "";

        function refreshHarvestedLinks() {
            const harvested = harvestLinks();
            mediaCountSpan.textContent = harvested.mediaLinks.length;
            cloudCountSpan.textContent = harvested.cloudLinks.length;

            const mediaUrls = harvested.mediaLinks.map(item => item.url);
            const currentMediaSerialized = JSON.stringify(mediaUrls);
            const currentCloudSerialized = JSON.stringify(harvested.cloudLinks);

            if (currentMediaSerialized !== lastHarvestedMediaSerialized) {
                lastHarvestedMediaSerialized = currentMediaSerialized;
                if (harvested.mediaLinks.length === 0) {
                    mediaListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No harvested media links found.</div>';
                } else {
                    const checkedUrls = new Set(
                        Array.from(mediaListContainer.querySelectorAll('.zipper-media-checkbox:checked'))
                            .map(cb => cb.getAttribute('data-url'))
                    );
                    const renderedUrls = new Set(
                        Array.from(mediaListContainer.querySelectorAll('.zipper-media-checkbox'))
                            .map(cb => cb.getAttribute('data-url'))
                    );

                    mediaListContainer.innerHTML = harvested.mediaLinks.map((item, idx) => {
                        const url = item.url;
                        const isChecked = renderedUrls.has(url) ? checkedUrls.has(url) : item.isInteresting;
                        return `
                            <div class="zipper-link-item">
                                <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" ${isChecked ? 'checked' : ''}>
                                <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                            </div>
                        `;
                    }).join('');
                }
            }

            if (currentCloudSerialized !== lastHarvestedCloudSerialized) {
                lastHarvestedCloudSerialized = currentCloudSerialized;
                if (harvested.cloudLinks.length === 0) {
                    cloudListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No harvested cloud links found.</div>';
                } else {
                    const checkedUrls = new Set(
                        Array.from(cloudListContainer.querySelectorAll('.zipper-cloud-checkbox:checked'))
                            .map(cb => cb.getAttribute('data-url'))
                    );
                    const renderedUrls = new Set(
                        Array.from(cloudListContainer.querySelectorAll('.zipper-cloud-checkbox'))
                            .map(cb => cb.getAttribute('data-url'))
                    );

                    cloudListContainer.innerHTML = harvested.cloudLinks.map((url, idx) => {
                        const isChecked = renderedUrls.has(url) ? checkedUrls.has(url) : true;
                        let display = url.split('/').pop() || url;
                        try {
                            const parsed = new URL(url.startsWith('http') ? url : 'http:' + url);
                            const domain = parsed.hostname.replace('www.', '');
                            display = `<strong>[${domain}]</strong> ${display}`;
                        } catch (e) { }
                        return `
                            <div class="zipper-link-item">
                                <input type="checkbox" class="zipper-cloud-checkbox" id="cloud-cb-${idx}" data-url="${url}" ${isChecked ? 'checked' : ''}>
                                <span class="zipper-link-url" title="${url}">${display}</span>
                            </div>
                        `;
                    }).join('');
                }
            }
        }

        refreshHarvestedLinks();

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

        function addDroppedLinks(links) {
            links.forEach(url => {
                url = normalizeUrl(url, window.location.href);
                if (!url) return;
                const isCloud = isCloudUrl(url);
                const isMedia = isMediaUrl(url);

                if (isCloud) {
                    const exists = Array.from(linksSection.querySelectorAll('.zipper-cloud-checkbox')).some(cb => cb.getAttribute('data-url') === url);
                    if (!exists) {
                        const idx = linksSection.querySelectorAll('.zipper-cloud-checkbox').length;
                        let display = url.split('/').pop() || url;
                        try {
                            const parsed = new URL(url.startsWith('http') ? url : 'http:' + url);
                            const domain = parsed.hostname.replace('www.', '');
                            display = `<strong>[${domain}]</strong> ${display}`;
                        } catch (e) { }
                        const itemHtml = `
                            <div class="zipper-link-item">
                                <input type="checkbox" class="zipper-cloud-checkbox" id="cloud-cb-${idx}" data-url="${url}" checked>
                                <span class="zipper-link-url" title="${url}">${display}</span>
                            </div>
                        `;
                        if (cloudListContainer.querySelector('.zipper-text-muted') || cloudListContainer.textContent.includes('No harvested')) {
                            cloudListContainer.innerHTML = '';
                        }
                        cloudListContainer.insertAdjacentHTML('beforeend', itemHtml);
                        cloudCountSpan.textContent = parseInt(cloudCountSpan.textContent) + 1;
                    }
                } else if (isMedia) {
                    const exists = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox')).some(cb => cb.getAttribute('data-url') === url);
                    if (!exists) {
                        const idx = imagesSection.querySelectorAll('.zipper-media-checkbox').length;
                        const itemHtml = `
                            <div class="zipper-link-item">
                                <input type="checkbox" class="zipper-media-checkbox" id="media-cb-${idx}" data-url="${url}" checked>
                                <span class="zipper-link-url" title="${url}">${url.split('/').pop() || url}</span>
                            </div>
                        `;
                        if (mediaListContainer.querySelector('.zipper-text-muted') || mediaListContainer.textContent.includes('No harvested')) {
                            mediaListContainer.innerHTML = '';
                        }
                        mediaListContainer.insertAdjacentHTML('beforeend', itemHtml);
                        mediaCountSpan.textContent = parseInt(mediaCountSpan.textContent) + 1;
                    }
                }
            });
        }

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

        const toggleHighlightsBtn = header.querySelector('#zipper-toggle-highlights-btn');
        toggleHighlightsBtn.onclick = () => {
            const enabled = !toggleHighlightsBtn.classList.contains('active');
            toggleHighlightsBtn.classList.toggle('active', enabled);
            setZipperSetting('highlight-enabled', String(enabled));
            if (enabled) {
                lastHarvestedMediaSerialized = "";
                lastHarvestedCloudSerialized = "";
                refreshHarvestedLinks();
            } else {
                document.querySelectorAll('.zipper-captured-highlight').forEach(el => {
                    el.classList.remove('zipper-captured-highlight');
                });
            }
        };

        const savedUpscaleModel = getZipperSetting('upscale-model', '4xNomos8k_atd') || '4xNomos8k_atd';
        const savedUpscaleEnabled = getZipperSetting('upscale-enabled', 'false') === 'true';

        // Set up upscale button handler synchronously (no timeout needed)
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

        let dashboardPollInterval = null;

        async function fetchJobsFromEndpoints() {
            const mergedJobs = {};
            let jobOrigin = Api.origin;
            for (const endpointKey of ["primary", "local", "localhost"]) {
                const response = await Api.send("jobs", "GET", null, endpointKey);
                if (!response.ok) continue;
                let data = {};
                try { data = await response.json(); } catch (_e) { data = {}; }
                if (data.jobs && Object.keys(data.jobs).length > 0) {
                    Object.assign(mergedJobs, data.jobs);
                    jobOrigin = response.origin || jobOrigin;
                }
            }
            return { jobs: mergedJobs, origin: jobOrigin };
        }

        let previousJobStatuses = {};

        async function refreshJobs() {
            if (!globalState.serverOnline) return;
            const { jobs, origin: jobOrigin } = await fetchJobsFromEndpoints();
            const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');

            // Notification tracking
            for (const key in jobs) {
                const job = jobs[key];
                const prevStatus = previousJobStatuses[key];
                if (prevStatus && prevStatus !== 'completed' && job.status === 'completed') {
                    showBrowserNotification("Job Complete", `Job ${key.substring(0, 12)} completed successfully!`);
                }
                previousJobStatuses[key] = job.status;
            }

            const jobKeys = Object.keys(jobs);
            if (jobKeys.length === 0) {
                jobsListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>';
            } else {
                jobKeys.sort((a, b) => jobs[b].created_at - jobs[a].created_at);
                jobsListContainer.innerHTML = jobKeys.map(key => {
                    const job = jobs[key];
                    const statusColor = job.status === 'running' ? '#60a5fa' :
                        job.status === 'completed' ? '#22c55e' :
                            job.status === 'aborted' ? '#f59e0b' : '#ef4444';

                    const percent = job.total_links > 0 ? Math.min(100, Math.round((job.processed_links / job.total_links) * 100)) : 0;

                    return `
                        <div class="zipper-job-item" style="border: 1px solid rgba(255,255,255,0.05); padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.15); margin-bottom: 6px;">
                            <div style="display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 4px;">
                                <span class="zipper-job-id" style="font-family: monospace; color: var(--zipper-primary);" title="${key}">${key.substring(0, 15)}...</span>
                                <span style="color: ${statusColor}; font-weight: bold; font-size: 10px; text-transform: uppercase;">${job.status}</span>
                            </div>
                            <div style="font-size: 10px; color: var(--zipper-text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap; margin-bottom: 6px;" title="${job.url}">
                                Source: ${job.url}
                            </div>
                            ${job.upscale_enabled ? `<div style="font-size: 9px; color: var(--zipper-accent); margin-bottom: 4px;"><strong>Upscaling:</strong> ${job.upscale_model}</div>` : ''}
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
                                    <div style="width: ${percent}%; height: 100%; background: ${statusColor}; transition: width 0.3s;"></div>
                                </div>
                                <span style="font-size: 10px; font-weight: bold; min-width: 24px; text-align: right;">${percent}%</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; font-size: 9px; color: var(--zipper-text-muted); margin-top: 4px; align-items: center;">
                                <span>Processed: ${job.processed_links}/${job.total_links}</span>
                                <span>Media zipped: ${job.images_count}</span>
                            </div>
                            ${job.status === 'completed' ? `
                                <div style="display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center;">
                                    ${job.archives && job.archives.length > 0 ? job.archives.map(arch => `
                                        <div style="display: inline-flex; border: 1px solid var(--zipper-border); border-radius: 4px; overflow: hidden; background: rgba(0,0,0,0.2);">
                                            <a href="#" data-file="${arch}" data-origin="${jobOrigin}" class="zipper-view-link zipper-btn" style="text-decoration: none; padding: 2px 6px; font-size: 9px; height: 18px; line-height: 18px; font-weight: normal; background: var(--zipper-primary); color: #fff; box-shadow: none; border: none; border-radius: 0;">
                                                View ${arch.split('_').pop() || 'File'}
                                            </a>
                                            <button class="zipper-open-btn zipper-btn" data-file="${arch}" title="Locate in Desktop Explorer" style="padding: 2px 4px; font-size: 9px; height: 18px; font-weight: normal; background: rgba(255,255,255,0.08); border: none; border-left: 1px solid var(--zipper-border); border-radius: 0; box-shadow: none;">
                                                Ã°Å¸â€œâ€š
                                            </button>
                                        </div>
                                    `).join('') : ''}
                                    <button class="zipper-open-folder-btn zipper-btn" style="padding: 2px 6px; font-size: 9px; height: 20px; font-weight: normal; background: rgba(255,255,255,0.08); border: 1px solid var(--zipper-border); box-shadow: none;">
                                        Open Folder
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('');
            }
        }

        dashboardSection.querySelector('#zipper-refresh-jobs').onclick = refreshJobs;

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
                    refreshJobs();
                    if (!dashboardPollInterval) {
                        dashboardPollInterval = setInterval(refreshJobs, 3000);
                    }
                } else {
                    if (dashboardPollInterval) {
                        clearInterval(dashboardPollInterval);
                        dashboardPollInterval = null;
                    }
                }
            };
        });

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

        let isDragging = false;
        let dragTarget = null;
        let startX, startY, startRight, startBottom;

        function stopDrag() {
            if (isDragging) {
                // Capture before clearing so the try/catch below can reference it
                const _target = dragTarget;
                const _panelRight = panel.style.right || '20px';
                const _panelBottom = panel.style.bottom || '80px';
                const _fabRight = fab.style.right || '20px';
                const _fabBottom = fab.style.bottom || '20px';

                // ALWAYS reset drag state first Ã¢â‚¬â€ GM_setValue must never block this
                isDragging = false;
                dragTarget = null;
                document.body.style.userSelect = '';

                // Persist positions (non-critical, wrapped in case of GM API failure)
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
                            // Restore saved active state now that we know it's available
                            const savedEnabled = getZipperSetting('upscale-enabled', 'false') === 'true';
                            upscaleBtn.classList.toggle('active', savedEnabled);
                            upscaleBtn.title = `Toggle Image Upscaling (4x AI Ã¢â‚¬â€ ${(upscalerData.models || []).join(', ')})`;
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

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        window.addEventListener('dragend', () => {
            dropOverlay.style.display = 'none';
        });

        window.addEventListener('drop', () => {
            dropOverlay.style.display = 'none';
        });

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
            e.preventDefault();
            dropOverlay.style.display = 'none';

            let links = [];

            if (e.dataTransfer.files.length > 0) {
                logToConsole(`[Drop] Processing ${e.dataTransfer.files.length} dropped file(s)...`);
                for (let file of e.dataTransfer.files) {
                    if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.json') || file.name.endsWith('.html')) {
                        try {
                            const text = await file.text();
                            links = links.concat(extractUrlsFromText(text, window.location.href));
                        } catch (err) {
                            logToConsole(`Failed to read file: ${err.message}`, 'error');
                        }
                    }
                }
            }

            const html = e.dataTransfer.getData('text/html');
            const text = e.dataTransfer.getData('text/plain');

            if (html) {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                doc.querySelectorAll('a').forEach(a => { if (a.href) links.push(normalizeUrl(a.href, window.location.href)); });
                doc.querySelectorAll('img').forEach(img => { if (img.src) links.push(normalizeUrl(img.src, window.location.href)); });
            }

            if (text) {
                links = links.concat(extractUrlsFromText(text, window.location.href));
            }

            links = [...new Set(links.map(url => normalizeUrl(url, window.location.href)).filter(Boolean))];

            if (links.length > 0) {
                logToConsole(`[Drop] Extracted ${links.length} unique URLs!`, 'info');
                addDroppedLinks(links);
                tabBtns[1].click();
            } else {
                logToConsole('[Drop] No valid URLs found in dropped data.', 'error');
            }
        });

        const scrapeBtn = imagesSection.querySelector('#zipper-scrape-btn');
        scrapeBtn.onclick = async () => {
            const checkedBoxes = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox:checked'));
            let urls = checkedBoxes.map(cb => normalizeUrl(cb.getAttribute('data-url'), window.location.href)).filter(Boolean);

            let selVal = selectorInput.value.trim();
            if (selVal) {
                let container = document;
                if (document.querySelector(selVal)) {
                    container = document.querySelector(selVal);
                    logToConsole(`[Media] Scrape targeted to container: "${selVal}"`);
                }
                let nodes = container.querySelectorAll('img, video, source');
                let rawUrls = Array.from(nodes).map(el => getElementUrl(el));
                let extraUrls = [...new Set(rawUrls.map(url => normalizeUrl(url, window.location.href)).filter(Boolean))];
                urls = [...new Set([...urls, ...extraUrls])];
            }

            if (urls.length === 0) {
                logToConsole('[Media] No media links selected.', 'error');
                return;
            }

            scrapeBtn.disabled = true;
            logToConsole(`[Media] Resolving quality and gated media links...`, 'info');
            const resolvedUrls = [];
            for (const u of urls) {
                const bestUrl = await resolveBestMediaUrl(u);
                resolvedUrls.push(bestUrl);
            }
            const finalUrls = [...new Set(resolvedUrls.filter(Boolean))];

            logToConsole(`[Media] Sending ${finalUrls.length} media files to local server...`, 'info');

            const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
            const upscaleEnabled = upscaleBtn ? upscaleBtn.classList.contains('active') : false;
            const selectVal = document.getElementById('zipper-upscale-model').value;
            const upscaleModel = selectVal === 'off' ? getZipperSetting('upscale-model', '4xNomos8k_atd') : selectVal;

            if (globalState.serverOnline) {
                try {
                    const response = await Api.sendWithFallback("download", "POST", {
                        url: window.location.href,
                        links: finalUrls,
                        batch_size: 5,
                        upscale_enabled: upscaleEnabled,
                        upscale_model: upscaleModel
                    });

                    if (response.ok) {
                        let data;
                        try {
                            data = await response.json();
                            logToConsole(`[Server] Success: Sent ${finalUrls.length} media files to pipeline.`, 'success');
                            if (data.correlationId) {
                                logToConsole(`[Server] Job ID: ${data.correlationId}`, 'info');
                            }
                        } catch (e) {
                            logToConsole(`[Server] Success: Sent ${finalUrls.length} media files to pipeline.`, 'success');
                        }
                        flashFab();
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    logToConsole(`[Server] Failed to send links: ${err.message}`, 'error');
                    await clientSideFallback(finalUrls, scrapeBtn, logToConsole);
                }
            } else {
                await clientSideFallback(finalUrls, scrapeBtn, logToConsole);
            }
            scrapeBtn.disabled = false;
        };

        const sendBtn = linksSection.querySelector('#zipper-send-btn');
        const linksInput = linksSection.querySelector('#zipper-links-input');

        sendBtn.onclick = async () => {
            const checkedBoxes = Array.from(linksSection.querySelectorAll('.zipper-cloud-checkbox:checked'));
            let links = checkedBoxes.map(cb => normalizeUrl(cb.getAttribute('data-url'), window.location.href)).filter(Boolean);

            const rawText = linksInput.value.trim();
            if (rawText) {
                const manualLinks = extractUrlsFromText(rawText, window.location.href);
                links = [...new Set([...links, ...manualLinks])];
            }

            if (links.length === 0) {
                logToConsole('[Upload] No cloud links selected or manually input.', 'error');
                return;
            }

            sendBtn.disabled = true;
            logToConsole(`[Upload] Sending ${links.length} link(s) to pipeline...`, 'info');

            if (globalState.serverOnline) {
                try {
                    const response = await Api.sendWithFallback("download", "POST", {
                        url: window.location.href,
                        links: links,
                        batch_size: 100
                    });

                    if (response.ok) {
                        logToConsole(`[Server] Successfully forwarded links to pipeline!`, 'success');
                        linksInput.value = '';
                    } else {
                        throw new Error(`Server error: ${response.status}`);
                    }
                } catch (err) {
                    logToConsole(`[Server] Failed to contact server: ${err.message}`, 'error');
                }
            } else {
                logToConsole('[Server] Error: Local server offline.', 'error');
            }
            sendBtn.disabled = false;
        };

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

