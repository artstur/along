const CACHE='along-shell-v11';
const FILES=['./','./index.html','./style.css','./app.mjs','./health.mjs','./workspace.mjs','./loop.mjs','./goal-agent-core.mjs','./adaptive-ui.mjs','./super-agent.mjs','./agent-client.mjs','./agent-replay.json','./app-icon.png','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('along-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!FILES.some(f=>new URL(f,self.registration.scope).pathname===url.pathname))return;
  event.respondWith(fetch(event.request).then(response=>{
    // Do not cache login redirects or responses from another origin.
    if(response.ok&&!response.redirected&&response.url===event.request.url){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(async()=>await caches.match(event.request)||new Response('请联网后重新打开 Along。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}})));
});
