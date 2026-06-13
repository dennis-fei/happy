// Web platform version of persistence — uses localStorage instead of MMKV
import { Settings, settingsDefaults, settingsParse, settingsToSyncPayload, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from './purchases';
import { Profile, profileDefaults, profileParse } from './profile';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

// Simple localStorage wrapper matching MMKV API shape
const store = {
    getString: (key: string): string | undefined => localStorage.getItem(key) ?? undefined,
    set: (key: string, value: string | number) => localStorage.setItem(key, String(value)),
    delete: (key: string) => localStorage.removeItem(key),
    getNumber: (key: string): number | undefined => {
        const v = localStorage.getItem(key);
        if (v === null) return undefined;
        const n = Number(v);
        return isNaN(n) ? undefined : n;
    },
    clearAll: () => localStorage.clear(),
};

const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';
const REGISTERED_PUSH_TOKEN_KEY = 'registered-push-token-v1';
const VOICE_SOFT_PAYWALL_SHOWN_KEY = 'voice-soft-paywall-shown';
const VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY = 'voice-onboarding-prompt-load-count';
const VOICE_MESSAGE_COUNT_KEY = 'voice-message-count';

export type NewSessionAgentType = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'apichat';
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey;
    modelMode: string;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    updatedAt: number;
}

export function loadSettings(): { settings: Settings, version: number | null } {
    const settings = store.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            return { settings: settingsParse(parsed.settings), version: parsed.version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    store.set('settings', JSON.stringify({ settings: settingsToSyncPayload(settings), version }));
}

export function loadPendingSettings(): Partial<Settings> {
    const pending = store.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending);
            return SettingsSchema.partial().parse(parsed);
        } catch (e) {
            console.error('Failed to parse pending settings', e);
            return {};
        }
    }
    return {};
}

export function savePendingSettings(settings: Partial<Settings>) {
    store.set('pending-settings', JSON.stringify(settings));
}

export function loadLocalSettings(): LocalSettings {
    const localSettings = store.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return localSettingsParse(parsed);
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    store.set('local-settings', JSON.stringify(settings));
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    const localSettings = store.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePreference;
        } catch (e) {
            console.error('Failed to parse local settings for theme preference', e);
            return localSettingsDefaults.themePreference;
        }
    }
    return localSettingsDefaults.themePreference;
}

export function loadPurchases(): Purchases {
    const purchases = store.getString('purchases');
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases', e);
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    store.set('purchases', JSON.stringify(purchases));
}

export function loadSessionDrafts(): Record<string, string> {
    const drafts = store.getString('session-drafts');
    if (drafts) {
        try {
            return JSON.parse(drafts);
        } catch (e) {
            console.error('Failed to parse session drafts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>) {
    store.set('session-drafts', JSON.stringify(drafts));
}

export function loadNewSessionDraft(): NewSessionDraft | null {
    const raw = store.getString(NEW_SESSION_DRAFT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
        const agentType: NewSessionAgentType =
            parsed.agentType === 'codex' || parsed.agentType === 'gemini' ||
            parsed.agentType === 'openclaw' || parsed.agentType === 'apichat'
                ? parsed.agentType : 'claude';
        const permissionMode: PermissionModeKey =
            typeof parsed.permissionMode === 'string' ? parsed.permissionMode : 'default';
        const modelMode: string = typeof parsed.modelMode === 'string' ? parsed.modelMode : 'default';
        const sessionType: NewSessionSessionType = parsed.sessionType === 'worktree' ? 'worktree' : 'simple';
        const worktreeKey = typeof parsed.worktreeKey === 'string' ? parsed.worktreeKey : null;
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        return { input, selectedMachineId, selectedPath, agentType, permissionMode, modelMode, sessionType, worktreeKey, updatedAt };
    } catch (e) {
        console.error('Failed to parse new session draft', e);
        return null;
    }
}

export function saveNewSessionDraft(draft: NewSessionDraft) {
    store.set(NEW_SESSION_DRAFT_KEY, JSON.stringify(draft));
}

export function clearNewSessionDraft() {
    store.delete(NEW_SESSION_DRAFT_KEY);
}

export function loadRegisteredPushToken(): string | null {
    return store.getString(REGISTERED_PUSH_TOKEN_KEY) ?? null;
}

export function saveRegisteredPushToken(token: string) {
    store.set(REGISTERED_PUSH_TOKEN_KEY, token);
}

export function clearRegisteredPushToken() {
    store.delete(REGISTERED_PUSH_TOKEN_KEY);
}

export function loadSessionPermissionModes(): Record<string, string> {
    const modes = store.getString('session-permission-modes');
    if (modes) {
        try { return JSON.parse(modes); } catch (e) { return {}; }
    }
    return {};
}

export function saveSessionPermissionModes(modes: Record<string, string>) {
    store.set('session-permission-modes', JSON.stringify(modes));
}

export function loadSessionModelModes(): Record<string, string> {
    const modes = store.getString('session-model-modes');
    if (modes) {
        try { return JSON.parse(modes); } catch (e) { return {}; }
    }
    return {};
}

export function saveSessionModelModes(modes: Record<string, string>) {
    store.set('session-model-modes', JSON.stringify(modes));
}

export function loadSessionEffortLevels(): Record<string, string> {
    const levels = store.getString('session-effort-levels');
    if (levels) {
        try { return JSON.parse(levels); } catch (e) { return {}; }
    }
    return {};
}

export function saveSessionEffortLevels(levels: Record<string, string>) {
    store.set('session-effort-levels', JSON.stringify(levels));
}

export function loadProfile(): Profile {
    const profile = store.getString('profile');
    if (profile) {
        try {
            const parsed = JSON.parse(profile);
            return profileParse(parsed);
        } catch (e) {
            console.error('Failed to parse profile', e);
            return { ...profileDefaults };
        }
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    store.set('profile', JSON.stringify(profile));
}

export function storeTempText(content: string): string {
    const id = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    store.set(`temp_text_${id}`, content);
    return id;
}

export function retrieveTempText(id: string): string | null {
    const content = store.getString(`temp_text_${id}`);
    if (content) {
        store.delete(`temp_text_${id}`);
        return content;
    }
    return null;
}

export function getVoiceSoftPaywallShownCount(): number {
    return store.getNumber(VOICE_SOFT_PAYWALL_SHOWN_KEY) ?? 0;
}

export function incrementVoiceSoftPaywallShown() {
    store.set(VOICE_SOFT_PAYWALL_SHOWN_KEY, getVoiceSoftPaywallShownCount() + 1);
}

export function getVoiceOnboardingPromptLoadCount(): number {
    return store.getNumber(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY) ?? 0;
}

export function incrementVoiceOnboardingPromptLoadCount() {
    store.set(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY, getVoiceOnboardingPromptLoadCount() + 1);
}

export function getVoiceMessageCount(): number {
    return store.getNumber(VOICE_MESSAGE_COUNT_KEY) ?? 0;
}

export function incrementVoiceMessageCount() {
    store.set(VOICE_MESSAGE_COUNT_KEY, getVoiceMessageCount() + 1);
}

export function getVoiceLocalCounters() {
    return {
        softPaywallShownCount: getVoiceSoftPaywallShownCount(),
        onboardingPromptLoadCount: getVoiceOnboardingPromptLoadCount(),
        voiceMessageCount: getVoiceMessageCount(),
    };
}

export function resetVoiceLocalCounters() {
    store.delete(VOICE_SOFT_PAYWALL_SHOWN_KEY);
    store.delete(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY);
    store.delete(VOICE_MESSAGE_COUNT_KEY);
}

export function clearPersistence() {
    store.clearAll();
}
