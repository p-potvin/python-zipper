// ==UserScript==
// @name         Zip it (zip.js Edition) - Python Server Link
// @namespace    clopeux-scripts
// @version      5.0
// @description  Visually stunning, glassmorphic download and upload manager for python-zipper
// @author       Clopeux
// @match        *://*/*
// @exclude      https://www.pornpics.com/*
// @exclude      https://onlyfans.com/*
// @icon         https://icons.duckduckgo.com/ip2/7-zip.org.ico
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.62/dist/zip.min.js
// @require      https://raw.githubusercontent.com/eligrey/FileSaver.js/refs/heads/master/dist/FileSaver.min.js
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
    'use strict';
    let pathname = window.location.pathname;
    let serverOnline = false;

    // RGB to HSL conversion helper
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        let max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            let d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
    }

    // Color theory palette generator
    function generatePalette(h, s, l) {
        // Safe ranges for readability
        const safeS = Math.max(30, Math.min(85, s));
        const safeL = Math.max(40, Math.min(65, l));

        const primary = `hsl(${h}, ${safeS}%, ${safeL}%)`;
        
        // Complementary Hue (Opposite 180 degrees)
        const compH = (h + 180) % 360;
        const accent = `hsl(${compH}, ${Math.max(65, safeS)}%, 55%)`;
        
        // Analogous Hue (Secondary, 30 degrees shift)
        const analH = (h + 30) % 360;
        const secondary = `hsl(${analH}, ${safeS}%, 50%)`;
        
        // Premium Dark Theme components matching base color
        const bgDark = `rgba(${Math.round(h / 15)}, 12, 24, 0.75)`;
        const bgHeader = `rgba(${Math.round(h / 12)}, 16, 32, 0.88)`;
        const bgCard = `rgba(255, 255, 255, 0.04)`;
        
        const border = `hsla(${h}, ${safeS}%, 40%, 0.25)`;
        const borderHover = `hsla(${h}, ${safeS}%, 60%, 0.5)`;
        
        const textMain = `#f3f4f6`;
        const textMuted = `hsl(${h}, 15%, 75%)`;
        
        return { primary, secondary, accent, bgDark, bgHeader, bgCard, border, borderHover, textMain, textMuted };
    }

    async function getAverageColor() {
        return new Promise((resolve) => {
            const getFallbackColor = () => {
                const bgColor = window.getComputedStyle(document.body).backgroundColor;
                if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') return bgColor;
                return 'rgb(99, 102, 241)'; // default Indigo fallback
            };

            try {
                const elements = document.querySelectorAll('div, header, body, section');
                let r = 0, g = 0, b = 0, count = 0;

                const samples = Array.from(elements).slice(0, 50);
                samples.forEach(el => {
                    const style = window.getComputedStyle(el);
                    const color = style.backgroundColor;
                    const match = color.match(/\d+/g);
                    if (match && match.length >= 3) {
                        const [currR, currG, currB, currA] = match.map(Number);
                        if (currA === 0) return;
                        r += currR;
                        g += currG;
                        b += currB;
                        count++;
                    }
                });

                if (count === 0) return resolve(getFallbackColor());

                resolve(`rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`);
            } catch (e) {
                resolve(getFallbackColor());
            }
        });
    }

    // Injects global CSS styles to create the visual appearance
    function injectStyles(pal) {
        const style = document.createElement('style');
        style.textContent = `
            :root {
                --zipper-primary: ${pal.primary};
                --zipper-secondary: ${pal.secondary};
                --zipper-accent: ${pal.accent};
                --zipper-bg: ${pal.bgDark};
                --zipper-bg-header: ${pal.bgHeader};
                --zipper-bg-card: ${pal.bgCard};
                --zipper-border: ${pal.border};
                --zipper-border-hover: ${pal.borderHover};
                --zipper-text: ${pal.textMain};
                --zipper-text-muted: ${pal.textMuted};
            }

            #zipper-fab {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                background: var(--zipper-bg-header);
                backdrop-filter: blur(12px);
                border: 1px solid var(--zipper-border);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                cursor: pointer;
                z-index: 9999999;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), border-color 0.3s;
            }

            #zipper-fab:hover {
                transform: scale(1.1);
                border-color: var(--zipper-primary);
            }

            #zipper-fab svg {
                width: 22px;
                height: 22px;
                fill: var(--zipper-primary);
                transition: fill 0.3s;
            }

            #zipper-fab:hover svg {
                fill: var(--zipper-accent);
            }

            #zipper-status-dot {
                position: absolute;
                top: 2px;
                right: 2px;
                width: 10px;
                height: 10px;
                border-radius: 50%;
                background: #ef4444;
                border: 2px solid #1f2937;
                transition: background 0.3s;
            }

            #zipper-status-dot.online {
                background: #22c55e;
                box-shadow: 0 0 8px #22c55e;
            }

            #zipper-panel {
                position: fixed;
                bottom: 80px;
                right: 20px;
                width: 330px;
                height: 480px;
                border-radius: 12px;
                background: var(--zipper-bg);
                backdrop-filter: blur(16px) saturate(120%);
                border: 1px solid var(--zipper-border);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
                z-index: 9999998;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                color: var(--zipper-text);
                opacity: 0;
                transform: translateY(20px) scale(0.95);
                pointer-events: none;
                transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            }

            #zipper-panel.visible {
                opacity: 1;
                transform: translateY(0) scale(1);
                pointer-events: auto;
            }

            #zipper-header {
                padding: 12px 16px;
                background: var(--zipper-bg-header);
                border-bottom: 1px solid var(--zipper-border);
                cursor: move;
                display: flex;
                align-items: center;
                justify-content: space-between;
                user-select: none;
            }

            #zipper-header h3 {
                margin: 0;
                font-size: 14px;
                font-weight: 700;
                background: linear-gradient(90deg, var(--zipper-primary), var(--zipper-accent));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                letter-spacing: 0.5px;
            }

            #zipper-close-btn {
                background: transparent;
                border: none;
                color: var(--zipper-text-muted);
                cursor: pointer;
                font-size: 18px;
                padding: 0;
                line-height: 1;
                transition: color 0.2s;
            }

            #zipper-close-btn:hover {
                color: #ef4444;
            }

            .zipper-tabs {
                display: flex;
                background: rgba(0, 0, 0, 0.2);
                border-bottom: 1px solid var(--zipper-border);
            }

            .zipper-tab-btn {
                flex: 1;
                padding: 10px;
                background: transparent;
                border: none;
                color: var(--zipper-text-muted);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                text-align: center;
            }

            .zipper-tab-btn.active {
                color: var(--zipper-primary);
                background: rgba(255, 255, 255, 0.02);
                box-shadow: inset 0 -2px 0 var(--zipper-primary);
            }

            .zipper-content {
                flex: 1;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                overflow-y: auto;
            }

            .zipper-panel-section {
                display: none;
                flex-direction: column;
                gap: 12px;
                height: 100%;
            }

            .zipper-panel-section.active {
                display: flex;
            }

            .zipper-input-group {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .zipper-input-group label {
                font-size: 11px;
                color: var(--zipper-text-muted);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                font-weight: 600;
            }

            .zipper-input {
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid var(--zipper-border);
                border-radius: 6px;
                color: var(--zipper-text);
                padding: 8px 12px;
                font-size: 12px;
                transition: border-color 0.2s;
                outline: none;
            }

            .zipper-input:focus {
                border-color: var(--zipper-primary);
            }

            .zipper-textarea {
                resize: none;
                height: 110px;
                font-family: monospace;
            }

            .zipper-btn {
                background: var(--zipper-primary);
                color: #fff;
                border: none;
                border-radius: 6px;
                padding: 10px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.2s, transform 0.1s;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }

            .zipper-btn:hover {
                background: var(--zipper-secondary);
            }

            .zipper-btn:active {
                transform: scale(0.98);
            }

            .zipper-btn.secondary-btn {
                background: transparent;
                border: 1px solid var(--zipper-primary);
                color: var(--zipper-text);
            }

            .zipper-btn.secondary-btn:hover {
                background: rgba(255, 255, 255, 0.05);
                border-color: var(--zipper-secondary);
            }

            .zipper-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }

            #zipper-console {
                height: 120px;
                background: rgba(0, 0, 0, 0.45);
                border-radius: 6px;
                border: 1px solid var(--zipper-border);
                padding: 8px;
                overflow-y: auto;
                font-family: monospace;
                font-size: 10px;
                color: var(--zipper-text-muted);
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .console-line {
                line-height: 1.4;
                word-break: break-all;
            }

            .console-success { color: #22c55e; }
            .console-error { color: #ef4444; }
            .console-info { color: var(--zipper-primary); }

            #zipper-drop-overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(10, 10, 15, 0.92);
                border: 2px dashed var(--zipper-primary);
                border-radius: 12px;
                z-index: 100;
                display: none;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                gap: 12px;
                pointer-events: none;
            }

            #zipper-drop-overlay svg {
                width: 48px;
                height: 48px;
                fill: var(--zipper-primary);
                animation: pulse 1.5s infinite;
            }

            @keyframes pulse {
                0% { transform: scale(1); opacity: 0.6; }
                50% { transform: scale(1.08); opacity: 1; }
                100% { transform: scale(1); opacity: 0.6; }
            }
        `;
        document.head.appendChild(style);
    }

    async function checkServerStatus() {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 1200);
            await fetch("http://127.0.0.1:5171/", { method: "OPTIONS", signal: controller.signal });
            clearTimeout(id);
            return true;
        } catch (e) {
            return false;
        }
    }

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

    async function clientSideFallback(urls, btn, logToConsole) {
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
                let ext = url.split('.').pop().split(/[\?#]/)[0];
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext.toLowerCase())) ext = 'jpg';

                blob = new Blob([rawBuffer]);
                await zipWriter.add(pathname + `_${String(i + 1).padStart(3, '0')}.${ext}`, new zip.BlobReader(blob), { level: 0 });
                count++;
                btn.textContent = `Zipping (${count}/${urls.length})...`;
            } catch (error) {
                logToConsole(`[Local] Error processing image ${i + 1}: ${error.message || error}`, "error");
            }

            await new Promise(r => setTimeout(r, 80));

            if (count > 0 && count % 100 == 0) {
                try {
                    zipBlob = await zipWriter.close();
                    saveAs(zipBlob, pathname + '_' + getRandomInt(9) + '.zip');
                    logToConsole(`[Local] Downloaded batch ZIP of 100 images!`, "success");
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
                saveAs(zipBlob, pathname + '_' + getRandomInt(9) + '.zip');
                logToConsole(`[Local] Final ZIP downloaded successfully!`, "success");
            } catch (error) {
                logToConsole(`[Local] Final ZIP generation failed: ${error}`, "error");
            }
        }

        btn.textContent = 'Start Image Scrape';
        btn.disabled = false;
    }

    function getRandomInt(max) {
        return Math.floor(Math.random() * 1000 * max);
    }

    function initUI(pal) {
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

        // --- 2. Main Sliding Panel ---
        const panel = document.createElement('div');
        panel.id = 'zipper-panel';
        document.body.appendChild(panel);

        // --- Header (Draggable) ---
        const header = document.createElement('div');
        header.id = 'zipper-header';
        header.innerHTML = `
            <h3>Python Zipper Control</h3>
            <button id="zipper-close-btn">&times;</button>
        `;
        panel.appendChild(header);

        // --- Tabs ---
        const tabs = document.createElement('div');
        tabs.className = 'zipper-tabs';
        tabs.innerHTML = `
            <button class="zipper-tab-btn active" data-tab="images">Image Pipeline</button>
            <button class="zipper-tab-btn" data-tab="links">Cloud / Upload</button>
        `;
        panel.appendChild(tabs);

        // --- Main Content Area ---
        const content = document.createElement('div');
        content.className = 'zipper-content';
        panel.appendChild(content);

        // --- Console ---
        const consolePanel = document.createElement('div');
        consolePanel.id = 'zipper-console';
        content.appendChild(consolePanel);

        function logToConsole(message, type = '') {
            const line = document.createElement('div');
            line.className = `console-line ${type ? 'console-' + type : ''}`;
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            line.textContent = `[${time}] ${message}`;
            consolePanel.appendChild(line);
            consolePanel.scrollTop = consolePanel.scrollHeight;
        }

        // --- Images Section ---
        const imagesSection = document.createElement('div');
        imagesSection.className = 'zipper-panel-section active';
        imagesSection.id = 'section-images';
        imagesSection.innerHTML = `
            <div class="zipper-input-group">
                <label>Container Selector</label>
                <input type="text" id="zipper-selector" class="zipper-input" placeholder="e.g. #gallery, .content (empty=all)">
            </div>
            <button id="zipper-scrape-btn" class="zipper-btn">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                    <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                </svg>
                <span>Start Image Scrape</span>
            </button>
        `;
        content.insertBefore(imagesSection, consolePanel);

        // --- Links/Cloud Section ---
        const linksSection = document.createElement('div');
        linksSection.className = 'zipper-panel-section';
        linksSection.id = 'section-links';
        linksSection.innerHTML = `
            <div class="zipper-input-group">
                <label>File or Host Links</label>
                <textarea id="zipper-links-input" class="zipper-input zipper-textarea" placeholder="Paste links (GDrive, Mega, etc.), one per line..."></textarea>
            </div>
            <button id="zipper-send-btn" class="zipper-btn">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M15.964.686a.5.5 0 0 0-.65-.65L.767 5.855H.766l-.452.18a.5.5 0 0 0-.082.887l.41.26.001.002 4.995 3.178 3.178 4.995.002.002.26.41a.5.5 0 0 0 .886-.083l6-15Zm-1.833 1.89L6.637 10.07l-.215-.338a.5.5 0 0 0-.154-.154l-.338-.215 7.494-7.494 1.178-.471-.47 1.178Z"/>
                </svg>
                <span>Send to Cloud Pipeline</span>
            </button>
        `;
        content.insertBefore(linksSection, consolePanel);

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

        // --- Interactivity & Event Binding ---

        // Toggle Expand
        fab.onclick = () => {
            panel.classList.toggle('visible');
        };

        header.querySelector('#zipper-close-btn').onclick = () => {
            panel.classList.remove('visible');
        };

        // Tab Switching
        const tabBtns = tabs.querySelectorAll('.zipper-tab-btn');
        tabBtns.forEach(btn => {
            btn.onclick = () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const targetTab = btn.getAttribute('data-tab');
                content.querySelectorAll('.zipper-panel-section').forEach(sec => sec.classList.remove('active'));
                content.querySelector(`#section-${targetTab}`).classList.add('active');
            };
        });

        // Draggable Panel Handler
        let isDragging = false;
        let startX, startY, startRight, startBottom;
        header.onmousedown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startRight = parseInt(window.getComputedStyle(panel).right) || 20;
            startBottom = parseInt(window.getComputedStyle(panel).bottom) || 80;
            document.body.style.userSelect = 'none';

            document.onmousemove = (moveEvent) => {
                if (!isDragging) return;
                let dx = moveEvent.clientX - startX;
                let dy = moveEvent.clientY - startY;
                panel.style.right = `${startRight - dx}px`;
                panel.style.bottom = `${startBottom - dy}px`;
            };

            document.onmouseup = () => {
                isDragging = false;
                document.onmousemove = null;
                document.body.style.userSelect = '';
            };
        };

        // Live Server Status Tracker
        const statusDot = fab.querySelector('#zipper-status-dot');
        
        async function updateStatus() {
            const online = await checkServerStatus();
            serverOnline = online;
            if (online) {
                statusDot.classList.add('online');
                if (statusDot.title !== 'Server Online') {
                    statusDot.title = 'Server Online';
                    logToConsole('Connection established with Python Server on 5171', 'success');
                }
            } else {
                statusDot.classList.remove('online');
                if (statusDot.title !== 'Server Offline') {
                    statusDot.title = 'Server Offline';
                    logToConsole('Python Server offline on port 5171. Using local fallback.', 'error');
                }
            }
        }
        updateStatus();
        setInterval(updateStatus, 5000);

        // --- Drag and Drop File/URL Reader ---
        window.addEventListener('dragenter', (e) => {
            if (panel.classList.contains('visible')) {
                dropOverlay.style.display = 'flex';
            }
        });

        panel.addEventListener('dragleave', (e) => {
            // Only hide overlay if drag leaves the panel boundary
            const rect = panel.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                dropOverlay.style.display = 'none';
            }
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        panel.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropOverlay.style.display = 'none';
            
            let links = [];
            
            // Extract from dropped files (reading plain text)
            if (e.dataTransfer.files.length > 0) {
                logToConsole(`[Drop] Processing ${e.dataTransfer.files.length} dropped file(s)...`);
                for (let file of e.dataTransfer.files) {
                    if (file.type.startsWith('text/') || file.name.endsWith('.txt') || file.name.endsWith('.json') || file.name.endsWith('.html')) {
                        try {
                            const text = await file.text();
                            const matched = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi) || [];
                            links = links.concat(matched);
                        } catch (err) {
                            logToConsole(`Failed to read file: ${err.message}`, 'error');
                        }
                    }
                }
            }

            // Extract from HTML/Text contents
            const html = e.dataTransfer.getData('text/html');
            const text = e.dataTransfer.getData('text/plain');

            if (html) {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                doc.querySelectorAll('a').forEach(a => { if (a.href) links.push(a.href); });
                doc.querySelectorAll('img').forEach(img => { if (img.src) links.push(img.src); });
            }

            if (text) {
                const matched = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi) || [];
                links = links.concat(matched);
            }

            links = [...new Set(links.filter(url => url && (url.startsWith('http') || url.indexOf("//") !== -1)))];

            if (links.length > 0) {
                logToConsole(`[Drop] Successfully extracted ${links.length} unique URLs!`, 'info');
                const textarea = panel.querySelector('#zipper-links-input');
                const existing = textarea.value.trim();
                textarea.value = existing ? `${existing}\n${links.join('\n')}` : links.join('\n');
                
                // Navigate to link tab
                tabBtns[1].click();
            } else {
                logToConsole('[Drop] No valid URLs found in dropped data.', 'error');
            }
        });

        // --- Action Scripts Execution ---

        // Scrape & Download Images Action
        const scrapeBtn = imagesSection.querySelector('#zipper-scrape-btn');
        const selectorInput = imagesSection.querySelector('#zipper-selector');

        scrapeBtn.onclick = async () => {
            scrapeBtn.disabled = true;
            let selVal = selectorInput.value.trim();
            let container = document;
            
            if (selVal && document.querySelector(selVal)) {
                container = document.querySelector(selVal);
                logToConsole(`[Images] Scrape targeted to container: "${selVal}"`);
            } else if (selVal) {
                logToConsole(`[Images] Selector "${selVal}" not found. Falling back to whole page.`, 'error');
            }

            let nodes = container.querySelectorAll('img');
            let rawUrls = Array.from(nodes).map(el => el.href || el.src || el.getAttribute('data-src'));
            let urls = [...new Set(rawUrls.filter(url => url && (url.startsWith('http') || url.indexOf("//") !== -1)))];

            if (urls.length === 0) {
                logToConsole('[Images] No image links detected on page.', 'error');
                scrapeBtn.disabled = false;
                return;
            }

            logToConsole(`[Images] Extracted ${urls.length} unique images.`, 'info');

            if (serverOnline) {
                logToConsole('[Images] Sending links to Python Server...', 'info');
                try {
                    const response = await fetch("http://127.0.0.1:5171/download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            url: window.location.href,
                            links: urls,
                            batch_size: 100
                        })
                    });

                    if (response.ok) {
                        logToConsole(`[Server] Success: Sent ${urls.length} images to scraper server.`, 'success');
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    logToConsole(`[Server] Failed to send links: ${err.message}`, 'error');
                    await clientSideFallback(urls, scrapeBtn, logToConsole);
                }
            } else {
                await clientSideFallback(urls, scrapeBtn, logToConsole);
            }
            scrapeBtn.disabled = false;
        };

        // Cloud / Upload Links Action
        const sendBtn = linksSection.querySelector('#zipper-send-btn');
        const linksInput = linksSection.querySelector('#zipper-links-input');

        sendBtn.onclick = async () => {
            const rawText = linksInput.value.trim();
            if (!rawText) {
                logToConsole('[Upload] Please paste links in the input area first.', 'error');
                return;
            }

            const links = [...new Set(rawText.split('\n').map(l => l.trim()).filter(l => l.startsWith('http') || l.indexOf("//") !== -1))];
            if (links.length === 0) {
                logToConsole('[Upload] No valid HTTP links detected.', 'error');
                return;
            }

            sendBtn.disabled = true;
            logToConsole(`[Upload] Sending ${links.length} link(s) to pipeline...`, 'info');

            if (serverOnline) {
                try {
                    // Send to download endpoint on Python server
                    const response = await fetch("http://127.0.0.1:5171/download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            url: window.location.href,
                            links: links,
                            batch_size: 100
                        })
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
                logToConsole('[Server] Error: Local server offline. Cannot run upload pipeline without port 5171.', 'error');
            }
            sendBtn.disabled = false;
        };

        // Keyboard Shortcut triggers FAB toggle
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

    async function start() {
        const avgColor = await getAverageColor();
        const rgb = avgColor.match(/\d+/g);
        let h = 230, s = 80, l = 55; // Default HSL values (Indigo)
        if (rgb && rgb.length >= 3) {
            [h, s, l] = rgbToHsl(Number(rgb[0]), Number(rgb[1]), Number(rgb[2]));
        }

        const pal = generatePalette(h, s, l);
        injectStyles(pal);
        initUI(pal);
    }

    // Wait until document body is parsed
    if (document.body) {
        start();
    } else {
        window.addEventListener('DOMContentLoaded', start);
    }
})();
