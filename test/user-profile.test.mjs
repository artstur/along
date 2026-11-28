import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_VERSION,NICKNAME_MAX,cleanNickname,readProfile,writeProfile,profileNickname,adoptProfile,setNickname,scopeKey,DEVICE_SCOPE,legacyBucket} from '../web/user-profile.mjs';

// 昵称是显示名，不是身份：写它不改 UID，也不改配对关系。
// 这条文件的规则来自 docs/user-settings.md §2：昵称属于「已核验的 Host + UID」
// 这一对身份，所以作用域键就是 `${host}|${uid}`。
const HOST_A='https://a.example.com:443';
const HOST_B='https://b.example.com:443';
const UID='u_12345678';
const OTHER='u_87654321';

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
  assert.deepEqual(record,{version:PROFILE_VERSION,nicknames:{[scope]:'小明'}});
  const restored=readProfile(writeProfile(record));
  assert.deepEqual(restored,record);
  assert.equal(profileNickname(restored,scope),'小明');
});

test('a broken or foreign stored profile is ignored instead of throwing',()=>{
  const empty={version:PROFILE_VERSION,nicknames:{}};
  assert.deepEqual(readProfile(null),empty);
  assert.deepEqual(readProfile('not json'),empty);
  assert.deepEqual(readProfile('{"version":3,"nickname":"x"}'),empty);
  assert.deepEqual(readProfile('{"version":2,"nicknames":{"a":7}}'),empty);
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

test('clearing the nickname removes the entry instead of storing an empty one',()=>{
  const scope=scopeKey(HOST_A,UID);
  const record=setNickname(setNickname(null,scope,'小明'),scope,'');
  assert.deepEqual(record,{version:PROFILE_VERSION,nicknames:{}});
  assert.equal(profileNickname(record,scope),'');
});
