import test from 'node:test';
import assert from 'node:assert/strict';
import { codingTools, createDeps, editText } from '../public/tools.mjs';

const tools = codingTools();

test('edit: unique exact match replaces once', async () => {
  const deps = createDeps({ fs: { 'a.txt': 'alpha beta gamma' } });
  const res = await tools.call('edit', { path: 'a.txt', old_string: 'beta', new_string: 'BETA' }, deps);
  assert.equal(res.ok, true);
  assert.equal(deps.fs.get('a.txt'), 'alpha BETA gamma');
});

test('edit: ambiguous match is an error, not a guess', () => {
  const res = editText('x = 1\nx = 2\n', 'x =', 'y =');
  assert.equal(res.ok, false);
  assert.match(res.error, /ambiguous: 2 matches/);
});

test('edit: not found reports zero hits even after whitespace collapse', () => {
  const res = editText('nothing here', 'missing needle', 'x');
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test('edit: BOM and CRLF the model never saw do not break the match', () => {
  const res = editText('﻿const a = 1;\r\nconst b = 2;\r\n', 'const a = 1;', 'const a = 9;');
  assert.equal(res.ok, true);
  assert.match(res.text, /const a = 9;\nconst b = 2;/);
});

test('edit: whitespace-collapsed fallback rescues spacing differences', () => {
  const res = editText('if (a)  {\n    run();\n}', 'if (a) { run(); }', 'fixed();');
  assert.equal(res.ok, true);
  assert.match(res.text, /fixed\(\);/);
});

test('read: returns file contents and errors on missing path', async () => {
  const deps = createDeps({ fs: { 'f.txt': 'l1\nl2\nl3\n' } });
  assert.equal((await tools.call('read', { path: 'f.txt' }, deps)).output, 'l1\nl2\nl3\n');
  const missing = await tools.call('read', { path: 'nope.txt' }, deps);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no such file/);
});

test('read: offset and limit window the file', async () => {
  const deps = createDeps({ fs: { 'f.txt': 'l1\nl2\nl3\nl4\n' } });
  const res = await tools.call('read', { path: 'f.txt', offset: 2, limit: 2 }, deps);
  assert.equal(res.output, 'l2\nl3');
});

test('write: creates and overwrites', async () => {
  const deps = createDeps({ fs: {} });
  await tools.call('write', { path: 'n.md', content: 'hi\n' }, deps);
  assert.equal(deps.fs.get('n.md'), 'hi\n');
  await tools.call('write', { path: 'n.md', content: 'bye\n' }, deps);
  assert.equal(deps.fs.get('n.md'), 'bye\n');
});

test('todo_write: overwrites in place and emits one event', async () => {
  const emitted = [];
  const deps = createDeps({ emit: (e) => emitted.push(e) });
  const store = deps.taskStore;
  await tools.call('todo_write', { tasks: ['a', 'b'] }, deps);
  await tools.call('todo_write', { tasks: ['[x] a', 'b'] }, deps);
  assert.equal(deps.taskStore, store, 'same list object — overwrite in place');
  assert.deepEqual(store, ['[x] a', 'b']);
  assert.equal(emitted.filter((e) => e.type === 'task-list-updated').length, 2);
});

test('bash: registered command sees live fs; unregistered returns 127', async () => {
  const deps = createDeps({
    fs: { 'x.txt': 'data\n' },
    commands: { 'cat x.txt': (fs) => ({ stdout: fs.get('x.txt'), code: 0 }) },
  });
  const ok = await tools.call('bash', { command: 'cat x.txt' }, deps);
  assert.match(ok.output, /Exit code: 0/);
  assert.match(ok.output, /data/);
  const bad = await tools.call('bash', { command: 'rm -rf /' }, deps);
  assert.match(bad.output, /Exit code: 127/);
});

test('web_fetch: fixture hit returns body capped; miss errors explicitly', async () => {
  const deps = createDeps({ pages: { 'https://a.dev/p': 'page body' } });
  const ok = await tools.call('web_fetch', { url: 'https://a.dev/p' }, deps);
  assert.match(ok.output, /HTTP 200/);
  assert.match(ok.output, /page body/);
  const miss = await tools.call('web_fetch', { url: 'https://a.dev/missing' }, deps);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /404/);
});
