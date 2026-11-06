import {homedir} from 'node:os';
import {join} from 'node:path';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {acceptAgentSuggestion} from '../web/loop.mjs';

export async function proposeNextStep({oldTask, eventMinutes, completed, target, remaining}) {
  const harness = new DeepSeekHarness({
    profile: 'sdk', dshHome: join(homedir(), '.dsh'),
    provider: 'deepseek-account', model: 'deepseek-flash',
    initializeTimeoutMs: 30_000,
  });
  try {
    const prompt = `你是 Along 的下一步建议 Agent。健康数据和剩余分钟已由 Along 确定；不要重新估算，也不要调用工具。只输出一行合法 JSON，字段为 task、reason、minutes。\n目标：本周健身 ${target} 分钟。新增前的任务：${oldTask}。刚收到一条新增 ${eventMinutes} 分钟的健身记录。当前累计 ${completed} 分钟，精确剩余 ${remaining} 分钟。请给用户一个可执行、简短、不过度打扰的下一步，只覆盖剩余的 ${remaining} 分钟，不要编造用户日程、身体状况或医学建议。reason 说明为什么原任务需要改变，引用 45→${remaining} 分钟的差异。minutes 必须是整数 ${remaining}。`;
    const result = await harness.run(prompt);
    const failure = result.events.find(item => item.type === 'turn/end')?.data?.reason;
    if (failure?.kind === 'error') throw Error(`DSH 调用失败：${failure.error?.code ?? failure.error?.message ?? '未知错误'}`);
    return acceptAgentSuggestion(result.finalResponse, remaining);
  } finally {
    await harness.close();
  }
}
