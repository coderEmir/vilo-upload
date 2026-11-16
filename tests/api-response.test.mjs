import assert from 'node:assert/strict';
import test from 'node:test';
import { readApiResponse } from '../src/api-response.ts';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('preserves a valid config response', async () => {
  assert.deepEqual(await readApiResponse(json({ models: [] }), '请求失败'), { models: [] });
});

for (const [name, response] of [
  ['SPA fallback HTML', () => new Response('<html>SPA</html>')],
  ['JSON null', () => json(null)],
  ['empty body', () => new Response(null)],
  ['array', () => json([])],
]) {
  test(`rejects ${name} before API fields are accessed`, async () => {
    await assert.rejects(readApiResponse(response(), '请求失败'), /代理配置/);
  });
}

test('preserves backend authorization errors', async () => {
  await assert.rejects(readApiResponse(json({ error: { message: '无权限' } }, 403), '请求失败'), /无权限/);
});

test('reports non-JSON upstream failure status', async () => {
  await assert.rejects(readApiResponse(new Response('Bad Gateway', { status: 502 }), '请求失败'), /请求失败 \(502\)/);
});
