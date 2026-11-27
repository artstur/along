import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// 网页端的文档滚动就是正常浏览（滚轮往下、按 End 到页尾）。
// 软键盘那次复位是为原生壳修的：原生壳的页面主体是 position:fixed，iOS 为露出输入框
// 滚动文档时会把整个界面顶出可视区。复位一旦漏到网页端，网页就没法往下看了。
test('the document scroll reset stays inside the native shell', () => {
  const source = read('../web/app.mjs');
  assert.match(source, /const nativePage = location\.protocol === 'along:';/,
    'the native shell is detected by the along: scheme');
  const reset = source.match(/function resetDocumentScroll\(\)\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(reset, /nativePage\s*&&\s*window\.scrollY/,
    'the document scroll reset must only run in the native shell');
  assert.match(source, /if\s*\(nativePage\)\s*window\.addEventListener\('scroll'/,
    'the scroll listener must only be registered in the native shell');
});

test('the web page keeps a scrollable document', () => {
  const css = read('../web/style.css');
  assert.doesNotMatch(css, /(^|[,{\s])html\s*,\s*body\s*\{[^}]*overflow:\s*hidden/,
    'the web document must not be locked against scrolling');
  assert.doesNotMatch(css, /body\s*\{[^}]*overflow:\s*hidden/,
    'the web document must not be locked against scrolling');
  assert.match(css, /\.along-native #app\s*\{[^}]*overflow-y:\s*auto/,
    'the native shell scrolls inside #app, not by locking the document');
});
