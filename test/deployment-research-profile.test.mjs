import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';

test('cloud profile explicitly selects Along research providers without forwarding the original private question',()=>{
  const entries=parse(readFileSync(new URL('../deploy/superagent-profile.patch.yml',import.meta.url),'utf8'));
  const settings=id=>entries.find(entry=>entry.id===id)?.config;
  assert.equal(settings('web')?.searchProvider,'deepseek-search-api');
  assert.equal(settings('web')?.fetchProvider,'deepseek-fetch-api');
  assert.equal(settings('web-deepseek-api')?.sendOriginalQuestion,false);
  assert.equal(settings('web-deepseek-api')?.apiKey,undefined,'provider secrets stay outside the public profile');
});
