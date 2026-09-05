import test from 'node:test';
import assert from 'node:assert/strict';
import { getConnectionManagerProfiles, normalizeProviderProfiles, resolveModuleProvider } from '../provider-profiles.js';

test('normalizes independent OpenAI-compatible profiles and preserves module separation', () => {
    const profiles = normalizeProviderProfiles([{ id: 'writer', type: 'direct', name: '写作模型', url: 'https://api.example/v1', apiKey: 'secret', model: 'writer-1' }]);
    assert.equal(profiles[0].kind, 'openai-compatible');
    assert.equal(profiles[0].baseUrl, 'https://api.example/v1');
    const settings = { apiProfiles: profiles, moduleConnections: { memory: 'tavern-current', director: 'writer', reply: 'tavern-current' } };
    assert.equal(resolveModuleProvider(settings, 'director').model, 'writer-1');
    assert.equal(resolveModuleProvider(settings, 'memory').kind, 'tavern-current');
});

test('resolves a selected Connection Manager profile when available', () => {
    const ctx = { extensionSettings: { connectionManager: { profiles: [{
        id: 'cm1', name: 'Claude', api: 'openai', 'api-url': 'https://api.example/v1/', api_key: 'secret', 'secret-id': 'secret-1', model: 'claude-3', context_length: 200000, max_tokens: 8192,
    }] } } };
    const profiles = getConnectionManagerProfiles(ctx);
    assert.equal(profiles[0].baseUrl, 'https://api.example/v1');
    assert.equal(profiles[0].apiKey, 'secret');
    assert.equal(profiles[0].model, 'claude-3');
    assert.equal(profiles[0].contextTokens, 200000);
    assert.equal(profiles[0].outputTokens, 8192);
    assert.equal(profiles[0].apiType, 'openai');
    assert.equal(profiles[0].secretId, 'secret-1');
    const provider = resolveModuleProvider({ moduleConnections: { director: 'connection:cm1' } }, 'director', ctx);
    assert.equal(provider.kind, 'connection');
    assert.equal(provider.profileId, 'cm1');
    assert.equal(provider.baseUrl, 'https://api.example/v1');
    assert.equal(provider.model, 'claude-3');
});

test('lets each module override a Connection Manager model after pulling the model list', () => {
    const ctx = {
        extensionSettings: {
            connectionManager: { profiles: [{ id: 'cm1', name: 'Claude', model: 'old-model' }] },
        },
    };
    const provider = resolveModuleProvider({
        moduleConnections: { memory: 'connection:cm1' },
        moduleModels: { memory: 'claude-fable-5' },
    }, 'memory', ctx);
    assert.equal(provider.model, 'claude-fable-5');
});
