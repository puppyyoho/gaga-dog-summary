import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGeneratedText, generateCompatible, generateQuietOnly } from '../generation-client.js';

test('reads common Tavern and OpenAI-compatible generation results', () => {
    assert.equal(extractGeneratedText('直接文本'), '直接文本');
    assert.equal(extractGeneratedText({ text: 'Tavern 文本' }), 'Tavern 文本');
    assert.equal(extractGeneratedText({ choices: [{ message: { content: '兼容端文本' } }] }), '兼容端文本');
});

test('uses Tavern quiet generation first with one combined prompt', async () => {
    const calls = [];
    const ctx = {
        generateQuietPrompt: async options => {
            calls.push(['quiet', options]);
            return 'quiet-ok';
        },
        generateRaw: async options => {
            calls.push(['raw', options]);
            return 'raw-ok';
        },
    };
    const result = await generateCompatible(ctx, {
        systemPrompt: '系统说明',
        prompt: '总结材料',
        responseLength: 1200,
    });
    assert.equal(result, 'quiet-ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'quiet');
    assert.deepEqual(calls[0][1], {
        quietPrompt: '系统说明\n\n总结材料',
        skipWIAN: true,
        responseLength: 1200,
    });
});

test('falls back to raw only when quiet generation is unavailable', async () => {
    const calls = [];
    const failure = new Error('quiet unavailable');
    const ctx = {
        generateQuietPrompt: async () => {
            calls.push('quiet');
            throw failure;
        },
        generateRaw: async request => {
            calls.push(['raw', request]);
            return { content: 'raw-ok' };
        },
    };
    let fallbackError;
    const request = { systemPrompt: '系统', prompt: '材料' };
    const result = await generateCompatible(ctx, request, error => { fallbackError = error; });
    assert.equal(result, 'raw-ok');
    assert.deepEqual(calls, ['quiet', ['raw', request]]);
    assert.equal(fallbackError, failure);
});

test('rejects an empty quiet response instead of saving an empty summary', async () => {
    await assert.rejects(
        generateQuietOnly({ generateQuietPrompt: async () => ({ text: '   ' }) }, { prompt: '总结' }),
        /模型返回了空内容/,
    );
});
