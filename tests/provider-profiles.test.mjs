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
    const ctx = { extensionSettings: { connectionManager: { profiles: [{ id: 'cm1', name: 'Claude' }] } } };
    assert.deepEqual(getConnectionManagerProfiles(ctx), [{ id: 'cm1', name: 'Claude' }]);
    const provider = resolveModuleProvider({ moduleConnections: { director: 'connection:cm1' } }, 'director', ctx);
    assert.equal(provider.kind, 'connection');
    assert.equal(provider.profileId, 'cm1');
});
