import { rgbToHsl, generatePalette, getAverageColor } from './theme_palette';
export { rgbToHsl, generatePalette, getAverageColor };

export function injectStyles(pal) {
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
                width: 320px;
                height: 440px;
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
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
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
                height: 50px;
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
                height: 80px;
                min-height: 40px;
                background: rgba(0, 0, 0, 0.3);
                border-top: 1px solid var(--zipper-border);
                padding: 6px 10px;
                overflow-y: auto;
                resize: vertical;
                font-family: 'Jetbrains Mono', monospace;
                font-size: 9px;
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

            #zipper-panel,
            #zipper-panel * {
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

            .zipper-captured-highlight {
                outline: 2px dashed var(--zipper-primary) !important;
                outline-offset: -2px !important;
                box-shadow: 0 0 10px var(--zipper-primary) !important;
                transition: outline 0.3s ease, box-shadow 0.3s ease !important;
            }

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

