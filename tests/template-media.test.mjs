import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { readTemplateEmbeddedMedia, storedMedia, previewMedia, uploadTemplateFile } from '../src/template-media.ts';

globalThis.DOMParser = DOMParser;
const headers = ['模板名称（必填）', '唯一标识（必填）', '分类（必填）', '模板描述（必填）', '封面图链接（必填，可插入图片）', '标签（逗号分隔）', '状态（DRAFT/PUBLISHED/ARCHIVED）', '启用（是/否）', '付费（是/否）', '排序权重', '模型编码或名称（必填）', '生成提示词（必填）', '负向提示词', '预览视频或动图（可插入媒体）'];
const rns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function fixture({ preview = 'mp4', duplicate = false, slug = 'one' } = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ['Example', 'one'], [], ['Other', 'two']]), '视频');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['填写说明'], [], ['模板标识', '模板名称', '素材用途', '内嵌原文件'],
    [slug, 'Example', '生成参考图', ''], [slug, 'Example', '生成参考视频', ''],
  ]), '填写说明');
  const files = unzipSync(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
  function sheet(index, assets) {
    const path = `xl/worksheets/sheet${index}.xml`;
    files[path] = strToU8(new TextDecoder().decode(files[path]).replace('</worksheet>', `<drawing r:id="media"/></worksheet>`));
    files[`xl/worksheets/_rels/sheet${index}.xml.rels`] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="media" Type="${rns}/drawing" Target="../drawings/media${index}.xml"/></Relationships>`);
    files[`xl/drawings/media${index}.xml`] = strToU8(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rns}">${assets.map((a, i) => `<xdr:oneCellAnchor><xdr:from><xdr:row>${a.row}</xdr:row><xdr:col>${a.col}</xdr:col></xdr:from><a:${a.ext === 'mp4' ? 'videoFile r:link' : 'blip r:embed'}="r${i}"/></xdr:oneCellAnchor>`).join('')}</xdr:wsDr>`);
    files[`xl/drawings/_rels/media${index}.xml.rels`] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${assets.map((a, i) => `<Relationship Id="r${i}" Type="${rns}/${a.ext === 'mp4' ? 'video' : 'image'}" Target="../media/${index}-${i}.${a.ext}"/>`).join('')}</Relationships>`);
    assets.forEach((a, i) => { files[`xl/media/${index}-${i}.${a.ext}`] = new Uint8Array([index, i, 10, 20]); });
  }
  sheet(1, [{ row: 1, col: 4, ext: 'webp' }, { row: 1, col: 13, ext: preview }, { row: 3, col: 4, ext: 'png' }, ...(duplicate ? [{ row: 1, col: 13, ext: preview }] : [])]);
  sheet(2, [{ row: 3, col: 3, ext: 'jpg' }, { row: 4, col: 3, ext: 'mp4' }]);
  return { buffer: zipSync(files).buffer, book };
}

for (const [ext, mime] of [['mp4', 'video/mp4'], ['gif', 'image/gif'], ['webp', 'image/webp']]) {
  test(`extracts ${ext} preview separately from cover and generation inputs`, async () => {
    const { buffer, book } = fixture({ preview: ext });
    const assets = readTemplateEmbeddedMedia(buffer, book, '视频');
    assert.deepEqual(assets.map(a => [a.row, a.role, a.file.type]), [[2, 'COVER', 'image/webp'], [2, 'PREVIEW', mime], [4, 'COVER', 'image/png'], [2, 'INPUT', 'image/jpeg'], [2, 'INPUT', 'video/mp4']]);
    assert.deepEqual(new Uint8Array(await assets[1].file.arrayBuffer()), new Uint8Array([1, 1, 10, 20]));
    const preview = storedMedia('https://oss.example/original.' + ext, mime, 'PREVIEW');
    const reference = storedMedia('https://oss.example/input.mp4', 'video/mp4', 'INPUT');
    assert.equal(preview.role, 'RESULT'); assert.equal(reference.role, 'SOURCE_TEMPLATE');
    assert.equal(previewMedia([preview]), preview);
  });
}
test('rejects a static PNG preview, duplicate previews and orphaned input rows', () => {
  for (const [options, message] of [[{ preview: 'png' }, /预览必须/], [{ duplicate: true }, /只能指定一个预览/], [{ slug: 'missing' }, /不存在的模板标识/]]) {
    const { buffer, book } = fixture(options);
    assert.throws(() => readTemplateEmbeddedMedia(buffer, book, '视频'), message);
  }
});
test('legacy workbook without embedded media keeps working', () => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ['Example', 'one']]), '视频');
  const data = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  assert.deepEqual(readTemplateEmbeddedMedia(data, book, '视频'), []);
});
test('preview upload sends original bytes and MIME to the OSS asset endpoint before serialization', async () => {
  for (const mime of ['video/mp4', 'image/gif', 'image/webp']) {
    const file = new File([new Uint8Array([3, 9, 2, 7])], 'original', { type: mime });
    const url = await uploadTemplateFile(file, '/template-api', 'key', async (target, init) => {
      assert.equal(target, '/template-api/templates/assets');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], mime);
      assert.equal(init.headers['x-template-admin-key'], 'key');
      assert.equal(init.body, file);
      return Response.json({ url: 'https://oss.example/uploaded' }, { status: 201 });
    });
    assert.equal(storedMedia(url, mime, 'PREVIEW').url, 'https://oss.example/uploaded');
  }
  await assert.rejects(uploadTemplateFile(new File(['x'], 'bad', { type: 'text/plain' }), '/api', ''), /素材必须/);
  await assert.rejects(uploadTemplateFile(new File(['x'], 'video', { type: 'video/mp4' }), '/api', '', async () => Response.json({ error: { message: 'OSS unavailable' } }, { status: 502 })), /OSS unavailable/);
  await assert.rejects(uploadTemplateFile(new File(['x'], 'video', { type: 'video/mp4' }), '/api', '', async () => Response.json({})), /OSS 地址/);
});
