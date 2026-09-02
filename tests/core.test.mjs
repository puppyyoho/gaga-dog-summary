import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compileInjection,
    makeSourceRange,
    mergeMemoryPacket,
    normalizeChatState,
    parseModelPacket,
    rangeForNewSummary,
    rangeStillMatches,
    selectHideEnd,
    selectRelevantCapsules,
    selectStyleAnchors,
    tokenEstimate,
} from '../memory-core.js';

const messages = [
    { name: 'User', is_user: true, mes: '我们进入了白榆镇。', send_date: '1' },
    { name: 'Char', mes: '沈砚捂住旧伤，告诉陆遥不要去后院。', send_date: '2' },
    { name: 'User', is_user: true, mes: '陆遥发现他袖中的军徽。', send_date: '3' },
    { name: 'Char', mes: '雨停后，两人决定天亮前调查枯井。沈砚仍不知道陆遥拿走了军徽。', send_date: '4' },
    { name: 'User', is_user: true, mes: '他们在客栈休息。', send_date: '5' },
    { name: 'Char', mes: '夜里很安静。', send_date: '6' },
];

test('parses JSON and JSONL memory packets', () => {
    const object = parseModelPacket(JSON.stringify({ scene: { title: '客栈' }, facts: [{ text: '拿到钥匙' }], stateUpdates: [], threads: [], recap: '前情' }));
    assert.equal(object.scene.title, '客栈');
    const jsonl = parseModelPacket('{"type":"event","text":"进入客栈"}\n{"type":"state","key":"地点","value":"客栈"}');
    assert.equal(jsonl.facts.length, 1);
    assert.equal(jsonl.stateUpdates.length, 1);
});

test('merges facts, state and threads while protecting locked memory', () => {
    const locked = normalizeChatState({
        facts: [{ id: 'secret', text: '原始秘密', importance: 'critical', userLocked: true }],
        state: { '人物.伤势': { key: '人物.伤势', value: '不能奔跑', userLocked: true } },
    });
    const range = makeSourceRange(messages, 0, 3);
    const next = mergeMemoryPacket(locked, {
        scene: { title: '雨夜客栈', text: '两人抵达客栈。' },
        facts: [{ id: 'secret', text: '模型猜出的新秘密', importance: 'critical' }, { id: 'new', text: '陆遥拿到军徽', importance: 'high' }],
        stateUpdates: [{ key: '人物.伤势', value: '已经痊愈' }, { key: '地点', value: '客栈' }],
        threads: [{ id: 'well', text: '天亮前调查枯井', status: 'open' }],
        recap: '雨夜前情',
    }, range, 'cp_test');
    assert.equal(next.facts.find(item => item.id === 'secret').text, '原始秘密');
    assert.equal(next.state['人物.伤势'].value, '不能奔跑');
    assert.equal(next.state['地点'].value, '客栈');
    assert.equal(next.threads[0].status, 'open');
    assert.equal(next.recap, '雨夜前情');
});

test('detects changed source ranges', () => {
    const range = makeSourceRange(messages, 0, 2);
    assert.equal(rangeStillMatches(messages, range), true);
    const edited = messages.map(item => ({ ...item }));
    edited[1].mes = '沈砚已经痊愈。';
    assert.equal(rangeStillMatches(edited, range), false);
});

test('plans a range while protecting recent messages', () => {
    const state = normalizeChatState({ lastProcessedIndex: -1 });
    const range = rangeForNewSummary(messages, state, { keepMessages: 4 });
    assert.equal(range.start, 0);
    assert.equal(range.end, 1);
    assert.equal(selectHideEnd(messages, state, { keepMessages: 4 }), 1);
});

test('injection modes and recall remain bounded', () => {
    const state = normalizeChatState({
        recap: '这是一段文学前情。',
        facts: [{ id: 'f', text: '沈砚持有军徽', importance: 'critical', keywords: ['军徽'] }],
        sceneCards: [{ id: 's', title: '港口', text: '沈砚在港口遗失军徽', keywords: ['军徽', '港口'], importance: 'high', createdAt: 1 }],
    });
    const safe = compileInjection(state, { mode: 'safe', query: '军徽', maxTokens: 240 });
    assert.equal(safe.includes('文学前情'), false);
    assert.equal(safe.includes('持有军徽'), true);
    assert.ok(tokenEstimate(safe) <= 600);
    assert.equal(selectRelevantCapsules(state, '军徽', 1).length, 1);
});

test('style anchors may include hidden source samples', () => {
    const hidden = [{ name: 'Char', mes: '这是一个足够长的叙述片段。'.repeat(40), is_system: true }];
    assert.equal(selectStyleAnchors(hidden, 2).length, 0);
    assert.equal(selectStyleAnchors(hidden, 2, { includeHidden: true }).length, 1);
});
