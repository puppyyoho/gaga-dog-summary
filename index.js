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
    rangeStillMatches,
    selectStyleAnchors,
    simpleHash,
    tokenEstimate,
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
import { generateWithFallback, readableGenerationError } from './generation-client.js';

const EXTENSION_NAME = 'gaga-dog-summary';
const DISPLAY_NAME = '嘎嘎小狗总结';
const SETTINGS_KEY = 'gagaDogSummary';
const INJECTION_ID = `${EXTENSION_NAME}:memory`;
const PANEL_LOGO_URL = new URL('./assets/gaga-dog-logo.png', import.meta.url).href;
const FLOATING_LOGO_URL = new URL('./assets/gaga-dog-floating.png', import.meta.url).href;
const VERSION = '0.1.14';
const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
    showFloatingButton: true,
    autoSummarize: true,
    autoHide: true,
    collapseHidden: true,
    triggerTokens: 60000,
    keepMessages: 10,
    manualKeepMessages: 4,
    injectionMaxTokens: 1400,
    recallLimit: 3,
    targetWords: 520,
    injectionMode: 'balanced',
    streamOutput: true,
    autoAudit: false,
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
    generating: false,
    lastChatSignature: '',
    lastError: '',
    lastSuccess: '',
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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
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
    for (const key of ['triggerTokens', 'keepMessages', 'manualKeepMessages', 'injectionMaxTokens', 'recallLimit', 'targetWords']) {
        const value = Number(result[key]);
        result[key] = Number.isFinite(value) ? Math.max(1, Math.round(value)) : DEFAULT_SETTINGS[key];
    }
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
    setStatus(`正在生成${stageName(runtime.activeStage)}${source}${chunks} · ${runtime.streamText.length} 字符`);
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
            if (meta.phase === 'connecting') setStatus(`正在连接${meta.source || '当前酒馆模型'}，准备生成${stageName(pending.stage)}……`);
            if (meta.phase === 'fallback') setStatus(`直接流式通道未完成，正在尝试兼容通道：${meta.reason}`);
        },
    });
}

async function summarizeRange(ctx, range, settings, reason = 'manual', resumeTask = null) {
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
        createdAt: Date.now(),
    };
    pending.range = clone(range);
    pending.checkpointId = checkpointId;
    pending.reason ||= reason;
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
        const factsForProse = renderFactsForProse(draft);
        const styleText = styleAnchors.map(anchor => `[消息 ${anchor.index}]\n${anchor.text}`).join('\n\n');
        let proseDraft = cleanProse(pending.proseDraft);
        if (pending.stage !== 'polish' || !proseDraft) {
            pending.stage = 'prose';
            const prosePrompt = buildProsePrompt({
                facts: factsForProse,
                currentState: formatState(draft),
                openThreads: formatThreads(draft),
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
            styleAnchors: styleText,
            targetWords: settings.targetWords,
            customPrompts: settings.prompts,
        });
        const polishResult = await runGenerationStage(ctx, polishPrompt, settings, pending, controller);
        if (serial !== runtime.taskSerial || controller.signal.aborted) throw controller.signal.reason || new DOMException('已中断生成', 'AbortError');
        if (runtime.abortController === controller) runtime.abortController = null;
        setStatus('文学润色完成，正在校验并保存记忆……');
        refreshUi();
        const polishedProse = cleanProse(polishResult.text);
        if (!polishedProse) throw new Error('文学润色结果为空，尚不能提交记忆');
        draft.recap = polishedProse;
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
        runtime.lastSuccess = `已保存检查点 · 消息 ${range.start}–${range.end}`;
        notify('success', `已总结消息 ${range.start}–${range.end}${settings.autoHide ? '，旧正文已退出上下文' : ''}。`);
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
        if (!runtime.lastError && !getChatState(ctx).pending) scheduleAutoSummary(1200);
    }
}

async function applyInjection(ctx = getContext(), chatState = getChatState(ctx), settings = getSettings(ctx)) {
    const messages = getMessages(ctx);
    if (!chatState.enabled) {
        if (typeof ctx.setExtensionPrompt === 'function') await ctx.setExtensionPrompt(INJECTION_ID, '', 1, 0, false, 0);
        return '';
    }
    const query = recentQuery(messages);
    const injection = compileInjection(chatState, {
        query,
        maxTokens: settings.injectionMaxTokens,
        recallLimit: settings.recallLimit,
        mode: settings.injectionMode,
    });
    chatState.lastInjection = injection;
    chatState.lastInjectionTokens = tokenEstimate(injection);
    if (typeof ctx.setExtensionPrompt === 'function') {
        await ctx.setExtensionPrompt(INJECTION_ID, injection, 1, 0, false, 0);
    }
    setChatState(chatState, ctx);
    return injection;
}

function planRange(ctx, manual = false) {
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    const options = {
        keepMessages: manual ? settings.manualKeepMessages : settings.keepMessages,
        targetTokens: settings.triggerTokens,
    };
    return rangeForNewSummary(getMessages(ctx), chatState, options);
}

function shouldAutoSummarize(ctx) {
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    if (!settings.autoSummarize || !chatState.enabled || chatState.pending || runtime.busy || runtime.generating) return false;
    const range = planRange(ctx, false);
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
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    if (chatState.pending) {
        if (manual) notify('info', '已有未完成的总结，请点击“继续”恢复，或点击“恢复并重建”放弃它。');
        return;
    }
    const range = planRange(ctx, manual);
    if (!range) {
        notify('info', manual ? '目前没有足够的旧正文可总结；请保留一些近期消息后再试。' : '尚未达到自动总结阈值。');
        return;
    }
    await summarizeRange(ctx, range, settings, manual ? 'manual' : 'auto');
}

async function continueSummary() {
    if (runtime.busy) return;
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
    await summarizeRange(ctx, pending.range, getSettings(ctx), pending.reason || 'continued', pending);
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
    const fresh = normalizeChatState({ enabled: old.enabled, autoSummarize: old.autoSummarize, autoHide: old.autoHide });
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

function savedRecap(chatState) {
    const direct = String(chatState?.recap || '').trim();
    if (direct) return direct;
    const latest = [...(chatState?.checkpoints || [])]
        .reverse()
        .find(item => item.status === 'committed' && String(item.recap || '').trim());
    return String(latest?.recap || '').trim();
}

function refreshUi() {
    if (!runtime.overlay) return;
    const ctx = getContext();
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    const messages = getMessages(ctx);
    const summary = runtime.overlay.querySelector('[data-gds-summary]');
    const preview = runtime.overlay.querySelector('[data-gds-preview]');
    const streamPreview = runtime.overlay.querySelector('[data-gds-stream-preview]');
    const recap = savedRecap(chatState);
    if (recap && !chatState.recap.trim()) {
        chatState.recap = recap;
        setChatState(chatState, ctx);
        saveChat(ctx).catch(error => console.warn(`[${DISPLAY_NAME}] 检查点前情回填保存失败`, error));
    }
    if (summary && (document.activeElement !== summary || !summary.value.trim())) summary.value = recap;
    if (streamPreview && document.activeElement !== streamPreview) {
        streamPreview.value = runtime.streamText || chatState.pending?.partialText || '';
    }
    if (preview) preview.value = compileInjection(chatState, {
        query: recentQuery(messages),
        maxTokens: settings.injectionMaxTokens,
        recallLimit: settings.recallLimit,
        mode: settings.injectionMode,
    });
    const metrics = runtime.overlay.querySelector('[data-gds-metrics]');
    if (metrics) metrics.innerHTML = `
        <span>场景 ${chatState.sceneCards.length}</span>
        <span>事实 ${chatState.facts.length}</span>
        <span>未结 ${chatState.threads.filter(item => item.status === 'open').length}</span>
        <span>检查点 ${chatState.checkpoints.length}</span>
        <span>注入约 ${chatState.lastInjectionTokens || tokenEstimate(chatState.lastInjection || '')} Token</span>`;
    const status = runtime.overlay.querySelector('[data-gds-status]');
    if (status && !runtime.busy) {
        const hasCheckpoint = chatState.checkpoints.some(item => item.status === 'committed');
        const recapMissing = hasCheckpoint && !recap;
        const orphanOutput = Boolean(runtime.streamText.trim() && !hasCheckpoint && !chatState.pending);
        if (chatState.pending) status.textContent = `总结未完成：${stageName(chatState.pending.stage)}，请点击“继续”`;
        else if (runtime.lastError) status.textContent = `未保存：${runtime.lastError}`;
        else if (recapMissing) status.textContent = '检查点已保存，但文学前情为空，请点击“恢复并重建”';
        else if (orphanOutput) status.textContent = '收到模型文本，但尚未保存成记忆，请重新总结';
        else if (runtime.lastSuccess) status.textContent = runtime.lastSuccess;
        else status.textContent = hasCheckpoint ? '记忆已保存并正在注入' : '尚未建立记忆，点击“立即总结”';
    }
    const summarize = runtime.overlay.querySelector('[data-gds-summarize]');
    const resume = runtime.overlay.querySelector('[data-gds-continue]');
    const stop = runtime.overlay.querySelector('[data-gds-stop]');
    const rebuild = runtime.overlay.querySelector('[data-gds-rebuild]');
    const restore = runtime.overlay.querySelector('[data-gds-restore]');
    if (summarize) summarize.disabled = runtime.busy || Boolean(chatState.pending);
    if (resume) {
        resume.hidden = runtime.busy || !chatState.pending;
        resume.disabled = runtime.busy;
    }
    if (stop) stop.hidden = !runtime.busy || !runtime.abortController;
    if (rebuild) rebuild.disabled = runtime.busy;
    if (restore) restore.disabled = runtime.busy;
    const list = runtime.overlay.querySelector('[data-gds-checkpoints]');
    if (list) list.innerHTML = renderCheckpointList(chatState);
    const auto = runtime.overlay.querySelector('[data-gds-auto]');
    const hide = runtime.overlay.querySelector('[data-gds-hide]');
    const collapse = runtime.overlay.querySelector('[data-gds-collapse]');
    const stream = runtime.overlay.querySelector('[data-gds-stream]');
    const mode = runtime.overlay.querySelector('[data-gds-mode]');
    if (auto) auto.checked = Boolean(settings.autoSummarize);
    if (hide) hide.checked = Boolean(settings.autoHide);
    if (collapse) collapse.checked = Boolean(settings.collapseHidden);
    if (stream) stream.checked = settings.streamOutput !== false;
    if (mode) mode.value = settings.injectionMode;
    for (const [selector, value] of [
        ['[data-gds-trigger]', settings.triggerTokens],
        ['[data-gds-keep]', settings.keepMessages],
        ['[data-gds-injection]', settings.injectionMaxTokens],
        ['[data-gds-words]', settings.targetWords],
    ]) {
        const input = runtime.overlay.querySelector(selector);
        if (input && document.activeElement !== input) input.value = value;
    }
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

function createUi() {
    if (runtime.overlay) return;
    const overlay = document.createElement('section');
    overlay.className = 'gds-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="gds-window">
            <header class="gds-header">
                <div><img class="gds-puppy" src="${escapeHtml(PANEL_LOGO_URL)}" alt="" aria-hidden="true"><div><h2>嘎嘎小狗总结</h2><small>剧情记忆 · 文风继承 · 自动隐藏</small></div></div>
                <button class="gds-icon-button" data-gds-close title="关闭">×</button>
            </header>
            <div class="gds-status" data-gds-status>尚未建立记忆，点击“立即总结”</div>
            <div class="gds-metrics" data-gds-metrics></div>
            <div class="gds-actions">
                <button class="gds-primary" data-gds-summarize>立即总结</button>
                <button class="gds-primary" data-gds-continue hidden>继续</button>
                <button class="gds-danger" data-gds-stop hidden>中断</button>
                <button data-gds-rebuild>恢复并重建</button>
                <button data-gds-restore>恢复隐藏</button>
            </div>
            <div class="gds-grid">
                <label class="gds-field gds-wide gds-stream-field"><span>当前阶段原始返回（事实 → 草稿 → 润色，不代表已保存）</span><textarea rows="6" readonly data-gds-stream-preview placeholder="每个阶段会重新显示；只有出现已保存检查点才算完成，中断后可点击继续"></textarea></label>
                <label class="gds-field gds-wide"><span>文学版前情（可编辑）</span><textarea rows="8" data-gds-summary placeholder="总结后会在这里显示有文笔的前情回顾"></textarea><button data-gds-save-summary>保存前情修改</button></label>
                <label class="gds-field gds-wide"><span>模型实际收到的记忆注入</span><textarea rows="10" readonly data-gds-preview></textarea></label>
            </div>
            <details class="gds-details" open><summary>自动总结与上下文</summary>
                <div class="gds-settings-grid">
                    <label class="gds-toggle-row"><span>自动总结</span><input type="checkbox" data-gds-auto></label>
                    <label class="gds-toggle-row"><span>总结成功后自动隐藏旧正文</span><input type="checkbox" data-gds-hide></label>
                    <label class="gds-toggle-row"><span>在界面折叠已隐藏范围</span><input type="checkbox" data-gds-collapse></label>
                    <label class="gds-toggle-row"><span>流式生成与实时显示</span><input type="checkbox" data-gds-stream></label>
                    <label>每批总结约 Token <input type="number" min="5000" step="5000" data-gds-trigger></label>
                    <label>保留近期消息 <input type="number" min="4" step="1" data-gds-keep></label>
                    <label>注入上限 Token <input type="number" min="160" step="100" data-gds-injection></label>
                    <label>前情目标字数 <input type="number" min="80" step="20" data-gds-words></label>
                    <label>注入模式 <select data-gds-mode><option value="safe">安全：只发事实</option><option value="balanced">平衡：事实与前情</option></select></label>
                </div>
                <p class="gds-help">酒馆消息索引从 0 开始；自动隐藏使用 /hide，点击恢复隐藏使用 /unhide。设置的保留条数只保护最新消息，不会参与本批总结。</p>
            </details>
            <details class="gds-details"><summary>检查点</summary><div data-gds-checkpoints></div></details>
            <footer class="gds-footer"><span>v${VERSION} · 提示词 ${PROMPT_VERSION}</span><span>原消息可恢复，不会自动删除</span></footer>
        </div>`;
    document.body.appendChild(overlay);
    runtime.overlay = overlay;

    const floating = document.createElement('button');
    floating.className = 'gds-floating';
    floating.title = DISPLAY_NAME;
    floating.innerHTML = `<img class="gds-floating-image" src="${escapeHtml(FLOATING_LOGO_URL)}" alt="" aria-hidden="true">`;
    document.body.appendChild(floating);
    runtime.floating = floating;
    floating.addEventListener('click', () => togglePanel(true));

    overlay.addEventListener('click', async event => {
        const target = event.target.closest('[data-gds-close],[data-gds-summarize],[data-gds-continue],[data-gds-stop],[data-gds-rebuild],[data-gds-restore],[data-gds-save-summary]');
        if (!target) return;
        try {
            if (target.matches('[data-gds-close]')) togglePanel(false);
            if (target.matches('[data-gds-summarize]')) await startSummary(true);
            if (target.matches('[data-gds-continue]')) await continueSummary();
            if (target.matches('[data-gds-stop]')) stopSummary();
            if (target.matches('[data-gds-rebuild]')) await rebuildFromStart();
            if (target.matches('[data-gds-restore]')) await restoreAll();
            if (target.matches('[data-gds-save-summary]')) {
                const ctx = getContext();
                const chatState = getChatState(ctx);
                chatState.recap = overlay.querySelector('[data-gds-summary]')?.value || '';
                setChatState(chatState, ctx);
                await applyInjection(ctx, chatState, getSettings(ctx));
                await saveChat(ctx);
                notify('success', '前情修改已保存并更新注入。');
            }
        } catch (error) { console.error(`[${DISPLAY_NAME}] UI 操作失败`, error); }
        refreshUi();
    });

    for (const input of overlay.querySelectorAll('input[data-gds-auto],input[data-gds-hide],input[data-gds-collapse],input[data-gds-stream],input[data-gds-trigger],input[data-gds-keep],input[data-gds-injection],input[data-gds-words],select[data-gds-mode]')) {
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
            if (input.matches('[data-gds-mode]')) settings.injectionMode = input.value === 'safe' ? 'safe' : 'balanced';
            ctx.extensionSettings[SETTINGS_KEY] = settings;
            saveSettings(ctx);
            applyInjection(ctx, getChatState(ctx), settings).then(refreshUi).catch(console.error);
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
            </div>
        </div>`;
    host.appendChild(entry);
    entry.querySelector('[data-gds-open-settings]').addEventListener('click', () => togglePanel(true));
    runtime.settingsEntry = entry;
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
            windowNode.scrollTop = 0;
            requestAnimationFrame(() => { windowNode.scrollTop = 0; });
        }
        refreshUi();
    }
}

function syncMobileViewport() {
    const height = Math.round(globalThis.visualViewport?.height || globalThis.innerHeight || 0);
    if (height > 0) document.documentElement.style.setProperty('--gds-viewport-height', `${height}px`);
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
    const bindings = {
        CHAT_CHANGED: onChat,
        MESSAGE_RECEIVED: onMessage,
        MESSAGE_SENT: onMessage,
        MESSAGE_EDITED: onMessage,
        MESSAGE_SWIPED: onMessage,
        MESSAGE_DELETED: onMessage,
        GENERATION_ENDED: () => { runtime.generating = false; scheduleAutoSummary(1500); },
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
        syncMobileViewport();
        globalThis.visualViewport?.addEventListener?.('resize', syncMobileViewport);
        globalThis.addEventListener?.('orientationchange', syncMobileViewport);
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
