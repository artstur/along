import {HostError} from './host-error.mjs';
import {requireOkxGoal,requireOwnedSourceGoal} from './source-access.mjs';
import {DeviceSourceError} from './device-source-gateway.mjs';

// Only the native-only pinned route may call this adapter. No credentials,
// vendor response body, model-chosen endpoint or caller-provided identity.
// 每请求身份（docs/cloud-deploy-multi-user.md §3.2 M2）：绑定由宿主按请求解析后传入，
// 守卫不再是模块级单例比较，而是 stillBound(who)——该绑定（user+device）仍在绑定表中；
// 同一用户重新配对会整条替换绑定，旧绑定的守卫随即失效。
export function createDeviceSourceRoute({gateway,stillBound,readGoal,retireLegacy=async()=>{},pump=()=>{}}) {
  return async (input,who)=>{
    if(!who)throw new HostError('请先配对这台 Mac',403);
    if(!input||Array.isArray(input)||typeof input!=='object'||input.provider!=='okx'||
      typeof input.goalId!=='string'||!/^g_[A-Za-z0-9_-]{1,100}$/.test(input.goalId)||
      'userId' in input||'deviceId' in input||'user_id' in input||'device_id' in input)throw new HostError('设备采集请求无效',400);
    const allowed=async()=>{
      if(!stillBound(who))return false;
      const detail=await readGoal(who,input.goalId);
      if(input.action==='disconnect')requireOwnedSourceGoal(detail,who,input.goalId);
      else requireOkxGoal(detail,who,input.goalId);
      return stillBound(who);
    };
    try {
      if(!await allowed())throw new DeviceSourceError('stale_authorization');
      const result=await gateway.handle({userId:who.userId,deviceId:who.deviceId,goalId:input.goalId,input,stillAuthorized:allowed});
      if(!stillBound(who))throw new DeviceSourceError('stale_authorization');
      if(input.action==='open') {
        // hasScope now owns pending too, so the legacy vault can never be
        // adopted again even if its physical cleanup needs a later retry.
        await retireLegacy(who,input.goalId);
        if(!stillBound(who))throw new DeviceSourceError('stale_authorization');
      }
      void Promise.resolve().then(()=>pump(who)).catch(()=>{});
      return {status:200,value:result};
    }catch(error){
      const id=typeof input.eventId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(input.eventId)?input.eventId:null;
      if(id&&(error instanceof DeviceSourceError&&error.status<500||error instanceof HostError&&error.status===403)) {
        return {status:error.status??400,value:{event_id:id,status:error.code==='event_conflict'?'conflict':'rejected',reason:error instanceof DeviceSourceError?error.code:'authorization_denied'}};
      }
      throw error;
    }
  };
}

// binding(userId) 解析该用户的现役绑定（user+device）或 null：请求语境与无请求语境的
// 后台泵都按 userId 取绑定，guarded 比对捕获时与现解析的绑定是否一致。
export function deviceAwareSourceConnection({gateway,legacy,binding}) {
  function who(args){const current=binding(args.userId);if(!current)throw new HostError('配对已变化',403);return current;}
  const guarded=(args,current)=>async()=>{const latest=binding(args.userId);
    return Boolean(latest&&latest.userId===current.userId&&latest.deviceId===current.deviceId)&&(!args.stillAuthorized||await args.stillAuthorized());};
  return {
    hasSavedSource(args){
      who(args);
      return gateway.hasScope(args)?true:legacy.hasSavedSource(args);
    },
    sourceSnapshot(args){
      const current=who(args);
      if(!gateway.hasScope(args))return legacy.sourceSnapshot({...args,stillAuthorized:guarded(args,current)});
      if(!gateway.owned({...args,deviceId:current.deviceId})) {
        return gateway.handle({...args,deviceId:undefined,input:{action:'disconnect'},sourceState:'unavailable',stillAuthorized:guarded(args,current)}).then(()=>null);
      }
      return gateway.sourceSnapshot({...args,deviceId:current.deviceId,stillAuthorized:guarded(args,current)});
    },
    handle(args){
      const current=who(args);
      const bound={...args,stillAuthorized:guarded(args,current)};
      if(!gateway.hasScope(args))return legacy.handle(bound);
      if(args.input?.action==='status')return gateway.handle({...bound,deviceId:current.deviceId,input:{action:'status',provider:'okx'}});
      if(args.input?.action==='disconnect')return gateway.handle({...bound,deviceId:undefined,sourceState:args.sourceState??'disconnected'});
      throw new HostError('请在 iPhone 上连接或刷新数据源',409);
    },
  };
}
