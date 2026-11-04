import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {routeHealthEvent} from './loop.mjs';
const root=resolve(process.argv.includes('--dist')?'dist':'.');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}).end(JSON.stringify(value));}
async function parseBody(req){let raw='';for await(const part of req){raw+=part;if(raw.length>8192)throw Error('请求过大');}return JSON.parse(raw);}
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health-event'){
      if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json'))return json(res,405,{error:'仅接受 JSON POST'});
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'来源不匹配'});
      const {before,event}=await parseBody(req);
      const route=routeHealthEvent(before,event);
      if(route.decision==='quiet')return json(res,200,{decision:'quiet',reason:route.reason,remaining:route.remainingAfter});
      if(typeof before.loop.currentTask!=='string'||before.loop.currentTask.length>100)throw Error('原任务格式不正确');
      const {proposeNextStep}=await import('./codex-agent.mjs');
      const suggestion=await proposeNextStep({oldTask:before.loop.currentTask,eventMinutes:event.amount,completed:route.after.snapshot.workoutMinutes,target:120,remaining:route.remainingAfter});
      return json(res,200,{decision:'replan',reason:route.reason,remaining:route.remainingAfter,suggestion,source:'live-codex'});
    }
    let path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    if((await stat(path)).isDirectory())path=resolve(path,'index.html');
    const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream','Cache-Control':'no-cache'}).end(body);
  }catch(error){if(req.url?.startsWith('/api/'))json(res,400,{error:error?.message??'请求失败'});else res.writeHead(404).end('Not found');}
}).listen(Number(process.env.PORT)||4173,process.env.HOST||'127.0.0.1',()=>console.log(`Along is ready: http://${process.env.HOST||'127.0.0.1'}:${Number(process.env.PORT)||4173}`));
