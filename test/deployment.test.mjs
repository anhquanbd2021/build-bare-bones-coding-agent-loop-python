import test from 'node:test';
import assert from 'node:assert/strict';
import { startProduction } from '../app/server.js';

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
}

test('server serves only allowed lab assets, health and version', async () => {
  const previousGit = process.env.GIT_COMMIT;
  const previousRender = process.env.RENDER_GIT_COMMIT;
  process.env.GIT_COMMIT = 'test-commit';
  process.env.RENDER_GIT_COMMIT = 'test-commit';
  const { server, close } = await startProduction({ port: 0 });
  const port = server.address().port;
  try {
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.body, /Agent Loop Under Glass/);
    assert.match(index.type, /text\/html/);

    const health = await get(port, '/health');
    assert.equal(health.status, 200);

    const version = await get(port, '/version');
    assert.equal(version.status, 200);
    assert.deepEqual(JSON.parse(version.body), {
      name: 'agent-loop-under-glass-demo',
      version: '1.0.0',
      commit: 'test-commit',
    });

    for (const path of ['/engine.mjs', '/tools.mjs', '/models.mjs', '/scenarios.mjs']) {
      const module = await get(port, path);
      assert.equal(module.status, 200);
      assert.match(module.type, /javascript/);
    }

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await close();
    if (previousGit === undefined) delete process.env.GIT_COMMIT;
    else process.env.GIT_COMMIT = previousGit;
    if (previousRender === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previousRender;
  }
});

test('server blocks path traversal and missing files', async () => {
  const { server, close } = await startProduction({ port: 0 });
  const port = server.address().port;
  try {
    assert.equal((await get(port, '/../package.json')).status, 404);
    assert.equal((await get(port, '/index.html')).status, 404);
    assert.equal((await get(port, '/nope.js')).status, 404);
    assert.equal((await get(port, '/app/server.js')).status, 404);
  } finally {
    await close();
  }
});
