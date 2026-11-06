export const KEY = 'along.health.v1';
export const initialState = () => ({version: 1, source: null, snapshot: null, goals: []});
export function loadState(raw) {
  try { const value = JSON.parse(raw); return value?.version === 1 && Array.isArray(value.goals) ? value : initialState(); }
  catch { return initialState(); }
}
export function setSnapshot(state, input, source) {
  if (!['demo', 'healthkit'].includes(source)) throw Error('未知数据来源');
  const optionalNumber = value => value == null ? null : Number(value);
  const data = {steps: optionalNumber(input?.steps), workoutMinutes: optionalNumber(input?.workoutMinutes), workoutCount: optionalNumber(input?.workoutCount), weightKg: optionalNumber(input?.weightKg), sleepMinutes: optionalNumber(input?.sleepMinutes), activeEnergyKcal: optionalNumber(input?.activeEnergyKcal), restingHeartRate: optionalNumber(input?.restingHeartRate), wristTemperatureC: optionalNumber(input?.wristTemperatureC)};
  if (Object.values(data).some(value => value !== null && (!Number.isFinite(value) || value < 0))) throw Error('健康数据格式不正确');
  if ((data.restingHeartRate != null && data.restingHeartRate > 250) || (data.wristTemperatureC != null && data.wristTemperatureC > 45) || (data.activeEnergyKcal != null && data.activeEnergyKcal > 20000)) throw Error('健康数据超出合理范围');
  const selectedTypes=source==='healthkit' && Array.isArray(input?.selectedTypes) ? input.selectedTypes.filter(type=>['steps','workout','activeEnergy','weight','restingHeartRate','wristTemperature','sleep'].includes(type)) : null;
  return {...state, source, snapshot: {...data, selectedTypes, updatedAt: new Date().toISOString()}};
}
