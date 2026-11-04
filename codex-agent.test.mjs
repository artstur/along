import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Codex output schemas forbid arbitrary properties and require a declarative layout',async()=>{
  const schema=JSON.parse(await readFile(new URL('./schemas/goal-chat.schema.json',import.meta.url),'utf8'));
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual(schema.required,['reply','proposal','layout']);
  assert.equal(schema.properties.layout.additionalProperties,false);
  assert.equal(schema.properties.layout.properties.modules.maxItems,6);
  assert.deepEqual(schema.properties.layout.properties.modules.items.properties.kind.enum,['summary','fact_list','chips','metric']);
  assert.equal(schema.properties.layout.properties.modules.items.additionalProperties,false);
});
