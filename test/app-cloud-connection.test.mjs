import test from 'node:test';
import assert from 'node:assert/strict';
import {installDomStub} from './dom-stub.mjs';

// 归属标识改用 bindingScopeId（docs/iphone-ca-profile-design.md §2.2）：叶指纹不再充当绑定身份。
// 这里用可预期的假值即可——网页只把它当作不透明的归属标识。
const EVENT_HOST={baseURL:'https://event.example.com',token:'b'.repeat(64),bindingScopeId:'scope-event'};
const CLOUD={baseURL:'https://along.example.com',token:'d'.repeat(64),bindingScopeId:'scope-cloud'};
const runtime='dsh-superagent';
const AGENT_KEY='along.agent.v1';
const RUNTIME_KEY='along.agent-runtime.v1';
const EVENT_KEY='along.event-connection.v1';
const GOALS_KEY='along.goal-custom.v1';
const ACTIVE_KEY='along.active-goal.v1';
const RUNS_KEY='along.goal-super-agent-runs.v1';
const CONVERSATIONS_KEY='along.goal-conversations.v1';
const eventStatus={along:true,ready:true,runtime,eventProtocol:1,userId:'u_event'};
const cloudStatus={along:true,ready:true,runtime};
const task={id:'practice',when:'本周',title:'练习一次',detail:'完成一次短练习。',state:'planned'};
const layout={version:1,title:'本周完成三次练习',summary:'先安排一次。',modules:[],tasks:[task],questions:[]};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const read=(dom,key)=>JSON.parse(dom.storage.get(key));
function start(config,bridge,storage={}) {
  const dom=installDomStub({storage:{[AGENT_KEY]:JSON.stringify(config),[RUNTIME_KEY]:runtime,...storage}});
  document.visibilityState='visible';
  location.protocol='along:';
  window.AlongAgentBridge=bridge;
  return dom;
}
function submit(dom,id,fields) {
  assert.ok(dom.app.innerHTML.includes(`id="${id}"`),`${id} must be available in the rendered app`);
  return dom.app.dispatch('submit',{target:{id,fields,querySelector:()=>null,reset(){}},preventDefault(){}});
}
function pair(dom,config) {
  return submit(dom,'pair-form',{baseURL:config.baseURL,code:'12345678'});
}
function done(request,{target=request.goal?.domain==='custom'?null:180,auto=true}={}) {
  return {
    version:1,actual:true,kind:'goal',status:'done',runtime,requestId:request.requestId,
    source:{label:'Along'},trigger:{label:'对话'},agents:[],events:[],input:{goal:request.goal,message:request.message},
    ...(auto?{applyValidatedGoal:true}:{}),
    result:{reply:'已整理这次目标。',proposal:{title:layout.title,target,task:task.title,reason:'按你的要求安排。'},layout},
  };
}

test('a paired event workspace can change Hosts and keeps serving the original Host after a failed pair or Keychain write',async()=>{
  let native=EVENT_HOST, rejectPair=true,rejectSave=true;
  let finishOldSync;let holdOldSync=false;
  const requests=[];
  const dom=start(EVENT_HOST,{
    connection:async (action,value)=>{
      if (action==='load') return native;
      assert.deepEqual(read(dom,AGENT_KEY),EVENT_HOST,'the WebView must still use the old connection during native save');
      if (rejectSave) throw Error('钥匙串写入失败');
      // 原生会补上 bindingScopeId（docs/iphone-ca-profile-design.md §2.2），
      // 网页用的是原生确认过的值，不是自己猜的。
      native={...value,bindingScopeId:value.baseURL===EVENT_HOST.baseURL?EVENT_HOST.bindingScopeId:CLOUD.bindingScopeId};
      return native;
    },
    request:async input=>{
      requests.push(input);
      const oldHost=input.baseURL===EVENT_HOST.baseURL;
      if (input.path==='/connection/status') return oldHost?eventStatus:cloudStatus;
      if (input.path==='/pair') {
        assert.equal(input.token,'','never forward an old bearer when pairing');
        if (rejectPair) throw Error('验证码不正确');
        return {token:CLOUD.token,runtime};
      }
      if (input.path==='/sync') {
        assert.ok(oldHost,'the legacy cloud does not use event sync');
        if (holdOldSync) return new Promise(resolve=>{finishOldSync=resolve;});
        return {items:[]};
      }
      if (input.path==='/super-agent/goals') return {run:done(input.body)};
      throw Error(input.path);
    },
  });
  await import('../web/app.mjs?cloud-switch-from-event');
  await settle();
  assert.ok(dom.app.innerHTML.includes('说说你想做什么'));
  await pair(dom,CLOUD);
  assert.deepEqual(native,EVENT_HOST);
  assert.deepEqual(read(dom,EVENT_KEY),{bindingScopeId:EVENT_HOST.bindingScopeId,userId:'u_event',bindingOrigin:'https://event.example.com:443'});
  assert.match(dom.app.innerHTML,/说说你想做什么/);
  rejectPair=false;
  await pair(dom,CLOUD);
  assert.deepEqual(read(dom,AGENT_KEY),EVENT_HOST);
  assert.deepEqual(read(dom,EVENT_KEY),{bindingScopeId:EVENT_HOST.bindingScopeId,userId:'u_event',bindingOrigin:'https://event.example.com:443'});
  assert.match(dom.app.innerHTML,/说说你想做什么/);

  rejectSave=false;holdOldSync=true;
  await dom.tick(3000);
  assert.ok(finishOldSync);
  await pair(dom,CLOUD);
  assert.deepEqual(native,{...CLOUD,runtime});
  assert.deepEqual(read(dom,AGENT_KEY),{...CLOUD,runtime});
  assert.equal(read(dom,EVENT_KEY),null);
  assert.match(dom.app.innerHTML,/整条目标编排链路可用/);
  finishOldSync({items:[{seq:1,userId:'u_event',kind:'message',payload:{conversation_id:'old',
    message:{id:'m_old',role:'assistant',direction:'outbound',eventId:'old',text:'迟到的原服务消息',seq:1}}}]});
  await settle();
  assert.doesNotMatch(dom.app.innerHTML,/迟到的原服务消息/);
  assert.equal(requests.some(input=>input.path==='/sync/ack'),false);
  await submit(dom,'agent-form',{message:'把我的目标更新到每周 180 分钟'});
  assert.equal(read(dom,'along.health.v1').goals.find(goal=>goal.type==='workout').target,180);
});

test('re-pairing to an event-capable cloud Host detaches a pending cloud status response and restores the event workspace',async()=>{
  let finishPoll;
  const requests=[];
  const dom=start(CLOUD,{connection:async (action,value)=>{
    if (action==='load') return null;
    // 原生会补上 bindingScopeId（docs/iphone-ca-profile-design.md §2.2）。
    return {...value,bindingScopeId:value.baseURL===EVENT_HOST.baseURL?EVENT_HOST.bindingScopeId:CLOUD.bindingScopeId};
  },request:async input=>{
    requests.push(input);
    if (input.path==='/connection/status') return input.baseURL===EVENT_HOST.baseURL?eventStatus:cloudStatus;
    if (input.path==='/pair') return {token:EVENT_HOST.token};
    if (input.path==='/sync') return {items:[]};
    if (input.path==='/super-agent/goals/status') return new Promise(resolve=>{finishPoll=resolve;});
    throw Error(input.path);
  }},{[RUNS_KEY]:JSON.stringify({['health:'+runtime]:{...done({requestId:'req_old',goal:{domain:'health'}}),status:'working',result:null}})});
  await import('../web/app.mjs?cloud-switch-to-event');
  await dom.click({action:'edit-goal'});
  await dom.tick(3000);
  assert.ok(finishPoll);
  await pair(dom,EVENT_HOST);
  finishPoll(done({requestId:'req_old',goal:{domain:'health'}}));
  await settle();
  assert.deepEqual(read(dom,AGENT_KEY),EVENT_HOST);
  assert.deepEqual(read(dom,EVENT_KEY),{bindingScopeId:EVENT_HOST.bindingScopeId,userId:'u_event',bindingOrigin:'https://event.example.com:443'});
  assert.ok(requests.some(input=>input.path==='/sync'&&input.token===EVENT_HOST.token));
  assert.doesNotMatch(dom.app.innerHTML,/已整理这次目标|本周完成三次练习/);
  assert.equal(read(dom,GOALS_KEY)?.health,undefined);
  assert.equal(read(dom,CONVERSATIONS_KEY)?.health?.some(item=>item.requestId==='req_old')??false,false);
});

test('a cloud connection selects its available runtime after the first pair',async()=>{
  const statuses=[];
  const dom=start({}, {request:async ({path,body})=>{
    if (path==='/pair') return {token:CLOUD.token,runtime};
    if (path==='/connection/status') {statuses.push(body.runtime);return cloudStatus;}
    throw Error(path);
  }},{[RUNTIME_KEY]:'kimi-code-swarm'});
  await import('../web/app.mjs?cloud-pair-runtime');
  await dom.click({action:'edit-goal'});
  await pair(dom,CLOUD);
  assert.deepEqual(statuses,[runtime]);
  assert.equal(dom.storage.get(RUNTIME_KEY),runtime);
  assert.match(dom.app.innerHTML,/整条目标编排链路可用/);
});

test('cloud Keychain restoration works with empty WebView storage',async()=>{
  const statuses=[];
  const dom=installDomStub();
  document.visibilityState='visible';
  window.AlongAgentBridge={
    connection:async action=>action==='load'?{...CLOUD,runtime}:null,
    request:async ({path,body})=>{
      if (path!=='/connection/status') throw Error(path);
      statuses.push(body.runtime);
      return cloudStatus;
    },
  };
  await import('../web/app.mjs?cloud-restore-runtime');
  await settle();
  await dom.click({action:'edit-goal'});
  await settle();
  assert.ok(statuses.length>0&&statuses.every(value=>value===runtime));
  assert.equal(dom.storage.get(RUNTIME_KEY),runtime);
  assert.match(dom.app.innerHTML,/整条目标编排链路可用/);
});

test('a completed cloud goal submission applies to the existing goal without an adoption preview',async()=>{
  const dom=start(CLOUD,{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals') return {run:done(body)};
    throw Error(path);
  }});
  await import('../web/app.mjs?cloud-auto-apply-existing');
  await dom.click({action:'edit-goal'});
  await submit(dom,'agent-form',{message:'把我的目标更新到每周 180 分钟'});
  assert.equal(read(dom,GOALS_KEY)?.health?.title,layout.title);
  assert.equal(read(dom,GOALS_KEY)?.health?.target,180);
  assert.match(dom.app.innerHTML,/已整理这次目标/);
  assert.doesNotMatch(dom.app.innerHTML,/data-action="accept-goal"/);
  await dom.click({action:'agent-back'});
  assert.match(dom.app.innerHTML,/练习一次/);
});

test('a cloud goal completed by polling creates the first custom goal and its task once',async()=>{
  let request;
  let polls=0;
  const dom=start(CLOUD,{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals') {
      request=body;
      return {run:{...done(body),status:'working',result:null}};
    }
    if (path==='/super-agent/goals/status') {
      assert.equal(body.requestId,request.requestId);
      polls++;
      const run=done(request);
      return {...run,result:{...run.result,proposal:null}};
    }
    throw Error(path);
  }});
  await import('../web/app.mjs?cloud-auto-apply-first-custom');
  await dom.click({action:'new-goal'});
  const key=dom.storage.get(ACTIVE_KEY);
  await submit(dom,'agent-form',{message:'我想每周练习三次'});
  await dom.tick(3000);
  await settle();
  assert.equal(read(dom,'along.adaptive-layouts.v1')[key].title,layout.title);
  assert.match(dom.app.innerHTML,/练习一次/);
  await dom.click({action:'edit-goal'});
  await dom.tick(3000);
  assert.equal(polls,1);
  assert.equal(read(dom,CONVERSATIONS_KEY)[key].filter(item=>item.role==='assistant').length,1);
  assert.doesNotMatch(dom.app.innerHTML,/data-action="accept-goal"/);
});

test('polling a validated cloud completion respects a locally restricted request',async()=>{
  const request={requestId:'req_private',goal:{domain:'health'},message:'仅在这台手机上保存'};
  const dom=start(CLOUD,{request:async ({path})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals/status') return done(request);
    throw Error(path);
  }},{
    [RUNS_KEY]:JSON.stringify({['health:'+runtime]:{...done(request),status:'working',result:null}}),
    'along.health-sharing.v1':JSON.stringify({oldRuns:[request.requestId]}),
  });
  await import('../web/app.mjs?cloud-local-only');
  await dom.click({action:'edit-goal'});
  await dom.tick(3000);
  await settle();
  assert.equal(read(dom,GOALS_KEY)?.health,undefined);
  assert.equal(read(dom,CONVERSATIONS_KEY).health[0].localOnly,true);
  assert.match(dom.app.innerHTML,/已整理这次目标/);
  assert.doesNotMatch(dom.app.innerHTML,/data-action="accept-goal"/);
});

test('cloud chat recovers a lost submit receipt after restart without resending',async()=>{
  const config={...CLOUD,runtime};
  let request;
  const dom=start(config,{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals') {request=body;throw Error('网络连接中断');}
    throw Error(path);
  }});
  await import('../web/app.mjs?cloud-lost-receipt');
  await dom.click({action:'edit-goal'});
  await submit(dom,'agent-form',{message:'把目标调整成每周 180 分钟'});
  assert.equal(read(dom,RUNS_KEY)['health:'+runtime].status,'working');
  const calls=[];
  const reopened=start(config,{request:async ({path,body})=>{
    calls.push(path);
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals/status') {
      assert.equal(body.requestId,request.requestId);
      return done(request);
    }
    throw Error(path);
  }},Object.fromEntries(dom.store));
  await import('../web/app.mjs?cloud-reopened-after-lost-receipt');
  await settle();
  await reopened.tick(3000);
  await settle();
  await reopened.tick(3000);
  assert.equal(read(reopened,GOALS_KEY).health.target,180);
  assert.equal(read(reopened,CONVERSATIONS_KEY).health.filter(item=>item.requestId===request.requestId).length,1);
  assert.equal(calls.filter(path=>path==='/super-agent/goals/status').length,1);
  assert.ok(!calls.includes('/super-agent/goals'));
});

test('an expired cloud submit without an acknowledgement stops after looking up its original request',async()=>{
  const request={requestId:'req_never_admitted',goal:{domain:'health'},message:'每周练习三次'};
  const dom=start({...CLOUD,runtime},{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    assert.equal(path,'/super-agent/goals/status');
    assert.equal(body.requestId,request.requestId);
    throw Error('运行记录不存在');
  }},{
    [RUNS_KEY]:JSON.stringify({['health:'+runtime]:{...done(request),actual:false,status:'working',result:null,createdAt:Date.now()-60_000}}),
  });
  await import('../web/app.mjs?cloud-receipt-recovery-expired');
  await settle();
  await dom.tick(3000);
  await settle();
  assert.equal(read(dom,RUNS_KEY)['health:'+runtime].status,'blocked');
});

test('a cloud goal continues recovering on another goal screen after a temporary network error',async()=>{
  const request={requestId:'req_cloud_accepted',goal:{domain:'health'},message:'每周练习三次'};
  let polls=0;
  const dom=start({...CLOUD,runtime},{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    assert.equal(path,'/super-agent/goals/status');
    assert.equal(body.requestId,request.requestId);
    if (++polls===1) throw Error('网络连接中断');
    return done(request);
  }},{
    [ACTIVE_KEY]:'finance',
    [RUNS_KEY]:JSON.stringify({['health:'+runtime]:{...done(request),actual:false,status:'working',result:null,createdAt:Date.now()-60_000}}),
  });
  await import('../web/app.mjs?cloud-receipt-transient');
  await settle();
  await dom.tick(3000);
  await settle();
  assert.equal(polls,1);
  assert.equal(read(dom,RUNS_KEY)['health:'+runtime].status,'working');
  await dom.tick(3000);
  await settle();
  assert.equal(polls,2);
  assert.equal(read(dom,GOALS_KEY).health.target,180);
  assert.equal(dom.storage.get(ACTIVE_KEY),'finance');
});

test('a blocked or mismatched cloud run cannot change an existing goal',async()=>{
  let blocked=true;
  const dom=start(CLOUD,{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals') {
      if (blocked) return {run:{...done(body),status:'blocked',result:null,error:'目标变化没有通过校验'}};
      return {run:done({...body,requestId:'req_other'})};
    }
    throw Error(path);
  }});
  await import('../web/app.mjs?cloud-blocked-or-mismatched');
  await dom.click({action:'edit-goal'});
  await submit(dom,'agent-form',{message:'把我的目标更新到每周 180 分钟'});
  assert.match(dom.app.innerHTML,/目标变化没有通过校验/);
  blocked=false;
  await submit(dom,'agent-form',{message:'改成每周 180 分钟'});
  assert.match(dom.app.innerHTML,/没有返回与本次请求匹配的目标编排记录/);
  assert.equal(read(dom,GOALS_KEY)?.health,undefined);
  assert.equal(read(dom,CONVERSATIONS_KEY).health.some(item=>item.role==='assistant'),false);
});

test('legacy protocol submissions retain their adoption preview',async()=>{
  const dom=start(EVENT_HOST,{request:async ({path,body})=>{
    if (path==='/connection/status') return cloudStatus;
    if (path==='/super-agent/goals') return {run:done(body,{auto:false})};
    throw Error(path);
  }});
  await import('../web/app.mjs?legacy-protocol-preview');
  await dom.click({action:'edit-goal'});
  await submit(dom,'agent-form',{message:'把我的目标更新到每周 180 分钟'});
  assert.equal(read(dom,GOALS_KEY)?.health,undefined);
  assert.match(dom.app.innerHTML,/data-action="accept-goal"/);
});
