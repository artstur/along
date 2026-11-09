import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// web/sw.js 是浏览器里的经典脚本，这里用一个最小的 self/caches 替身把它跑起来，
// 直接验证「离线时带 ?v= 的资源还能不能命中缓存」。
function loadServiceWorker(entries) {
  const listeners={};
  const store=new Map(entries.map(entry=>[entry.url,{body:entry.body,status:200}]));
  const urlOf=request=>request.url;
  const sandbox={
    self:{
      addEventListener:(type,handler)=>{listeners[type]=handler;},
      location:{origin:'https://along.test'},
      registration:{scope:'https://along.test/'},
      clients:{claim:async()=>{}},
      skipWaiting:async()=>{},
    },
    caches:{
      async open(){ return {async addAll(){}, async put(request,response){ store.set(urlOf(request),response); }}; },
      async match(request,options={}) {
        const target=urlOf(request);
        for (const [url,value] of store) {
          const same=options.ignoreSearch?url.split('?')[0]===target.split('?')[0]:url===target;
          if (same) return value;
        }
        return null;
      },
    },
    Response:class { constructor(body,init={}){ this.body=body; this.status=init.status??200; } },
    fetch:async()=>{ throw Error('offline'); },
    URL,console,Promise,Map,Set,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../web/sw.js',import.meta.url),'utf8'),sandbox);
  return {listeners,store};
}

async function offlineFetch(listeners,url) {
  let responded=null;
  await listeners.fetch({request:{url,method:'GET'},respondWith(value){ responded=value; }});
  return responded;
}

test('the offline shell still serves files that carry a version query',async()=>{
  const {listeners}=loadServiceWorker([{url:'https://along.test/app.mjs',body:'cached-app'}]);
  const response=await offlineFetch(listeners,'https://along.test/app.mjs?v=35');
  assert.equal(response.body,'cached-app','带 ?v= 的资源离线时要命中缓存，而不是 503 白屏');
});

test('the exact versioned entry wins over the query-stripped one',async()=>{
  const {listeners}=loadServiceWorker([
    {url:'https://along.test/app.mjs',body:'stale-no-query'},
    {url:'https://along.test/app.mjs?v=36',body:'fresh-with-query'},
  ]);
  const response=await offlineFetch(listeners,'https://along.test/app.mjs?v=36');
  assert.equal(response.body,'fresh-with-query','精确命中优先，不能拿旧版本兜底');
});
