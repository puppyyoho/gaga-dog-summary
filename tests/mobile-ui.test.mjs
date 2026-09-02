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
});

test('settings entry uses a standard drawer and cannot become vertical text', () => {
    assert.match(js, /extension_container gds-settings-entry/);
    assert.match(js, /inline-drawer-toggle inline-drawer-header/);
    assert.match(css, /\.gds-settings-entry \.gds-open-settings[\s\S]*?white-space:\s*nowrap\s*!important/);
    assert.match(css, /writing-mode:\s*horizontal-tb\s*!important/);
    assert.match(css, /word-break:\s*keep-all\s*!important/);
});
