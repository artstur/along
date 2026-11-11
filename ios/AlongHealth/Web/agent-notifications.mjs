export const AGENT_NOTIFICATION_LEDGER_KEY = 'along.agent-notification-ledger.v1';

const MAX_LEDGER_ITEMS = 80;
const LEDGER_TTL_MS = 30 * 24 * 60 * 60_000;

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeGoalKey(value) {
  const key = text(value, 100);
  return key === 'health' || key === 'finance' || key.startsWith('custom:') ? key : '';
}

function firstAction(result) {
  const proposed = text(result?.proposal?.task, 140);
  if (proposed) return proposed;
  const tasks = Array.isArray(result?.layout?.tasks) ? result.layout.tasks : [];
  const task = tasks.find(item => item && ['temporary', 'planned'].includes(item.state)) || tasks[0];
  return text(task?.title, 100) || text(task?.detail, 140);
}

export function goalRunNotification(goalKey, run) {
  if (run?.actual !== true || run?.status !== 'done' || typeof run.requestId !== 'string') return null;
  const action = firstAction(run.result);
  const safeKey = safeGoalKey(goalKey);
  if (!action || !safeKey) return null;
  return {
    id: `goal:${run.requestId}`,
    kind: 'goal',
    goalKey: safeKey,
    requestId: run.requestId,
    title: 'Along 已整理好下一步',
    body: `下一步：${action}`.slice(0, 180),
  };
}

export function taskRunNotification(goalKey, task, run) {
  if (run?.actual !== true || run?.status !== 'done' || typeof run.requestId !== 'string') return null;
  const safeKey = safeGoalKey(goalKey);
  const taskId = text(task?.id, 64);
  const title = text(task?.title, 100);
  const detail = text(task?.detail, 150);
  if (!safeKey || !taskId || !title) return null;
  return {
    id: `task:${run.requestId}`,
    kind: 'task',
    goalKey: safeKey,
    taskId,
    requestId: run.requestId,
    title: 'Agent 编排已完成',
    body: `${title}${detail ? `：${detail}` : ''}`.slice(0, 180),
  };
}

export function healthProposalNotification(ticket) {
  const task = text(ticket?.suggestion?.task, 140);
  const id = text(ticket?.id, 100);
  const goalKey = safeGoalKey(ticket?.goalKey ?? 'health');
  if (ticket?.status !== 'proposed' || !id || !task || !goalKey || goalKey === 'finance') return null;
  return {
    id: `proposal:${id}`,
    kind: 'goal',
    goalKey,
    requestId: id,
    title: '健康计划有了新建议',
    body: `下一步：${task}`.slice(0, 180),
  };
}

export function readNotificationLedger(raw, now = Date.now()) {
  let value;
  try { value = JSON.parse(raw || '{}'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([id, at]) => typeof id === 'string' && id.length <= 220 && Number.isFinite(at) && now - at <= LEDGER_TTL_MS)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_LEDGER_ITEMS));
}

export function notificationWasDelivered(raw, id, now = Date.now()) {
  return Object.hasOwn(readNotificationLedger(raw, now), id);
}

export function recordNotificationDelivered(raw, id, now = Date.now()) {
  const next = {...readNotificationLedger(raw, now), [id]: now};
  return JSON.stringify(readNotificationLedger(JSON.stringify(next), now));
}
