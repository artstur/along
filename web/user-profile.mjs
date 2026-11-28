// 用户昵称：沿用既有用户身份，不另建账号体系。
//
// 这里只有纯逻辑：存储与渲染由 app.mjs 负责，所以昵称的归属、清洗和
// 认领规则可以直接被测试覆盖，不用起一个 DOM。
//
// 归属规则（docs/user-settings.md §2）：昵称属于「已核验的 Host + UID」
// 这一对身份，作用域键就是 `${host}|${uid}`：
//   - 同一对身份重启后仍是同一个昵称；
//   - 同一台 Host 换用户（UID 变了）看不到别人的昵称；
//   - 换一台 Host（哪怕回传同一个 UID）也看不到别人的昵称；
//   - 还没连上任何 Host 时昵称先记在本机桶 `|`；连上后认领到该身份。
// 认领只改昵称的归属，不改 UID，也不动配对关系与凭据。
//
// 旧协议 Host 不回传 UID，这时作用域是 `${host}|`（这台 Host 自己）。
// 这种昵称记下它属于哪一次绑定（legacyOwners）：同一个绑定升级协议时可以认领，
// 换配对码重新配对（凭据变了）就不认领——新身份先独立显示。
// 存储格式仍是 v2（`{version,nicknames}`）；v2 记录新增一个可选的 legacyOwners 字段，
// 记「旧协议 Host 的待认领昵称属于哪一次绑定」。老记录没有这个字段也能读。
export const PROFILE_VERSION=2;
export const NICKNAME_MAX=24;

// 控制字符会破坏显示（含换行），去掉后再去空白，超长昵称按上限裁剪。
const CONTROL_CHARS=new RegExp('[\\u0000-\\u001f\\u007f]','g');

export function cleanNickname(value) {
  if (typeof value!=='string') return '';
  return value.replace(CONTROL_CHARS,'').trim().slice(0,NICKNAME_MAX);
}

// 作用域键：Host 与 UID 都在时才算一个完整身份；缺哪一半就先落在缺哪一半的桶里。
export function scopeKey(host,userId) {
  return `${host||''}|${userId||''}`;
}

// 本机桶：还没连上任何 Host 时昵称先落在这里，等身份确认后再认领。
export const DEVICE_SCOPE=scopeKey('','');

// 旧版（v1）昵称只记了 UID、没有 Host 维度，升级后先放在「只有 UID」的桶里，
// 等 UID 对得上的身份来认领——不会跟着 UID 相同但 Host 不同的身份跑过去。
export function legacyBucket(userId) {
  return scopeKey('',userId||'');
}

// 作用域里的 Host 部分（`${host}|${uid}` 的 host）。
export function hostOfScope(scope) {
  if (typeof scope!=='string') return '';
  const index=scope.indexOf('|');
  return index<0?'':scope.slice(0,index);
}

// 「连上了这台 Host，但它不认 UID（旧协议）」的作用域：Host 有、UID 空。
export function isLegacyScope(scope) {
  if (typeof scope!=='string') return false;
  const host=hostOfScope(scope);
  const uid=scope.slice(scope.indexOf('|')+1);
  return !!host&&!uid;
}

// 绑定的稳定标识：原生给的 bindingScopeId 不是凭证，可以直接用；
// 旧形态没有它时只落到 token —— 那时取一次不可逆摘要，
// 不把凭据本身写进昵称存储。
export function bindingFingerprint(config) {
  const scopeId=config?.bindingScopeId;
  if (typeof scopeId==='string'&&scopeId) return scopeId;
  const token=typeof config?.token==='string'?config.token:'';
  if (!token) return '';
  // FNV-1a 的两轮不同初值：够用的稳定摘要，不是加密，也不泄露凭据。
  let low=0x811c9dc5,high=0x01000193;
  for (let index=0;index<token.length;index+=1) {
    const code=token.charCodeAt(index);
    low=Math.imul(low^code,16777619)>>>0;
    high=Math.imul(high^code,2246822519)>>>0;
  }
  return `${low.toString(36)}.${high.toString(36)}`;
}

// 读本机存的昵称。旧版（v1）只有一条记录、只按 UID 区分，升级后放进旧桶：
// 旧记录没有 Host 维度，硬套到当前身份上会串到另一台 Host 上。
export function readProfile(raw) {
  let value;
  try { value=JSON.parse(raw); } catch { return {version:PROFILE_VERSION,nicknames:{},legacyOwners:{}}; }
  if (!value||typeof value!=='object') return {version:PROFILE_VERSION,nicknames:{},legacyOwners:{}};
  if (value.version===PROFILE_VERSION&&value.nicknames&&typeof value.nicknames==='object') {
    const nicknames={};
    for (const [scope,name] of Object.entries(value.nicknames)) {
      if (typeof scope!=='string'||!scope) continue;
      const clean=cleanNickname(name);
      if (clean) nicknames[scope]=clean;
    }
    const legacyOwners={};
    for (const [host,owner] of Object.entries(value.legacyOwners||{})) {
      if (typeof host==='string'&&host&&typeof owner==='string'&&owner) legacyOwners[host]=owner;
    }
    return {version:PROFILE_VERSION,nicknames,legacyOwners};
  }
  if (value.version===1&&typeof value.nickname==='string') {
    const clean=cleanNickname(value.nickname);
    const owner=typeof value.userId==='string'&&value.userId?value.userId:null;
    return {version:PROFILE_VERSION,nicknames:clean?{[legacyBucket(owner)]:clean}:{},legacyOwners:{}};
  }
  return {version:PROFILE_VERSION,nicknames:{},legacyOwners:{}};
}

export function writeProfile(profile) {
  const nicknames={};
  for (const [scope,name] of Object.entries(profile?.nicknames||{})) {
    const clean=cleanNickname(name);
    if (clean&&typeof scope==='string'&&scope) nicknames[scope]=clean;
  }
  const legacyOwners={};
  for (const [host,owner] of Object.entries(profile?.legacyOwners||{})) {
    if (typeof host==='string'&&host&&typeof owner==='string'&&owner) legacyOwners[host]=owner;
  }
  return JSON.stringify({version:PROFILE_VERSION,nicknames,legacyOwners});
}

// 某个作用域下应该显示的昵称：只认这一条，不跨作用域回落。
export function profileNickname(profile,scope) {
  return cleanNickname(profile?.nicknames?.[scope]??'');
}

// 身份确认后认领还挂着的昵称：只在该作用域还没有昵称时认领。
// 认领来源按「同 Host 的旧协议桶（同绑定才认）、同 UID 的旧桶、最后到本机」：
//   - 同一台 Host 补上 UID 不该换掉昵称；
//   - 旧协议 Host 的昵称只归它那一次绑定：换配对码重新配对就不认领；
//   - 旧版记录只有 UID，UID 对得上才认领；
//   - 换到另一台 Host 时不能把上一台 Host 的昵称带过去。
export function adoptProfile(profile,scope,{binding=''}={}) {
  if (!profile||!scope||scope===DEVICE_SCOPE) return profile;
  if (profile.nicknames?.[scope]) return profile;
  const host=hostOfScope(scope);
  const uid=scope.slice(scope.indexOf('|')+1);
  const candidates=[
    {scope:host?scopeKey(host,''):null,needsSameBinding:true},
    {scope:uid?legacyBucket(uid):null,needsSameBinding:false},
    {scope:DEVICE_SCOPE,needsSameBinding:false},
  ];
  for (const candidate of candidates) {
    if (!candidate.scope) continue;
    if (candidate.needsSameBinding&&profile.legacyOwners?.[host]!==binding) continue;
    const pending=cleanNickname(profile.nicknames?.[candidate.scope]??'');
    if (!pending) continue;
    const nicknames={...profile.nicknames};
    nicknames[scope]=pending;
    delete nicknames[candidate.scope];
    const legacyOwners={...(profile.legacyOwners||{})};
    if (candidate.needsSameBinding) delete legacyOwners[host];
    // 认领到旧协议作用域（这台 Host 还没认出 UID）时，记下这次绑定：
    // 等它认出 UID 时，同一个绑定才能把昵称领过去（首次配对的昵称就是这么跟过去的）。
    if (isLegacyScope(scope)&&binding) legacyOwners[host]=binding;
    return {version:PROFILE_VERSION,nicknames,legacyOwners};
  }
  return profile;
}

// 保存昵称：沿用当前作用域；清空昵称就是把这条删掉。
// 旧协议作用域（`${host}|`）要记下这次绑定：只有同一个绑定升级协议时才认领，
// 换配对码重新配对（凭据变了）时新身份独立显示。
export function setNickname(profile,scope,nickname,{legacyOwner=''}={}) {
  const clean=cleanNickname(nickname);
  const nicknames={...(profile?.nicknames||{})};
  const legacyOwners={...(profile?.legacyOwners||{})};
  if (!clean) delete nicknames[scope];
  else nicknames[scope]=clean;
  if (legacyOwner&&isLegacyScope(scope)) legacyOwners[hostOfScope(scope)]=legacyOwner;
  return {version:PROFILE_VERSION,nicknames,legacyOwners};
}
