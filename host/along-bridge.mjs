// Host→Along Agent 本机回环调用（docs/stage-a-tech-design.md §2.4.3/§4.2，SD-2）。
//
// 凭证：ALONG_BRIDGE_TOKEN_FILE 指向 0600 的 32B hex 文件（Along Agent 首次启动生成），Host 启动读一次，
// 之后只在两个 Mac 本机进程之间传递——不发 iPhone、不写日志与运行结果、不进 Worker 环境（AGENTS.md §5）。
// 文件缺失、读不到或权限过宽（非 0600，statSync 口径对齐 host/apns.mjs）→ readBridgeToken 返回 null：
// 权限过宽等同未配置凭证（fail-closed）——旧链路不带 token 照发（对旧版 Along Agent 兼容），
// 新端点由 agent-host 先行 503「未配置桥接凭证」，云端 runner-token 过宽则在启动时拒绝。
// 恢复/搬运 secret 后须统一 chmod 600（恢复链路尚未实现，docs/cloud-security-hardening.md §6 移交注记）。
//
// 语义沿用原 superAgentCall：上游故障一律 HostError 502，错误文案取上游 error 字段。
// /events 需要回执透传（200 accepted/duplicate、400 rejected、409 conflict），用 receipt() 拿原始
// 状态码，不把回执错误答成 502。
import {readFileSync, statSync} from 'node:fs';
import {HostError} from './host-error.mjs';

const DEFAULT_TIMEOUT=15_000;

export function readBridgeToken(file=process.env.ALONG_BRIDGE_TOKEN_FILE) {
  if (!file) return null;
  try {
    if (statSync(file).mode&0o077) return null;
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
      // 身份只来自服务端绑定的配对会话（001 §4.2）：回环调用把绑定身份带在头上，Along Agent 不收请求体自称。
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
  // 真实就绪契约（Tier 2，docs/cloud-deploy-multi-user.md §3.5）。
  //
  // 契约路径 /along-source/api/goals/along-status-probe：along-superagent 侧
  // （src/along/api.ts，交付于 feature/along-tier2-readiness 的 18fb806）已改成**真实就绪**：
  // 业务面未组装或 Along Source 未注册/未启用时答 503 {"error":"along_source_not_ready"}，
  // 就绪时答 200 {"service":"along-source","ready":true}。
  //
  // 旧版 Along Agent 的这条路径恒返回 200，**分不清**「Along Source 已注册、投递泵已启动」
  // 与「进程刚起来、Source 还没注册」的启动窗口。V-1 实测正是这个窗口把重启后已到期的
  // 待投递行领走并终结为 filtered/source_not_installed。
  //
  // 就绪判定沿用**同一条**契约路径，不另造 /ready 路径：另造一条路径而 Super Agent 侧
  // 没实现时，它会 404，然后被当成「旧版没有契约路径 → 就绪」——恰好把要防的启动窗口
  // 又放回去了。宿主因此必须按状态码与 body 判定，而不是按「路径是否存在」。
  //
  // 判定口径：只有 HTTP 200 且 body 为 {service:'along-source', ready:true} 才算就绪。
  // 503 = 进程在但 Source 还没注册/投递泵未就绪（要区分的启动窗口）；
  // 401/403 = 凭证或身份头配置错了（属于配置问题，不按未就绪静默处理）；
  // 连不上 = 服务没起来。
  //
  // 404 **不再**按「旧版没有契约路径」容忍成就绪：那条路径恒答 200 的旧版 Along Agent
  // 装错时同样会答 200 ready:true，容忍 404 等于把「装错版本」与「已就绪」混成一个答案，
  // 而装错版本的投递泵仍会把待投递行终结为 filtered/source_not_installed。
  // 404 现在归入未就绪（503）：宁可让连接检查说「还没准备好」，也不要给一个假的 ready。
  const READY_PATH='/along-source/api/goals/along-status-probe';
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
    // 存量探测（原 superAgentReady）：旧版 Along Agent 没有该路由时容忍 404。
    async ready(path=READY_PATH) {
      let response;
      try {
        response=await fetch(`${base}${path}`,{method:'GET',headers:headers(),signal:AbortSignal.timeout(5_000)});
      } catch(error) { throw new HostError(`DSH Super Agent 未运行：${error.message}`,503); }
      if (response.status!==404 && !response.ok) throw new HostError(`DSH Along Source 未就绪（${response.status}）`,503);
      return true;
    },
    /**
     * 真实就绪探测（Tier 2）：按上面的契约路径判定——200 且 body.ready === true 才算就绪。
     *
     * 严格口径（审查 P2-5）：
     *   - 只探**一次**。就绪判定与后续的业务调用是两次独立的回环请求；把「探针」和
     *     「再探一次同一路径」叠在一起，会让一次持续 404 变成 502（上游故障），把
     *     「还没就绪」误报成「服务坏了」。
     *   - 只认 **200**。其它 2xx（如 204）不携带契约 body，不算就绪。
     *   - body 必须是 {service:'along-source', ready:true}。字段不对就是未就绪。
     *   - 404 归入**未就绪（503）**，不再按「旧版没有契约路径」容忍成就绪。
     *   - 401/403 是配置问题（凭证或身份头），给出可操作的提示，不静默当未就绪。
     *
     * identity：契约路径会校验身份头格式（Along Agent 侧 boundIdentity，缺头 403）。
     * 宿主传**服务端绑定**的配对身份（与其它回环调用同一个 who），不自造身份。
     */
    async readyStrict({identity=null}={}) {
      let response;
      try {
        response=await fetch(`${base}${READY_PATH}`,{method:'GET',headers:headers({identity}),signal:AbortSignal.timeout(5_000)});
      } catch(error) { throw new HostError(`DSH Super Agent 未运行：${error.message}`,503); }
      if (response.status===401||response.status===403) {
        throw new HostError(`DSH Along Source 拒绝了桥接凭证或身份头（${response.status}）：检查 ALONG_BRIDGE_TOKEN_FILE`,503);
      }
      // 非 200 一律未就绪（含 404：旧版恒答 200 的探针装错时同样会答 200，容忍 404
      // 等于把「装错版本」说成「已就绪」）。2xx 但不是 200 也不带契约 body，同样未就绪。
      if (response.status!==200) throw new HostError(`DSH Along Source 未就绪（${response.status}）`,503);
      let body=null;
      try { body=await response.json(); } catch { /* 非 JSON 响应：按未就绪处理。 */ }
      if (!body||body.service!=='along-source'||body.ready!==true) throw new HostError('DSH Along Source 尚未就绪',503);
      return true;
    },
  };
}
