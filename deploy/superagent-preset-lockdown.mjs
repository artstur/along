// Along 云端 Super Agent 的**读取面收紧**（docs/cloud-deploy-multi-user.md §3.5，审查 P1-1）。
//
// 问题：长驻 DSH 与 Along 业务库在**同一个容器、同一个进程树**里跑，
// 而 DSH 的文件读取工具（tool-fs / tool-fs-search / tool-bash）能读**任意绝对路径**：
// DSH 的文件沙箱只约束**写**（读一律放行——见 dsh-fs-sandbox 的说明：
// "Reads pass through untouched: every mode permits reading"），
// 所以一个会话可以直接把 ../../data/superagent/along/along.sqlite 读出来。
// 业务库里两位用户的数据在**同一张表**里（按 user_id 分行），
// 文件路径不分用户——于是 API 上的身份检查约束不了这条读取路径：
// 用户 B 的会话能把用户 A 的行读出来。
//
// 收紧口径：Tier 2 的部署形态下，会话只保留**按用户授权的工具**——
// Along 业务面的读取走 Host 的 along_* 工具（服务端绑定身份、逐行按 user_id 过滤），
// 文件与 shell 的读取面整体去掉。
//
// 为什么是**推导**而不是把上游的 preset 抄一份：
// 上游 bundle 的 preset（dsh-superagent-worker / dsh-superagent-router）与
// DSH web 模板的 preset（standard / ptc / minimal / cordis）都由上游声明，
// 本仓库若照抄一份，改上游就会漂移；而漏掉一个 preset 就是一个漏掉的读取面。
// 所以这里**读上游自己的 patch 文件**，把被禁的工具从 preset 的插件表里去掉，
// 再以「同 id 覆盖」的形式写进部署 profile 的 patch 层（profile 层在 bundle 层之后生效）。
//
// 禁掉的能力（每个都有明确的越权理由）：
//   tool-fs / tool-fs-search —— 任意路径的文件读与内容搜索：业务库、桥接凭证、DSH 会话日志都在盘上。
//   tool-bash / tool-pwsh    —— shell 同样能 cat 任意文件，且能绕过工具层的任何限制。
//   tool-subagent(-control)  —— 子代理跑在 DSH 的 standard preset 下（上游自己的注释写明），
//                                那套 preset 带全套文件与 shell 工具；留着它就是留了一条绕过收紧的旁路。
//   tool-office              —— 文档工具的读走**同一个文件系统后端**（它的注释写明
//                                "Reads use the filesystem backend's read authority"），
//                                且模型能指定源路径——所以它是一条同源的读取路径。
//   terminal-bash / tool-bash-persistent —— ptc 与 minimal preset 里的另一套 shell 入口，
//                                与 tool-bash 同样能读任意文件。
//
// 保留的能力：Along 业务工具（along_*，由上游按 ticket 绑定身份注册）、
// skill（读的是静态技能正文，不是用户数据）、todo、jobs、web（公网，与用户数据无关）。
//
// 幂等：每次启动都重新推导并重写 profile 的 patch 层，容器重启不残留旧结果。
import {createRequire} from 'node:module';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

// 被禁的模型可见工具（按上游的插件 id）。DSH 的插件 id 在各 preset 内是稳定的，
// 上游改 id 时这里会漏掉——所以推导时**同时**按插件名（npm 包名）匹配，两道口径。
const DENIED_IDS=new Set([
  'tool-fs',
  'tool-fs-search',
  'tool-bash',
  'tool-pwsh',
  'tool-subagent',
  'tool-subagent-control',
  'tool-office',
  'terminal-bash',
  'bash-persistent',
  'pwsh-persistent',
  'terminal-pwsh',
  'pty',
]);
const DENIED_NAMES=new Set([
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-office',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-terminal-pwsh',
  // PTY 宿主：它给会话一个可交互的终端，与 shell 同样能读任意文件。
  '@deepseek-ai/dsh-terminal',
]);

/**
 * 一行插件是否被禁：按 id 或按插件名。
 * @param {{id?: string, name?: string}} row - 一行插件。
 * @returns whether the row is one of the denied read paths.
 */
function denied(row) {
  return (row?.id!==undefined&&DENIED_IDS.has(row.id))||(row?.name!==undefined&&DENIED_NAMES.has(row.name));
}

/**
 * 去掉插件表里的被禁行；组（cordis:group）递归处理，空组一并去掉。
 * @param {any[]} plugins - 一份 preset 的插件表。
 * @returns the plugin table without the denied rows.
 */
function filterPlugins(plugins) {
  if (!Array.isArray(plugins)) return plugins;
  const kept=[];
  for (const row of plugins) {
    if (denied(row)) continue;
    if (Array.isArray(row?.config)) {
      const nested=filterPlugins(row.config);
      // 组里剩下的全是沙箱/编排类插件时，组本身没有模型可见能力了——去掉它，
      // 免得留下一个空壳组（它会带着 isolate 语义进作用域）。
      if (nested.length===0) continue;
      kept.push({...row,config:nested});
      continue;
    }
    kept.push(row);
  }
  return kept;
}

/**
 * 一行是不是一个 agent preset（有 config.id 与 config.plugins）。
 * @param {any} row - 一行插件。
 * @returns whether the row declares an agent preset.
 */
function isPreset(row) {
  return row?.config!==undefined&&typeof row.config==='object'&&!Array.isArray(row.config)
    &&typeof row.config.id==='string'&&Array.isArray(row.config.plugins);
}

/**
 * 读一个 patch 文件，返回它声明的行（含 `- insert:` 里的行）。
 * @param {object} deps - 依赖（require 与 yaml 载入器）。
 * @param {string} file - patch 文件路径。
 * @returns the declared rows.
 */
function readPatch(deps,file) {
  if (!existsSync(file)) return [];
  const text=readFileSync(file,'utf8');
  const rows=deps.yaml.load(text,{schema:deps.entryListSchema})??[];
  // patch 文件的两种形态：一行插件，或 `- insert:` 下一批插件。
  // 上游的 preset 都在 insert 里，所以两种都要摊平。
  const flat=[];
  for (const row of rows) {
    if (row?.insert&&Array.isArray(row.insert)) { flat.push(...row.insert); continue; }
    flat.push(row);
  }
  return flat;
}

/**
 * 推导收紧后的 preset 覆盖行。
 * @param {string} cliDir - DSH CLI 的安装目录（node_modules 在它下面）。
 * @param {string} bundleDir - bundle 的安装目录（cordis.patch.yml 在它下面）。
 * @returns the override rows, one per preset.
 */
export function lockdownRows(deps,cliDir,bundleDir) {
  const sources=[];
  // 上游 bundle 的 patch：worker 与 router 两个 preset。
  sources.push(...readPatch(deps,join(bundleDir,'cordis.patch.yml')));
  // DSH web 模板的 preset：standard / ptc / minimal / cordis。子代理跑在 standard 下，
  // 所以它和 worker/router 一样要收紧。
  const presetsDir=join(cliDir,'node_modules','@deepseek-ai','dsh-web-app','presets');
  if (existsSync(presetsDir)) {
    for (const name of readdirSync(presetsDir).sort()) {
      if (!name.endsWith('.patch.yml')) continue;
      sources.push(...readPatch(deps,join(presetsDir,name)));
    }
  }
  const rows=[];
  for (const row of sources) {
    if (!isPreset(row)) continue;
    const plugins=filterPlugins(row.config.plugins);
    if (plugins.length===row.config.plugins.length) continue; // 这一行本来就没有被禁的能力。
    rows.push({id:row.id,name:row.name,config:{...row.config,plugins}});
  }
  return rows;
}

/**
 * 顶层（全局）那几行也要关掉：它们在**任何**作用域下都是可见的，
 * 只收 preset 里的副本不够——preset 之外的入口（比如子代理继承的全局工具）仍然能读到盘。
 * @returns the global tool rows to disable.
 */
export function globalDenials() {
  return [
    {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs',disabled:true},
    {id:'tool-fs-search',name:'@deepseek-ai/dsh-tool-fs-search',disabled:true},
    {id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash',disabled:true},
    {id:'tool-pwsh',name:'@deepseek-ai/dsh-tool-pwsh',disabled:true},
  ];
}

if (process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cliDir=process.argv[2];
  const bundleDir=process.argv[3];
  if (!cliDir||!bundleDir) throw Error('需要参数：DSH CLI 目录与 bundle 目录');
  // 从 **DSH CLI 自己的** node_modules 解析：cordis-plugin-include 与 js-yaml 都在那里
  // （deploy/agent-dsh 的锁文件固定了它们），本脚本所在目录没有依赖树。
  const require=createRequire(join(cliDir,'node_modules','@deepseek-ai','dsh','package.json'));
  const {entryListSchema}=require('@deepseek-ai/cordis-plugin-include');
  const yaml=require('js-yaml');
  const deps={entryListSchema,yaml};
  const rows=[...globalDenials(),...lockdownRows(deps,cliDir,bundleDir)];
  // 用**同一个** schema 序列化：DSH 的 !!js 表达式节点必须原样保留
  // （普通 YAML 解析会把它降级成普通字符串，disabled 的语义就变了）。
  const text=yaml.dump(rows,{schema:entryListSchema,lineWidth:-1,noRefs:true});
  process.stdout.write(text);
}
