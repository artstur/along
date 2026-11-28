// 用户昵称：沿用既有用户身份，不另建账号体系。
//
// 这里只有纯逻辑：存储与渲染由 app.mjs 负责，所以昵称的归属、清洗和
// 认领规则可以直接被测试覆盖，不用起一个 DOM。
//
// 归属规则（docs/user-settings.md §2）：
//   - 已配对时昵称属于那个身份（userId）。换个身份登录就看不到别人的昵称。
//   - 还没配对时昵称先记在本机（userId 为 null）；配对确认身份后由
//     adoptProfile 认领到该身份。
//   - 认领只改昵称的归属，不改 UID，也不动配对关系与凭据。
export const PROFILE_VERSION=1;
export const NICKNAME_MAX=24;

// 控制字符会破坏显示（含换行），去掉后再去空白，超长昵称按上限裁剪。
const CONTROL_CHARS=new RegExp('[\\u0000-\\u001f\\u007f]','g');

export function cleanNickname(value) {
  if (typeof value!=='string') return '';
  return value.replace(CONTROL_CHARS,'').trim().slice(0,NICKNAME_MAX);
}

export function readProfile(raw) {
  try {
    const value=JSON.parse(raw);
    if (!value||value.version!==PROFILE_VERSION||typeof value.nickname!=='string') return null;
    return {version:PROFILE_VERSION,nickname:value.nickname,userId:typeof value.userId==='string'?value.userId:null};
  } catch { return null; }
}

export function writeProfile(record) {
  return JSON.stringify({version:PROFILE_VERSION,nickname:record.nickname,userId:record.userId??null});
}

// 某个身份下应该显示的昵称：还没有配对时显示本机记的那条；配对后只显示属于自己的那条。
export function profileNickname(record,userId) {
  if (!record) return '';
  if (record.userId===null||record.userId===undefined) return record.nickname;
  return record.userId===userId?record.nickname:'';
}

// 身份确认后认领本机上的昵称：只改归属，UID 与配对关系不变。
export function adoptProfile(record,userId) {
  if (!record||!userId) return record;
  if (record.userId!==null&&record.userId!==undefined) return record;
  return {...record,userId};
}

// 保存昵称：沿用当前身份；还没配对就先记在本机上。
export function setNickname(record,nickname,userId) {
  const clean=cleanNickname(nickname);
  if (!clean) return null; // 清空昵称：删掉记录本身。
  return {version:PROFILE_VERSION,nickname:clean,userId:userId??null};
}
