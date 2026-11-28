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
//   - 还没配对时昵称先记在本机桶 `|`；配对确认身份后认领到该身份。
// 认领只改昵称的归属，不改 UID，也不动配对关系与凭据。
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

// 本机桶：还没配对时昵称先落在这里，等身份确认后再认领。
export const DEVICE_SCOPE=scopeKey('','');

// 旧版（v1）昵称只记了 UID、没有 Host 维度，升级后先放在「只有 UID」的桶里，
// 等 UID 对得上的身份来认领——不会跟着 UID 相同但 Host 不同的身份跑过去。
export function legacyBucket(userId) {
  return scopeKey('',userId||'');
}

// 读本机存的昵称。旧版（v1）只有一条记录、只按 UID 区分，升级后放进旧桶：
// 旧记录没有 Host 维度，硬套到当前身份上会串到另一台 Host 上。
export function readProfile(raw) {
  let value;
  try { value=JSON.parse(raw); } catch { return {version:PROFILE_VERSION,nicknames:{}}; }
  if (!value||typeof value!=='object') return {version:PROFILE_VERSION,nicknames:{}};
  if (value.version===PROFILE_VERSION&&value.nicknames&&typeof value.nicknames==='object') {
    const nicknames={};
    for (const [scope,name] of Object.entries(value.nicknames)) {
      if (typeof scope!=='string'||!scope) continue;
      const clean=cleanNickname(name);
      if (clean) nicknames[scope]=clean;
    }
    return {version:PROFILE_VERSION,nicknames};
  }
  if (value.version===1&&typeof value.nickname==='string') {
    const clean=cleanNickname(value.nickname);
    const owner=typeof value.userId==='string'&&value.userId?value.userId:null;
    return {version:PROFILE_VERSION,nicknames:clean?{[legacyBucket(owner)]:clean}:{}};
  }
  return {version:PROFILE_VERSION,nicknames:{}};
}

export function writeProfile(profile) {
  const nicknames={};
  for (const [scope,name] of Object.entries(profile?.nicknames||{})) {
    const clean=cleanNickname(name);
    if (clean&&typeof scope==='string'&&scope) nicknames[scope]=clean;
  }
  return JSON.stringify({version:PROFILE_VERSION,nicknames});
}

// 某个作用域下应该显示的昵称：只认这一条，不跨作用域回落。
export function profileNickname(profile,scope) {
  return cleanNickname(profile?.nicknames?.[scope]??'');
}

// 身份确认后认领还挂着的昵称：只在该作用域还没有昵称时认领。
// 认领来源按「同 Host 优先、再到同 UID 的旧桶、最后到本机」：
//   - 同一台 Host 补上 UID 不该换掉昵称；
//   - 旧版记录只有 UID，UID 对得上才认领；
//   - 换到另一台 Host 时不能把上一台 Host 的昵称带过去。
export function adoptProfile(profile,scope) {
  if (!profile||!scope||scope===DEVICE_SCOPE) return profile;
  if (profile.nicknames?.[scope]) return profile;
  const [host,userId]=scope.split('|');
  const sources=[host?scopeKey(host,''):null,userId?legacyBucket(userId):null,DEVICE_SCOPE].filter(Boolean);
  for (const source of sources) {
    const pending=cleanNickname(profile.nicknames?.[source]??'');
    if (!pending) continue;
    const nicknames={...profile.nicknames};
    nicknames[scope]=pending;
    delete nicknames[source];
    return {version:PROFILE_VERSION,nicknames};
  }
  return profile;
}

// 保存昵称：沿用当前作用域；清空昵称就是把这条删掉。
export function setNickname(profile,scope,nickname) {
  const clean=cleanNickname(nickname);
  const nicknames={...(profile?.nicknames||{})};
  if (!clean) delete nicknames[scope];
  else nicknames[scope]=clean;
  return {version:PROFILE_VERSION,nicknames};
}
