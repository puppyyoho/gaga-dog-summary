import test from 'node:test';
import assert from 'node:assert/strict';
import {
    activeRoundCapsules,
    appendRoundCapsule,
    assertMemoryPacket,
    compileInjection,
    createRoundCapsule,
    makeSourceRange,
    mergeMemoryPacket,
    normalizeChatState,
    nextRoundRange,
    parseModelPacket,
    parseRoundCapsule,
    rangeForNewSummary,
    rangesForSummaryBacklog,
    rangeStillMatches,
    roundCapsuleTokens,
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

test('rejects prose-only and empty memory packets before committing a checkpoint', () => {
    assert.throws(() => assertMemoryPacket(parseModelPacket(JSON.stringify({ recap: '只有散文，没有事实结构' }))));
    assert.throws(() => assertMemoryPacket(parseModelPacket(JSON.stringify({ facts: [], stateUpdates: [], threads: [] }))));
    assert.equal(assertMemoryPacket(parseModelPacket(JSON.stringify({ facts: [{ text: '沈砚带伤抵达客栈' }] }))).facts.length, 1);
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

test('detects edits beyond the legacy 6000-character compatibility hash', () => {
    const long = [{ name: 'Char', mes: `${'前'.repeat(7000)}原结尾`, send_date: 'long' }];
    const range = makeSourceRange(long, 0, 0);
    const edited = [{ ...long[0], mes: `${'前'.repeat(7000)}新结尾` }];
    assert.equal(rangeStillMatches(edited, range), false);
});

test('plans a range while protecting recent messages', () => {
    const state = normalizeChatState({ lastProcessedIndex: -1 });
    const range = rangeForNewSummary(messages, state, { keepMessages: 4 });
    assert.equal(range.start, 0);
    assert.equal(range.end, 1);
    assert.equal(selectHideEnd(messages, state, { keepMessages: 4 }), 1);
});

test('splits a large backlog into approximately token-sized summary batches', () => {
    const longMessages = Array.from({ length: 10 }, (_, index) => ({
        name: index % 2 ? 'Char' : 'User',
        is_user: index % 2 === 0,
        mes: '长'.repeat(10000),
        send_date: String(index),
    }));
    const state = normalizeChatState({ lastProcessedIndex: -1 });
    const range = rangeForNewSummary(longMessages, state, { keepMessages: 4, targetTokens: 18000 });
    assert.equal(range.start, 0);
    assert.equal(range.end, 1);
});

test('plans every internal batch needed for a one-click manual summary', () => {
    const longMessages = Array.from({ length: 10 }, (_, index) => ({
        name: index % 2 ? 'Char' : 'User',
        is_user: index % 2 === 0,
        mes: '长'.repeat(10000),
        send_date: String(index),
    }));
    const state = normalizeChatState({ lastProcessedIndex: -1 });
    const ranges = rangesForSummaryBacklog(longMessages, state, { keepMessages: 4, targetTokens: 18000 });
    assert.deepEqual(ranges.map(range => [range.start, range.end]), [[0, 1], [2, 3], [4, 5]]);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges.at(-1).end, 5);
    for (let index = 1; index < ranges.length; index += 1) {
        assert.equal(ranges[index].start, ranges[index - 1].end + 1);
    }
});

test('summarizes floors 1 through 140 when 150 messages keep the newest 10', () => {
    const oneHundredFifty = Array.from({ length: 150 }, (_, index) => ({
        name: index % 2 ? 'Char' : 'User',
        is_user: index % 2 === 0,
        mes: `第${index + 1}楼` + '剧情'.repeat(1000),
        send_date: String(index),
    }));
    const ranges = rangesForSummaryBacklog(oneHundredFifty, normalizeChatState(), {
        keepMessages: 10,
        targetTokens: 60000,
    });
    assert.ok(ranges.length > 1);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges.at(-1).end, 139);
    assert.equal(ranges.reduce((count, range) => count + range.end - range.start + 1, 0), 140);
    for (let index = 1; index < ranges.length; index += 1) {
        assert.equal(ranges[index].start, ranges[index - 1].end + 1);
    }
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

test('creates one incremental capsule for a completed user and assistant round', () => {
    const initial = normalizeChatState({ memoryMode: 'layered', lastProcessedIndex: 1, lastCapsuleIndex: 1 });
    const range = nextRoundRange(messages, initial);
    assert.deepEqual([range.start, range.end], [2, 3]);
    const packet = parseRoundCapsule(JSON.stringify({
        title: '军徽暴露',
        text: '陆遥发现并拿走军徽，沈砚仍不知情；两人的秘密与信任出现新的张力。',
        importance: 'high',
        participants: ['陆遥', '沈砚'],
        keywords: ['军徽', '秘密'],
    }));
    const capsule = createRoundCapsule(packet, range, 'cap_test');
    const next = appendRoundCapsule(initial, capsule);
    assert.equal(next.lastCapsuleIndex, 3);
    assert.equal(activeRoundCapsules(next).length, 1);
    assert.ok(roundCapsuleTokens(next) > 0);
});

test('layered injection omits capsules still covered by the complete recent floors', () => {
    const first = createRoundCapsule({ title: '旧轮', text: '旧轮发生了关系变化。' }, makeSourceRange(messages, 0, 1), 'old');
    const recent = createRoundCapsule({ title: '近轮', text: '近轮发生了新的变化。' }, makeSourceRange(messages, 2, 3), 'recent');
    const state = normalizeChatState({
        memoryMode: 'layered',
        roundCapsules: [first, recent],
        summaryArtifacts: { novel: '长期前情。', structured: '', mixed: '' },
        summaryMode: 'novel',
    });
    const injection = compileInjection(state, { recentStartIndex: 2, maxTokens: 1000 });
    assert.match(injection, /旧轮发生了关系变化/);
    assert.doesNotMatch(injection, /近轮发生了新的变化/);
});

test('layered summary and capsule injection share one strict token budget', () => {
    const capsules = Array.from({ length: 12 }, (_, index) => createRoundCapsule(
        { title: `第${index}轮`, text: '情绪与关系变化'.repeat(80) },
        makeSourceRange(messages, 0, 1),
        `long_${index}`,
    ));
    const state = normalizeChatState({
        memoryMode: 'layered',
        summaryMode: 'novel',
        summaryArtifacts: { novel: '长期前情'.repeat(500), structured: '', mixed: '' },
        roundCapsules: capsules,
    });
    const injection = compileInjection(state, { recentStartIndex: 6, maxTokens: 240, capsuleLimit: 12 });
    assert.ok(tokenEstimate(injection) <= 240);
});
