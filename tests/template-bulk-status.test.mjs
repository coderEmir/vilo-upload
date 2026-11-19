import assert from 'node:assert/strict';
import test from 'node:test';
import { updateTemplateStatuses } from '../src/template-bulk-status.ts';

test('publishes each selected template and sets only missing publication dates', async () => {
  const calls = [];
  const publishedAt = '2026-01-01T00:00:00.000Z';
  const result = await updateTemplateStatuses([
    { id: 'one', title: 'One', publishedAt: null }, { id: 'two/id', title: 'Two', publishedAt },
  ], 'PUBLISHED', async (path, init) => { calls.push([path, init.method, JSON.parse(init.body)]); });
  assert.equal(result.succeeded.length, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(calls[0][2].status, 'PUBLISHED');
  assert.ok(Number.isFinite(Date.parse(calls[0][2].publishedAt)));
  assert.deepEqual(calls[1], ['/templates/two%2Fid', 'PATCH', { status: 'PUBLISHED' }]);
  assert.equal(result.succeeded[1].publishedAt, publishedAt);
});
test('draft updates only status without changing other template or episode fields', async () => {
  const publishedAt = '2026-01-01T00:00:00.000Z';
  const result = await updateTemplateStatuses([{ id: 'one', title: 'One', publishedAt }], 'DRAFT', async (_, init) => {
    assert.deepEqual(JSON.parse(init.body), { status: 'DRAFT' });
  });
  assert.deepEqual(result.succeeded, [{ id: 'one', status: 'DRAFT', publishedAt }]);
});
test('continues after a failed item and reports successful and retryable selections separately', async () => {
  const result = await updateTemplateStatuses(['one', 'two', 'three'].map(id => ({ id, title: id, publishedAt: null })), 'DRAFT', async path => {
    if (path.endsWith('/two')) throw new Error('Permission denied');
  });
  assert.deepEqual(result.succeeded.map(item => item.id), ['one', 'three']);
  assert.deepEqual(result.failed, [{ id: 'two', title: 'two', message: 'Permission denied' }]);
});
