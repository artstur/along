import {createServer} from 'node:http';
import {randomBytes, randomInt, createHash, timingSafeEqual} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';

const TYPES = ['steps', 'workout', 'weight', 'sleep'];
const FIELDS = {steps:['steps'], workout:['workoutMinutes','workoutCount'], weight:['weightKg'], sleep:['sleepMinutes']};
const LIMITS = {steps:300000, workoutMinutes:10080, workoutCount:500, weightKg:500, sleepMinutes:1440};
const MAX_BODY = 4096;

export function validateHealthSummary(value) {
  if (!value || value.schema !== 1 || value.source !== 'healthkit' || !Array.isArray(value.selectedTypes) || !value.selectedTypes.length) throw Error('同步格式不正确');
  const selected = new Set(value.selectedTypes);
  if (selected.size !== value.selectedTypes.length || [...selected].some(type => !TYPES.includes(type))) throw Error('数据类型不正确');
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) throw Error('缺少健康摘要');
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) throw Error('采集时间不正确');
  const allowed = new Set([...selected].flatMap(type => FIELDS[type]));
  if (Object.keys(value.snapshot).some(field => !allowed.has(field))) throw Error('包含未选择的数据');
  for (const type of selected) if (FIELDS[type].some(field => !(field in value.snapshot))) throw Error('选定的数据不完整');
  for (const [field, number] of Object.entries(value.snapshot)) {
    if (number === null) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > LIMITS[field]) throw Error('健康摘要数值不正确');
    if (field !== 'weightKg' && !Number.isInteger(number)) throw Error('健康摘要数值不正确');
  }
  return {schema:1, source:'healthkit', selectedTypes:TYPES.filter(type=>selected.has(type)), capturedAt:value.capturedAt, snapshot:Object.fromEntries(Object.entries(value.snapshot))};
}

async function readJSON(req) {
  let raw='';
  for await (const chunk of req) { raw+=chunk; if (raw.length>MAX_BODY) throw Error('请求过大'); }
  return JSON.parse(raw);
}
function reply(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(value)); }
async function atomicJSON(path,value) {
  const temp=`${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});
  await rename(temp,path);
}
async function readOptional(path) { try { return JSON.parse(await readFile(path,'utf8')); } catch(error) { if(error.code==='ENOENT')return null; throw error; } }
const hash = value => createHash('sha256').update(value).digest();

export function createHealthSyncServer({dataDir=join(homedir(),'.along'), pairCode=String(randomInt(10000000,99999999)), now=()=>Date.now()}={}) {
  const tokenPath=join(dataDir,'pairing.json'), summaryPath=join(dataDir,'health-summary.json');
  const expiresAt=now()+10*60*1000;
  let failures=0, consumed=false;
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if (req.method==='GET' && path==='/health') return reply(res,200,{service:'along-health-sync',schema:1});
      if (req.method==='POST' && path==='/api/pair') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res,415,{error:'仅接受 JSON'});
        const input=await readJSON(req);
        if (consumed || now()>expiresAt || failures>=5 || input?.code!==pairCode) { failures++; return reply(res,403,{error:'配对码无效或已过期'}); }
        const token=randomBytes(32).toString('hex');
        await mkdir(dataDir,{recursive:true,mode:0o700});
        await atomicJSON(tokenPath,{hash:hash(token).toString('hex')});
        consumed=true;
        return reply(res,200,{token});
      }
      if (path==='/api/health-sync') {
        const saved=await readOptional(tokenPath);
        const supplied=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!saved?.hash || !supplied || !timingSafeEqual(Buffer.from(saved.hash,'hex'),hash(supplied))) return reply(res,401,{error:'请先配对 Along 服务'});
        if (req.method==='GET') return reply(res,200,{summary:await readOptional(summaryPath)});
        if (req.method==='DELETE') { try { await unlink(summaryPath); } catch(error) { if(error.code!=='ENOENT')throw error; } return reply(res,200,{deleted:true}); }
        if (req.method==='POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) return reply(res,415,{error:'仅接受 JSON'});
          const summary=validateHealthSummary(await readJSON(req));
          const record={...summary,receivedAt:new Date(now()).toISOString()};
          await mkdir(dataDir,{recursive:true,mode:0o700});
          await atomicJSON(summaryPath,record);
          return reply(res,200,{saved:true,receivedAt:record.receivedAt,selectedTypes:record.selectedTypes});
        }
        return reply(res,405,{error:'请求方法不支持'});
      }
      return reply(res,404,{error:'未找到接口'});
    } catch(error) { return reply(res,400,{error:error?.message??'请求失败'}); }
  });
  return {server,pairCode,expiresAt};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const {server,pairCode,expiresAt}=createHealthSyncServer();
  const port=Number(process.env.SYNC_PORT)||4175;
  server.listen(port,'127.0.0.1',()=>{
    console.log(`Along health sync: http://127.0.0.1:${port}`);
    console.log(`一次性配对码：${pairCode}（${new Date(expiresAt).toLocaleTimeString('zh-CN')} 前有效）`);
  });
}
