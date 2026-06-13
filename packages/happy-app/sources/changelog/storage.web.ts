// Web platform version — uses localStorage instead of MMKV

const LAST_VIEWED_KEY = 'changelog-last-viewed-title';

export function getLastViewedTitle(): string {
    try {
        return localStorage.getItem(LAST_VIEWED_KEY) ?? '';
    } catch {
        return '';
    }
}

export function setLastViewedTitle(title: string): void {
    try {
        localStorage.setItem(LAST_VIEWED_KEY, title);
    } catch { /* ignore */ }
}

export function hasUnreadChangelog(latestTitle: string): boolean {
    return latestTitle !== '' && latestTitle !== getLastViewedTitle();
}
