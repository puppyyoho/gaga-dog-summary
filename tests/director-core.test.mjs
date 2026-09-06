import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyDirectorRevision,
    applyBranchesToDirector,
    applyForeshadowsToDirector,
    applyLonglineToDirector,
    applyProgressToDirector,
    buildDirectorPrompt,
    buildDirectorRevisionPrompt,
    buildExecutionCard,
    clearActiveBranch,
    createEmptyDirectorState,
    DIRECTOR_PRESETS,
    directorProgressSnapshot,
    discardDirectorRevision,
    lockMainline,
    normalizeDirectorState,
    parseDirectorPacket,
    parseDirectorRevision,
    selectBranch,
    setCurrentDirectorBeat,
    stageDirectorRevision,
    undoDirectorRevision,
    unlockMainline,
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
    assert.match(request.prompt, /故事日历/);
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
    assert.match(card, /强制执行规则/);
    assert.match(card, /本轮只能推进当前阶段与当前节拍/);
    assert.match(card, /严禁使用任何破折号/);
    assert.match(card, /旧钥匙/);
    assert.doesNotMatch(card, /未来计划是事实/);
});

test('keeps calendar reminders out of factual memory and marks them as optional', () => {
    const state = createEmptyDirectorState();
    state.enabled = true;
    const card = buildExecutionCard({
        directorState: state,
        calendarContext: { cardText: '【故事日历】当前日期：2026-02-17\n临近事件：- 春节（今天）' },
    });
    assert.match(card, /春节/);
    assert.match(card, /不是已发生事实/);
});

test('builds a continuation prompt from an interrupted director draft', () => {
    const request = buildDirectorPrompt({
        task: 'longline',
        continuationMode: 'draft',
        continuationDraft: '{"title":"未完成草稿"',
        memory: { recap: '已发生内容', facts: [], state: {}, threads: [] },
    });
    assert.match(request.prompt, /续写模式/);
    assert.match(request.prompt, /未完成草稿/);
    assert.match(request.prompt, /完整合法 JSON/);
});

test('normalizes, locks, selects branches and advances beats without mutating facts', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), {
        title: '主线', premise: '前进', arcs: [{ id: 'a', title: '阶段', goal: '目标', beats: [{ id: 'b', goal: '节拍' }] }],
    });
    state = lockMainline(state);
    assert.equal(state.mainPlan.status, 'locked');
    state = unlockMainline(state);
    assert.equal(state.mainPlan.status, 'draft');
    state = lockMainline(state);
    state = applyBranchesToDirector(state, { branches: [{ id: 'x', title: '分支', summary: '转向', consequences: ['改变关系'] }] });
    state = selectBranch(state, 'x');
    assert.equal(state.activeBranchId, 'x');
    state = clearActiveBranch(state);
    assert.equal(state.activeBranchId, '');
    assert.equal(state.branchCandidates[0].status, 'candidate');
    state = selectBranch(state, 'x');
    state = applyForeshadowsToDirector(state, { foreshadows: [{ id: 'f', name: '线索', surface: '一闪而过' }] });
    const next = applyProgressToDirector(state, { beatCompleted: true, completedGoals: ['节拍'], remainingGoals: [] });
    assert.equal(next.mainPlan.arcs[0].beats[0].status, 'completed');
    assert.equal(next.foreshadows[0].name, '线索');
});

test('preserves a locked mainline when a later director plan is applied', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), { title: '旧主线', premise: '已确认', arcs: [{ id: 'a', title: '阶段', goal: '目标', beats: [] }] });
    state = lockMainline(state);
    const next = applyLonglineToDirector(state, { title: '续写草案', premise: '补充', arcs: [{ id: 'b', title: '后续', goal: '后续目标', beats: [] }] });
    assert.equal(next.mainPlan.status, 'locked');
    assert.equal(next.mainPlan.title, '旧主线');
    assert.equal(next.mainPlan.arcs.length, 2);
});

test('normalizes a concise outline and exposes the current director stage', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), {
        title: '长线',
        outline: ['相遇', '试探', '确认关系'],
        arcs: [{ id: 'a', title: '第一幕', goal: '靠近', beats: [{ id: 'b1', goal: '再次见面' }, { id: 'b2', goal: '交换秘密' }] }],
    });
    assert.deepEqual(state.mainPlan.outline, ['相遇', '试探', '确认关系']);
    state = setCurrentDirectorBeat(state, 'a', 'b2');
    const progress = directorProgressSnapshot(state);
    assert.equal(progress.arcIndex, 0);
    assert.equal(progress.beatIndex, 1);
    assert.equal(progress.beat.goal, '交换秘密');
});

test('parses fenced and wrapped director JSON', () => {
    const packet = parseDirectorPacket('```json\n{"branches":[{"title":"A","summary":"测试"}]}\n```', 'branch');
    assert.equal(packet.branches[0].title, 'A');
});

test('stages director revisions as previews and only applies them after confirmation', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), {
        title: '原主线', outline: ['相遇', '靠近'], premise: '原前提',
        arcs: [{ id: 'a', title: '第一幕', goal: '靠近', beats: [{ id: 'b', goal: '第一次约会' }] }],
    });
    state = lockMainline(state);
    const prompt = buildDirectorRevisionPrompt({
        state,
        scope: 'outline',
        instruction: '让第二步更酸涩。',
        memory: { recap: '两人已经相遇。', facts: [], state: {}, threads: [] },
    });
    assert.match(prompt.prompt, /只修订简明总纲/);
    assert.match(prompt.prompt, /让第二步更酸涩/);
    const packet = parseDirectorRevision('{"changeSummary":["加强拉扯"],"mainPlan":{"outline":["相遇","误解后仍旧靠近"]},"branches":null,"foreshadows":null}');
    const staged = stageDirectorRevision(state, packet, 'outline', '让第二步更酸涩。');
    assert.deepEqual(staged.mainPlan.outline, ['相遇', '靠近']);
    assert.deepEqual(staged.revisionDraft.mainPlan.outline, ['相遇', '误解后仍旧靠近']);
    const applied = applyDirectorRevision(staged);
    assert.deepEqual(applied.mainPlan.outline, ['相遇', '误解后仍旧靠近']);
    assert.equal(applied.mainPlan.status, 'locked');
    assert.equal(applied.currentArcId, 'a');
    assert.equal(applied.currentBeatId, 'b');
    assert.equal(applied.revisionHistory.length, 1);
    const undone = undoDirectorRevision(applied);
    assert.deepEqual(undone.mainPlan.outline, ['相遇', '靠近']);
    assert.equal(undone.mainPlan.status, 'locked');
});

test('can discard a director revision without changing the current plan', () => {
    let state = applyLonglineToDirector(createEmptyDirectorState(), {
        title: '原主线', outline: ['原总纲'], arcs: [{ id: 'a', title: '第一幕', beats: [] }],
    });
    state = stageDirectorRevision(state, { mainPlan: { outline: ['新总纲'] } }, 'outline', '重写');
    const discarded = discardDirectorRevision(state);
    assert.equal(discarded.revisionDraft, null);
    assert.deepEqual(discarded.mainPlan.outline, ['原总纲']);
});
