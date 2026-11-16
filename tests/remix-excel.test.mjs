import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { mediaMime, readRemixExcel } from '../src/remix-excel.ts';

function excel(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '素材');
  return new File([XLSX.write(book, { type: 'buffer', bookType: 'biff8' })], 'batch.xls');
}
test('reads every linked image and video with independent optional subjects', async () => {
  const result = await readRemixExcel(excel([
    ['模板名称', '媒体类型', '原素材', '主体图片', '替换要求'],
    ['图片', '图片', 'https://example.com/source.png', 'https://example.com/person.png', '保留文字'],
    [],
    ['视频', '视频', 'https://example.com/stream?id=1', '', ''],
  ]));
  assert.equal(result.length, 2);
  assert.equal(result[0].subjectUrl, 'https://example.com/person.png');
  assert.equal(result[0].prompt, '保留文字');
  assert.equal(result[1].mimeType, 'video/mp4');
  assert.equal(result[1].subjectUrl, undefined);
});
test('reports missing source columns and inaccessible local paths', async () => {
  await assert.rejects(readRemixExcel(excel([['模板名称'], ['测试']])), /缺少“原素材”列/);
  await assert.rejects(readRemixExcel(excel([['原素材'], ['C:\\video.mp4']])), /本地路径无法直接读取/);
});
test('rejects invalid subject links rather than silently omitting subjects', async () => {
  await assert.rejects(readRemixExcel(excel([['原素材', '主体图片'], ['https://example.com/a.jpg', 'person.jpg']])), /主体链接无效/);
});
test('detects signed video and image link extensions', () => {
  assert.equal(mediaMime('https://example.com/video.mp4?sign=abc'), 'video/mp4');
  assert.equal(mediaMime('https://example.com/image.JPG#view'), 'image/jpeg');
});

test('one template collects multiple image and video columns plus additional rows', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  const rows = await readRemixExcel(excel([
    ['模板标识', '模板名称', '图片1', '图片2', '视频1', '视频2', '主体图片'],
    ['group-1', '完整模板', 'https://example.com/1.jpg\nhttps://example.com/2.jpg', 'https://example.com/3.png', 'https://example.com/1.mp4', 'https://example.com/2.mp4', 'https://example.com/person.png'],
    ['group-1', '完整模板', 'https://example.com/4.jpg', '', '', '', 'https://example.com/person.png'],
    ['group-2', '另一个模板', 'https://example.com/5.jpg', '', '', '', ''],
  ]));
  const groups = groupImportSources(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].assets.length, 6);
  assert.equal(groups[0].assets.filter((asset) => asset.mimeType.startsWith('video/')).length, 2);
  assert.ok(groups[0].assets.every((asset) => asset.subjectUrl === 'https://example.com/person.png'));
  assert.equal(groups[1].assets.length, 1);
});

test('different names cannot accidentally share the same template identifier', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  assert.throws(() => groupImportSources([
    { templateKey: 'same', title: '模板一', name: 'a', mimeType: 'image/png' },
    { templateKey: 'same', title: '模板二', name: 'b', mimeType: 'image/png' },
  ]), /不同的模板名称/);
});


test('the first subject becomes the template default for additional media rows', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  const groups = groupImportSources(await readRemixExcel(excel([
    ['模板标识', '原素材', '主体图片'],
    ['template', 'https://example.com/a.png', 'https://example.com/person.png'],
    ['template', 'https://example.com/b.mp4', ''],
  ])));
  assert.equal(groups[0].subjectUrl, 'https://example.com/person.png');
  assert.equal(groups[0].assets[1].subjectUrl, undefined);
  assert.equal(groups[0].assets.length, 2);
});
