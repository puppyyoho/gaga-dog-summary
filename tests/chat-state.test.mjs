import test from 'node:test';
import assert from 'node:assert/strict';
import {
    persistChatMetadata,
    readChatState,
    writeChatState,
} from '../chat-state.js';

const key = 'gagaDogSummary';
const normalize = value => ({ checkpoints: [], ...(value && typeof value === 'object' ? value : {}) });

test('reads and writes the canonical SillyTavern chatMetadata store', () => {
    const ctx = { chatMetadata: {} };
    writeChatState(ctx, key, { recap: '已经保存' }, normalize);
    assert.equal(ctx.chatMetadata[key].recap, '已经保存');
    assert.equal(ctx.chat_metadata, undefined);
    assert.equal(readChatState(ctx, key, normalize).recap, '已经保存');
});

test('migrates a legacy chat_metadata state into chatMetadata', () => {
    const ctx = {
        chatMetadata: {},
        chat_metadata: { [key]: { recap: '旧版记忆' } },
    };
    assert.equal(readChatState(ctx, key, normalize).recap, '旧版记忆');
    assert.equal(ctx.chatMetadata[key].recap, '旧版记忆');
});

test('prefers saveMetadata and saves chat messages only when requested', async () => {
    const calls = [];
    const ctx = {
        saveMetadata: async () => calls.push('metadata'),
        saveChat: async () => calls.push('chat'),
    };
    await persistChatMetadata(ctx);
    assert.deepEqual(calls, ['metadata']);
    await persistChatMetadata(ctx, { includeMessages: true });
    assert.deepEqual(calls, ['metadata', 'metadata', 'chat']);
});

test('falls back to saveChat for older context implementations', async () => {
    let calls = 0;
    await persistChatMetadata({ saveChat: async () => { calls += 1; } }, { includeMessages: true });
    assert.equal(calls, 1);
});
