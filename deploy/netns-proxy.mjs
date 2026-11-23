// 命名空间锚点里的 TCP 跳板（deploy/netns-proxy.mjs）。
//
// 背景：Super Agent 的管理面硬性要求 webserver 绑回环（along-superagent 的
// src/app/http.ts:234），宿主与别的容器都够不着它；面板要能从宿主访问，就需要在
// 同一个网络命名空间里有一路 0.0.0.0 的入口转进 127.0.0.1。
//
// 用法：node deploy/netns-proxy.mjs <listenPort> <targetPort>
//   例：node deploy/netns-proxy.mjs 3083 3082
//
// 裸 TCP 转发，不解析内容：DSH 自己的同源校验（Origin/Host 头）由 nginx 面板配置负责。
import {createServer,createConnection} from 'node:net';

const listen=Number(process.argv[2]);
const target=Number(process.argv[3]);
if(!Number.isInteger(listen)||!Number.isInteger(target)) throw Error('用法：node netns-proxy.mjs <listenPort> <targetPort>');

createServer(client=>{
  const upstream=createConnection({host:'127.0.0.1',port:target});
  client.pipe(upstream);
  upstream.pipe(client);
  const close=()=>{client.destroy();upstream.destroy();};
  client.on('error',close);
  upstream.on('error',close);
}).listen(listen,'0.0.0.0',()=>console.log(`跳板就绪：0.0.0.0:${listen} → 127.0.0.1:${target}`));
