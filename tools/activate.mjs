import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir, networkInterfaces} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {createInterface} from 'node:readline/promises';
import {Document, isMap, isSeq, parseDocument} from 'yaml';
import {lockSync} from 'proper-lockfile';
import {parseEnv} from 'node:util';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PROFILE='along-phone';
const MODEL_IDS=new Set(['llm-pi-ai','agent-default-model']);

function yamlDocument(file) {
  const doc=parseDocument(readFileSync(file,'utf8'),{prettyErrors:false});
  if (doc.errors.length) throw Error(`YAML 格式有误，请检查 ${file}（未输出文件内容）。`);
  return doc;
}

export function writePrivate(file,content) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary,content,{mode:0o600,flag:'wx'});
    renameSync(temporary,file);
  } finally {rmSync(temporary,{force:true});}
}

/** Copy YAML nodes without evaluating !!js or importing any unrelated desktop plugins. */
export function desktopModelEntries(file) {
  if (!existsSync(file)) return [];
  const doc=yamlDocument(file);
  if (!isSeq(doc.contents)) throw Error(`模型配置不是 YAML 列表：${file}`);
  return doc.contents.items.filter(node=>isMap(node)&&MODEL_IDS.has(node.get('id'))).map(node=>node.clone());
}

export function patchDocument(paths,modelEntries=[]) {
  const doc=new Document([
    {id:'webserver',config:{host:'127.0.0.1',port:3082}},
    {id:'dsh-superagent',config:{stateDir:paths.state,alongStateDir:paths.data,alongBridgeTokenFile:paths.bridge}},
    {id:'dsh-superagent-github',disabled:true},
    {id:'dsh-superagent-along',disabled:false},
  ]);
  for (const node of modelEntries) doc.contents.items.push(node);
  return doc;
}

function entry(doc,id) {return doc.contents?.items?.find(node=>isMap(node)&&node.get('id')===id);}
function upsert(doc,value) {
  const previous=entry(doc,value.id);
  const node=doc.createNode(value);
  if (previous) doc.contents.items[doc.contents.items.indexOf(previous)]=node;
  else doc.contents.items.push(node);
}

export function selectedModel(doc) {
  const model=entry(doc,'agent-default-model')?.get('config')?.toJSON();
  if (!model?.provider||!model?.model) return null;
  const provider=entry(doc,'llm-pi-ai')?.getIn(['config','providers',model.provider]);
  return {...model,providerConfig:provider?.toJSON()};
}

/** Match credentials-local's managed refs before environment and dotenv fallbacks. */
export function hasCredential(ref,files,env=process.env,provider) {
  if (typeof ref!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return false;
  for (const file of files) {
    if (!existsSync(file)) continue;
    if ((statSync(file).mode&0o077)!==0) throw Error(`凭证文件权限必须为 0600：${file}`);
    const doc=yamlDocument(file);
    if (doc.get('version')!==1) throw Error(`不支持的 DSH 凭证格式：${file}`);
    const value=doc.getIn(['refs',ref]);
    if (typeof value==='string'&&value.trim()) return true;
    const record=doc.getIn(['records',`llm-pi-ai/${provider}`]);
    if (record?.get('kind')==='api-key'&&record.get('key')?.trim()) return true;
    if (record?.get('kind')==='grant'&&record.has('payload')) return true;
  }
  return typeof env[ref]==='string'&&env[ref].trim().length>0;
}

export async function promptLine(label,{secret=false,input=process.stdin,output=process.stdout}={}) {
  if (!input.isTTY||!output.isTTY) throw Error('缺少模型配置或 API Key，请在本机终端运行 npm run activate 完成首次设置。');
  if (!secret) {
    const rl=createInterface({input,output});
    const controller=new AbortController();
    rl.once('SIGINT',()=>controller.abort());
    try {return (await rl.question(label,{signal:controller.signal})).trim();}
    catch {throw Error('已取消模型配置。');}
    finally {rl.close();}
  }
  output.write(label);
  const wasRaw=input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveInput,reject)=>{
    let value='';
    const finish=(error)=>{
      input.off('data',onData); input.off('end',onEnd);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      error?reject(error):resolveInput(value.trim());
    };
    const onEnd=()=>finish(Error('API Key 输入已中断。'));
    const onData=chunk=>{
      for (const char of chunk.toString()) {
        if (char==='\u0003'||char==='\u0004') return finish(Error('已取消 API Key 输入。'));
        if (char==='\r'||char==='\n') return finish();
        if (char==='\u007f'||char==='\b') value=Array.from(value).slice(0,-1).join('');
        else if (char>=' ') value+=char;
      }
    };
    input.on('data',onData); input.once('end',onEnd);
  });
}

/** New keys stay in a DSH credentials file, never a command argument or child environment. */
export async function configureModel(doc,{home,credentials,ask=promptLine,env=process.env}) {
  let model=selectedModel(doc);
  if (!model) {
    const baseURL=await ask('模型接口 Base URL（例如 https://api.minimax.cn/v1）：');
    let url;
    try {url=new URL(baseURL);} catch {throw Error('模型接口地址无效。');}
    if (!['https:','http:'].includes(url.protocol)||url.username||url.password) throw Error('请输入不带用户名或密码的 HTTP(S) 接口地址。');
    const modelId=await ask('模型 ID：');
    if (!modelId) throw Error('模型 ID 不能为空。');
    const kind=await ask('接口类型：1 OpenAI 兼容；2 Anthropic 兼容 [1]：');
    if (kind&&!['1','2'].includes(kind)) throw Error('接口类型应为 1 或 2。');
    const api=kind==='2'?'anthropic-messages':'openai-completions';
    upsert(doc,{id:'llm-pi-ai',config:{providers:{'along-local':{
      displayName:'Along',apiKeyEnv:'ALONG_MODEL_API_KEY',baseURL,api,
      models:[{id:modelId,name:modelId,api,baseURL,contextWindow:32768,maxTokens:4096,input:['text']}],
    }}}});
    upsert(doc,{id:'agent-default-model',config:{provider:'along-local',model:modelId}});
    model=selectedModel(doc);
  }
  const ref=model.providerConfig?.apiKeyEnv||`${model.provider.toUpperCase().replace(/[^A-Z0-9_]/g,'_')}_API_KEY`;
  if (!model.providerConfig?.apiKeyEnv) {
    if (!entry(doc,'llm-pi-ai')) upsert(doc,{id:'llm-pi-ai',config:{providers:{}}});
    entry(doc,'llm-pi-ai').setIn(['config','providers',model.provider,'apiKeyEnv'],ref);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw Error('模型 API Key 引用必须是合法的环境变量名。');
  const current=entry(doc,'credentials-local')?.getIn(['config','path']);
  const store=current||join(home,'.credentials.yaml');
  if (hasCredential(ref,[store],env,model.provider)) return model;
  const key=await ask(`请输入 ${model.provider} / ${model.model} 的 API Key（隐藏输入）：`,{secret:true});
  if (!key||/[\r\n\0]/.test(key)) throw Error('API Key 不能为空或包含换行。');
  // An Along-owned store avoids rewriting a credentials file another DSH process may be updating.
  const saved=existsSync(credentials)?yamlDocument(credentials):new Document({version:1,refs:{}});
  saved.setIn(['refs',ref],key);
  writePrivate(credentials,saved.toString());
  upsert(doc,{id:'credentials-local',config:{path:credentials}});
  return model;
}

export function acquireLock(file) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  try {return lockSync(dirname(file),{lockfilePath:`${file}.lock`,stale:10_000});}
  catch (error) {
    if (error.code==='ELOCKED') throw Error('Along 启动器已在运行，请使用原来的终端；异常退出后等十秒再试。');
    throw error;
  }
}

export async function freePort(port,host='127.0.0.1') {
  await new Promise((resolvePort,reject)=>{
    const server=createServer();
    server.once('error',()=>reject(Error(`端口 ${port} 已被占用，请先关闭占用服务后重试。`)));
    server.listen(port,host,()=>server.close(resolvePort));
  });
}

/** Track only children of this invocation; every exit is observed, including spawn failures. */
export class Processes {
  children=new Set();
  stopping=false;
  start(command,args,options={}) {
    if (this.stopping) throw Error('启动已取消。');
    const child=spawn(command,args,{stdio:'ignore',...options});
    this.children.add(child);
    child.done=new Promise(resolveDone=>{
      child.once('error',()=>{child.finished=true;this.children.delete(child);resolveDone(1);});
      child.once('exit',code=>{child.finished=true;this.children.delete(child);resolveDone(code??1);});
    });
    return child;
  }
  async run(command,args,options={}) {
    if (this.stopping) throw Error('启动已取消。');
    const code=await this.start(command,args,options).done;
    if (code!==0||this.stopping) throw Error(`${command} 执行未完成，请检查本次启动日志。`);
  }
  async stop() {
    this.stopping=true;
    const children=[...this.children];
    for (const child of children) child.kill('SIGINT');
    await Promise.all(children.map(child=>child.done));
  }
}

async function waitFor(check,child,label,signal) {
  const deadline=Date.now()+90_000;
  while (!signal.aborted&&Date.now()<deadline) {
    if (child.finished) throw Error(`${label} 已退出，请检查启动日志。`);
    try {if (await check()) return;} catch { /* The local server may still be mounting. */ }
    await new Promise(resolveWait=>setTimeout(resolveWait,500));
  }
  throw Error(`${label} 启动未完成，请检查启动日志。`);
}

export async function activate({root=ROOT,home=resolve(process.env.DSH_HOME||join(homedir(),'.dsh')),base=join(homedir(),'.along','phone-test')}={}) {
  const agent=resolve(root,'../along-superagent');
  if (!existsSync(join(agent,'src/app/store.ts'))) throw Error(`找不到相邻的 Along Agent 仓库（along-superagent）：${agent}`);
  const paths={state:join(base,'dsh'),data:join(base,'data'),bridge:join(base,'data','bridge-token')};
  const profile=join(home,'profiles',PROFILE),patch=join(profile,'cordis.patch.yml');
  const marker=join(base,'activation.json');
  const release=acquireLock(join(base,'activate.pid'));
  const processes=new Processes(),controller=new AbortController();
  const stop=()=>{controller.abort();void processes.stop();};
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
  let log;
  try {
    const lanHost=process.env.ALONG_AGENT_HOST||networkInterfaces().en0?.find(item=>item.family==='IPv4'&&!item.internal)?.address||'127.0.0.1';
    await freePort(3082); await freePort(4176,lanHost);
    const managed=existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):null;
    if (existsSync(profile)&&managed?.profile!==profile) throw Error(`已有非启动器管理的 ${PROFILE} profile，拒绝覆盖：${profile}`);
    const initializing=!existsSync(profile)||managed?.initialized===false;
    log=openSync(join(base,'activation.log'),'a',0o600); chmodSync(join(base,'activation.log'),0o600);
    const env={...process.env,DSH_HOME:home};
    const options={cwd:agent,env,stdio:['ignore',log,log]};
    console.log('准备 Along DSH 与手机资源…（日志：'+join(base,'activation.log')+'）');
    if (!existsSync(join(agent,'node_modules/.modules.yaml'))) await processes.run('pnpm',['install','--frozen-lockfile'],options);
    await processes.run('pnpm',['build'],options);
    await processes.run(process.execPath,[join(root,'tools/build.mjs')],{...options,cwd:root});
    if (!existsSync(profile)) {
      writePrivate(marker,JSON.stringify({profile,initialized:false},null,2));
      await processes.run('dsh',[PROFILE,'--from-default-profile','web','--dump-config'],options);
    }
    if (!existsSync(patch)||initializing) {
      if (existsSync(patch)) {
        const partial=yamlDocument(patch);
        if (!isSeq(partial.contents)||partial.contents.items.length) throw Error('首次初始化中断且 profile 已有配置，请检查后再启动，避免覆盖。');
      }
      writePrivate(patch,patchDocument(paths,desktopModelEntries(join(home,'profiles','desktop','cordis.patch.yml'))).toString());
      writePrivate(marker,JSON.stringify({profile,initialized:true},null,2));
    }
    if (!existsSync(join(profile,'node_modules/dsh-superagent'))) {
      await processes.run('dsh',['plugin','--profile',PROFILE,'add',`link:${agent}`],options);
    }
    const doc=yamlDocument(patch);
    if (!isSeq(doc.contents)) throw Error(`Along profile 配置格式有误：${patch}`);
    const machine=entry(doc,'dsh-superagent')?.get('config')?.toJSON();
    if (machine?.stateDir!==paths.state||machine?.alongStateDir!==paths.data||machine?.alongBridgeTokenFile!==paths.bridge) throw Error('Along profile 数据目录已修改，请使用原 profile 启动，避免读错数据库。');
    const credentialEnv={};
    for (const file of [join(home,'.env'),join(agent,'.env')]) {
      if (existsSync(file)) Object.assign(credentialEnv,parseEnv(readFileSync(file,'utf8')));
    }
    const model=await configureModel(doc,{home,credentials:join(base,'model-credentials.yaml'),env:{...credentialEnv,...process.env}});
    writePrivate(patch,doc.toString());
    const db=join(paths.state,'orchestrator.sqlite');
    // Only a new database is seeded. Existing pause, policy and allowed lists remain authoritative.
    if (!existsSync(db)) {
      const code=`import {Store} from ${JSON.stringify(pathToFileURL(join(agent,'src/app/store.ts')).href)};
const store=new Store(process.argv[1]);
try {const s=store.settings();store.saveSettings({...s,sources:{...s.sources,along:{enabled:true,config:{}},github:{enabled:false,config:{}}},eval:{...s.eval,mode:'auto'}});}finally{store.close();}`;
      await processes.run(process.execPath,['--experimental-transform-types','--input-type=module','-e',code,db],options);
    }
    console.log(`启动 DSH：${model.provider} / ${model.model}`);
    const dsh=processes.start('dsh',['--profile',PROFILE,'--no-open'],options);
    const stateURL='http://127.0.0.1:3082/orchestrator/api/state';
    await waitFor(async()=>{
      const response=await fetch(stateURL,{headers:{'x-orchestrator-request':'1'},signal:AbortSignal.timeout(1500)});
      if (!response.ok) return false;
      const value=await response.json();
      return value.health?.runtime?.state==='ready'&&!value.setup?.problem;
    },dsh,'DSH',controller.signal);
    const token=readFileSync(paths.bridge,'utf8').trim();
    await waitFor(async()=>{
      const response=await fetch('http://127.0.0.1:3082/along-source/api/goals',{
        headers:{'x-along-bridge':'1','x-along-bridge-token':token},signal:AbortSignal.timeout(1500),
      });
      // Correct bridge auth reaches the identity guard, without inventing or registering a user.
      return response.status===403&&(await response.json()).error==='invalid_identity';
    },dsh,'Along Bridge',controller.signal);
    console.log('DSH 已就绪：http://127.0.0.1:3082\n启动手机连接服务，退出请按 Ctrl+C。');
    const host=processes.start(process.execPath,[join(root,'host/agent-host.mjs')],{
      cwd:root,env:{...env,ALONG_EVENT_INGEST:'on',ALONG_AGENT_STATE_DIR:join(base,'host'),
        ALONG_BRIDGE_TOKEN_FILE:paths.bridge,ALONG_SUPERAGENT_URL:'http://127.0.0.1:3082',ALONG_AGENT_PORT:'4176',ALONG_AGENT_HOST:lanHost},
      stdio:['ignore','inherit','inherit'],
    });
    const exit=await Promise.race([dsh.done.then(code=>({name:'DSH',code})),host.done.then(code=>({name:'Along Host',code}))]);
    if (!controller.signal.aborted) throw Error(`${exit.name} 已退出（${exit.code}），本次服务将一起关闭。`);
  } finally {
    await processes.stop();
    if (log!==undefined) closeSync(log);
    process.off('SIGINT',stop); process.off('SIGTERM',stop); release();
  }
}

if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  activate().catch(error=>{console.error('Along 激活未完成：'+error.message);process.exitCode=1;});
}
