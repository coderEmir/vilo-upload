import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAdminKey } from '../src/admin-auth.ts';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('verifies both services through existing protected read endpoints', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.headers['x-template-admin-key']]);
    return json(url.endsWith('/templates') ? { templates: [], models: [] } : { models: [] });
  });
  await verifyAdminKey('/template-api', '/remix-api', 'secret');
  assert.deepEqual(calls, [['/template-api/templates', 'secret'], ['/remix-api/template-remix/config', 'secret']]);
});

test('rejects incorrect keys and invalid success responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: { message: '模板管理密钥无效' } }, 401));
  await assert.rejects(verifyAdminKey('/template-api', '/remix-api', 'wrong'), /密钥无效/);
  globalThis.fetch = async () => json({ valid: true });
  await assert.rejects(verifyAdminKey('/template-api', '/remix-api', 'secret'), /响应无效/);
  globalThis.fetch = async () => new Response('<html>fallback</html>');
  await assert.rejects(verifyAdminKey('/template-api', '/remix-api', 'secret'), /代理配置/);
});
