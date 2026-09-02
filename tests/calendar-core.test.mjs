import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCalendarContext,
    BUILTIN_CALENDAR_EVENTS,
    createEmptyCalendarState,
    getCalendarAlerts,
    normalizeCalendarState,
    resolveStoryDate,
} from '../calendar-core.js';

test('ships built-in holidays and solar terms without pretending approximate dates are facts', () => {
    const calendar = normalizeCalendarState(createEmptyCalendarState());
    assert.ok(BUILTIN_CALENDAR_EVENTS.some(item => item.title === '元旦'));
    assert.ok(BUILTIN_CALENDAR_EVENTS.some(item => item.title === '立春'));
    const alerts = getCalendarAlerts(calendar, '2025-01-01', 0);
    assert.ok(alerts.some(item => item.title === '元旦'));
});

test('supports annual, one-off and cycle events such as anniversaries and periods', () => {
    const calendar = normalizeCalendarState({
        builtinsEnabled: false,
        reminderWindowDays: 2,
        events: [
            { id: 'anniversary', title: '纪念日', kind: 'anniversary', dateRule: 'annual', date: '06-12' },
            { id: 'period', title: '生理期', kind: 'period', dateRule: 'cycle', date: '2025-06-01', recurrence: { anchorDate: '2025-06-01', cycleDays: 28, durationDays: 5 } },
            { id: 'deadline', title: '剧情期限', kind: 'deadline', dateRule: 'once', date: '2025-06-13' },
        ],
    });
    const alerts = getCalendarAlerts(calendar, '2025-06-11', 2);
    assert.ok(alerts.some(item => item.title === '纪念日' && item.daysUntil === 1));
    assert.ok(alerts.some(item => item.title === '剧情期限' && item.daysUntil === 2));
    const periodAlerts = getCalendarAlerts(calendar, '2025-06-03', 2);
    assert.ok(periodAlerts.some(item => item.title === '生理期'));
});

test('prefers explicit manual date, then recent正文, memory and character card', () => {
    assert.equal(resolveStoryDate({ calendarState: { worldDate: '2025-08-20' }, recentText: '2025年9月1日' }).source, 'manual');
    const recent = resolveStoryDate({ calendarState: {}, recentText: '故事发生在2025年9月1日。', characterCard: '背景是2024年1月1日。' });
    assert.deepEqual({ date: recent.date, source: recent.source }, { date: '2025-09-01', source: '正文' });
    const card = resolveStoryDate({ calendarState: {}, recentText: '', characterCard: '背景日期：2024年1月1日。' });
    assert.equal(card.source, '角色卡');
    assert.equal(resolveStoryDate({ calendarState: {}, recentText: '', memoryText: '', characterCard: '' }).date, '');
});

test('builds a bounded director-facing calendar context with non-factual reminders', () => {
    const context = buildCalendarContext({ calendarState: { worldDate: '2025-01-01' }, recentText: '今天是2025年1月1日。' });
    assert.match(context.cardText, /故事日历/);
    assert.match(context.cardText, /元旦/);
    assert.match(context.cardText, /只做提醒/);
});
