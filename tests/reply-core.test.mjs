import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyPrompt, normalizeReplyState, parseReplyCandidates } from '../reply-core.js';

test('reply prompt carries viewpoint, detail, initiative and director context', () => {
    const preferences = normalizeReplyState({ viewpoint: 'third', detail: 'full', length: 'long', initiative: 'active', tone: '嘴硬但心软', followDirector: true, customInstruction: '不要替用户承认秘密。' });
    const request = buildReplyPrompt({ recentText: '角色说下次再见。', memory: { recap: '两人已有约定。' }, directorCard: '<gaga_director>慢热</gaga_director>', preferences });
    assert.match(request.prompt, /第三人称/);
    assert.match(request.prompt, /完整行动描写/);
    assert.match(request.prompt, /主动程度：active/);
    assert.match(request.prompt, /慢热/);
});

test('parses up to five selectable candidate replies', () => {
    const raw = JSON.stringify({ candidates: Array.from({ length: 7 }, (_, i) => ({ title: `候选${i}`, text: `回复${i}`, intent: '不同策略' })) });
    const candidates = parseReplyCandidates(raw, 5);
    assert.equal(candidates.length, 5);
    assert.equal(candidates[0].text, '回复0');
});

test('repairs fenced reply JSON with dialogue quotes and raw line breaks', () => {
    const raw = `\`\`\`json
{"candidates":[{"title":"追问钩子的材质细节","intent":"把话题延伸到他的手艺","text":"她偏过头来看他。\n\n"你说回去换钩子，换什么材质的？银的还是金的？"\n\n她问得很随意。","possibleEffect":"延续新的互动线索"}]}
\`\`\``;
    const candidates = parseReplyCandidates(raw, 5);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /你说回去换钩子/);
    assert.match(candidates[0].text, /\n/);
});

test('repairs reply JSON that uses literal newline escapes around dialogue', () => {
    const raw = '{"candidates":[{"title":"自然接话","intent":"继续互动","text":"她看向他。\\n\\n"你说什么？"\\n\\n她没有移开视线。","possibleEffect":"把话题继续下去"}]}';
    const candidates = parseReplyCandidates(raw, 5);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /你说什么/);
    assert.match(candidates[0].text, /\n/);
});
