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

const CONNECTION_VALUE_KEYS = {
    apiType: ['api', 'apiType', 'api_type'],
    baseUrl: ['baseUrl', 'base_url', 'url', 'apiUrl', 'api_url', 'api-url', 'endpoint', 'serverUrl', 'server_url', 'customUrl', 'custom_url', 'chatCompletionUrl', 'chat_completion_url'],
    apiKey: ['apiKey', 'api_key', 'key', 'token', 'secret', 'accessToken', 'access_token', 'authToken', 'auth_token', 'password', 'proxyPassword', 'proxy_password', 'proxy_password_value'],
    secretId: ['secretId', 'secret_id', 'secret-id'],
    model: ['model', 'modelName', 'model_name', 'defaultModel', 'default_model', 'selectedModel', 'selected_model', 'chatCompletionModel', 'chat_completion_model'],
    contextTokens: ['contextTokens', 'context_tokens', 'contextLength', 'context_length', 'maxContext', 'max_context', 'maxContextTokens', 'max_context_tokens'],
    outputTokens: ['outputTokens', 'output_tokens', 'maxOutputTokens', 'max_output_tokens', 'maxTokens', 'max_tokens', 'maxNewTokens', 'max_new_tokens'],
    customIncludeHeaders: ['customIncludeHeaders', 'custom_include_headers', 'custom-include-headers'],
};

function connectionValue(profile, keys) {
    const sources = [profile, profile?.settings, profile?.config, profile?.connection, profile?.data];
    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        for (const key of keys) {
            const value = source[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') return value;
        }
    }
    return '';
}

/**
 * Connection Manager keeps provider details in its own profile objects. Keep
 * the normalized list backwards-compatible (id/name are always present) but
 * expose the fields the workbench can safely copy into its independent form.
 */
export function normalizeConnectionManagerProfile(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || '').trim();
    if (!id) return null;
    const name = String(value.name || value.title || value.model || id).trim();
    const result = { id, name };
    const apiType = String(connectionValue(value, CONNECTION_VALUE_KEYS.apiType) || '').trim();
    const baseUrl = String(connectionValue(value, CONNECTION_VALUE_KEYS.baseUrl) || '').trim().replace(/\/+$/, '');
    const apiKey = String(connectionValue(value, CONNECTION_VALUE_KEYS.apiKey) || '');
    const secretId = String(connectionValue(value, CONNECTION_VALUE_KEYS.secretId) || '').trim();
    const model = String(connectionValue(value, CONNECTION_VALUE_KEYS.model) || '').trim();
    const contextNumber = Number(connectionValue(value, CONNECTION_VALUE_KEYS.contextTokens));
    const outputNumber = Number(connectionValue(value, CONNECTION_VALUE_KEYS.outputTokens));
    const contextTokens = Number.isFinite(contextNumber) && contextNumber > 0 ? Math.round(contextNumber) : 0;
    const outputTokens = Number.isFinite(outputNumber) && outputNumber >= 128 ? Math.round(outputNumber) : 0;
    const customIncludeHeaders = String(connectionValue(value, CONNECTION_VALUE_KEYS.customIncludeHeaders) || '').trim();
    if (apiType) result.apiType = apiType;
    if (baseUrl) result.baseUrl = baseUrl;
    if (apiKey) result.apiKey = apiKey;
    if (secretId) result.secretId = secretId;
    if (model) result.model = model;
    if (contextTokens) result.contextTokens = contextTokens;
    if (outputTokens) result.outputTokens = outputTokens;
    if (customIncludeHeaders) result.customIncludeHeaders = customIncludeHeaders;
    if (value.stream !== undefined) result.stream = value.stream !== false;
    return result;
}

export function getConnectionManagerProfiles(ctx = {}) {
    const manager = ctx?.extensionSettings?.connectionManager;
    const profiles = Array.isArray(manager?.profiles) ? manager.profiles : [];
    return profiles.map(normalizeConnectionManagerProfile).filter(Boolean);
}

export function resolveModuleProvider(settings = {}, moduleName = 'memory', ctx = {}) {
    const choice = settings?.moduleConnections?.[moduleName] || PROVIDER_CURRENT;
    const moduleModel = String(settings?.moduleModels?.[moduleName] || '').trim();
    if (!choice || choice === PROVIDER_CURRENT || choice === 'tavern') return { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
    if (String(choice).startsWith('connection:')) {
        const profileId = String(choice).slice('connection:'.length).trim();
        const known = getConnectionManagerProfiles(ctx).find(profile => profile.id === profileId);
        return profileId ? {
            kind: 'connection',
            profileId,
            ...(known || {}),
            ...(moduleModel ? { model: moduleModel } : {}),
            name: known?.name || profileId,
        } : { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
    }
    const custom = normalizeProviderProfiles(settings.apiProfiles).find(profile => profile.id === choice);
    return custom || { kind: PROVIDER_CURRENT, name: '当前酒馆连接' };
}

export function providerChoiceValue(profile) {
    if (!profile || profile.kind === PROVIDER_CURRENT) return PROVIDER_CURRENT;
    if (profile.kind === 'connection') return `connection:${profile.profileId}`;
    return profile.id || PROVIDER_CURRENT;
}
