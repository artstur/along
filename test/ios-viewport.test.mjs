import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installDomStub} from './dom-stub.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the iPhone work area scrolls inside a fixed viewport with a pinned header', async () => {
  installDomStub();
  location.protocol = 'along:';
  const rootClasses = [];
  document.documentElement.classList = {add: name => rootClasses.push(name)};
  await import('../web/app.mjs?ios-viewport');

  assert.ok(rootClasses.includes('along-native'), 'the bundled scheme enables the native layout');
  const css = read('../web/style.css');
  const workArea = css.match(/\.along-native #app\s*\{([^}]+)\}/)?.[1];
  assert.match(workArea ?? '', /position:\s*fixed/);
  assert.match(workArea, /inset:\s*0\b/);
  assert.match(workArea, /overflow-y:\s*auto/);
  const header = css.match(/\.along-native \.topbar\s*\{([^}]+)\}/)?.[1];
  assert.match(header ?? '', /position:\s*sticky/);
  assert.match(header, /top:\s*0\b/);
  assert.match(css, /\.along-native \.agent-shell\s*\{\s*min-height:\s*0\b/);
  assert.match(read('../ios/AlongHealth/Sources/AlongShellView.swift'), /webView\.scrollView\.bounces = false/);
});
