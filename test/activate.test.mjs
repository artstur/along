import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {Document, parseDocument} from 'yaml';
import {acquireLock, configureModel, desktopModelEntries, freePort, hasCredential, patchDocument, Processes, promptLine, selectedModel, writePrivate} from '../tools/activate.mjs';

function temporary(t) {
  const root=mkdtempSync(join(tmpdir(),'along-activate-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
const paths={state:'/test/dsh',data:'/test/data',bridge:'/test/data/bridge-token'};
function configured() {
  const model=new Document([
    {id:'llm-pi-ai',config:{providers:{sample:{apiKeyEnv:'SAMPLE_API_KEY',api:'openai-completions',baseURL:'https://example.com/v1',models:[{id:'test-model'}]}}}},
    {id:'agent-default-model',config:{provider:'sample',model:'test-model',reasoningEffort:'low'}},
  ]);
  return patchDocument(paths,model.contents.items);
}

test('activation copies only model config and preserves tagged YAML without executing it',t=>{
  const root=temporary(t),file=join(root,'desktop.yml');
  writeFileSync(file,`- id: llm-pi-ai
  config:
    providers:
      sample:
        apiKeyEnv: SAMPLE_API_KEY
- id: agent-default-model
  config:
    provider: sample
    model: test-model
- id: dangerous-plugin
  name: !!js (() => { throw new Error('must never execute'); })()
- id: dsh-superagent
  config:
    stateDir: /old/personal/state
`);
  const doc=patchDocument(paths,desktopModelEntries(file));
  const rendered=doc.toString();
  assert.equal(doc.contents.items.length,6);
  assert.equal(selectedModel(doc).provider,'sample');
  assert.ok(!rendered.includes('dangerous-plugin'));
  assert.ok(!rendered.includes('/old/personal/state'));
  assert.ok(rendered.includes('/test/dsh'));
});

test('invalid YAML diagnostics do not contain credential values',t=>{
  const root=temporary(t),file=join(root,'bad.yml');
  writeFileSync(file,'[sample-secret-value: [');
  assert.throws(()=>desktopModelEntries(file),error=>!error.message.includes('sample-secret-value')&&error.message.includes('YAML'));
});

test('missing key is prompted hidden, persisted privately and reused on a later run',async t=>{
  const root=temporary(t),credentials=join(root,'model-credentials.yaml'),doc=configured();
  const calls=[];
  await configureModel(doc,{home:root,credentials,env:{},ask:async(label,options)=>{
    calls.push({label,options}); return 'synthetic-secret-value';
  }});
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.secret,true);
  assert.equal(statSync(credentials).mode&0o777,0o600);
  assert.equal(parseDocument(readFileSync(credentials,'utf8')).getIn(['refs','SAMPLE_API_KEY']),'synthetic-secret-value');
  assert.ok(!doc.toString().includes('synthetic-secret-value'));
  const reloaded=parseDocument(doc.toString());
  await configureModel(reloaded,{home:root,credentials,env:{},ask:()=>assert.fail('saved key must not be prompted again')});
  assert.equal(reloaded.toString(),doc.toString());
});

test('DSH-managed, environment and owner-record credentials avoid prompting',async t=>{
  const root=temporary(t),global=join(root,'.credentials.yaml');
  for (const value of [
    {version:1,refs:{SAMPLE_API_KEY:'managed-value'}},
    {version:1,records:{'llm-pi-ai/sample':{kind:'api-key',key:'record-value'}}},
  ]) {
    writePrivate(global,new Document(value).toString());
    await configureModel(configured(),{home:root,credentials:join(root,'local.yml'),env:{},ask:()=>assert.fail('existing credentials should be reused')});
  }
  rmSync(global);
  await configureModel(configured(),{home:root,credentials:join(root,'local.yml'),env:{SAMPLE_API_KEY:'environment-value'},ask:()=>assert.fail('environment should be reused')});
});

test('fresh model configuration asks for URL, model, protocol and hidden key',async t=>{
  const root=temporary(t),doc=patchDocument(paths);
  const answers=['https://example.com/v1','my-model','2','sample-new-secret'];
  const options=[];
  await configureModel(doc,{home:root,credentials:join(root,'credentials.yaml'),env:{},ask:async(label,config)=>{
    options.push(config); return answers.shift();
  }});
  const selected=selectedModel(doc);
  assert.equal(selected.model,'my-model');
  assert.equal(selected.providerConfig.api,'anthropic-messages');
  assert.equal(options.at(-1).secret,true);
  assert.ok(!doc.toString().includes('sample-new-secret'));
  assert.equal(answers.length,0);
});

test('catalog model without explicit provider config can reuse its conventional key',async t=>{
  const root=temporary(t),doc=patchDocument(paths);
  doc.contents.items.push(doc.createNode({id:'agent-default-model',config:{provider:'openai',model:'catalog-model'}}));
  await configureModel(doc,{home:root,credentials:join(root,'credentials.yml'),env:{OPENAI_API_KEY:'existing-key'},ask:()=>assert.fail('catalog key should be reused')});
  assert.equal(selectedModel(doc).providerConfig.apiKeyEnv,'OPENAI_API_KEY');
  assert.ok(!doc.toString().includes('existing-key'));
});

test('bad inputs and noninteractive missing credentials fail without echoing key data',async t=>{
  const root=temporary(t);
  await assert.rejects(configureModel(configured(),{home:root,credentials:join(root,'creds.yml'),env:{},ask:async()=>''}),/API Key 不能为空/);
  await assert.rejects(configureModel(patchDocument(paths),{home:root,credentials:join(root,'creds.yml'),env:{},ask:async()=>'https://secret-user:secret-pass@example.com'}),error=>!error.message.includes('secret-pass'));
  await assert.rejects(promptLine('API Key：',{secret:true,input:{isTTY:false},output:{isTTY:false}}),/本机终端/);
  writeFileSync(join(root,'unsafe.yml'),'version: 1\nrefs:\n  SAMPLE_API_KEY: private-value\n',{mode:0o644});
  assert.throws(()=>hasCredential('SAMPLE_API_KEY',[join(root,'unsafe.yml')],{}),error=>error.message.includes('0600')&&!error.message.includes('private-value'));
});

test('atomic private replacement keeps new permissions and refuses concurrent launcher ownership',t=>{
  const root=temporary(t),file=join(root,'private.yml');
  writeFileSync(file,'old',{mode:0o644});
  writePrivate(file,'new');
  assert.equal(readFileSync(file,'utf8'),'new');
  assert.equal(statSync(file).mode&0o777,0o600);
  const release=acquireLock(join(root,'launcher.pid'));
  try {assert.throws(()=>acquireLock(join(root,'launcher.pid')),/已在运行/);} finally {release();}
  acquireLock(join(root,'launcher.pid'))();
});

test('port check uses the exact listening address and leaves an existing server running',async()=>{
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  try {await assert.rejects(freePort(port),/已被占用/);assert.equal(server.listening,true);}
  finally {await new Promise(resolve=>server.close(resolve));}
  await freePort(port);
});

test('process owner observes launch failures and closes only its own children',async t=>{
  const owner=new Processes(),other=new Processes();
  t.after(async()=>{await owner.stop();await other.stop();});
  const waiting='process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000);console.log("ready")';
  const owned=owner.start(process.execPath,['-e',waiting],{stdio:['ignore','pipe','ignore']});
  const external=other.start(process.execPath,['-e',waiting],{stdio:['ignore','pipe','ignore']});
  await Promise.all([once(owned.stdout,'data'),once(external.stdout,'data')]);
  await owner.stop();
  assert.equal(owned.exitCode,0);
  assert.equal(external.exitCode,null);
  assert.equal(other.children.size,1);
  await assert.rejects(new Processes().run('/no/such/along-command',[]),/执行未完成/);
  assert.throws(()=>owner.start(process.execPath,[]),/已取消/);
});
