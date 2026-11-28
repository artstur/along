import test from 'node:test';
import assert from 'node:assert/strict';
import {PROFILE_VERSION,NICKNAME_MAX,cleanNickname,readProfile,writeProfile,profileNickname,adoptProfile,setNickname} from '../web/user-profile.mjs';

// 昵称是显示名，不是身份：写它不改 UID，也不改配对关系。
// 这条文件的规则来自 docs/user-settings.md §2。

test('a nickname is cleaned, trimmed and capped',()=>{
  assert.equal(cleanNickname('  小明  '),'小明');
  assert.equal(cleanNickname('小\n明'),'小明');
  assert.equal(cleanNickname('x'.repeat(50)),'x'.repeat(NICKNAME_MAX));
  assert.equal(cleanNickname(''),'');
  assert.equal(cleanNickname(null),'');
  assert.equal(cleanNickname(42),'');
});

test('a profile round-trips through storage without losing the owner',()=>{
  const record=setNickname(null,'小明','u_12345678');
  assert.deepEqual(record,{version:PROFILE_VERSION,nickname:'小明',userId:'u_12345678'});
  const restored=readProfile(writeProfile(record));
  assert.deepEqual(restored,record);
});

test('a broken or foreign stored profile is ignored instead of throwing',()=>{
  assert.equal(readProfile(null),null);
  assert.equal(readProfile('not json'),null);
  assert.equal(readProfile('{"version":2,"nickname":"x"}'),null);
  assert.equal(readProfile('{"version":1}'),null);
  assert.equal(readProfile('{"version":1,"nickname":7}'),null);
});

test('a nickname set before pairing stays visible, then belongs to the paired identity',()=>{
  const pending=setNickname(null,'小明',null);
  assert.equal(profileNickname(pending,null),'小明');
  const adopted=adoptProfile(pending,'u_12345678');
  assert.equal(adopted.userId,'u_12345678');
  assert.equal(adopted.nickname,'小明');
  assert.equal(profileNickname(adopted,'u_12345678'),'小明');
});

test('a nickname never leaks across identities',()=>{
  const owned=setNickname(null,'小明','u_12345678');
  assert.equal(profileNickname(owned,'u_87654321'),'');
  assert.equal(profileNickname(owned,'u_12345678'),'小明');
});

test('adopting an already-owned nickname leaves the owner alone',()=>{
  const owned=setNickname(null,'小明','u_12345678');
  assert.deepEqual(adoptProfile(owned,'u_87654321'),owned);
});

test('clearing the nickname removes the record instead of storing an empty one',()=>{
  assert.equal(setNickname(null,'   ',null),null);
  assert.equal(setNickname(setNickname(null,'小明',null),'',null),null);
});

test('an unpaired device still shows the nickname it saved',()=>{
  const pending=setNickname(null,'小明',null);
  assert.equal(profileNickname(pending,null),'小明');
  // 认领之前，别的身份看不到它。
  assert.equal(profileNickname(pending,'u_12345678'),'小明');
});
