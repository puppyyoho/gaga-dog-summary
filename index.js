import {
    clone,
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
import {
    buildAuditPrompt,
    buildFactPrompt,
    buildProsePrompt,
    DEFAULT_PROMPTS,
    defaultJsonSchema,
    PROMPT_VERSION,
    renderFactsForProse,
} from './prompts.js';

const EXTENSION_NAME = 'gaga-dog-summary';
const DISPLAY_NAME = '嘎嘎小狗总结';
const SETTINGS_KEY = 'gagaDogSummary';
const INJECTION_ID = `${EXTENSION_NAME}:memory`;
const VERSION = '0.1.0';

const DEFAULT_SETTINGS = {
    showFloatingButton: true,
    autoSummarize: true,
    autoHide: true,
    collapseHidden: true,
    triggerTokens: 1800,
    keepMessages: 10,
    manualKeepMessages: 4,
    injectionMaxTokens: 1400,
    recallLimit: 3,
    targetWords: 520,
    injectionMode: 'balanced',
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
    generating: false,
    lastChatSignature: '',
    lastError: '',
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
    result.prompts = { ...DEFAULT_PROMPTS, ...(current?.prompts && typeof current.prompts === 'object' ? current.prompts : {}) };
    for (const key of ['triggerTokens', 'keepMessages', 'manualKeepMessages', 'injectionMaxTokens', 'recallLimit', 'targetWords']) {
        const value = Number(result[key]);
        result[key] = Number.isFinite(value) ? Math.max(1, Math.round(value)) : DEFAULT_SETTINGS[key];
    }
    ctx.extensionSettings[SETTINGS_KEY] = result;
    return result;
}

function saveSettings(ctx = getContext()) {
    try { ctx.saveSettingsDebounced?.(); } catch (error) { console.warn(`[${DISPLAY_NAME}] 设置保存失败`, error); }
}

function getChatState(ctx = getContext()) {
    ctx.chat_metadata ??= {};
    return normalizeChatState(ctx.chat_metadata[SETTINGS_KEY]);
}

function setChatState(value, ctx = getContext()) {
    ctx.chat_metadata ??= {};
    ctx.chat_metadata[SETTINGS_KEY] = normalizeChatState(value);
}

async function saveChat(ctx = getContext()) {
    try {
        if (typeof ctx.saveChat === 'function') await ctx.saveChat();
        else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
        else if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 聊天保存失败`, error);
        throw error;
    }
}

function formatMessages(messages, start = 0, end = messages.length - 1) {
    return normalizeMessages(messages.slice(start, end + 1)).map(item => (
        `[消息 ${item.index + start}｜${item.name}]\n${item.content}`
    )).join('\n\n');
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

function hideRange(ctx, range, checkpointId) {
    const messages = getMessages(ctx);
    const hidden = [];
    for (const ref of range?.refs || []) {
        const located = locateMessage(messages, ref);
        const message = located?.message;
        if (!message || message.is_system || message.extra?.gagaDogHiddenBy) continue;
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.gagaDogHiddenBy = checkpointId;
        message.extra.gagaDogHadSystemField = Object.prototype.hasOwnProperty.call(message, 'is_system');
        message.extra.gagaDogOriginalSystem = Boolean(message.is_system);
        message.is_system = true;
        hidden.push({ index: located.index, key: located.item.key, checkpointId });
    }
    return hidden;
}

function restoreOwnedMessages(ctx, checkpointIds = null) {
    const ids = checkpointIds ? new Set(checkpointIds) : null;
    let restored = 0;
    for (const message of getMessages(ctx)) {
        const extra = message?.extra;
        const owner = extra?.gagaDogHiddenBy;
        if (!owner || (ids && !ids.has(owner))) continue;
        if (extra.gagaDogHadSystemField) message.is_system = Boolean(extra.gagaDogOriginalSystem);
        else delete message.is_system;
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

function invalidateIfNeeded(ctx, chatState) {
    const messages = getMessages(ctx);
    const checkpoints = Array.isArray(chatState.checkpoints) ? chatState.checkpoints : [];
    const brokenIndex = checkpoints.findIndex(checkpoint => checkpoint.range && !rangeStillMatches(messages, checkpoint.range));
    if (brokenIndex < 0) return { state: chatState, changed: false };
    const affected = checkpoints.slice(brokenIndex);
    restoreOwnedMessages(ctx, affected.map(item => item.id));
    const previous = checkpoints[brokenIndex - 1];
    const next = restoreSnapshot(chatState, previous?.memorySnapshot);
    next.checkpoints = checkpoints.slice(0, brokenIndex);
    next.sceneCards = next.sceneCards.filter(card => next.checkpoints.some(cp => cp.sceneCardId === card.id));
    next.hiddenRanges = (next.hiddenRanges || []).filter(item => next.checkpoints.some(cp => cp.id === item.checkpointId));
    next.pending = null;
    setChatState(next, ctx);
    return { state: next, changed: true, affected: affected.length };
}

async function generateRaw(ctx, request) {
    if (typeof ctx.generateRaw !== 'function') throw new Error('当前 SillyTavern 没有可用的 generateRaw()。');
    const result = await ctx.generateRaw(request);
    const text = typeof result === 'string' ? result : result?.text || result?.content || '';
    if (!String(text).trim()) throw new Error('模型返回了空内容。');
    return String(text);
}

async function generateQuiet(ctx, request) {
    const combined = [request.systemPrompt, request.prompt].filter(Boolean).join('\n\n');
    if (typeof ctx.generateQuietPrompt === 'function') {
        const result = await ctx.generateQuietPrompt({ quietPrompt: combined });
        const text = typeof result === 'string' ? result : result?.text || result?.content || '';
        if (String(text).trim()) return String(text);
    }
    return generateRaw(ctx, { systemPrompt: request.systemPrompt, prompt: request.prompt });
}

function cleanProse(value) {
    return String(value || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
}

async function summarizeRange(ctx, range, settings, reason = 'manual') {
    if (runtime.busy) throw new Error('已有总结任务正在运行。');
    runtime.busy = true;
    runtime.taskSerial += 1;
    const serial = runtime.taskSerial;
    const messages = getMessages(ctx);
    const before = getChatState(ctx);
    const checkpointId = `cp_${Date.now()}_${simpleHash(`${range.start}:${range.end}:${range.rangeHash}`)}`;
    try {
        const sourceText = formatMessages(messages, range.start, range.end);
        if (!sourceText.trim()) throw new Error('待总结范围没有可用正文。');
        const factPrompt = buildFactPrompt({
            messages: sourceText,
            currentState: formatState(before),
            openThreads: formatThreads(before),
            customPrompts: settings.prompts,
        });
        setStatus('正在提取事实与状态……');
        let rawPacket;
        try {
            rawPacket = await generateRaw(ctx, { ...factPrompt, jsonSchema: defaultJsonSchema() });
        } catch (schemaError) {
            console.warn(`[${DISPLAY_NAME}] 结构化输出不可用，回退普通 JSON`, schemaError);
            rawPacket = await generateRaw(ctx, factPrompt);
        }
        if (serial !== runtime.taskSerial) throw new Error('总结任务已取消。');
        let packet;
        try {
            packet = parseModelPacket(rawPacket);
        } catch (error) {
            rawPacket = await generateRaw(ctx, factPrompt);
            packet = parseModelPacket(rawPacket);
        }

        const draft = mergeMemoryPacket(before, packet, range, checkpointId);
        const styleAnchors = selectStyleAnchors(messages, 3, { includeHidden: true });
        const prosePrompt = buildProsePrompt({
            facts: renderFactsForProse(draft),
            currentState: formatState(draft),
            openThreads: formatThreads(draft),
            styleAnchors: styleAnchors.map(anchor => `[消息 ${anchor.index}]\n${anchor.text}`).join('\n\n'),
            targetWords: settings.targetWords,
            customPrompts: settings.prompts,
        });
        setStatus('正在按原正文文风编写前情……');
        let prose = '';
        try { prose = cleanProse(await generateQuiet(ctx, prosePrompt)); } catch (error) {
            console.warn(`[${DISPLAY_NAME}] 文学前情生成失败，将使用事实回顾`, error);
        }
        if (serial !== runtime.taskSerial) throw new Error('总结任务已取消。');
        draft.recap = prose || cleanProse(packet.recap) || before.recap;
        draft.styleAnchors = styleAnchors;
        const checkpoint = draft.checkpoints.find(item => item.id === checkpointId);
        if (checkpoint) {
            checkpoint.recap = draft.recap;
            checkpoint.promptVersion = PROMPT_VERSION;
            checkpoint.reason = reason;
            checkpoint.memorySnapshot = snapshotMemory(draft);
            checkpoint.beforeSnapshot = snapshotMemory(before);
        }
        draft.pending = null;
        setChatState(draft, ctx);
        await applyInjection(ctx, draft, settings);
        await saveChat(ctx);

        if (settings.autoHide) {
            const hidden = hideRange(ctx, range, checkpointId);
            draft.hiddenRanges.push({ checkpointId, range, hidden, createdAt: Date.now() });
            if (checkpoint) checkpoint.hiddenCount = hidden.length;
            setChatState(draft, ctx);
            await saveChat(ctx);
        }
        notify('success', `已总结消息 ${range.start}–${range.end}${settings.autoHide ? '，旧正文已退出上下文' : ''}。`);
        return draft;
    } catch (error) {
        runtime.lastError = String(error?.message || error);
        notify('error', runtime.lastError);
        throw error;
    } finally {
        runtime.busy = false;
        setStatus('');
        refreshUi();
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
    const options = { keepMessages: manual ? settings.manualKeepMessages : settings.keepMessages };
    return rangeForNewSummary(getMessages(ctx), chatState, options);
}

function shouldAutoSummarize(ctx) {
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    if (!settings.autoSummarize || !chatState.enabled || runtime.busy || runtime.generating) return false;
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
    const range = planRange(ctx, manual);
    if (!range) {
        notify('info', manual ? '目前没有足够的旧正文可总结；请保留一些近期消息后再试。' : '尚未达到自动总结阈值。');
        return;
    }
    await summarizeRange(ctx, range, settings, manual ? 'manual' : 'auto');
}

async function restoreAll() {
    const ctx = getContext();
    const count = restoreOwnedMessages(ctx);
    const chatState = getChatState(ctx);
    chatState.hiddenRanges = [];
    setChatState(chatState, ctx);
    await saveChat(ctx);
    await applyInjection(ctx, chatState, getSettings(ctx));
    refreshUi();
    notify('success', count ? `已恢复 ${count} 条由插件隐藏的消息。` : '没有需要恢复的插件隐藏消息。');
}

async function rebuildFromStart() {
    const ctx = getContext();
    const old = getChatState(ctx);
    restoreOwnedMessages(ctx);
    const fresh = normalizeChatState({ enabled: old.enabled, autoSummarize: old.autoSummarize, autoHide: old.autoHide });
    setChatState(fresh, ctx);
    await saveChat(ctx);
    await applyInjection(ctx, fresh, getSettings(ctx));
    refreshUi();
    notify('info', '已恢复原文并清空当前检查点。点击“立即总结”重新建立记忆。');
}

async function reconcileAndRefresh() {
    try {
        const ctx = getContext();
        const current = getChatState(ctx);
        const result = invalidateIfNeeded(ctx, current);
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

function refreshUi() {
    if (!runtime.overlay) return;
    const ctx = getContext();
    const settings = getSettings(ctx);
    const chatState = getChatState(ctx);
    const messages = getMessages(ctx);
    const summary = runtime.overlay.querySelector('[data-gds-summary]');
    const preview = runtime.overlay.querySelector('[data-gds-preview]');
    if (summary && document.activeElement !== summary) summary.value = chatState.recap || '';
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
    if (status && !runtime.busy) status.textContent = runtime.lastError ? `上次任务：${runtime.lastError}` : '已就绪';
    const list = runtime.overlay.querySelector('[data-gds-checkpoints]');
    if (list) list.innerHTML = renderCheckpointList(chatState);
    const auto = runtime.overlay.querySelector('[data-gds-auto]');
    const hide = runtime.overlay.querySelector('[data-gds-hide]');
    const collapse = runtime.overlay.querySelector('[data-gds-collapse]');
    const mode = runtime.overlay.querySelector('[data-gds-mode]');
    if (auto) auto.checked = Boolean(settings.autoSummarize);
    if (hide) hide.checked = Boolean(settings.autoHide);
    if (collapse) collapse.checked = Boolean(settings.collapseHidden);
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
                <div><span class="gds-puppy">🐶</span><div><h2>嘎嘎小狗总结</h2><small>剧情记忆 · 文风继承 · 自动隐藏</small></div></div>
                <button class="gds-icon-button" data-gds-close title="关闭">×</button>
            </header>
            <div class="gds-status" data-gds-status>已就绪</div>
            <div class="gds-metrics" data-gds-metrics></div>
            <div class="gds-actions">
                <button class="gds-primary" data-gds-summarize>立即总结</button>
                <button data-gds-rebuild>恢复并重建</button>
                <button data-gds-restore>恢复隐藏</button>
            </div>
            <div class="gds-grid">
                <label class="gds-field gds-wide"><span>文学版前情（可编辑）</span><textarea rows="8" data-gds-summary placeholder="总结后会在这里显示有文笔的前情回顾"></textarea><button data-gds-save-summary>保存前情修改</button></label>
                <label class="gds-field gds-wide"><span>模型实际收到的记忆注入</span><textarea rows="10" readonly data-gds-preview></textarea></label>
            </div>
            <details class="gds-details" open><summary>自动总结与上下文</summary>
                <div class="gds-settings-grid">
                    <label><input type="checkbox" data-gds-auto> 自动总结</label>
                    <label><input type="checkbox" data-gds-hide> 总结成功后自动隐藏旧正文</label>
                    <label><input type="checkbox" data-gds-collapse> 在界面折叠已隐藏范围</label>
                    <label>触发 Token <input type="number" min="200" step="100" data-gds-trigger></label>
                    <label>保留近期消息 <input type="number" min="4" step="1" data-gds-keep></label>
                    <label>注入上限 Token <input type="number" min="160" step="100" data-gds-injection></label>
                    <label>前情目标字数 <input type="number" min="80" step="20" data-gds-words></label>
                    <label>注入模式 <select data-gds-mode><option value="safe">安全：只发事实</option><option value="balanced">平衡：事实与前情</option></select></label>
                </div>
            </details>
            <details class="gds-details"><summary>检查点</summary><div data-gds-checkpoints></div></details>
            <footer class="gds-footer"><span>v${VERSION} · 提示词 ${PROMPT_VERSION}</span><span>原消息可恢复，不会自动删除</span></footer>
        </div>`;
    document.body.appendChild(overlay);
    runtime.overlay = overlay;

    const floating = document.createElement('button');
    floating.className = 'gds-floating';
    floating.title = DISPLAY_NAME;
    floating.textContent = '🐶';
    document.body.appendChild(floating);
    runtime.floating = floating;
    floating.addEventListener('click', () => togglePanel(true));

    overlay.addEventListener('click', async event => {
        const target = event.target.closest('[data-gds-close],[data-gds-summarize],[data-gds-rebuild],[data-gds-restore],[data-gds-save-summary]');
        if (!target) return;
        try {
            if (target.matches('[data-gds-close]')) togglePanel(false);
            if (target.matches('[data-gds-summarize]')) await startSummary(true);
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

    for (const input of overlay.querySelectorAll('input[data-gds-auto],input[data-gds-hide],input[data-gds-collapse],input[data-gds-trigger],input[data-gds-keep],input[data-gds-injection],input[data-gds-words],select[data-gds-mode]')) {
        input.addEventListener('change', () => {
            const ctx = getContext();
            const settings = getSettings(ctx);
            if (input.matches('[data-gds-auto]')) settings.autoSummarize = input.checked;
            if (input.matches('[data-gds-hide]')) settings.autoHide = input.checked;
            if (input.matches('[data-gds-collapse]')) settings.collapseHidden = input.checked;
            if (input.matches('[data-gds-trigger]')) settings.triggerTokens = Math.max(200, Number(input.value) || DEFAULT_SETTINGS.triggerTokens);
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
    entry.className = 'gds-settings-entry';
    entry.innerHTML = `<button class="menu_button" data-gds-open-settings>🐶 打开嘎嘎小狗总结</button><small>自动压缩前情、保留记忆并退出旧正文上下文</small>`;
    host.appendChild(entry);
    entry.querySelector('[data-gds-open-settings]').addEventListener('click', () => togglePanel(true));
    runtime.settingsEntry = entry;
}

function togglePanel(open) {
    createUi();
    runtime.open = Boolean(open);
    runtime.overlay.hidden = !runtime.open;
    if (runtime.open) refreshUi();
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
