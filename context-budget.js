export const FALLBACK_BATCH_TOKENS = 48000;

function positiveInteger(values, minimum = 1) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= minimum) return Math.round(number);
    }
    return 0;
}

export function resolveContextWindowTokens(ctx = {}, doc = globalThis.document) {
    const mainApi = String(ctx?.mainApi ?? ctx?.main_api ?? '').toLowerCase();
    const chat = ctx?.chatCompletionSettings || {};
    const text = ctx?.textCompletionSettings || {};
    const apiSpecific = mainApi === 'openai'
        ? [chat.openai_max_context, chat.max_context, chat.context_length]
        : mainApi === 'textgenerationwebui'
            ? [text.max_context, text.max_context_length, text.truncation_length, text.context_length]
            : [];
    return positiveInteger([
        ...apiSpecific,
        ctx?.maxContext,
        ctx?.max_context,
        doc?.querySelector?.('#openai_max_context')?.value,
        doc?.querySelector?.('#max_context')?.value,
        doc?.querySelector?.('#context_length')?.value,
    ], 2048);
}

export function resolveOutputReserveTokens(ctx = {}, doc = globalThis.document) {
    const chat = ctx?.chatCompletionSettings || {};
    const text = ctx?.textCompletionSettings || {};
    return positiveInteger([
        chat.openai_max_tokens,
        chat.max_tokens,
        text.genamt,
        text.max_new_tokens,
        text.max_tokens,
        doc?.querySelector?.('#openai_max_tokens')?.value,
        doc?.querySelector?.('#amount_gen')?.value,
        doc?.querySelector?.('#max_new_tokens')?.value,
    ], 128) || 4096;
}

export function chooseSummaryBatchPlan(options = {}) {
    const contextTokens = Math.max(0, Number(options.contextTokens || 0));
    const sourceTokens = Math.max(1, Number(options.sourceTokens || 1));
    const promptTokens = Math.max(sourceTokens, Number(options.promptTokens || sourceTokens));
    const fallbackTokens = Math.max(5000, Number(options.fallbackTokens || FALLBACK_BATCH_TOKENS));

    if (!contextTokens) {
        return {
            strategy: 'fallback',
            batchTokens: fallbackTokens,
            contextTokens: 0,
            sourceTokens,
            promptTokens,
            usablePromptTokens: 0,
        };
    }

    const requestedOutput = Math.max(1024, Number(options.outputTokens || 4096));
    const outputReserve = Math.min(requestedOutput, Math.max(1024, Math.floor(contextTokens * 0.25)));
    const safetyReserve = Math.max(2048, Math.floor(contextTokens * 0.08));
    const usablePromptTokens = Math.max(5000, contextTokens - outputReserve - safetyReserve);
    const promptOverhead = Math.max(1000, promptTokens - sourceTokens);
    const safeSourceTokens = Math.max(5000, Math.floor((usablePromptTokens - promptOverhead) * 0.9));

    if (promptTokens <= usablePromptTokens) {
        return {
            strategy: 'single',
            batchTokens: 0,
            contextTokens,
            sourceTokens,
            promptTokens,
            usablePromptTokens,
        };
    }

    return {
        strategy: 'adaptive-split',
        batchTokens: safeSourceTokens,
        contextTokens,
        sourceTokens,
        promptTokens,
        usablePromptTokens,
    };
}
