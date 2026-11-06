import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, setSnapshot} from '../web/health.mjs';
import {ensureHealthGoal, healthView, loadFinance, connectFinanceDemo, addFinanceDemoRecord, financeView} from '../web/workspace.mjs';

test('existing HealthKit summary survives the new goal view', () => {
  const state = ensureHealthGoal(setSnapshot(initialState(), {
    workoutMinutes: 75, workoutCount: 2, selectedTypes: ['workout'],
  }, 'healthkit'));
  const view = healthView(state);
  assert.equal(view.measure, '75');
  assert.equal(view.percent, 63);
  assert.match(view.primary.detail, /还差 45 分钟/);
  assert.equal(view.connection.kind, 'real');
  assert.equal(ensureHealthGoal(state).goals.length, 1);
});

test('finance connection stays explicitly simulated and changes the task', () => {
  const empty = loadFinance(null);
  assert.equal(financeView(empty).measure, '—');
  const connected = connectFinanceDemo();
  assert.equal(financeView(connected).measure, '¥3,200');
  assert.equal(financeView(connected).connection.label, '演示连接');
  const changed = financeView(addFinanceDemoRecord(connected));
  assert.equal(changed.measure, '¥4,000');
  assert.match(changed.primary.title, /调整/);
  assert.match(changed.primary.detail, /¥2,000/);
  assert.match(changed.note, /演示数据/);
});
test('connected health sources show only selected additional aggregates',()=>{
  const state=ensureHealthGoal(setSnapshot(initialState(),{
    selectedTypes:['workout','restingHeartRate','activeEnergy'],
    workoutMinutes:75,workoutCount:2,restingHeartRate:58,activeEnergyKcal:340,
  },'healthkit'));
  const view=healthView(state);
  assert.equal(view.connection.metrics.length,2);
  assert.deepEqual(view.connection.metrics.map(item=>item.label),['静息心率','今日活动消耗']);
  assert.match(view.connection.detail,/已选 3 项/);
});
