import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Bug#5：App 页面被双指捏合整体放大。
//
// 不变量：App 内置页面（along://）的比例固定在 1 倍——双指张开、双指收拢都不改变页面比例；
// 单指滚动、点按、输入照旧；网页版本不跟着锁（静态 viewport 仍然允许缩放）。
//
// 修在页面层：index.html 在 head 里就地改写 viewport，只有 along:// 的内置页面才锁。
// 为什么是这一层（模拟器实测，详见 docs/bugfix-pinch-page-zoom.md）：
//   - 原生容器锁不住：关掉 scrollView 的捏合识别器、把缩放范围收成 1 倍，页面照样放大 1.56～1.84 倍；
//   - CSS 也锁不住：touch-action: pan-x pan-y 拦不住双指缩放（实测放大 1.68 倍），
//     none 能拦住但会连单指滚动一起关掉；
//   - viewport 能拦住：WKWebView 认 user-scalable=no / maximum-scale=1，两个方向都拦得住。
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

const index = read('../web/index.html');
const viewport = index.match(/<meta name="viewport" content="([^"]*)"/)?.[1] ?? '';
const locked = index.match(/content = '([^']*maximum-scale[^']*)'/)?.[1] ?? '';

test('the App locks page zoom and the web version keeps its own', () => {
  assert.ok(viewport, 'index.html 必须声明 viewport');
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i, '静态 viewport 不能全局禁掉缩放：网页版本不跟着锁');
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1(\b|$)/, '静态 viewport 不能全局禁掉缩放：网页版本不跟着锁');

  assert.ok(locked, 'index.html 必须有一份锁缩放的 viewport 内容');
  assert.match(locked, /maximum-scale=1/, '锁缩放要收掉缩放上限');
  assert.match(locked, /user-scalable=no/, '锁缩放要禁掉用户缩放');
  assert.match(locked, /width=device-width/, '锁缩放不能改布局宽度');
  assert.match(locked, /initial-scale=1/, '锁缩放不能改初始比例');
});

test('the zoom lock only applies to the bundled App pages', () => {
  assert.match(index, /location\.protocol === 'along:'/, '锁缩放只对 App 内置页面生效：网页版本仍可缩放');
  const guard = index.match(/if \(([^)]*)\) \{[^}]*content = '[^']*maximum-scale/)?.[1] ?? '';
  assert.equal(guard.trim(), "location.protocol === 'along:'", '锁缩放的条件只能是 App 内置页面');
});

test('the zoom lock is in place before the first layout', () => {
  const scriptAt = index.indexOf("maximum-scale=1, user-scalable=no");
  const stylesheetAt = index.indexOf('<link rel="stylesheet"');
  const moduleAt = index.indexOf('<script type="module"');
  assert.ok(scriptAt > 0, '找不到锁缩放的那段脚本');
  assert.ok(scriptAt < stylesheetAt, '锁缩放要在样式表之前生效：晚于首次布局就来不及了');
  assert.ok(scriptAt < moduleAt, '锁缩放要在模块脚本之前生效：模块脚本是延迟加载的');
});

test('the App bundled assets ship the same zoom lock', () => {
  const bundled = read('../ios/AlongHealth/Web/index.html');
  assert.equal(bundled, index, 'App 内置产物必须和 web/index.html 一致，否则手机上跑的还是旧页面');
});
