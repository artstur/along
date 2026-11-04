export const ACTIVE_GOAL_KEY = 'along.active-goal.v1';
export const FINANCE_KEY = 'along.finance-demo.v1';
export const HEALTH_GOAL_ID = 'along-health-weekly-workout';
export const FINANCE_TARGET = 10000;

export function ensureHealthGoal(state) {
  if (state.goals.some(goal => goal.type === 'workout')) return state;
  return {
    ...state,
    goals: [...state.goals, {id: HEALTH_GOAL_ID, type: 'workout', target: 120}],
  };
}

export function loadFinance(raw) {
  try {
    const value = JSON.parse(raw);
    if (value?.version === 1 && typeof value.connected === 'boolean' &&
        Number.isInteger(value.saved) && value.saved >= 0 && value.saved <= 10000000 &&
        Number.isInteger(value.recordCount) && value.recordCount >= 0) return value;
  } catch {}
  return {version: 1, connected: false, saved: 0, recordCount: 0};
}

export function connectFinanceDemo() {
  return {version: 1, connected: true, saved: 3200, recordCount: 0};
}

export function addFinanceDemoRecord(finance, target = FINANCE_TARGET) {
  if (!finance.connected) throw Error('请先打开理财演示连接');
  return {...finance, saved: Math.min(target, finance.saved + 800), recordCount: finance.recordCount + 1};
}

export function healthView(state, customization = null) {
  const goal = state.goals.find(item => item.type === 'workout');
  const target = goal?.target ?? 120;
  const selected = state.snapshot?.selectedTypes;
  const hasWorkout = state.snapshot?.workoutMinutes != null &&
    (state.source !== 'healthkit' || !Array.isArray(selected) || selected.includes('workout'));
  const completed = hasWorkout ? state.snapshot.workoutMinutes : null;
  const remaining = hasWorkout ? Math.max(0, target - completed) : null;
  const percent = hasWorkout ? Math.min(100, Math.round(completed / target * 100)) : 0;
  const real = state.source === 'healthkit';
  const sample = state.source === 'demo';
  const metrics = real ? [
    selected?.includes('restingHeartRate') ? {label:'静息心率',value:state.snapshot.restingHeartRate == null ? '无记录' : `${state.snapshot.restingHeartRate} 次/分`} : null,
    selected?.includes('wristTemperature') ? {label:'手腕温度',value:state.snapshot.wristTemperatureC == null ? '无记录' : `${state.snapshot.wristTemperatureC.toFixed(1)} °C`} : null,
    selected?.includes('activeEnergy') ? {label:'今日活动消耗',value:state.snapshot.activeEnergyKcal == null ? '无记录' : `${state.snapshot.activeEnergyKcal} 千卡`} : null,
  ].filter(Boolean) : [];
  const primary = !hasWorkout
    ? {title: '先连接本周健身记录', detail: '选择 Apple Health 的健身记录后，Along 才能计算还差多少。', status: '待连接'}
    : remaining === 0
      ? {title: '本周目标已达到', detail: `已累计 ${completed} 分钟，先保留当前节奏。`, status: '已达成'}
      : remaining <= 20
        ? {title: `找一个 ${remaining} 分钟的活动时段`, detail: `本周只差 ${remaining} 分钟；新记录到来后再更新安排。`, status: '下一步'}
        : {title: `安排一次 ${Math.min(30, remaining)} 分钟活动`, detail: `本周还差 ${remaining} 分钟，先完成一段可执行的运动。`, status: '下一步'};
  const chosenTask = customization?.task && hasWorkout && remaining > 0 ?
    {title:customization.task, detail:customization.reason || `本周还差 ${remaining} 分钟。`, status:'Agent 提案'} : primary;
  return {
    id: 'health', category: '健康目标', title: customization?.title || `本周累计运动 ${target} 分钟`,
    measure: completed == null ? '—' : String(completed), measureUnit: `/ ${target} 分钟`,
    percent, progressText: completed == null ? '等待健身记录' : remaining ? `已完成 ${percent}% · 还差 ${remaining} 分钟` : '本周已达成',
    note: real ? '根据你选择导入的 Apple Health 摘要计算' : sample ? '当前使用演示健康数据' : '连接 Apple Health 后开始追踪',
    primary: chosenTask,
    secondary: hasWorkout ? [{title: '完成后更新健身记录', detail: '新数据到来时，下一步会重新计算。', status: '待更新'}] : [],
    connection: {name: 'Apple Health', label: real ? '已连接' : sample ? '演示数据' : '未连接', detail: real ? `已选 ${selected?.length ?? 0} 项 · 前台自动检查 · 保存在本机` : sample ? '当前没有连接真实健康数据' : '选择要读取的健康数据', action: real ? '管理' : '连接', kind: real ? 'real' : sample ? 'demo' : 'none', metrics},
  };
}

export function financeView(finance, customization = null) {
  const known = finance.connected;
  const target = customization?.target ?? FINANCE_TARGET;
  const saved = known ? finance.saved : null;
  const remaining = known ? Math.max(0, target - saved) : null;
  const monthly = known ? Math.ceil(remaining / 3) : null;
  const percent = known ? Math.min(100, Math.round(saved / target * 100)) : 0;
  const primary = !known
    ? {title: '先查看当前储备', detail: '开启演示连接后，才能根据余额计算下一步。', status: '待连接'}
    : remaining === 0
      ? {title: '核对目标是否已经完成', detail: '示例余额已达到目标；实际资金仍需在原应用中确认。', status: '待确认'}
      : finance.recordCount > 0
        ? {title: '根据新增结余调整本月安排', detail: `示例余额增加后还差 ¥${remaining.toLocaleString('zh-CN')}；按三个月均分约 ¥${monthly.toLocaleString('zh-CN')} / 月。`, status: '已调整'}
        : {title: '核对本月可用于储备的金额', detail: `距目标还差 ¥${remaining.toLocaleString('zh-CN')}；先确认实际现金流，再决定转入多少。`, status: '下一步'};
  return {
    id: 'finance', category: '理财目标 · 演示', title: customization?.title || '三个月存下 ¥10,000 应急金',
    measure: saved == null ? '—' : `¥${saved.toLocaleString('zh-CN')}`, measureUnit: `/ ¥${target.toLocaleString('zh-CN')}`,
    percent, progressText: saved == null ? '等待连接演示数据' : remaining ? `已完成 ${percent}% · 还差 ¥${remaining.toLocaleString('zh-CN')}` : '示例目标已达成',
    note: '所有余额与变化均为演示数据，不代表真实账户',
    primary: customization?.task && known && remaining > 0 ? {title:customization.task,detail:customization.reason || '由 Agent 与你共同确定。',status:'Agent 提案'} : primary,
    secondary: known ? [{title: '下一次余额变化后复核节奏', detail: '只更新计划，不自动转账或交易。', status: '待更新'}] : [],
    connection: {name: '蚂蚁财富类应用', label: known ? '演示连接' : '未连接', detail: known ? '模拟汇总余额 · 未读取真实账户' : '以第三方理财应用为例，不会请求账号权限', action: known ? '模拟 +¥800' : '体验连接', kind: known ? 'demo' : 'none'},
  };
}
