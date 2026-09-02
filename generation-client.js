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

function selectedConnectionProfile(ctx) {
    const manager = ctx?.extensionSettings?.connectionManager;
    const disabled = Array.isArray(ctx?.extensionSettings?.disabledExtensions)
        && ctx.extensionSettings.disabledExtensions.includes('connection-manager');
    if (disabled || !manager?.selectedProfile || typeof ctx?.ConnectionManagerRequestService?.sendRequest !== 'function') return null;
    const profiles = Array.isArray(manager.profiles) ? manager.profiles : [];
    const profile = profiles.find(item => item?.id === manager.selectedProfile);
    if (!profile) return null;
    try {
        if (typeof ctx.ConnectionManagerRequestService.isProfileSupported === 'function'
            && !ctx.ConnectionManagerRequestService.isProfileSupported(profile)) return null;
    } catch {
        return null;
    }
    return {
        service: ctx.ConnectionManagerRequestService,
        profileId: manager.selectedProfile,
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

function configuredOutputLimit() {
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

export async function generateStreaming(ctx, { systemPrompt, prompt, signal, onText, onStatus }) {
    const api = currentStreamingApi(ctx);
    const connection = api ? null : selectedConnectionProfile(ctx);
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
                configuredOutputLimit(),
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
