import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCapsuleMemoryRevisionPrompt,
    buildCapsuleReorganizePrompt,
    buildCapsuleConsolidationPrompt,
    buildFactPrompt,
    buildPolishPrompt,
    buildRoundCapsulePrompt,
    DEFAULT_PROMPTS,
    PROMPT_VERSION,
} from '../prompts.js';

test('builds a separate fact-bounded literary polishing stage', () => {
    const request = buildPolishPrompt({
        facts: '- 谢怀璧接过热茶',
        draft: '谢怀璧接过了茶。',
        previousRecap: '此前两人已经约定再次见面。',
        styleAnchors: '雨声很轻。',
        targetWords: 600,
        customPrompts: DEFAULT_PROMPTS,
    });
    assert.equal(PROMPT_VERSION, 'gaga-summary-v8');
    assert.match(request.systemPrompt, /不得新增、删除或改变事件/);
    assert.match(request.prompt, /<前情草稿>/);
    assert.match(request.prompt, /谢怀璧接过了茶/);
    assert.match(request.prompt, /此前两人已经约定再次见面/);
    assert.match(request.prompt, /目标长度约 600 字/);
});

test('capsule prompts embed emotional and relationship changes without a duplicate report', () => {
    const capsule = buildRoundCapsulePrompt({ messages: '她低头避开他的目光。', currentMemory: '两人关系正在升温。' });
    assert.match(capsule.systemPrompt, /情绪变化和人物关系变化自然写进同一段 text/);
    assert.match(capsule.systemPrompt, /只记录本轮新发生/);
    assert.match(capsule.systemPrompt, /角色状态栏、人物属性面板/);
    assert.match(capsule.systemPrompt, /剧情分支、候选选项/);
    const archive = buildCapsuleConsolidationPrompt({ capsules: '本轮胶囊', currentMemory: '长期记忆' });
    assert.match(archive.systemPrompt, /情绪与关系变化必须嵌入对应事件/);
    assert.match(archive.systemPrompt, /不要另写一份重复的情感报告/);
    assert.match(archive.systemPrompt, /不得只返回 recap/);
    assert.match(archive.systemPrompt, /facts 至少包含一条带 text 的事实/);
    const upgradedArchive = buildCapsuleConsolidationPrompt({
        capsules: '本轮胶囊',
        customPrompts: { ...DEFAULT_PROMPTS, consolidateSystem: '旧版自定义归档提示' },
    });
    assert.match(upgradedArchive.systemPrompt, /旧版自定义归档提示/);
    assert.match(upgradedArchive.systemPrompt, /不得只返回 recap/);
});

test('keeps the complete source text in an adaptive fact request', () => {
    const messages = `${'前'.repeat(300000)}尾部标记`;
    const request = buildFactPrompt({
        messages,
        currentState: '暂无旧记忆',
        openThreads: '暂无未结事项',
        customPrompts: DEFAULT_PROMPTS,
    });

    assert.match(request.prompt, /尾部标记/);
});

test('capsule reorganization rereads source and archived edits use a bounded correction prompt', () => {
    const reorganize = buildCapsuleReorganizePrompt({
        messages: '[消息 4] 她收下钥匙。',
        currentCapsule: '她收下钥匙。',
        currentMemory: '两人已经约定再见。',
        instruction: '保留她迟疑后才收下的细节',
    });
    assert.match(reorganize.systemPrompt, /原始消息是唯一事实来源/);
    assert.match(reorganize.prompt, /保留她迟疑后才收下的细节/);

    const archiveRevision = buildCapsuleMemoryRevisionPrompt({
        memoryStructure: '{"facts":[]}',
        novelRecap: '旧前情',
        oldCapsule: '旧胶囊',
        newCapsule: '新胶囊',
    });
    assert.match(archiveRevision.systemPrompt, /其余记忆必须原样保留/);
    assert.match(archiveRevision.systemPrompt, /noMemoryChange/);
    assert.match(archiveRevision.prompt, /<修订前胶囊>/);
    assert.match(archiveRevision.prompt, /新胶囊/);
});
