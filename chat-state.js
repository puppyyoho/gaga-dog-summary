function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Resolve SillyTavern's per-chat metadata store.
 *
 * Modern getContext() exposes `chatMetadata`. Older builds and a few test
 * harnesses expose `chat_metadata`, so keep a migration path without making
 * the legacy property the primary store.
 */
export function resolveChatMetadata(ctx, key, normalize) {
    if (!ctx || typeof ctx !== 'object') throw new Error('无法读取当前聊天上下文。');
    const canonical = isRecord(ctx.chatMetadata) ? ctx.chatMetadata : null;
    const legacy = isRecord(ctx.chat_metadata) ? ctx.chat_metadata : null;

    if (canonical) {
        if (canonical[key] === undefined && legacy?.[key] !== undefined) {
            canonical[key] = normalize(legacy[key]);
        }
        return canonical;
    }
    if (legacy) return legacy;

    try {
        ctx.chatMetadata = {};
        if (isRecord(ctx.chatMetadata)) return ctx.chatMetadata;
    } catch { /* Some context implementations expose a read-only property. */ }

    try {
        ctx.chat_metadata = {};
        if (isRecord(ctx.chat_metadata)) return ctx.chat_metadata;
    } catch { /* Report one clear error below. */ }

    throw new Error('当前酒馆版本没有提供可写的聊天元数据。');
}

export function readChatState(ctx, key, normalize) {
    return normalize(resolveChatMetadata(ctx, key, normalize)[key]);
}

export function writeChatState(ctx, key, value, normalize) {
    const normalized = normalize(value);
    const metadata = resolveChatMetadata(ctx, key, normalize);
    metadata[key] = normalized;

    // Keep an already-existing legacy store in sync during upgrades. Never
    // create it on modern contexts: doing so caused v0.1.4's lost state bug.
    if (isRecord(ctx.chatMetadata) && isRecord(ctx.chat_metadata) && ctx.chat_metadata !== metadata) {
        ctx.chat_metadata[key] = normalized;
    }
    return normalized;
}

export async function persistChatMetadata(ctx, { includeMessages = false } = {}) {
    let savedWholeChat = false;
    if (typeof ctx?.saveMetadata === 'function') {
        await ctx.saveMetadata();
    } else if (typeof ctx?.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
    } else if (typeof ctx?.saveChat === 'function') {
        await ctx.saveChat();
        savedWholeChat = true;
    } else if (typeof ctx?.saveChatDebounced === 'function') {
        ctx.saveChatDebounced();
        savedWholeChat = true;
    } else {
        throw new Error('当前酒馆版本没有提供聊天元数据保存接口。');
    }

    if (includeMessages && !savedWholeChat) {
        if (typeof ctx?.saveChat === 'function') await ctx.saveChat();
        else if (typeof ctx?.saveChatDebounced === 'function') ctx.saveChatDebounced();
    }
}
