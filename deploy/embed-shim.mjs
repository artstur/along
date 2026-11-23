// MiniMax embeddings → OpenAI 兼容形状的翻译垫片（deploy/embed-shim.mjs）。
//
// 为什么需要它：hy-memory 的 embedder 统一走 **OpenAI 兼容协议**（hy_memory/config.py：
// "Embedder 配置（统一走 OpenAI 兼容协议）"），即 POST {base}/embeddings 请求体
// {model, input:[...]}、响应 {data:[{index, embedding:[...]}]}。
// 而 MiniMax 的 embeddings 是自家形状：请求体要 `texts`（不是 `input`），响应是
// `{"vectors":[[...]], "base_resp":{...}}`（不是 `data`）。
// 实测（2026-11-23）：MiniMax 用 `input` 直接报 "missing required parameter texts"。
//
// 这个垫片只做形状翻译，不缓存、不改向量、不做鉴权之外的任何加工：
//   {model, input} → MiniMax {model:'embo-01', texts:[...], type:'db'} → {object:'list', data:[...]}
// LLM 一侧不需要垫片：MiniMax 的 /v1/chat/completions 本身就是 OpenAI 形状。
//
// 鉴权：要求带 `Authorization: Bearer <token>`，token 与 MiniMax key 分开存
// （ALONG_EMBED_SHIM_TOKEN_FILE），密钥本体只经 file secret 落盘。
//
// 用法：node deploy/embed-shim.mjs
//   环境变量：ALONG_EMBED_SHIM_PORT（默认 3090）、ALONG_MODEL_API_KEY_FILE、
//             ALONG_EMBED_SHIM_TOKEN_FILE
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';

const port=Number(process.env.ALONG_EMBED_SHIM_PORT??3090);
const keyPath=process.env.ALONG_MODEL_API_KEY_FILE;
const tokenPath=process.env.ALONG_EMBED_SHIM_TOKEN_FILE;
if (!keyPath||!tokenPath) throw Error('需要 ALONG_MODEL_API_KEY_FILE 与 ALONG_EMBED_SHIM_TOKEN_FILE');
const modelKey=readFileSync(keyPath,'utf8').trim();
const shimToken=readFileSync(tokenPath,'utf8').trim();

const EMBED_MODEL='embo-01';
const UPSTREAM='https://api.minimaxi.com/v1/embeddings';

async function embed(texts) {
  const response=await fetch(UPSTREAM,{method:'POST',
    headers:{authorization:`Bearer ${modelKey}`,'content-type':'application/json'},
    body:JSON.stringify({model:EMBED_MODEL,texts,type:'db'}),
    signal:AbortSignal.timeout(60_000)});
  const payload=await response.json().catch(()=>null);
  if (!response.ok||!payload?.vectors) {
    const detail=payload?.base_resp?.status_msg??`HTTP ${response.status}`;
    throw Error(`MiniMax embeddings 调用失败：${detail}`);
  }
  return payload.vectors;
}

createServer((req,res)=>{
  const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message}}));};
  if (req.method!=='POST'||!req.url?.startsWith('/v1/embeddings')) return fail(404,'只有 POST /v1/embeddings');
  const auth=req.headers.authorization??'';
  if (auth!==`Bearer ${shimToken}`) return fail(401,'无效的垫片令牌');
  let body='';
  req.on('data',chunk=>{body+=chunk; if (body.length>2_000_000) req.destroy();});
  req.on('end',async()=>{
    let input;
    try {
      const parsed=JSON.parse(body||'{}');
      input=Array.isArray(parsed.input)?parsed.input:[parsed.input].filter(value=>typeof value==='string');
      if (!input.length) return fail(400,'缺少 input');
    } catch { return fail(400,'请求体不是 JSON'); }
    try {
      const vectors=await embed(input);
      const data=vectors.map((embedding,index)=>({object:'embedding',index,embedding}));
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({object:'list',data,model:EMBED_MODEL,usage:{prompt_tokens:0,total_tokens:0}}));
    } catch (error) {
      fail(502,error instanceof Error?error.message:'上游失败');
    }
  });
}).listen(port,'127.0.0.1',()=>console.log(`embeddings 垫板就绪：127.0.0.1:${port}/v1/embeddings → MiniMax ${EMBED_MODEL}`));
