import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractGeneratedText,
    generateWithFallback,
    mergeStreamText,
} from '../generation-client.js';

test('reads common Tavern and OpenAI-compatible generation results', () => {
    assert.equal(extractGeneratedText('直接文本'), '直接文本');
    assert.equal(extractGeneratedText({ text: 'Tavern 文本' }), 'Tavern 文本');
    assert.equal(extractGeneratedText({ choices: [{ message: { content: '兼容端文本' } }] }), '兼容端文本');
    assert.equal(extractGeneratedText({ choices: [{ delta: { content: '流式增量' } }] }), '流式增量');
});

test('streams an independent OpenAI-compatible profile and can be aborted', async () => {
    const originalFetch = globalThis.fetch;
    const updates = [];
    globalThis.fetch = async (_url, options) => {
        assert.equal(options.method, 'POST');
        assert.match(options.body, /独立模型/);
        const encoder = new TextEncoder();
        const chunks = [
            'data: {"choices":[{"delta":{"content":"第一"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"段"}}]}\n\n',
            'data: [DONE]\n\n',
        ];
        const body = new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    try {
        const result = await generateWithFallback({}, {
            systemPrompt: '系统',
            prompt: '独立模型',
            providerProfile: { kind: 'openai-compatible', name: '测试', baseUrl: 'https://example.test/v1', model: 'demo', apiKey: 'key' },
            preferStream: true,
            onText: text => updates.push(text),
        });
        assert.equal(result.text, '第一段');
        assert.equal(result.streamed, true);
        assert.deepEqual(updates, ['第一', '第一段']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('merges cumulative and delta stream chunks without duplication', () => {
    assert.equal(mergeStreamText('前半', '前半后半'), '前半后半');
    assert.equal(mergeStreamText('前半', '后半'), '前半后半');
    assert.equal(mergeStreamText('完整', '完整'), '完整');
});

test('uses the live Text Completion service for real streaming', async () => {
    const payloads = [];
    const updates = [];
    const ctx = {
        mainApi: 'textgenerationwebui',
        textCompletionSettings: { preset: '当前预设' },
        getPresetManager: () => ({ getCompletionPresetByName: () => ({ temperature: 0.8 }) }),
        TextCompletionService: {
            presetToGeneratePayload: (_settings, _params, override) => ({ ...override, model: 'live-model' }),
            sendRequest: async payload => {
                payloads.push(payload);
                return (async function* stream() {
                    yield '{"scene"';
                    yield '{"scene":{},"facts":[],';
                    yield '{"scene":{},"facts":[],"stateUpdates":[],"threads":[],"recap":"完成"}';
                }());
            },
        },
        generateQuietPrompt: async () => { throw new Error('不应进入 Quiet'); },
        generateRaw: async () => { throw new Error('不应进入 Raw'); },
    };
    const result = await generateWithFallback(ctx, {
        systemPrompt: '系统',
        prompt: '材料',
        preferStream: true,
        onText: text => updates.push(text),
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].stream, true);
    assert.equal(result.streamed, true);
    assert.equal(result.updates, 3);
    assert.equal(result.text.endsWith('"完成"}'), true);
    assert.equal(updates.length, 3);
});

test('falls back to Tavern quiet generation only when no direct service exists', async () => {
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
    const result = await generateWithFallback(ctx, {
        systemPrompt: '系统说明',
        prompt: '总结材料',
        preferStream: true,
    });
    assert.equal(result.text, 'quiet-ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'quiet');
    assert.equal(calls[0][1].quietPrompt, '系统说明\n\n总结材料');
});

test('an abort signal stops a live stream before applying later chunks', async () => {
    const controller = new AbortController();
    const ctx = {
        mainApi: 'textgenerationwebui',
        textCompletionSettings: {},
        TextCompletionService: {
            presetToGeneratePayload: (_settings, _params, override) => override,
            sendRequest: async () => (async function* stream() {
                yield '第一段';
                yield '第二段';
            }()),
        },
    };
    await assert.rejects(
        generateWithFallback(ctx, {
            systemPrompt: '系统',
            prompt: '材料',
            preferStream: true,
            signal: controller.signal,
            onText: () => controller.abort(new DOMException('测试中断', 'AbortError')),
        }),
        error => error?.name === 'AbortError',
    );
});

test('reports both the live service and compatibility errors', async () => {
    const gateway = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const ctx = {
        mainApi: 'textgenerationwebui',
        textCompletionSettings: {},
        TextCompletionService: {
            presetToGeneratePayload: (_settings, _params, override) => override,
            sendRequest: async () => { throw gateway; },
        },
        generateQuietPrompt: async () => { throw gateway; },
        generateRaw: async () => { throw gateway; },
    };
    await assert.rejects(
        generateWithFallback(ctx, { systemPrompt: '系统', prompt: '材料', preferStream: true }),
        /直接流式：.*502.*兼容通道：/,
    );
});
