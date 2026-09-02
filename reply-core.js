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

const REPLY_STYLE_GUIDANCE = `文风与文学创作要求：延续最近正文的叙事视角、时态、语感和用词密度，保持人物说话方式与关系阶段一致。每个候选都要有明确的回应对象、情绪变化和可执行动作，让回复自然承接当前场面并推动互动。优先使用具体的神态、动作、触感、声音和环境细节，避免空泛抒情、套话、重复形容词和解释作者意图。只替用户角色写出当下能够知道和做出的内容，不替对方角色做决定，不泄露角色未知秘密。正文段落之间只保留一个换行，不插入空白行。严禁使用先否定后肯定的转折句式，包括“不是……而是……”和“没有……没有……而是……”等变体。严禁使用破折号或连续短横线。`;

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
        systemPrompt: `你是“嘎嘎小狗”的用户回复代写助手。你只生成用户可以选择的回复草稿，不替用户发送消息。\n\n必须遵守用户角色已经知道的内容，不得让用户角色凭空知道角色秘密。五个候选必须代表不同的行动意图，而不是同一句话的五种同义改写。${REPLY_STYLE_GUIDANCE}\n\n输出合法 JSON，不要输出 Markdown。`,
        prompt: `<代写任务>\n请根据当前正文，生成 ${settings.candidateCount} 个真正不同的用户回复候选。\n\n<写作设置>\n用户名称：${userName}\n用户人设：${compactText(userPersona, 12000) || '无'}\n视角：${viewpoint}\n描写密度：${detail}\n长度：${settings.length}\n情绪倾向：${settings.tone}\n主动程度：${settings.initiative}\n自定义要求：${settings.customInstruction || '无'}\n</写作设置>\n\n<已发生记忆>\n${formatMemory(memory) || '无'}\n</已发生记忆>\n\n${settings.followDirector && directorCard ? `<当前导演执行卡>\n${compactText(directorCard, 10000)}\n</当前导演执行卡>` : ''}\n\n<最近正文>\n${compactText(recentText, 30000) || '无'}\n</最近正文>\n\n<输出格式>\n{\"candidates\":[{\"title\":\"候选名称\",\"intent\":\"行动意图\",\"text\":\"实际可发送的回复正文\",\"possibleEffect\":\"可能后果\"}]}\n</输出格式>\n${REPLY_STYLE_GUIDANCE}\n只输出一个完整 JSON 对象，不要 Markdown 代码围栏或解释。JSON 字符串中的换行必须写成 \\n，正文对话中的双引号必须写成 \\\"；不要输出未转义的控制字符。当前角色名：${characterName}。候选正文不得包含标题、解释或 JSON 以外的内容。`,
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

function repairLooseJson(value) {
    const source = String(value || '');
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (!inString) {
            output += char;
            if (char === '"') inString = true;
            continue;
        }
        if (escaped) {
            // Preserve valid JSON escapes. If a model emitted a stray slash,
            // quote it so one malformed character cannot invalidate all replies.
            if (!'"\\/bfnrtu'.includes(char)) output += '\\\\';
            output += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            output += char;
            escaped = true;
            continue;
        }
        if (char === '\r') {
            if (source[index + 1] === '\n') index += 1;
            output += '\\n';
            continue;
        }
        if (char === '\n') {
            output += '\\n';
            continue;
        }
        if (char === '"') {
            let rest = source.slice(index + 1);
            // A model may encode line breaks as literal `\\n` text. Skip those
            // escape sequences while deciding whether this quote closes the
            // JSON value; a dialogue quote before more prose is still content.
            while (true) {
                const whitespace = rest.match(/^\s+/)?.[0] || '';
                if (whitespace) rest = rest.slice(whitespace.length);
                if (/^\\[nrt]/.test(rest)) {
                    rest = rest.slice(2);
                    continue;
                }
                break;
            }
            const next = /^[,}:\]]/.test(rest) ? rest[0] : '';
            if (next || !source.slice(index + 1).trim()) {
                output += char;
                inString = false;
            } else {
                // Chinese dialogue frequently contains unescaped quotation
                // marks inside a generated text value. Treat those as content.
                output += '\\"';
            }
            continue;
        }
        if (char.charCodeAt(0) < 0x20) {
            output += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
            continue;
        }
        output += char;
    }
    return output;
}

function normalizeReplyText(value) {
    let text = String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    // Keep the prose readable while enforcing the requested punctuation rule.
    text = text.replace(/(?:—|–|―|－|-{2,})+/g, '，');
    text = text.replace(/没有([^，。；！？\n]{0,80})[，,]?\s*没有([^，。；！？\n]{0,80})[，,]?\s*而是\s*/g, '只是');
    text = text.replace(/(?:不是|并非)([^，。；！？\n]{0,80})[，,]?\s*而是\s*/g, '只是');
    return text;
}

export function parseReplyCandidates(raw, count = 5) {
    for (const candidate of jsonCandidates(raw)) {
        for (const source of [candidate, repairLooseJson(candidate)]) {
            try {
                const parsed = JSON.parse(source);
            const rows = Array.isArray(parsed) ? parsed : parsed?.candidates;
            if (!Array.isArray(rows) || !rows.length) continue;
            const output = rows.slice(0, Math.max(1, Math.min(5, Number(count) || 5))).map((item, index) => ({
                id: String(item?.id || `reply_${Date.now()}_${index + 1}`),
                title: normalizeReplyText(compactText(item?.title || `候选 ${index + 1}`, 120)),
                intent: normalizeReplyText(compactText(item?.intent || '', 300)),
                text: normalizeReplyText(compactText(item?.text || item?.reply || item?.content || '', 6000)),
                possibleEffect: normalizeReplyText(compactText(item?.possibleEffect || item?.effect || '', 500)),
            })).filter(item => item.text);
            if (output.length) return output;
            } catch { /* Try the strict and repaired bounded JSON candidates. */ }
        }
    }
    throw new Error('代写模型没有返回合法候选回复。');
}
