export const KEY = 'along.health.v1';
export const initialState = () => ({version: 1, source: null, snapshot: null, goals: []});
export function loadState(raw) {
  try { const value = JSON.parse(raw); return value?.version === 1 && Array.isArray(value.goals) ? value : initialState(); }
  catch { return initialState(); }
}
export function addGoal(state, type, amount) {
  const limit = type === 'workout' ? 168 : type === 'weight' ? 100 : 0;
  if (!Number.isFinite(amount) || amount <= 0 || amount > limit) throw Error('请输入有效的目标数值');
  return {...state, goals: [...state.goals, {id: crypto.randomUUID(), type, target: type === 'workout' ? Math.round(amount * 60) : amount, baselineWeight: state.snapshot?.weightKg ?? null, weightRecords: state.snapshot?.weightKg == null ? 0 : 1}]};
}
export const removeGoal = (state, id) => ({...state, goals: state.goals.filter(goal => goal.id !== id)});
export function setSnapshot(state, input, source) {
  if (!['demo', 'healthkit'].includes(source)) throw Error('未知数据来源');
  const optionalNumber = value => value == null ? null : Number(value);
  const data = {steps: optionalNumber(input?.steps), workoutMinutes: optionalNumber(input?.workoutMinutes), workoutCount: optionalNumber(input?.workoutCount), weightKg: optionalNumber(input?.weightKg), sleepMinutes: optionalNumber(input?.sleepMinutes), activeEnergyKcal: optionalNumber(input?.activeEnergyKcal), restingHeartRate: optionalNumber(input?.restingHeartRate), wristTemperatureC: optionalNumber(input?.wristTemperatureC)};
  if (Object.values(data).some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw Error('健康数据格式不正确');
  if ((data.restingHeartRate != null && data.restingHeartRate > 250) || (data.wristTemperatureC != null && data.wristTemperatureC > 45) || (data.activeEnergyKcal != null && data.activeEnergyKcal > 20000)) throw Error('健康数据超出合理范围');
  const selectedTypes=source==='healthkit' && Array.isArray(input?.selectedTypes) ? input.selectedTypes.filter(type=>['steps','workout','activeEnergy','weight','restingHeartRate','wristTemperature','sleep'].includes(type)) : null;
  return {...state, source, snapshot: {...data, selectedTypes, updatedAt: new Date().toISOString()}, goals: state.goals.map(goal => {
    if (goal.type !== 'weight') return goal;
    if (source !== state.source) return {...goal, baselineWeight:data.weightKg, weightRecords:data.weightKg == null ? 0 : 1};
    return data.weightKg != null && data.weightKg !== state.snapshot?.weightKg ? {...goal, baselineWeight: goal.baselineWeight ?? data.weightKg, weightRecords: (goal.weightRecords ?? 0) + 1} : goal;
  })};
}
export function advanceDemo(state) {
  if (state.source !== 'demo' || !state.snapshot) return state;
  return setSnapshot(state, {...state.snapshot, steps: state.snapshot.steps + 1540, workoutMinutes: state.snapshot.workoutMinutes + 35, workoutCount: state.snapshot.workoutCount + 1}, 'demo');
}
export function advanceWeightDemo(state) {
  if (state.source !== 'demo' || !state.snapshot || state.snapshot.weightKg == null) return state;
  return setSnapshot(state, {...state.snapshot, weightKg: Math.round((state.snapshot.weightKg - 0.2) * 10) / 10}, 'demo');
}
export function taskPlan(state) {
  const data = state.snapshot, progress = [], tasks = [];
  for (const goal of state.goals) {
    if (goal.type === 'workout') {
      const known=data?.workoutMinutes != null && data?.workoutCount != null;
      const current = known ? data.workoutMinutes : 0, remaining = Math.max(0, goal.target - current);
      progress.push({id: goal.id, percent: known ? Math.min(100, Math.round(current / goal.target * 100)) : 0, label: known ? `已完成 ${current} / ${goal.target} 分钟` : '等待健身记录', note: known ? remaining ? `还差 ${remaining} 分钟；新记录到来后自动更新。` : '本周目标已达到。' : '选择健身数据并同步后开始追踪。'});
      tasks.push({title: '读取本周健身记录', detail: known ? `${data.workoutCount} 次 · 合计 ${current} 分钟` : '等待数据', status: known ? 'done' : 'active'});
      tasks.push({title: remaining ? '安排下一次活动' : '查看本周结果', detail: known ? remaining ? `本周还差 ${remaining} 分钟。` : '本周已达到目标。' : '同步健身数据后计算剩余时长。', status: known && !remaining ? 'done' : 'active'});
    } else {
      const known = goal.baselineWeight != null && data?.weightKg != null && goal.weightRecords >= 2;
      const change = known ? Math.max(0, goal.baselineWeight - data.weightKg) : 0;
      progress.push({id: goal.id, percent: known ? Math.min(100, Math.round(change / goal.target * 100)) : 0, label: known ? `已变化 ${change.toFixed(1)} / ${goal.target} kg` : '等待起点与最新体重', note: known ? '体重会波动，趋势需要结合连续记录来看。' : '连接后需要至少两次记录才能看到变化。'});
      tasks.push({title: '记录体重变化', detail: known ? `起点 ${goal.baselineWeight.toFixed(1)} kg · 最近 ${data.weightKg.toFixed(1)} kg` : '等待体重记录', status: known ? 'done' : 'active'});
      tasks.push({title: '观察本月体重趋势', detail: '有新记录时更新，不根据单次波动调整安排。', status: known ? 'active' : 'waiting'});
    }
  }
  return {progress, tasks};
}
