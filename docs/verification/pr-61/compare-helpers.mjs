import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';

const [before, after] = process.argv.slice(2);
const candidate = await import(pathToFileURL(join(after, 'test/helpers/dockerfile-web-dependencies.mjs')));
const suites = ['test/deploy-orchestration.test.mjs', 'test/security-deploy-hardening.test.mjs'];

// The private baseline functions lived directly above the tests in both pinned suites.
const baselineHelpers = suites.map(suite => {
  const source = readFileSync(join(before, suite), 'utf8');
  const changed = readFileSync(join(after, suite), 'utf8');
  const testStart = "\ntest('";
  assert.ok(source.includes(testStart) && changed.includes(testStart), suite);
  assert.equal(source.slice(source.indexOf(testStart)), changed.slice(changed.indexOf(testStart)), suite);

  const start = source.indexOf('function copyTokens(');
  const closure = source.indexOf('function webClosure()');
  const end = source.indexOf('\nconst ', source.indexOf('\n}', closure));
  assert.ok(start >= 0 && closure > start && end > closure, suite);
  const helpers = source.slice(start, end) + '\n;({copyTokens, copyWebFiles, webClosure})';
  return root => runInNewContext(helpers, {ROOT: root, join, readdirSync, readFileSync});
});

const inputs = [
  ...['Dockerfile.host', 'Dockerfile.agent'].map(name => readFileSync(join(after, 'deploy', name), 'utf8')),
  '',
  'copy a b\n# COPY a b',
  'COPY web/a.mjs web/\nCOPY --from=other web/b.mjs app/\nCOPY  a web/c.json web/',
];

const fixture = mkdtempSync(join(tmpdir(), 'along-pr61-imports-'));
try {
  for (const dir of ['host', 'web']) mkdirSync(join(fixture, dir));
  writeFileSync(join(fixture, 'host/a.mjs'), "import { x } from './b.mjs';\nimport('../web/leaf.mjs');\n");
  writeFileSync(join(fixture, 'host/b.mjs'), "import { y } from '../web/cycle.mjs';\n");
  writeFileSync(join(fixture, 'web/cycle.mjs'), "import { y } from './leaf.mjs';\n");
  writeFileSync(join(fixture, 'web/leaf.mjs'), "import('./cycle.mjs');\nimport('./data.json');\n");
  writeFileSync(join(fixture, 'web/data.json'), '{}');
  assert.deepEqual([...candidate.hostWebDependencies(fixture)].sort(), ['cycle.mjs', 'data.json', 'leaf.mjs']);
  for (const helpers of baselineHelpers) {
    const old = helpers(before);
    for (const input of inputs) {
      for (const method of ['copyTokens', 'copyWebFiles']) {
        assert.deepEqual([...old[method](input)], [...candidate[method](input)]);
      }
    }
    for (const [oldRoot, newRoot] of [[before, after], [fixture, fixture]]) {
      const previous = helpers(oldRoot).webClosure();
      assert.deepEqual([...(previous.reachable ?? previous)], [...candidate.hostWebDependencies(newRoot)]);
    }
  }
  rmSync(join(fixture, 'web/data.json'));
  for (const helpers of baselineHelpers) assert.throws(() => helpers(fixture).webClosure(), {code: 'ENOENT'});
  assert.throws(() => candidate.hostWebDependencies(fixture), {code: 'ENOENT'});
  console.log('PASS: both suites retain their assertions, COPY parsing, import traversal order and missing-file errors.');
} finally {
  rmSync(fixture, {recursive: true, force: true});
}
