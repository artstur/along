import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {acceptAgentSuggestion} from './loop.mjs';

const goalSchema=fileURLToPath(new URL('./schemas/goal-chat.schema.json',import.meta.url));
const taskSchema=fileURLToPath(new URL('./schemas/task-reply.schema.json',import.meta.url));

function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const local=join(homedir(),'.local','bin','codex');
  return existsSync(local)?local:'codex';
}

async function runCodexJSON(prompt,schema,{timeoutMs=105_000}={}) {
  const dir=await mkdtemp(join(tmpdir(),'along-codex-'));
  const output=join(dir,'response.json');
  let stderr='';
  try {
    const args=['exec','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check','--output-schema',schema,'--output-last-message',output,'--color','never','-C',dir,'-'];
    await new Promise((resolve,reject)=>{
      const child=spawn(codexBinary(),args,{stdio:['pipe','ignore','pipe'],env:process.env});
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Codex 生成超时'));},timeoutMs);
      child.stderr.on('data',chunk=>{if(stderr.length<16_000)stderr+=chunk;});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{
        clearTimeout(timer);
        if(code===0)resolve();
        else reject(Error(`Codex 调用失败${stderr.trim()?`：${stderr.trim().slice(-600)}`:''}`));
      });
      child.stdin.end(prompt);
    });
    return JSON.parse(await readFile(output,'utf8'));
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
}

function normalizeGoalAnswer(answer) {
  const proposal=answer?.proposal?.active ? {
    title:answer.proposal.title,target:answer.proposal.target,task:answer.proposal.task,reason:answer.proposal.reason,
  } : null;
  const modules=(answer?.layout?.modules ?? []).map(module=>{
    const base={kind:module.kind,id:module.id,title:module.title};
    if(module.kind==='summary')return {...base,content:module.content};
    if(module.kind==='fact_list')return {...base,items:module.facts};
    if(module.kind==='chips')return {...base,items:module.chips};
    return {...base,source:module.source,target:module.target,unit:module.unit,note:module.note};
  });
  return {...answer,proposal,layout:{...answer.layout,modules}};
}

export async function runGoalCodex(prompt) { return normalizeGoalAnswer(await runCodexJSON(prompt,goalSchema)); }
export function runTaskCodex(prompt) { return runCodexJSON(prompt,taskSchema); }

export async function proposeNextStep({oldTask,eventMinutes,completed,target,remaining}) {
  const prompt=`你是 Along 的下一步建议 Agent。健康数据与剩余分钟已经由 Along 确定，不要重新估算，不要调用工具。目标是本周健身 ${target} 分钟；新增前任务是「${oldTask}」；刚新增 ${eventMinutes} 分钟；当前累计 ${completed} 分钟；精确剩余 ${remaining} 分钟。返回简短可执行的下一步，只覆盖剩余分钟，不编造日程、身体状况或医学建议。remaining 必须是整数 ${remaining}。`;
  return acceptAgentSuggestion(await runTaskCodex(prompt),remaining);
}
