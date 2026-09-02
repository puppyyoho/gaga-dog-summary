import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chooseSummaryBatchPlan,
    resolveContextWindowTokens,
    resolveOutputReserveTokens,
} from '../context-budget.js';

test('reads the active Tavern context and output limits', () => {
    const ctx = {
        mainApi: 'openai',
        maxContext: 128000,
        chatCompletionSettings: {
            openai_max_context: 200000,
            openai_max_tokens: 8192,
        },
    };
    assert.equal(resolveContextWindowTokens(ctx, null), 200000);
    assert.equal(resolveOutputReserveTokens(ctx, null), 8192);
});

test('manual summary uses one fact batch when the complete prompt fits', () => {
    const plan = chooseSummaryBatchPlan({
        reason: 'manual',
        contextTokens: 200000,
        outputTokens: 8192,
        sourceTokens: 145000,
        promptTokens: 148000,
    });
    assert.equal(plan.strategy, 'single');
    assert.equal(plan.batchTokens, 0);
});

test('manual summary adapts the batch size only when the prompt cannot fit', () => {
    const plan = chooseSummaryBatchPlan({
        reason: 'manual',
        contextTokens: 128000,
        outputTokens: 8192,
        sourceTokens: 150000,
        promptTokens: 153000,
    });
    assert.equal(plan.strategy, 'adaptive-split');
    assert.ok(plan.batchTokens > 60000);
    assert.ok(plan.batchTokens < 128000);
});

test('automatic summary still follows its configured trigger threshold', () => {
    const plan = chooseSummaryBatchPlan({
        reason: 'auto',
        contextTokens: 200000,
        outputTokens: 8192,
        sourceTokens: 140000,
        promptTokens: 143000,
        autoTriggerTokens: 60000,
    });
    assert.equal(plan.strategy, 'auto-threshold');
    assert.equal(plan.batchTokens, 60000);
});

test('unknown context falls back to a conservative manual batch', () => {
    const plan = chooseSummaryBatchPlan({
        reason: 'manual',
        contextTokens: 0,
        sourceTokens: 180000,
        promptTokens: 183000,
    });
    assert.equal(plan.strategy, 'fallback');
    assert.equal(plan.batchTokens, 60000);
});
