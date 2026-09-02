import { compactText, normalizeChatState } from './memory-core.js';

export const REPLY_SCHEMA_VERSION = 1;

export const REPLY_VIEWPOINTS = [
    { id: 'first', name: '第一人称', description: '以用户角色的“我”来写。' },
    { id: 'third', name: '第三人称', description: '以角色姓名或“她／他”来写。' },
];

export const REPLY_DETAIL_LEVELS = [
    { id: 'dialogue', name: '仅对白', description: '只写自然的说话内容。' },
    { id: 'light', name: '对白＋简单动作', description: '补充必要的神态和动作。' },
    { id: 'full', name: '完整行动描写', description: '包含动作、神态、心理和环境，但不替角色决定未知信息。' },
];

export function createEmptyReplyState() {
    return {
        schemaVersion: REPLY_SCHEMA_VERSION,
        viewpoint: 'first',
        detail: 'light',
        length: 'medium',
        tone: '自然克制',
        initiative: 'natural',
        followDirector: true,
        candidateCount: 5,
        customInstruction: '',
        lastCandidates: [],
        createdAt: 0,
    };
}

export function normalizeReplyState(value) {
    const defaults = createEmptyReplyState();
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const result = { ...defaults, ...input };
    result.schemaVersion = REPLY_SCHEMA_VERSION;
    result.viewpoint = REPLY_VIEWPOINTS.some(item => item.id === result.viewpoint) ? result.viewpoint : defaults.viewpoint;
    result.detail = REPLY_DETAIL_LEVELS.some(item => item.id === result.detail) ? result.detail : defaults.detail;
    result.length = ['short', 'medium', 'long'].includes(result.length) ? result.length : defaults.length;
    result.initiative = ['passive', 'natural', 'active'].includes(result.initiative) ? result.initiative : defaults.initiative;
    result.tone = compactText(result.tone || defaults.tone, 200);
    result.followDirector = result.followDirector !== false && result.followDirector !== 'false';
    result.candidateCount = Math.max(1, Math.min(5, Number(result.candidateCount || 5) || 5));
    result.customInstruction = compactText(result.customInstruction, 10000);
    result.lastCandidates = Array.isArray(result.lastCandidates) ? result.lastCandidates.slice(0, 5) : [];
    return result;
}

function formatMemory(memory) {
    const state = normalizeChatState(memory);
    const current = Object.values(state.state).filter(item => item.status !== 'resolved' && item.value).slice(-30);
    const threads = state.threads.filter(item => item.status === 'open' || item.userLocked).slice(-30);
    const facts = state.facts.filter(item => ['critical', 'high'].includes(item.importance) || item.userLocked).slice(-60);
    return [
        state.recap ? `【前情】\n${compactText(state.recap, 10000)}` : '',
        facts.length ? `【关键事实】\n${facts.map(item => `- ${item.text}`).join('\n')}` : '',
        current.length ? `【当前状态】\n${current.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
        threads.length ? `【未结事项】\n${threads.map(item => `- ${item.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
}

export function buildReplyPrompt({ recentText = '', memory, directorCard = '', userPersona = '', userName = '用户', characterName = '角色', preferences = {} }) {
    const settings = normalizeReplyState(preferences);
    const viewpoint = REPLY_VIEWPOINTS.find(item => item.id === settings.viewpoint)?.name || '第一人称';
    const detail = REPLY_DETAIL_LEVELS.find(item => item.id === settings.detail)?.name || '对白＋简单动作';
    return {
        systemPrompt: `你是“嘎嘎小狗”的用户回复代写助手。你只生成用户可以选择的回复草稿，不替用户发送消息。\n\n必须遵守用户角色已经知道的内容，不得让用户角色凭空知道角色秘密。五个候选必须代表不同的行动意图，而不是同一句话的五种同义改写。输出合法 JSON，不要输出 Markdown。`,
        prompt: `<代写任务>\n请根据当前正文，生成 ${settings.candidateCount} 个真正不同的用户回复候选。\n\n<写作设置>\n用户名称：${userName}\n用户人设：${compactText(userPersona, 12000) || '无'}\n视角：${viewpoint}\n描写密度：${detail}\n长度：${settings.length}\n情绪倾向：${settings.tone}\n主动程度：${settings.initiative}\n自定义要求：${settings.customInstruction || '无'}\n</写作设置>\n\n<已发生记忆>\n${formatMemory(memory) || '无'}\n</已发生记忆>\n\n${settings.followDirector && directorCard ? `<当前导演执行卡>\n${compactText(directorCard, 10000)}\n</当前导演执行卡>` : ''}\n\n<最近正文>\n${compactText(recentText, 30000) || '无'}\n</最近正文>\n\n<输出格式>\n{\"candidates\":[{\"title\":\"候选名称\",\"intent\":\"行动意图\",\"text\":\"实际可发送的回复正文\",\"possibleEffect\":\"可能后果\"}]}\n</输出格式>\n当前角色名：${characterName}。候选正文不得包含标题、解释或 JSON 以外的内容。`,
    };
}

function jsonCandidates(raw) {
    const value = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [value, value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')];
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(value.slice(start, end + 1));
    return [...new Set(candidates.filter(Boolean))];
}

export function parseReplyCandidates(raw, count = 5) {
    for (const candidate of jsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const rows = Array.isArray(parsed) ? parsed : parsed?.candidates;
            if (!Array.isArray(rows) || !rows.length) continue;
            const output = rows.slice(0, Math.max(1, Math.min(5, Number(count) || 5))).map((item, index) => ({
                id: String(item?.id || `reply_${Date.now()}_${index + 1}`),
                title: compactText(item?.title || `候选 ${index + 1}`, 120),
                intent: compactText(item?.intent || '', 300),
                text: compactText(item?.text || item?.reply || item?.content || '', 6000),
                possibleEffect: compactText(item?.possibleEffect || item?.effect || '', 500),
            })).filter(item => item.text);
            if (output.length) return output;
        } catch { /* Try the next bounded JSON candidate. */ }
    }
    throw new Error('代写模型没有返回合法候选回复。');
}
