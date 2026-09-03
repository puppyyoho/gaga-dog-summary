import { PROVIDER_CURRENT } from './provider-profiles.js';

function cloneSettings(settings) {
    if (!settings || typeof settings !== 'object') return {};
    try {
        if (typeof structuredClone === 'function') return structuredClone(settings);
    } catch {
        return { ...settings };
    }
    return { ...settings };
}

function currentStreamingApi(ctx) {
    const mainApi = String(ctx?.mainApi ?? ctx?.main_api ?? '').toLowerCase();
    if (mainApi === 'openai'
        && typeof ctx?.ChatCompletionService?.sendRequest === 'function'
        && ctx?.chatCompletionSettings) {
        const settings = ctx.chatCompletionSettings;
        return {
            kind: 'chat',
            service: ctx.ChatCompletionService,
            settings,
            label: [settings.chat_completion_source || 'Chat Completion', ctx.getChatCompletionModel?.(settings)].filter(Boolean).join(' · '),
        };
    }
    if (mainApi === 'textgenerationwebui'
        && typeof ctx?.TextCompletionService?.sendRequest === 'function'
        && typeof ctx?.TextCompletionService?.presetToGeneratePayload === 'function'
        && ctx?.textCompletionSettings) {
        return {
            kind: 'text',
            service: ctx.TextCompletionService,
            settings: ctx.textCompletionSettings,
            label: '当前 Text Completion',
        };
    }
    return null;
}

function selectedConnectionProfile(ctx, requestedId = '') {
    const manager = ctx?.extensionSettings?.connectionManager;
    const disabled = Array.isArray(ctx?.extensionSettings?.disabledExtensions)
        && ctx.extensionSettings.disabledExtensions.includes('connection-manager');
    const profileId = String(requestedId || manager?.selectedProfile || '').trim();
    if (disabled || !profileId || typeof ctx?.ConnectionManagerRequestService?.sendRequest !== 'function') return null;
    const profiles = Array.isArray(manager.profiles) ? manager.profiles : [];
    const profile = profiles.find(item => item?.id === profileId);
    if (!profile) return null;
    try {
        if (typeof ctx.ConnectionManagerRequestService.isProfileSupported === 'function'
            && !ctx.ConnectionManagerRequestService.isProfileSupported(profile)) return null;
    } catch {
        return null;
    }
    return {
        service: ctx.ConnectionManagerRequestService,
        profileId,
        label: profile.name || profile.model || '连接管理器',
    };
}

async function buildChatPayload(ctx, api, messages) {
    const runtime = await import('/scripts/openai.js');
    if (typeof runtime.createGenerationParameters !== 'function') throw new Error('当前酒馆版本没有导出 Chat Completion normal 参数构造器');
    const settings = cloneSettings(api.settings);
    settings.stream_openai = true;
    const model = ctx.getChatCompletionModel?.(settings);
    const built = await runtime.createGenerationParameters(settings, model, 'normal', messages);
    const payload = built?.generate_data;
    if (!payload || typeof payload !== 'object') throw new Error('无法构造当前 Chat Completion 请求');
    payload.stream = true;
    delete payload.n;
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.assistant_prefill;
    const ready = ctx.eventTypes?.CHAT_COMPLETION_SETTINGS_READY ?? ctx.event_types?.CHAT_COMPLETION_SETTINGS_READY;
    if (ready && typeof ctx.eventSource?.emit === 'function') await ctx.eventSource.emit(ready, payload);
    return payload;
}

function activeTextPreset(ctx, settings) {
    try {
        return settings?.preset && typeof ctx?.getPresetManager === 'function'
            ? ctx.getPresetManager('textgenerationwebui')?.getCompletionPresetByName?.(settings.preset)
            : null;
    } catch {
        return null;
    }
}

function configuredOutputLimit(providerProfile = null) {
    if (Number(providerProfile?.outputTokens) >= 128) return Math.round(Number(providerProfile.outputTokens));
    const doc = globalThis.document;
    const candidates = [
        doc?.querySelector?.('#openai_max_tokens')?.value,
        doc?.querySelector?.('#amount_gen')?.value,
        doc?.querySelector?.('#max_new_tokens')?.value,
    ];
    for (const value of candidates) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 128) return Math.round(number);
    }
    return 4096;
}

function directCompletionUrl(baseUrl) {
    const value = String(baseUrl || '').replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`;
}

function directModelsUrl(baseUrl) {
    const value = String(baseUrl || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(value)) return value.replace(/\/chat\/completions$/i, '/models');
    return /\/models$/i.test(value) ? value : `${value}/models`;
}

function directHeaders(profile) {
    const headers = { 'Content-Type': 'application/json' };
    if (profile?.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
    return headers;
}

function directRequestBody(profile, messages, stream) {
    const body = {
        model: profile.model,
        messages,
        stream,
        max_tokens: Math.max(128, Number(profile.outputTokens || 4096) || 4096),
    };
    if (Number.isFinite(Number(profile.temperature))) body.temperature = Number(profile.temperature);
    return body;
}

async function directCompletion(profile, messages, signal, stream, onText, onStatus) {
    if (typeof fetch !== 'function') throw new Error('当前浏览器没有可用的 fetch 接口');
    const source = profile.name || profile.model || '独立 OpenAI 兼容连接';
    onStatus?.({ phase: 'connecting', source, chunks: 0, updates: 0, length: 0 });
    const response = await fetch(directCompletionUrl(profile.baseUrl), {
        method: 'POST',
        headers: directHeaders(profile),
        body: JSON.stringify(directRequestBody(profile, messages, stream)),
        signal,
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`${source} · HTTP ${response.status}${detail ? ` · ${detail.slice(0, 600)}` : ''}`);
    }
    if (!stream || !response.body?.getReader) {
        const data = await response.json();
        const text = extractGeneratedText(data);
        if (!text.trim()) throw new Error(`${source} 返回了空内容`);
        onText?.(text, { phase: 'received', source, chunks: 1, updates: 1, length: text.length });
        return { supported: true, text, source, chunks: 1, updates: 1, streamed: false, buffered: true };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let chunks = 0;
    let updates = 0;
    const emitLine = line => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) return false;
        const dataText = trimmed.slice(5).trim();
        if (!dataText || dataText === '[DONE]') return dataText === '[DONE]';
        try {
            const data = JSON.parse(dataText);
            const next = extractGeneratedText(data);
            const merged = mergeStreamText(text, next);
            chunks += 1;
            if (merged !== text) {
                text = merged;
                updates += 1;
                onText?.(text, { phase: 'receiving', source, chunks, updates, length: text.length });
            }
        } catch { /* Ignore keep-alive and incomplete SSE lines. */ }
        return false;
    };
    while (true) {
        if (signal?.aborted) throw signal.reason || new DOMException('已中断生成', 'AbortError');
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        let finished = false;
        for (const line of lines) if (emitLine(line)) finished = true;
        if (finished || done) break;
    }
    if (buffer) emitLine(buffer);
    if (!text.trim()) throw new Error(`${source} 返回了空内容`);
    onStatus?.({ phase: 'received', source, chunks, updates, length: text.length });
    return { supported: true, text, source, chunks, updates, streamed: updates > 1, buffered: updates <= 1 };
}

export async function listDirectModels(profile, signal) {
    if (!profile?.baseUrl || typeof fetch !== 'function') throw new Error('独立连接缺少 URL 或浏览器 fetch 不可用');
    const response = await fetch(directModelsUrl(profile.baseUrl), { headers: directHeaders(profile), signal });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`获取模型列表失败：HTTP ${response.status}${detail ? ` · ${detail.slice(0, 300)}` : ''}`);
    }
    const data = await response.json();
    return normalizeModelList(data);
}

function normalizeModelList(data) {
    const list = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.models)
                ? data.models
                : Array.isArray(data?.data?.data)
                    ? data.data.data
                    : [];
    return list
        .map(item => typeof item === 'string' ? item : String(item?.id || item?.name || ''))
        .map(item => item.trim())
        .filter(Boolean)
        .filter((item, index, all) => all.indexOf(item) === index);
}

async function getTavernRequestHeaders(ctx) {
    const candidates = [ctx?.getRequestHeaders, globalThis.getRequestHeaders];
    try {
        const runtime = await import('/scripts/script.js');
        candidates.push(runtime?.getRequestHeaders);
    } catch { /* Older Tavern builds may not expose script.js as an importable module. */ }
    for (const candidate of candidates) {
        if (typeof candidate !== 'function') continue;
        try {
            const headers = await candidate();
            if (headers && typeof headers === 'object') return { ...headers, 'Content-Type': 'application/json' };
        } catch { /* Try the next compatible header provider. */ }
    }
    return { 'Content-Type': 'application/json' };
}

function connectionApiDetails(ctx, profile) {
    const profiles = Array.isArray(ctx?.extensionSettings?.connectionManager?.profiles)
        ? ctx.extensionSettings.connectionManager.profiles
        : [];
    const raw = profiles.find(item => String(item?.id || '').trim() === String(profile?.profileId || '').trim()) || null;
    const apiType = String(raw?.api || raw?.apiType || raw?.api_type || profile?.apiType || '').trim();
    const maps = [ctx?.CONNECT_API_MAP, globalThis.CONNECT_API_MAP];
    let apiMap = null;
    for (const map of maps) {
        if (!map || !apiType) continue;
        apiMap = map[apiType] || map[apiType.toLowerCase()]
            || Object.entries(map).find(([key]) => key.toLowerCase() === apiType.toLowerCase())?.[1]
            || null;
        if (apiMap) break;
    }
    const selected = String(apiMap?.selected || '').trim().toLowerCase();
    const mappedSource = String(apiMap?.source || '').trim().toLowerCase();
    const rawSource = String(raw?.chat_completion_source || raw?.chatCompletionSource || raw?.source || '').trim().toLowerCase();
    let source = mappedSource || rawSource || String(profile?.apiType || '').trim().toLowerCase();
    if (source === 'openai-compatible' || source === 'openai_compatible' || source === 'direct') source = 'custom';
    if (!source) source = profile?.baseUrl ? 'custom' : 'openai';
    return { raw, apiMap, apiType, selected, source };
}

/**
 * Ask SillyTavern's own Chat Completion status endpoint to resolve a
 * Connection Manager profile's Secret Manager key and fetch its /models
 * list. This keeps credentials inside Tavern instead of copying them into
 * the extension or making a browser cross-origin request.
 */
export async function listConnectionModels(ctx, profile, signal) {
    if (!profile?.profileId) throw new Error('酒馆连接缺少 Connection Manager 配置');
    if (typeof fetch !== 'function') throw new Error('当前浏览器没有可用的 fetch 接口');
    const details = connectionApiDetails(ctx, profile);
    if (details.selected && details.selected !== 'openai') {
        throw new Error('当前酒馆连接使用 Text Completion，酒馆没有通用的 Chat Completion 模型列表接口；已保留连接档案中的默认模型');
    }
    const source = details.source;
    const baseUrl = String(profile.baseUrl || details.raw?.['api-url'] || '').trim().replace(/\/+$/, '');
    const secretId = String(profile.secretId || details.raw?.['secret-id'] || '').trim();
    const customIncludeHeaders = String(profile.customIncludeHeaders || details.raw?.custom_include_headers || details.raw?.['custom-include-headers'] || '').trim();
    const body = {
        chat_completion_source: source,
        secret_id: secretId,
    };
    if (source === 'custom') {
        if (!baseUrl) throw new Error('酒馆连接缺少自定义 API URL');
        body.custom_url = baseUrl;
    } else if (baseUrl && !secretId && profile.apiKey) {
        // A profile explicitly carrying a key can represent a reverse proxy.
        body.reverse_proxy = baseUrl;
        body.proxy_password = profile.apiKey;
    }
    if (customIncludeHeaders) body.custom_include_headers = customIncludeHeaders;
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: await getTavernRequestHeaders(ctx),
        body: JSON.stringify(body),
        signal,
        cache: 'no-cache',
    });
    let data = null;
    try { data = await response.json(); } catch { /* The status endpoint may return an empty error body. */ }
    if (!response.ok || data?.error) {
        const message = data?.message || data?.error?.message || data?.error || '';
        throw new Error(`酒馆连接拉取模型失败：HTTP ${response.status}${message ? ` · ${message}` : ''}`);
    }
    return normalizeModelList(data);
}

export function mergeStreamText(previous, next) {
    const value = String(next ?? '');
    if (!value) return previous;
    if (!previous) return value;
    if (value.startsWith(previous)) return value;
    if (previous.startsWith(value) || previous.endsWith(value)) return previous;
    return previous + value;
}

export function extractGeneratedText(result, ctx = null) {
    if (typeof result === 'string') return result;
    const direct = result?.text
        ?? result?.content
        ?? result?.message?.content
        ?? result?.choices?.[0]?.message?.content
        ?? result?.choices?.[0]?.delta?.content
        ?? result?.choices?.[0]?.text;
    if (Array.isArray(direct)) {
        return direct.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').join('');
    }
    if (direct != null) return String(direct);
    try {
        return String(ctx?.extractMessageFromData?.(result) || '');
    } catch {
        return '';
    }
}

function nextFrame() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
    });
}

export function readableGenerationError(error) {
    const details = [
        error?.message,
        error?.cause?.message,
        error?.status,
        error?.statusText,
        error?.response?.status,
        error?.response?.statusText,
        error?.response?.data?.error?.message,
        error?.response?.data?.message,
    ].filter(Boolean).map(String);
    return [...new Set(details)].join(' · ') || String(error || '未知生成错误');
}

export async function generateStreaming(ctx, { systemPrompt, prompt, signal, onText, onStatus, providerProfile = null }) {
    if (providerProfile?.kind === 'openai-compatible') {
        const messages = [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: prompt },
        ];
        return directCompletion(providerProfile, messages, signal, true, onText, onStatus);
    }
    const api = providerProfile?.kind === 'connection' ? null : currentStreamingApi(ctx);
    const connection = providerProfile?.kind === 'connection'
        ? selectedConnectionProfile(ctx, providerProfile.profileId)
        : api ? null : selectedConnectionProfile(ctx);
    if (!api && !connection) return { supported: false, text: '', streamed: false };
    const source = api?.label || connection?.label || '当前连接';
    const messages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
    ];
    onStatus?.({ phase: 'connecting', source, chunks: 0, updates: 0, length: 0 });

    let response;
    try {
        if (connection) {
            response = await connection.service.sendRequest(
                connection.profileId,
                messages,
                configuredOutputLimit(providerProfile),
                { stream: true, signal, extractData: true, includePreset: true, includeInstruct: true },
            );
        } else if (api.kind === 'chat') {
            const payload = await buildChatPayload(ctx, api, messages);
            response = await api.service.sendRequest(payload, true, signal);
        } else {
            const preset = activeTextPreset(ctx, api.settings);
            const settings = cloneSettings(preset || api.settings);
            const payload = api.service.presetToGeneratePayload(settings, {}, {
                prompt: [systemPrompt, prompt].filter(Boolean).join('\n\n'),
                stream: true,
            });
            const ready = ctx.eventTypes?.TEXT_COMPLETION_SETTINGS_READY ?? ctx.event_types?.TEXT_COMPLETION_SETTINGS_READY;
            if (ready && typeof ctx.eventSource?.emit === 'function') await ctx.eventSource.emit(ready, payload);
            response = await api.service.sendRequest(payload, true, signal);
        }
    } catch (error) {
        throw new Error(`${source} · ${readableGenerationError(error)}`, { cause: error });
    }

    const iterator = typeof response === 'function'
        ? response()
        : response && typeof response[Symbol.asyncIterator] === 'function' ? response : null;
    let text = '';
    let chunks = 0;
    let updates = 0;
    onStatus?.({ phase: 'connected', source, chunks, updates, length: 0 });
    if (iterator) {
        for await (const chunk of iterator) {
            if (signal?.aborted) throw signal.reason || new DOMException('已中断生成', 'AbortError');
            chunks += 1;
            const merged = mergeStreamText(text, extractGeneratedText(chunk, ctx));
            if (merged !== text) {
                text = merged;
                updates += 1;
                onText?.(text, { phase: 'receiving', source, chunks, updates, length: text.length });
            }
            if (chunks === 1 || chunks % 8 === 0) await nextFrame();
        }
    } else {
        text = extractGeneratedText(response, ctx);
        if (text) onText?.(text, { phase: 'received', source, chunks: 1, updates: 1, length: text.length });
    }
    if (!text.trim()) throw new Error(`${source} 返回了空内容`);
    return {
        supported: true,
        text,
        source,
        chunks,
        updates,
        streamed: Boolean(iterator && updates > 1),
        buffered: Boolean(!iterator || updates <= 1),
    };
}

async function generateBuffered(ctx, options) {
    if (options.providerProfile?.kind === 'openai-compatible') {
        const messages = [
            ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
            { role: 'user', content: options.prompt },
        ];
        return directCompletion(options.providerProfile, messages, options.signal, false, options.onText, options.onStatus);
    }
    if (options.providerProfile?.kind === 'connection') {
        const connection = selectedConnectionProfile(ctx, options.providerProfile.profileId);
        if (!connection) throw new Error('指定的酒馆 Connection Manager 连接不可用或已被禁用');
        const messages = [
            ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
            { role: 'user', content: options.prompt },
        ];
        try {
            const response = await connection.service.sendRequest(
                connection.profileId,
                messages,
                configuredOutputLimit(options.providerProfile),
                { stream: false, signal: options.signal, extractData: true, includePreset: true, includeInstruct: true },
            );
            const text = extractGeneratedText(response, ctx);
            if (!text.trim()) throw new Error(`${connection.label} 返回了空内容`);
            options.onText?.(text, { phase: 'received', source: connection.label, chunks: 1, updates: 1, length: text.length });
            return { text, source: connection.label };
        } catch (error) {
            throw new Error(`${connection.label} · ${readableGenerationError(error)}`, { cause: error });
        }
    }
    const combined = [options.systemPrompt, options.prompt].filter(Boolean).join('\n\n');
    let quietError = null;
    if (typeof ctx?.generateQuietPrompt === 'function') {
        try {
            const text = extractGeneratedText(await ctx.generateQuietPrompt({
                quietPrompt: combined,
                skipWIAN: true,
                signal: options.signal,
            }), ctx);
            if (text.trim()) return { text, source: 'Quiet 后台生成' };
        } catch (error) {
            quietError = error;
        }
    }
    if (typeof ctx?.generateRaw === 'function') {
        try {
            const text = extractGeneratedText(await ctx.generateRaw({
                systemPrompt: options.systemPrompt,
                prompt: options.prompt,
                signal: options.signal,
            }), ctx);
            if (text.trim()) return { text, source: 'Raw 兼容生成' };
        } catch (error) {
            const quietDetail = quietError ? `Quiet：${readableGenerationError(quietError)}；` : '';
            throw new Error(`${quietDetail}Raw：${readableGenerationError(error)}`, { cause: error });
        }
    }
    if (quietError) throw quietError;
    throw new Error('当前 SillyTavern 未提供可用的生成接口');
}

export async function generateWithFallback(ctx, options) {
    let streamError = null;
    if (options.preferStream !== false) {
        try {
            const streamed = await generateStreaming(ctx, options);
            if (streamed.supported) return streamed;
        } catch (error) {
            if (options.signal?.aborted || error?.name === 'AbortError') throw error;
            streamError = error;
            options.onStatus?.({ phase: 'fallback', reason: readableGenerationError(error) });
        }
    }
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('已中断生成', 'AbortError');
    let buffered;
    try {
        buffered = await generateBuffered(ctx, options);
    } catch (error) {
        if (!streamError) throw error;
        throw new Error(`直接流式：${readableGenerationError(streamError)}；兼容通道：${readableGenerationError(error)}`, { cause: error });
    }
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('已中断生成', 'AbortError');
    options.onText?.(buffered.text, { phase: 'received', source: buffered.source, chunks: 1, updates: 1, length: buffered.text.length });
    return { supported: true, streamed: false, buffered: true, text: buffered.text, source: buffered.source, chunks: 1, updates: 1 };
}

/**
 * Direct-only generation for preflight work such as the story director.
 * It deliberately never falls back to generateQuietPrompt, which would
 * re-enter SillyTavern's generation events and recursively invoke the director.
 */
export async function generateDirectOnly(ctx, options = {}) {
    const result = await generateStreaming(ctx, options);
    return result?.supported ? result : null;
}
