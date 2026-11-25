import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

export function copyTokens(dockerfile) {
  return dockerfile.split('\n')
    .filter(line => line.startsWith('COPY '))
    .flatMap(line => line.split(/\s+/).slice(1));
}

export function copyWebFiles(dockerfile) {
  return copyTokens(dockerfile)
    .filter(token => token.startsWith('web/') && token !== 'web/')
    .map(token => token.slice('web/'.length));
}

const IMPORT_RE = /(?:from|import\()\s*'([^']+\.(?:mjs|json))'/g;

// 从 Host 的顶层模块跟随相对 import，收集 Dockerfile.host 需要复制的 Web 文件。
export function hostWebDependencies(root) {
  const reachable = new Set();
  const seen = new Set();
  const queue = readdirSync(join(root, 'host'))
    .filter(file => file.endsWith('.mjs'))
    .map(file => ['host', file]);

  while (queue.length) {
    const [dir, file] = queue.pop();
    const key = `${dir}/${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (dir === 'web') reachable.add(file);

    const source = readFileSync(join(root, dir, file), 'utf8');
    for (const [, ref] of source.matchAll(IMPORT_RE)) {
      if (ref.startsWith('../web/')) {
        queue.push(['web', ref.slice('../web/'.length)]);
      } else if (ref.startsWith('./')) {
        queue.push([dir, ref.slice(2)]);
      }
    }
  }
  return reachable;
}
