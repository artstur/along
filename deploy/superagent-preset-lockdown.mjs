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
// 口径是**白名单**而不是黑名单（复核意见 P1-1 的第二轮）：
// 黑名单只挡住「已经列出来的」那些能力，上游新增一个带读盘能力的工具插件，
// 黑名单就漏一个——而漏一个就是一个新的越权读取面。白名单的口径是：
// **模型可见的工具插件只有 ALLOWED_TOOL_PACKAGES 里那几个**，
// 其余（无论上游叫什么）一律不留在任何作用域里。
// 上游新增工具时默认被挡，而不是默认被放行。
//
// 作用域有两层，两个都要查：
//   - 顶层（全局）：DSH 的 web 模板把模型可见工具挪到 preset 里，顶层是「关掉」的；
//     但顶层仍有别的入口（工作流引擎、宿主配置检查、团队会话消息），
//     它们在任何作用域下都可见，只收 preset 里的副本不够。
//   - preset：worker / router（上游 bundle 声明）与 standard / ptc / minimal / cordis
//     （DSH web 模板声明）。子代理跑在 standard 下（上游自己的注释写明），
//     所以 standard 与其余 preset 一样要收紧。
// 而且**可用 preset 本身要收窄**：Tier 2 是无人值守的长驻服务，
// Web 交互用的四套 preset（standard/ptc/minimal/cordis）在部署形态下没有用途，
// 留着 standard 就等于留着子代理与工作流引擎的默认落点。
//
// 「最终生效配置」才是判据：推导只产生补丁行，真正被检查的是
// **补丁写完之后** compose 出来的那份配置（dsh --dump-config）。
// 所以这个脚本有两个动作：
//   derive —— 从上游自己的 patch 推导收紧补丁（读上游声明，不抄一份）。
//   verify —— 逐作用域检查**最终生效配置**：有任何一处白名单外的模型可见能力，
//              就非零退出（启动脚本据此拒绝启动）。
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
//   tool-workflow / workflow-ptc —— 工作流引擎：它能起**子会话**（子会话按 standard
//                                或别的 preset 拿工具，是绕过收紧的另一条路）。
//   tool-cordis              —— 宿主配置检查（cordis_inspect_*）：读的是**宿主运行时**
//                                的插件与配置面，含本地路径与配置值。
//   tool-plugin-manager / tool-plugin-market —— 宿主配置改写面：能装任意插件
//                                （装插件 = 任意代码执行 = 任意读盘）。
//   tool-agent-team          —— 团队会话消息面（send_message / list_agents /
//                                interrupt_agent）：能触达**别的会话**（别的用户的数据面）。
//   tool-present / tool-working-directory / tool-session-query —— 文件stat、路径与
//                                会话日志的读出面。
//   office-kit / skill-office —— 文档读走同一个文件系统后端（office-kit 的注释写明
//                                "private disk input/output"）。
//
// 白名单口径下，上面这些**不需要**逐个列进黑名单（不在白名单 = 一律去掉）。
// 但清单要**可审计**——下面这份「被去掉的能力」是给人看的：
//   dsh-tool-fs            任意路径的文件读
//   dsh-tool-fs-search     任意路径的内容搜索
//   dsh-tool-bash          shell（能 cat 任意文件，且绕过工具层的任何限制）
//   dsh-tool-pwsh          同上（PowerShell）
//   dsh-tool-bash-persistent  持久 shell（minimal preset 的入口）
//   dsh-tool-pwsh-persistent  同上
//   dsh-terminal            PTY 宿主（可交互终端）
//   dsh-terminal-bash       终端 shell
//   dsh-terminal-panel      终端面板（能读别的会话的终端输出）
//   dsh-tool-terminal       终端控制工具
//   dsh-tool-office         文档工具（读走同一个文件系统后端）
//   dsh-office-kit          文档后端（private disk input/output）
//   dsh-skill-office        文档技能
//   dsh-tool-subagent       子代理（子会话按 standard 拿工具 = 绕过收紧的旁路）
//   dsh-tool-subagent-control  子会话控制（send_message / interrupt_agent）
//   dsh-tool-workflow       工作流引擎（能起子会话）
//   dsh-workflow-ptc        工作流引擎（ptc 变体）
//   dsh-tool-cordis         宿主配置检查（读宿主运行时配置面）
//   dsh-plugin-manager/tools 宿主配置改写（装插件 = 任意代码执行）
//   dsh-plugin-market/tools  宿主插件市场
//   dsh-tool-agent-team     团队会话消息（能触达别的会话 = 别的用户的数据面）
//   dsh-tool-present        文件 stat（读出面）
//   dsh-tool-working-directory  路径读出面
//   dsh-tool-session-query  会话日志读出面
//   dsh-tool-web            web 工具（web_fetch 对本机回环没有私网拦截）
//   dsh-mcp-resources       MCP 资源读取
//   dsh-subagent            子代理运行时
//   dsh-cua                 电脑操作（截图 = 读屏幕上的一切）
//   dsh-plan-mode           计划模式
//   dsh-action-cards        动作卡片
//   dsh-tool-schedule       调度
//   dsh-tool-goal           目标
//   dsh-tool-ask-user       问人
//   dsh-tool-str-replace-editor  字符串编辑（走文件后端）
//   dsh-tool-ralph          迭代循环
//
// 保留的能力：Along 业务工具（along_*，由上游按 ticket 绑定身份注册，
// **不在 preset 的插件表里**——它是上游按 ticket 注册到 agent 上的，不受 preset 收紧影响）、
// skill（读的是静态技能正文，不是用户数据）、todo、jobs。
// web 不保留：DSH 的 web_fetch 对**本机回环**没有私网地址拦截，
// 留着它就是一条到 127.0.0.1:3082（桥接管理面）的路；上游另有
// along_web_search / along_web_fetch（自带公开 URL 口径）。
//
// 幂等：每次启动都重新推导并重写 profile 的 patch 层，容器重启不残留旧结果。
import {createRequire} from 'node:module';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

// 模型可见工具插件的判定口径：**包名**。
//
// 为什么按包名而不是按插件 id：id 是声明处给的短名（tool-fs / tool-workflow / …），
// 上游改 id 时黑名单会漏；包名是 npm 包名（@deepseek-ai/dsh-tool-*），稳定得多。
//
// 名单是**按 DSH 自己的源码查出来的**：凡是 `ctx.tools.register(...)` 的包，
// 就是模型可见的工具。逐个包对过（deploy/agent-dsh/node_modules/@deepseek-ai/dsh-*/src），
// 不靠猜名字前缀——名字像工具的包里有好几个**不是**模型工具（执行器、超时策略、
// 压缩裁剪、子代理模型选择设置），漏判成工具会把执行器也关掉（工具就没人执行了）。
const MODEL_TOOL_PREFIX='@deepseek-ai/dsh-tool-';

// 名字像工具、其实不是模型可见工具的基础设施插件：执行器（跑工具的）、
// 超时策略、压缩裁剪、子代理模型选择设置。它们必须留着（工具要有人执行）。
const INFRA_PACKAGES=new Set([
  '@deepseek-ai/dsh-tool-executor-native',
  '@deepseek-ai/dsh-tool-executor-ptc',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
  // 工作区依赖查询：只报内置 Python/Node 运行时的**绝对路径**，
  // 不读用户数据（读的是打包在镜像里的运行时装载），留着它工具执行器才有环境。
  '@deepseek-ai/dsh-tool-workspace-dependencies',
]);

// 模型可见工具插件**但包名不以 dsh-tool- 开头**的那些（各自有越权理由，见文件头）。
// 这几类逐个查过源码：它们都真的调 ctx.tools.register。
const EXTRA_MODEL_PACKAGES=new Set([
  // 交互式终端与 PTY：给会话一个终端，与 shell 同样能读任意文件。
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  // 终端面板：user_terminal_read 能读别的会话的终端输出。
  '@deepseek-ai/dsh-terminal-panel',
  // 文档后端与文档技能：读走同一个文件系统后端（office-kit 的注释写明
  // "private disk input/output"）。
  '@deepseek-ai/dsh-office-kit',
  '@deepseek-ai/dsh-skill-office',
  // 宿主配置面：能读宿主运行时配置（cordis_inspect_*）、能装任意插件
  // （装插件 = 任意代码执行 = 任意读盘）。
  '@deepseek-ai/dsh-plugin-manager/tools',
  '@deepseek-ai/dsh-plugin-market/tools',
  '@deepseek-ai/dsh-tool-cordis/host',
  // MCP 资源读取：list/read MCP 资源，是一条任意外部读出面。
  '@deepseek-ai/dsh-mcp-resources',
  // 子代理运行时（structured.ts 里注册工具）。
  '@deepseek-ai/dsh-subagent',
  // 计划模式与动作卡片：都是模型可见工具。
  '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-action-cards',
  // 电脑操作（cua）：截图与点击，能读屏幕上的任何东西。
  '@deepseek-ai/dsh-cua',
]);

// **允许**留在任何作用域里的模型可见工具插件（白名单）。
//   jobs    —— 后台任务表；没有 shell 就没有任务，剩下的是空表。
//   skill   —— 静态技能正文（不是用户数据），上游的主会话只放行 skill。
//   todo    —— 会话内的待办清单。
// 刻意**不**保留的：文件、shell、终端、文档、工作流与子代理、宿主配置检查、
// 宿主配置改写、团队会话消息、web（回环可达）。
const ALLOWED_TOOL_PACKAGES=new Set([
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-todo',
]);

// Pinned worker/router layers need these support plugins. Unknown preset plugins
// are excluded even if their package names do not look like model tools.
const PRESET_SUPPORT_PACKAGES=new Set([
  'cordis:group',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
]);
const DISABLED_GLOBAL_PACKAGES=new Set(globalDenials().map(row=>row.name));

// 部署形态下**允许**存在的 preset：只有上游 bundle 自己声明的两套
// （执行器 worker 与主会话 router）。web 模板的四套（standard / ptc / minimal / cordis）
// 是给人在 Web UI 里手动选的，Tier 2 无人值守——standard 还是子代理与工作流的默认落点。
const ALLOWED_PRESETS=new Set(['dsh-superagent-worker','dsh-superagent-router']);

// preset 注册表的默认 preset 要指到允许集合里（web 模板默认是 standard）。
const DEFAULT_PRESET='dsh-superagent-worker';

/**
 * 一行插件是不是模型可见的工具插件。
 * @param {{name?: string}} row - 一行插件。
 * @returns whether the row is a model-facing tool plugin.
 */
function isModelTool(row) {
  const name=row?.name;
  if (typeof name!=='string'||name==='') return false;
  if (INFRA_PACKAGES.has(name)) return false;
  return name.startsWith(MODEL_TOOL_PREFIX)||EXTRA_MODEL_PACKAGES.has(name)||DISABLED_GLOBAL_PACKAGES.has(name);
}

/**
 * 一行插件是不是允许留在作用域里的模型可见工具。
 * @param {{name?: string}} row - 一行插件。
 * @returns whether the row is on the allowlist.
 */
function allowedTool(row) {
  return typeof row?.name==='string'&&ALLOWED_TOOL_PACKAGES.has(row.name);
}

/**
 * 一行插件在白名单口径下该留还是该去：非模型工具留下，模型工具只在白名单里才留。
 * @param {{name?: string}} row - 一行插件。
 * @returns whether the row survives the allowlist.
 */
function keep(row) {
  return PRESET_SUPPORT_PACKAGES.has(row?.name)||allowedTool(row);
}

/**
 * 去掉插件表里白名单外的模型工具行；组（cordis:group）递归处理，空组一并去掉。
 *
 * 这里**不能**用「顶层长度不变就跳过」的写法（复核意见 P1-1 的第二个漏检）：
 * 组内删项不改变顶层行数——一个 group 行被替换成更短的 config 数组，
 * 顶层长度一样，但组里的文件工具已经没了（或者反过来：组里多了一行，
 * 顶层长度也一样）。用长度当「有没有变化」的判据，
 * 一是组内删项会被跳过（该收紧的没收紧），
 * 二是组内**多**了项也会被跳过（该拦的没拦）。
 * 所以判据是**深度比对**：逐行递归比较结构，任何差异都算变化。
 *
 * @param {any[]} plugins - 一份 preset 的插件表。
 * @returns the plugin table with only allowlisted model tools.
 */
function filterPlugins(plugins) {
  if (!Array.isArray(plugins)) return plugins;
  const kept=[];
  for (const row of plugins) {
    if (!keep(row)) continue;
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
 * 两份插件表是否在结构上完全一致（深度比对，不看长度）。
 * @param {any[]} left - 一份插件表。
 * @param {any[]} right - 另一份插件表。
 * @returns whether the two tables are structurally identical.
 */
function samePlugins(left,right) {
  if (left===right) return true;
  if (!Array.isArray(left)||!Array.isArray(right)) return false;
  if (left.length!==right.length) return false;
  for (let index=0;index<left.length;index+=1) {
    const a=left[index];
    const b=right[index];
    if (!a||!b) return false;
    if ((a.id??null)!==(b.id??null)) return false;
    if ((a.name??null)!==(b.name??null)) return false;
    if ((a.disabled??null)!==(b.disabled??null)) return false;
    if (Array.isArray(a.config)||Array.isArray(b.config)) {
      if (!samePlugins(a.config,b.config)) return false;
    }
  }
  return true;
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
 * 收集**顶层**（根作用域）存在的行 id。
 *
 * 为什么需要它：顶层禁用行按 id 定位目标，而 DSH 的 patch 算法对
 * 「找不到的行」会打一条 `patch: entry "x" not found` 警告并跳过。
 * 那些只存在于 preset 插件表里的行（tool-office、pty、tool-cordis 等）
 * 在顶层根本不存在——它们由 preset 的覆盖行处理，不需要顶层禁用行。
 * 不做这个过滤，每次启动的日志里都会多出几条无意义的警告，
 * 真正的警告反而被淹没。
 *
 * @param {object} deps - 依赖（require 与 yaml 载入器）。
 * @param {string} cliDir - DSH CLI 的安装目录。
 * @returns the set of root-level entry ids.
 */
export function rootEntryIds(deps,cliDir) {
  const ids=new Set();
  const files=[
    join(cliDir,'node_modules','@deepseek-ai','dsh-base','cordis.patch.yml'),
    join(cliDir,'node_modules','@deepseek-ai','dsh-web-app','cordis.patch.yml'),
  ];
  const presetsDir=join(cliDir,'node_modules','@deepseek-ai','dsh-web-app','presets');
  if (existsSync(presetsDir)) {
    for (const name of readdirSync(presetsDir).sort()) {
      if (name.endsWith('.patch.yml')) files.push(join(presetsDir,name));
    }
  }
  // 基础层文件读不到（依赖树不完整、夹具只造了一部分）时**不返回空集**：
  // 空集会让调用方以为「顶层没有这些行」，从而把所有顶层禁用行都过滤掉——
  // 顶层禁用行恰恰是兜底（顶层在**任何**作用域下都可见）。
  // 所以这里返回 null 表示「不知道」，调用方据此不做过滤。
  if (!files.some(file=>existsSync(file))) return null;
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const row of readPatch(deps,file)) {
      if (typeof row?.id==='string') ids.add(row.id);
    }
  }
  return ids;
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
    // 判据是**深度比对**而不是长度：组内删项/多项都不改变顶层长度（复核意见 P1-1）。
    const presetId=row.config.id;
    if (!ALLOWED_PRESETS.has(presetId)) {
      // 不允许存在的 preset：**整行关掉**，而不是只清它的插件表。
      // 留着行（哪怕插件表空了）就等于留着「这个 preset 可被选中」的入口，
      // 而 standard 正是子代理与工作流引擎的默认落点。
      rows.push({id:row.id,name:row.name,disabled:true});
      continue;
    }
    if (samePlugins(plugins,row.config.plugins)) continue; // 这一行本来就没有白名单外的能力。
    rows.push({id:row.id,name:row.name,config:{...row.config,plugins}});
  }
  return rows;
}

/**
 * preset 注册表的默认 preset：web 模板默认是 standard（不允许存在的那套）。
 * 指到允许集合里，否则「新建会话没指定 preset」会落在一个被关掉的 preset 上。
 *
 * 这行是**常量**而不是推导结果，所以它不参与「推导结果是否为空」的判据
 * （否则推导结果永远非空，判据失效）。
 * @returns the preset registry override row.
 */
export function presetRegistryRow() {
  return {id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',
    config:{default:DEFAULT_PRESET}};
}

/**
 * 顶层（全局）的收紧行：它们在**任何**作用域下都是可见的，
 * 只收 preset 里的副本不够——preset 之外的入口（比如子代理继承的全局工具）仍然能读到盘。
 *
 * 这里关的是**白名单外**的模型工具与宿主配置面：
 * 文件、shell、文件搜索、文档、工作流引擎与子代理、宿主配置检查、宿主配置改写、
 * 团队会话消息、以及 web（DSH 的 web_fetch 对本机回环没有私网拦截）。
 *
 * 注意：这些行**不能**被当成「推导结果非空」的证据（复核意见 P1-1 的第三个漏检）：
 * 上一版把固定的四条禁用行拼在推导结果前面，于是
 * `if [ -z "$LOCKDOWN_ROWS" ]` 永远不成立——收紧推导失败时照样启动。
 * 现在推导结果与全局禁用行**分开**输出：全局行是固定的，
 * 推导结果为空时脚本自己非零退出，启动脚本不再依赖字符串判空。
 *
 * @returns the global tool rows to disable.
 */
export function globalDenials() {
  return [
    {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs',disabled:true},
    {id:'tool-fs-search',name:'@deepseek-ai/dsh-tool-fs-search',disabled:true},
    {id:'tool-bash',name:'@deepseek-ai/dsh-tool-bash',disabled:true},
    {id:'tool-pwsh',name:'@deepseek-ai/dsh-tool-pwsh',disabled:true},
    // 终端与 PTY：交互式终端与 shell 同样能读任意文件。
    {id:'pty',name:'@deepseek-ai/dsh-terminal',disabled:true},
    {id:'terminal-bash',name:'@deepseek-ai/dsh-terminal-bash',disabled:true},
    {id:'terminal-panel',name:'@deepseek-ai/dsh-terminal-panel',disabled:true},
    {id:'tool-terminal',name:'@deepseek-ai/dsh-tool-terminal',disabled:true},
    // 文档与工作流：文档读走同一个文件系统后端；工作流能起子会话。
    {id:'tool-office',name:'@deepseek-ai/dsh-tool-office',disabled:true},
    {id:'tool-workflow',name:'@deepseek-ai/dsh-tool-workflow',disabled:true},
    {id:'workflow-ptc',name:'@deepseek-ai/dsh-workflow-ptc',disabled:true},
    // 子代理：子会话按 standard 拿工具，那套 preset 带全套读取工具。
    {id:'tool-subagent',name:'@deepseek-ai/dsh-tool-subagent',disabled:true},
    {id:'tool-subagent-control',name:'@deepseek-ai/dsh-tool-subagent-control',disabled:true},
    {id:'tool-subagent-fork',name:'@deepseek-ai/dsh-tool-subagent',disabled:true},
    // 宿主配置检查与改写：能读宿主运行时配置面、能装任意插件（= 任意代码执行）。
    {id:'tool-cordis',name:'@deepseek-ai/dsh-tool-cordis',disabled:true},
    {id:'cordis-inspect-providers',name:'@deepseek-ai/dsh-tool-cordis/host',disabled:true},
    {id:'tool-plugin-manager',name:'@deepseek-ai/dsh-plugin-manager/tools',disabled:true},
    {id:'tool-plugin-market',name:'@deepseek-ai/dsh-plugin-market/tools',disabled:true},
    {id:'plugin-manager',name:'@deepseek-ai/dsh-plugin-manager',disabled:true},
    {id:'config-editor',name:'@deepseek-ai/dsh-config-editor',disabled:true},
    // MCP 资源读取：一条任意外部读出面。
    {id:'mcp-resources',name:'@deepseek-ai/dsh-mcp-resources',disabled:true},
    // 子代理运行时与电脑操作。
    {id:'subagent',name:'@deepseek-ai/dsh-subagent',disabled:true},
    {id:'subagent-spawn-in-process',name:'@deepseek-ai/dsh-subagent-spawn-in-process',disabled:true},
    {id:'subagent-fork-in-process',name:'@deepseek-ai/dsh-subagent-fork-in-process',disabled:true},
    {id:'cua',name:'@deepseek-ai/dsh-cua',disabled:true},
    // 计划模式与动作卡片。
    {id:'plan-mode',name:'@deepseek-ai/dsh-plan-mode',disabled:true},
    {id:'action-cards',name:'@deepseek-ai/dsh-action-cards',disabled:true},
    // 团队会话消息面：能触达别的会话（别的用户的数据面）。
    {id:'tool-agent-team',name:'@deepseek-ai/dsh-tool-agent-team',disabled:true},
    // 文件 stat、路径与会话日志的读出面。
    {id:'tool-present',name:'@deepseek-ai/dsh-tool-present',disabled:true},
    {id:'tool-working-directory',name:'@deepseek-ai/dsh-tool-working-directory',disabled:true},
    {id:'tool-session-query',name:'@deepseek-ai/dsh-tool-session-query',disabled:true},
    // 文档后端与文档技能：读走同一个文件系统后端。
    {id:'office-kit',name:'@deepseek-ai/dsh-office-kit',disabled:true},
    {id:'skill-office',name:'@deepseek-ai/dsh-skill-office',disabled:true},
    // web：DSH 的 web_fetch 对本机回环没有私网地址拦截，
    // 留着它就是一条到 127.0.0.1:3082（桥接管理面）的路。
    {id:'tool-web',name:'@deepseek-ai/dsh-tool-web',disabled:true},
  ];
}

/**
 * 逐作用域检查**最终生效配置**。
 *
 * 为什么必须查最终生效配置而不是查推导结果（复核意见 P1-1）：
 * 推导只是「打算怎么改」，真正生效的是 compose 之后的那份配置——
 * 上游的 bundle 层、DSH web 模板层、profile 层叠在一起，
 * 任何一层的行都能在某个作用域里露出模型可见工具。
 * 只查推导结果 = 只查了自己写的那份补丁，没查别人的。
 *
 * 作用域有两层：
 *   - 顶层（全局）：任何作用域下都可见的行。
 *   - preset：worker / router / standard / ptc / minimal / cordis 各自的插件表。
 * 组（cordis:group）递归查——组里的行同样进作用域。
 *
 * @param {object} deps - 依赖（yaml 载入器与 schema）。
 * @param {string} text - dsh --dump-config 的输出（已 compose 的配置）。
 * @returns the problems found; empty means the effective config is locked down.
 */
export function verifyEffectiveConfig(deps,text) {
  const rows=deps.yaml.load(text,{schema:deps.entryListSchema});
  if (!Array.isArray(rows)) return ['最终生效配置不是一个顶层数组'];
  const problems=[];
  const presets=new Set();
  let registries=0;
  const check=(list,scope,inPreset=false)=>{
    if (!Array.isArray(list)) return;
    for (const row of list) {
      if (!row||typeof row!=='object') continue;
      const id=row.id??'(无 id)';
      const name=row.name??'(无 name)';
      // 整行被关掉时不构成暴露面（`disabled: true`）。
      // !!js 表达式不静态求值：它可能是 `process.platform === 'win32'`
      // （在 Linux 上为 false = 启用）。所以对表达式行**保守判定**：视为启用。
      if (row.disabled===true) continue;
      if (inPreset?!keep(row):isModelTool(row)&&!allowedTool(row)) {
        problems.push(`${scope} 的 ${id}（${name}）不在白名单内`);
      }
      if (name==='@deepseek-ai/dsh-agent-preset-registry') {
        registries+=1;
        if (row.config?.default!==DEFAULT_PRESET) problems.push('默认 preset 必须是 Along Worker');
      }
      if (name==='@deepseek-ai/dsh-agent-preset') {
        const config=row.config;
        const presetId=config?.id;
        if (!ALLOWED_PRESETS.has(presetId)||!Array.isArray(config?.plugins)||presets.has(presetId)) {
          problems.push(`${scope} 存在未知、无效或重复的 preset：${presetId??id}`);
        } else {
          presets.add(presetId);
          check(config.plugins,`preset ${presetId}`,true);
        }
      }
      if (Array.isArray(row.config)) check(row.config,`${scope} 的 ${id}`,inPreset);
    }
  };
  check(rows,'顶层');
  if (registries!==1) problems.push('最终配置需要唯一启用的 preset 注册表');
  for (const presetId of ALLOWED_PRESETS) {
    if (!presets.has(presetId)) problems.push(`缺少启用的 preset：${presetId}`);
  }
  return problems;
}

if (process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cliDir=process.argv[2];
  const bundleDir=process.argv[3];
  const mode=process.argv[4]??'derive';
  if (!cliDir||!bundleDir) throw Error('需要参数：DSH CLI 目录与 bundle 目录');
  // 从 **DSH CLI 自己的** node_modules 解析：cordis-plugin-include 与 js-yaml 都在那里
  // （deploy/agent-dsh 的锁文件固定了它们），本脚本所在目录没有依赖树。
  const require=createRequire(join(cliDir,'node_modules','@deepseek-ai','dsh','package.json'));
  const {entryListSchema}=require('@deepseek-ai/cordis-plugin-include');
  const yaml=require('js-yaml');
  const deps={entryListSchema,yaml};
  if (mode==='verify') {
    // 校验**最终生效配置**：stdin 上是 dsh --dump-config 的输出（已 compose 的那一份）。
    // 逐作用域查：顶层与每个 preset 里，凡有白名单外的模型可见工具就非零退出。
    const text=readFileSync(0,'utf8');
    const problems=verifyEffectiveConfig(deps,text);
    if (problems.length>0) {
      for (const problem of problems) process.stderr.write(`读取面收紧校验失败：${problem}\n`);
      process.exit(1);
    }
    process.stderr.write('读取面收紧校验通过：Worker、Router 与全局工具配置符合 Tier 2 约束\n');
    process.exit(0);
  }
  const overrides=lockdownRows(deps,cliDir,bundleDir);
  // 推导为空 = 没有任何 preset 需要收紧 = 上游的声明形状变了（preset 搬了家、
  // 换了 id、或不再声明 preset）。此时**必须**失败：静默继续等于没收紧。
  // 上一版这里拼了固定的四条全局禁用行，于是判空永远不成立（复核意见 P1-1）。
  if (overrides.length===0) {
    process.stderr.write('读取面收紧推导结果为空（上游的 preset 声明形状已变），拒绝启动\n');
    process.exit(1);
  }
  // 顶层禁用行只保留**顶层真的存在**的那些 id：
  // 找不到的行会被 DSH 的 patch 算法打一条 "entry not found" 警告并跳过，
  // 日志里堆着无意义的警告，真正的警告就被淹没了。
  const rootIds=rootEntryIds(deps,cliDir);
  // rootIds 为 null = 读不到基础层（依赖树不完整）→ 不过滤，全部顶层禁用行都写出去。
  const globals=rootIds===null?globalDenials():globalDenials().filter(row=>rootIds.has(row.id));
  const rows=[...globals,...overrides,presetRegistryRow()];
  // 用**同一个** schema 序列化：DSH 的 !!js 表达式节点必须原样保留
  // （普通 YAML 解析会把它降级成普通字符串，disabled 的语义就变了）。
  const text=yaml.dump(rows,{schema:entryListSchema,lineWidth:-1,noRefs:true});
  process.stdout.write(text);
}
