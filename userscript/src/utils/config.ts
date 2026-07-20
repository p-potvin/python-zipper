export function getZipperSetting(key: string, fallbackValue: any): string {
    const storageKey = `zipper-${key}`;
    try {
        const value = GM_getValue(storageKey, undefined);
        if (value !== undefined && value !== null) return String(value);
    } catch (_e) { }
    try {
        const legacyValue = localStorage.getItem(storageKey);
        if (legacyValue !== null) {
            try { GM_setValue(storageKey, legacyValue); } catch (_e) { }
            return legacyValue;
        }
    } catch (_e) { }
    return String(fallbackValue);
}

export function setZipperSetting(key: string, value: any): void {
    const storageKey = `zipper-${key}`;
    const normalized = String(value);
    try { GM_setValue(storageKey, normalized); } catch (_e) { }
    try { localStorage.setItem(storageKey, normalized); } catch (_e) { }
}

export let logToConsole = (msg: string, type = "INFO") => {
    console.log(`[${type}] ${msg}`);
};

export function setLogToConsole(fn: (msg: string, type?: string) => void) {
    logToConsole = fn;
}
