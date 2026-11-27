import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installDomStub} from './dom-stub.mjs';

// Bug#4：iPhone App 里连点左上角品牌图标会触发 iOS 双击缩放（smart zoom），页面被放大并移位。
// 不变量：品牌区关掉双击缩放，同时保住从品牌区起手的单指滚动与双指缩放。
//
// 为什么是 manipulation 而不是 none：
//   - WebCore（Source/WebCore/platform/TouchAction.h）：
//     touchActionAllowsDoubleTapToZoom = !t.containsAny({None, Manipulation})
//     即 none 与 manipulation 都能关掉双击缩放；但 CSS 的列表写法
//     pan-x pan-y pinch-zoom 不带 Manipulation 位，照旧会双击缩放。
//   - iOS 手势层（Source/WebKit/UIProcess/ios/WKTouchActionGestureRecognizer.mm）：
//     只有 none 能禁掉双击缩放——用 none 会把品牌区起手的滚动与双指缩放一起关掉
//     （模拟器实测：滚动位移 0.00pt、放大 1.000 倍），那是上一轮被打回的回归。
//   - 实测（iPhone 17 Pro 模拟器，iOS 26.3.1）：manipulation 既挡住双击缩放，
//     又保住品牌区起手的滚动（-42.71pt）与双指缩放（1.48～1.60 倍）。
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// 取某条规则的声明体（只取第一条同名规则，避免匹配到 .brand-symbol 之类）。
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  assert.equal(matches.length, 1, `${selector} 应该只有一条规则，实际 ${matches.length} 条`);
  return matches[0][1];
}

function touchAction(css, selector) {
  return rule(css, selector).match(/touch-action:\s*([^;]+);/)?.[1]?.trim() ?? '';
}

test('the brand area opts out of double-tap zoom while keeping scroll and pinch zoom', () => {
  const css = read('../web/style.css');
  const value = touchAction(css, '.brand');
  assert.equal(value, 'manipulation', '品牌区要用 touch-action: manipulation：关掉双击缩放，保留滚动与双指缩放');
  assert.doesNotMatch(value, /(^|\s)none(\s|$)/, '不能用 none：那会把品牌区起手的滚动与双指缩放一起关掉');
  assert.doesNotMatch(value, /(^|\s)auto(\s|$)/, 'auto 等于没声明，双击缩放照旧');
  assert.doesNotMatch(value, /pan-x|pan-y|pinch-zoom/, 'pan 列表不带 WebCore 的 Manipulation 位，双击缩放照旧');
});

test('the brand icon does not kill the gestures of the whole brand area', () => {
  const css = read('../web/style.css');
  const value = touchAction(css, '.brand-symbol');
  assert.doesNotMatch(value, /(^|\s)none(\s|$)/, '图标上不能用 none，否则从图标起手的滚动与双指缩放会被关掉');
});

test('the rule targets the brand markup the user actually taps', async () => {
  const dom = installDomStub();
  location.protocol = 'along:';
  document.documentElement.classList = {add() {}};
  await import('../web/app.mjs?brand-double-tap');
  assert.match(dom.app.innerHTML, /class="brand"/, '首页必须渲染品牌区，否则这条 CSS 规则打不到用户点的元素');
  assert.match(dom.app.innerHTML, /class="brand-symbol"/, '品牌区里必须有那个图标');
});

test('the web version keeps pinch zoom while the App locks it at runtime', () => {
  // 契约变更（Bug#5，2026-11-28）：App 内置页面现在整体禁掉双指缩放，网页版本不跟着锁。
  // 所以静态 viewport 仍然不能全局禁掉缩放——网页版本要保留双指缩放。
  // App 侧的锁由 index.html 里那段 along: 判断负责，见 test/ios-page-zoom-lock.test.mjs。
  const viewport = read('../web/index.html').match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? '';
  assert.ok(viewport, 'index.html 必须声明 viewport');
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i, '网页版本不跟着锁缩放：静态 viewport 不能全局禁掉双指缩放');
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1(\b|$)/, '网页版本不跟着锁缩放：静态 viewport 不能全局禁掉双指缩放');
});

test('the App bundled assets ship the same rule', () => {
  const bundled = read('../ios/AlongHealth/Web/style.css');
  assert.equal(touchAction(bundled, '.brand'), 'manipulation', 'App 内置产物必须带上这条声明，否则手机上跑的还是旧页面');
  assert.doesNotMatch(touchAction(bundled, '.brand-symbol'), /(^|\s)none(\s|$)/, 'App 产物里图标也不能用 none');
});
