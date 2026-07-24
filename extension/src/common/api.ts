// Cross-browser WebExtension namespace. Firefox exposes `browser` (promise-based);
// Chrome exposes `chrome` (also promise-based for most APIs under MV3).
export const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;

export const IS_FIREFOX: boolean = typeof (globalThis as any).browser !== 'undefined';
