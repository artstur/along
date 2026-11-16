// Host→fork 本机回环调用（docs/stage-a-tech-design.md §2.4.3/§4.2，SD-2）。
//
// 凭证：ALONG_BRIDGE_TOKEN_FILE 指向 0600 的 32B hex 文件（fork 首次启动生成），Host 启动读一次，
// 之后只在两个 Mac 本机进程之间传递——不发 iPhone、不写日志与运行结果、不进 Worker 环境（AGENTS.md §5）。
// 文件缺失或读不到 → readBridgeToken 返回 null：旧链路不带 token 照发（对旧版 fork 兼容），
// 新端点由 agent-host 先行 503「未配置桥接凭证」。
//
// 语义沿用原 superAgentCall：上游故障一律 HostError 502，错误文案取上游 error 字段。
// /events 需要回执透传（200 accepted/duplicate、400 rejected、409 conflict），用 receipt() 拿原始
// 状态码，不把回执错误答成 502。
import {readFileSync} from 'node:fs';
import {HostError} from './host-error.mjs';

const DEFAULT_TIMEOUT=15_000;

export function readBridgeToken(file=process.env.ALONG_BRIDGE_TOKEN_FILE) {
  if (!file) return null;
  try {
    const token=readFileSync(file,'utf8').trim();
    return /^[a-f0-9]{64}$/.test(token)?token:null;
  } catch { return null; }
}

export function createBridge({url,token=null}) {
  const base=url.replace(/\/$/,'');
  function headers({identity=null,contextToken=null}={}) {
    return {'x-along-bridge':'1',
      ...(token?{'x-along-bridge-token':token}:{}),
      ...(contextToken?{'x-along-context-token':contextToken}:{}),
      // 身份只来自服务端绑定的配对会话（001 §4.2）：回环调用把绑定身份带在头上，fork 不收请求体自称。
      ...(identity?{'x-along-user':identity.userId,'x-along-device':identity.deviceId}:{})};
  }
  async function send(path,{method='POST',value,identity=null,contextToken=null,timeout=DEFAULT_TIMEOUT}) {
    let response;
    try {
      response=await fetch(`${base}${path}`,{method,headers:{...headers({identity,contextToken}),...(value===undefined?{}:{'content-type':'application/json'})},
        ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(timeout)});
    } catch(error) { throw new HostError(`Along 服务暂不可用：${error.message}`,502); }
    let result;
    try { result=await response.json(); } catch { throw new HostError(`Along 返回了无效响应（${response.status}）`,502); }
    return {status:response.status,result};
  }
  const upstreamFailure=(status,result)=>new HostError(
    status===401?'Along Source 拒绝了桥接凭证（401）':(result?.error||`Along 请求失败（${status}）`),502);
  return {
    // 存量调用语义（原 superAgentCall）：任何非 2xx 都按上游故障答复。
    async call(path,{method='POST',value,identity=null,contextToken=null,timeout=DEFAULT_TIMEOUT}={}) {
      const {status,result}=await send(path,{method,value,identity,contextToken,timeout});
      if (!status||status>=400) throw upstreamFailure(status,result);
      return result;
    },
    // 回执透传（/events 专线）：200/400/409 原样交还调用方处置，其余状态仍按上游故障抛 502。
    async receipt(path,{method='POST',value,identity=null,timeout=DEFAULT_TIMEOUT}={}) {
      const {status,result}=await send(path,{method,value,identity,timeout});
      if (status!==200&&status!==400&&status!==409) throw upstreamFailure(status,result);
      return {status,result};
    },
    // 存量探测（原 superAgentReady）：旧版 fork 没有该路由时容忍 404。
    async ready(path='/along-source/api/goals/along-status-probe') {
      let response;
      try {
        response=await fetch(`${base}${path}`,{method:'GET',headers:headers(),signal:AbortSignal.timeout(5_000)});
      } catch(error) { throw new HostError(`DSH Super Agent 未运行：${error.message}`,503); }
      if (response.status!==404 && !response.ok) throw new HostError(`DSH Along Source 未就绪（${response.status}）`,503);
      return true;
    },
  };
}
