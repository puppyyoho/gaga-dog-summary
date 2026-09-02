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
    assert.match(css, /overflow-y:\s*auto\s*!important/);
    assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
});

test('mobile header remains reachable and fields cannot overflow horizontally', () => {
    assert.match(css, /\.gds-header\s*\{[\s\S]*?position:\s*sticky/);
    assert.match(css, /\.gds-field textarea\s*\{[\s\S]*?max-width:\s*100%\s*!important/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('settings checkboxes have a high-contrast custom checked state', () => {
    assert.match(css, /\.gds-settings-grid input\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none/);
    assert.match(css, /\.gds-settings-grid input\[type="checkbox"\]:checked\s*\{[\s\S]*?background:\s*var\(--gds-pink-deep\)/);
    assert.match(css, /\.gds-settings-grid input\[type="checkbox"\]:checked::after/);
    assert.match(css, /background-image:\s*url\("data:image\/svg\+xml/);
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
    assert.match(js, /检查点已保存，但文学前情为空/);
    assert.match(js, /function savedRecap\(chatState\)/);
    assert.match(js, /status === 'committed' && String\(item\.recap/);
});

test('uses a 60000 Token default and labels it as a per-batch target', () => {
    assert.match(js, /triggerTokens:\s*60000/);
    assert.match(js, /每批总结约 Token/);
    assert.match(js, /targetTokens:\s*settings\.triggerTokens/);
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
