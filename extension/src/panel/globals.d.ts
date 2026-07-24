// Ambient globals for the ported userscript panel. At runtime these are
// provided by `src/shim/gm-shim.ts` (GM_*) and `src/content/vendors.ts`
// (zip, saveAs, unsafeWindow). This file is a script (no import/export), so the
// declarations are global and visible to every ported module.
declare const GM_xmlhttpRequest: any;
declare const GM_getValue: (key: string, def?: any) => any;
declare const GM_setValue: (key: string, val: any) => void;
declare const GM_deleteValue: (key: string) => void;
declare const GM_addStyle: (css: string) => any;
declare const GM_setClipboard: (text: string) => void;
declare const GM_registerMenuCommand: (name: string, fn: () => void) => void;
declare const GM_notification: (opts: any) => void;
declare const unsafeWindow: any;
declare const zip: any;
declare const saveAs: any;
