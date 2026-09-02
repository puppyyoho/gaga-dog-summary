export function extractGeneratedText(result) {
    if (typeof result === 'string') return result;
    const content = result?.text
        ?? result?.content
        ?? result?.message?.content
        ?? result?.choices?.[0]?.message?.content
        ?? result?.choices?.[0]?.text
        ?? '';
    if (Array.isArray(content)) {
        return content.map(item => typeof item === 'string' ? item : item?.text || item?.content || '').join('');
    }
    return String(content || '');
}

export async function generateRaw(ctx, request) {
    if (typeof ctx?.generateRaw !== 'function') throw new Error('当前 SillyTavern 没有可用的 generateRaw()。');
    const text = extractGeneratedText(await ctx.generateRaw(request));
    if (!String(text).trim()) throw new Error('模型返回了空内容。');
    return String(text);
}

export async function generateQuietOnly(ctx, request) {
    if (typeof ctx?.generateQuietPrompt !== 'function') throw new Error('当前 SillyTavern 没有可用的 generateQuietPrompt()。');
    const combined = [request.systemPrompt, request.prompt].filter(Boolean).join('\n\n');
    const options = { quietPrompt: combined, skipWIAN: true };
    if (Number(request.responseLength) > 0) options.responseLength = Math.round(Number(request.responseLength));
    const text = extractGeneratedText(await ctx.generateQuietPrompt(options));
    if (!String(text).trim()) throw new Error('模型返回了空内容。');
    return String(text);
}

export async function generateCompatible(ctx, request, onFallback = null) {
    try {
        // This is the same background-generation path used by Tavern extensions.
        return await generateQuietOnly(ctx, request);
    } catch (quietError) {
        if (typeof onFallback === 'function') onFallback(quietError);
        return generateRaw(ctx, request);
    }
}
