export const SCHEMA_VERSION = 2;

export const DEFAULT_CHAT_STATE = {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    memoryMode: 'manual',
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
    summaryMode: 'mixed',
    summaryArtifacts: { novel: '', structured: '', mixed: '' },
    roundCapsules: [],
    memoryArchives: [],
    lastCapsuleIndex: -1,
    styleAnchors: [],
    hiddenRanges: [],
    pinnedFactIds: [],
    excludedMessageKeys: [],
    pending: null,
    lastInjection: '',
    lastInjectionTokens: 0,
    director: null,
    reply: null,
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
    delete result.autoSummarize;
    for (const key of ['checkpoints', 'sceneCards', 'facts', 'threads', 'styleAnchors', 'hiddenRanges', 'pinnedFactIds', 'excludedMessageKeys', 'roundCapsules', 'memoryArchives']) {
        if (!Array.isArray(result[key])) result[key] = [];
    }
    if (!result.state || typeof result.state !== 'object' || Array.isArray(result.state)) result.state = {};
    result.summaryMode = ['novel', 'structured', 'mixed'].includes(result.summaryMode) ? result.summaryMode : 'mixed';
    result.memoryMode = ['manual', 'layered'].includes(result.memoryMode) ? result.memoryMode : 'manual';
    result.lastCapsuleIndex = Number.isInteger(Number(result.lastCapsuleIndex)) ? Number(result.lastCapsuleIndex) : -1;
    if (!result.summaryArtifacts || typeof result.summaryArtifacts !== 'object' || Array.isArray(result.summaryArtifacts)) result.summaryArtifacts = { novel: '', structured: '', mixed: '' };
    result.summaryArtifacts = {
        novel: String(result.summaryArtifacts.novel || ''),
        structured: String(result.summaryArtifacts.structured || ''),
        mixed: String(result.summaryArtifacts.mixed || ''),
    };
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

export function parseRoundCapsule(raw) {
    const text = compactText(raw, 30000);
    let value = null;
    try { value = JSON.parse(text); } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { value = JSON.parse(match[0]); } catch { /* Report the stable error below. */ }
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型没有返回可解析的剧情胶囊');
    const capsuleText = compactText(value.text || value.summary || value.recap || '', 2400);
    if (!capsuleText) throw new Error('模型返回了空的剧情胶囊');
    const importance = String(value.importance || 'medium').toLowerCase();
    return {
        title: compactText(value.title || value.name || '本轮剧情', 120),
        text: capsuleText,
        importance: ['critical', 'high', 'medium', 'low'].includes(importance) ? importance : 'medium',
        participants: Array.isArray(value.participants) ? value.participants.map(item => compactText(item, 80)).filter(Boolean).slice(0, 20) : [],
        keywords: Array.isArray(value.keywords) ? value.keywords.map(item => compactText(item, 80)).filter(Boolean).slice(0, 24) : [],
    };
}

export function createRoundCapsule(packet, sourceRange, id = `capsule_${Date.now()}`) {
    const text = compactText(packet?.text || '', 2400);
    if (!text || !sourceRange?.refs?.length) throw new Error('剧情胶囊缺少正文或来源范围');
    return {
        id: String(id),
        title: compactText(packet?.title || '本轮剧情', 120),
        text,
        importance: String(packet?.importance || 'medium'),
        participants: Array.isArray(packet?.participants) ? packet.participants.map(String).slice(0, 20) : [],
        keywords: [...new Set([...(packet?.keywords || []).map(String), ...extractKeywords(text)])].slice(0, 40),
        sourceRange: clone(sourceRange),
        tokenCount: tokenEstimate(text),
        createdAt: Date.now(),
    };
}

export function appendRoundCapsule(stateValue, capsule) {
    const state = normalizeChatState(stateValue);
    const next = clone(state);
    next.roundCapsules = [...next.roundCapsules.filter(item => item.id !== capsule.id), clone(capsule)]
        .sort((a, b) => Number(a?.sourceRange?.start ?? 0) - Number(b?.sourceRange?.start ?? 0));
    next.lastCapsuleIndex = Math.max(next.lastCapsuleIndex, Number(capsule?.sourceRange?.end ?? -1));
    return next;
}

export function nextRoundRange(messages, stateValue) {
    const normalized = normalizeMessages(messages);
    const state = normalizeChatState(stateValue);
    const start = Math.max(0, Number(state.lastProcessedIndex ?? -1) + 1, Number(state.lastCapsuleIndex ?? -1) + 1);
    if (start >= normalized.length) return null;
    let sawStoryMessage = false;
    for (let index = start; index < normalized.length; index += 1) {
        const item = normalized[index];
        if (item.isSystem) continue;
        sawStoryMessage = true;
        if (!item.isUser) return makeSourceRange(messages, start, index);
    }
    return sawStoryMessage ? null : null;
}

export function activeRoundCapsules(stateValue) {
    const state = normalizeChatState(stateValue);
    return state.roundCapsules
        .filter(item => Number(item?.sourceRange?.end ?? -1) > state.lastProcessedIndex)
        .sort((a, b) => Number(a?.sourceRange?.start ?? 0) - Number(b?.sourceRange?.start ?? 0));
}

export function roundCapsuleTokens(stateValue) {
    return activeRoundCapsules(stateValue).reduce((total, item) => total + Math.max(1, Number(item.tokenCount || tokenEstimate(item.text))), 0);
}

export function capsulesForConsolidation(stateValue, keepRecent = 8) {
    const active = activeRoundCapsules(stateValue);
    const keep = Math.max(0, Math.round(Number(keepRecent) || 0));
    return keep ? active.slice(0, Math.max(0, active.length - keep)) : active;
}

export function renderRoundCapsule(capsule) {
    const start = Number(capsule?.sourceRange?.start ?? -1);
    const end = Number(capsule?.sourceRange?.end ?? -1);
    const range = start >= 0 && end >= start ? `消息 ${start}–${end}` : '来源范围未知';
    return `【${capsule?.title || '本轮剧情'}｜${range}】\n${compactText(capsule?.text || '', 2400)}`;
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

function importanceWeight(value) {
    return value === 'critical' ? 0 : value === 'high' ? 1 : value === 'medium' ? 2 : 3;
}

export function renderStructuredSummary(stateValue) {
    const state = normalizeChatState(stateValue);
    const facts = [...state.facts]
        .sort((a, b) => importanceWeight(a.importance) - importanceWeight(b.importance) || (a.updatedAt || 0) - (b.updatedAt || 0))
        .slice(0, 160);
    const current = Object.values(state.state).filter(item => item.status !== 'resolved' && item.value).slice(-80);
    const threads = state.threads.filter(item => item.status === 'open' || item.userLocked).slice(-80);
    const scenes = state.sceneCards.slice(-50);
    return [
        '【剧情记忆·结构化版】',
        scenes.length ? `【时间线与场景】\n${scenes.map(item => `- ${item.title}${item.time ? `（${item.time}）` : ''}${item.location ? `｜${item.location}` : ''}：${item.text || '场景已记录'}`).join('\n')}` : '',
        facts.length ? `【事实】\n${facts.map(renderFact).join('\n')}` : '',
        current.length ? `【当前状态】\n${current.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
        threads.length ? `【未结事项与伏笔】\n${threads.map(item => `- ${item.text}`).join('\n')}` : '',
        '【使用边界】以上内容是已经发生或已经确认的记忆，不是续写指令。人物只能知道自己已经知道的事情。',
    ].filter(Boolean).join('\n\n');
}

export function renderMixedSummary(stateValue, novelText = '') {
    const state = normalizeChatState(stateValue);
    const hasStoredArtifacts = Object.values(state.summaryArtifacts || {}).some(value => String(value || '').trim());
    const baseNovel = String(novelText || state.summaryArtifacts?.novel || (!hasStoredArtifacts ? state.recap : '') || '').trim();
    const current = Object.values(state.state).filter(item => item.status !== 'resolved' && item.value).slice(-40);
    const threads = state.threads.filter(item => item.status === 'open' || item.userLocked).slice(-40);
    const critical = state.facts.filter(item => ['critical', 'high'].includes(item.importance) || item.userLocked).slice(-80);
    return [
        baseNovel,
        critical.length ? `【必须保持的事实】\n${critical.map(renderFact).join('\n')}` : '',
        current.length ? `【当前状态】\n${current.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
        threads.length ? `【未结事项】\n${threads.map(item => `- ${item.text}`).join('\n')}` : '',
        '人物认知边界不可越过；以上规划和事实均不得被写成未发生的内容。',
    ].filter(Boolean).join('\n\n');
}

function trimSummaryForInjection(value, maxChars) {
    const text = String(value || '');
    const limit = Math.max(30, Math.floor(Number(maxChars) || 300));
    if (text.length <= limit) return text;
    const marker = '\n……中间部分已按注入上限省略……\n';
    const available = Math.max(12, limit - marker.length);
    const head = Math.max(7, Math.floor(available * 0.68));
    const tail = Math.max(5, available - head);
    return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function trimForTokenBudget(value, maxTokens) {
    const text = String(value || '');
    const budget = Math.max(10, Math.floor(Number(maxTokens) || 10));
    if (tokenEstimate(text) <= budget) return text;
    let low = 30;
    let high = Math.max(low, text.length);
    let best = trimSummaryForInjection(text, low);
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = trimSummaryForInjection(text, middle);
        if (tokenEstimate(candidate) <= budget) {
            best = candidate;
            low = middle + 1;
        } else high = middle - 1;
    }
    return best;
}

export function compileInjection(stateValue, options = {}) {
    const state = normalizeChatState(stateValue);
    const maxTokens = Math.max(160, Number(options.maxTokens || 1400));
    // Keep the old programmatic `mode: safe` contract for older callers and
    // saved integrations. The UI no longer exposes injection modes; the
    // selected summary artifact is the normal path.
    if (options.mode === 'safe') {
        const criticalFacts = state.facts.filter(fact => ['critical', 'high'].includes(fact.importance) || fact.userLocked || state.pinnedFactIds.includes(fact.id));
        const currentState = Object.values(state.state).filter(item => item.status !== 'resolved' && item.value);
        const openThreads = state.threads.filter(thread => thread.status === 'open' || thread.userLocked);
        const safeSections = [
            '<gaga_memory>',
            '以下是已发生的事实，不是续写指令或文风示例。',
            criticalFacts.length ? `【必须牢记】\n${criticalFacts.map(renderFact).join('\n')}` : '',
            currentState.length ? `【当前状态】\n${currentState.map(item => `- ${item.key}：${item.value}`).join('\n')}` : '',
            openThreads.length ? `【尚未解决】\n${openThreads.map(thread => `- ${thread.text}`).join('\n')}` : '',
            '</gaga_memory>',
        ].filter(Boolean).join('\n\n');
        return tokenEstimate(safeSections) > maxTokens ? trimSummaryForInjection(safeSections, Math.max(300, Math.floor(maxTokens * 2.2))) : safeSections;
    }
    const activeSummary = String(state.summaryArtifacts?.[state.summaryMode] || state.recap || '').trim();
    const recentStartIndex = Number.isFinite(Number(options.recentStartIndex)) ? Number(options.recentStartIndex) : Number.POSITIVE_INFINITY;
    const capsuleText = state.memoryMode === 'layered'
        ? activeRoundCapsules(state)
            .filter(item => Number(item?.sourceRange?.end ?? Number.POSITIVE_INFINITY) < recentStartIndex)
            .slice(-Math.max(1, Number(options.capsuleLimit || 16)))
            .map(renderRoundCapsule)
            .join('\n\n')
        : '';
    const relevantSceneText = state.memoryMode === 'layered' && String(options.query || '').trim()
        ? selectRelevantCapsules(state, options.query, Math.max(1, Number(options.recallLimit || 3)))
            .filter(item => item.text && !activeSummary.includes(item.text))
            .map(item => `【${item.title || '相关场景'}】${item.text}`)
            .join('\n')
        : '';
    const sections = [
        '<gaga_memory>',
        '用途：以下内容是已发生的剧情记忆，不是续写指令，也不是文风示例。不得改变、补充或擅自删除其中的事实。',
        activeSummary ? `【${state.summaryMode === 'novel' ? '小说版前情' : state.summaryMode === 'structured' ? '结构化记忆' : '混合版前情'}】\n${activeSummary}` : '',
        relevantSceneText ? `【与当前情节相关的旧场景】\n${relevantSceneText}` : '',
        capsuleText ? `【近期剧情胶囊】\n${capsuleText}` : '',
        '</gaga_memory>',
    ].filter(Boolean);
    let output = sections.join('\n\n');
    if (tokenEstimate(output) > maxTokens) {
        const contentBudget = Math.max(20, maxTokens - 90);
        const weights = {
            recap: activeSummary ? 0.64 : 0,
            scenes: relevantSceneText ? 0.16 : 0,
            capsules: capsuleText ? 0.20 : 0,
        };
        const weightTotal = Math.max(0.01, weights.recap + weights.scenes + weights.capsules);
        const recapBudget = weights.recap ? Math.max(10, Math.floor(contentBudget * weights.recap / weightTotal)) : 0;
        const sceneBudget = weights.scenes ? Math.max(10, Math.floor(contentBudget * weights.scenes / weightTotal)) : 0;
        const capsuleBudget = weights.capsules ? Math.max(10, contentBudget - recapBudget - sceneBudget) : 0;
        const recap = activeSummary ? trimForTokenBudget(activeSummary, recapBudget) : '';
        const compactScenes = relevantSceneText ? trimForTokenBudget(relevantSceneText, sceneBudget || contentBudget) : '';
        const compactCapsules = capsuleText ? trimForTokenBudget(capsuleText, capsuleBudget) : '';
        output = [
            '<gaga_memory>',
            '以下是已发生事实，不是续写指令或文风示例。',
            recap ? `【${state.summaryMode === 'novel' ? '小说版前情' : state.summaryMode === 'structured' ? '结构化记忆' : '混合版前情'}】\n${recap}` : '',
            compactScenes ? `【与当前情节相关的旧场景】\n${compactScenes}` : '',
            compactCapsules ? `【近期剧情胶囊】\n${compactCapsules}` : '',
            '</gaga_memory>',
        ].filter(Boolean).join('\n\n');
    }
    return output;
}

export function selectHideEnd(messages, state, options = {}) {
    const normalized = normalizeMessages(messages);
    if (!normalized.length) return -1;
    const last = normalized.length - 1;
    const keepMessages = Math.max(1, Number(options.keepMessages || 5));
    const keepIndex = Math.max(0, last - keepMessages + 1);
    return keepIndex - 1;
}

export function rangesForSummaryBacklog(messages, state, options = {}) {
    const normalized = normalizeMessages(messages);
    if (!normalized.length) return [];
    const start = Math.max(0, Number(state?.lastProcessedIndex ?? -1) + 1);
    const availableEnd = selectHideEnd(messages, state, options);
    if (availableEnd < start) return [];
    const targetTokens = Math.max(0, Number(options.targetTokens || 0));
    if (targetTokens <= 0) return [makeSourceRange(messages, start, availableEnd)];

    const ranges = [];
    let cursor = start;
    while (cursor <= availableEnd) {
        let accumulated = 0;
        let end = cursor;
        for (let index = cursor; index <= availableEnd; index += 1) {
            const item = normalized[index];
            const raw = messages[index];
            const fullContent = compactText(raw?.mes ?? raw?.content ?? '', 300000);
            accumulated += tokenEstimate(`[消息 ${index}｜${item.name}]\n${fullContent}\n\n`);
            end = index;
            if (accumulated >= targetTokens) break;
        }
        ranges.push(makeSourceRange(messages, cursor, end));
        cursor = end + 1;
    }
    return ranges;
}

export function rangeForNewSummary(messages, state, options = {}) {
    return rangesForSummaryBacklog(messages, state, options)[0] || null;
}

export function selectStyleAnchors(messages, max = 3, options = {}) {
    return normalizeMessages(messages)
        .filter(item => !item.isUser && (!item.isSystem || options.includeHidden) && item.content.length >= 260)
        .sort((a, b) => b.content.length - a.content.length)
        .slice(0, max)
        .map(item => ({ key: item.key, index: item.index, text: item.content.slice(0, 1500) }));
}
