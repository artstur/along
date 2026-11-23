// Along 云端 Super Agent 的设置播种（docs/cloud-deploy-multi-user.md §3.5 Tier 2）。
//
// 为什么要在第一次 boot 之前播种，而不是起来之后再调管理面 API：
//
// Runtime 的构造函数里 assembleAlong() 读**已经存好的设置**来决定是否组装 Along 业务面
//（along-superagent/src/app/runtime.ts：`settings.sources.along?.enabled === true &&
// settings.sources.github?.enabled === false`）。设置不存在时它返回 undefined：不组装业务库、
// 不注册 /along-source 路由、也不生成桥接凭证文件。此时再从管理面补设置，会触发一次
// Runtime 重启才生效——多一次启动窗口，而重启窗口正是 V-1 暴露的投递丢失窗口。
// 所以设置必须在**第一次 boot 之前**落库。
//
// 为什么直接写库而不是调管理面 API：
// 管理面只暴露「按块保存」（PUT /orchestrator/api/settings/<block>），来源实例要按
// source:<id> 一块块存；而 source:github 这一块在 GitHub Source 未安装时会被
//「Source not found」挡掉（along-superagent/src/app/http.ts 的 known 判定）。
// 直接写库绕开了这个限制，也绕开了「保存设置会触发重启」的时序。
//
// 写库的形状必须与 Store 的持久化格式一致（along-superagent/src/app/store.ts 与
// src/app/versions.ts）：设置是**带版本**的快照——键 `settings-revision` 指向当前版本号，
// 键 `settings-version:<n>` 存第 n 版快照。少写指针，Store.settings() 就读不到设置。
// 指针的值是 JSON 数字（Store.get 用 JSON.parse 解析 value 列）。
//
// 幂等：已经有设置（settings-revision 存在）就什么都不做——运维在面板上改过的设置
// 不会被容器重启覆盖。
//
// 这里的 SQL 只写 kv 表（设置快照所在的那张表）。其余表由 Store 在打开数据库时创建
//（CREATE TABLE IF NOT EXISTS），不需要这里重复实现 schema。**不写 schema 版本键**：
// 那个键由 Store 自己维护，预写会让 Runtime 以为数据库需要迁移
//（along-superagent/src/app/store.ts：version < SCHEMA_VERSION 即迁移）。
import {DatabaseSync} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

const engineDir=process.argv[2];
if(!engineDir) throw Error('需要编排库目录参数（stateDir/engine）');

mkdirSync(engineDir,{recursive:true,mode:0o700});
const dbPath=join(engineDir,'orchestrator.sqlite');
const db=new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const pointer=db.prepare('SELECT value FROM kv WHERE key=?').get('settings-revision');
  if(pointer) {
    // 已经有设置：不动（容器重启不覆盖运维改过的值）。
    console.log('设置已存在，跳过播种。');
  } else {
    // 设置快照（第 1 版）。字段与 SettingsVersion 对齐（along-superagent/src/app/store.ts），
    // settings 的字段与 SettingsSchema 对齐（src/policy.ts）：
    // sources.along 开、sources.github **显式** 关——assembleAlong 要求 github 明确为 false，
    //「没配」不等于「关了」；eval.mode=auto 是 Along 业务面的既定要求。
    const settings={
      paused:false,
      sources:{
        along:{enabled:true,config:{}},
        github:{enabled:false,config:{}},
      },
      // policy.rules 留空：SettingsSchema 给它默认值（DEFAULT_RULES），不需要在这里复述。
      policy:{sources:{}},
      eval:{mode:'auto'},
      executor:{},
    };
    const version={
      revision:1,
      savedAt:new Date().toISOString(),
      source:'internal',
      policyVersion:'',
      policyChanged:false,
      notified:[],
      settings,
    };
    const set=db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    set.run('settings-version:1',JSON.stringify(version));
    // 指针的值是 JSON 数字——Store.get() 对 value 列做 JSON.parse，裸数字会被解析成 number。
    set.run('settings-revision',JSON.stringify(1));
    console.log('已播种 Along 部署设置（Along Source 开、GitHub Source 关）。');
  }
} finally {
  db.close();
}
chmodSync(dbPath,0o600);
