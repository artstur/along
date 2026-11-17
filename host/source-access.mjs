import {HostError} from './host-error.mjs';

export function validateOkxSourceRequest(input) {
  if(!input||Array.isArray(input)||typeof input!=='object'||
    typeof input.goalId!=='string'||!/^g_[A-Za-z0-9_-]{1,100}$/.test(input.goalId)||
    !['status','connect','refresh','disconnect'].includes(input.action)||
    Object.keys(input).some(k=>!['action','goalId','site','credentials'].includes(k))||
    (input.action!=='connect'&&('credentials' in input||'site' in input))) {
    throw new HostError('连接请求无效，请重新打开目标',400);
  }
  return input;
}

export function requireOkxGoal(detail,who,goalId) {
  const goal=detail?.goal,revision=detail?.revision;
  if(goal?.id!==goalId||goal.userId!==who.userId||goal.status!=='active'||
    revision?.goalId!==goalId||revision.userId!==who.userId||revision.status!=='active'||
    revision.revision!==goal.currentRevision||
    !detail?.dataSources?.some(source=>source.provider==='okx'&&source.status==='recommended')) {
    throw new HostError('这个目标当前无法连接 OKX，请同步目标后重试',403);
  }
}
