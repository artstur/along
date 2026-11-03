import { mkdir, rm, copyFile, readFile, writeFile } from 'node:fs/promises';
const files=['index.html','style.css','app.mjs','health.mjs','icon.svg','icon-192.png','icon-512.png','manifest.webmanifest','sw.js'];
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
for(const file of files)await copyFile(file,`dist/${file}`);
try { const config=JSON.parse(await readFile('.openai/hosting.json','utf8')); config.static={directory:'dist'}; await writeFile('.openai/hosting.json',JSON.stringify(config,null,2)+'\n'); } catch {}
console.log(`Built ${files.length} files → dist/`);
