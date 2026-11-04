import {initialState, setSnapshot} from './health.mjs';

export const EXPERIMENT = 'weekly-workout-120-v1';
export const ORIGINAL_TASK = '本周安排一次 45 分钟健身';

// The previous state may contain the user's real HealthKit snapshot.
// Send only the fixed simulation fields needed by the local Agent endpoint.
export function agentRequestPayload(before, event) {
  return {
    before: {
      source: before.source,
      snapshot: {
        workoutMinutes: before.snapshot.workoutMinutes,
        workoutCount: before.snapshot.workoutCount,
        steps: before.snapshot.steps,
      },
      goals: [{id: EXPERIMENT, type: 'workout', target: 120}],
      loop: {experiment: EXPERIMENT, currentTask: before.loop.currentTask},
    },
    event: {type: event.type, amount: event.amount},
  };
}

export function startExperiment(previous = initialState()) {
  const previousState = previous.loop?.experiment === EXPERIMENT ? previous.loop.previousState ?? initialState() : previous;
  const state = setSnapshot(initialState(), {
    steps: 6842, weightKg: 64.2, workoutMinutes: 75, workoutCount: 2, sleepMinutes: 437,
  }, 'demo');
  return {
    ...state,
    goals: [{id: EXPERIMENT, type: 'workout', target: 120}],
    loop: {experiment: EXPERIMENT, previousState, currentTask: ORIGINAL_TASK, changes: []},
  };
}

export function routeHealthEvent(before, event) {
  if (before?.loop?.experiment !== EXPERIMENT || before.source !== 'demo') throw Error('请先开始实验');
  const goal = before.goals.find(item => item.id === EXPERIMENT);
  if (!goal || goal.target !== 120 || !before.snapshot) throw Error('实验目标不完整');
  if (!event || !['workout', 'steps'].includes(event.type) || !Number.isInteger(event.amount) || event.amount < 1 || event.amount > 300) throw Error('事件格式不正确');
  const previous = before.snapshot.workoutMinutes;
  const input = {...before.snapshot};
  if (event.type === 'workout') {
    input.workoutMinutes += event.amount;
    input.workoutCount += 1;
  } else input.steps += event.amount;
  const after = setSnapshot(before, input, 'demo');
  const remainingBefore = Math.max(0, goal.target - previous);
  const remainingAfter = Math.max(0, goal.target - after.snapshot.workoutMinutes);
  const meaningful = event.type === 'workout' && remainingBefore > 0 &&
    (remainingAfter === 0 || (event.amount >= 20 && remainingAfter < remainingBefore));
  const reason = event.type !== 'workout' ? '步数变化与本周健身时长目标无关。'
    : !meaningful ? '这次变化较小，暂不打断原有安排。'
    : `新增 ${event.amount} 分钟健身记录，目标还差 ${remainingAfter} 分钟（原来还差 ${remainingBefore} 分钟）。`;
  return {after, decision: meaningful ? 'replan' : 'quiet', reason, remainingBefore, remainingAfter};
}

export function acceptAgentSuggestion(value, expectedRemaining) {
  const raw = typeof value === 'string' ? value : value?.finalResponse;
  if (typeof raw !== 'string') throw Error('DSH 没有返回任务');
  const match = raw.trim().match(/(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?/);
  if (!match) throw Error('DSH 返回格式不正确');
  let answer;
  try { answer = JSON.parse(match[1]); } catch { throw Error('DSH 返回格式不正确'); }
  if (!answer || !Number.isInteger(answer.minutes) || answer.minutes !== expectedRemaining ||
      typeof answer.task !== 'string' || !answer.task.trim() || answer.task.length > 100 ||
      typeof answer.reason !== 'string' || !answer.reason.trim() || answer.reason.length > 240) {
    throw Error('DSH 建议与 Along 计算的剩余分钟不一致');
  }
  return {task: answer.task.trim(), reason: answer.reason.trim(), minutes: answer.minutes};
}
