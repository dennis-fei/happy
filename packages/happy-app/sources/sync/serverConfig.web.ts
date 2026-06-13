// Web platform version of serverConfig — uses localStorage instead of MMKV

const SERVER_KEY = 'happy:custom-server-url';
const LOG_SERVER_KEY = 'happy:log-server-url';
const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

export function getServerUrl(): string {
    try {
        return localStorage.getItem(SERVER_KEY) ||
               (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||
               process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
               DEFAULT_SERVER_URL;
    } catch {
        return process.env.EXPO_PUBLIC_HAPPY_SERVER_URL || DEFAULT_SERVER_URL;
    }
}

export function setServerUrl(url: string | null): void {
    try {
        if (url && url.trim()) {
            localStorage.setItem(SERVER_KEY, url.trim());
        } else {
            localStorage.removeItem(SERVER_KEY);
        }
    } catch { /* ignore */ }
}

export function getLogServerUrl(): string | null {
    try {
        return localStorage.getItem(LOG_SERVER_KEY) ||
               process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
               null;
    } catch {
        return null;
    }
}

export function setLogServerUrl(url: string | null): void {
    try {
        if (url && url.trim()) {
            localStorage.setItem(LOG_SERVER_KEY, url.trim());
        } else {
            localStorage.removeItem(LOG_SERVER_KEY);
        }
    } catch { /* ignore */ }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return { hostname: parsed.hostname, port, isCustom };
    } catch {
        return { hostname: url, port: undefined, isCustom };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
