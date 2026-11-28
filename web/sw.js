// Web 壳的缓存版本：改动 web/ 下的静态资源后必须同步推进，否则已缓存的客户端会一直沿用旧副本。
const CACHE='along-shell-v105';
const FILES=['./','./index.html','./style.css','./app.mjs','./health.mjs','./workspace.mjs','./loop.mjs','./goal-agent-core.mjs','./adaptive-ui.mjs','./super-agent.mjs','./agent-client.mjs','./event-envelope.mjs','./event-workspace.mjs','./task-results.mjs','./task-result-view.mjs','./data-sources.mjs','./recommendations.mjs','./agent-notifications.mjs','./contextual-planning.mjs','./agent-replay.json','./app-icon.png','./manifest.webmanifest'];
// 静态托管（GitHub Pages 等）会给所有响应 max-age=600，缓存仍新鲜时浏览器直接用旧副本，
// 源站更新后客户端仍加载不到新代码。壳内资源一律绕过 HTTP 缓存回源，离线时再退回 CacheStorage。
const freshRequest=url=>fetch(url,{cache:'no-store'});
const isShellFile=url=>FILES.some(f=>new URL(f,self.registration.scope).pathname===url.pathname);
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(async cache=>{
  await Promise.all(FILES.map(async file=>{
    const response=await freshRequest(new URL(file,self.registration.scope).href);
    if(!response.ok||response.type!=='basic')throw new Error(`预缓存失败: ${file}`);
    await cache.put(file,response);
  }));
  await self.skipWaiting();
}));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('along-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!isShellFile(url))return;
  event.respondWith(freshRequest(event.request.url).then(response=>{
    // Do not cache login redirects or responses from another origin.
    if(response.ok&&!response.redirected&&response.url===event.request.url){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(async()=>await caches.match(event.request)||await caches.match(event.request,{ignoreSearch:true})||new Response('请联网后重新打开 Along。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
});
