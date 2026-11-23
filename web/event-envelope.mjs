// 事件信封的组装与校验（docs/stage-a-tech-design.md §4.1，SD-1/SG-1）——浏览器与 Node 双端共享，
// 不引 Node 专用模块（AGENTS.md §2）。这里是 Along Agent 侧 src/along/envelope.ts 同一 Schema 的 JS 移植：
// 信封字段的取值范围、跨字段一致性（payload.event_type 与顶层一致；仅 along.message 可带 kind 且
// envelope.kind === payload.kind；task.completed/feedback 必须带 task_id；authorization.changed 无业务
// 载荷）与 strict 拒绝多余字段（user_id/device_id/adapter/原始样本一律不收）全部对齐。
//
// 两端以静态用例向量对齐：本文件与 Along Agent tests/along-inbox.spec.ts 使用同一组向量（含合法/越界/未知
// 类型/越权/authorization.changed），任何一端改协议必须先改向量再改实现。
// 身份只由服务端配对会话绑定（§4.2）：信封从不携带 user_id/device_id，事件号在此生成并保持稳定
// （同号重试是去重与幂等的锚，001 §4.3）。

export const EVENT_SCHEMA_VERSION = '1';
export const EVENT_TYPES = ['along.user_message', 'along.health_summary_updated', 'along.message'];
export const MESSAGE_KINDS = ['task.completed', 'task.feedback', 'authorization.changed'];
// D5 七类健康类型（ios/AlongHealth/Sources/HealthKitReader.swift 的 sampleType）：adapter 由服务端按
// 这份清单派生，客户端无 adapter 字段；未知类型保存为待适配、不进模型上下文（§2.2.4）。
export const HEALTH_SUMMARY_TYPES = ['steps', 'workout', 'active_energy', 'weight', 'resting_heart_rate', 'wrist_temperature', 'sleep'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const AVAILABILITIES = ['ok', 'no_permission', 'unavailable', 'not_synced'];

const isId = value => typeof value === 'string' && ID_RE.test(value);
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textBetween = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;

// Validate the container before any adapter-specific field access. Both browser callers and
// the durable queue expect invalid JSON input to produce a reason, never a TypeError.
function summaryWindowReason(window) {
  if (window === undefined) return null;
  if (!isRecord(window)) return '摘要窗口无效';
  const keys = Object.keys(window).sort();
  const interval = keys.length === 2 && keys[0] === 'end' && keys[1] === 'start';
  const night = keys.length === 1 && keys[0] === 'night';
  if (!interval && !night) return '摘要窗口形状无效';
  if (interval ? !isTime(window.start) || !isTime(window.end) : !isTime(window.night)) return '摘要窗口时间无效';
  return null;
}

// Mirrors Along Agent health-context.ts: optional typed aggregates, never arbitrary HealthKit payloads.
function summaryContextReason(summary) {
  const context = summary.context;
  if (context === undefined) return null;
  if (!isRecord(context) || summary.summarizer_version !== 'along-health-v1') return '摘要上下文类型或来源无效';
  const boundedTime = value => textBetween(value, 1, 64) && isTime(value);
  const number = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
  const count = value => number(value, 10000) && Number.isInteger(value);
  const keysWithin = (value, keys) => Object.keys(value).every(key => keys.includes(key));
  let observedTimes;
  if (summary.type === 'sleep') {
    const fields = ['windowDays', 'daysWithData', 'averageThroughAt', 'latestWindowOpen', 'averageMinutes',
      'latestNightMinutes', 'previousNightMinutes', 'latestSleepStartAt', 'latestWakeAt',
      'latestAsleepSegmentCount', 'latestLongestAsleepMinutes', 'latestStageMinutes', 'latestStageOverlap'];
    if (!keysWithin(context, fields) || context.windowDays !== 7 || !Number.isInteger(context.daysWithData)
      || context.daysWithData < 0 || context.daysWithData > 7 || !boundedTime(context.averageThroughAt)
      || typeof context.latestWindowOpen !== 'boolean') return '睡眠汇总上下文无效';
    for (const key of ['averageMinutes', 'latestNightMinutes', 'previousNightMinutes']) {
      if (context[key] !== undefined && context[key] !== null && !number(context[key], 1440)) return '睡眠汇总分钟无效';
    }
    for (const key of ['latestSleepStartAt', 'latestWakeAt']) {
      if (context[key] !== undefined && context[key] !== null && !boundedTime(context[key])) return '睡眠观测时间无效';
    }
    const start = context.latestSleepStartAt, end = context.latestWakeAt;
    if (start && end && Date.parse(start) > Date.parse(end)) return '睡眠观测起止倒置';
    if (isRecord(summary.window) && 'start' in summary.window && [start, end].some(value => value &&
      (Date.parse(value) < Date.parse(summary.window.start) || Date.parse(value) > Date.parse(summary.window.end)))) {
      return '睡眠观测不在对应统计窗内';
    }
    const details = ['latestAsleepSegmentCount', 'latestLongestAsleepMinutes', 'latestStageMinutes', 'latestStageOverlap'];
    if (details.some(key => context[key] !== undefined) && !number(context.latestNightMinutes, 1440)) return '最新睡眠细节缺少对应观测';
    if (context.latestAsleepSegmentCount !== undefined && (!count(context.latestAsleepSegmentCount) || context.latestAsleepSegmentCount < 1)) return '睡眠段数无效';
    if (context.latestLongestAsleepMinutes !== undefined && (!number(context.latestLongestAsleepMinutes, 1440)
      || context.latestLongestAsleepMinutes > context.latestNightMinutes + 1)) return '连续睡眠分钟无效';
    if (context.latestStageMinutes !== undefined) {
      const stages = context.latestStageMinutes;
      if (!isRecord(stages) || !Object.keys(stages).length || !keysWithin(stages, ['core', 'deep', 'rem', 'unspecified', 'awake'])
        || Object.values(stages).some(value => !number(value, 1440))) return '睡眠分期汇总无效';
      if (['core', 'deep', 'rem', 'unspecified'].reduce((sum, key) => sum + (stages[key] ?? 0), 0) > context.latestNightMinutes + 1) return '睡眠分期重复计数';
    }
    if (context.latestStageOverlap !== undefined && (typeof context.latestStageOverlap !== 'boolean' || context.latestStageMinutes === undefined)) return '睡眠分期不确定性无效';
    observedTimes = [context.averageThroughAt, start, end];
  } else if (summary.type === 'workout') {
    const fields = ['windowDays', 'weekStartAt', 'todayMinutes', 'todayCount', 'yesterdayMinutes', 'latestWorkoutAt', 'patterns', 'recentSessions'];
    if (!keysWithin(context, fields) || context.windowDays !== 28 || !boundedTime(context.weekStartAt)
      || !number(context.todayMinutes, 40320) || !count(context.todayCount) || !number(context.yesterdayMinutes, 40320)
      || !boundedTime(context.latestWorkoutAt) || !Array.isArray(context.patterns) || context.patterns.length > 40) return '运动汇总上下文无效';
    const patternFields = ['activity', 'weekday', 'hour', 'count', 'recentCount', 'averageMinutes', 'lastObservedAt'];
    const activity = /^(?:yoga|walking|hiking|running|cycling|swimming|pilates|strength_training|hiit|traditionalStrengthTraining|traditional_strength_training|functionalStrengthTraining|functional_strength_training|highIntensityIntervalTraining|high_intensity_interval_training|healthkit_activity_[0-9]+)$/;
    for (const pattern of context.patterns) {
      if (!isRecord(pattern) || !keysWithin(pattern, patternFields) || typeof pattern.activity !== 'string' || !activity.test(pattern.activity)
        || !Number.isInteger(pattern.weekday) || pattern.weekday < 1 || pattern.weekday > 7
        || !Number.isInteger(pattern.hour) || pattern.hour < 0 || pattern.hour > 23 || !count(pattern.count)
        || !count(pattern.recentCount) || pattern.recentCount > pattern.count || !number(pattern.averageMinutes, 40320)
        || !boundedTime(pattern.lastObservedAt)) return '运动模式汇总无效';
    }
    if (context.recentSessions !== undefined) {
      if (!Array.isArray(context.recentSessions) || context.recentSessions.length > 7) return '近期运动摘要数量无效';
      const sessionFields = ['activity', 'startAt', 'endAt', 'durationMinutes', 'location', 'distanceMeters', 'activeEnergyKcal',
        'averageHeartRateBpm', 'maximumHeartRateBpm', 'effortScore', 'estimatedEffortScore'];
      for (const [index, session] of context.recentSessions.entries()) {
        if (!isRecord(session) || !keysWithin(session, sessionFields) || typeof session.activity !== 'string' || !activity.test(session.activity)
          || !boundedTime(session.startAt) || !boundedTime(session.endAt) || Date.parse(session.startAt) > Date.parse(session.endAt)
          || !number(session.durationMinutes, 40320) || session.durationMinutes > (Date.parse(session.endAt) - Date.parse(session.startAt)) / 60000 + 1 / 60
          || !['indoor', 'outdoor', 'unknown'].includes(session.location)) return '近期运动摘要无效';
        if (index > 0 && Date.parse(session.startAt) > Date.parse(context.recentSessions[index - 1].startAt)) return '近期运动摘要顺序无效';
        // The context spans 28 civil dates, unlike the scalar's current-week window.
        try {
          const formatter = new Intl.DateTimeFormat('en-CA', {timeZone: summary.timezone, year: 'numeric', month: '2-digit', day: '2-digit'});
          const ordinal = value => {
            const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
            return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
          };
          const age = ordinal(summary.metric_version) - ordinal(session.startAt);
          if (age < 0 || age > 27) return '运动记录不在观察窗内';
        } catch { return '运动观察时区无效'; }
        for (const [key, max] of [['distanceMeters', 1000000], ['activeEnergyKcal', 100000], ['averageHeartRateBpm', 400], ['maximumHeartRateBpm', 400], ['effortScore', 10], ['estimatedEffortScore', 10]]) {
          if (session[key] !== undefined && (!number(session[key], max)
            || (key.includes('HeartRate') && session[key] <= 0) || (key.includes('Effort') || key === 'effortScore') && session[key] < 1)) return '运动关联统计无效';
        }
        if (session.averageHeartRateBpm !== undefined && session.maximumHeartRateBpm !== undefined && session.averageHeartRateBpm > session.maximumHeartRateBpm) return '运动心率统计倒置';
      }
    }
    observedTimes = [context.weekStartAt, context.latestWorkoutAt, ...context.patterns.map(pattern => pattern.lastObservedAt),
      ...(context.recentSessions ?? []).flatMap(session => [session.startAt, session.endAt])];
  } else return '该摘要类型不支持上下文';
  if (observedTimes.some(value => value && Date.parse(value) > Date.parse(summary.metric_version))) return '汇总观测晚于采集时间';
  return null;
}

function summaryReason(summary) {
  if (!isRecord(summary)) return 'summary 不是对象';
  const keys = Object.keys(summary).sort();
  const allowed = ['availability', 'context', 'metric_version', 'statistic', 'summarizer_version', 'timezone', 'type', 'unit', 'value', 'window'];
  for (const key of keys) if (!allowed.includes(key)) return `摘要带了多余字段 ${key}`;
  if (!textBetween(summary.type, 1, 64) || !textBetween(summary.metric_version, 1, 64)) return '摘要类型或版本无效';
  if (summary.unit !== undefined && !textBetween(summary.unit, 1, 16)) return '摘要单位无效';
  if (summary.statistic !== undefined && !textBetween(summary.statistic, 1, 32)) return '摘要统计方法无效';
  if (!textBetween(summary.timezone, 1, 64)) return '摘要时区无效';
  if (!textBetween(summary.summarizer_version, 1, 64)) return '摘要器版本无效';
  if (!AVAILABILITIES.includes(summary.availability)) return '摘要可用性无效';
  if (summary.value!==undefined&&summary.value!==null&&(typeof summary.value!=='number'||!Number.isFinite(summary.value))) return '摘要只能包含有限数值';
  const contextReason = summaryContextReason(summary);
  if (contextReason) return contextReason;
  const windowReason = summaryWindowReason(summary.window);
  if (windowReason) return windowReason;
  if (summary.summarizer_version==='along-health-v1'&&HEALTH_SUMMARY_TYPES.includes(summary.type)) {
    const units={steps:'count',workout:'min',active_energy:'kcal',weight:'kg',resting_heart_rate:'bpm',wrist_temperature:'degC',sleep:'min'};
    if (summary.unit!==units[summary.type]) return '摘要单位不符';
    if (!summary.window||!isTime(summary.window.start)||!isTime(summary.window.end)||Date.parse(summary.window.start)>Date.parse(summary.window.end)) return '摘要观测窗口无效';
    if (!isTime(summary.metric_version)) return '摘要读取版本无效';
    if (summary.availability==='ok'&&typeof summary.value!=='number') return '有效摘要缺少数值';
    if (summary.availability!=='ok'&&summary.value!==null&&summary.value!==undefined) return '不可用摘要带有数值';
  }
  return null;
}

function payloadReason(envelope) {
  const payload = envelope.payload;
  if (!isRecord(payload)) return 'payload 不是对象';
  if (payload.event_type !== envelope.event_type) return 'payload.event_type 与信封顶层不一致';
  const extra = Object.keys(payload).filter(key => key !== 'event_type');
  if (envelope.event_type === 'along.user_message') {
    if (extra.length !== 1 || extra[0] !== 'text') return 'user_message 载荷字段不符';
    if (!textBetween(payload.text, 1, 800) || payload.text.trim() === '') return 'user_message 原话为空或超长';
    return null;
  }
  if (envelope.event_type === 'along.health_summary_updated') {
    if (extra.length !== 1 || extra[0] !== 'summaries') return 'health 载荷字段不符';
    if (!Array.isArray(payload.summaries) || payload.summaries.length < 1 || payload.summaries.length > 20) return 'health 摘要数量不符';
    for (const summary of payload.summaries) {
      const reason = summaryReason(summary);
      if (reason) return reason;
    }
    return null;
  }
  // along.message：kind 必填且与顶层一致（信封顶层也必须带同值 kind，与 Along Agent Schema 一致）；
  // task.completed/feedback 必须带 task_id；authorization.changed 无业务载荷（D15：接受并记录、不投递）。
  const messageAllowed = ['kind', 'task_id', 'completed_at', 'note', 'reply_to_message_id'];
  for (const key of extra) if (!messageAllowed.includes(key)) return `message 载荷带了多余字段 ${key}`;
  if (!extra.includes('kind')) return 'message 载荷缺少 kind';
  if (!MESSAGE_KINDS.includes(payload.kind)) return 'message kind 无效';
  if (envelope.kind !== payload.kind) return 'envelope.kind 与 payload.kind 不一致';
  if (payload.kind === 'authorization.changed') {
    if (payload.task_id !== undefined || payload.completed_at !== undefined || payload.note !== undefined
      || payload.reply_to_message_id !== undefined) return 'authorization.changed 不带业务载荷';
    return null;
  }
  if (!isId(payload.task_id)) return `${payload.kind} 必须带 task_id`;
  if (payload.completed_at !== undefined && !isTime(payload.completed_at)) return 'completed_at 无效';
  if (payload.note !== undefined && !textBetween(payload.note, 0, 500)) return 'note 超长';
  if (payload.reply_to_message_id !== undefined && !isId(payload.reply_to_message_id)) return 'reply_to_message_id 无效';
  return null;
}

/**
 * 校验一个信封：合法返回 null，否则返回拒绝原因（对外统一按 invalid_envelope/rejected 口径应答，
 * 详细原因只用于本端排查）。语义与 Along Agent 的 zod Schema 一致，两端向量锁定。
 */
export function validateEnvelope(envelope) {
  if (!isRecord(envelope)) return '信封不是对象';
  const allowed = ['event_id', 'schema_version', 'event_type', 'kind', 'goal_id', 'task_id', 'occurred_at',
    'timezone', 'message_id', 'causation_id', 'base_revision', 'payload'];
  for (const key of Object.keys(envelope)) if (!allowed.includes(key)) return `信封带了多余字段 ${key}`;
  if (!isId(envelope.event_id)) return 'event_id 无效';
  if (envelope.schema_version !== EVENT_SCHEMA_VERSION) return 'schema_version 不受支持';
  if (!EVENT_TYPES.includes(envelope.event_type)) return 'event_type 不受支持（目标只能通过聊天改变，D4）';
  if (envelope.kind !== undefined && !MESSAGE_KINDS.includes(envelope.kind)) return 'kind 无效';
  if (envelope.event_type !== 'along.message' && envelope.kind !== undefined) return '仅 along.message 可带 kind';
  if (!isId(envelope.goal_id) && envelope.goal_id !== undefined) return 'goal_id 无效';
  if (!isId(envelope.task_id) && envelope.task_id !== undefined) return 'task_id 无效';
  if (!isTime(envelope.occurred_at)) return 'occurred_at 无效';
  if (!textBetween(envelope.timezone, 1, 64)) return 'timezone 无效';
  if (!isId(envelope.message_id) && envelope.message_id !== undefined) return 'message_id 无效';
  if (!isId(envelope.causation_id) && envelope.causation_id !== undefined) return 'causation_id 无效';
  if (envelope.base_revision !== undefined && (!Number.isInteger(envelope.base_revision) || envelope.base_revision < 0)) return 'base_revision 无效';
  return payloadReason(envelope);
}

/**
 * 组装信封：补齐 schema_version、去掉取值为 undefined 的可选键，并整体校验。缺 event_id 时生成一个
 * 稳定的新号（入队后不再换号——重试复用同一信封，payload_hash 才稳定，§2.2.7）。
 * 返回 {ok:true, envelope} 或 {ok:false, reason}。
 */
export function assembleEnvelope(input) {
  const envelope = { ...(isRecord(input) ? input : {}) };
  if (envelope.event_id === undefined || envelope.event_id === null || envelope.event_id === '') envelope.event_id = newEventId();
  if (envelope.schema_version === undefined) envelope.schema_version = EVENT_SCHEMA_VERSION;
  for (const key of Object.keys(envelope)) if (envelope[key] === undefined) delete envelope[key];
  const reason = validateEnvelope(envelope);
  if (reason) return { ok: false, reason, envelope };
  return { ok: true, envelope };
}

// 与既有 Along 页面同款的可读随机号：时间基数 + 随机尾巴，满足信封 ID 形状且不依赖安全上下文。
export function newEventId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
