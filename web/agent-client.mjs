export const AGENT_KEY = 'along.agent.v1';
export const GOALS_KEY = 'along.goal-custom.v1';
export const CONVERSATIONS_KEY = 'along.goal-conversations.v1';

export function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export async function agentCall(config, path, body) {
  if (!window.AlongAgentBridge?.request) throw Error('请在 iPhone 的 Along App 中连接 Along');
  if (!config?.baseURL || !config?.fingerprint) throw Error('请先完成 Along 连接设置');
  if (path !== '/pair' && !config.token) throw Error('请先连接 Along');
  return window.AlongAgentBridge.request({baseURL:config.baseURL,fingerprint:config.fingerprint,path,token:config.token ?? '',body});
}

export async function loadNativeConnection() {
  if (!window.AlongAgentBridge?.connection) return null;
  return window.AlongAgentBridge.connection('load');
}

export async function saveNativeConnection(config) {
  if (!window.AlongAgentBridge?.connection) return;
  await window.AlongAgentBridge.connection('save', config);
}
