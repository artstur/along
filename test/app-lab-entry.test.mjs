import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

test('the documented goal-change experiment is reachable from the health goal page',async()=>{
  const dom=installDomStub({});
  await import('../web/app.mjs');
  assert.match(dom.app.innerHTML,/data-action="open-lab"/,'健康目标页应该保留「目标变化实验」入口');
  await dom.click({action:'open-lab'});
  assert.match(dom.app.innerHTML,/当进度变化，下一步会怎样变？/);
});
