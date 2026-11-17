import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOkxSourceRequest,requireOkxGoal} from '../host/source-access.mjs';
const who={userId:'u_one'},goalId='g_one';
const goal=()=>({goal:{id:goalId,userId:who.userId,status:'active',currentRevision:3},
  revision:{goalId,userId:who.userId,status:'active',revision:3},dataSources:[{provider:'okx',status:'recommended'}]});
test('source connection requires the current owned active goal and its trusted recommendation',()=>{
  requireOkxGoal(goal(),who,goalId);
  for(const alter of [d=>d.goal.userId='u_other',d=>d.goal.id='g_other',d=>d.goal.status='paused',d=>d.revision.revision=2,
    d=>d.revision.userId='u_other',d=>d.dataSources=[],d=>d.dataSources[0].status='connected']) {
    const detail=goal();alter(detail);assert.throws(()=>requireOkxGoal(detail,who,goalId),/无法连接/);
  }
});
test('source route refuses claimed identities and arbitrary URLs before connection work',()=>{
  const input={action:'status',goalId};assert.equal(validateOkxSourceRequest(input),input);
  for(const value of [{...input,user_id:'u_other'},{...input,baseURL:'https://evil.test'},
    {...input,credentials:{}},{...input,action:'trade'},{...input,goalId:'../../g_one'},null]) {
    assert.throws(()=>validateOkxSourceRequest(value),/连接请求无效/);
  }
});
