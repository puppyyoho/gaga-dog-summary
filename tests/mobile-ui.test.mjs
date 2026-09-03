import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'style.css'), 'utf8');
const js = readFileSync(join(here, '..', 'index.js'), 'utf8');

test('mobile panel uses a full dynamic viewport with its own scrolling', () => {
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /height:\s*var\(--gds-viewport-height, 100vh\)\s*!important/);
    assert.match(css, /\.gds-page-host[\s\S]*overflow-y:\s*auto/);
    assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
});

test('mobile header remains reachable and fields cannot overflow horizontally', () => {
    assert.match(css, /\.gds-header\s*\{[\s\S]*?position:\s*sticky/);
    assert.match(css, /\.gds-field textarea\s*\{[\s\S]*?max-width:\s*100%\s*!important/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('settings use theme-resistant pink toggle switches', () => {
    assert.match(css, /\.gds-settings-grid input\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none\s*!important/);
    assert.match(css, /width:\s*32px\s*!important/);
    assert.match(css, /background-image:\s*radial-gradient\(circle at 8px 50%/);
    assert.match(css, /\.gds-settings-grid input\[type="checkbox"\]:checked\s*\{[\s\S]*?background-color:\s*var\(--gds-pink-deep\)\s*!important/);
    assert.match(css, /background-image:\s*radial-gradient\(circle at 24px 50%/);
    assert.match(css, /\.gds-settings-grid \.gds-toggle-row\s*\{[^}]*justify-content:\s*flex-start/);
    assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(260px, 360px\)\)/);
    assert.match(css, /column-gap:\s*clamp\(70px, 9vw, 110px\)/);
    assert.match(css, /max-width:\s*820px/);
    assert.match(js, /class="gds-toggle-row"><input type="checkbox" data-gds-auto><span>自动总结<\/span>/);
});

test('opening the panel locks background scrolling and resets panel scroll', () => {
    assert.match(js, /classList\.toggle\('gds-panel-open'/);
    assert.match(js, /windowNode\.scrollTop = 0/);
    assert.match(js, /visualViewport\?\.height/);
});

test('summary UI exposes streaming, stop, and resumable pending tasks', () => {
    assert.match(js, /data-gds-stream-preview/);
    assert.match(js, /data-gds-stop/);
    assert.match(js, /data-gds-continue/);
    assert.match(js, /new AbortController\(\)/);
    assert.match(js, /state\.pending = clone\(pending\)/);
    assert.match(js, /rangeStillMatches\(getMessages\(ctx\), pending\.range\)/);
    assert.match(js, /pending\.stage = 'polish'/);
    assert.match(js, /buildPolishPrompt/);
    assert.match(js, /事实 → 草稿 → 润色/);
    assert.match(js, /检查点已保存，但当前总结成品为空/);
    assert.match(js, /function savedRecap\(chatState\)/);
    assert.match(js, /status === 'committed' && String\(item\.recap/);
});

test('workbench exposes three independent modules and selected summary artifacts', () => {
    assert.match(js, /data-gds-tab="memory"/);
    assert.match(js, /data-gds-tab="director"/);
    assert.match(js, /data-gds-tab="reply"/);
    assert.match(js, /data-gds-summary-mode/);
    assert.match(js, /summaryArtifacts/);
    assert.match(js, /compileInjection\(chatState, \{[\s\S]*maxTokens:\s*settings\.injectionMaxTokens/);
    assert.match(js, /data-gds-provider="memory"/);
    assert.match(js, /data-gds-provider="director"/);
    assert.match(js, /data-gds-provider="reply"/);
    assert.match(js, /data-gds-api-save/);
    assert.match(js, /data-gds-api-test/);
    assert.match(js, /syncApiFormFromProvider/);
    assert.match(js, /data-gds-api-source/);
    assert.match(js, /modelInput\.value = selectedModel/);
    assert.match(js, /GENERATION_AFTER_COMMANDS/);
    assert.match(js, /setExtensionPrompt\(DIRECTOR_INJECTION_ID/);
    assert.match(js, /data-gds-tab-panel="home"/);
    assert.match(js, /gds-home-card/);
    assert.match(js, /class="gds-page-host"/);
    assert.match(js, /data-gds-tab="connections"/);
    assert.match(js, /setActiveTab\('home'\)/);
});

test('director exposes pacing, branch, foreshadow and toggle controls', () => {
    assert.match(js, /data-gds-director-longline/);
    assert.match(js, /data-gds-director-branch/);
    assert.match(js, /data-gds-director-foreshadow/);
    assert.match(js, /data-gds-director-pacing-custom/);
    assert.match(js, /data-gds-director-toggle="foreshadow"/);
    assert.match(js, /data-gds-director-toggle="autoTrack"/);
    assert.match(js, /buildExecutionCard/);
});

test('director exposes a story calendar with built-ins, custom events and date sync', () => {
    assert.match(js, /data-gds-calendar-enabled/);
    assert.match(js, /data-gds-calendar-builtins/);
    assert.match(js, /data-gds-calendar-auto-advance/);
    assert.match(js, /data-gds-calendar-title/);
    assert.match(js, /data-gds-calendar-rule/);
    assert.match(js, /data-gds-calendar-sync/);
    assert.match(js, /buildCalendarContext/);
    assert.match(js, /故事日期/);
    assert.match(css, /\.gds-calendar-alert/);
});

test('director exposes stop, continue and restart controls', () => {
    assert.match(js, /data-gds-director-stop/);
    assert.match(js, /data-gds-director-continue/);
    assert.match(js, /data-gds-director-restart/);
    assert.match(js, /async function continueDirectorTask/);
    assert.match(js, /async function restartDirectorTask/);
    assert.match(js, /continuationDraft/);
    assert.match(js, /taskState: \{ task, status: 'completed'/);
    assert.match(css, /\.gds-director-task-actions/);
});

test('director exposes a guarded clear-all action and releases stale generation guards', () => {
    assert.match(js, /data-gds-director-clear/);
    assert.match(js, /async function clearDirectorAll/);
    assert.match(js, /主线、分支、伏笔、推进记录、日历事件和未完成草稿都会被删除/);
    assert.match(js, /function reconcileGeneratingFlag/);
    assert.match(js, /const onMessageReceived/);
    assert.match(js, /MESSAGE_RECEIVED: onMessageReceived/);
    assert.match(js, /function hostGenerationActive/);
    assert.match(js, /hostStopControlVisible/);
    assert.match(css, /\.gds-director-task-actions \.gds-danger/);
});

test('keeps switched pages in a dedicated scrolling viewport and resists theme hidden overrides', () => {
    assert.match(css, /\.gds-page-host/);
    assert.match(css, /\.gds-window \[data-gds-tab-panel\]\[hidden\]\s*\{\s*display:\s*none !important/);
    assert.match(css, /overflow:\s*hidden !important/);
    assert.match(js, /pageHost\.scrollTop = 0/);
});

test('reply candidates can be copied or inserted without auto-sending', () => {
    assert.doesNotMatch(js, /待写回复/);
    assert.match(js, /代写回复/);
    assert.match(js, /生成五个候选/);
    assert.match(js, /data-gds-reply-copy/);
    assert.match(js, /data-gds-reply-insert/);
    assert.match(js, /#send_textarea/);
    assert.doesNotMatch(js, /send_message\(/);
    assert.match(css, /\.gds-reply-card textarea[^}]*font-size:\s*13px/);
    assert.match(css, /\.gds-reply-list[^}]*gap:\s*7px/);
});

test('uses the supplied dog image instead of emoji branding', () => {
    assert.match(js, /PANEL_LOGO_URL = new URL\('\.\/assets\/gaga-dog-logo\.png', import\.meta\.url\)/);
    assert.match(js, /FLOATING_LOGO_URL = new URL\('\.\/assets\/gaga-dog-floating\.png', import\.meta\.url\)/);
    assert.match(js, /class="gds-puppy" src="\$\{escapeHtml\(PANEL_LOGO_URL\)\}"/);
    assert.match(js, /class="gds-floating-image" src="\$\{escapeHtml\(FLOATING_LOGO_URL\)\}"/);
    assert.match(js, /class="gds-entry-puppy" src="\$\{escapeHtml\(PANEL_LOGO_URL\)\}"/);
    assert.doesNotMatch(js, /textContent\s*=\s*['"]🐶['"]/);
    assert.match(css, /\.gds-puppy\s*\{[\s\S]*?object-fit:\s*contain/);
    assert.match(css, /\.gds-puppy\s*\{[\s\S]*?border-radius:\s*0/);
    assert.match(css, /\.gds-floating\s*\{[\s\S]*?background:\s*transparent\s*!important/);
    assert.match(css, /\.gds-floating-image\s*\{[^}]*object-fit:\s*contain/);
    assert.match(css, /\.gds-floating-image\s*\{[^}]*border-radius:\s*0/);
});

test('brands the extension as the workshop and exposes local floating icon controls', () => {
    assert.match(js, /const DISPLAY_NAME = '嘎嘎小狗工坊'/);
    assert.match(js, /"?floatingIconSize"?:\s*62/);
    assert.match(js, /floatingIconData:\s*['"]['"]/);
    assert.match(js, /data-gds-floating-size/);
    assert.match(js, /data-gds-floating-upload/);
    assert.match(js, /data-gds-floating-upload-button/);
    assert.match(js, /async function handleFloatingIconUpload/);
    assert.match(js, /function applyFloatingAppearance/);
    assert.match(js, /恢复默认图标/);
    assert.match(css, /\.gds-floating-settings\s*\{/);
    assert.match(css, /\.gds-floating-size input\[type="range"\]/);
    assert.match(css, /\.gds-floating-actions\s*\{[\s\S]*?flex-direction:\s*row/);
    assert.match(css, /\.gds-floating-actions button\s*\{[\s\S]*?white-space:\s*nowrap/);
    assert.match(css, /\.gds-floating-file\s*\{[\s\S]*?display:\s*none/);
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.gds-floating-actions/);
});

test('uses 60000 Token only as the automatic trigger and adapts manual batches', () => {
    assert.match(js, /triggerTokens:\s*60000/);
    assert.match(js, /FALLBACK_BATCH_TOKENS/);
    assert.match(js, /自动总结触发约 Token/);
    assert.match(js, /function planEligibleRange\(ctx\)[\s\S]*?targetTokens:\s*0/);
    assert.match(js, /async function buildWorkflowBatchPlan\(ctx,[\s\S]*?chooseSummaryBatchPlan/);
    assert.match(js, /resolveContextWindowTokens\(ctx\)/);
    assert.match(js, /getTokenCountAsync/);
    assert.match(js, /async function runSummaryWorkflow\(ctx,[\s\S]*?while \(true\)[\s\S]*?await summarizeRange\(/);
    assert.match(js, /pending\.workflow = clone\(workflowInfo\)/);
    assert.doesNotMatch(js, /manualKeepMessages/);
    assert.match(js, /完整旧正文装得下就整段处理，只有装不下时才自适应拆批/);
});

test('floating dog can be dragged without accidentally opening the panel', () => {
    assert.match(js, /floatingPosition:\s*null/);
    assert.match(js, /addEventListener\('pointerdown'/);
    assert.match(js, /addEventListener\('pointermove'/);
    assert.match(js, /setPointerCapture/);
    assert.match(js, /persistFloatingPosition\(completed\.position\)/);
    assert.match(js, /if \(suppressClick\)/);
    assert.match(css, /\.gds-floating\s*\{[\s\S]*?touch-action:\s*none/);
    assert.match(css, /\.gds-floating\.gds-dragging/);
});

test('desktop summary window is draggable by its header', () => {
    assert.match(js, /panelPosition:\s*null/);
    assert.match(js, /function bindPanelDrag\(node, handle\)/);
    assert.match(js, /persistPanelPosition\(completed\.position\)/);
    assert.match(js, /bindPanelDrag\(windowNode, headerNode\)/);
    assert.match(css, /\.gds-window\s*\{[\s\S]*?transform:\s*translate3d\(/);
    assert.match(css, /\.gds-window\.gds-window-dragging \.gds-header/);
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.gds-window\s*\{[\s\S]*?transform:\s*none\s*!important/);
});

test('uses SillyTavern hide and unhide paths for committed ranges', () => {
    assert.match(js, /visibilityCommand\(start, end, hidden\)/);
    assert.match(js, /\/\$\{hidden \? 'hide' : 'unhide'\}/);
    assert.match(js, /await executeSlashCommands\(command\)/);
    assert.match(js, /import\('\/scripts\/chats\.js'\)/);
    assert.match(js, /const hidden = await hideRange\(ctx, range, checkpointId\)/);
    assert.match(js, /const count = await restoreOwnedMessages\(ctx\)/);
});

test('settings entry uses a standard drawer and cannot become vertical text', () => {
    assert.match(js, /extension_container gds-settings-entry/);
    assert.match(js, /inline-drawer-toggle inline-drawer-header/);
    assert.match(css, /\.gds-settings-entry \.gds-open-settings[\s\S]*?white-space:\s*nowrap\s*!important/);
    assert.match(css, /writing-mode:\s*horizontal-tb\s*!important/);
    assert.match(css, /word-break:\s*keep-all\s*!important/);
});
