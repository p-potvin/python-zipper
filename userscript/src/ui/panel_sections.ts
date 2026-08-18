import { getZipperSetting } from '../utils/config';

export function isHighlightEnabled() {
    return getZipperSetting('highlight-enabled', 'true') !== 'false';
}

export function createImagesSection() {
    const section = document.createElement('div');
    section.className = 'zipper-panel-section active';
    section.id = 'section-images';
    section.innerHTML = `
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
    return section;
}

export function createLinksSection() {
    const section = document.createElement('div');
    section.className = 'zipper-panel-section';
    section.id = 'section-links';
    section.style.display = 'none';
    section.innerHTML = `
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
    return section;
}

export function createSmartGallerySection() {
    const section = makeSection('zipper-panel-section', 'section-smart-gallery', `
        <div style="display: flex; gap: 8px; align-items: flex-end; margin-bottom: 4px;">
            <div class="zipper-input-group" style="flex: 1; margin: 0; min-width: 0;">
                <label style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Gallery Container Selector</label>
                <div style="display: flex; gap: 4px; align-items: center;">
                    <input type="text" id="zipper-gallery-selector" class="zipper-input" placeholder="e.g. .user_posts" style="flex: 1; box-sizing: border-box; height: 26px; padding: 2px 6px; font-size: 11px;">
                    <button id="zipper-gallery-picker-btn" class="zipper-btn" title="Pick element on page" style="height: 26px; width: 26px; padding: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(255,255,255,0.08); border: 1px solid var(--zipper-border);">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="22" y1="12" x2="18" y2="12"></line>
                            <line x1="6" y1="12" x2="2" y2="12"></line>
                            <line x1="12" y1="6" x2="12" y2="2"></line>
                            <line x1="12" y1="22" x2="12" y2="18"></line>
                        </svg>
                    </button>
                </div>
            </div>
            <button id="zipper-smart-gallery-btn" class="zipper-btn" style="height: 26px; padding: 2px 8px; font-size: 11px; flex-shrink: 0; background: var(--zipper-secondary);">
                Smart Gallery Zip
            </button>
        </div>
    `);
    section.style.display = 'none';
    return section;
}

export function createDashboardSection() {
    const section = document.createElement('div');
    section.className = 'zipper-panel-section';
    section.id = 'section-dashboard';
    section.style.display = 'none';
    section.innerHTML = `
        <div class="zipper-select-all-group">
            <label>Active Pipeline Jobs</label>
            <button id="zipper-refresh-jobs" class="zipper-btn" style="padding: 2px 6px; font-size: 10px;">Refresh</button>
        </div>
        <div id="zipper-jobs-list" class="zipper-link-list" style="max-height: 250px; flex: 1;">
            <div style="font-size: 11px; padding: 10px; text-align: center; color: var(--zipper-text-muted);">No active or recent jobs found.</div>
        </div>
    `;
    return section;
}

export function createHeader() {
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
    return header;
}

export function createTabs() {
    const tabs = document.createElement('div');
    tabs.className = 'zipper-tabs';
    tabs.innerHTML = `
        <button class="zipper-tab-btn active" data-tab="images">Media</button>
        <button class="zipper-tab-btn" data-tab="links">Cloud</button>
        <button class="zipper-tab-btn" data-tab="smart-gallery">Smart</button>
        <button class="zipper-tab-btn" data-tab="dashboard">Jobs</button>
    `;
    return tabs;
}

export function createDropOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'zipper-drop-overlay';
    overlay.innerHTML = `
        <svg viewBox="0 0 24 24">
            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
        </svg>
        <div style="font-weight: bold; font-size: 14px;">Drop links to queue</div>
    `;
    return overlay;
}
