import {cleanHealthContext} from './contextual-planning.mjs';
export const KEY = 'along.health.v1';
export const initialState = () => ({version: 1, source: null, snapshot: null, goals: []});
export function loadState(raw) {
  try { const value = JSON.parse(raw); return value?.version === 1 && Array.isArray(value.goals) ? value : initialState(); }
  catch { return initialState(); }
}
const SUMMARY_KEYS=['steps','workoutMinutes','workoutCount','weightKg','sleepMinutes','activeEnergyKcal','restingHeartRate','wristTemperatureC'];
export function summaryHasData(snapshot) {
  return !!snapshot && (SUMMARY_KEYS.some(key=>snapshot[key]!=null)||
    Object.values(snapshot.recentHistory||{}).some(pair=>pair?.recent?.value!=null||pair?.previous?.value!=null));
}
export function setSnapshot(state, input, source) {
  if (!['demo', 'healthkit'].includes(source)) throw Error('未知数据来源');
  const optionalNumber = value => value == null ? null : Number(value);
  const data = {steps: optionalNumber(input?.steps), workoutMinutes: optionalNumber(input?.workoutMinutes), workoutCount: optionalNumber(input?.workoutCount), weightKg: optionalNumber(input?.weightKg), sleepMinutes: optionalNumber(input?.sleepMinutes), activeEnergyKcal: optionalNumber(input?.activeEnergyKcal), restingHeartRate: optionalNumber(input?.restingHeartRate), wristTemperatureC: optionalNumber(input?.wristTemperatureC)};
  if (Object.values(data).some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw Error('健康数据格式不正确');
  if ((data.restingHeartRate != null && data.restingHeartRate > 250) || (data.wristTemperatureC != null && data.wristTemperatureC > 45) || (data.activeEnergyKcal != null && data.activeEnergyKcal > 20000)) throw Error('健康数据超出合理范围');
  const selectedTypes=source==='healthkit' && Array.isArray(input?.selectedTypes) ? input.selectedTypes.filter(type=>['steps','workout','activeEnergy','weight','restingHeartRate','wristTemperature','sleep'].includes(type)) : null;
  const context=cleanHealthContext({...input,selectedTypes});
  const background=source==='healthkit'&&input?.contextReviewAllowed===true&&input?.backgroundReviewAllowed===true&&
    (input.backgroundReviewGoalKey==='health'||/^custom:[A-Za-z0-9_:-]{1,90}$/.test(input.backgroundReviewGoalKey||''));
  const snapshot={backgroundReviewAllowed:background,backgroundReviewGoalKey:background?input.backgroundReviewGoalKey:null,...data, selectedTypes, contextReviewAllowed:source==='healthkit'&&input?.contextReviewAllowed===true,capturedAt:context.capturedAt,
    sleepSummary:context.sleepSummary,workoutSummary:context.workoutSummary,
    comparisonHistoryAllowed:source==='healthkit'&&input?.contextReviewAllowed===true&&context.comparisonHistoryAllowed,
    ...(source==='healthkit'&&input?.contextReviewAllowed===true&&context.recentHistory?{recentHistory:context.recentHistory}:{}),updatedAt:new Date().toISOString()};
  // 空读数（撤销授权、读取失败）不等于「用户没有数据」，不能拿它覆盖已经有的摘要。
  if (!summaryHasData(snapshot) && summaryHasData(state.snapshot) &&
    state.snapshot.contextReviewAllowed!==true && !snapshot.contextReviewAllowed) return state;
  return {...state, source, snapshot};
}
