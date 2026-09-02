import { compactText } from './memory-core.js';

export const CALENDAR_SCHEMA_VERSION = 1;

// Solar terms are deliberately approximate when no year-specific table is available.
// The director is told that these are reminders, never immutable facts.
export const SOLAR_TERMS = [
    ['lichun', '立春', '02-04'], ['yushui', '雨水', '02-19'], ['jingzhe', '惊蛰', '03-05'], ['chunfen', '春分', '03-20'],
    ['qingming', '清明', '04-04'], ['guyu', '谷雨', '04-20'], ['lixia', '立夏', '05-05'], ['xiaoman', '小满', '05-21'],
    ['mangzhong', '芒种', '06-05'], ['xiazhi', '夏至', '06-21'], ['xiaoshu', '小暑', '07-07'], ['dashu', '大暑', '07-23'],
    ['liqiu', '立秋', '08-07'], ['chushu', '处暑', '08-23'], ['bailu', '白露', '09-07'], ['qiufen', '秋分', '09-23'],
    ['hanlu', '寒露', '10-08'], ['shuangjiang', '霜降', '10-23'], ['lidong', '立冬', '11-07'], ['xiaoxue', '小雪', '11-22'],
    ['daxue', '大雪', '12-07'], ['dongzhi', '冬至', '12-21'], ['xiaohan', '小寒', '01-05'], ['dahan', '大寒', '01-20'],
];

const SOLAR_TERM_MAP = Object.fromEntries(SOLAR_TERMS.map(([id, name, monthDay]) => [id, { id, name, monthDay }]));

// Common Chinese lunar festivals for recent/frequently used story years. Unknown years
// stay absent rather than receiving a misleading guessed date; users can add a one-off event.
export const LUNAR_FESTIVAL_DATES = {
    spring: { 2025: '01-29', 2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03' },
    lantern: { 2025: '02-12', 2026: '03-03', 2027: '02-20', 2028: '02-23', 2029: '03-01', 2030: '02-20' },
    dragonBoat: { 2025: '05-31', 2026: '06-19', 2027: '06-09', 2028: '05-27', 2029: '06-16', 2030: '06-09' },
    midAutumn: { 2025: '10-06', 2026: '09-25', 2027: '09-15', 2028: '10-03', 2029: '09-22', 2030: '09-12' },
};

export const BUILTIN_CALENDAR_EVENTS = [
    { id: 'builtin-new-year', title: '元旦', kind: 'holiday', dateRule: 'annual', date: '01-01', note: '公历节日', plotHook: '可以作为新年愿望、重逢或新阶段开场的背景。' },
    { id: 'builtin-valentines', title: '情人节', kind: 'holiday', dateRule: 'annual', date: '02-14', note: '公历节日', plotHook: '仅在关系氛围合适时，作为礼物、邀约或误会的契机。' },
    { id: 'builtin-womens-day', title: '妇女节', kind: 'holiday', dateRule: 'annual', date: '03-08', note: '公历节日', plotHook: '可作为角色被看见、被祝福或谈论身份的轻节点。' },
    { id: 'builtin-labor-day', title: '劳动节', kind: 'holiday', dateRule: 'annual', date: '05-01', note: '公历节日', plotHook: '适合作为旅行、休假或工作冲突的背景。' },
    { id: 'builtin-childrens-day', title: '儿童节', kind: 'holiday', dateRule: 'annual', date: '06-01', note: '公历节日', plotHook: '可用于童年回忆、礼物或家庭话题。' },
    { id: 'builtin-national-day', title: '国庆节', kind: 'holiday', dateRule: 'annual', date: '10-01', note: '公历节日', plotHook: '可作为长假、出行或公共事件背景。' },
    { id: 'builtin-christmas', title: '圣诞节', kind: 'holiday', dateRule: 'annual', date: '12-25', note: '公历节日', plotHook: '可作为交换礼物、聚会或年末收束的背景。' },
    { id: 'builtin-spring-festival', title: '春节', kind: 'holiday', dateRule: 'lunar', lunarKey: 'spring', note: '农历节日；内置 2025–2030 日期，其他年份请手动添加。', plotHook: '可作为团圆、返乡、礼物或家庭冲突的背景。' },
    { id: 'builtin-lantern-festival', title: '元宵节', kind: 'holiday', dateRule: 'lunar', lunarKey: 'lantern', note: '农历节日；内置 2025–2030 日期，其他年份请手动添加。', plotHook: '可作为灯会、寻找、约定或关系确认的轻节点。' },
    { id: 'builtin-dragon-boat', title: '端午节', kind: 'holiday', dateRule: 'lunar', lunarKey: 'dragonBoat', note: '农历节日；内置 2025–2030 日期，其他年份请手动添加。', plotHook: '可作为短途出行、饮食、传说或家人来访的背景。' },
    { id: 'builtin-mid-autumn', title: '中秋节', kind: 'holiday', dateRule: 'lunar', lunarKey: 'midAutumn', note: '农历节日；内置 2025–2030 日期，其他年份请手动添加。', plotHook: '可作为月色、团聚、礼物或未说出口的话的背景。' },
    ...SOLAR_TERMS.map(([id, name, monthDay]) => ({ id: `builtin-${id}`, title: name, kind: 'solar-term', dateRule: 'solar-term', term: id, date: monthDay, note: '节气日期为常用近似值，具体年份可能前后浮动一天。', plotHook: `可用${name}的天气、植物或生活感受轻轻映照当前剧情。` })),
];

function record(value, fallback = {}) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function list(value, max = 120) {
    return Array.isArray(value) ? value.slice(0, max) : [];
}

function validIsoDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const date = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function validMonthDay(value) {
    return /^\d{2}-\d{2}$/.test(String(value || '').trim());
}

function dateToIso(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
    if (!validIsoDate(value)) return null;
    return new Date(`${value}T00:00:00Z`);
}

function lunarDateForYear(event, year) {
    const monthDay = event?.lunarKey ? LUNAR_FESTIVAL_DATES[event.lunarKey]?.[year] : '';
    return monthDay ? `${year}-${monthDay}` : '';
}

function daysBetween(start, end) {
    const a = parseIsoDate(start);
    const b = parseIsoDate(end);
    if (!a || !b) return NaN;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function normalizeRecurrence(value) {
    const recurrence = record(value);
    return {
        anchorDate: validIsoDate(recurrence.anchorDate) ? recurrence.anchorDate : '',
        cycleDays: Math.max(1, Math.min(366, Number(recurrence.cycleDays || 28) || 28)),
        durationDays: Math.max(1, Math.min(60, Number(recurrence.durationDays || 5) || 5)),
    };
}

export function normalizeCalendarEvent(value, index = 0) {
    const input = record(value);
    const dateRule = ['once', 'annual', 'range', 'cycle', 'solar-term', 'lunar'].includes(input.dateRule) ? input.dateRule : 'once';
    const id = String(input.id || `calendar_${Date.now()}_${index + 1}`);
    const date = String(input.date || '').trim();
    const normalizedDate = dateRule === 'annual' || dateRule === 'solar-term'
        ? (validMonthDay(date) ? date : validIsoDate(date) ? date.slice(5) : '')
        : (validIsoDate(date) ? date : '');
    return {
        id,
        title: compactText(input.title || input.name || '未命名日历事件', 120),
        kind: compactText(input.kind || 'custom', 40),
        enabled: input.enabled !== false && input.enabled !== 'false',
        dateRule,
        date: normalizedDate,
        startDate: validIsoDate(input.startDate) ? input.startDate : '',
        endDate: validIsoDate(input.endDate) ? input.endDate : '',
        term: SOLAR_TERM_MAP[input.term] ? input.term : '',
        lunarKey: LUNAR_FESTIVAL_DATES[input.lunarKey] ? input.lunarKey : '',
        recurrence: normalizeRecurrence(input.recurrence),
        remindDays: Math.max(0, Math.min(30, Number(input.remindDays ?? 3) || 0)),
        priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal',
        note: compactText(input.note || '', 500),
        plotHook: compactText(input.plotHook || '', 800),
        source: input.source === 'builtin' ? 'builtin' : input.source === 'inferred' ? 'inferred' : 'user',
        createdAt: Number(input.createdAt || Date.now()),
    };
}

export function createEmptyCalendarState() {
    return {
        schemaVersion: CALENDAR_SCHEMA_VERSION,
        enabled: true,
        builtinsEnabled: true,
        autoAdvance: false,
        reminderWindowDays: 3,
        worldDate: '',
        dateSource: 'auto',
        dateConfidence: 'unknown',
        dateEvidence: '',
        events: [],
        lastAlertSignature: '',
        lastSyncedAt: 0,
    };
}

export function normalizeCalendarState(value) {
    const defaults = createEmptyCalendarState();
    const input = record(value);
    const result = {
        ...defaults,
        ...input,
        events: list(input.events).map((event, index) => normalizeCalendarEvent(event, index)),
    };
    result.schemaVersion = CALENDAR_SCHEMA_VERSION;
    result.enabled = result.enabled !== false && result.enabled !== 'false';
    result.builtinsEnabled = result.builtinsEnabled !== false && result.builtinsEnabled !== 'false';
    result.autoAdvance = result.autoAdvance === true || result.autoAdvance === 'true';
    result.reminderWindowDays = Math.max(0, Math.min(30, Number(result.reminderWindowDays ?? 3) || 0));
    result.worldDate = validIsoDate(result.worldDate) ? result.worldDate : '';
    result.dateSource = String(result.dateSource || 'auto');
    result.dateConfidence = String(result.dateConfidence || 'unknown');
    result.dateEvidence = compactText(result.dateEvidence || '', 500);
    result.lastAlertSignature = compactText(result.lastAlertSignature || '', 500);
    result.lastSyncedAt = Number(result.lastSyncedAt || 0) || 0;
    return result;
}

function extractDateCandidates(text, fallbackYear = new Date().getUTCFullYear()) {
    const source = String(text || '');
    const candidates = [];
    const full = /(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*(?:日)?/g;
    for (const match of source.matchAll(full)) {
        const iso = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
        if (validIsoDate(iso)) candidates.push({ date: iso, confidence: 'high', evidence: match[0] });
    }
    const monthDay = /(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*(?:日)?/g;
    for (const match of source.matchAll(monthDay)) {
        const iso = `${fallbackYear}-${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
        if (validIsoDate(iso)) candidates.push({ date: iso, confidence: 'medium', evidence: match[0] });
    }
    return candidates;
}

/** Resolve the story date without asking the model on every generation. */
export function resolveStoryDate({ calendarState, recentText = '', memoryText = '', characterCard = '', fallbackDate = '' } = {}) {
    const calendar = normalizeCalendarState(calendarState);
    if (calendar.worldDate) return { date: calendar.worldDate, source: 'manual', confidence: 'high', evidence: '用户手动指定' };
    const sources = [
        ['正文', recentText, 'high'],
        ['记忆', memoryText, 'medium'],
        ['角色卡', characterCard, 'medium'],
    ];
    for (const [source, text] of sources) {
        const candidates = extractDateCandidates(text);
        if (candidates.length) {
            const hit = [...candidates].reverse().find(candidate => candidate.confidence === 'high') || candidates.at(-1);
            return { date: hit.date, source, confidence: hit.confidence, evidence: compactText(hit.evidence, 120) };
        }
    }
    return validIsoDate(fallbackDate)
        ? { date: fallbackDate, source: '手动调用兜底', confidence: 'low', evidence: '未找到明确故事日期，使用调用方提供的日期' }
        : { date: '', source: '未识别', confidence: 'unknown', evidence: '未找到明确故事日期；请在日历中手动指定' };
}

function occurrenceForEvent(event, date) {
    const target = parseIsoDate(date);
    if (!target || !event.enabled) return [];
    if (event.dateRule === 'once' && event.date === date) return [{ event, date, offset: 0 }];
    if (event.dateRule === 'range' && event.startDate && event.endDate && date >= event.startDate && date <= event.endDate) {
        return [{ event, date: event.startDate, offset: daysBetween(event.startDate, date) }];
    }
    if (event.dateRule === 'cycle' && event.recurrence.anchorDate) {
        const offset = daysBetween(event.recurrence.anchorDate, date);
        if (Number.isFinite(offset) && offset >= 0) {
            const dayInCycle = offset % event.recurrence.cycleDays;
            if (dayInCycle < event.recurrence.durationDays) {
                const occurrenceDate = dateToIso(new Date(target.getTime() - dayInCycle * 86400000));
                return [{ event, date: occurrenceDate, offset: dayInCycle }];
            }
        }
    }
    if (event.dateRule === 'annual' || event.dateRule === 'solar-term') {
        const monthDay = event.date || SOLAR_TERM_MAP[event.term]?.monthDay;
        if (validMonthDay(monthDay) && monthDay === date.slice(5)) return [{ event, date, offset: 0 }];
    }
    if (event.dateRule === 'lunar' && lunarDateForYear(event, date.slice(0, 4)) === date) return [{ event, date, offset: 0 }];
    return [];
}

export function calendarEvents(calendarState) {
    const calendar = normalizeCalendarState(calendarState);
    const custom = calendar.events;
    return [...(calendar.builtinsEnabled ? BUILTIN_CALENDAR_EVENTS.map(item => ({ ...item, source: 'builtin' })) : []), ...custom];
}

export function getCalendarOccurrences(calendarState, date) {
    const target = validIsoDate(date) ? date : '';
    if (!target) return [];
    const values = [];
    for (const event of calendarEvents(calendarState)) values.push(...occurrenceForEvent(normalizeCalendarEvent(event), target));
    return values;
}

export function getCalendarAlerts(calendarState, date, windowDays = null) {
    const calendar = normalizeCalendarState(calendarState);
    if (!calendar.enabled) return [];
    const target = validIsoDate(date) ? date : '';
    if (!target) return [];
    const window = Math.max(0, Number(windowDays ?? calendar.reminderWindowDays) || 0);
    const targetDate = parseIsoDate(target);
    const alerts = [];
    for (const rawEvent of calendarEvents(calendar)) {
        const event = normalizeCalendarEvent(rawEvent);
        if (!event.enabled) continue;
        const dates = [];
        if (event.dateRule === 'once' && event.date) dates.push(event.date);
        else if (event.dateRule === 'range' && event.startDate) dates.push(event.startDate);
        else if (event.dateRule === 'cycle' && event.recurrence.anchorDate) {
            const days = daysBetween(event.recurrence.anchorDate, target);
            const cycle = event.recurrence.cycleDays;
            if (Number.isFinite(days)) {
                const index = Math.max(0, Math.floor(days / cycle));
                for (const n of [index - 1, index, index + 1]) if (n >= 0) {
                    dates.push(dateToIso(new Date(parseIsoDate(event.recurrence.anchorDate).getTime() + n * cycle * 86400000)));
                }
            }
        } else if (event.dateRule === 'annual' || event.dateRule === 'solar-term') {
            const monthDay = event.date || SOLAR_TERM_MAP[event.term]?.monthDay;
            if (validMonthDay(monthDay)) {
                for (const year of [target.slice(0, 4), String(Number(target.slice(0, 4)) - 1), String(Number(target.slice(0, 4)) + 1)]) dates.push(`${year}-${monthDay}`);
            }
        } else if (event.dateRule === 'lunar') {
            for (const year of [target.slice(0, 4), String(Number(target.slice(0, 4)) - 1), String(Number(target.slice(0, 4)) + 1)]) {
                const lunarDate = lunarDateForYear(event, year);
                if (lunarDate) dates.push(lunarDate);
            }
        }
        for (const occurrenceDate of dates) {
            const occurrence = parseIsoDate(occurrenceDate);
            if (!occurrence) continue;
            const daysUntil = Math.round((occurrence.getTime() - targetDate.getTime()) / 86400000);
            if (daysUntil < -window || daysUntil > window) continue;
            alerts.push({
                id: `${event.id}:${occurrenceDate}`,
                eventId: event.id,
                title: event.title,
                kind: event.kind,
                date: occurrenceDate,
                daysUntil,
                isToday: daysUntil === 0,
                phase: event.dateRule === 'cycle' ? '周期事件' : event.dateRule === 'solar-term' ? '节气' : event.kind === 'holiday' || event.dateRule === 'lunar' ? '节日' : '自定义事件',
                note: event.note,
                plotHook: event.plotHook,
                autoAdvance: calendar.autoAdvance,
                priority: event.priority,
            });
        }
    }
    return alerts.sort((a, b) => Math.abs(a.daysUntil) - Math.abs(b.daysUntil) || b.priority.localeCompare(a.priority));
}

export function buildCalendarContext({ calendarState, recentText = '', memoryText = '', characterCard = '', fallbackDate } = {}) {
    const calendar = normalizeCalendarState(calendarState);
    const resolved = resolveStoryDate({ calendarState: calendar, recentText, memoryText, characterCard, fallbackDate });
    const alerts = getCalendarAlerts(calendar, resolved.date);
    const lines = alerts.slice(0, 8).map(alert => {
        const when = alert.daysUntil === 0 ? '今天' : alert.daysUntil > 0 ? `${alert.daysUntil}天后` : `${Math.abs(alert.daysUntil)}天前`;
        return `- ${alert.title}（${alert.date}，${when}）${alert.plotHook ? `：${alert.plotHook}` : ''}`;
    });
    return {
        ...resolved,
        alerts,
        cardText: calendar.enabled ? [
            `【故事日历】当前日期：${resolved.date}（来源：${resolved.source}，置信度：${resolved.confidence}）`,
            lines.length ? `临近事件：\n${lines.join('\n')}` : '临近事件：无',
            calendar.autoAdvance ? '日历推进建议已开启：只可提供与当前因果相容的建议，不得强行改写剧情。' : '日历只做提醒，不自动推进或改写正文。',
        ].join('\n') : '',
    };
}

export function calendarSignature(context) {
    return `${context?.date || ''}|${(context?.alerts || []).map(item => item.id).join(',')}`;
}
