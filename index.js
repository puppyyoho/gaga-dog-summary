import {
    assertMemoryPacket,
    clone,
    compactText,
    compileInjection,
    DEFAULT_CHAT_STATE,
    makeSourceRange,
    mergeMemoryPacket,
    normalizeChatState,
    normalizeMessages,
    parseModelPacket,
    rangeForNewSummary,
    rangesForSummaryBacklog,
    rangeStillMatches,
    selectStyleAnchors,
    simpleHash,
    tokenEstimate,
    renderMixedSummary,
    renderStructuredSummary,
} from './memory-core.js';
import { persistChatMetadata, readChatState, writeChatState } from './chat-state.js';
import {
    buildAuditPrompt,
    buildFactPrompt,
    buildPolishPrompt,
    buildProsePrompt,
    DEFAULT_PROMPTS,
    PROMPT_VERSION,
    renderFactsForProse,
} from './prompts.js';
import { generateDirectOnly, generateWithFallback, listDirectModels, readableGenerationError } from './generation-client.js';
import {
    chooseSummaryBatchPlan,
    FALLBACK_BATCH_TOKENS,
    resolveContextWindowTokens,
    resolveOutputReserveTokens,
} from './context-budget.js';
import {
    applyBranchesToDirector,
    applyForeshadowsToDirector,
    applyLonglineToDirector,
    applyProgressToDirector,
    buildDirectorPrompt,
    buildExecutionCard,
    createEmptyDirectorState,
    getDirectorPreset,
    lockMainline,
    normalizeBranches,
    normalizeDirectorState,
    normalizeForeshadows,
    PACING_OPTIONS,
    parseDirectorPacket,
    selectBranch,
} from './director-core.js';
import {
    buildCalendarContext,
    createEmptyCalendarState,
    normalizeCalendarEvent,
    normalizeCalendarState,
} from './calendar-core.js';
import {
    buildReplyPrompt,
    createEmptyReplyState,
    normalizeReplyState,
    parseReplyCandidates,
    REPLY_DETAIL_LEVELS,
    REPLY_VIEWPOINTS,
} from './reply-core.js';
import {
    getConnectionManagerProfiles,
    normalizeProviderProfiles,
    providerChoiceValue,
    PROVIDER_CURRENT,
    resolveModuleProvider,
} from './provider-profiles.js';

const EXTENSION_NAME = 'gaga-dog-summary';
const DISPLAY_NAME = '嘎嘎小狗工坊';
const SETTINGS_KEY = 'gagaDogSummary';
const INJECTION_ID = `${EXTENSION_NAME}:memory`;
const DIRECTOR_INJECTION_ID = `${EXTENSION_NAME}:director`;
const PANEL_LOGO_URL = new URL('./assets/gaga-dog-logo.png', import.meta.url).href;
const FLOATING_LOGO_URL = new URL('./assets/gaga-dog-floating.png', import.meta.url).href;
const VERSION = '0.3.6';
const SETTINGS_VERSION = 5;

const DEFAULT_SETTINGS = {
    showFloatingButton: true,
    floatingIconSize: 62,
    floatingIconData: '',
    floatingPosition: null,
    panelPosition: null,
    autoSummarize: true,
    autoHide: true,
    collapseHidden: true,
    triggerTokens: 60000,
    keepMessages: 10,
    injectionMaxTokens: 1400,
    recallLimit: 3,
    targetWords: 520,
    summaryMode: 'mixed',
    streamOutput: true,
    apiProfiles: [],
    moduleConnections: { memory: PROVIDER_CURRENT, director: PROVIDER_CURRENT, reply: PROVIDER_CURRENT },
    prompts: {},
};

const runtime = {
    overlay: null,
    floating: null,
    settingsEntry: null,
    open: false,
    busy: false,
    scheduled: false,
    timer: null,
    taskSerial: 0,
    abortController: null,
    streamText: '',
    streamMeta: null,
    activeStage: '',
    workflowActive: false,
    workflow: null,
    generating: false,
    lastChatSignature: '',
    lastError: '',
    lastSuccess: '',
    directorBusy: false,
    directorAbortController: null,
    directorText: '',
    replyBusy: false,
    replyAbortController: null,
    replyText: '',
};

function getContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) throw new Error('未检测到 SillyTavern.getContext()。');
    return context;
}

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, DISPLAY_NAME);
    else console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function hostGenerationState(ctx = null) {
    const candidates = [
        ctx?.isGenerating,
        ctx?.is_generation_running,
        globalThis.isGenerating,
        globalThis.is_generation_running,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'function') {
            try { return Boolean(candidate()); } catch { /* Try the next host signal. */ }
        }
        if (typeof candidate === 'boolean') return candidate;
    }
    return null;
}

function hostStopControlVisible() {
    const selectors = ['#mes_stop', '#stop_generation', '#stop_but', '[data-generation-stop]'];
    return selectors.some(selector => [...(globalThis.document?.querySelectorAll?.(selector) || [])].some(node => {
        if (!node || node.hidden || node.disabled) return false;
        const style = globalThis.getComputedStyle?.(node);
        return style?.display !== 'none' && style?.visibility !== 'hidden' && (node.offsetParent !== null || style?.position === 'fixed');
    }));
}

function hostGenerationActive(ctx = null) {
    const explicit = hostGenerationState(ctx);
    if (explicit !== null) {
        if (!explicit) runtime.generating = false;
        return explicit;
    }
    // Older Tavern builds may not expose a boolean state. In that case only
    // trust the runtime flag while the native stop control is actually shown.
    return Boolean(runtime.generating && hostStopControlVisible());
}

function reconcileGeneratingFlag(ctx = null) {
    if (!runtime.generating) return false;
    const active = hostGenerationState(ctx);
    if (active === false) {
        runtime.generating = false;
        return true;
    }
    return false;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizeFloatingIconData(value) {
    const data = String(value || '').trim();
    return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(data) ? data : '';
}

function getMessages(ctx = getContext()) {
    return Array.isArray(ctx.chat) ? ctx.chat : Array.isArray(globalThis.chat) ? globalThis.chat : [];
}

function getSettings(ctx = getContext()) {
    ctx.extensionSettings ??= {};
    const current = ctx.extensionSettings[SETTINGS_KEY];
    const result = { ...DEFAULT_SETTINGS, ...(current && typeof current === 'object' ? current : {}) };
    const migratedDefault = Boolean(current && typeof current === 'object' && !current.settingsVersion && Number(current.triggerTokens) === 1800);
    if (migratedDefault) result.triggerTokens = DEFAULT_SETTINGS.triggerTokens;
    result.settingsVersion = SETTINGS_VERSION;
    result.prompts = { ...DEFAULT_PROMPTS, ...(current?.prompts && typeof current.prompts === 'object' ? current.prompts : {}) };
    result.summaryMode = ['novel', 'structured', 'mixed'].includes(result.summaryMode) ? result.summaryMode : DEFAULT_SETTINGS.summaryMode;
    result.floatingIconSize = Math.min(120, Math.max(32, Math.round(Number(result.floatingIconSize) || DEFAULT_SETTINGS.floatingIconSize)));
    result.floatingIconData = normalizeFloatingIconData(result.floatingIconData);
    result.apiProfiles = normalizeProviderProfiles(result.apiProfiles);
    result.moduleConnections = {
        ...DEFAULT_SETTINGS.moduleConnections,
        ...(current?.moduleConnections && typeof current.moduleConnections === 'object' ? current.moduleConnections : {}),
    };
    for (const moduleName of ['memory', 'director', 'reply']) {
        result.moduleConnections[moduleName] = String(result.moduleConnections[moduleName] || PROVIDER_CURRENT);
    }
    for (const key of ['triggerTokens', 'keepMessages', 'injectionMaxTokens', 'recallLimit', 'targetWords']) {
        const value = Number(result[key]);
        result[key] = Number.isFinite(value) ? Math.max(1, Math.round(value)) : DEFAULT_SETTINGS[key];
    }
    const floatingPosition = result.floatingPosition;
    result.floatingPosition = floatingPosition
        && Number.isFinite(Number(floatingPosition.x))
        && Number.isFinite(Number(floatingPosition.y))
        ? { x: Math.round(Number(floatingPosition.x)), y: Math.round(Number(floatingPosition.y)) }
        : null;
    const panelPosition = result.panelPosition;
    result.panelPosition = panelPosition
        && Number.isFinite(Number(panelPosition.x))
        && Number.isFinite(Number(panelPosition.y))
        ? { x: Math.round(Number(panelPosition.x)), y: Math.round(Number(panelPosition.y)) }
        : null;
    ctx.extensionSettings[SETTINGS_KEY] = result;
    if (migratedDefault) {
        try { ctx.saveSettingsDebounced?.(); } catch (error) { console.warn(`[${DISPLAY_NAME}] 默认批次迁移保存失败`, error); }
    }
    return result;
}

function saveSettings(ctx = getContext()) {
    try { ctx.saveSettingsDebounced?.(); } catch (error) { console.warn(`[${DISPLAY_NAME}] 设置保存失败`, error); }
}

function getChatState(ctx = getContext()) {
    return readChatState(ctx, SETTINGS_KEY, normalizeChatState);
}

function setChatState(value, ctx = getContext()) {
    return writeChatState(ctx, SETTINGS_KEY, value, normalizeChatState);
}

function getDirectorState(ctx = getContext()) {
    const state = getChatState(ctx);
    return normalizeDirectorState(state.director || createEmptyDirectorState());
}

function getReplyState(ctx = getContext()) {
    const state = getChatState(ctx);
    return normalizeReplyState(state.reply || createEmptyReplyState());
}

function saveDirectorState(ctx, director) {
    const state = getChatState(ctx);
    state.director = normalizeDirectorState(director);
    setChatState(state, ctx);
    return state.director;
}

function saveReplyState(ctx, reply) {
    const state = getChatState(ctx);
    state.reply = normalizeReplyState(reply);
    setChatState(state, ctx);
    return state.reply;
}

function moduleProvider(ctx, moduleName) {
    return resolveModuleProvider(getSettings(ctx), moduleName, ctx);
}

async function saveChat(ctx = getContext(), options = {}) {
    try {
        await persistChatMetadata(ctx, options);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 聊天元数据保存失败`, error);
        throw error;
    }
}

function formatMessages(messages, start = 0, end = messages.length - 1) {
    return messages.slice(start, end + 1).map((message, offset) => {
        const [item] = normalizeMessages([message]);
        const content = compactText(message?.mes ?? message?.content ?? '', 300000);
        return `[消息 ${offset + start}｜${item.name}]\n${content}`;
    }).join('\n\n');
}

function formatState(value) {
    const state = normalizeChatState(value);
    const rows = Object.values(state.state).map(item => `- ${item.key}：${item.value}${item.status && item.status !== 'active' ? `（${item.status}）` : ''}`);
    return rows.length ? rows.join('\n') : '无';
}

function formatThreads(value) {
    const state = normalizeChatState(value);
    const rows = state.threads.filter(item => item.status === 'open' || item.userLocked).map(item => `- ${item.text}`);
    return rows.length ? rows.join('\n') : '无';
}

function recentQuery(messages) {
    return normalizeMessages(messages).slice(-5).map(item => `${item.name}：${item.content}`).join('\n');
}

function locateMessage(messages, ref) {
    const normalized = normalizeMessages(messages);
    const byKey = normalized.find(item => item.key === ref?.key);
    if (byKey) return { item: byKey, message: messages[byKey.index], index: byKey.index };
    const index = Number(ref?.index);
    if (Number.isInteger(index) && normalized[index] && (!ref.hash || normalized[index].hash === ref.hash)) {
        return { item: normalized[index], message: messages[index], index };
    }
    const fallback = normalized.find(item => item.hash === ref?.hash && item.name === ref?.name);
    if (fallback) return { item: fallback, message: messages[fallback.index], index: fallback.index };
    return null;
}

let tavernVisibilityImport;

function messageDomNode(index) {
    if (typeof document === 'undefined' || !Number.isInteger(index)) return null;
    try { return document.querySelector(`.mes[mesid="${index}"]`); } catch { return null; }
}

function syncMessageVisibilityDom(index, hidden) {
    messageDomNode(index)?.setAttribute('is_system', String(Boolean(hidden)));
}

function visibilityCommand(start, end, hidden) {
    const range = start === end ? String(start) : `${start}-${end}`;
    return `/${hidden ? 'hide' : 'unhide'} ${range}`;
}

async function loadTavernHideChatMessageRange() {
    if (tavernVisibilityImport !== undefined) return tavernVisibilityImport;
    tavernVisibilityImport = import('/scripts/chats.js')
        .then(module => typeof module.hideChatMessageRange === 'function' ? module.hideChatMessageRange : null)
        .catch(error => {
            console.debug(`[${DISPLAY_NAME}] 无法加载酒馆聊天隐藏模块，将使用消息标记兼容模式`, error);
            return null;
        });
    return tavernVisibilityImport;
}

/**
 * Use SillyTavern's own visibility path whenever the host exposes it. The
 * slash-command adapter is intentionally first: it is the same `/hide` /
 * `/unhide` path a user can run, including DOM refresh and chat persistence.
 */
async function setTavernRangeVisibility(ctx, start, end, hidden) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return false;
    const command = visibilityCommand(start, end, hidden);
    const executeSlashCommands = ctx?.executeSlashCommands || globalThis.executeSlashCommands;
    if (typeof executeSlashCommands === 'function') {
        try {
            await executeSlashCommands(command);
            return true;
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] ${command} 执行失败，尝试直接调用酒馆隐藏接口`, error);
        }
    }
    const hideChatMessageRange = ctx?.hideChatMessageRange || globalThis.hideChatMessageRange || await loadTavernHideChatMessageRange();
    if (typeof hideChatMessageRange === 'function') {
        try {
            await hideChatMessageRange(start, end, !hidden);
            return true;
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 酒馆隐藏接口调用失败，使用兼容标记模式`, error);
        }
    }
    return false;
}

function contiguousRanges(indexes) {
    const sorted = [...new Set(indexes)].filter(Number.isInteger).sort((a, b) => a - b);
    const ranges = [];
    for (const index of sorted) {
        const previous = ranges[ranges.length - 1];
        if (previous && index === previous.end + 1) previous.end = index;
        else ranges.push({ start: index, end: index });
    }
    return ranges;
}

async function hideRange(ctx, range, checkpointId) {
    const messages = getMessages(ctx);
    const candidates = [];
    for (const ref of range?.refs || []) {
        const located = locateMessage(messages, ref);
        const message = located?.message;
        if (!message || message.is_system || message.extra?.gagaDogHiddenBy) continue;
        candidates.push({
            ...located,
            hadSystemField: Object.prototype.hasOwnProperty.call(message, 'is_system'),
            originalSystem: Boolean(message.is_system),
        });
    }
    if (!candidates.length) return [];

    const start = Math.min(...candidates.map(item => item.index));
    const end = Math.max(...candidates.map(item => item.index));
    const usedTavernPath = await setTavernRangeVisibility(ctx, start, end, true);
    const hidden = [];
    for (const located of candidates) {
        const message = located.message;
        // The host path updates `is_system` and the rendered .mes block. If an
        // older build has no command/helper, keep the same flag as a fallback.
        if (!usedTavernPath || !message.is_system) {
            message.is_system = true;
            syncMessageVisibilityDom(located.index, true);
        }
        if (!message.is_system) continue;
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.gagaDogHiddenBy = checkpointId;
        message.extra.gagaDogHadSystemField = located.hadSystemField;
        message.extra.gagaDogOriginalSystem = located.originalSystem;
        hidden.push({ index: located.index, key: located.item.key, checkpointId });
    }
    return hidden;
}

async function restoreOwnedMessages(ctx, checkpointIds = null) {
    const ids = checkpointIds ? new Set(checkpointIds) : null;
    const messages = getMessages(ctx);
    const owned = messages.map((message, index) => ({ message, index }))
        .filter(({ message }) => {
            const owner = message?.extra?.gagaDogHiddenBy;
            return owner && (!ids || ids.has(owner));
        });
    if (!owned.length) return 0;

    const usedTavernRanges = [];
    for (const range of contiguousRanges(owned.map(item => item.index))) {
        if (await setTavernRangeVisibility(ctx, range.start, range.end, false)) usedTavernRanges.push(range);
    }
    let restored = 0;
    for (const { message, index } of owned) {
        const extra = message.extra;
        if (!usedTavernRanges.some(range => index >= range.start && index <= range.end)) {
            if (extra.gagaDogHadSystemField) message.is_system = Boolean(extra.gagaDogOriginalSystem);
            else delete message.is_system;
            syncMessageVisibilityDom(index, Boolean(message.is_system));
        } else if (extra.gagaDogOriginalSystem) {
            // We currently avoid taking ownership of already-hidden messages,
            // but preserve this field for old checkpoints made by v0.1.7.
            message.is_system = true;
            syncMessageVisibilityDom(index, true);
        }
        delete extra.gagaDogHiddenBy;
        delete extra.gagaDogHadSystemField;
        delete extra.gagaDogOriginalSystem;
        restored += 1;
    }
    return restored;
}

function snapshotMemory(value) {
    const state = normalizeChatState(value);
    return {
        facts: clone(state.facts),
        state: clone(state.state),
        threads: clone(state.threads),
        sceneCards: clone(state.sceneCards),
        recap: state.recap,
        summaryMode: state.summaryMode,
        summaryArtifacts: clone(state.summaryArtifacts),
        lastProcessedIndex: state.lastProcessedIndex,
    };
}

function restoreSnapshot(state, snapshot) {
    if (!snapshot) return normalizeChatState(state);
    const next = normalizeChatState(state);
    next.facts = clone(snapshot.facts || []);
    next.state = clone(snapshot.state || {});
    next.threads = clone(snapshot.threads || []);
    next.sceneCards = clone(snapshot.sceneCards || []);
    next.recap = String(snapshot.recap || '');
    next.summaryMode = ['novel', 'structured', 'mixed'].includes(snapshot.summaryMode) ? snapshot.summaryMode : next.summaryMode;
    next.summaryArtifacts = {
        novel: String(snapshot.summaryArtifacts?.novel || next.summaryArtifacts?.novel || ''),
        structured: String(snapshot.summaryArtifacts?.structured || next.summaryArtifacts?.structured || ''),
        mixed: String(snapshot.summaryArtifacts?.mixed || next.summaryArtifacts?.mixed || ''),
    };
    next.lastProcessedIndex = Number(snapshot.lastProcessedIndex ?? -1);
    next.lastStableIndex = next.lastProcessedIndex;
    return next;
}

async function invalidateIfNeeded(ctx, chatState) {
    const messages = getMessages(ctx);
    const checkpoints = Array.isArray(chatState.checkpoints) ? chatState.checkpoints : [];
    const brokenIndex = checkpoints.findIndex(checkpoint => checkpoint.range && !rangeStillMatches(messages, checkpoint.range));
    if (brokenIndex < 0) return { state: chatState, changed: false };
    const affected = checkpoints.slice(brokenIndex);
    await restoreOwnedMessages(ctx, affected.map(item => item.id));
    const previous = checkpoints[brokenIndex - 1];
    const next = restoreSnapshot(chatState, previous?.memorySnapshot);
    next.checkpoints = checkpoints.slice(0, brokenIndex);
    next.sceneCards = next.sceneCards.filter(card => next.checkpoints.some(cp => cp.sceneCardId === card.id));
    next.hiddenRanges = (next.hiddenRanges || []).filter(item => next.checkpoints.some(cp => cp.id === item.checkpointId));
    next.pending = null;
    setChatState(next, ctx);
    return { state: next, changed: true, affected: affected.length };
}

function cleanProse(value) {
    return String(value || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

function renderSelectedSummary(state, novelText, mode) {
    const selected = ['novel', 'structured', 'mixed'].includes(mode) ? mode : 'mixed';
    const novel = String(novelText || state.summaryArtifacts?.novel || '').trim();
    const artifacts = {
        novel: novel,
        structured: renderStructuredSummary(state),
        mixed: renderMixedSummary(state, novel),
    };
    return { mode: selected, artifacts, active: artifacts[selected] || novel || artifacts.structured };
}

function stageName(stage) {
    if (stage === 'polish') return '文学润色';
    if (stage === 'prose') return '前情草稿';
    return '事实记忆';
}

function isInterrupted(error, controller) {
    return Boolean(controller?.signal?.aborted || error?.name === 'AbortError');
}

function updatePendingInMemory(ctx, pending) {
    const state = getChatState(ctx);
    state.pending = clone(pending);
    setChatState(state, ctx);
}

async function savePending(ctx, pending) {
    updatePendingInMemory(ctx, pending);
    await saveChat(ctx);
}

function updateStreamPreview(text, meta = {}) {
    runtime.streamText = String(text || '');
    runtime.streamMeta = meta;
    const output = runtime.overlay?.querySelector('[data-gds-stream-preview]');
    if (output) {
        output.value = runtime.streamText;
        output.scrollTop = output.scrollHeight;
    }
    const source = meta.source ? ` · ${meta.source}` : '';
    const chunks = meta.updates > 1 ? ` · ${meta.updates} 个有效分片` : '';
    const batch = runtime.workflow ? `第 ${runtime.workflow.batchIndex + 1}/${runtime.workflow.totalBatches} 批 · ` : '';
    setStatus(`${batch}正在生成${stageName(runtime.activeStage)}${source}${chunks} · ${runtime.streamText.length} 字符`);
}

function requestForResume(request, pending) {
    const partial = String(pending.partialText || '').trim();
    if (!partial) return request;
    if (pending.stage === 'prose' || pending.stage === 'polish') {
        const label = pending.stage === 'polish' ? '润色稿' : '前情草稿';
        return {
            ...request,
            prompt: `${request.prompt}\n\n<interrupted_draft>\n${partial}\n</interrupted_draft>\n\n上一次${label}在途中被中断。请以这份未完成内容为基础，重新输出一份从头到尾完整、连贯的本阶段成稿；保留其中正确细节并续完，不要解释中断。`,
        };
    }
    return {
        ...request,
        prompt: `${request.prompt}\n\n<interrupted_json>\n${partial}\n</interrupted_json>\n\n上一次 JSON 生成在途中被中断。请依据原始材料和已有片段，重新输出一个从头到尾完整、合法的 JSON 对象；不要只输出尾部，不要使用 Markdown。`,
    };
}

async function runGenerationStage(ctx, request, settings, pending, controller) {
    runtime.activeStage = pending.stage;
    runtime.streamText = '';
    runtime.streamMeta = null;
    updateStreamPreview('', { phase: 'preparing' });
    const resumableRequest = requestForResume(request, pending);
    pending.partialText = '';
    updatePendingInMemory(ctx, pending);
    return generateWithFallback(ctx, {
        ...resumableRequest,
        providerProfile: moduleProvider(ctx, 'memory'),
        preferStream: settings.streamOutput !== false,
        signal: controller.signal,
        onText: (text, meta) => {
            if (runtime.abortController !== controller) return;
            pending.partialText = text;
            updatePendingInMemory(ctx, pending);
            updateStreamPreview(text, meta);
        },
        onStatus: meta => {
            if (runtime.abortController !== controller) return;
            runtime.streamMeta = meta;
            if (meta.phase === 'connecting') {
                const batch = runtime.workflow ? `第 ${runtime.workflow.batchIndex + 1}/${runtime.workflow.totalBatches} 批 · ` : '';
                setStatus(`${batch}正在连接${meta.source || '当前酒馆模型'}，准备生成${stageName(pending.stage)}……`);
            }
            if (meta.phase === 'fallback') setStatus(`直接流式通道未完成，正在尝试兼容通道：${meta.reason}`);
        },
    });
}

async function summarizeRange(ctx, range, settings, reason = 'manual', resumeTask = null, workflowInfo = null) {
    if (runtime.busy) throw new Error('已有总结任务正在运行。');
    const messages = getMessages(ctx);
    if (!rangeStillMatches(messages, range)) throw new Error('待总结消息已发生变化，请重新开始总结。');
    runtime.busy = true;
    runtime.lastError = '';
    runtime.lastSuccess = '';
    runtime.taskSerial += 1;
    const serial = runtime.taskSerial;
    const controller = new AbortController();
    runtime.abortController = controller;
    const current = getChatState(ctx);
    const before = normalizeChatState(current);
    const summaryMode = ['novel', 'structured', 'mixed'].includes(before.summaryMode) ? before.summaryMode : settings.summaryMode;
    before.pending = null;
    const checkpointId = resumeTask?.checkpointId || `cp_${Date.now()}_${simpleHash(`${range.start}:${range.end}:${range.rangeHash}`)}`;
    const pending = resumeTask ? clone(resumeTask) : {
        id: `pending_${Date.now()}`,
        checkpointId,
        range: clone(range),
        reason,
        stage: 'facts',
        partialText: '',
        factRaw: '',
        packet: null,
        proseDraft: '',
        workflow: clone(workflowInfo),
        createdAt: Date.now(),
    };
    pending.range = clone(range);
    pending.checkpointId = checkpointId;
    pending.reason ||= reason;
    if (workflowInfo) pending.workflow = clone(workflowInfo);
    try {
        await savePending(ctx, pending);
        const sourceText = formatMessages(messages, range.start, range.end);
        if (!sourceText.trim()) throw new Error('待总结范围没有可用正文。');
        const factPrompt = buildFactPrompt({
            messages: sourceText,
            currentState: formatState(before),
            openThreads: formatThreads(before),
            customPrompts: settings.prompts,
        });

        let packet = pending.packet;
        if ((pending.stage === 'prose' || pending.stage === 'polish') && !packet && pending.factRaw) {
            try { packet = assertMemoryPacket(parseModelPacket(pending.factRaw)); } catch { pending.stage = 'facts'; }
        }
        if (!['prose', 'polish'].includes(pending.stage) || !packet) {
            pending.stage = 'facts';
            const factResult = await runGenerationStage(ctx, factPrompt, settings, pending, controller);
            if (serial !== runtime.taskSerial || controller.signal.aborted) throw controller.signal.reason || new DOMException('已中断生成', 'AbortError');
            let rawPacket = factResult.text;
            try {
                packet = assertMemoryPacket(parseModelPacket(rawPacket));
            } catch (error) {
                console.warn(`[${DISPLAY_NAME}] 首次记忆结构无法解析，要求模型重新输出纯 JSON`, error);
                pending.partialText = rawPacket;
                const repairResult = await runGenerationStage(ctx, {
                    ...factPrompt,
                    prompt: `${factPrompt.prompt}\n\n上一次回答无法解析。请重新完成任务，并且只输出一个完整、合法的 JSON 对象；不要输出 Markdown 代码块、解释或思考过程。`,
                }, settings, pending, controller);
                rawPacket = repairResult.text;
                packet = assertMemoryPacket(parseModelPacket(rawPacket));
            }
            pending.factRaw = rawPacket;
            pending.packet = clone(packet);
            pending.proseDraft = '';
            pending.stage = 'prose';
            pending.partialText = '';
            await savePending(ctx, pending);
        }

        const draft = mergeMemoryPacket(before, packet, range, checkpointId);
        const styleAnchors = selectStyleAnchors(messages, 3, { includeHidden: true });
        let polishedProse = '';
        if (summaryMode !== 'structured') {
            const factsForProse = renderFactsForProse(draft);
            const styleText = styleAnchors.map(anchor => `[消息 ${anchor.index}]\n${anchor.text}`).join('\n\n');
            let proseDraft = cleanProse(pending.proseDraft);
            if (pending.stage !== 'polish' || !proseDraft) {
                pending.stage = 'prose';
                const prosePrompt = buildProsePrompt({
                    facts: factsForProse,
                    currentState: formatState(draft),
                    openThreads: formatThreads(draft),
                    previousRecap: before.summaryArtifacts?.novel || before.recap || '',
                    styleAnchors: styleText,
                    targetWords: settings.targetWords,
                    customPrompts: settings.prompts,
                });
                const proseResult = await runGenerationStage(ctx, prosePrompt, settings, pending, controller);
                if (serial !== runtime.taskSerial || controller.signal.aborted) throw controller.signal.reason || new DOMException('已中断生成', 'AbortError');
                proseDraft = cleanProse(proseResult.text);
                if (!proseDraft) throw new Error('前情草稿为空，无法进入文学润色');
                pending.proseDraft = proseDraft;
                pending.stage = 'polish';
                pending.partialText = '';
                await savePending(ctx, pending);
            }

            const polishPrompt = buildPolishPrompt({
                facts: factsForProse,
                draft: proseDraft,
                previousRecap: before.summaryArtifacts?.novel || before.recap || '',
                styleAnchors: styleText,
                targetWords: settings.targetWords,
                customPrompts: settings.prompts,
            });
            const polishResult = await runGenerationStage(ctx, polishPrompt, settings, pending, controller);
            if (serial !== runtime.taskSerial || controller.signal.aborted) throw controller.signal.reason || new DOMException('已中断生成', 'AbortError');
            if (runtime.abortController === controller) runtime.abortController = null;
            setStatus('文学润色完成，正在校验并保存记忆……');
            refreshUi();
            polishedProse = cleanProse(polishResult.text);
            if (!polishedProse) throw new Error('文学润色结果为空，尚不能提交记忆');
        } else {
            if (runtime.abortController === controller) runtime.abortController = null;
            setStatus('结构化记忆整理完成，正在校验并保存记忆……');
            refreshUi();
        }
        const selectedSummary = renderSelectedSummary(draft, polishedProse, summaryMode);
        draft.summaryMode = selectedSummary.mode;
        draft.summaryArtifacts = selectedSummary.artifacts;
        draft.recap = selectedSummary.active;
        draft.styleAnchors = styleAnchors;
        const checkpoint = draft.checkpoints.find(item => item.id === checkpointId);
        if (!checkpoint) throw new Error('记忆检查点未建立，已阻止空结果覆盖旧记忆');
        checkpoint.recap = draft.recap;
        checkpoint.promptVersion = PROMPT_VERSION;
        checkpoint.reason = pending.reason || reason;
        checkpoint.memorySnapshot = snapshotMemory(draft);
        checkpoint.beforeSnapshot = snapshotMemory(before);
        draft.pending = null;
        setChatState(draft, ctx);
        await applyInjection(ctx, draft, settings);
        await saveChat(ctx);

        const committed = getChatState(ctx);
        if (!committed.recap.trim() || !committed.checkpoints.some(item => item.id === checkpointId && item.status === 'committed')) {
            throw new Error('总结已生成，但没有通过聊天记忆保存校验');
        }

        if (settings.autoHide) {
            const hidden = await hideRange(ctx, range, checkpointId);
            draft.hiddenRanges.push({ checkpointId, range, hidden, createdAt: Date.now() });
            if (checkpoint) checkpoint.hiddenCount = hidden.length;
            setChatState(draft, ctx);
            await saveChat(ctx, { includeMessages: true });
        }
        runtime.lastError = '';
        runtime.lastSuccess = workflowInfo
            ? `已保存第 ${workflowInfo.batchIndex + 1}/${workflowInfo.totalBatches} 批 · 消息 ${range.start}–${range.end}`
            : `已保存检查点 · 消息 ${range.start}–${range.end}`;
        if (!workflowInfo) notify('success', `已总结消息 ${range.start}–${range.end}${settings.autoHide ? '，旧正文已退出上下文' : ''}。`);
        return draft;
    } catch (error) {
        pending.partialText = runtime.streamText || pending.partialText || '';
        pending.lastError = readableGenerationError(error);
        pending.interruptedAt = Date.now();
        let progressSaveError = null;
        try { await savePending(ctx, pending); } catch (saveError) {
            progressSaveError = saveError;
            console.error(`[${DISPLAY_NAME}] 未完成任务进度也无法保存`, saveError);
        }
        if (isInterrupted(error, controller)) {
            runtime.lastError = `已中断${stageName(pending.stage)}，可以继续`;
            notify('info', runtime.lastError);
        } else {
            runtime.lastError = `${stageName(pending.stage)}生成中断：${pending.lastError}`;
            console.error(`[${DISPLAY_NAME}] 总结生成失败`, error);
            notify('error', runtime.lastError);
        }
        if (progressSaveError) runtime.lastError += `；未完成进度保存失败：${readableGenerationError(progressSaveError)}`;
        return null;
    } finally {
        if (runtime.abortController === controller) runtime.abortController = null;
        runtime.busy = false;
        runtime.activeStage = '';
        refreshUi();
        if (!runtime.workflowActive && !runtime.lastError && !getChatState(ctx).pending) scheduleAutoSummary(1200);
    }
}

async function applyInjection(ctx = getContext(), chatState = getChatState(ctx), settings = getSettings(ctx)) {
    const messages = getMessages(ctx);
    if (!chatState.enabled) {
        if (typeof ctx.setExtensionPrompt === 'function') await ctx.setExtensionPrompt(INJECTION_ID, '', 1, 0, false, 0);
        return '';
    }
    const injection = compileInjection(chatState, {
        maxTokens: settings.injectionMaxTokens,
    });
    chatState.lastInjection = injection;
    chatState.lastInjectionTokens = tokenEstimate(injection);
    if (typeof ctx.setExtensionPrompt === 'function') {
        await ctx.setExtensionPrompt(INJECTION_ID, injection, 1, 0, false, 0);
    }
    setChatState(chatState, ctx);
    return injection;
}

function recentStoryText(ctx, count = 10) {
    const messages = getMessages(ctx);
    const start = Math.max(0, messages.length - Math.max(1, count));
    return formatMessages(messages, start, messages.length - 1);
}

function userPersonaText(ctx) {
    return String(ctx?.persona || ctx?.userPersona || ctx?.name1 || '').trim();
}

function characterCardText(ctx) {
    const character = ctx?.character || ctx?.char || ctx?.characters?.[ctx?.characterId] || null;
    const data = character?.data || character;
    return compactText([
        data?.name || ctx?.name2 ? `角色名：${data?.name || ctx?.name2}` : '',
        data?.description || data?.desc || ctx?.characterDescription || ctx?.description || '',
        data?.personality ? `性格：${data.personality}` : '',
        data?.scenario ? `场景：${data.scenario}` : '',
        data?.first_mes ? `开场：${data.first_mes}` : '',
    ].filter(Boolean).join('\n'), 24000);
}

function calendarContextFor(ctx, director = getDirectorState(ctx), recentCount = 12) {
    const state = getChatState(ctx);
    return buildCalendarContext({
        calendarState: normalizeCalendarState(director?.calendar || createEmptyCalendarState()),
        recentText: recentStoryText(ctx, recentCount),
        memoryText: [savedRecap(state), ...state.facts.slice(-20).map(item => item.text)].filter(Boolean).join('\n'),
        characterCard: characterCardText(ctx),
    });
}

async function saveChatStateAndRefresh(ctx, state) {
    setChatState(state, ctx);
    await saveChat(ctx);
    refreshUi();
}

function directorTaskLabel(task) {
    return task === 'longline' ? '长线规划' : task === 'branch' ? '当前分支' : task === 'foreshadow' ? '伏笔方案' : '推进判断';
}

async function persistDirectorTaskState(ctx, task, status, partial = '') {
    const current = getDirectorState(ctx);
    const next = normalizeDirectorState({
        ...current,
        taskState: { task: String(task || ''), status, partial: compactText(partial, 60000), updatedAt: Date.now() },
    });
    setChatState({ ...getChatState(ctx), director: next }, ctx);
    try { await saveChat(ctx); } catch (error) { console.warn(`[${DISPLAY_NAME}] 导演任务状态保存失败`, error); }
    return next;
}

async function runDirectorTask(ctx, task, options = {}) {
    reconcileGeneratingFlag(ctx);
    if (runtime.directorBusy || runtime.busy || runtime.workflowActive || hostGenerationActive(ctx)) {
        notify('info', '当前还有生成任务进行中，请稍后再使用情节导演。');
        return null;
    }
    const settings = getSettings(ctx);
    const previous = getDirectorState(ctx);
    const calendarContext = calendarContextFor(ctx, previous, task === 'longline' ? 18 : 10);
    const previousTask = previous.taskState || {};
    const continuationDraft = options.continueFromDraft && previousTask.task === task ? previousTask.partial : '';
    const continuationMode = continuationDraft ? 'draft' : options.continueFromDraft ? 'advance' : '';
    const prompt = buildDirectorPrompt({
        task,
        memory: getChatState(ctx),
        recentText: recentStoryText(ctx, task === 'longline' ? 18 : 10),
        characterCard: characterCardText(ctx),
        calendarContext,
        continuationDraft,
        continuationMode,
        state: previous,
        presetId: previous.presetId,
        customBrief: previous.customBrief,
        pacingMode: previous.pacingMode,
        pacingCustom: previous.pacingCustom,
        toggles: previous.toggles,
    });
    const controller = new AbortController();
    runtime.directorBusy = true;
    runtime.directorAbortController = controller;
    runtime.directorText = continuationDraft;
    setStatus(`情节导演正在生成${directorTaskLabel(task)}${continuationDraft ? '（续写）' : ''}……`);
    await persistDirectorTaskState(ctx, task, 'running', continuationDraft);
    refreshUi();
    try {
        const result = await generateWithFallback(ctx, {
            ...prompt,
            providerProfile: moduleProvider(ctx, 'director'),
            preferStream: settings.streamOutput !== false,
            signal: controller.signal,
            onText: text => {
                runtime.directorText = String(text || '');
                refreshUi();
            },
            onStatus: meta => {
                if (meta?.phase === 'connecting') setStatus(`情节导演连接${meta.source || '模型'}……`);
            },
        });
        const packet = parseDirectorPacket(result.text, task);
        let next = previous;
        if (task === 'longline') next = applyLonglineToDirector(previous, packet);
        if (task === 'branch') next = applyBranchesToDirector(previous, packet);
        if (task === 'foreshadow') next = applyForeshadowsToDirector(previous, packet);
        if (task === 'progress') next = applyProgressToDirector(previous, packet);
        next = normalizeDirectorState({ ...next, taskState: { task, status: 'completed', partial: '', updatedAt: Date.now() } });
        await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
        await updateDirectorInjection(ctx);
        notify('success', `${task === 'longline' ? '长线规划' : task === 'branch' ? '当前分支' : task === 'foreshadow' ? '伏笔方案' : '推进状态'}已生成。`);
        return next;
    } catch (error) {
        const stopped = controller.signal.aborted;
        await persistDirectorTaskState(ctx, task, stopped ? 'stopped' : 'error', runtime.directorText);
        if (stopped) notify('info', '情节导演已停止，草稿已保留。');
        else {
            console.error(`[${DISPLAY_NAME}] 情节导演失败`, error);
            notify('error', `情节导演失败：${readableGenerationError(error)}`);
        }
        return null;
    } finally {
        if (runtime.directorAbortController === controller) runtime.directorAbortController = null;
        runtime.directorBusy = false;
        refreshUi();
    }
}

function stopDirectorTask() {
    runtime.directorAbortController?.abort(new DOMException('已中断导演生成', 'AbortError'));
}

async function continueDirectorTask(ctx) {
    const director = getDirectorState(ctx);
    const task = director.taskState?.task || (director.mainPlan ? 'longline' : '');
    if (!task) {
        notify('info', '还没有可续写的导演任务，请先生成一次长线规划。');
        return null;
    }
    return runDirectorTask(ctx, task, { continueFromDraft: true });
}

async function restartDirectorTask(ctx) {
    if (runtime.directorBusy) {
        notify('info', '请先停止当前导演生成，再重新开始。');
        return null;
    }
    const director = getDirectorState(ctx);
    const task = director.taskState?.task || 'longline';
    if (task === 'longline' && director.mainPlan?.status === 'locked') {
        notify('info', '当前主线已经锁定；重新开始不会覆盖它。请先继续当前主线，或手动编辑后再生成分支。');
        return null;
    }
    if (director.taskState?.partial && globalThis.confirm && !globalThis.confirm('确定清除当前未保存的导演草稿并重新开始吗？')) return null;
    runtime.directorText = '';
    const reset = normalizeDirectorState({ ...director, taskState: { task, status: 'idle', partial: '', updatedAt: Date.now() } });
    await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: reset });
    return runDirectorTask(ctx, task, { restart: true });
}

async function clearDirectorAll(ctx) {
    if (runtime.directorBusy) {
        notify('info', '请先停止当前导演生成，再清空导演内容。');
        return null;
    }
    const confirmed = !globalThis.confirm || globalThis.confirm('确定清空导演的全部内容吗？主线、分支、伏笔、推进记录、日历事件和未完成草稿都会被删除。模型连接不会删除。');
    if (!confirmed) return null;
    runtime.directorText = '';
    runtime.lastError = '';
    runtime.lastSuccess = '';
    const next = createEmptyDirectorState();
    await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
    await updateDirectorInjection(ctx);
    notify('success', '导演内容已全部清空。');
    return next;
}

async function updateDirectorInjection(ctx = getContext()) {
    const state = getChatState(ctx);
    const director = normalizeDirectorState(state.director || createEmptyDirectorState());
    const calendarContext = calendarContextFor(ctx, director, 8);
    const card = buildExecutionCard({
        directorState: director,
        memoryState: state,
        recentText: recentStoryText(ctx, 6),
        calendarContext,
    });
    if (typeof ctx.setExtensionPrompt === 'function') {
        await ctx.setExtensionPrompt(DIRECTOR_INJECTION_ID, card, 1, 0, false, 0);
    }
    if (card !== director.lastExecutionCard) {
        const next = { ...state, director: { ...director, lastExecutionCard: card } };
        setChatState(next, ctx);
    }
    return card;
}

async function trackDirectorProgress(ctx = getContext()) {
    const settings = getSettings(ctx);
    const director = getDirectorState(ctx);
    if (!director.enabled || !director.toggles.autoTrack || !director.currentBeatId || runtime.directorBusy) return null;
    const calendarContext = calendarContextFor(ctx, director, 6);
    const prompt = buildDirectorPrompt({
        task: 'progress',
        memory: getChatState(ctx),
        recentText: recentStoryText(ctx, 3),
        characterCard: characterCardText(ctx),
        calendarContext,
        state: director,
        presetId: director.presetId,
        customBrief: director.customBrief,
        pacingMode: director.pacingMode,
        pacingCustom: director.pacingCustom,
        toggles: director.toggles,
    });
    const controller = new AbortController();
    runtime.directorBusy = true;
    runtime.directorAbortController = controller;
    try {
        const result = await generateDirectOnly(ctx, {
            ...prompt,
            providerProfile: moduleProvider(ctx, 'director'),
            signal: controller.signal,
        });
        if (!result) return null;
        const progress = parseDirectorPacket(result.text, 'progress');
        const next = applyProgressToDirector(director, progress);
        await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
        await updateDirectorInjection(ctx);
        return next;
    } catch (error) {
        if (!controller.signal.aborted) console.warn(`[${DISPLAY_NAME}] 自动推进判断失败`, error);
        return null;
    } finally {
        if (runtime.directorAbortController === controller) runtime.directorAbortController = null;
        runtime.directorBusy = false;
        refreshUi();
        scheduleAutoSummary(1200);
    }
}

async function prepareDirectorForGeneration(ctx, type, options, dryRun) {
    const ignored = new Set(['quiet', 'extension', 'command']);
    if (dryRun || ignored.has(String(type || '').toLowerCase())) return;
    try {
        await updateDirectorInjection(ctx);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 导演提示更新失败，本轮继续使用正文生成`, error);
        try { await ctx.setExtensionPrompt?.(DIRECTOR_INJECTION_ID, '', 1, 0, false, 0); } catch { /* Best effort cleanup. */ }
    }
}

async function runReplyTask(ctx) {
    reconcileGeneratingFlag(ctx);
    if (runtime.replyBusy || runtime.busy || runtime.workflowActive || hostGenerationActive(ctx)) {
        notify('info', '当前还有生成任务进行中，请稍后再生成代写回复。');
        return null;
    }
    const settings = getSettings(ctx);
    const state = getChatState(ctx);
    const reply = getReplyState(ctx);
    const director = getDirectorState(ctx);
    const calendarContext = calendarContextFor(ctx, director, 8);
    const prompt = buildReplyPrompt({
        recentText: recentStoryText(ctx, 10),
        memory: state,
        directorCard: reply.followDirector ? buildExecutionCard({ directorState: director, memoryState: state, recentText: recentStoryText(ctx, 4), calendarContext }) : '',
        userPersona: userPersonaText(ctx),
        userName: String(ctx?.name1 || '用户'),
        characterName: String(ctx?.name2 || '角色'),
        preferences: reply,
    });
    const controller = new AbortController();
    runtime.replyBusy = true;
    runtime.replyAbortController = controller;
    runtime.replyText = '';
    setStatus('代写回复正在生成五个候选……');
    refreshUi();
    try {
        const result = await generateWithFallback(ctx, {
            ...prompt,
            providerProfile: moduleProvider(ctx, 'reply'),
            preferStream: settings.streamOutput !== false,
            signal: controller.signal,
            onText: text => {
                runtime.replyText = String(text || '');
                refreshUi();
            },
        });
        const candidates = parseReplyCandidates(result.text, reply.candidateCount);
        const nextReply = { ...reply, lastCandidates: candidates, createdAt: Date.now() };
        await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), reply: nextReply });
        notify('success', `已生成 ${candidates.length} 个代写回复。`);
        return candidates;
    } catch (error) {
        if (controller.signal.aborted) notify('info', '代写回复已中断。');
        else notify('error', `代写回复失败：${readableGenerationError(error)}`);
        return null;
    } finally {
        if (runtime.replyAbortController === controller) runtime.replyAbortController = null;
        runtime.replyBusy = false;
        refreshUi();
    }
}

function stopReplyTask() {
    runtime.replyAbortController?.abort(new DOMException('已中断代写回复', 'AbortError'));
}

async function copyText(text) {
    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(String(text || ''));
        return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = String(text || '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy');
    textarea.remove();
    return Boolean(copied);
}

function insertIntoSendTextarea(text, append = false) {
    const input = document.querySelector('#send_textarea, textarea[data-send-textarea]');
    if (!input) throw new Error('没有找到酒馆编辑栏。');
    const current = String(input.value || '');
    input.value = append && current ? `${current}\n\n${text}` : String(text || '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return input.value;
}

function planEligibleRange(ctx) {
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    return rangeForNewSummary(getMessages(ctx), chatState, {
        keepMessages: settings.keepMessages,
        targetTokens: 0,
    });
}

function planBatchRanges(ctx, goalEnd = Number.POSITIVE_INFINITY, batchTokens = FALLBACK_BATCH_TOKENS) {
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    const messages = getMessages(ctx);
    return rangesForSummaryBacklog(messages, chatState, {
        keepMessages: settings.keepMessages,
        targetTokens: Math.max(0, Number(batchTokens || 0)),
    }).filter(range => range.start <= goalEnd).map(range => (
        range.end > goalEnd ? makeSourceRange(messages, range.start, goalEnd) : range
    ));
}

async function countTokensForPlan(ctx, text) {
    try {
        if (typeof ctx?.getTokenCountAsync === 'function') {
            const count = Number(await ctx.getTokenCountAsync(String(text || '')));
            if (Number.isFinite(count) && count > 0) return Math.round(count);
        }
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 酒馆 tokenizer 计数失败，使用本地估算`, error);
    }
    return tokenEstimate(text);
}

async function buildWorkflowBatchPlan(ctx, goalRange, reason) {
    const settings = getSettings(ctx);
    const provider = moduleProvider(ctx, 'memory');
    const chatState = getChatState(ctx);
    const sourceText = formatMessages(getMessages(ctx), goalRange.start, goalRange.end);
    const factRequest = buildFactPrompt({
        messages: sourceText,
        currentState: formatState(chatState),
        openThreads: formatThreads(chatState),
        customPrompts: settings.prompts,
    });
    const fullFactPrompt = [factRequest.systemPrompt, factRequest.prompt].filter(Boolean).join('\n\n');
    const [sourceTokens, promptTokens] = await Promise.all([
        countTokensForPlan(ctx, sourceText),
        countTokensForPlan(ctx, fullFactPrompt),
    ]);
    return chooseSummaryBatchPlan({
        reason,
        contextTokens: Number(provider?.contextTokens) > 0 ? Number(provider.contextTokens) : resolveContextWindowTokens(ctx),
        outputTokens: Number(provider?.outputTokens) >= 128 ? Number(provider.outputTokens) : resolveOutputReserveTokens(ctx),
        sourceTokens,
        promptTokens,
        autoTriggerTokens: settings.triggerTokens,
        fallbackTokens: FALLBACK_BATCH_TOKENS,
    });
}

function shouldAutoSummarize(ctx) {
    reconcileGeneratingFlag(ctx);
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    if (!settings.autoSummarize || !chatState.enabled || chatState.pending || runtime.busy || runtime.workflowActive || hostGenerationActive(ctx) || runtime.directorBusy || runtime.replyBusy) return false;
    const range = planEligibleRange(ctx);
    if (!range) return false;
    const messages = getMessages(ctx);
    const text = formatMessages(messages, range.start, range.end);
    return tokenEstimate(text) >= settings.triggerTokens;
}

function scheduleAutoSummary(delay = 1100) {
    if (runtime.timer || runtime.scheduled) return;
    runtime.scheduled = true;
    runtime.timer = setTimeout(async () => {
        runtime.timer = null;
        runtime.scheduled = false;
        try {
            const ctx = getContext();
            if (shouldAutoSummarize(ctx)) await startSummary(false);
        } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 自动总结失败`, error);
        }
    }, delay);
}

async function startSummary(manual = true) {
    const ctx = getContext();
    reconcileGeneratingFlag(ctx);
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    if (runtime.busy || runtime.workflowActive) {
        if (manual) notify('info', '已有总结任务正在运行。');
        return;
    }
    if (chatState.pending) {
        if (manual) notify('info', '已有未完成的总结，请点击“继续”恢复，或点击“恢复并重建”放弃它。');
        return;
    }
    const range = planEligibleRange(ctx);
    if (!range) {
        notify('info', manual ? '目前没有足够的旧正文可总结；请保留一些近期消息后再试。' : '尚未达到自动总结阈值。');
        return;
    }
    if (!manual) {
        const sourceTokens = tokenEstimate(formatMessages(getMessages(ctx), range.start, range.end));
        if (sourceTokens < settings.triggerTokens) return;
    }
    await runSummaryWorkflow(ctx, {
        reason: manual ? 'manual' : 'auto',
        goalRange: range,
    });
}

async function runSummaryWorkflow(ctx, options = {}) {
    const settings = getSettings(ctx);
    const resumeTask = options.resumeTask || null;
    const savedWorkflow = resumeTask?.workflow && typeof resumeTask.workflow === 'object' ? resumeTask.workflow : {};
    const goalStart = Number(savedWorkflow.goalStart ?? options.goalRange?.start ?? resumeTask?.range?.start);
    const goalEnd = Number(savedWorkflow.goalEnd ?? options.goalRange?.end ?? resumeTask?.range?.end);
    if (!Number.isInteger(goalStart) || !Number.isInteger(goalEnd) || goalEnd < goalStart) {
        throw new Error('无法确定本次总结的完整消息范围。');
    }

    const reason = String(resumeTask?.reason || options.reason || 'manual');
    const workflowId = String(savedWorkflow.id || `workflow_${Date.now()}_${simpleHash(`${goalStart}:${goalEnd}`)}`);
    const hasSavedPlan = Number.isFinite(Number(savedWorkflow.batchTokens)) && Boolean(savedWorkflow.strategy);
    const batchPlan = hasSavedPlan
        ? {
            strategy: savedWorkflow.strategy,
            batchTokens: Math.max(0, Number(savedWorkflow.batchTokens || 0)),
            contextTokens: Math.max(0, Number(savedWorkflow.contextTokens || 0)),
            sourceTokens: Math.max(1, Number(savedWorkflow.sourceTokens || 1)),
            promptTokens: Math.max(1, Number(savedWorkflow.promptTokens || 1)),
            usablePromptTokens: Math.max(0, Number(savedWorkflow.usablePromptTokens || 0)),
        }
        : await buildWorkflowBatchPlan(ctx, { start: goalStart, end: goalEnd }, reason);
    const batchTokens = batchPlan.batchTokens;
    let batchIndex = Math.max(0, Number(savedWorkflow.batchIndex || 0));
    const initialRanges = planBatchRanges(ctx, goalEnd, batchTokens);
    let totalBatches = Math.max(batchIndex + 1, Number(savedWorkflow.totalBatches || 0), batchIndex + initialRanges.length);
    let pending = resumeTask;
    let lastEnd = Number(getChatState(ctx).lastProcessedIndex ?? goalStart - 1);

    runtime.workflowActive = true;
    try {
        while (true) {
            const planned = planBatchRanges(ctx, goalEnd, batchTokens);
            let range = pending?.range || planned[0] || null;
            if (!range || range.start > goalEnd) break;
            if (range.end > goalEnd) range = makeSourceRange(getMessages(ctx), range.start, goalEnd);
            totalBatches = Math.max(totalBatches, batchIndex + Math.max(1, planned.length));
            const workflowInfo = {
                id: workflowId,
                goalStart,
                goalEnd,
                batchIndex,
                totalBatches,
                ...batchPlan,
            };
            runtime.workflow = workflowInfo;
            const mode = batchPlan.strategy === 'single' ? '上下文充足，整段处理' : batchPlan.strategy === 'adaptive-split' ? '超出上下文，自适应分批' : batchPlan.strategy === 'auto-threshold' ? '自动阈值分批' : '安全回退分批';
            setStatus(`${mode} · 第 ${batchIndex + 1}/${totalBatches} 批 · 消息 ${range.start}–${range.end} · 总目标 ${goalStart}–${goalEnd}`);
            refreshUi();
            const result = await summarizeRange(ctx, range, settings, reason, pending, workflowInfo);
            if (!result) return null;
            lastEnd = range.end;
            batchIndex += 1;
            pending = null;
            if (lastEnd >= goalEnd) break;
        }

        if (lastEnd < goalEnd) {
            runtime.lastError = `总结在消息 ${lastEnd} 后停止，尚未到达目标 ${goalEnd}`;
            notify('warning', runtime.lastError);
            return null;
        }
        runtime.lastError = '';
        const planText = batchPlan.strategy === 'single' ? '整段完成' : `自适应完成 ${batchIndex} 批`;
        runtime.lastSuccess = `${reason === 'manual' ? '手动全量总结' : '自动总结'}完成 · 消息 ${goalStart}–${goalEnd} · ${planText}`;
        notify('success', `${reason === 'manual' ? '手动总结' : '自动总结'}已一次完成消息 ${goalStart}–${goalEnd}，${planText}${settings.autoHide ? '，旧正文已退出上下文' : ''}。`);
        return getChatState(ctx);
    } finally {
        runtime.workflowActive = false;
        runtime.workflow = null;
        refreshUi();
        if (!runtime.lastError && !getChatState(ctx).pending) scheduleAutoSummary(1200);
    }
}

async function continueSummary() {
    if (runtime.busy || runtime.workflowActive) return;
    const ctx = getContext();
    const pending = getChatState(ctx).pending;
    if (!pending?.range) {
        notify('info', '没有可以继续的总结任务。');
        return;
    }
    if (!rangeStillMatches(getMessages(ctx), pending.range)) {
        const state = getChatState(ctx);
        state.pending = null;
        setChatState(state, ctx);
        await saveChat(ctx);
        refreshUi();
        notify('warning', '原消息已发生变化，旧的中断任务不能继续，请重新总结。');
        return;
    }
    const workflow = pending.workflow && typeof pending.workflow === 'object' ? pending.workflow : {};
    const eligible = planEligibleRange(ctx);
    await runSummaryWorkflow(ctx, {
        reason: pending.reason || 'continued',
        goalRange: {
            start: Number(workflow.goalStart ?? pending.range.start),
            end: Number(workflow.goalEnd ?? eligible?.end ?? pending.range.end),
        },
        resumeTask: pending,
    });
}

function stopSummary() {
    const controller = runtime.abortController;
    if (!controller) return;
    runtime.taskSerial += 1;
    controller.abort(new DOMException('用户中断总结', 'AbortError'));
    setStatus(`正在中断${stageName(runtime.activeStage)}并保存进度……`);
    try { getContext().stopGeneration?.(); } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 酒馆停止接口调用失败`, error);
    }
}

async function restoreAll() {
    const ctx = getContext();
    const count = await restoreOwnedMessages(ctx);
    const chatState = getChatState(ctx);
    chatState.hiddenRanges = [];
    setChatState(chatState, ctx);
    await saveChat(ctx, { includeMessages: true });
    await applyInjection(ctx, chatState, getSettings(ctx));
    refreshUi();
    notify('success', count ? `已恢复 ${count} 条由插件隐藏的消息。` : '没有需要恢复的插件隐藏消息。');
}

async function rebuildFromStart() {
    const ctx = getContext();
    const old = getChatState(ctx);
    await restoreOwnedMessages(ctx);
    const fresh = normalizeChatState({
        enabled: old.enabled,
        autoSummarize: old.autoSummarize,
        autoHide: old.autoHide,
        summaryMode: old.summaryMode,
        director: old.director,
        reply: old.reply,
    });
    setChatState(fresh, ctx);
    await saveChat(ctx, { includeMessages: true });
    await applyInjection(ctx, fresh, getSettings(ctx));
    refreshUi();
    notify('info', '已恢复原文并清空当前检查点。点击“立即总结”重新建立记忆。');
}

async function reconcileAndRefresh() {
    try {
        const ctx = getContext();
        const current = getChatState(ctx);
        const result = await invalidateIfNeeded(ctx, current);
        if (result.changed) {
            await saveChat(ctx);
            await applyInjection(ctx, result.state, getSettings(ctx));
            notify('warning', `检测到已总结消息发生变化，已使 ${result.affected} 个检查点失效。`);
        } else {
            await applyInjection(ctx, current, getSettings(ctx));
        }
        await updateDirectorInjection(ctx);
        refreshUi();
        scheduleAutoSummary(1300);
    } catch (error) { console.warn(`[${DISPLAY_NAME}] 上下文同步失败`, error); }
}

function setStatus(message) {
    const node = runtime.overlay?.querySelector('[data-gds-status]');
    if (node) node.textContent = message || (runtime.busy ? '处理中……' : '已就绪');
}

function renderCheckpointList(chatState) {
    const list = [...(chatState.checkpoints || [])].reverse();
    if (!list.length) return '<div class="gds-empty">还没有检查点。总结成功后会显示在这里。</div>';
    return list.map(item => `
        <div class="gds-checkpoint">
            <div><span class="gds-dot ${item.status === 'dirty' ? 'dirty' : ''}"></span><strong>${escapeHtml(item.id)}</strong></div>
            <small>消息 ${Number(item.range?.start ?? 0)}–${Number(item.range?.end ?? 0)} · ${escapeHtml(item.reason || 'auto')}</small>
            <small>${item.hiddenCount ? `已隐藏 ${item.hiddenCount} 条` : '未自动隐藏'}</small>
        </div>`).join('');
}

function renderDirectorPlan(director) {
    const plan = director?.mainPlan;
    if (!plan) return '<div class="gds-empty">还没有主线规划。输入要求后点击“生成长线规划”。</div>';
    const arcs = (plan.arcs || []).map(arc => {
        const beat = (arc.beats || []).find(item => item.id === director.currentBeatId) || (arc.beats || []).find(item => item.status !== 'completed');
        return `<div class="gds-plan-arc"><strong>${escapeHtml(arc.title)}</strong><small>${escapeHtml(arc.pacing || 'balanced')} · 预计 ${Number(arc.estimatedTurns || 0)} 轮</small><p>${escapeHtml(arc.goal || '')}</p>${beat ? `<em>当前节拍：${escapeHtml(beat.goal || '')}</em>` : '<em>阶段已完成</em>'}</div>`;
    }).join('');
    return `<div class="gds-plan-head"><strong>${escapeHtml(plan.title)}</strong><span>${plan.status === 'locked' ? '已锁定' : '草案'}</span></div><p>${escapeHtml(plan.premise || '')}</p><div class="gds-plan-arcs">${arcs}</div><button data-gds-director-lock ${plan.status === 'locked' ? 'disabled' : ''}>${plan.status === 'locked' ? '主线已锁定' : '确认并锁定主线'}</button>`;
}

function renderDirectorBranches(director) {
    const branches = Array.isArray(director?.branchCandidates) ? director.branchCandidates : [];
    if (!branches.length) return '<div class="gds-empty">还没有分支候选。</div>';
    return branches.map(branch => `<article class="gds-branch-card ${branch.id === director.activeBranchId ? 'active' : ''}"><strong>${escapeHtml(branch.title)}</strong><p>${escapeHtml(branch.summary)}</p><small>${escapeHtml(branch.reason || '')}</small><button data-gds-director-select-branch="${escapeHtml(branch.id)}">${branch.id === director.activeBranchId ? '当前执行中' : '采用此分支'}</button></article>`).join('');
}

function renderDirectorForeshadows(director) {
    const items = Array.isArray(director?.foreshadows) ? director.foreshadows : [];
    if (!items.length) return '<div class="gds-empty">还没有伏笔方案。</div>';
    return items.map(item => `<article class="gds-foreshadow-card"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.status)}</span><p>${escapeHtml(item.surface)}</p><small>真实含义：${escapeHtml(item.meaning || '待补充')}</small></article>`).join('');
}

function renderCalendarEvents(calendar, context) {
    const alerts = context?.alerts || [];
    const alertHtml = alerts.length
        ? alerts.slice(0, 8).map(item => `<article class="gds-calendar-alert ${item.isToday ? 'today' : ''}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.date)} · ${escapeHtml(item.phase)} · ${item.isToday ? '今天' : item.daysUntil > 0 ? `${item.daysUntil}天后` : `${Math.abs(item.daysUntil)}天前`}</span><p>${escapeHtml(item.plotHook || item.note || '可作为剧情背景提醒，是否采用由正文因果决定。')}</p></article>`).join('')
        : '<div class="gds-empty">当前日期附近没有日历提醒。</div>';
    const custom = Array.isArray(calendar?.events) ? calendar.events : [];
    const eventHtml = custom.length
        ? custom.map(item => `<article class="gds-calendar-event"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.kind)} · ${item.dateRule === 'cycle' ? `每 ${item.recurrence.cycleDays} 天，持续 ${item.recurrence.durationDays} 天` : escapeHtml(item.date || item.startDate || '未设日期')}</span></div><small>${escapeHtml(item.plotHook || item.note || '无剧情提示')}</small><button data-gds-calendar-remove="${escapeHtml(item.id)}" title="删除事件">删除</button></article>`).join('')
        : '<div class="gds-empty">还没有自定义事件。可以添加纪念日、生日、周期事件或剧情期限。</div>';
    return `<div class="gds-calendar-context"><strong>故事日期：${escapeHtml(context?.date || '未识别')}</strong><span>来源：${escapeHtml(context?.source || '自动')} · 置信度：${escapeHtml(context?.confidence || 'unknown')}</span>${context?.evidence ? `<small>依据：${escapeHtml(context.evidence)}</small>` : ''}</div><div class="gds-calendar-alerts"><h5>近期提醒</h5>${alertHtml}</div><div class="gds-calendar-events"><h5>自定义事件</h5>${eventHtml}</div>`;
}

function renderReplyCandidates(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return '<div class="gds-empty">还没有代写回复。点击“生成五个候选”。</div>';
    return candidates.map((item, index) => `<article class="gds-reply-card"><div class="gds-reply-card-head"><strong>${escapeHtml(item.title || `候选 ${index + 1}`)}</strong><small>${escapeHtml(item.intent || '')}</small></div><textarea readonly data-gds-reply-text="${escapeHtml(item.id)}">${escapeHtml(item.text)}</textarea><p>${escapeHtml(item.possibleEffect || '')}</p><div><button data-gds-reply-copy="${escapeHtml(item.id)}">复制</button><button class="gds-primary" data-gds-reply-insert="${escapeHtml(item.id)}">放入编辑栏</button></div></article>`).join('');
}

function populateDirectorOptions(overlay) {
    const preset = overlay.querySelector('[data-gds-director-preset]');
    if (preset && !preset.options.length) {
        preset.innerHTML = [
            ['balanced', '均衡推进'],
            ['broken-reunion', '破镜重圆 · 酸涩慢热'],
            ['dual-growth', '双强成长 · 并肩升级'],
            ['identity-secret', '身份秘密 · 逐层掉马'],
            ['slow-burn', '暗恋成真 · 克制渗透'],
            ['redemption', '救赎陪伴 · 克制治愈'],
            ['first-marriage', '先婚后爱 · 日常变真心'],
            ['mystery-ensemble', '悬疑群像 · 感情暗线'],
        ].map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    }
    const pacing = overlay.querySelector('[data-gds-director-pacing]');
    if (pacing && !pacing.options.length) pacing.innerHTML = PACING_OPTIONS.map(item => `<option value="${item.id}">${item.name}：${item.description}</option>`).join('');
    const viewpoint = overlay.querySelector('[data-gds-reply-viewpoint]');
    if (viewpoint && !viewpoint.options.length) viewpoint.innerHTML = REPLY_VIEWPOINTS.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
    const detail = overlay.querySelector('[data-gds-reply-detail]');
    if (detail && !detail.options.length) detail.innerHTML = REPLY_DETAIL_LEVELS.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
    const length = overlay.querySelector('[data-gds-reply-length]');
    if (length && !length.options.length) length.innerHTML = '<option value="short">短（1–3句）</option><option value="medium">中（一个完整回合）</option><option value="long">长（多段行动）</option>';
    const initiative = overlay.querySelector('[data-gds-reply-initiative]');
    if (initiative && !initiative.options.length) initiative.innerHTML = '<option value="passive">被动回应</option><option value="natural">自然接话</option><option value="active">主动推进</option>';
}

function providerChoices(ctx) {
    const settings = getSettings(ctx);
    const choices = [{ value: PROVIDER_CURRENT, label: '跟随当前酒馆连接' }];
    for (const profile of getConnectionManagerProfiles(ctx)) choices.push({ value: `connection:${profile.id}`, label: `酒馆连接：${profile.name}` });
    for (const profile of normalizeProviderProfiles(settings.apiProfiles)) choices.push({ value: profile.id, label: `独立连接：${profile.name}` });
    return choices;
}

function populateProviderSelectors(overlay, ctx) {
    const choices = providerChoices(ctx);
    const signature = JSON.stringify(choices);
    for (const moduleName of ['memory', 'director', 'reply']) {
        const select = overlay.querySelector(`[data-gds-provider="${moduleName}"]`);
        if (!select) continue;
        const previous = select.value;
        if (select.dataset.gdsProviderChoices !== signature) {
            select.innerHTML = choices.map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
            select.dataset.gdsProviderChoices = signature;
        }
        const desired = getSettings(ctx).moduleConnections?.[moduleName] || PROVIDER_CURRENT;
        select.value = choices.some(item => item.value === desired) ? desired : (choices.some(item => item.value === previous) ? previous : PROVIDER_CURRENT);
    }
}

async function saveApiProfileFromUi(ctx) {
    const overlay = runtime.overlay;
    const name = String(overlay.querySelector('[data-gds-api-name]')?.value || '').trim();
    const baseUrl = String(overlay.querySelector('[data-gds-api-url]')?.value || '').trim();
    const apiKey = String(overlay.querySelector('[data-gds-api-key]')?.value || '');
    const model = String(overlay.querySelector('[data-gds-api-model]')?.value || '').trim();
    if (!baseUrl || !model) throw new Error('请先填写独立 API URL 和模型名。');
    const id = `custom_${Date.now()}`;
    const profile = {
        id,
        kind: 'openai-compatible',
        name: name || model,
        baseUrl,
        apiKey,
        model,
        contextTokens: Math.max(0, Number(overlay.querySelector('[data-gds-api-context]')?.value || 0) || 0),
        outputTokens: Math.max(128, Number(overlay.querySelector('[data-gds-api-output]')?.value || 4096) || 4096),
        stream: true,
    };
    const settings = getSettings(ctx);
    settings.apiProfiles = [...normalizeProviderProfiles(settings.apiProfiles), profile];
    const moduleName = overlay.querySelector('[data-gds-api-module]')?.value || 'director';
    settings.moduleConnections[moduleName] = id;
    ctx.extensionSettings[SETTINGS_KEY] = settings;
    saveSettings(ctx);
    populateProviderSelectors(overlay, ctx);
    refreshUi();
    notify('success', `独立连接已保存并绑定到${moduleName === 'memory' ? '剧情记忆' : moduleName === 'director' ? '情节导演' : '代写回复'}。`);
}

async function testApiProfileFromUi(ctx) {
    const overlay = runtime.overlay;
    const profile = {
        kind: 'openai-compatible',
        name: String(overlay.querySelector('[data-gds-api-name]')?.value || '独立连接'),
        baseUrl: String(overlay.querySelector('[data-gds-api-url]')?.value || '').trim(),
        apiKey: String(overlay.querySelector('[data-gds-api-key]')?.value || ''),
        model: String(overlay.querySelector('[data-gds-api-model]')?.value || '').trim(),
    };
    const models = await listDirectModels(profile);
    notify('success', models.length ? `连接成功，模型：${models.slice(0, 8).join('、')}${models.length > 8 ? '……' : ''}` : '连接成功，但服务未返回模型列表。');
}

function setActiveTab(tab = 'home') {
    const windowNode = runtime.overlay?.querySelector('.gds-window');
    if (!windowNode) return;
    const active = ['home', 'memory', 'director', 'reply', 'connections'].includes(tab) ? tab : 'home';
    windowNode.dataset.gdsTab = active;
    for (const button of windowNode.querySelectorAll('[data-gds-tab]')) button.classList.toggle('active', button.dataset.gdsTab === active);
    for (const panel of windowNode.querySelectorAll('[data-gds-tab-panel]')) panel.hidden = panel.dataset.gdsTabPanel !== active;
    const navigation = windowNode.querySelector('.gds-tabs');
    if (navigation) navigation.hidden = active === 'home';
    const pageHost = windowNode.querySelector('.gds-page-host');
    if (pageHost) pageHost.scrollTop = 0;
    const title = windowNode.querySelector('[data-gds-page-title]');
    const subtitles = {
        home: ['嘎嘎小狗工坊', '选择一个功能开始'],
        memory: ['剧情记忆', '精简前情 · 保留细节 · 自动隐藏'],
        director: ['情节导演', '规划主线 · 分支 · 伏笔 · 日历'],
        reply: ['代写回复', '生成候选 · 复制或放入编辑栏'],
        connections: ['模型连接', '分别绑定酒馆连接或独立 API'],
    };
    if (title) title.textContent = subtitles[active][0];
    const subtitle = windowNode.querySelector('[data-gds-page-subtitle]');
    if (subtitle) subtitle.textContent = subtitles[active][1];
}

function updateDirectorFromUi(ctx) {
    const current = getDirectorState(ctx);
    const overlay = runtime.overlay;
    const currentCalendar = normalizeCalendarState(current.calendar || createEmptyCalendarState());
    const next = normalizeDirectorState({
        ...current,
        enabled: Boolean(overlay.querySelector('[data-gds-director-enabled]')?.checked),
        presetId: overlay.querySelector('[data-gds-director-preset]')?.value || current.presetId,
        pacingMode: overlay.querySelector('[data-gds-director-pacing]')?.value || current.pacingMode,
        pacingCustom: overlay.querySelector('[data-gds-director-pacing-custom]')?.value || '',
        customBrief: overlay.querySelector('[data-gds-director-brief]')?.value || '',
        toggles: Object.fromEntries(Object.keys(current.toggles).map(key => [key, Boolean(overlay.querySelector(`[data-gds-director-toggle="${key}"]`)?.checked)])),
        calendar: {
            ...currentCalendar,
            enabled: Boolean(overlay.querySelector('[data-gds-calendar-enabled]')?.checked),
            builtinsEnabled: Boolean(overlay.querySelector('[data-gds-calendar-builtins]')?.checked),
            autoAdvance: Boolean(overlay.querySelector('[data-gds-calendar-auto-advance]')?.checked),
            reminderWindowDays: Math.max(0, Number(overlay.querySelector('[data-gds-calendar-window]')?.value || currentCalendar.reminderWindowDays) || 0),
            worldDate: String(overlay.querySelector('[data-gds-calendar-world-date]')?.value || currentCalendar.worldDate || '').trim(),
        },
    });
    saveDirectorState(ctx, next);
    saveSettings(ctx);
    return next;
}

function addCalendarEventFromUi(ctx) {
    const overlay = runtime.overlay;
    const calendar = normalizeCalendarState(getDirectorState(ctx).calendar);
    const title = String(overlay.querySelector('[data-gds-calendar-title]')?.value || '').trim();
    if (!title) throw new Error('请先填写日历事件名称。');
    const kind = overlay.querySelector('[data-gds-calendar-kind]')?.value || 'custom';
    const dateRule = overlay.querySelector('[data-gds-calendar-rule]')?.value || 'once';
    const date = String(overlay.querySelector('[data-gds-calendar-date]')?.value || '').trim();
    const cycleDays = Number(overlay.querySelector('[data-gds-calendar-cycle]')?.value || 28) || 28;
    const durationDays = Number(overlay.querySelector('[data-gds-calendar-duration]')?.value || 5) || 5;
    const plotHook = String(overlay.querySelector('[data-gds-calendar-hook]')?.value || '').trim();
    const event = normalizeCalendarEvent({
        id: `calendar_${Date.now()}`,
        title,
        kind,
        dateRule,
        date,
        recurrence: { anchorDate: dateRule === 'cycle' ? date : '', cycleDays, durationDays },
        plotHook,
        source: 'user',
        remindDays: calendar.reminderWindowDays,
    });
    if ((dateRule === 'once' || dateRule === 'annual' || dateRule === 'cycle') && !event.date && dateRule !== 'cycle') throw new Error('请填写有效日期。');
    if (dateRule === 'cycle' && !event.recurrence.anchorDate) throw new Error('周期事件需要填写起始日期。');
    const next = normalizeDirectorState({ ...getDirectorState(ctx), calendar: { ...calendar, events: [...calendar.events, event] } });
    saveDirectorState(ctx, next);
    for (const selector of ['[data-gds-calendar-title]', '[data-gds-calendar-date]', '[data-gds-calendar-hook]']) {
        const node = overlay.querySelector(selector);
        if (node) node.value = '';
    }
    return next;
}

async function removeCalendarEvent(ctx, eventId) {
    const director = getDirectorState(ctx);
    const calendar = normalizeCalendarState(director.calendar);
    const next = normalizeDirectorState({ ...director, calendar: { ...calendar, events: calendar.events.filter(item => item.id !== String(eventId || '')) } });
    await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
    await updateDirectorInjection(ctx);
}

async function syncCalendarFromStory(ctx) {
    const director = getDirectorState(ctx);
    const state = getChatState(ctx);
    const context = calendarContextFor(ctx, director, 14);
    const next = normalizeDirectorState({ ...director, calendar: { ...normalizeCalendarState(director.calendar), dateSource: context.source, dateConfidence: context.confidence, dateEvidence: context.evidence, lastSyncedAt: Date.now() } });
    await saveChatStateAndRefresh(ctx, { ...state, director: next });
    await updateDirectorInjection(ctx);
    notify('success', `已从角色卡与正文读取日期：${context.date}（${context.source}）。`);
    return context;
}

function updateReplyFromUi(ctx) {
    const current = getReplyState(ctx);
    const overlay = runtime.overlay;
    const next = normalizeReplyState({
        ...current,
        viewpoint: overlay.querySelector('[data-gds-reply-viewpoint]')?.value || current.viewpoint,
        detail: overlay.querySelector('[data-gds-reply-detail]')?.value || current.detail,
        length: overlay.querySelector('[data-gds-reply-length]')?.value || current.length,
        initiative: overlay.querySelector('[data-gds-reply-initiative]')?.value || current.initiative,
        tone: overlay.querySelector('[data-gds-reply-tone]')?.value || current.tone,
        followDirector: Boolean(overlay.querySelector('[data-gds-reply-follow]')?.checked),
        customInstruction: overlay.querySelector('[data-gds-reply-brief]')?.value || '',
    });
    saveReplyState(ctx, next);
    return next;
}

function savedRecap(chatState) {
    const selected = String(chatState?.summaryArtifacts?.[chatState?.summaryMode] || '').trim();
    const direct = selected || String(chatState?.recap || '').trim();
    if (direct) return direct;
    const latest = [...(chatState?.checkpoints || [])]
        .reverse()
        .find(item => item.status === 'committed' && String(item.recap || '').trim());
    return String(latest?.recap || '').trim();
}

function refreshUi() {
    if (!runtime.overlay) return;
    const ctx = getContext();
    reconcileGeneratingFlag(ctx);
    const settings = getSettings(ctx);
    populateProviderSelectors(runtime.overlay, ctx);
    const chatState = getChatState(ctx);
    const summary = runtime.overlay.querySelector('[data-gds-summary]');
    const preview = runtime.overlay.querySelector('[data-gds-preview]');
    const streamPreview = runtime.overlay.querySelector('[data-gds-stream-preview]');
    const recap = savedRecap(chatState);
    const director = getDirectorState(ctx);
    const reply = getReplyState(ctx);
    const calendar = normalizeCalendarState(director.calendar || createEmptyCalendarState());
    const calendarContext = calendarContextFor(ctx, director, 10);
    if (recap && !chatState.recap.trim()) {
        chatState.recap = recap;
        setChatState(chatState, ctx);
        saveChat(ctx).catch(error => console.warn(`[${DISPLAY_NAME}] 检查点前情回填保存失败`, error));
    }
    if (summary && (document.activeElement !== summary || !summary.value.trim())) summary.value = recap;
    if (streamPreview && document.activeElement !== streamPreview) {
        streamPreview.value = runtime.streamText || chatState.pending?.partialText || '';
    }
    if (preview) preview.value = compileInjection(chatState, { maxTokens: settings.injectionMaxTokens });
    const metrics = runtime.overlay.querySelector('[data-gds-metrics]');
    if (metrics) metrics.innerHTML = `
        <span>场景 ${chatState.sceneCards.length}</span>
        <span>事实 ${chatState.facts.length}</span>
        <span>未结 ${chatState.threads.filter(item => item.status === 'open').length}</span>
        <span>检查点 ${chatState.checkpoints.length}</span>
        <span>注入约 ${chatState.lastInjectionTokens || tokenEstimate(chatState.lastInjection || '')} Token</span>`;
    const status = runtime.overlay.querySelector('[data-gds-status]');
    if (status && !runtime.busy && !runtime.workflowActive) {
        const hasCheckpoint = chatState.checkpoints.some(item => item.status === 'committed');
        const recapMissing = hasCheckpoint && !recap;
        const orphanOutput = Boolean(runtime.streamText.trim() && !hasCheckpoint && !chatState.pending);
        if (chatState.pending) status.textContent = `总结未完成：${stageName(chatState.pending.stage)}，请点击“继续”`;
        else if (runtime.lastError) status.textContent = `未保存：${runtime.lastError}`;
        else if (recapMissing) status.textContent = '检查点已保存，但当前总结成品为空，请点击“恢复并重建”';
        else if (orphanOutput) status.textContent = '收到模型文本，但尚未保存成记忆，请重新总结';
        else if (runtime.lastSuccess) status.textContent = runtime.lastSuccess;
        else status.textContent = hasCheckpoint ? '记忆已保存并正在注入' : '尚未建立记忆，点击“立即总结”';
    }
    const summarize = runtime.overlay.querySelector('[data-gds-summarize]');
    const resume = runtime.overlay.querySelector('[data-gds-continue]');
    const stop = runtime.overlay.querySelector('[data-gds-stop]');
    const directorStop = runtime.overlay.querySelector('[data-gds-director-stop]');
    const directorContinue = runtime.overlay.querySelector('[data-gds-director-continue]');
    const directorRestart = runtime.overlay.querySelector('[data-gds-director-restart]');
    const directorClear = runtime.overlay.querySelector('[data-gds-director-clear]');
    const replyStop = runtime.overlay.querySelector('[data-gds-reply-stop]');
    const rebuild = runtime.overlay.querySelector('[data-gds-rebuild]');
    const restore = runtime.overlay.querySelector('[data-gds-restore]');
    const taskActive = runtime.busy || runtime.workflowActive || runtime.directorBusy || runtime.replyBusy;
    if (summarize) summarize.disabled = taskActive || Boolean(chatState.pending);
    if (resume) {
        resume.hidden = taskActive || !chatState.pending;
        resume.disabled = taskActive;
    }
    if (stop) stop.hidden = !(runtime.busy && runtime.abortController);
    if (directorStop) directorStop.hidden = !(runtime.directorBusy && runtime.directorAbortController);
    if (directorContinue) {
        const resumable = Boolean(director.taskState?.task || director.mainPlan);
        directorContinue.disabled = taskActive || !resumable;
        directorContinue.title = director.taskState?.partial ? '从上次停止的草稿继续' : '从当前导演状态继续规划';
    }
    if (directorRestart) directorRestart.disabled = taskActive;
    if (directorClear) directorClear.disabled = taskActive;
    if (replyStop) replyStop.hidden = !(runtime.replyBusy && runtime.replyAbortController);
    if (rebuild) rebuild.disabled = taskActive;
    if (restore) restore.disabled = taskActive;
    const list = runtime.overlay.querySelector('[data-gds-checkpoints]');
    if (list) list.innerHTML = renderCheckpointList(chatState);
    const auto = runtime.overlay.querySelector('[data-gds-auto]');
    const hide = runtime.overlay.querySelector('[data-gds-hide]');
    const collapse = runtime.overlay.querySelector('[data-gds-collapse]');
    const stream = runtime.overlay.querySelector('[data-gds-stream]');
    const mode = runtime.overlay.querySelector('[data-gds-mode]');
    const summaryMode = runtime.overlay.querySelector('[data-gds-summary-mode]');
    if (auto) auto.checked = Boolean(settings.autoSummarize);
    if (hide) hide.checked = Boolean(settings.autoHide);
    if (collapse) collapse.checked = Boolean(settings.collapseHidden);
    if (stream) stream.checked = settings.streamOutput !== false;
    if (mode) mode.value = 'balanced';
    if (summaryMode) summaryMode.value = chatState.summaryMode || settings.summaryMode;
    for (const [selector, value] of [
        ['[data-gds-trigger]', settings.triggerTokens],
        ['[data-gds-keep]', settings.keepMessages],
        ['[data-gds-injection]', settings.injectionMaxTokens],
        ['[data-gds-words]', settings.targetWords],
    ]) {
        const input = runtime.overlay.querySelector(selector);
        if (input && document.activeElement !== input) input.value = value;
    }
    const directorEnabled = runtime.overlay.querySelector('[data-gds-director-enabled]');
    const directorPreset = runtime.overlay.querySelector('[data-gds-director-preset]');
    const directorPacing = runtime.overlay.querySelector('[data-gds-director-pacing]');
    const directorPacingCustom = runtime.overlay.querySelector('[data-gds-director-pacing-custom]');
    const directorBrief = runtime.overlay.querySelector('[data-gds-director-brief]');
    if (directorEnabled) directorEnabled.checked = Boolean(director.enabled);
    if (directorPreset) directorPreset.value = director.presetId;
    if (directorPacing) directorPacing.value = director.pacingMode;
    if (directorPacingCustom && document.activeElement !== directorPacingCustom) directorPacingCustom.value = director.pacingCustom || '';
    if (directorBrief && document.activeElement !== directorBrief) directorBrief.value = director.customBrief;
    for (const [selector, value] of Object.entries(director.toggles || {})) {
        const input = runtime.overlay.querySelector(`[data-gds-director-toggle="${selector}"]`);
        if (input) input.checked = Boolean(value);
    }
    const directorOutput = runtime.overlay.querySelector('[data-gds-director-output]');
    if (directorOutput && document.activeElement !== directorOutput) directorOutput.value = runtime.directorText || director.lastExecutionCard || '';
    const directorPlan = runtime.overlay.querySelector('[data-gds-director-plan]');
    if (directorPlan) directorPlan.innerHTML = renderDirectorPlan(director);
    const branchList = runtime.overlay.querySelector('[data-gds-director-branches]');
    if (branchList) branchList.innerHTML = renderDirectorBranches(director);
    const foreshadowList = runtime.overlay.querySelector('[data-gds-director-foreshadows]');
    if (foreshadowList) foreshadowList.innerHTML = renderDirectorForeshadows(director);
    const calendarEnabled = runtime.overlay.querySelector('[data-gds-calendar-enabled]');
    const calendarBuiltins = runtime.overlay.querySelector('[data-gds-calendar-builtins]');
    const calendarAutoAdvance = runtime.overlay.querySelector('[data-gds-calendar-auto-advance]');
    const calendarWindow = runtime.overlay.querySelector('[data-gds-calendar-window]');
    const calendarWorldDate = runtime.overlay.querySelector('[data-gds-calendar-world-date]');
    if (calendarEnabled) calendarEnabled.checked = Boolean(calendar.enabled);
    if (calendarBuiltins) calendarBuiltins.checked = Boolean(calendar.builtinsEnabled);
    if (calendarAutoAdvance) calendarAutoAdvance.checked = Boolean(calendar.autoAdvance);
    if (calendarWindow && document.activeElement !== calendarWindow) calendarWindow.value = calendar.reminderWindowDays;
    if (calendarWorldDate && document.activeElement !== calendarWorldDate) calendarWorldDate.value = calendar.worldDate || '';
    const calendarOutput = runtime.overlay.querySelector('[data-gds-calendar-output]');
    if (calendarOutput) calendarOutput.innerHTML = renderCalendarEvents(calendar, calendarContext);
    const replyViewpoint = runtime.overlay.querySelector('[data-gds-reply-viewpoint]');
    const replyDetail = runtime.overlay.querySelector('[data-gds-reply-detail]');
    const replyLength = runtime.overlay.querySelector('[data-gds-reply-length]');
    const replyInitiative = runtime.overlay.querySelector('[data-gds-reply-initiative]');
    const replyTone = runtime.overlay.querySelector('[data-gds-reply-tone]');
    const replyBrief = runtime.overlay.querySelector('[data-gds-reply-brief]');
    if (replyViewpoint) replyViewpoint.value = reply.viewpoint;
    if (replyDetail) replyDetail.value = reply.detail;
    if (replyLength) replyLength.value = reply.length;
    if (replyInitiative) replyInitiative.value = reply.initiative;
    if (replyTone) replyTone.value = reply.tone;
    const replyFollow = runtime.overlay.querySelector('[data-gds-reply-follow]');
    if (replyFollow) replyFollow.checked = Boolean(reply.followDirector);
    if (replyBrief && document.activeElement !== replyBrief) replyBrief.value = reply.customInstruction;
    const replyOutput = runtime.overlay.querySelector('[data-gds-reply-output]');
    if (replyOutput && document.activeElement !== replyOutput) replyOutput.value = runtime.replyText || '';
    const replyList = runtime.overlay.querySelector('[data-gds-reply-list]');
    if (replyList) replyList.innerHTML = renderReplyCandidates(reply.lastCandidates);
    refreshSettingsEntry();
    applyFloatingAppearance();
    applyCollapsedView();
}

function applyCollapsedView() {
    const ctx = getContext();
    const settings = getSettings(ctx);
    const messages = getMessages(ctx);
    const hiddenIndexes = new Set(messages.map((message, index) => message?.extra?.gagaDogHiddenBy ? index : -1).filter(index => index >= 0));
    for (const node of document.querySelectorAll('.mes')) {
        const raw = node.getAttribute('mesid') || node.dataset?.mesid;
        const index = Number(raw);
        if (!Number.isInteger(index)) continue;
        node.classList.toggle('gds-auto-hidden', Boolean(settings.collapseHidden && hiddenIndexes.has(index)));
    }
}

function clampFloatingPosition(node, x, y) {
    const viewportWidth = Math.max(1, Number(globalThis.innerWidth || document.documentElement?.clientWidth || 1));
    const viewportHeight = Math.max(1, Number(globalThis.innerHeight || document.documentElement?.clientHeight || 1));
    const width = Math.max(1, Number(node?.offsetWidth || node?.getBoundingClientRect?.().width || 62));
    const height = Math.max(1, Number(node?.offsetHeight || node?.getBoundingClientRect?.().height || 62));
    const margin = 6;
    return {
        x: Math.round(Math.min(Math.max(margin, Number(x) || margin), Math.max(margin, viewportWidth - width - margin))),
        y: Math.round(Math.min(Math.max(margin, Number(y) || margin), Math.max(margin, viewportHeight - height - margin))),
    };
}

function placeFloating(node = runtime.floating, position = null) {
    if (!node) return null;
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) {
        for (const property of ['left', 'top', 'right', 'bottom']) node.style.removeProperty(property);
        return null;
    }
    const next = clampFloatingPosition(node, position.x, position.y);
    node.style.left = `${next.x}px`;
    node.style.top = `${next.y}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
    return next;
}

function applyFloatingPosition() {
    if (!runtime.floating || runtime.floating.classList.contains('gds-dragging')) return;
    placeFloating(runtime.floating, getSettings().floatingPosition);
}

function applyFloatingAppearance() {
    if (!runtime.floating) return;
    const settings = getSettings();
    const size = settings.floatingIconSize;
    runtime.floating.style.width = `${size}px`;
    runtime.floating.style.height = `${size}px`;
    const image = runtime.floating.querySelector('.gds-floating-image');
    if (image) image.src = settings.floatingIconData || FLOATING_LOGO_URL;
    applyFloatingPosition();
}

function persistFloatingAppearance(mutator) {
    const ctx = getContext();
    const settings = getSettings(ctx);
    mutator(settings);
    ctx.extensionSettings[SETTINGS_KEY] = settings;
    saveSettings(ctx);
    applyFloatingAppearance();
    refreshUi();
}

function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file || typeof FileReader !== 'function') {
            reject(new Error('当前环境不支持读取图片文件。'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('图片读取失败，请换一张图片重试。'));
        reader.onload = () => resolve(normalizeFloatingIconData(reader.result));
        reader.readAsDataURL(file);
    });
}

async function handleFloatingIconUpload(event) {
    const input = event.currentTarget;
    const file = input?.files?.[0];
    if (!file) return;
    if (!String(file.type || '').match(/^image\/(?:png|jpe?g|gif|webp)$/i)) {
        input.value = '';
        notify('error', '请上传 PNG、JPG、GIF 或 WebP 图片。');
        return;
    }
    if (Number(file.size || 0) > 2 * 1024 * 1024) {
        input.value = '';
        notify('error', '图片不能超过 2 MB。');
        return;
    }
    try {
        const data = await readImageAsDataUrl(file);
        if (!data) throw new Error('图片格式无法识别，请换一张图片重试。');
        persistFloatingAppearance(settings => { settings.floatingIconData = data; });
        notify('success', '悬浮窗图标已更新。');
    } catch (error) {
        notify('error', error.message || '图片读取失败。');
    } finally {
        input.value = '';
    }
}

function persistFloatingPosition(position) {
    const ctx = getContext();
    const settings = getSettings(ctx);
    settings.floatingPosition = position ? { x: position.x, y: position.y } : null;
    ctx.extensionSettings[SETTINGS_KEY] = settings;
    saveSettings(ctx);
}

function bindFloatingDrag(node) {
    let drag = null;
    let suppressClick = false;
    let suppressTimer = null;

    node.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        node.classList.add('gds-dragging');
        const rect = node.getBoundingClientRect();
        drag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            position: { x: rect.left, y: rect.top },
        };
        try { node.setPointerCapture?.(event.pointerId); } catch { /* Older WebViews may not support capture. */ }
    });

    node.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4) drag.moved = true;
        drag.position = placeFloating(node, {
            x: event.clientX - drag.offsetX,
            y: event.clientY - drag.offsetY,
        }) || drag.position;
        event.preventDefault();
    });

    const finishDrag = (event, cancelled = false) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const completed = drag;
        drag = null;
        node.classList.remove('gds-dragging');
        try { node.releasePointerCapture?.(event.pointerId); } catch { /* Capture may already be released. */ }
        if (completed.moved && !cancelled) {
            persistFloatingPosition(completed.position);
            suppressClick = true;
            clearTimeout(suppressTimer);
            suppressTimer = setTimeout(() => { suppressClick = false; }, 350);
        }
        if (cancelled) applyFloatingPosition();
        if (completed.moved) event.preventDefault();
    };
    node.addEventListener('pointerup', event => finishDrag(event, false));
    node.addEventListener('pointercancel', event => finishDrag(event, true));
    node.addEventListener('click', event => {
        if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        togglePanel(true);
    });
}

function isMobilePanelLayout() {
    return Boolean(globalThis.matchMedia?.('(max-width: 900px)')?.matches || Number(globalThis.innerWidth || 0) <= 900);
}

function clampPanelPosition(node, x, y) {
    const viewportWidth = Math.max(1, Number(globalThis.innerWidth || document.documentElement?.clientWidth || 1));
    const viewportHeight = Math.max(1, Number(globalThis.innerHeight || document.documentElement?.clientHeight || 1));
    const width = Math.max(1, Number(node?.offsetWidth || node?.getBoundingClientRect?.().width || 920));
    const height = Math.max(1, Number(node?.offsetHeight || node?.getBoundingClientRect?.().height || 700));
    const baseLeft = (viewportWidth - width) / 2;
    const baseTop = (viewportHeight - height) / 2;
    const margin = 8;
    const minX = margin - baseLeft;
    const maxX = viewportWidth - width - margin - baseLeft;
    const minY = margin - baseTop;
    const maxY = viewportHeight - height - margin - baseTop;
    return {
        x: Math.round(Math.min(Math.max(Number(x) || 0, Math.min(minX, maxX)), Math.max(minX, maxX))),
        y: Math.round(Math.min(Math.max(Number(y) || 0, Math.min(minY, maxY)), Math.max(minY, maxY))),
    };
}

function placePanel(node, position) {
    if (!node) return null;
    if (isMobilePanelLayout()) {
        node.style.setProperty('--gds-window-x', '0px');
        node.style.setProperty('--gds-window-y', '0px');
        return { x: 0, y: 0 };
    }
    const next = clampPanelPosition(node, position?.x, position?.y);
    node.style.setProperty('--gds-window-x', `${next.x}px`);
    node.style.setProperty('--gds-window-y', `${next.y}px`);
    return next;
}

function applyPanelPosition() {
    const node = runtime.overlay?.querySelector('.gds-window');
    if (!node || node.classList.contains('gds-window-dragging')) return;
    placePanel(node, getSettings().panelPosition || { x: 0, y: 0 });
}

function persistPanelPosition(position) {
    const ctx = getContext();
    const settings = getSettings(ctx);
    settings.panelPosition = position ? { x: position.x, y: position.y } : null;
    ctx.extensionSettings[SETTINGS_KEY] = settings;
    saveSettings(ctx);
}

function bindPanelDrag(node, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', event => {
        if (isMobilePanelLayout() || (event.button !== undefined && event.button !== 0)) return;
        if (event.target.closest('button,input,select,textarea,a')) return;
        const current = placePanel(node, getSettings().panelPosition || { x: 0, y: 0 }) || { x: 0, y: 0 };
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: current.x,
            originY: current.y,
            position: current,
        };
        node.classList.add('gds-window-dragging');
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* Older WebViews may not support capture. */ }
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.position = placePanel(node, {
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY,
        }) || drag.position;
        event.preventDefault();
    });
    const finish = (event, cancelled = false) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const completed = drag;
        drag = null;
        node.classList.remove('gds-window-dragging');
        try { handle.releasePointerCapture?.(event.pointerId); } catch { /* Capture may already be released. */ }
        if (cancelled) applyPanelPosition();
        else persistPanelPosition(completed.position);
        event.preventDefault();
    };
    handle.addEventListener('pointerup', event => finish(event, false));
    handle.addEventListener('pointercancel', event => finish(event, true));
}

function createUi() {
    if (runtime.overlay) return;
    const overlay = document.createElement('section');
    overlay.className = 'gds-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="gds-window">
            <header class="gds-header" title="桌面端可按住标题栏拖动">
                <div><img class="gds-puppy" src="${escapeHtml(PANEL_LOGO_URL)}" alt="" aria-hidden="true"><div><h2 data-gds-page-title>嘎嘎小狗工坊</h2><small data-gds-page-subtitle>选择一个功能开始</small></div></div>
                <button class="gds-icon-button" data-gds-close title="关闭">×</button>
            </header>
            <nav class="gds-tabs" aria-label="故事工作台功能"><button data-gds-tab="home">功能首页</button><button data-gds-tab="memory">剧情记忆</button><button data-gds-tab="director">情节导演</button><button data-gds-tab="reply">代写回复</button><button data-gds-tab="connections">模型连接</button></nav>
            <main class="gds-page-host">
                <section class="gds-home" data-gds-tab-panel="home">
                    <div class="gds-home-intro"><h3>选择要使用的功能</h3></div>
                    <div class="gds-home-grid">
                        <button class="gds-home-card" data-gds-tab="memory"><strong>剧情记忆</strong><span>总结前情、保留文风、隐藏旧正文</span></button>
                        <button class="gds-home-card" data-gds-tab="director"><strong>情节导演</strong><span>长线规划、分支、伏笔与故事日历</span></button>
                        <button class="gds-home-card" data-gds-tab="reply"><strong>代写回复</strong><span>生成多个用户回复候选并放入编辑栏</span></button>
                        <button class="gds-home-card" data-gds-tab="connections"><strong>模型连接</strong><span>分别配置三个功能使用的酒馆连接或独立 API</span></button>
                    </div>
                </section>
            <div class="gds-status" data-gds-tab-panel="memory" data-gds-status>尚未建立记忆，点击“立即总结”</div>
            <div class="gds-metrics" data-gds-tab-panel="memory" data-gds-metrics></div>
            <div class="gds-actions" data-gds-tab-panel="memory">
                <button class="gds-primary" data-gds-summarize>立即总结</button>
                <button class="gds-primary" data-gds-continue hidden>继续</button>
                <button class="gds-danger" data-gds-stop hidden>中断</button>
                <button data-gds-rebuild>恢复并重建</button>
                <button data-gds-restore>恢复隐藏</button>
            </div>
            <div class="gds-grid" data-gds-tab-panel="memory">
                <label class="gds-field gds-wide gds-stream-field"><span>当前阶段原始返回（事实 → 草稿 → 润色，不代表已保存）</span><textarea rows="6" readonly data-gds-stream-preview placeholder="每个阶段会重新显示；正常批次会自动衔接，只有中断或失败后才需要点击继续"></textarea></label>
                <label class="gds-field gds-wide"><span>总结版本</span><select data-gds-summary-mode><option value="novel">小说版：全知视角与文学表达</option><option value="structured">结构化版：事实、状态和未结事项</option><option value="mixed">混合版：文学前情＋必要记忆锚点</option></select></label>
                <label class="gds-field gds-wide"><span>当前总结成品（可编辑）</span><textarea rows="10" data-gds-summary placeholder="选择总结版本后，这里显示唯一会注入正文模型的记忆成品"></textarea><button data-gds-save-summary>保存当前总结</button></label>
                <label class="gds-field gds-wide"><span>模型实际收到的记忆注入</span><textarea rows="10" readonly data-gds-preview></textarea></label>
            </div>
            <details class="gds-details" data-gds-tab-panel="memory" open><summary>自动总结与上下文</summary>
                <div class="gds-settings-grid">
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-auto><span>自动总结</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-hide><span>总结成功后自动隐藏旧正文</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-collapse><span>在界面折叠已隐藏范围</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-stream><span>流式生成与实时显示</span></label>
                    <label>自动总结触发约 Token <input type="number" min="5000" step="5000" data-gds-trigger></label>
                    <label>保留近期消息 <input type="number" min="4" step="1" data-gds-keep></label>
                    <label>注入上限 Token <input type="number" min="160" step="100" data-gds-injection></label>
                    <label>前情目标字数 <input type="number" min="80" step="20" data-gds-words></label>
                </div>
                <p class="gds-help">手动总结会读取酒馆当前上下文容量：完整旧正文装得下就整段处理，只有装不下时才自适应拆批并在后台连续完成。自动总结仍以触发 Token 为准。只有主动中断或生成失败时才会出现“继续”。</p>
            </details>
            <details class="gds-details" data-gds-tab-panel="connections"><summary>模型连接</summary>
                <div class="gds-settings-grid gds-provider-grid">
                    <label>剧情记忆使用 <select data-gds-provider="memory"></select></label>
                    <label>情节导演使用 <select data-gds-provider="director"></select></label>
                    <label>代写回复使用 <select data-gds-provider="reply"></select></label>
                </div>
                <div class="gds-api-form">
                    <p class="gds-help">默认跟随当前酒馆。需要单独模型时，可保存一个 OpenAI 兼容连接，再分别绑定到三个模块。</p>
                    <div class="gds-settings-grid">
                        <label>连接名称 <input type="text" data-gds-api-name placeholder="例如：导演创作模型"></label>
                        <label>API URL <input type="url" data-gds-api-url placeholder="https://example.com/v1"></label>
                        <label>API Key <input type="password" data-gds-api-key autocomplete="off"></label>
                        <label>模型 <input type="text" data-gds-api-model placeholder="例如：gpt-4o-mini"></label>
                        <label>上下文 Token <input type="number" min="0" step="1024" data-gds-api-context placeholder="不知道可留空"></label>
                        <label>最大输出 Token <input type="number" min="128" step="128" data-gds-api-output value="4096"></label>
                        <label>绑定模块 <select data-gds-api-module><option value="memory">剧情记忆</option><option value="director">情节导演</option><option value="reply">代写回复</option></select></label>
                    </div>
                    <button data-gds-api-save>保存并绑定连接</button><button data-gds-api-test>测试模型列表</button>
                </div>
            </details>
            <details class="gds-details" data-gds-tab-panel="memory"><summary>检查点</summary><div data-gds-checkpoints></div></details>
            <section class="gds-tab-content" data-gds-tab-panel="director" hidden>
                <div class="gds-section-title"><div><h3>情节导演</h3><p>规划未来剧情，不会把计划自动写入已发生记忆。</p></div><div class="gds-director-task-actions"><button data-gds-director-stop hidden>停止</button><button data-gds-director-continue disabled>续写</button><button data-gds-director-restart>重新开始</button><button class="gds-danger" data-gds-director-clear>清空全部</button></div></div>
                <div class="gds-settings-grid gds-director-settings">
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-enabled><span>启用导演执行卡</span></label>
                    <label>规划风格 <select data-gds-director-preset></select></label>
                    <label>推进速度 <select data-gds-director-pacing></select></label>
                    <label>自定义推进说明 <input type="text" data-gds-director-pacing-custom placeholder="选择自定义时填写每阶段轮数和节奏"></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="mainline"><span>使用已确认主线</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="branch"><span>使用当前分支</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="pacing"><span>控制每轮推进速度</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="foreshadow"><span>使用伏笔设计</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="newCharacters"><span>允许引入新角色</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="sidePlots"><span>允许额外支线</span></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-director-toggle="autoTrack"><span>自动判断节拍进度</span></label>
                </div>
                <label class="gds-field gds-wide"><span>自定义规划要求（可写题材、必做、禁用和结局）</span><textarea rows="6" data-gds-director-brief placeholder="例如：破镜重圆，过程酸涩慢热；中期引入一名知道秘密的新角色；结局 HE，不使用失忆推动。"></textarea></label>
                <div class="gds-director-actions"><button class="gds-primary" data-gds-director-longline>生成长线规划</button><button data-gds-director-branch>生成当前分支</button><button data-gds-director-foreshadow>设计伏笔</button><button data-gds-director-save>保存导演设置</button></div>
                <label class="gds-field gds-wide"><span>导演模型原始返回／当前执行卡</span><textarea rows="8" readonly data-gds-director-output></textarea></label>
                <div class="gds-director-block"><h4>当前主线</h4><div data-gds-director-plan></div></div>
                <div class="gds-director-block"><h4>分支候选</h4><div data-gds-director-branches></div></div>
                <div class="gds-director-block"><h4>伏笔管理</h4><div data-gds-director-foreshadows></div></div>
                <div class="gds-director-block gds-calendar-block"><div class="gds-section-title"><div><h4>故事日历</h4><p>按角色卡与正文识别故事日期；提醒只提供可选背景，不会擅自改写剧情。</p></div><button data-gds-calendar-sync>从角色卡与正文同步日期</button></div>
                    <div class="gds-settings-grid gds-calendar-settings">
                        <label class="gds-toggle-row"><input type="checkbox" data-gds-calendar-enabled><span>启用故事日历</span></label>
                        <label class="gds-toggle-row"><input type="checkbox" data-gds-calendar-builtins><span>内置节日与节气</span></label>
                        <label class="gds-toggle-row"><input type="checkbox" data-gds-calendar-auto-advance><span>临近时给导演推进建议</span></label>
                        <label>提醒提前天数 <input type="number" min="0" max="30" data-gds-calendar-window></label>
                        <label>故事当前日期（留空自动读取） <input type="date" data-gds-calendar-world-date></label>
                    </div>
                    <div class="gds-calendar-add"><strong>添加自定义事件</strong><div class="gds-settings-grid"><label>名称 <input type="text" data-gds-calendar-title placeholder="纪念日、生日、生理期……"></label><label>类型 <select data-gds-calendar-kind><option value="anniversary">纪念日</option><option value="period">生理期</option><option value="birthday">生日</option><option value="deadline">剧情期限</option><option value="custom">其他</option></select></label><label>规则 <select data-gds-calendar-rule><option value="once">一次性日期</option><option value="annual">每年同日</option><option value="cycle">周期事件</option></select></label><label>日期／起始日 <input type="date" data-gds-calendar-date></label><label>周期天数 <input type="number" min="1" max="366" value="28" data-gds-calendar-cycle></label><label>持续天数 <input type="number" min="1" max="60" value="5" data-gds-calendar-duration></label></div><label class="gds-field gds-wide">剧情提示（可留空）<input type="text" data-gds-calendar-hook placeholder="例如：只在关系自然合适时提醒一次，不要强行触发"></label><button data-gds-calendar-add>添加到日历</button></div>
                    <div data-gds-calendar-output></div>
                </div>
            </section>
            <section class="gds-tab-content" data-gds-tab-panel="reply" hidden>
                <div class="gds-section-title"><div><h3>代写回复</h3><p>生成五种不同策略的用户回复，选择后放入酒馆编辑栏，不会自动发送。</p></div><button data-gds-reply-stop hidden>中断代写</button></div>
                <div class="gds-settings-grid gds-reply-settings">
                    <label>视角 <select data-gds-reply-viewpoint></select></label>
                    <label>描写密度 <select data-gds-reply-detail></select></label>
                    <label>回复长度 <select data-gds-reply-length></select></label>
                    <label>主动程度 <select data-gds-reply-initiative></select></label>
                    <label>情绪倾向 <input type="text" data-gds-reply-tone value="自然克制"></label>
                    <label class="gds-toggle-row"><input type="checkbox" data-gds-reply-follow><span>遵循当前导演分支</span></label>
                </div>
                <label class="gds-field gds-wide"><span>代写自定义要求</span><textarea rows="4" data-gds-reply-brief placeholder="例如：保持嘴硬，不要直接承认心动，但要给出愿意继续见面的暗示。"></textarea></label>
                <div class="gds-director-actions"><button class="gds-primary" data-gds-reply-generate>生成五个候选</button></div>
                <label class="gds-field gds-wide"><span>代写模型原始返回</span><textarea rows="6" readonly data-gds-reply-output></textarea></label>
                <div class="gds-reply-list" data-gds-reply-list></div>
            </section>
            </main>
            <footer class="gds-footer"><span>v${VERSION} · 提示词 ${PROMPT_VERSION}</span><span>原消息可恢复，不会自动删除</span></footer>
        </div>`;
    document.body.appendChild(overlay);
    runtime.overlay = overlay;
    populateDirectorOptions(overlay);
    populateProviderSelectors(overlay, getContext());
    setActiveTab('home');
    const windowNode = overlay.querySelector('.gds-window');
    const headerNode = overlay.querySelector('.gds-header');
    if (windowNode && headerNode) bindPanelDrag(windowNode, headerNode);

    const floating = document.createElement('button');
    floating.className = 'gds-floating';
    floating.title = DISPLAY_NAME;
    floating.innerHTML = `<img class="gds-floating-image" src="${escapeHtml(FLOATING_LOGO_URL)}" alt="" aria-hidden="true" draggable="false">`;
    document.body.appendChild(floating);
    runtime.floating = floating;
    applyFloatingAppearance();
    bindFloatingDrag(floating);

    overlay.addEventListener('click', async event => {
        const target = event.target.closest('[data-gds-tab],[data-gds-close],[data-gds-summarize],[data-gds-continue],[data-gds-stop],[data-gds-rebuild],[data-gds-restore],[data-gds-save-summary],[data-gds-api-save],[data-gds-api-test],[data-gds-director-longline],[data-gds-director-branch],[data-gds-director-foreshadow],[data-gds-director-save],[data-gds-director-lock],[data-gds-director-select-branch],[data-gds-director-stop],[data-gds-director-continue],[data-gds-director-restart],[data-gds-director-clear],[data-gds-calendar-add],[data-gds-calendar-remove],[data-gds-calendar-sync],[data-gds-reply-generate],[data-gds-reply-copy],[data-gds-reply-insert],[data-gds-reply-stop]');
        if (!target) return;
        try {
            if (target.matches('[data-gds-tab]')) {
                setActiveTab(target.dataset.gdsTab);
                return;
            }
            if (target.matches('[data-gds-close]')) togglePanel(false);
            if (target.matches('[data-gds-summarize]')) await startSummary(true);
            if (target.matches('[data-gds-continue]')) await continueSummary();
            if (target.matches('[data-gds-stop]')) stopSummary();
            if (target.matches('[data-gds-rebuild]')) await rebuildFromStart();
            if (target.matches('[data-gds-restore]')) await restoreAll();
            if (target.matches('[data-gds-save-summary]')) {
                const ctx = getContext();
                const chatState = getChatState(ctx);
                const selectedMode = overlay.querySelector('[data-gds-summary-mode]')?.value || chatState.summaryMode || 'mixed';
                const edited = overlay.querySelector('[data-gds-summary]')?.value || '';
                chatState.summaryMode = selectedMode;
                chatState.summaryArtifacts = { ...(chatState.summaryArtifacts || {}), [selectedMode]: edited };
                if (selectedMode === 'novel') chatState.summaryArtifacts.mixed = renderMixedSummary(chatState, edited);
                if (selectedMode === 'structured' && !chatState.summaryArtifacts.novel) chatState.summaryArtifacts.mixed = edited;
                chatState.recap = edited;
                setChatState(chatState, ctx);
                await applyInjection(ctx, chatState, getSettings(ctx));
                await saveChat(ctx);
                notify('success', '前情修改已保存并更新注入。');
            }
            if (target.matches('[data-gds-api-save]')) await saveApiProfileFromUi(getContext());
            if (target.matches('[data-gds-api-test]')) await testApiProfileFromUi(getContext());
            if (target.matches('[data-gds-director-save]')) {
                const ctx = getContext();
                updateDirectorFromUi(ctx);
                await saveChat(ctx);
                await updateDirectorInjection(ctx);
                notify('success', '导演设置已保存。');
            }
            if (target.matches('[data-gds-director-longline],[data-gds-director-branch],[data-gds-director-foreshadow]')) {
                const ctx = getContext();
                updateDirectorFromUi(ctx);
                await saveChat(ctx);
                const task = target.matches('[data-gds-director-longline]') ? 'longline' : target.matches('[data-gds-director-branch]') ? 'branch' : 'foreshadow';
                await runDirectorTask(ctx, task);
            }
            if (target.matches('[data-gds-director-lock]')) {
                const ctx = getContext();
                const next = lockMainline(getDirectorState(ctx));
                await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
                await updateDirectorInjection(ctx);
                notify('success', '主线已锁定。');
            }
            if (target.matches('[data-gds-director-select-branch]')) {
                const ctx = getContext();
                const next = selectBranch(getDirectorState(ctx), target.dataset.gdsDirectorSelectBranch);
                await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: next });
                await updateDirectorInjection(ctx);
                notify('success', '当前分支已采用。');
            }
            if (target.matches('[data-gds-director-stop]')) stopDirectorTask();
            if (target.matches('[data-gds-director-continue]')) await continueDirectorTask(getContext());
            if (target.matches('[data-gds-director-restart]')) await restartDirectorTask(getContext());
            if (target.matches('[data-gds-director-clear]')) await clearDirectorAll(getContext());
            if (target.matches('[data-gds-calendar-add]')) {
                const ctx = getContext();
                updateDirectorFromUi(ctx);
                await saveChatStateAndRefresh(ctx, { ...getChatState(ctx), director: addCalendarEventFromUi(ctx) });
                await updateDirectorInjection(ctx);
                notify('success', '日历事件已添加。');
            }
            if (target.matches('[data-gds-calendar-remove]')) await removeCalendarEvent(getContext(), target.dataset.gdsCalendarRemove);
            if (target.matches('[data-gds-calendar-sync]')) await syncCalendarFromStory(getContext());
            if (target.matches('[data-gds-reply-generate]')) {
                updateReplyFromUi(getContext());
                await runReplyTask(getContext());
            }
            if (target.matches('[data-gds-reply-stop]')) stopReplyTask();
            if (target.matches('[data-gds-reply-copy]') || target.matches('[data-gds-reply-insert]')) {
                const ctx = getContext();
                const candidates = getReplyState(ctx).lastCandidates;
                const item = candidates.find(candidate => candidate.id === target.dataset.gdsReplyCopy || candidate.id === target.dataset.gdsReplyInsert);
                if (item?.text) {
                    if (target.matches('[data-gds-reply-copy]')) {
                        await copyText(item.text);
                        notify('success', '候选回复已复制。');
                    } else {
                        const input = document.querySelector('#send_textarea, textarea[data-send-textarea]');
                        const append = Boolean(input?.value?.trim()) && globalThis.confirm?.('编辑栏已有内容，是否追加候选回复？');
                        insertIntoSendTextarea(item.text, append);
                        notify('success', '候选回复已放入酒馆编辑栏。');
                    }
                }
            }
        } catch (error) {
            console.error(`[${DISPLAY_NAME}] UI 操作失败`, error);
            notify('error', readableGenerationError(error));
        }
        refreshUi();
    });

    for (const input of overlay.querySelectorAll('input[data-gds-auto],input[data-gds-hide],input[data-gds-collapse],input[data-gds-stream],input[data-gds-trigger],input[data-gds-keep],input[data-gds-injection],input[data-gds-words],select[data-gds-summary-mode],select[data-gds-provider],input[data-gds-director-enabled],select[data-gds-director-preset],select[data-gds-director-pacing],input[data-gds-director-pacing-custom],input[data-gds-director-toggle],input[data-gds-calendar-enabled],input[data-gds-calendar-builtins],input[data-gds-calendar-auto-advance],input[data-gds-calendar-window],input[data-gds-calendar-world-date],input[data-gds-reply-follow],select[data-gds-reply-viewpoint],select[data-gds-reply-detail],select[data-gds-reply-length],select[data-gds-reply-initiative],input[data-gds-reply-tone]')) {
        input.addEventListener('change', () => {
            const ctx = getContext();
            const settings = getSettings(ctx);
            if (input.matches('[data-gds-auto]')) settings.autoSummarize = input.checked;
            if (input.matches('[data-gds-hide]')) settings.autoHide = input.checked;
            if (input.matches('[data-gds-collapse]')) settings.collapseHidden = input.checked;
            if (input.matches('[data-gds-stream]')) settings.streamOutput = input.checked;
            if (input.matches('[data-gds-trigger]')) settings.triggerTokens = Math.max(5000, Number(input.value) || DEFAULT_SETTINGS.triggerTokens);
            if (input.matches('[data-gds-keep]')) settings.keepMessages = Math.max(4, Number(input.value) || DEFAULT_SETTINGS.keepMessages);
            if (input.matches('[data-gds-injection]')) settings.injectionMaxTokens = Math.max(160, Number(input.value) || DEFAULT_SETTINGS.injectionMaxTokens);
            if (input.matches('[data-gds-words]')) settings.targetWords = Math.max(80, Number(input.value) || DEFAULT_SETTINGS.targetWords);
            if (input.matches('[data-gds-summary-mode]')) {
                const chatState = getChatState(ctx);
                const mode = ['novel', 'structured', 'mixed'].includes(input.value) ? input.value : 'mixed';
                chatState.summaryMode = mode;
                chatState.recap = String(chatState.summaryArtifacts?.[mode] || chatState.recap || '');
                setChatState(chatState, ctx);
                settings.summaryMode = mode;
                ctx.extensionSettings[SETTINGS_KEY] = settings;
                saveSettings(ctx);
                applyInjection(ctx, chatState, settings).catch(console.error);
                saveChat(ctx).catch(console.error);
            }
            if (input.matches('[data-gds-provider]')) {
                const moduleName = input.dataset.gdsProvider;
                if (['memory', 'director', 'reply'].includes(moduleName)) {
                    settings.moduleConnections[moduleName] = input.value || PROVIDER_CURRENT;
                    ctx.extensionSettings[SETTINGS_KEY] = settings;
                    saveSettings(ctx);
                    if (moduleName === 'director') updateDirectorInjection(ctx).catch(console.error);
                    refreshUi();
                }
            }
            if (input.matches('[data-gds-director-enabled],[data-gds-director-preset],[data-gds-director-pacing],[data-gds-director-pacing-custom],input[data-gds-director-toggle],[data-gds-calendar-enabled],[data-gds-calendar-builtins],[data-gds-calendar-auto-advance],[data-gds-calendar-window],[data-gds-calendar-world-date]')) {
                updateDirectorFromUi(ctx);
                updateDirectorInjection(ctx).catch(console.error);
                saveChat(ctx).catch(console.error);
            }
            if (input.matches('[data-gds-reply-follow],[data-gds-reply-viewpoint],[data-gds-reply-detail],[data-gds-reply-length],[data-gds-reply-initiative],[data-gds-reply-tone]')) {
                updateReplyFromUi(ctx);
                saveChat(ctx).catch(console.error);
            }
            ctx.extensionSettings[SETTINGS_KEY] = settings;
            saveSettings(ctx);
            if (!input.matches('[data-gds-director-enabled],[data-gds-director-preset],[data-gds-director-pacing],[data-gds-director-pacing-custom],input[data-gds-director-toggle],[data-gds-calendar-enabled],[data-gds-calendar-builtins],[data-gds-calendar-auto-advance],[data-gds-calendar-window],[data-gds-calendar-world-date],[data-gds-reply-follow],[data-gds-reply-viewpoint],[data-gds-reply-detail],[data-gds-reply-length],[data-gds-reply-initiative],[data-gds-reply-tone],[data-gds-provider]')) applyInjection(ctx, getChatState(ctx), settings).then(refreshUi).catch(console.error);
            else refreshUi();
        });
    }
}

function createSettingsEntry() {
    if (runtime.settingsEntry || !document.body) return;
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) return;
    const entry = document.createElement('div');
    entry.className = 'extension_container gds-settings-entry';
    entry.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${DISPLAY_NAME}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>自动压缩前情、保留剧情记忆，并在总结完成后让旧正文退出模型上下文。</p>
                <button class="menu_button gds-open-settings" type="button" data-gds-open-settings><img class="gds-entry-puppy" src="${escapeHtml(PANEL_LOGO_URL)}" alt="" aria-hidden="true"><span>打开${DISPLAY_NAME}</span></button>
                <div class="gds-floating-settings">
                    <label class="gds-floating-size"><span>悬浮窗图标大小 <output data-gds-floating-size-value>62 px</output></span><input type="range" min="32" max="120" step="1" value="62" data-gds-floating-size></label>
                    <label class="gds-floating-upload"><span>自定义悬浮窗图标</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-gds-floating-upload></label>
                    <div class="gds-floating-settings-actions"><button type="button" class="menu_button" data-gds-floating-reset>恢复默认图标</button><small>支持 PNG、JPG、GIF、WebP，单张不超过 2 MB；图片仅保存在本地酒馆设置中。</small></div>
                </div>
            </div>
        </div>`;
    host.appendChild(entry);
    entry.querySelector('[data-gds-open-settings]').addEventListener('click', () => togglePanel(true));
    const sizeInput = entry.querySelector('[data-gds-floating-size]');
    const sizeOutput = entry.querySelector('[data-gds-floating-size-value]');
    sizeInput?.addEventListener('input', () => {
        const value = Math.min(120, Math.max(32, Math.round(Number(sizeInput.value) || DEFAULT_SETTINGS.floatingIconSize)));
        if (sizeOutput) sizeOutput.value = `${value} px`;
        if (sizeOutput) sizeOutput.textContent = `${value} px`;
        persistFloatingAppearance(settings => { settings.floatingIconSize = value; });
    });
    entry.querySelector('[data-gds-floating-upload]')?.addEventListener('change', handleFloatingIconUpload);
    entry.querySelector('[data-gds-floating-reset]')?.addEventListener('click', () => {
        persistFloatingAppearance(settings => { settings.floatingIconData = ''; });
        notify('success', '已恢复默认悬浮窗图标。');
    });
    runtime.settingsEntry = entry;
    refreshSettingsEntry();
}

function refreshSettingsEntry() {
    const entry = runtime.settingsEntry;
    if (!entry) return;
    let settings;
    try { settings = getSettings(); } catch { return; }
    const sizeInput = entry.querySelector('[data-gds-floating-size]');
    const sizeOutput = entry.querySelector('[data-gds-floating-size-value]');
    if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = String(settings.floatingIconSize);
    if (sizeOutput) {
        sizeOutput.value = `${settings.floatingIconSize} px`;
        sizeOutput.textContent = `${settings.floatingIconSize} px`;
    }
}

function togglePanel(open) {
    createUi();
    runtime.open = Boolean(open);
    runtime.overlay.hidden = !runtime.open;
    document.body.classList.toggle('gds-panel-open', runtime.open);
    if (runtime.open) {
        syncMobileViewport();
        const windowNode = runtime.overlay.querySelector('.gds-window');
        if (windowNode) {
            applyPanelPosition();
            windowNode.scrollTop = 0;
            requestAnimationFrame(() => {
                applyPanelPosition();
                windowNode.scrollTop = 0;
            });
        }
        refreshUi();
    }
}

function syncMobileViewport() {
    const height = Math.round(globalThis.visualViewport?.height || globalThis.innerHeight || 0);
    if (height > 0) document.documentElement.style.setProperty('--gds-viewport-height', `${height}px`);
}

function handleViewportChange() {
    syncMobileViewport();
    applyFloatingPosition();
    if (runtime.open) applyPanelPosition();
}

function bindContextEvents() {
    const ctx = getContext();
    const source = ctx.eventSource;
    const types = ctx.eventTypes ?? ctx.event_types;
    if (!source?.on || !types) return;
    const onChat = () => {
        const chat = getMessages(ctx);
        const edge = normalizeMessages(chat);
        const signature = simpleHash(`${chat.length}|${ctx.characterId || ctx.this_chid || ''}|${edge[0]?.hash || ''}|${edge.at(-1)?.hash || ''}`);
        if (signature === runtime.lastChatSignature) return;
        runtime.lastChatSignature = signature;
        createUi();
        reconcileAndRefresh().catch(console.error);
    };
    const onMessage = () => {
        reconcileAndRefresh().catch(console.error);
    };
    const onMessageReceived = () => {
        // In some Tavern builds a failed/aborted generation does not emit
        // GENERATION_ENDED. Receiving a new assistant message is still a
        // reliable completion boundary, so release the compatibility guard.
        runtime.generating = false;
        reconcileAndRefresh().catch(console.error);
    };
    const bindings = {
        CHAT_CHANGED: onChat,
        MESSAGE_RECEIVED: onMessageReceived,
        MESSAGE_SENT: onMessage,
        MESSAGE_EDITED: onMessage,
        MESSAGE_SWIPED: onMessage,
        MESSAGE_DELETED: onMessage,
        GENERATION_AFTER_COMMANDS: (type, options, dryRun) => prepareDirectorForGeneration(ctx, type, options, dryRun),
        GENERATION_ENDED: () => {
            runtime.generating = false;
            refreshUi();
            trackDirectorProgress(ctx).catch(error => console.warn(`[${DISPLAY_NAME}] 导演进度跟踪失败`, error));
            scheduleAutoSummary(1800);
        },
        GENERATION_STOPPED: () => { runtime.generating = false; refreshUi(); },
        GENERATION_STARTED: () => { runtime.generating = true; },
    };
    for (const [name, handler] of Object.entries(bindings)) if (types[name]) source.on(types[name], handler);
}

export async function init() {
    try {
        const ctx = getContext();
        getSettings(ctx);
        createUi();
        createSettingsEntry();
        bindContextEvents();
        handleViewportChange();
        globalThis.visualViewport?.addEventListener?.('resize', handleViewportChange);
        globalThis.addEventListener?.('resize', handleViewportChange);
        globalThis.addEventListener?.('orientationchange', handleViewportChange);
        await reconcileAndRefresh();
        const settings = getSettings(ctx);
        if (runtime.floating) runtime.floating.hidden = !settings.showFloatingButton;
        console.info(`[${DISPLAY_NAME}] v${VERSION} 已加载`);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 初始化失败`, error);
        notify('error', String(error?.message || error));
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(), { once: true });
else init();
