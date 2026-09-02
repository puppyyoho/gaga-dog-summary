import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyBranchesToDirector,
    applyForeshadowsToDirector,
    applyLonglineToDirector,
    applyProgressToDirector,
    buildDirectorPrompt,
    buildExecutionCard,
    createEmptyDirectorState,
    DIRECTOR_PRESETS,
    lockMainline,
    normalizeDirectorState,
    parseDirectorPacket,
    selectBranch,
} from '../director-core.js';

test('ships built-in director styles and embeds custom pacing requirements', () => {
    assert.ok(DIRECTOR_PRESETS.some(item => item.id === 'broken-reunion'));
    const request = buildDirectorPrompt({
        task: 'longline',
        presetId: 'broken-reunion',
        customBrief: '结局 HE；中段必须引入一位知道秘密的新角色。',
        pacingMode: 'custom',
        pacingCustom: '前两阶段各 6 轮，高潮 2 轮，余波 4 轮。',
        memory: { recap: '两人刚刚重逢。', facts: [], state: {}, threads: [] },
    });
    assert.match(request.prompt, /破镜重圆/);
    assert.match(request.prompt, /前两阶段各 6 轮/);
    assert.match(request.prompt, /结局 HE/);
});

test('keeps future plans separate from factual memory and builds a bounded execution card', () => {
    let state = createEmptyDirectorState();
    state.enabled = true;
    state.mainPlan = {
        id: 'plan', title: '重逢主线', premise: '修复关系', status: 'draft',
        arcs: [{ id: 'arc1', title: '试探', goal: '重新建立信任', conflict: '旧伤', pacing: 'slow', estimatedTurns: 4,
            beats: [{ id: 'beat1', goal: '一次克制的靠近', allowed: ['见面'], forbidden: ['直接结婚'], completion: ['双方愿意再见'], pace: 'slow' }] }],
    };
    state.currentArcId = 'arc1';
    state.currentBeatId = 'beat1';
    state.foreshadows = [{ id: 'f1', name: '旧钥匙', surface: '钥匙齿上有新刻痕', meaning: '有人进过房间', status: 'planned' }];
    const card = buildExecutionCard({ directorState: state, memoryState: { recap: '已发生的重逢', facts: [], state: {}, threads: [] }, recentText: '两人约定下次见面。' });
    assert.match(card, /<gaga_director>/);
    assert.match(card, /不要跨越未完成的节拍/);
    assert.match(card, /旧钥匙/);
    assert.doesNotMatch(card, /未来计划是事实/);
});

test('normalizes, locks, selects branches and advances beats without mutating facts', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), {
        title: '主线', premise: '前进', arcs: [{ id: 'a', title: '阶段', goal: '目标', beats: [{ id: 'b', goal: '节拍' }] }],
    });
    state = lockMainline(state);
    assert.equal(state.mainPlan.status, 'locked');
    state = applyBranchesToDirector(state, { branches: [{ id: 'x', title: '分支', summary: '转向', consequences: ['改变关系'] }] });
    state = selectBranch(state, 'x');
    assert.equal(state.activeBranchId, 'x');
    state = applyForeshadowsToDirector(state, { foreshadows: [{ id: 'f', name: '线索', surface: '一闪而过' }] });
    const next = applyProgressToDirector(state, { beatCompleted: true, completedGoals: ['节拍'], remainingGoals: [] });
    assert.equal(next.mainPlan.arcs[0].beats[0].status, 'completed');
    assert.equal(next.foreshadows[0].name, '线索');
});

test('parses fenced and wrapped director JSON', () => {
    const packet = parseDirectorPacket('```json\n{"branches":[{"title":"A","summary":"测试"}]}\n```', 'branch');
    assert.equal(packet.branches[0].title, 'A');
});
