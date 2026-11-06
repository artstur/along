import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
const files=['index.html','style.css','app.mjs','health.mjs','workspace.mjs','loop.mjs','goal-agent-core.mjs','adaptive-ui.mjs','super-agent.mjs','agent-client.mjs','agent-replay.json','app-icon.png','manifest.webmanifest','sw.js'];
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
await mkdir('ios/AlongHealth/Web',{recursive:true});
for(const file of files){await copyFile(`web/${file}`,`dist/${file}`);await copyFile(`web/${file}`,`ios/AlongHealth/Web/${file}`);}
try { const config=JSON.parse(await readFile('.openai/hosting.json','utf8')); config.static={directory:'dist'}; await writeFile('.openai/hosting.json',JSON.stringify(config,null,2)+'\n'); } catch {}
console.log(`Built ${files.length} files → dist/ and ios/AlongHealth/Web/`);
