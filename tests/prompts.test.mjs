import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPolishPrompt,
    DEFAULT_PROMPTS,
    PROMPT_VERSION,
} from '../prompts.js';

test('builds a separate fact-bounded literary polishing stage', () => {
    const request = buildPolishPrompt({
        facts: '- 谢怀璧接过热茶',
        draft: '谢怀璧接过了茶。',
        styleAnchors: '雨声很轻。',
        targetWords: 600,
        customPrompts: DEFAULT_PROMPTS,
    });
    assert.equal(PROMPT_VERSION, 'gaga-summary-v2');
    assert.match(request.systemPrompt, /不得新增、删除或改变事件/);
    assert.match(request.prompt, /<前情草稿>/);
    assert.match(request.prompt, /谢怀璧接过了茶/);
    assert.match(request.prompt, /目标长度约 600 字/);
});
