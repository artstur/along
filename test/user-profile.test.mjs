import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_VERSION,NICKNAME_MAX,cleanNickname,readProfile,writeProfile,profileNickname,adoptProfile,setNickname,scopeKey,DEVICE_SCOPE,legacyBucket,isLegacyScope,hostOfScope,bindingFingerprint} from '../web/user-profile.mjs';

// 昵称是显示名，不是身份：写它不改 UID，也不改配对关系。
// 这条文件的规则来自 docs/user-settings.md §2：昵称属于「已核验的 Host + UID」
// 这一对身份，所以作用域键就是 `${host}|${uid}`。
const HOST_A='https://a.example.com:443';
const HOST_B='https://b.example.com:443';
const UID='u_12345678';
const OTHER='u_87654321';
const BINDING='binding-a';
const OTHER_BINDING='binding-b';

test('a nickname is cleaned, trimmed and capped',()=>{
  assert.equal(cleanNickname('  小明  '),'小明');
  assert.equal(cleanNickname('小\n明'),'小明');
  assert.equal(cleanNickname('x'.repeat(50)),'x'.repeat(NICKNAME_MAX));
  assert.equal(cleanNickname(''),'');
  assert.equal(cleanNickname(null),'');
  assert.equal(cleanNickname(42),'');
});

test('a nickname round-trips through storage without losing its owner',()=>{
  const scope=scopeKey(HOST_A,UID);
  const record=setNickname(null,scope,'小明');
  assert.deepEqual(record,{version:PROFILE_VERSION,nicknames:{[scope]:'小明'},legacyOwners:{}});
  const restored=readProfile(writeProfile(record));
  assert.deepEqual(restored,record);
  assert.equal(profileNickname(restored,scope),'小明');
});

test('a broken or foreign stored profile is ignored instead of throwing',()=>{
  const empty={version:PROFILE_VERSION,nicknames:{},legacyOwners:{}};
  assert.deepEqual(readProfile(null),empty);
  assert.deepEqual(readProfile('not json'),empty);
  assert.deepEqual(readProfile('{"version":9,"nickname":"x"}'),empty);
  assert.deepEqual(readProfile('{"version":3,"nicknames":{"a":7}}'),empty);
});

test('the same Host and UID keeps the same nickname',()=>{
  const scope=scopeKey(HOST_A,UID);
  const record=setNickname(null,scope,'小明');
  assert.equal(profileNickname(record,scope),'小明');
});

test('two Hosts returning the same UID never see each other nickname',()=>{
  const scopeA=scopeKey(HOST_A,UID);
  const scopeB=scopeKey(HOST_B,UID);
  const first=setNickname(null,scopeA,'OnlyHostA');
  const second=setNickname(first,scopeB,'OnlyHostB');
  assert.equal(profileNickname(second,scopeA),'OnlyHostA','回到 Host A 要拿回 A 的昵称');
  assert.equal(profileNickname(second,scopeB),'OnlyHostB');
});

test('another UID on the same Host neither sees nor overwrites the nickname',()=>{
  const scope=scopeKey(HOST_A,UID);
  const other=scopeKey(HOST_A,OTHER);
  const first=setNickname(null,scope,'First');
  const second=setNickname(first,other,'Second');
  assert.equal(profileNickname(second,scope),'First','换个 UID 不能覆盖原来的昵称');
  assert.equal(profileNickname(second,other),'Second');
});

test('a nickname set before pairing stays visible, then belongs to the paired identity',()=>{
  const pending=setNickname(null,DEVICE_SCOPE,'小明');
  assert.equal(profileNickname(pending,DEVICE_SCOPE),'小明');
  const adopted=adoptProfile(pending,scopeKey(HOST_A,UID));
  assert.equal(profileNickname(adopted,scopeKey(HOST_A,UID)),'小明');
  assert.equal(profileNickname(adopted,DEVICE_SCOPE),'','认领后本机桶就不再占着这条');
});

test('adopting never carries a nickname to another Host',()=>{
  const owned=setNickname(null,scopeKey(HOST_A,UID),'小明');
  const adopted=adoptProfile(owned,scopeKey(HOST_B,UID));
  assert.equal(profileNickname(adopted,scopeKey(HOST_B,UID)),'');
  assert.equal(profileNickname(adopted,scopeKey(HOST_A,UID)),'小明','Host A 的昵称还留在 Host A 名下');
});

test('a v1 record migrates into the legacy bucket and is claimed by the same UID only',()=>{
  const legacy=readProfile(JSON.stringify({version:1,nickname:'旧名字',userId:UID}));
  assert.equal(profileNickname(legacy,scopeKey(HOST_A,UID)),'','刚读出来时还没归到身份上');
  const adopted=adoptProfile(legacy,scopeKey(HOST_A,UID));
  assert.equal(profileNickname(adopted,scopeKey(HOST_A,UID)),'旧名字');
  // 另一个 UID 认领不了这条旧记录。
  const other=adoptProfile(legacy,scopeKey(HOST_A,OTHER));
  assert.equal(profileNickname(other,scopeKey(HOST_A,OTHER)),'');
  assert.equal(profileNickname(legacy,legacyBucket(UID)),'旧名字');
});

test('a v2 record without owners still reads back with its nicknames',()=>{
  const legacy=readProfile(JSON.stringify({version:2,nicknames:{[`${HOST_A}|${UID}`]:'旧名字'}}));
  assert.equal(legacy.version,PROFILE_VERSION);
  assert.equal(profileNickname(legacy,`${HOST_A}|${UID}`),'旧名字');
  assert.deepEqual(legacy.legacyOwners,{});
});

test('a legacy Host nickname belongs to its binding and is only claimed by the same binding',()=>{
  const legacyScope=scopeKey(HOST_A,'');
  assert.equal(isLegacyScope(legacyScope),true);
  assert.equal(isLegacyScope(scopeKey(HOST_A,UID)),false);
  assert.equal(isLegacyScope(DEVICE_SCOPE),false);
  assert.equal(hostOfScope(legacyScope),HOST_A);
  // 旧协议 Host（不认 UID）的昵称记下它属于哪一次绑定。
  const saved=setNickname(null,legacyScope,'LegacyA',{legacyOwner:BINDING});
  assert.equal(profileNickname(saved,legacyScope),'LegacyA');
  assert.equal(saved.legacyOwners[HOST_A],BINDING);
  // 同一个绑定升级协议（认出了 UID）：昵称跟着走。
  const sameBinding=adoptProfile(saved,scopeKey(HOST_A,UID),{binding:BINDING});
  assert.equal(profileNickname(sameBinding,scopeKey(HOST_A,UID)),'LegacyA');
  // 换配对码重新配对（凭据变了）：新身份独立，旧昵称不认领。
  const newBinding=adoptProfile(saved,scopeKey(HOST_A,UID),{binding:OTHER_BINDING});
  assert.equal(profileNickname(newBinding,scopeKey(HOST_A,UID)),'','换了绑定就不能认领旧昵称');
  assert.equal(profileNickname(newBinding,legacyScope),'LegacyA','旧昵称仍留在旧绑定名下');
});

test('clearing the nickname removes the entry instead of storing an empty one',()=>{
  const scope=scopeKey(HOST_A,UID);
  const record=setNickname(setNickname(null,scope,'小明'),scope,'');
  assert.deepEqual(record,{version:PROFILE_VERSION,nicknames:{},legacyOwners:{}});
  assert.equal(profileNickname(record,scope),'');
});

test('the binding fingerprint never exposes the credential itself',()=>{
  const token='a'.repeat(64);
  const fingerprint=bindingFingerprint({token});
  assert.ok(fingerprint&&!fingerprint.includes(token),'摘要里不能出现凭据本身');
  assert.equal(fingerprint,bindingFingerprint({token}),'同一个凭据的摘要要稳定');
  assert.notEqual(fingerprint,bindingFingerprint({token:'b'.repeat(64)}),'不同凭据的摘要要不同');
  // 原生给的 bindingScopeId 不是凭证，可以直接用。
  assert.equal(bindingFingerprint({bindingScopeId:'scope-1',token}),'scope-1');
  assert.equal(bindingFingerprint({}),'');
});
