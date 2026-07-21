// Color palette utilities extracted from theme.ts

export function rgbToHsl(r, g, b) {
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

export function generatePalette(h, s, l) {
    const safeS = Math.max(45, Math.min(85, s));
    const safeL = Math.max(55, Math.min(75, l));

    const primary = `hsl(${h}, ${safeS}%, ${safeL}%)`;
    const opposite = `hsl(${(h + 180) % 360}, ${safeS}%, ${(safeL + 100) / 2}%)`;

    const analH = (h + 25) % 360;
    const secondary = `hsl(${analH}, ${safeS}%, ${safeL}%)`;

    const accentH = (h - 25 + 360) % 360;
    const accent = `hsl(${accentH}, ${Math.min(95, safeS + 10)}%, ${Math.min(80, safeL + 5)}%)`;

    const bgDark = `rgba(${Math.round(h / 15)}, 12, 24, 0.85)`;
    const bgHeader = `rgba(${Math.round(h / 12)}, 16, 32, 0.96)`;
    const bgCard = `rgba(255, 255, 255, 0.05)`;

    const border = `hsla(${h}, ${safeS}%, 55%, 0.25)`;
    const borderHover = `hsla(${h}, ${safeS}%, 70%, 0.48)`;

    const textMain = `#ffffff`;
    const textMuted = `#cbd5e1`;

    return { primary, opposite, secondary, accent, bgDark, bgHeader, bgCard, border, borderHover, textMain, textMuted };
}

export async function getAverageColor() {
    return new Promise((resolve) => {
        const getFallbackColor = () => {
            const bgColor = window.getComputedStyle(document.body).backgroundColor;
            if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') return bgColor;
            return 'rgb(99, 102, 241)';
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
