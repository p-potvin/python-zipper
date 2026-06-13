// ==UserScript==
// @name         Zip it - VaultWares
// @namespace    clopeux-scripts
// @version      7.0.2
// @description  Visually stunning, glassmorphic download and upload manager.VaultWares API Download Manager Browser Helper Script Addon Bridge for Media Cloud Management on Local Server (uses pyload :8003 as well as Internet Download Manager and Real-Debrid to download restricted links in bulk and Katfile, Fileboom/k2s API to upload directly to my cloud accounts and Linkvertise to wrap these links inside a comfortable linkvertise PPD link distributed automatically on both tube-sites' link-sharing feature and downloaded by customers around the world)
// @author       Clopeux
// @match        *://*/*
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

    // Privileged request helper to bypass CORS and Mixed Content restrictions
    function makeGMRequest(url, method = "GET", data = null) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: data ? { "Content-Type": "application/json" } : {},
                data: data ? JSON.stringify(data) : null,
                timeout: 5000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try {
                            resolve({ ok: true, status: res.status, json: () => JSON.parse(res.responseText), text: () => res.responseText });
                        } catch (e) {
                            resolve({ ok: true, status: res.status, text: () => res.responseText });
                        }
                    } else {
                        resolve({ ok: false, status: res.status });
                    }
                },
                onerror: () => resolve({ ok: false, status: 0 }),
                ontimeout: () => resolve({ ok: false, status: 0 })
            });
        });
    }

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

    // Color theory palette generator (soft analogous tones)
    function generatePalette(h, s, l) {
        // Safe ranges for readability and high contrast against dark panel background
        const safeS = Math.max(35, Math.min(90, s));
        const safeL = Math.max(35, Math.min(90, l));

        const primary = `hsl(${h}, ${safeS}%, ${safeL}%)`;

        const opposite = `hsl(${(h + 180) % 360}, ${safeS}%, ${(safeL + 100) / 2}%)`;


        // Analogous Hue (Secondary, 25 degrees shift)
        const analH = (h + 25) % 360;
        const secondary = `hsl(${analH}, ${safeS}%, ${safeL}%)`;

        // Soft Accent (Analogous on the other side, 25 degrees opposite shift)
        const accentH = (h - 25 + 360) % 360;
        const accent = `hsl(${accentH}, ${Math.min(95, safeS + 10)}%, ${Math.min(80, safeL + 5)}%)`;

        // Premium Dark Theme components matching base color
        const bgDark = `rgba(${Math.round(h / 15)}, 12, 24, 0.85)`;
        const bgHeader = `rgba(${Math.round(h / 12)}, 16, 32, 0.96)`;
        const bgCard = `rgba(255, 255, 255, 0.05)`;

        const border = `hsla(${h}, ${safeS}%, 55%, 0.25)`;
        const borderHover = `hsla(${h}, ${safeS}%, 70%, 0.48)`;

        const textMain = `#ffffff`;
        const textMuted = `#cbd5e1`;

        return { primary, opposite, secondary, accent, bgDark, bgHeader, bgCard, border, borderHover, textMain, textMuted };
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
                --zipper-opposite: ${pal.opposite};
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
                cursor: grab;
                z-index: 10000001;
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
            }

            @keyframes zipper-fab-flash {
                0%, 100% { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); }
                25% { box-shadow: 0 0 20px var(--zipper-primary), 0 0 40px var(--zipper-accent); transform: scale(1.15); }
                50% { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); transform: scale(1.0); }
                75% { box-shadow: 0 0 16px var(--zipper-primary), 0 0 32px var(--zipper-accent); transform: scale(1.1); }
            }

            #zipper-fab.zipper-fab-flash {
                animation: zipper-fab-flash 1.5s ease-in-out;
            }

            #zipper-panel {
                position: fixed;
                bottom: 80px;
                right: 20px;
                width: 350px;
                height: 520px;
                border-radius: 12px;
                background: var(--zipper-bg);
                backdrop-filter: blur(16px) saturate(120%);
                border: 1px solid var(--zipper-border);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
                z-index: 10000002;
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

            #zipper-abort-btn {
                background: #ef4444;
                border: none;
                color: #ffffff !important;
                font-size: 10px;
                font-weight: 700;
                padding: 4px 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s, transform 0.1s;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-left: auto;
                margin-right: 8px;
            }
            #zipper-abort-btn:hover {
                background: #dc2626;
            }
            #zipper-abort-btn:active {
                transform: scale(0.95);
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
                border-radius: 0 !important;
            }

            .zipper-tab-btn.active {
                color: var(--zipper-primary);
                background: rgba(255, 255, 255, 0.02);
                box-shadow: inset 0 -2px 0 var(--zipper-primary);
                border-radius: 0 !important;
            }

            .zipper-icon-toggle {
                background: transparent;
                border: none;
                padding: 6px;
                border-radius: 4px;
                color: var(--zipper-text-muted);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s ease;
                opacity: 0.6;
            }
            .zipper-icon-toggle:hover {
                background: rgba(255, 255, 255, 0.08);
                opacity: 0.9;
                color: var(--zipper-text);
            }
            .zipper-icon-toggle.active {
                color: var(--zipper-primary);
                opacity: 1;
                background: rgba(255, 255, 255, 0.05);
                box-shadow: 0 0 8px rgba(255, 255, 255, 0.05);
            }
            .zipper-icon-toggle:disabled {
                opacity: 0.15 !important;
                cursor: not-allowed !important;
                pointer-events: none !important;
            }

            .zipper-content {
                flex: 1;
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                overflow-y: auto;
            }

            .zipper-panel-section {
                display: none;
                flex-direction: column;
                gap: 10px;
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

            .zipper-input::placeholder {
                color: rgba(255, 255, 255, 0.45) !important;
            }

            .zipper-textarea {
                resize: none;
                height: 80px;
                font-family: 'Jetbrains Mono', monospace;
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

            .zipper-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }

            #zipper-console {
                height: 100px;
                background: rgba(0, 0, 0, 0.3);
                border-top: 1px solid var(--zipper-border);
                padding: 8px 12px;
                overflow-y: auto;
                font-family: 'Jetbrains Mono', monospace;
                font-size: 10px;
                color: var(--zipper-text-muted);
                display: flex;
                flex-direction: column;
                gap: 2px;
                flex-shrink: 0;
            }

            .console-line {
                line-height: 1.4;
                word-break: break-word;
            }

            .console-success { color: #4ade80 !important; }
            .console-error { color: #f87171 !important; }
            .console-info { color: #60a5fa !important; }

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

            .zipper-link-list {
                max-height: 120px;
                overflow-y: auto;
                border: 1px solid var(--zipper-border);
                border-radius: 6px;
                padding: 6px;
                background: rgba(0, 0, 0, 0.25);
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .zipper-link-item {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 11px;
                color: var(--zipper-text-muted);
                padding: 4px;
                border-radius: 4px;
                transition: background 0.2s;
            }

            .zipper-link-item:hover {
                background: rgba(255, 255, 255, 0.04);
                color: var(--zipper-text);
            }

            .zipper-link-item input[type="checkbox"] {
                accent-color: var(--zipper-primary);
                cursor: pointer;
            }

            .zipper-link-url {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                flex: 1;
                cursor: default;
            }

            .zipper-select-all-group {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 11px;
                color: var(--zipper-text-muted);
                padding: 2px 4px;
            }

            .zipper-select-all-group label {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }

            /* Custom Styled Scrollbars */

            /* For Added Browsers Support (Firefox) */
            #zipper-panel,
            #zipper-panel *  {
                scrollbar-width: thin;
                scrollbar-color: var(--zipper-border-hover) rgba(0, 0, 0, 0.25);
                border-radius: 3px;
            }

            #zipper-panel ::-webkit-scrollbar {
                width: 6px;
                height: 6px;
            }
            #zipper-panel ::-webkit-scrollbar-track {
                background: rgba(0, 0, 0, 0.77);
                border-radius: 3px;
            }
            #zipper-panel ::-webkit-scrollbar-thumb {
                background: var(--zipper-border);
                border-radius: 3px;
            }
            #zipper-panel ::-webkit-scrollbar-thumb:hover {
                background: var(--zipper-border-hover);
            }

            /* Visual effect for captured DOM media items */
            .zipper-captured-highlight {
                outline: 2px dashed var(--zipper-primary) !important;
                outline-offset: -2px !important;
                box-shadow: 0 0 10px var(--zipper-primary) !important;
                transition: outline 0.3s ease, box-shadow 0.3s ease !important;
            }

            /* Premium Switch Styling */
            .zipper-switch {
                position: relative;
                display: inline-block;
                width: 28px;
                height: 16px;
                margin-left: 8px;
            }

            .zipper-switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }

            .zipper-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: rgba(255, 255, 255, 0.2);
                transition: .3s;
                border-radius: 16px;
            }

            .zipper-slider:before {
                position: absolute;
                content: "";
                height: 12px;
                width: 12px;
                left: 2px;
                bottom: 2px;
                background-color: white;
                transition: .3s;
                border-radius: 50%;
            }

            .zipper-switch input:checked + .zipper-slider {
                background-color: var(--zipper-primary);
            }

            .zipper-switch input:checked + .zipper-slider:before {
                transform: translateX(15px);
            }

            .zipper-switch input:disabled + .zipper-slider {
                background-color: rgba(255, 255, 255, 0.08);
                cursor: not-allowed;
                opacity: 0.5;
            }

            .zipper-switch input:disabled + .zipper-slider:before {
                background-color: #555566;
            }

            /* Floating Download Button */
            #zipper-float-download-btn {
                display: none;
                position: absolute;
                z-index: 10000000;
                width: 18px;
                height: 18px;
                background: rgba(30, 30, 40, 0.95);
                border: 1px solid var(--zipper-primary);
                border-radius: 4px;
                cursor: pointer;
                align-items: center;
                justify-content: center;
                color: #fff;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                transition: background 0.2s, transform 0.1s, border-color 0.3s;
            }
            #zipper-float-download-btn:hover {
                background: var(--zipper-primary);
                transform: scale(1.1);
            }
            #zipper-float-download-btn.dl-success {
                border-color: var(--zipper-primary);
                color: var(--zipper-primary);
            }
            #zipper-float-download-btn.dl-error {
                border-color: var(--zipper-opposite);
                color: var(--zipper-opposite);
            }
            #zipper-float-download-btn svg {
                width: 10px;
                height: 10px;
                fill: currentColor;
            }
        `;
        document.head.appendChild(style);
    }

    async function checkServerStatus() {
        const res = await makeGMRequest("http://100.67.25.118:9001/health", "GET");
        return res.ok;
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
                let ext = url.split('.').pop().split(new RegExp('[?#]'))[0];
                if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg', 'mov', 'm4v', 'mkv', 'avi'].includes(ext.toLowerCase())) ext = 'jpg';

                blob = new Blob([rawBuffer]);
                await zipWriter.add(pathname + `_${String(i + 1).padStart(3, '0')}.${ext}`, new zip.BlobReader(blob), { level: 0 });
                count++;
                btn.textContent = `Zipping (${count}/${urls.length})...`;
            } catch (error) {
                logToConsole(`[Local] Error processing media ${i + 1}: ${error.message || error}`, "error");
            }

            await new Promise(r => setTimeout(r, 80));

            if (count > 0 && count % 100 == 0) {
                try {
                    zipBlob = await zipWriter.close();
                    saveAs(zipBlob, pathname + '_' + getRandomInt(9) + '.zip');
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
                saveAs(zipBlob, pathname + '_' + getRandomInt(9) + '.zip');
                logToConsole(`[Local] Final ZIP downloaded successfully!`, "success");
            } catch (error) {
                logToConsole(`[Local] Final ZIP generation failed: ${error}`, "error");
            }
        }

        btn.textContent = 'Send Selected Media';
        btn.disabled = false;
    }

    function getRandomInt(max) {
        return Math.floor(Math.random() * 1000 * max);
    }

    const cloudDomains = [
        "linkvertise.com", "rentry.co", "rentry.org", "pasterix.net", "mega.nz",
        "real-debrid.com", "trw.lat", "direct-link.net", "fileboom.me", "keep2share.cc",
        "k2s.cc", "rapidgator.net", "rg.to", "tezfiles.com", "katfile.com",
        "link-center.net", "link-hub.net", "link-target.net", "pastebin.com",
        "fboom.me", "gofile.io", "cyberfile.me", "pixeldrain.com", "patreon.com",
        "x.com", "twitter.com", "fanbox.cc"
    ];

    const mediaDomains = [
        "bunkr.la", "bunkrr.su", "onlyfans.com", "fansly.com", "manyvids.com",
        "coomer.st", "coomer.su", "pixiv.net", "subscribestar.com",
        "subscribestar.adult", "kemono.cr", "kemono.su"
    ];

    function harvestLinks() {
        const mediaExtRegex = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|mov|m4v|mkv|avi|flv|wmv)/i;
        const tagRegex = /^(img|video|source)$/i;
        const videoExtensions = ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.wmv'];

        const mediaLinks = new Set();
        const cloudLinks = new Set();
        const mediaLinksMetadata = new Map();

        // Helper to add highlighting to elements
        function highlightElement(el) {
            const highlightEnabled = localStorage.getItem('zipper-highlight-enabled') !== 'false';
            if (!highlightEnabled) return;

            let target = el;
            if (el.tagName.toLowerCase() === 'source' && el.parentElement) {
                target = el.parentElement;
            }
            target.classList.add('zipper-captured-highlight');
        }

        // Layout and metadata aware media filter
        function shouldFilterMedia(url, el) {
            const lowerUrl = url.toLowerCase();
            const filterKeywords = [
                'avatar', 'profile', 'sprite', 'logo', 'banner', 'button', 'icon',
                'loading', 'spacer', 'favicon', 'analytics', 'tracker', 'ad-group',
                'adsense', 'doubleclick', 'pixel', 'advertisement', 'widget'
            ];
            if (filterKeywords.some(keyword => lowerUrl.includes(keyword))) {
                return true;
            }

            if (el) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'img') {
                    if (el.naturalWidth > 0 && el.naturalWidth < 150) return true;
                    if (el.naturalHeight > 0 && el.naturalHeight < 150) return true;
                    if (el.width > 0 && el.width < 150) return true;
                    if (el.height > 0 && el.height < 150) return true;

                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return true;
                }

                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    const classIdStr = ((parent.className || '') + ' ' + (parent.id || '')).toLowerCase();
                    if (/(header|footer|nav|sidebar|menu|widget|button|btn)/i.test(classIdStr)) {
                        return true;
                    }
                    parent = parent.parentElement;
                    depth++;
                }
            }
            return false;
        }

        // Helper to check if the media link is likely interesting (should be ticked by default)
        function isInterestingMedia(url, el) {
            const lowerUrl = url.toLowerCase();

            // Videos are highly interesting!
            const isVideo = videoExtensions.some(ext => lowerUrl.endsWith(ext)) || (el && (el.tagName.toLowerCase() === 'video' || el.tagName.toLowerCase() === 'source'));
            if (isVideo) return true;

            // Eliminate uninteresting icons, vectors, and standard UI elements
            if (lowerUrl.endsWith('.ico') || lowerUrl.endsWith('.svg') || lowerUrl.includes('favicon')) return false;

            const uninterestingKeywords = [
                'avatar', 'sprite', 'logo', 'banner', 'button', 'icon',
                'font', 'loading', 'spacer', 'ad-', 'track', 'analytics', 'pixel',
                'nav', 'footer', 'header', 'sidebar', 'widget', 'profile', 'thumb_small', 'thumbnail_small'
            ];
            if (uninterestingKeywords.some(keyword => lowerUrl.includes(keyword))) {
                return false;
            }

            // Size checks for images - require at least 300px width/height for default checks
            if (el) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'img') {
                    if (el.naturalWidth > 0 && el.naturalWidth < 300) return false;
                    if (el.naturalHeight > 0 && el.naturalHeight < 300) return false;
                    if (el.width > 0 && el.width < 300) return false;
                    if (el.height > 0 && el.height < 300) return false;
                }
            }

            return true;
        }

        // 1. Scan all elements in the document
        document.querySelectorAll('*').forEach(el => {
            const tagName = el.tagName;

            // Check if it's img, video, or source tag
            if (tagRegex.test(tagName)) {
                const src = el.src || el.getAttribute('data-src') || el.srcset || el.getAttribute('srcset');
                if (src) {
                    let url = src.trim();
                    if (url.includes(',')) {
                        url = url.split(',').pop().trim().split(' ')[0];
                    }
                    if (url && (url.startsWith('http') || url.indexOf('//') !== -1)) {
                        if (!shouldFilterMedia(url, el)) {
                            mediaLinks.add(url);
                            highlightElement(el);
                            const interesting = isInterestingMedia(url, el);
                            if (!mediaLinksMetadata.has(url) || interesting) {
                                mediaLinksMetadata.set(url, interesting);
                            }
                            const isVideoTag = tagName.toLowerCase() === 'video' || tagName.toLowerCase() === 'source';
                            const isVideoUrl = videoExtensions.some(ext => url.toLowerCase().includes(ext)) || url.toLowerCase().includes("bunkr") || url.toLowerCase().includes("bunkrr");
                            if (isVideoTag || isVideoUrl) {
                                cloudLinks.add(url);
                            }
                        }
                    }
                }
            }
            // Check if it's an anchor link matching media or cloud patterns
            else if (tagName.toLowerCase() === 'a') {
                const href = el.href;
                if (href) {
                    const lowerHref = href.toLowerCase();
                    const isMedia = mediaExtRegex.test(lowerHref) || mediaDomains.some(domain => lowerHref.includes(domain));
                    const isCloud = cloudDomains.some(domain => lowerHref.includes(domain));

                    if (isMedia) {
                        if (!shouldFilterMedia(href, el)) {
                            mediaLinks.add(href);
                            highlightElement(el);
                            const interesting = isInterestingMedia(href, el);
                            if (!mediaLinksMetadata.has(href) || interesting) {
                                mediaLinksMetadata.set(href, interesting);
                            }
                            const isVideoUrl = videoExtensions.some(ext => lowerHref.includes(ext)) || lowerHref.includes("bunkr") || lowerHref.includes("bunkrr");
                            if (isVideoUrl) {
                                cloudLinks.add(href);
                            }
                        }
                    } else if (isCloud) {
                        cloudLinks.add(href);
                    }
                }
            }
        });

        // 2. Scan body text content for URLs as well
        const text = document.body.innerText || "";
        const textUrls = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi) || [];
        textUrls.forEach(url => {
            const lowerUrl = url.toLowerCase();
            const isMedia = mediaExtRegex.test(lowerUrl) || mediaDomains.some(domain => lowerUrl.includes(domain));
            const isCloud = cloudDomains.some(domain => lowerUrl.includes(domain));

            if (isMedia) {
                if (!shouldFilterMedia(url, null)) {
                    mediaLinks.add(url);
                    const interesting = isInterestingMedia(url, null);
                    if (!mediaLinksMetadata.has(url) || interesting) {
                        mediaLinksMetadata.set(url, interesting);
                    }
                    const isVideoUrl = videoExtensions.some(ext => lowerUrl.includes(ext)) || lowerUrl.includes("bunkr") || lowerUrl.includes("bunkrr");
                    if (isVideoUrl) {
                        cloudLinks.add(url);
                    }
                }
            } else if (isCloud) {
                cloudLinks.add(url);
            }
        });

        return {
            cloudLinks: Array.from(cloudLinks),
            mediaLinks: Array.from(mediaLinks).map(url => ({
                url: url,
                isInteresting: mediaLinksMetadata.get(url) ?? true
            }))
        };
    }

    function initUI(_pal) {
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

        // Prevent host page from intercepting inputs inside our panel
        panel.addEventListener('keydown', (e) => e.stopPropagation());
        panel.addEventListener('keyup', (e) => e.stopPropagation());
        panel.addEventListener('keypress', (e) => e.stopPropagation());
        panel.addEventListener('mousedown', (e) => {
            if (!isDragging) e.stopPropagation();
        });
        panel.addEventListener('mouseup', (e) => {
            if (!isDragging) e.stopPropagation();
        });
        panel.addEventListener('click', (e) => e.stopPropagation());
        panel.addEventListener('paste', (e) => e.stopPropagation());

        // --- Header (Draggable) ---
        const header = document.createElement('div');
        header.id = 'zipper-header';
        const isHighlightEnabled = localStorage.getItem('zipper-highlight-enabled') !== 'false';
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <h3 style="font-size: 13px; margin-right: 4px;">Python Zipper</h3>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <button id="zipper-toggle-highlights-btn" class="zipper-icon-toggle ${isHighlightEnabled ? 'active' : ''}" title="Toggle DOM Highlights">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                        </svg>
                    </button>
                    <button id="zipper-upscale-toggle-btn" class="zipper-icon-toggle" title="Toggle Image Upscaling (4x AI)" disabled>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M7.5 5.6L10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8l-2.5-1.4L14 15.4l1.4-2.5L14 10.4l2.5 1.4 2.5-1.4-1.4 2.5zM20 2l-1.4 2.5L20 7l-2.5-1.4L15 7l1.4-2.5L15 2l2.5 1.4zm-9.5 9.5l-6 6-.7-.7 6-6zm4.2-2.8l-1.4-1.4-1.4 1.4 1.4 1.4z"/>
                        </svg>
                    </button>
                </div>
            </div>
            <button id="zipper-abort-btn">Abort</button>
            <button id="zipper-close-btn">&times;</button>
        `;
        panel.appendChild(header);

        // --- Tabs ---
        const tabs = document.createElement('div');
        tabs.className = 'zipper-tabs';
        tabs.innerHTML = `
            <button class="zipper-tab-btn active" data-tab="images">Media Pipeline</button>
            <button class="zipper-tab-btn" data-tab="links">Cloud / Upload</button>
            <button class="zipper-tab-btn" data-tab="dashboard">Dashboard</button>
        `;
        panel.appendChild(tabs);

        // --- Main Content Area ---
        const content = document.createElement('div');
        content.className = 'zipper-content';
        panel.appendChild(content);

        // --- Console ---
        const consolePanel = document.createElement('div');
        consolePanel.id = 'zipper-console';
        panel.appendChild(consolePanel);

        function logToConsole(message, type = '') {
            const line = document.createElement('div');
            line.className = `console-line ${type ? 'console-' + type : ''}`;
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            line.textContent = `[${time}] ${message}`;
            consolePanel.appendChild(line);
            consolePanel.scrollTop = consolePanel.scrollHeight;
        }

        function flashFab() {
            fab.classList.remove('zipper-fab-flash');
            void fab.offsetWidth; // force reflow
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
                if (serverOnline) {
                    const response = await makeGMRequest("http://100.67.25.118:9001/download", "POST", {
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
                // Fallback: Browser download
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
                // Try simple link download fallback
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
            const highlightEnabled = localStorage.getItem('zipper-highlight-enabled') !== 'false';
            if (!highlightEnabled) {
                floatBtn.style.display = 'none';
                return;
            }

            const target = e.target.closest('.zipper-captured-highlight');
            if (target) {
                activeHoveredElement = target;
                let url = target.src || target.getAttribute('data-src') || target.href;
                if (!url && target.tagName.toLowerCase() === 'video') {
                    const srcEl = target.querySelector('source');
                    if (srcEl) url = srcEl.src;
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
            <div class="zipper-select-all-group">
                <label><input type="checkbox" id="zipper-media-select-all" checked> Media Links (<span id="zipper-media-count">0</span>)</label>
            </div>
            <div id="zipper-media-list" class="zipper-link-list"></div>
            <div style="display: flex; gap: 8px; align-items: flex-end;">
                <div class="zipper-input-group" style="flex: 1; margin: 0; min-width: 0;">
                    <label style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Filter / Selector</label>
                    <input type="text" id="zipper-selector" class="zipper-input" placeholder="Filter or CSS selector..." style="width: 100%; box-sizing: border-box; height: 32px; padding: 4px 8px;">
                </div>
                <div class="zipper-input-group" style="width: 110px; margin: 0; flex-shrink: 0;">
                    <label>AI Model</label>
                    <select id="zipper-upscale-model" class="zipper-input" style="width: 100%; font-size: 11px; height: 32px; padding: 4px; box-sizing: border-box;">
                        <option value="4xNomos8k_atd">Nomos8k</option>
                    </select>
                </div>
            </div>
            <button id="zipper-scrape-btn" class="zipper-btn" style="margin-top: 4px;">
                <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
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

        // --- Dashboard Section ---
        const dashboardSection = document.createElement('div');
        dashboardSection.className = 'zipper-panel-section';
        dashboardSection.id = 'section-dashboard';
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

        const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');
        jobsListContainer.onclick = async (e) => {
            const openFileBtn = e.target.closest('.zipper-open-btn');
            const openFolderBtn = e.target.closest('.zipper-open-folder-btn');
            if (openFileBtn) {
                const filename = openFileBtn.getAttribute('data-file');
                await makeGMRequest("http://100.67.25.118:9001/api/open-downloaded", "POST", { filename });
            } else if (openFolderBtn) {
                await makeGMRequest("http://100.67.25.118:9001/api/open-downloaded", "POST", { folder: true });
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

        // --- CSS Selector / Text Filter for Media List ---
        const selectorInput = imagesSection.querySelector('#zipper-selector');
        selectorInput.addEventListener('input', () => {
            const query = selectorInput.value.trim();
            const items = mediaListContainer.querySelectorAll('.zipper-link-item');

            if (!query) {
                items.forEach(item => item.style.display = '');
                return;
            }

            // Try as CSS selector first to get matching URLs from the page
            let selectorMatchedUrls = null;
            try {
                const matched = document.querySelectorAll(query);
                if (matched.length > 0) {
                    selectorMatchedUrls = new Set();
                    matched.forEach(el => {
                        const src = el.src || el.getAttribute('data-src') || el.href || '';
                        if (src) selectorMatchedUrls.add(src);
                    });
                }
            } catch (_e) { /* not a valid selector, use as text filter */ }

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
                const lower = url.toLowerCase();
                const isCloud = cloudDomains.some(domain => lower.includes(domain));
                const isMedia = mediaDomains.some(domain => lower.includes(domain)) ||
                    /\.(jpg|jpeg|png|gif|webp|svg)/i.test(lower);

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

        // --- Interactivity & Event Binding ---

        // Toggle Expand (click only, not drag)
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
            if (serverOnline) {
                try {
                    const response = await makeGMRequest("http://100.67.25.118:9001/api/abort", "POST");
                    if (response.ok) {
                        logToConsole("[Server] Cancellation command sent.", "info");
                    } else {
                        logToConsole("[Server] Failed to send abort command.", "error");
                    }
                } catch (err) {
                    logToConsole("[Server] Abort request failed: " + err.message, "error");
                }
            } else {
                logToConsole("[Server] Server offline. Cannot abort remote task.", "warning");
            }
        };

        const toggleHighlightsBtn = header.querySelector('#zipper-toggle-highlights-btn');
        toggleHighlightsBtn.onclick = () => {
            const enabled = !toggleHighlightsBtn.classList.contains('active');
            toggleHighlightsBtn.classList.toggle('active', enabled);
            localStorage.setItem('zipper-highlight-enabled', enabled);
            if (enabled) {
                refreshHarvestedLinks();
            } else {
                document.querySelectorAll('.zipper-captured-highlight').forEach(el => {
                    el.classList.remove('zipper-captured-highlight');
                });
            }
        };

        // Load saved preferences for upscaling and set event listeners
        const savedUpscaleEnabled = localStorage.getItem('zipper-upscale-enabled') === 'true';
        const savedUpscaleModel = localStorage.getItem('zipper-upscale-model') || '4xNomos8k_atd';

        // Set initial values (need to wait for elements to be created, so do this later)
        setTimeout(() => {
            const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
            const upscaleModelSelect = document.getElementById('zipper-upscale-model');

            if (upscaleBtn) {
                upscaleBtn.classList.toggle('active', savedUpscaleEnabled);
                upscaleBtn.onclick = () => {
                    const enabled = !upscaleBtn.classList.contains('active');
                    upscaleBtn.classList.toggle('active', enabled);
                    localStorage.setItem('zipper-upscale-enabled', enabled);
                };
            }

            if (upscaleModelSelect) {
                upscaleModelSelect.value = savedUpscaleModel;
                upscaleModelSelect.onchange = (e) => {
                    localStorage.setItem('zipper-upscale-model', e.target.value);
                };
            }
        }, 100);

        // Tab Switching
        let dashboardPollInterval = null;

        async function refreshJobs() {
            if (!serverOnline) return;
            try {
                const response = await makeGMRequest("http://100.67.25.118:9001/api/jobs", "GET");
                if (response.ok) {
                    const data = await response.json();
                    const jobs = data.jobs || {};
                    const jobsListContainer = dashboardSection.querySelector('#zipper-jobs-list');
                    const jobKeys = Object.keys(jobs);
                    if (jobKeys.length === 0) {
                        jobsListContainer.innerHTML = '<div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>';
                    } else {
                        // Sort by created_at descending
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
                                                    <a href="http://100.67.25.118:9001/downloaded/${encodeURIComponent(arch)}" target="_blank" class="zipper-btn" style="text-decoration: none; padding: 2px 6px; font-size: 9px; height: 18px; line-height: 18px; font-weight: normal; background: var(--zipper-primary); color: #fff; box-shadow: none; border: none; border-radius: 0;">
                                                        View ${arch.split('_').pop() || 'File'}
                                                    </a>
                                                    <button class="zipper-open-btn zipper-btn" data-file="${arch}" title="Locate in Desktop Explorer" style="padding: 2px 4px; font-size: 9px; height: 18px; font-weight: normal; background: rgba(255,255,255,0.08); border: none; border-left: 1px solid var(--zipper-border); border-radius: 0; box-shadow: none;">
                                                        📂
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
            } catch (err) {
                console.error("Failed to fetch jobs:", err);
            }
        }

        dashboardSection.querySelector('#zipper-refresh-jobs').onclick = refreshJobs;

        const tabBtns = tabs.querySelectorAll('.zipper-tab-btn');
        tabBtns.forEach(btn => {
            btn.onclick = () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const targetTab = btn.getAttribute('data-tab');
                content.querySelectorAll('.zipper-panel-section').forEach(sec => sec.classList.remove('active'));
                content.querySelector(`#section-${targetTab}`).classList.add('active');

                // Toggle polling based on tab
                if (targetTab === 'dashboard') {
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

        // Throttled/debounced MutationObserver to auto-scan DOM for new elements
        let scanThrottleTimeout = null;
        let lastScanTime = 0;

        function scheduleScan() {
            const now = Date.now();
            const timeSinceLastScan = now - lastScanTime;

            if (scanThrottleTimeout) return; // Already scheduled

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
            // Check if any mutation occurred outside of our own controls to prevent feedback loops
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

        // Draggable Panel Handler
        let isDragging = false;
        let dragTarget = null; // 'panel' or 'fab'
        let startX, startY, startRight, startBottom;

        function stopDrag() {
            if (isDragging) {
                isDragging = false;
                dragTarget = null;
                document.body.style.userSelect = '';
            }
        }

        header.addEventListener('mousedown', (e) => {
            // Ignore if clicking on buttons, inputs, labels, switches, or checkbox sliders
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

        // FAB draggable
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

            // Only mark as a drag (not a click) if mouse moved > 4px
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                fabDragged = true;
            }

            const margin = 10;

            if (dragTarget === 'panel') {
                let right = startRight - dx;
                let bottom = startBottom - dy;
                const panelWidth = panel.offsetWidth || 350;
                const panelHeight = panel.offsetHeight || 520;

                // Edge snapping and clamping with 10px margin (top boundary protects bookmarks/nav bar)
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

        // Capture-phase mouseup to guarantee we catch it even if panel swallows the event
        document.addEventListener('mouseup', stopDrag, true);
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('blur', stopDrag);

        // ESC key fallback to kill stuck drags
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isDragging) {
                stopDrag();
            }
        }, true);

        // Live Server Status Tracker
        const statusDot = fab.querySelector('#zipper-status-dot');
        let upscalerAvailable = false;

        async function updateStatus() {
            const online = await checkServerStatus();
            serverOnline = online;
            const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
            if (online) {
                statusDot.classList.add('online');
                if (statusDot.title !== 'Server Online') {
                    statusDot.title = 'Server Online';
                    logToConsole('Connection established with VaultWares API on 9001', 'success');
                }

                // Check upscaler status
                try {
                    const upscalerRes = await makeGMRequest("http://100.67.25.118:9001/api/upscaler/status", "GET");
                    if (upscalerRes.ok) {
                        const upscalerData = upscalerRes.json();
                        upscalerAvailable = upscalerData.available;
                        if (upscaleBtn) {
                            if (upscalerAvailable) {
                                upscaleBtn.removeAttribute('disabled');
                                upscaleBtn.title = `Toggle Image Upscaling (using ${upscalerData.models.join(', ')})`;
                            } else {
                                upscaleBtn.classList.remove('active');
                                upscaleBtn.setAttribute('disabled', 'true');
                                upscaleBtn.title = `Upscaler Unavailable: ${upscalerData.error || 'No models or CUDA unavailable'}`;
                            }
                        }
                    }
                } catch (err) {
                    console.error("Failed to query upscaler status", err);
                }
            } else {
                statusDot.classList.remove('online');
                if (statusDot.title !== 'Server Offline') {
                    statusDot.title = 'Server Offline';
                    logToConsole('VaultWares API offline on port 9001. Using local fallback.', 'error');
                }
                upscalerAvailable = false;
                if (upscaleBtn) {
                    upscaleBtn.classList.remove('active');
                    upscaleBtn.setAttribute('disabled', 'true');
                    upscaleBtn.title = 'Upscaler Unavailable (Server Offline)';
                }
            }
        }
        updateStatus();
        setInterval(updateStatus, 5000);

        // --- Drag and Drop File/URL Reader ---
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

        // Safe dismiss handlers for drag abort/drop outside
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
                            const matched = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi) || [];
                            links = links.concat(matched);
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
                doc.querySelectorAll('a').forEach(a => { if (a.href) links.push(a.href); });
                doc.querySelectorAll('img').forEach(img => { if (img.src) links.push(img.src); });
            }

            if (text) {
                const matched = text.match(/https?:\/\/[^\s"'<>\(\)]+/gi) || [];
                links = links.concat(matched);
            }

            links = [...new Set(links.filter(url => url && (url.startsWith('http') || url.indexOf("//") !== -1)))];

            if (links.length > 0) {
                logToConsole(`[Drop] Extracted ${links.length} unique URLs!`, 'info');
                addDroppedLinks(links);
                tabBtns[1].click();
            } else {
                logToConsole('[Drop] No valid URLs found in dropped data.', 'error');
            }
        });

        // --- Action Scripts Execution ---

        // Scrape & Download Media Action
        const scrapeBtn = imagesSection.querySelector('#zipper-scrape-btn');
        scrapeBtn.onclick = async () => {
            const checkedBoxes = Array.from(imagesSection.querySelectorAll('.zipper-media-checkbox:checked'));
            let urls = checkedBoxes.map(cb => cb.getAttribute('data-url'));

            let selVal = selectorInput.value.trim();
            if (selVal) {
                let container = document;
                if (document.querySelector(selVal)) {
                    container = document.querySelector(selVal);
                    logToConsole(`[Media] Scrape targeted to container: "${selVal}"`);
                }
                let nodes = container.querySelectorAll('img, video, source');
                let rawUrls = Array.from(nodes).map(el => {
                    return el.href || el.src || el.getAttribute('data-src') || el.srcset || el.getAttribute('srcset');
                }).map(url => {
                    if (url && url.includes(',')) {
                        return url.split(',').pop().trim().split(' ')[0];
                    }
                    return url;
                });
                let extraUrls = [...new Set(rawUrls.filter(url => url && (url.startsWith('http') || url.indexOf("//") !== -1)))];
                urls = [...new Set([...urls, ...extraUrls])];
            }

            if (urls.length === 0) {
                logToConsole('[Media] No media links selected.', 'error');
                return;
            }

            scrapeBtn.disabled = true;
            logToConsole(`[Media] Sending ${urls.length} media files to VaultWares API...`, 'info');

            // Get upscaling config
            const upscaleBtn = document.getElementById('zipper-upscale-toggle-btn');
            const upscaleEnabled = upscaleBtn ? upscaleBtn.classList.contains('active') : false;
            const upscaleModel = document.getElementById('zipper-upscale-model').value;

            if (serverOnline) {
                try {
                    const response = await makeGMRequest("http://100.67.25.118:9001/download", "POST", {
                        url: window.location.href,
                        links: urls,
                        batch_size: 5,
                        upscale_enabled: upscaleEnabled,
                        upscale_model: upscaleModel
                    });

                    if (response.ok) {
                        let data;
                        try {
                            data = await response.json();
                            logToConsole(`[Server] Success: Sent ${urls.length} media files to pipeline.`, 'success');
                            if (data.correlationId) {
                                logToConsole(`[Server] Job ID: ${data.correlationId}`, 'info');
                            }
                        } catch (e) {
                            logToConsole(`[Server] Success: Sent ${urls.length} media files to pipeline.`, 'success');
                        }
                        flashFab();
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
            const checkedBoxes = Array.from(linksSection.querySelectorAll('.zipper-cloud-checkbox:checked'));
            let links = checkedBoxes.map(cb => cb.getAttribute('data-url'));

            const rawText = linksInput.value.trim();
            if (rawText) {
                const manualLinks = [...new Set(rawText.split('\n').map(l => l.trim()).filter(l => l.startsWith('http') || l.indexOf("//") !== -1))];
                links = [...new Set([...links, ...manualLinks])];
            }

            if (links.length === 0) {
                logToConsole('[Upload] No cloud links selected or manually input.', 'error');
                return;
            }

            sendBtn.disabled = true;
            logToConsole(`[Upload] Sending ${links.length} link(s) to pipeline...`, 'info');

            if (serverOnline) {
                try {
                    const response = await makeGMRequest("http://100.67.25.118:9001/download", "POST", {
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
        let h = 120, s = 80, l = 75; // Default HSL values (vibrant green)
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
