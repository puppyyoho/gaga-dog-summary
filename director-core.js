import { compactText, extractKeywords, normalizeChatState, tokenEstimate } from './memory-core.js';
import { createEmptyCalendarState, normalizeCalendarState } from './calendar-core.js';

export const DIRECTOR_SCHEMA_VERSION = 4;

export const DIRECTOR_REVISION_SCOPES = [
    { id: 'outline', name: '只修订简明总纲' },
    { id: 'mainline', name: '修订完整主线' },
    { id: 'branches', name: '修订分支候选' },
    { id: 'foreshadows', name: '修订伏笔方案' },
    { id: 'all', name: '整体修订全部导演方案' },
];

export const DIRECTOR_PRESETS = [
    {
        id: 'balanced',
        name: '均衡推进',
        description: '铺垫、冲突和情绪变化保持自然比例。',
        rules: '保持因果清楚，每轮推进一个有效变化，重大转折前先给足铺垫。',
        paceCurve: '铺垫中速，关系变化中速，高潮快速，余波慢速。',
    },
    {
        id: 'broken-reunion',
        name: '破镜重圆 · 酸涩慢热',
        description: '重逢后持续拉扯，先修复信任，再谈重新相爱。',
        rules: '不要用一次误会解释全部裂痕；让双方在靠近、退缩和重新失望中逐步修复。',
        paceCurve: '重逢慢，试探慢，旧伤复发中速，关键选择快速，和好后的余波慢。',
    },
    {
        id: 'dual-growth',
        name: '双强成长 · 并肩升级',
        description: '双方都有目标和能力，通过共同事件互相成就。',
        rules: '双方都要拥有主动性和独立胜负，不把一方降格为被拯救者。',
        paceCurve: '准备慢，行动中速，危机快速，胜利后的关系确认慢。',
    },
    {
        id: 'identity-secret',
        name: '身份秘密 · 逐层掉马',
        description: '秘密通过可回溯的异常逐层露出，而非突然揭晓。',
        rules: '每次异常只揭开一层；人物只能依据自己已经看到的证据推断。',
        paceCurve: '日常慢，异常中速，危机快速，真相揭示前留出停顿。',
    },
    {
        id: 'slow-burn',
        name: '暗恋成真 · 克制渗透',
        description: '以日常、细节和未说出口的话积累情绪。',
        rules: '减少直白表白，多用行动、回避、重复物件和未兑现承诺传递变化。',
        paceCurve: '长期慢速，阶段节点中速，表白或确认时快速，确认后慢速收束。',
    },
    {
        id: 'redemption',
        name: '救赎陪伴 · 克制治愈',
        description: '创伤不是一句安慰解决，而是在反复陪伴中改变。',
        rules: '不浪漫化伤害，不让角色靠一次牺牲获得永久原谅。',
        paceCurve: '建立安全感慢，危机中速，复发快速，修复慢。',
    },
    {
        id: 'first-marriage',
        name: '先婚后爱 · 日常变真心',
        description: '从约定和边界开始，在生活细节中改变关系定义。',
        rules: '先写契约和现实摩擦，再让关心逐渐超过原本约定。',
        paceCurve: '相处慢，生活事件中速，关系确认快速，婚后余波慢。',
    },
    {
        id: 'mystery-ensemble',
        name: '悬疑群像 · 感情暗线',
        description: '主线谜团、群像关系和感情暗线彼此牵动。',
        rules: '线索必须可回溯，群像角色拥有各自目标，不用随机反转代替逻辑。',
        paceCurve: '线索铺设慢，交叉调查中速，真相段快速，解释和余波慢。',
    },
];

export const PACING_OPTIONS = [
    { id: 'slow', name: '慢速', description: '每轮只推进一个小变化，强调对白、动作和情绪余韵。' },
    { id: 'balanced', name: '均衡', description: '每轮完成一个有效事件或关系变化。' },
    { id: 'fast', name: '快速', description: '减少过渡，每轮推进一个主要节点及其直接后果。' },
    { id: 'dynamic', name: '动态', description: '根据当前阶段自动切换快慢。' },
    { id: 'custom', name: '自定义', description: '依据用户输入的每阶段轮数和节奏执行。' },
];

function record(value, fallback = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function list(value, max = 60) {
    return Array.isArray(value) ? value.slice(0, max) : [];
}

export function createEmptyDirectorState() {
    return {
        schemaVersion: DIRECTOR_SCHEMA_VERSION,
        enabled: false,
        customBrief: '',
        presetId: 'balanced',
        pacingMode: 'dynamic',
        pacingCustom: '',
        toggles: {
            mainline: true,
            branch: true,
            pacing: true,
            foreshadow: true,
            newCharacters: true,
            sidePlots: true,
            autoTrack: true,
        },
        calendar: createEmptyCalendarState(),
        taskState: {
            task: '',
            status: 'idle',
            partial: '',
            updatedAt: 0,
        },
        mainPlan: null,
        branchCandidates: [],
        activeBranchId: '',
        foreshadows: [],
        currentArcId: '',
        currentBeatId: '',
        turnsSpent: 0,
        progressLog: [],
        lastExecutionCard: '',
        lastPlanAt: 0,
        lastProgressAt: 0,
        revisionRequest: {
            scope: 'all',
            instruction: '',
        },
        revisionDraft: null,
        revisionHistory: [],
    };
}

export function normalizeDirectorState(value) {
    const defaults = createEmptyDirectorState();
    const input = record(value);
    const result = {
        ...defaults,
        ...input,
        toggles: { ...defaults.toggles, ...record(input.toggles) },
        calendar: normalizeCalendarState(input.calendar),
        taskState: {
            task: String(input.taskState?.task || ''),
            status: ['idle', 'running', 'stopped', 'error', 'completed'].includes(input.taskState?.status) ? input.taskState.status : 'idle',
            partial: compactText(input.taskState?.partial || '', 60000),
            updatedAt: Number(input.taskState?.updatedAt || 0) || 0,
        },
        mainPlan: input.mainPlan && typeof input.mainPlan === 'object' ? input.mainPlan : null,
        branchCandidates: list(input.branchCandidates),
        foreshadows: list(input.foreshadows),
        progressLog: list(input.progressLog, 100),
        revisionRequest: {
            scope: DIRECTOR_REVISION_SCOPES.some(item => item.id === input.revisionRequest?.scope) ? input.revisionRequest.scope : 'all',
            instruction: compactText(input.revisionRequest?.instruction || '', 12000),
        },
        revisionDraft: input.revisionDraft && typeof input.revisionDraft === 'object' ? input.revisionDraft : null,
        revisionHistory: list(input.revisionHistory, 10),
    };
    result.schemaVersion = DIRECTOR_SCHEMA_VERSION;
    for (const key of Object.keys(defaults.toggles)) result.toggles[key] = result.toggles[key] !== false && result.toggles[key] !== 'false';
    result.customBrief = compactText(result.customBrief, 30000);
    result.pacingCustom = compactText(result.pacingCustom, 10000);
    result.presetId = String(result.presetId || 'balanced');
    result.pacingMode = PACING_OPTIONS.some(item => item.id === result.pacingMode) ? result.pacingMode : 'dynamic';
    result.activeBranchId = String(result.activeBranchId || '');
    result.currentArcId = String(result.currentArcId || '');
    result.currentBeatId = String(result.currentBeatId || '');
    result.turnsSpent = Math.max(0, Number(result.turnsSpent || 0) || 0);
    return result;
}

export function getDirectorPreset(id) {
    return DIRECTOR_PRESETS.find(item => item.id === id) || DIRECTOR_PRESETS[0];
}

function stringifyState(memory) {
    const state = normalizeChatState(memory);
    const facts = state.facts.filter(item => ['critical', 'high'].includes(item.importance) || item.userLocked).slice(-80);
    const statuses = Object.values(state.state).filter(item => item.status !== 'resolved').slice(-40);
    const threads = state.threads.filter(item => item.status === 'open' || item.userLocked).slice(-40);
    return [
        facts.length ? `【核心事实】\n${facts.map(item => `- ${item.text}`).join('\n')}` : '',
        statuses.length ? `【当前状态】\n${statuses.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
        threads.length ? `【未结事项】\n${threads.map(item => `- ${item.text}`).join('\n')}` : '',
        state.recap ? `【当前文学前情】\n${state.recap}` : '',
    ].filter(Boolean).join('\n\n');
}

export function buildDirectorPrompt({ task = 'longline', memory, recentText = '', characterCard = '', calendarContext = null, continuationDraft = '', continuationMode = '', state = {}, presetId, customBrief = '', pacingMode = 'dynamic', pacingCustom = '', toggles = {} }) {
    const preset = getDirectorPreset(presetId);
    const director = normalizeDirectorState({ ...state, presetId, customBrief, pacingMode, pacingCustom, toggles });
    const currentPlan = director.mainPlan ? JSON.stringify(director.mainPlan, null, 2) : '暂无已确认主线';
    const branch = director.activeBranchId
        ? JSON.stringify(director.branchCandidates.find(item => item.id === director.activeBranchId) || {}, null, 2)
        : '暂无当前分支';
    const taskInstruction = continuationMode === 'advance' && task === 'longline'
        ? '请在已保存的当前主线和节拍之后继续设计下一段可执行规划，不要重写已锁定内容。'
        : task === 'longline'
            ? '请生成一份可供用户审阅的长线剧情规划草案。不要把未来计划写成已经发生的事实。'
            : task === 'branch'
                ? '请基于当前主线生成 3 到 5 条互相区别的当前分支候选，并说明每条的后果。'
                : task === 'foreshadow'
                    ? '请设计可以自然埋入当前剧情的伏笔，并记录表面信号、真实含义、知情者和建议回收阶段。'
                    : '请判断最近正文是否完成当前节拍，并只返回结构化的进度判断。';
    return {
        systemPrompt: `你是“嘎嘎小狗”的幕后情节导演。你只负责规划、检查和整理故事，不直接续写正文。\n\n已发生事实是不可修改的边界；未来计划、分支和伏笔都是“可能发生”，除非正文真正写出，否则不能称为已发生。人物只能依据自己已经知道的内容行动。\n\n输出必须是合法 JSON，不要输出 Markdown、解释或正文。`,
        prompt: `<导演任务>\n${taskInstruction}\n${continuationMode ? `\n<续写模式>\n${continuationMode === 'draft' ? '上一轮生成曾被停止或失败。请参考下面的部分草稿，补全并返回一份完整合法 JSON，不要只重复草稿。' : '当前规划已经保存。请在不改写既有主线事实的前提下，继续设计下一段可执行规划。'}\n</续写模式>` : ''}\n\n<内置规划风格>\n名称：${preset.name}\n说明：${preset.description}\n规划规则：${preset.rules}\n节奏曲线：${preset.paceCurve}\n</内置规划风格>\n\n<用户自定义要求>\n${compactText(customBrief, 30000) || '无'}\n</用户自定义要求>\n\n<推进设置>\n模式：${pacingMode}\n自定义节奏：${compactText(pacingCustom, 10000) || '无'}\n主线：${director.toggles.mainline ? '启用' : '关闭'}\n分支：${director.toggles.branch ? '启用' : '关闭'}\n推进速度：${director.toggles.pacing ? '启用' : '关闭'}\n伏笔：${director.toggles.foreshadow ? '启用' : '关闭'}\n新角色：${director.toggles.newCharacters ? '允许' : '禁止'}\n额外支线：${director.toggles.sidePlots ? '允许' : '禁止'}\n</推进设置>\n\n<故事日历>\n${calendarContext?.cardText || '未启用或暂无日历提醒。'}\n日历日期只是创作参考；如果与正文因果、人物认知或角色卡冲突，以正文为准。\n</故事日历>\n\n<角色卡背景>\n${compactText(characterCard, 16000) || '无'}\n</角色卡背景>\n\n<已发生记忆>\n${stringifyState(memory) || '无'}\n</已发生记忆>\n\n<最近正文>\n${compactText(recentText, 30000) || '无'}\n</最近正文>\n\n<当前主线>\n${currentPlan}\n</当前主线>\n\n<当前分支>\n${branch}\n</当前分支>\n\n${continuationDraft ? `<上一轮部分草稿>\n${compactText(continuationDraft, 60000)}\n</上一轮部分草稿>\n` : ''}\n<输出字段>\nlongline：{title, outline:["用一句话概括起点、发展、转折和结局方向，3到8条"], premise, ending, arcs:[{id,title,goal,conflict,pacing,estimatedTurns,beats:[{id,goal,allowed,forbidden,completion,pace}]}], characterArcs, constraints}\nbranches：[{id,title,summary,reason,consequences,risks,estimatedTurns}]\nforeshadows：[{id,name,surface,meaning,signals,knowers,earliestReveal,targetArc,status}]\nprogress：{beatCompleted,completedGoals,remainingGoals,triggeredForeshadows,recommendedPace,confidence,nextBeatId}\n</输出字段>`,
    };
}

export function buildDirectorRevisionPrompt({ state = {}, scope = 'all', instruction = '', memory, recentText = '', characterCard = '', calendarContext = null, continuationDraft = '' }) {
    const director = normalizeDirectorState(state);
    const safeScope = DIRECTOR_REVISION_SCOPES.some(item => item.id === scope) ? scope : 'all';
    const scopeLabel = DIRECTOR_REVISION_SCOPES.find(item => item.id === safeScope)?.name || '整体修订全部导演方案';
    const currentContent = {
        mainPlan: director.mainPlan,
        branches: director.branchCandidates,
        foreshadows: director.foreshadows,
        currentArcId: director.currentArcId,
        currentBeatId: director.currentBeatId,
        activeBranchId: director.activeBranchId,
    };
    const outputShape = {
        changeSummary: ['具体说明修改了什么，1到8条'],
        mainPlan: safeScope === 'outline'
            ? { outline: ['修订后的完整总纲'] }
            : ['mainline', 'all'].includes(safeScope)
                ? { title: '标题', outline: [], premise: '核心前提', ending: '结局方向', arcs: [], characterArcs: [], constraints: [] }
                : null,
        branches: ['branches', 'all'].includes(safeScope) ? [] : null,
        foreshadows: ['foreshadows', 'all'].includes(safeScope) ? [] : null,
    };
    return {
        systemPrompt: `你是“嘎嘎小狗”的剧情方案修订编辑。你只修改导演规划，不续写正文，也不能改写已经发生的剧情事实。输出必须是合法 JSON，不要输出 Markdown 或解释。`,
        prompt: `<修订任务>\n范围：${scopeLabel}\n用户要求：${compactText(instruction, 12000) || '在不改变已发生事实的前提下，提高规划的连贯性和可执行性。'}\n</修订任务>\n\n<修订硬规则>\n1. 已发生事实、人物认知边界和角色卡设定不可修改。\n2. 只修改指定范围。未指定的部分必须保持原样，不要在返回中擅自重写。\n3. 保留仍然适用的 arc、beat、branch 和 foreshadow 的 id。当前阶段、已完成状态和已采用分支不得因措辞润色而丢失。\n4. 主线即使已经确认，也只生成待确认的修订预览，不能把修改描述成已经生效。\n5. 规划仍属于未来建议，不能写成已经发生的正文。\n6. 需要修订完整主线时，mainPlan 必须返回全部字段和全部阶段；需要修订分支或伏笔时，相应数组必须返回修订后的完整列表。\n</修订硬规则>\n\n<角色卡背景>\n${compactText(characterCard, 16000) || '无'}\n</角色卡背景>\n\n<已发生记忆>\n${stringifyState(memory) || '无'}\n</已发生记忆>\n\n<最近正文>\n${compactText(recentText, 30000) || '无'}\n</最近正文>\n\n<故事日历>\n${calendarContext?.cardText || '无'}\n</故事日历>\n\n<当前导演方案>\n${JSON.stringify(currentContent, null, 2)}\n</当前导演方案>\n\n${continuationDraft ? `<上一轮未完成草稿>\n${compactText(continuationDraft, 60000)}\n</上一轮未完成草稿>\n\n` : ''}<返回格式>\n严格按以下 JSON 结构返回，用真正的对象和数组替换示例内容：\n${JSON.stringify(outputShape, null, 2)}\n</返回格式>`,
    };
}

function extractJsonCandidates(text) {
    const value = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [value, value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')];
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(value.slice(first, last + 1));
    return [...new Set(candidates.filter(Boolean))];
}

export function parseDirectorPacket(raw, task = 'longline') {
    for (const candidate of extractJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            if (task === 'longline' && (parsed.longline || parsed.arcs || parsed.premise)) return parsed.longline || parsed;
            if (task === 'branch' && Array.isArray(parsed.branches)) return { branches: parsed.branches };
            if (task === 'foreshadow' && Array.isArray(parsed.foreshadows)) return { foreshadows: parsed.foreshadows };
            if (task === 'progress' && (parsed.progress || 'beatCompleted' in parsed)) return parsed.progress || parsed;
            return parsed;
        } catch { /* Try the next bounded JSON candidate. */ }
    }
    throw new Error('导演模型没有返回合法 JSON。');
}

export function parseDirectorRevision(raw) {
    for (const candidate of extractJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            const packet = parsed.revision && typeof parsed.revision === 'object' ? parsed.revision : parsed;
            if (packet.mainPlan || Array.isArray(packet.branches) || Array.isArray(packet.foreshadows)) return packet;
        } catch { /* Try the next bounded JSON candidate. */ }
    }
    throw new Error('导演修订模型没有返回合法的修订 JSON。');
}

export function normalizeMainPlan(value) {
    const plan = record(value);
    const outlineSource = Array.isArray(plan.outline)
        ? plan.outline
        : String(plan.outline || plan.overview || '').split(/\r?\n/).map(item => item.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '')).filter(Boolean);
    const arcs = list(plan.arcs, 30).map((arc, index) => {
        const item = record(arc);
        return {
            id: String(item.id || `arc_${index + 1}`),
            title: compactText(item.title || `阶段 ${index + 1}`, 120),
            goal: compactText(item.goal || '', 800),
            conflict: compactText(item.conflict || '', 800),
            pacing: String(item.pacing || 'balanced'),
            estimatedTurns: Math.max(1, Number(item.estimatedTurns || 3) || 3),
            beats: list(item.beats, 80).map((beat, beatIndex) => normalizeBeat(beat, beatIndex)),
        };
    });
    return {
        id: String(plan.id || `plan_${Date.now()}`),
        title: compactText(plan.title || '未命名主线', 160),
        outline: list(outlineSource, 12).map(item => compactText(typeof item === 'string' ? item : JSON.stringify(item), 600)).filter(Boolean),
        premise: compactText(plan.premise || '', 3000),
        ending: compactText(plan.ending || '', 1600),
        arcs,
        characterArcs: list(plan.characterArcs, 60).map(item => compactText(typeof item === 'string' ? item : JSON.stringify(item), 800)),
        constraints: list(plan.constraints, 60).map(item => compactText(typeof item === 'string' ? item : JSON.stringify(item), 800)),
        status: String(plan.status || 'draft'),
        createdAt: Number(plan.createdAt || Date.now()),
        updatedAt: Date.now(),
    };
}

function normalizeBeat(value, index) {
    const beat = record(value);
    return {
        id: String(beat.id || `beat_${index + 1}`),
        goal: compactText(beat.goal || beat.title || '', 800),
        allowed: list(beat.allowed, 20).map(item => compactText(item, 500)),
        forbidden: list(beat.forbidden, 20).map(item => compactText(item, 500)),
        completion: list(beat.completion, 20).map(item => compactText(item, 500)),
        pace: String(beat.pace || 'balanced'),
        estimatedTurns: Math.max(1, Number(beat.estimatedTurns || 1) || 1),
        status: String(beat.status || 'planned'),
    };
}

export function normalizeBranches(value) {
    const branches = Array.isArray(value) ? value : value?.branches;
    return list(branches, 20).map((branch, index) => {
        const item = record(branch);
        return {
            id: String(item.id || `branch_${Date.now()}_${index + 1}`),
            title: compactText(item.title || `分支 ${index + 1}`, 160),
            summary: compactText(item.summary || item.description || '', 1400),
            reason: compactText(item.reason || '', 800),
            consequences: list(item.consequences, 20).map(entry => compactText(entry, 500)),
            risks: list(item.risks, 20).map(entry => compactText(entry, 500)),
            estimatedTurns: Math.max(1, Number(item.estimatedTurns || 2) || 2),
            status: String(item.status || 'candidate'),
            createdAt: Number(item.createdAt || Date.now()),
        };
    });
}

export function normalizeForeshadows(value) {
    const listValue = Array.isArray(value) ? value : value?.foreshadows;
    return list(listValue, 80).map((item, index) => {
        const entry = record(item);
        return {
            id: String(entry.id || `foreshadow_${Date.now()}_${index + 1}`),
            name: compactText(entry.name || `伏笔 ${index + 1}`, 160),
            surface: compactText(entry.surface || '', 1000),
            meaning: compactText(entry.meaning || '', 1000),
            signals: list(entry.signals, 20).map(signal => compactText(signal, 500)),
            knowers: list(entry.knowers, 30).map(String),
            earliestReveal: compactText(entry.earliestReveal || '', 300),
            targetArc: compactText(entry.targetArc || '', 300),
            status: String(entry.status || 'planned'),
            createdAt: Number(entry.createdAt || Date.now()),
        };
    });
}

function activeBeat(state) {
    const director = normalizeDirectorState(state);
    const plan = director.mainPlan;
    if (!plan?.arcs?.length) return { arc: null, beat: null };
    const arc = plan.arcs.find(item => item.id === director.currentArcId) || plan.arcs.find(item => item.status !== 'completed') || plan.arcs[0];
    const beat = arc?.beats?.find(item => item.id === director.currentBeatId && item.status !== 'completed')
        || arc?.beats?.find(item => item.status !== 'completed')
        || null;
    return { arc, beat };
}

function selectedBranch(state) {
    const director = normalizeDirectorState(state);
    return director.branchCandidates.find(item => item.id === director.activeBranchId && item.status !== 'abandoned') || null;
}

function pacingInstruction(director, arc, beat) {
    if (!director.toggles.pacing) return '';
    const mode = director.pacingMode;
    if (mode === 'custom' && director.pacingCustom) return `自定义推进：${director.pacingCustom}`;
    if (mode === 'dynamic') return `动态推进：当前阶段“${arc?.title || '未命名'}”，本节拍速度为“${beat?.pace || 'balanced'}”；不要跨越未完成的节拍。`;
    return `推进速度：${mode}`;
}

export function buildExecutionCard({ directorState, memoryState, recentText = '', calendarContext = null }) {
    const director = normalizeDirectorState(directorState);
    if (!director.enabled) return '';
    const { arc, beat } = activeBeat(director);
    const branch = selectedBranch(director);
    const confirmedMainline = Boolean(director.mainPlan?.status === 'locked');
    const sections = [
        '<gaga_director>',
        '【强制执行规则】这是当前正文生成必须遵循的幕后导演执行卡。正文不得提及执行卡；未来计划不得伪装成回忆；已发生事实与人物认知边界始终优先。',
        '【全局标点规则】本轮生成的正文、对白和标题严禁使用任何破折号。需要停顿、转折或补充说明时，必须改用逗号、句号、冒号、分号或括号。',
        '本轮只能推进当前阶段与当前节拍。不得擅自跳到后续阶段、提前完成禁做事项、改写已确认主线，或用突发事件绕开当前节拍。若一轮无法自然完成，只推进其中一个合理步骤并保留余韵。',
        director.toggles.mainline && director.mainPlan ? `【${confirmedMainline ? '已确认主线，必须遵循' : '主线草案，按当前设置执行'}】\n${director.mainPlan.title}\n${director.mainPlan.premise}` : '',
        director.toggles.mainline && arc ? `【当前阶段】\n${arc.title}\n目标：${arc.goal}\n冲突：${arc.conflict}` : '',
        director.toggles.pacing ? `【本轮推进】\n${pacingInstruction(director, arc, beat)}\n${beat ? `节拍目标：${beat.goal}\n允许：${beat.allowed.join('；') || '自然推进'}\n完成条件：${beat.completion.join('；') || '以正文实际发展为准'}\n禁止提前发生：${beat.forbidden.join('；') || '不要跨越未完成节拍'}` : '当前没有锁定节拍，请保持自然推进。'}` : '',
        director.toggles.branch && branch ? `【已采用分支，必须遵循】\n${branch.title}\n${branch.summary}\n预期后果：${branch.consequences.join('；') || '以正文实际发展为准'}` : '',
        director.toggles.foreshadow ? `【本轮可使用的伏笔】\n${director.foreshadows.filter(item => ['planned', 'seeded', 'reinforced'].includes(item.status)).slice(0, 8).map(item => `- ${item.name}：${item.surface}${item.targetArc ? `（目标阶段：${item.targetArc}）` : ''}`).join('\n') || '无；不要凭空添加伏笔。'}` : '',
        calendarContext?.cardText ? `${calendarContext.cardText}\n日历事件只是可选的剧情背景或提醒，不是已发生事实；若不合适就忽略，不得强行触发。` : '',
        !director.toggles.newCharacters ? '【限制】本轮不得引入新角色。' : '',
        !director.toggles.sidePlots ? '【限制】本轮不得开启额外支线。' : '',
        memoryState?.recap ? `【记忆锚点】\n${compactText(memoryState.recap, 4000)}` : '',
        recentText ? `【最近正文仅供衔接】\n${compactText(recentText, 5000)}` : '',
        '【生成前自检】确认正文只推进当前节拍，保留禁止事项，服从已确认主线与已采用分支，并延续最近正文；发现冲突时放慢推进，不得自行改线。',
        '</gaga_director>',
    ].filter(Boolean);
    return sections.join('\n\n');
}

export function applyLonglineToDirector(state, packet) {
    const next = normalizeDirectorState(state);
    const incoming = normalizeMainPlan(packet);
    if (next.mainPlan?.status === 'locked') {
        const existingIds = new Set(next.mainPlan.arcs.map(item => item.id));
        const appendedArcs = incoming.arcs.map((item, index) => existingIds.has(item.id)
            ? { ...item, id: `${item.id}_continuation_${next.mainPlan.arcs.length + index + 1}` }
            : item);
        next.mainPlan = normalizeMainPlan({
            ...next.mainPlan,
            outline: [...new Set([...(next.mainPlan.outline || []), ...incoming.outline])],
            ending: incoming.ending || next.mainPlan.ending,
            arcs: [...next.mainPlan.arcs, ...appendedArcs],
            status: 'locked',
            createdAt: next.mainPlan.createdAt,
        });
        next.mainPlan.status = 'locked';
        if (!next.currentArcId && appendedArcs.length) {
            next.currentArcId = appendedArcs[0].id;
            next.currentBeatId = appendedArcs[0].beats[0]?.id || '';
            next.turnsSpent = 0;
        }
    } else {
        next.mainPlan = incoming;
        next.mainPlan.status = 'draft';
        next.currentArcId = next.mainPlan.arcs[0]?.id || '';
        next.currentBeatId = next.mainPlan.arcs[0]?.beats[0]?.id || '';
        next.turnsSpent = 0;
    }
    next.lastPlanAt = Date.now();
    return next;
}

export function lockMainline(state) {
    const next = normalizeDirectorState(state);
    if (next.mainPlan) next.mainPlan = { ...next.mainPlan, status: 'locked', updatedAt: Date.now() };
    return next;
}

export function unlockMainline(state) {
    const next = normalizeDirectorState(state);
    if (next.mainPlan) next.mainPlan = { ...next.mainPlan, status: 'draft', updatedAt: Date.now() };
    return next;
}

export function applyBranchesToDirector(state, packet) {
    const next = normalizeDirectorState(state);
    next.branchCandidates = normalizeBranches(packet);
    next.activeBranchId = '';
    return next;
}

export function selectBranch(state, branchId) {
    const next = normalizeDirectorState(state);
    const id = String(branchId || '');
    next.activeBranchId = next.branchCandidates.some(item => item.id === id) ? id : '';
    next.branchCandidates = next.branchCandidates.map(item => item.id === id
        ? { ...item, status: 'active' }
        : { ...item, status: item.status === 'active' ? 'candidate' : item.status });
    return next;
}

export function clearActiveBranch(state) {
    return selectBranch(state, '');
}

export function setCurrentDirectorBeat(state, arcId, beatId) {
    const next = normalizeDirectorState(state);
    const arc = next.mainPlan?.arcs?.find(item => item.id === String(arcId || ''));
    const beat = arc?.beats?.find(item => item.id === String(beatId || ''));
    if (!arc || !beat) return next;
    next.currentArcId = arc.id;
    next.currentBeatId = beat.id;
    next.turnsSpent = 0;
    return next;
}

export function directorProgressSnapshot(state) {
    const director = normalizeDirectorState(state);
    const { arc, beat } = activeBeat(director);
    const arcs = director.mainPlan?.arcs || [];
    const beats = arcs.flatMap(item => item.beats || []);
    const lastProgress = director.progressLog.at(-1) || null;
    return {
        hasPlan: Boolean(director.mainPlan),
        arc,
        beat,
        arcIndex: arc ? arcs.findIndex(item => item.id === arc.id) : -1,
        arcTotal: arcs.length,
        beatIndex: arc && beat ? arc.beats.findIndex(item => item.id === beat.id) : -1,
        beatTotal: arc?.beats?.length || 0,
        completedArcs: arcs.filter(item => item.status === 'completed').length,
        completedBeats: beats.filter(item => item.status === 'completed').length,
        totalBeats: beats.length,
        turnsSpent: director.turnsSpent,
        lastProgress,
    };
}

export function applyForeshadowsToDirector(state, packet) {
    const next = normalizeDirectorState(state);
    next.foreshadows = normalizeForeshadows(packet);
    return next;
}

export function applyProgressToDirector(state, progress) {
    const next = normalizeDirectorState(state);
    const result = record(progress);
    const { arc, beat } = activeBeat(next);
    next.progressLog = [...next.progressLog, {
        ...result,
        createdAt: Date.now(),
        beatId: beat?.id || next.currentBeatId,
    }].slice(-100);
    next.lastProgressAt = Date.now();
    if (result.beatCompleted && beat && arc) {
        const nextBeats = arc.beats.map(item => item.id === beat.id ? { ...item, status: 'completed' } : item);
        const nextArc = { ...arc, beats: nextBeats, status: nextBeats.every(item => item.status === 'completed') ? 'completed' : arc.status };
        next.mainPlan = {
            ...next.mainPlan,
            arcs: next.mainPlan.arcs.map(item => item.id === arc.id ? nextArc : item),
        };
        const followingBeat = nextArc.beats.find(item => item.status !== 'completed');
        const followingArc = next.mainPlan.arcs.find(item => item.status !== 'completed');
        next.currentArcId = followingArc?.id || '';
        next.currentBeatId = followingBeat?.id || followingArc?.beats.find(item => item.status !== 'completed')?.id || '';
        next.turnsSpent = 0;
    } else {
        next.turnsSpent += 1;
    }
    return next;
}

function copyDirectorValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function directorContentSnapshot(state) {
    const director = normalizeDirectorState(state);
    return {
        mainPlan: copyDirectorValue(director.mainPlan),
        branchCandidates: copyDirectorValue(director.branchCandidates),
        activeBranchId: director.activeBranchId,
        foreshadows: copyDirectorValue(director.foreshadows),
        currentArcId: director.currentArcId,
        currentBeatId: director.currentBeatId,
        turnsSpent: director.turnsSpent,
    };
}

function mergePlanRevision(currentPlan, incomingPlan, scope) {
    if (!currentPlan || !incomingPlan) return currentPlan;
    if (scope === 'outline') {
        const outline = Array.isArray(incomingPlan.outline) ? incomingPlan.outline : [];
        const revised = normalizeMainPlan({ ...currentPlan, outline, status: currentPlan.status, createdAt: currentPlan.createdAt });
        revised.status = currentPlan.status;
        return revised;
    }
    const incomingArcs = Array.isArray(incomingPlan.arcs) ? incomingPlan.arcs : currentPlan.arcs;
    const preparedArcs = list(incomingArcs, 30).map((incomingArc, arcIndex) => {
        const oldArc = currentPlan.arcs?.find(item => item.id === incomingArc?.id) || currentPlan.arcs?.[arcIndex];
        return {
            ...incomingArc,
            id: incomingArc?.id || oldArc?.id,
            status: oldArc?.status || incomingArc?.status,
            beats: list(incomingArc?.beats, 80).map((incomingBeat, beatIndex) => {
                const oldBeat = oldArc?.beats?.find(item => item.id === incomingBeat?.id) || oldArc?.beats?.[beatIndex];
                return {
                    ...incomingBeat,
                    id: incomingBeat?.id || oldBeat?.id,
                    status: oldBeat?.status || incomingBeat?.status,
                };
            }),
        };
    });
    const revised = normalizeMainPlan({ ...currentPlan, ...incomingPlan, arcs: preparedArcs, status: currentPlan.status, createdAt: currentPlan.createdAt });
    revised.status = currentPlan.status;
    return revised;
}

export function stageDirectorRevision(state, packet, scope = 'all', instruction = '') {
    const next = normalizeDirectorState(state);
    const safeScope = DIRECTOR_REVISION_SCOPES.some(item => item.id === scope) ? scope : 'all';
    const source = record(packet);
    const draft = {
        id: `revision_${Date.now()}`,
        scope: safeScope,
        instruction: compactText(instruction, 12000),
        changeSummary: list(source.changeSummary, 8).map(item => compactText(item, 800)).filter(Boolean),
        mainPlan: null,
        branchCandidates: null,
        foreshadows: null,
        createdAt: Date.now(),
    };
    if (['outline', 'mainline', 'all'].includes(safeScope) && source.mainPlan) {
        draft.mainPlan = mergePlanRevision(next.mainPlan, source.mainPlan, safeScope);
    }
    if (['branches', 'all'].includes(safeScope) && Array.isArray(source.branches)) draft.branchCandidates = normalizeBranches(source.branches);
    if (['foreshadows', 'all'].includes(safeScope) && Array.isArray(source.foreshadows)) draft.foreshadows = normalizeForeshadows(source.foreshadows);
    if (!draft.mainPlan && !draft.branchCandidates && !draft.foreshadows) throw new Error('修订结果没有包含所选范围的有效内容。');
    next.revisionRequest = { scope: safeScope, instruction: draft.instruction };
    next.revisionDraft = draft;
    return next;
}

export function applyDirectorRevision(state) {
    const next = normalizeDirectorState(state);
    const draft = next.revisionDraft;
    if (!draft) return next;
    const before = directorContentSnapshot(next);
    if (draft.mainPlan) next.mainPlan = copyDirectorValue(draft.mainPlan);
    if (Array.isArray(draft.branchCandidates)) next.branchCandidates = copyDirectorValue(draft.branchCandidates);
    if (Array.isArray(draft.foreshadows)) next.foreshadows = copyDirectorValue(draft.foreshadows);

    const currentArc = next.mainPlan?.arcs?.find(item => item.id === before.currentArcId);
    const currentBeat = currentArc?.beats?.find(item => item.id === before.currentBeatId);
    if (currentArc && currentBeat) {
        next.currentArcId = currentArc.id;
        next.currentBeatId = currentBeat.id;
        next.turnsSpent = before.turnsSpent;
    } else {
        const fallbackArc = next.mainPlan?.arcs?.find(item => item.status !== 'completed') || next.mainPlan?.arcs?.[0];
        const fallbackBeat = fallbackArc?.beats?.find(item => item.status !== 'completed') || fallbackArc?.beats?.[0];
        next.currentArcId = fallbackArc?.id || '';
        next.currentBeatId = fallbackBeat?.id || '';
        next.turnsSpent = 0;
    }
    next.activeBranchId = next.branchCandidates.some(item => item.id === before.activeBranchId) ? before.activeBranchId : '';
    next.revisionHistory = [...next.revisionHistory, {
        id: draft.id,
        scope: draft.scope,
        instruction: draft.instruction,
        changeSummary: copyDirectorValue(draft.changeSummary),
        before,
        createdAt: Date.now(),
    }].slice(-10);
    next.revisionDraft = null;
    next.lastPlanAt = Date.now();
    return normalizeDirectorState(next);
}

export function discardDirectorRevision(state) {
    return normalizeDirectorState({ ...normalizeDirectorState(state), revisionDraft: null });
}

export function undoDirectorRevision(state) {
    const next = normalizeDirectorState(state);
    const last = next.revisionHistory.at(-1);
    if (!last?.before) return next;
    const restored = record(last.before);
    return normalizeDirectorState({
        ...next,
        ...copyDirectorValue(restored),
        revisionDraft: null,
        revisionHistory: next.revisionHistory.slice(0, -1),
        lastPlanAt: Date.now(),
    });
}

export function directorTokenEstimate(state) {
    return tokenEstimate(buildExecutionCard({ directorState: state }));
}

export function directorKeywords(state) {
    const director = normalizeDirectorState(state);
    return extractKeywords(JSON.stringify({ plan: director.mainPlan, branch: selectedBranch(director), foreshadows: director.foreshadows }));
}
