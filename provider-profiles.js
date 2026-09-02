export const PROVIDER_CURRENT = 'tavern-current';

export function cloneProviderProfile(value) {
    if (!value || typeof value !== 'object') return {};
    return { ...value };
}

export function normalizeProviderProfile(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = String(value.kind || value.type || '').toLowerCase();
    if (kind === 'connection' || kind === 'connection-profile') {
        const profileId = String(value.profileId || value.id || '').trim();
        return profileId ? { kind: 'connection', profileId, name: String(value.name || profileId) } : null;
    }
    if (kind === 'openai' || kind === 'openai-compatible' || kind === 'direct') {
        const baseUrl = String(value.baseUrl || value.url || '').trim().replace(/\/+$/, '');
        const model = String(value.model || '').trim();
        if (!baseUrl || !model) return null;
        return {
            kind: 'openai-compatible',
            id: String(value.id || '').trim(),
            name: String(value.name || model || baseUrl),
            baseUrl,
            apiKey: String(value.apiKey || ''),
            model,
            contextTokens: Math.max(0, Number(value.contextTokens || value.maxContext || 0) || 0),
            outputTokens: Math.max(128, Number(value.outputTokens || value.maxTokens || 4096) || 4096),
            temperature: Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : undefined,
            stream: value.stream !== false,
        };
    }
    return null;
}

export function normalizeProviderProfiles(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeProviderProfile).filter(Boolean).map((profile, index) => ({
        id: profile.id || `custom_${index + 1}`,
        ...profile,
    }));
}

export function getConnectionManagerProfiles(ctx = {}) {
    const manager = ctx?.extensionSettings?.connectionManager;
    const profiles = Array.isArray(manager?.profiles) ? manager.profiles : [];
    return profiles.map(profile => ({
        id: String(profile?.id || '').trim(),
        name: String(profile?.name || profile?.model || profile?.id || '').trim(),
    })).filter(profile => profile.id);
}

export function resolveModuleProvider(settings = {}, moduleName = 'memory', ctx = {}) {
    const choice = settings?.moduleConnections?.[moduleName] || PROVIDER_CURRENT;
    if (!choice || choice === PROVIDER_CURRENT || choice === 'tavern') return { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
    if (String(choice).startsWith('connection:')) {
        const profileId = String(choice).slice('connection:'.length).trim();
        const known = getConnectionManagerProfiles(ctx).find(profile => profile.id === profileId);
        return profileId ? { kind: 'connection', profileId, name: known?.name || profileId } : { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
    }
    const custom = normalizeProviderProfiles(settings.apiProfiles).find(profile => profile.id === choice);
    return custom || { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
}

export function providerChoiceValue(profile) {
    if (!profile || profile.kind === PROVIDER_CURRENT) return PROVIDER_CURRENT;
    if (profile.kind === 'connection') return `connection:${profile.profileId}`;
    return profile.id || PROVIDER_CURRENT;
}

