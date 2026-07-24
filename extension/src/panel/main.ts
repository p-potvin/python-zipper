// @ts-nocheck -- vendored verbatim from ../../userscript/src; built by esbuild, not type-checked
// Extension entry for the ported panel. The original userscript main.ts also
// contained duplicate copies of harvest/zip logic and an auto-run bootstrap;
// those are dropped here. The content script calls `start()` after the GM shim
// and vendor globals are installed. `showBrowserNotification` is kept because
// ui/panel.ts imports it.
import { rgbToHsl, generatePalette, getAverageColor, injectStyles } from './ui/theme';
import { initUI } from './ui/panel';

export function showBrowserNotification(title: string, body: string) {
    if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
            new Notification(title, { body });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification(title, { body });
                }
            });
        }
    }
}

export async function start() {
    const avgColor = await getAverageColor();
    const rgb = avgColor.match(/\d+/g);
    let h = 230, s = 80, l = 55;
    if (rgb && rgb.length >= 3) {
        [h, s, l] = rgbToHsl(Number(rgb[0]), Number(rgb[1]), Number(rgb[2]));
    }
    const pal = generatePalette(h, s, l);
    injectStyles(pal);
    initUI(pal);
}
