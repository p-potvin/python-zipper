let activeApiOrigin: string | null = null;

export class Api {
    static endpoints = Object.freeze({
        primary: "http://127.0.0.1:5171",
        local: "http://127.0.0.1:5171",
        localhost: "http://localhost:5171"
    });

    static routes = Object.freeze({
        root: "/",
        users: "/users",
        download: "/download",
        health: "/health",
        abort: "/api/abort",
        jobs: "/api/jobs",
        openDownloaded: "/api/open-downloaded",
        upscalerStatus: "/api/upscaler/status"
    });

    static get origin(): string {
        return activeApiOrigin || this.endpoints.local;
    }

    static getRouteUrl(routeKey: keyof typeof Api.routes, endpointKey: keyof typeof Api.endpoints | null = null): string {
        const path = this.routes[routeKey];
        if (path === undefined) {
            throw new Error(`Invalid route key: "${String(routeKey)}"`);
        }
        const origin = endpointKey ? this.endpoints[endpointKey] : this.origin;
        if (!origin) {
            throw new Error(`Invalid endpoint key: "${String(endpointKey)}"`);
        }
        return `${origin}${path}`;
    }

    static async send(routeKey: keyof typeof Api.routes, method = "GET", data: any = null, endpointKey: keyof typeof Api.endpoints | null = null): Promise<any> {
        try {
            const url = this.getRouteUrl(routeKey, endpointKey);
            const response = await makeGMRequest(url, method, data);
            response.endpointKey = endpointKey;
            response.origin = endpointKey ? this.endpoints[endpointKey] : this.origin;
            return response;
        } catch (error) {
            console.error(`[API Engine Error] Route: ${String(routeKey)}, Method: ${method}`, error);
            return { ok: false, status: 0 };
        }
    }

    static async sendWithFallback(routeKey: keyof typeof Api.routes, method = "GET", data: any = null, endpointKeys: (keyof typeof Api.endpoints)[] = ["primary", "local", "localhost"]): Promise<any> {
        let lastResponse = { ok: false, status: 0 };
        for (const endpointKey of endpointKeys) {
            const response = await this.send(routeKey, method, data, endpointKey);
            lastResponse = response;
            if (response.ok) {
                activeApiOrigin = this.endpoints[endpointKey];
                return response;
            }
        }
        return lastResponse;
    }

    static async checkServerStatus(): Promise<boolean> {
        const res = await this.sendWithFallback("health", "GET");
        return res.ok;
    }
}

// Privileged request helper to bypass CORS and Mixed Content restrictions
export function makeGMRequest(url: string, method = "GET", data: any = null): Promise<any> {
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
                        resolve({
                            ok: true,
                            status: res.status,
                            json: () => JSON.parse(res.responseText),
                            text: () => res.responseText
                        });
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
