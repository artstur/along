import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// The phone must already hold this goal's previous DSH receipt. Pairing alone
// does not identify which of its goal spaces the Mac user delegated.
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(value);
const isGoal=value=>value==='health'||typeof value==='string'&&/^custom:[a-zA-Z0-9_-]{1,80}$/.test(value);
function filename(dir,pair,goal,anchor) {
  if (!/^[a-f0-9]{64}$/.test(pair)||!isGoal(goal)||!identifier(anchor)) throw Error('每日安排缺少目标或原工单');
  return join(dir,'daily-grant-'+createHash('sha256').update(JSON.stringify([pair,goal,anchor])).digest('hex')+'.json');
}
function validated(input) {
  if (!input||!identifier(input.id)||!isGoal(input.goalKey)||!identifier(input.requestId)||!identifier(input.ticketId)||
      !Array.isArray(input.topics)||!input.topics.length||input.topics.length>2||!input.topics.every(t=>t==='sleep'||t==='workout')||
      new Set(input.topics).size!==input.topics.length) throw Error('每日委托无效');
  const weekly=input.weeklyWorkoutMinutes??null;
  if (weekly!==null&&(!input.topics.includes('workout')||!Number.isInteger(weekly)||weekly<=0||weekly>10080)) throw Error('每周运动目标无效');
  return {id:input.id,goalKey:input.goalKey,requestId:input.requestId,ticketId:input.ticketId,topics:input.topics,weeklyWorkoutMinutes:weekly};
}
export function registerDailyGrant(dir,pair,anchor,input,now=Date.now()) {
  const grant=validated(input),file=filename(dir,pair,grant.goalKey,anchor),temp=file+'.'+randomUUID();
  writeFileSync(temp,JSON.stringify({grant,expires:now+36*3600000}),{mode:0o600,flag:'wx'});renameSync(temp,file);
}
export function findDailyGrant(dir,pair,goal,anchors,now=Date.now()) {
  if (!isGoal(goal)||!Array.isArray(anchors)||anchors.length>4||!anchors.every(identifier)) throw Error('每日委托查询无效');
  for (const anchor of anchors) {
    let record;
    try {record=JSON.parse(readFileSync(filename(dir,pair,goal,anchor),'utf8'));} catch(error) {if(error.code==='ENOENT') continue;throw error;}
    if (record.expires>now&&record.grant?.goalKey===goal) return validated(record.grant);
  }
  return null;
}
