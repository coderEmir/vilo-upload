import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import ts from 'typescript';
import * as XLSX from 'xlsx';
import { createTemplateUploader } from '../src/template-upload-cache.ts';

// Exercise the actual Vue import handler with isolated browser/network dependencies.
const app = await fs.readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('async function importExcel('), app.indexOf('\nfunction handleDrop('));
const js = ts.transpile(handler, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
const fields = ['title', 'slug', 'category', 'description', 'coverUrl', 'modelCode', 'promptTemplate'];
function setup(rows, rejectValidation = false) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([fields, ...rows]), '视频');
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  const calls = [];
  const ref = value => ({ value });
  const context = {
    XLSX, activeType: ref('SHORT_VIDEO'), importing: ref(false), loading: ref(false), error: ref(''), notice: ref(''), typeLabel: ref('视频'),
    nonEmpty: v => v == null ? '' : String(v).trim(),
    workbookTemplate: () => ({ headers: fields, columns: fields.map(k => [k, k]) }),
    readTemplateEmbeddedMedia: () => rows.map((_, i) => ({ row: i + 2, role: 'COVER', file: new File(['cover'], 'cover.png', { type: 'image/png' }) })),
    models: ref([]), resolveTemplateModel: (_, code) => code === 'valid' ? { code, params: [] } : undefined,
    emptyEpisode: () => ({ mediaAssets: [], referenceAssets: [] }),
    isTemplateControlledParam: () => true,
    uploadAssetFile: async () => { calls.push('upload'); return 'https://oss.example/cover'; },
    request: async path => { calls.push(path); if (path.endsWith('/validate') && rejectValidation) throw new Error('模型参数错误'); },
    load: async () => {},
  };
  const run = new Function('context', `with(context) { ${js}; return importExcel; }`)(context);
  return { context, calls, run: () => run({ target: { files: [{ arrayBuffer: async () => bytes }], value: '' } }) };
}
const row = (slug, model = 'valid', prompt = 'original prompt') => ['Title', slug, 'Category', 'Description', '', model, prompt];
test('any invalid row prevents every upload and creation, including earlier valid rows', async () => {
  for (const invalid of [row('two', ''), row('two', 'valid', '')]) {
    const x = setup([row('one'), invalid]); await x.run();
    assert.deepEqual(x.calls, []); assert.match(x.context.error.value, /校验失败，未上传任何素材/);
  }
});
test('backend rejection prevents every upload', async () => {
  const x = setup([row('one'), row('two')], true); await x.run();
  assert.deepEqual(x.calls, ['/templates/validate', '/templates/validate']);
  assert.match(x.context.error.value, /模型参数错误/);
});
test('all rows validate before first asset upload', async () => {
  const x = setup([row('one'), row('two')]); await x.run();
  assert.equal(x.context.error.value, '');
  assert.deepEqual(x.calls, ['/templates/validate', '/templates/validate', 'upload', '/templates', 'upload', '/templates']);
});
test('content cache reuses successful uploads across retries, renamed files and refreshes', async () => {
  const values = new Map(); const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  let uploads = 0;
  const send = async () => { uploads++; return Response.json({ url: 'https://oss.example/original' }); };
  const file = new File(['original'], 'one.mp4', { type: 'video/mp4' });
  const upload = createTemplateUploader(storage);
  await Promise.all([upload(file, '/api', 'key', send), upload(file, '/api', 'key', send)]);
  await createTemplateUploader(storage)(new File(['original'], 'renamed.mp4', { type: 'video/mp4' }), '/api', 'key', send);
  assert.equal(uploads, 1);
  await upload(new File(['different'], 'one.mp4', { type: 'video/mp4' }), '/api', 'key', send);
  assert.equal(uploads, 2);
});
test('failed upload is retried rather than cached', async () => {
  const upload = createTemplateUploader(); const file = new File(['x'], 'x.png', { type: 'image/png' });
  await assert.rejects(upload(file, '/api', 'key', async () => Response.json({}, { status: 500 })));
  assert.equal(await upload(file, '/api', 'key', async () => Response.json({ url: 'https://oss.example/retry' })), 'https://oss.example/retry');
});
