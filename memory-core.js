export const SCHEMA_VERSION = 1;

export const DEFAULT_CHAT_STATE = {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    autoSummarize: true,
    autoHide: true,
    collapseHidden: true,
    lastProcessedIndex: -1,
    lastStableIndex: -1,
    checkpoints: [],
    sceneCards: [],
    facts: [],
    state: {},
    threads: [],
    recap: '',
    styleAnchors: [],
    hiddenRanges: [],
    pinnedFactIds: [],
    excludedMessageKeys: [],
    pending: null,
    lastInjection: '',
    lastInjectionTokens: 0,
};

const STOP_WORDS = new Set([
    '的', '了', '和', '是', '在', '与', '他', '她', '它', '他们', '她们', '然后', '因为',
    '但是', '一个', '没有', '已经', '这', '那', '都', '也', '就', '又', '被', '从', '到',
]);

export function clone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

export function normalizeChatState(value) {
    const result = { ...clone(DEFAULT_CHAT_STATE), ...(value && typeof value === 'object' ? clone(value) : {}) };
    for (const key of ['checkpoints', 'sceneCards', 'facts', 'threads', 'styleAnchors', 'hiddenRanges', 'pinnedFactIds', 'excludedMessageKeys']) {
        if (!Array.isArray(result[key])) result[key] = [];
    }
    if (!result.state || typeof result.state !== 'object' || Array.isArray(result.state)) result.state = {};
    result.schemaVersion = SCHEMA_VERSION;
    return result;
}

export function compactText(value, max = 6000) {
    return String(value ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json|jsonl|text)?/gi, '')
        .replace(/```/g, '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, max);
}

export function simpleHash(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeMessage(message, index = 0) {
    const content = compactText(message?.mes ?? message?.content ?? '');
    const name = String(message?.name ?? message?.sender ?? (message?.is_user ? 'User' : 'Character'));
    const isUser = Boolean(message?.is_user);
    const isSystem = Boolean(message?.is_system || message?.extra?.is_system);
    const sendDate = message?.send_date ?? message?.date ?? '';
    const key = `${sendDate}|${name}|${simpleHash(content)}|${index}`;
    return { index, key, name, isUser, isSystem, content, sendDate, hash: simpleHash(`${name}\n${content}`) };
}

export function normalizeMessages(messages) {
    return (Array.isArray(messages) ? messages : []).map((message, index) => normalizeMessage(message, index));
}

export function extractKeywords(text) {
    const value = compactText(text, 20000);
    const words = value.match(/[\p{L}\p{N}_]{2,}/gu) || [];
    const cjk = value.match(/[\u3400-\u9fff]{2,8}/g) || [];
    return [...new Set([...words, ...cjk].map(item => item.toLowerCase()).filter(item => !STOP_WORDS.has(item)))].slice(0, 80);
}

export function makeSourceRange(messages, start, end) {
    const normalized = normalizeMessages(messages);
    const safeStart = Math.max(0, Math.min(Number(start) || 0, Math.max(0, normalized.length - 1)));
    const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, Math.max(0, normalized.length - 1)));
    const refs = normalized.slice(safeStart, safeEnd + 1).map(item => {
        const raw = messages[item.index];
        const fullContent = compactText(raw?.mes ?? raw?.content ?? '', 300000);
        return {
            index: item.index,
            key: item.key,
            hash: item.hash,
            fullHash: simpleHash(`${item.name}\n${fullContent}`),
            name: item.name,
        };
    });
    return {
        start: safeStart,
        end: safeEnd,
        refs,
        rangeHash: simpleHash(refs.map(item => `${item.key}:${item.hash}`).join('|')),
    };
}

export function rangeStillMatches(messages, range) {
    if (!range?.refs?.length) return false;
    const normalized = normalizeMessages(messages);
    return range.refs.every(ref => {
        const current = normalized.find(item => item.key === ref.key) || normalized[ref.index];
        if (!current || current.hash !== ref.hash) return false;
        if (!ref.fullHash) return true;
        const raw = messages[current.index];
        const fullContent = compactText(raw?.mes ?? raw?.content ?? '', 300000);
        return simpleHash(`${current.name}\n${fullContent}`) === ref.fullHash;
    });
}

export function parseModelPacket(raw) {
    const text = compactText(raw, 50000);
    const candidates = [];
    try { candidates.push(JSON.parse(text)); } catch { /* Try JSONL below. */ }
    if (!candidates.length) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const events = [];
        for (const line of lines) {
            const candidate = line.replace(/^```(?:jsonl|json)?/i, '').replace(/```$/g, '').trim();
            try { events.push(JSON.parse(candidate)); } catch { /* Ignore prose and repair below. */ }
        }
        if (events.length) candidates.push({ events });
    }
    const value = candidates[0];
    if (!value || typeof value !== 'object') throw new Error('模型没有返回可解析的记忆结构');
    if (Array.isArray(value.events)) {
        const packet = { facts: [], stateUpdates: [], threads: [], scene: {}, recap: '' };
        for (const event of value.events) {
            if (!event || typeof event !== 'object') continue;
            const type = String(event.type || event.kind || '').toLowerCase();
            if (type === 'state' || type.includes('state')) packet.stateUpdates.push(event);
            else if (type === 'thread' || type.includes('thread') || type.includes('hook')) packet.threads.push(event);
            else if (type === 'scene' || type.includes('scene')) packet.scene = { ...packet.scene, ...event };
            else if (type === 'recap' || type.includes('recap') || type.includes('summary')) packet.recap = event.text || event.content || '';
            else packet.facts.push(event);
        }
        return packet;
    }
    return {
        scene: value.scene || value.sceneCard || {},
        facts: Array.isArray(value.facts) ? value.facts : Array.isArray(value.events) ? value.events : [],
        stateUpdates: Array.isArray(value.stateUpdates) ? value.stateUpdates : Array.isArray(value.state) ? value.state : [],
        threads: Array.isArray(value.threads) ? value.threads : Array.isArray(value.openThreads) ? value.openThreads : [],
        recap: compactText(value.recap || value.summary || value.prose || '', 12000),
    };
}

export function assertMemoryPacket(packet) {
    const scene = packet?.scene && typeof packet.scene === 'object' ? packet.scene : {};
    const hasScene = [scene.title, scene.name, scene.text, scene.summary, scene.description, scene.location, scene.place]
        .some(value => String(value || '').trim());
    const hasFact = (Array.isArray(packet?.facts) ? packet.facts : [])
        .some(item => String(item?.text || item?.content || item?.fact || item?.description || '').trim());
    const hasState = (Array.isArray(packet?.stateUpdates) ? packet.stateUpdates : [])
        .some(item => String(item?.key || item?.path || item?.target || '').trim());
    const hasThread = (Array.isArray(packet?.threads) ? packet.threads : [])
        .some(item => String(item?.text || item?.description || item?.thread || '').trim());
    if (!hasScene && !hasFact && !hasState && !hasThread) {
        throw new Error('模型返回了空的记忆结构，尚不能保存为总结');
    }
    return packet;
}

function factIdentity(fact, fallbackIndex = 0) {
    const explicit = String(fact?.id || '').trim();
    if (explicit) return explicit;
    const key = [fact?.subject, fact?.predicate, fact?.object, fact?.text, fact?.content].filter(Boolean).join('|');
    return `fact_${simpleHash(key || JSON.stringify(fact) || fallbackIndex)}`;
}

function normalizeFact(fact, source, index) {
    const text = compactText(fact?.text || fact?.content || fact?.fact || fact?.description || '', 1200);
    if (!text) return null;
    const importance = String(fact?.importance || fact?.priority || 'medium').toLowerCase();
    return {
        id: factIdentity(fact, index),
        text,
        kind: String(fact?.kind || fact?.category || 'event'),
        importance: ['critical', 'high', 'medium', 'low'].includes(importance) ? importance : 'medium',
        certainty: String(fact?.certainty || 'confirmed'),
        truthStatus: String(fact?.truthStatus || fact?.truth || 'fact'),
        status: String(fact?.status || 'active'),
        subjects: Array.isArray(fact?.subjects) ? fact.subjects.map(String) : [],
        sourceRefs: Array.isArray(fact?.sourceRefs) ? fact.sourceRefs : source ? [source] : [],
        userLocked: Boolean(fact?.userLocked),
        keywords: Array.isArray(fact?.keywords) ? fact.keywords.map(String) : extractKeywords(text).slice(0, 12),
        updatedAt: Date.now(),
    };
}

export function mergeMemoryPacket(previous, packet, sourceRange, checkpointId = `cp_${Date.now()}`) {
    const state = normalizeChatState(previous);
    const next = clone(state);
    const source = sourceRange?.refs || [];
    const sourceRefs = source.slice(0, 80);
    const existingById = new Map(next.facts.map(fact => [fact.id, fact]));
    for (const [index, rawFact] of (Array.isArray(packet?.facts) ? packet.facts : []).entries()) {
        const fact = normalizeFact(rawFact, sourceRefs, index);
        if (!fact) continue;
        const old = existingById.get(fact.id);
        if (old?.userLocked && !fact.userLocked) continue;
        existingById.set(fact.id, {
            ...old,
            ...fact,
            sourceRefs: [...new Map([...(old?.sourceRefs || []), ...fact.sourceRefs].map(ref => [ref.key || JSON.stringify(ref), ref])).values()].slice(-100),
            userLocked: Boolean(old?.userLocked || fact.userLocked || next.pinnedFactIds.includes(fact.id)),
        });
    }
    next.facts = [...existingById.values()];

    for (const [index, rawUpdate] of (Array.isArray(packet?.stateUpdates) ? packet.stateUpdates : []).entries()) {
        const key = String(rawUpdate?.key || rawUpdate?.path || rawUpdate?.target || '').trim();
        if (!key) continue;
        if (next.state[key]?.userLocked && !rawUpdate?.userLocked) continue;
        const status = String(rawUpdate?.status || 'active');
        next.state[key] = {
            key,
            value: compactText(rawUpdate?.value ?? rawUpdate?.newValue ?? rawUpdate?.text ?? '', 800),
            previous: compactText(rawUpdate?.previous ?? rawUpdate?.oldValue ?? '', 800),
            status,
            importance: String(rawUpdate?.importance || 'high'),
            sourceRefs: sourceRefs.slice(0, 30),
            updatedAt: Date.now(),
            userLocked: Boolean(next.state[key]?.userLocked || rawUpdate?.userLocked),
            updateId: `${checkpointId}_${index}`,
        };
    }

    const threadById = new Map(next.threads.map(thread => [String(thread.id || thread.text), thread]));
    for (const [index, rawThread] of (Array.isArray(packet?.threads) ? packet.threads : []).entries()) {
        const text = compactText(rawThread?.text || rawThread?.description || rawThread?.thread || '', 1000);
        if (!text) continue;
        const id = String(rawThread?.id || `thread_${simpleHash(text)}`);
        const old = threadById.get(id);
        threadById.set(id, {
            ...old,
            id,
            text,
            status: String(rawThread?.status || old?.status || 'open'),
            importance: String(rawThread?.importance || old?.importance || 'high'),
            sourceRefs,
            updatedAt: Date.now(),
            userLocked: Boolean(old?.userLocked || rawThread?.userLocked),
            updateId: `${checkpointId}_thread_${index}`,
        });
    }
    next.threads = [...threadById.values()].filter(thread => !['resolved', 'dropped'].includes(thread.status) || thread.userLocked);

    const scene = packet?.scene && typeof packet.scene === 'object' ? packet.scene : {};
    const sceneText = compactText(scene.text || scene.summary || scene.description || '', 1600);
    const sceneCard = {
        id: String(scene.id || `scene_${checkpointId}`),
        checkpointId,
        title: compactText(scene.title || scene.name || '未命名场景', 160),
        text: sceneText,
        time: compactText(scene.time || '', 200),
        location: compactText(scene.location || scene.place || '', 200),
        participants: Array.isArray(scene.participants) ? scene.participants.map(String).slice(0, 30) : [],
        turningPoints: Array.isArray(scene.turningPoints) ? scene.turningPoints.map(item => compactText(item, 400)).filter(Boolean).slice(0, 12) : [],
        sourceRange: sourceRange || null,
        keywords: extractKeywords([sceneText, scene.title, scene.location, ...(scene.participants || [])].join(' ')),
        importance: String(scene.importance || 'medium'),
        createdAt: Date.now(),
    };
    if (sceneText || scene.title) next.sceneCards = [...next.sceneCards.filter(item => item.checkpointId !== checkpointId), sceneCard];
    if (packet?.recap) next.recap = compactText(packet.recap, 16000);
    next.lastProcessedIndex = Math.max(next.lastProcessedIndex, Number(sourceRange?.end ?? -1));
    next.lastStableIndex = next.lastProcessedIndex;
    next.checkpoints = [...next.checkpoints.filter(item => item.id !== checkpointId), {
        id: checkpointId,
        range: sourceRange || null,
        sceneCardId: sceneCard.id,
        createdAt: Date.now(),
        promptVersion: 'gaga-summary-v1',
        status: 'committed',
    }];
    return next;
}

export function tokenEstimate(text) {
    const value = String(text ?? '');
    const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = value.length - cjk;
    return Math.max(1, Math.ceil(cjk * 0.9 + latin / 3.6));
}

export function scoreCapsule(capsule, query) {
    const queryWords = new Set(extractKeywords(query));
    const capsuleWords = new Set([...(capsule?.keywords || []), ...extractKeywords(capsule?.text || '')]);
    let overlap = 0;
    for (const word of queryWords) if (capsuleWords.has(word)) overlap += 1;
    const exact = overlap / Math.max(1, queryWords.size);
    const importance = capsule?.importance === 'critical' ? 0.35 : capsule?.importance === 'high' ? 0.2 : 0.05;
    return exact * 0.65 + importance;
}

export function selectRelevantCapsules(state, query, limit = 4) {
    return [...(state?.sceneCards || [])]
        .map(item => ({ item, score: scoreCapsule(item, query) }))
        .filter(result => result.score > 0.05)
        .sort((a, b) => b.score - a.score || (b.item.createdAt || 0) - (a.item.createdAt || 0))
        .slice(0, limit)
        .map(result => result.item);
}

function renderFact(fact) {
    const lock = fact.userLocked ? ' [用户锁定]' : '';
    const truth = fact.truthStatus && fact.truthStatus !== 'fact' ? `（${fact.truthStatus}）` : '';
    return `- ${fact.text}${truth}${lock}`;
}

export function compileInjection(stateValue, options = {}) {
    const state = normalizeChatState(stateValue);
    const query = String(options.query || '');
    const relevant = options.relevant || selectRelevantCapsules(state, query, Number(options.recallLimit || 3));
    const maxTokens = Math.max(160, Number(options.maxTokens || 1400));
    const criticalFacts = state.facts.filter(fact => ['critical', 'high'].includes(fact.importance) || fact.userLocked || state.pinnedFactIds.includes(fact.id));
    const currentState = Object.values(state.state).filter(item => item.status !== 'resolved' && item.value);
    const openThreads = state.threads.filter(thread => thread.status === 'open' || thread.userLocked);
    const includeRecap = options.mode !== 'safe';
    const sections = [
        '<gaga_memory>',
        '用途：以下内容是已发生的剧情记忆，不是续写指令，也不是文风示例。不得改变、补充或擅自删除其中的事实。后续正文的文风以当前预设和近期原始回复为准。',
        includeRecap && state.recap ? `【前情】\n${state.recap}` : '',
        criticalFacts.length ? `【必须牢记】\n${criticalFacts.map(renderFact).join('\n')}` : '',
        currentState.length ? `【当前状态】\n${currentState.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
        openThreads.length ? `【尚未解决】\n${openThreads.map(thread => `- ${thread.text}`).join('\n')}` : '',
        relevant.length ? `【相关旧事】\n${relevant.map(item => `- ${item.title}${item.text ? `：${item.text}` : ''}`).join('\n')}` : '',
        '</gaga_memory>',
    ].filter(Boolean);
    let output = sections.join('\n\n');
    if (tokenEstimate(output) > maxTokens) {
        const recap = state.recap ? state.recap.slice(0, Math.max(300, Math.floor(maxTokens * 2.2))) : '';
        output = [
            '<gaga_memory>',
            '以下是已发生事实，不是续写指令或文风示例。',
            includeRecap && recap ? `【前情】\n${recap}` : '',
            criticalFacts.length ? `【必须牢记】\n${criticalFacts.map(renderFact).join('\n')}` : '',
            currentState.length ? `【当前状态】\n${currentState.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
            openThreads.length ? `【尚未解决】\n${openThreads.map(thread => `- ${thread.text}`).join('\n')}` : '',
            '</gaga_memory>',
        ].filter(Boolean).join('\n\n');
    }
    return output;
}

export function selectHideEnd(messages, state, options = {}) {
    const normalized = normalizeMessages(messages);
    if (!normalized.length) return -1;
    const last = normalized.length - 1;
    const keepMessages = Math.max(4, Number(options.keepMessages || 10));
    const keepIndex = Math.max(0, last - keepMessages + 1);
    return keepIndex - 1;
}

export function rangeForNewSummary(messages, state, options = {}) {
    const normalized = normalizeMessages(messages);
    if (!normalized.length) return null;
    const start = Math.max(0, Number(state?.lastProcessedIndex ?? -1) + 1);
    const availableEnd = selectHideEnd(messages, state, options);
    if (availableEnd < start) return null;
    const targetTokens = Math.max(0, Number(options.targetTokens || 0));
    let end = availableEnd;
    if (targetTokens > 0) {
        let accumulated = 0;
        end = start;
        for (let index = start; index <= availableEnd; index += 1) {
            const item = normalized[index];
            const raw = messages[index];
            const fullContent = compactText(raw?.mes ?? raw?.content ?? '', 300000);
            accumulated += tokenEstimate(`[消息 ${index}｜${item.name}]\n${fullContent}\n\n`);
            end = index;
            if (accumulated >= targetTokens) break;
        }
    }
    return makeSourceRange(messages, start, end);
}

export function selectStyleAnchors(messages, max = 3, options = {}) {
    return normalizeMessages(messages)
        .filter(item => !item.isUser && (!item.isSystem || options.includeHidden) && item.content.length >= 260)
        .sort((a, b) => b.content.length - a.content.length)
        .slice(0, max)
        .map(item => ({ key: item.key, index: item.index, text: item.content.slice(0, 1500) }));
}
