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

test('rejects multiple sources sharing one Excel row', async () => {
  await assert.rejects(readRemixExcel(excel([
    ['模板标识', '图片1', '视频1', '主体图片'],
    ['group', 'https://example.com/a.png', 'https://example.com/b.mp4', 'https://example.com/person.png'],
  ])), /每行只允许一条/);
});

test('different names cannot accidentally share the same template identifier', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  assert.throws(() => groupImportSources([
    { templateKey: 'same', title: '模板一', name: 'a', mimeType: 'image/png' },
    { templateKey: 'same', title: '模板二', name: 'b', mimeType: 'image/png' },
  ]), /不同的模板名称/);
});


test('subjects remain independent and never become a template default', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  const groups = groupImportSources(await readRemixExcel(excel([
    ['模板标识', '原素材', '主体图片'],
    ['template', 'https://example.com/a.png', 'https://example.com/person.png'],
    ['template', 'https://example.com/b.mp4', ''],
  ])));
  assert.equal(groups[0].assets[0].subjectUrl, 'https://example.com/person.png');
  assert.equal('subjectUrl' in groups[0], false);
  assert.equal(groups[0].assets[1].subjectUrl, undefined);
  assert.equal(groups[0].assets.length, 2);
});


test('template prompt survives mixed-media Excel grouping and conflicts are rejected', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  const sources = await readRemixExcel(excel([
    ['模板标识', '原素材', '模板提示词', '替换要求'],
    ['same', 'https://example.com/a.png', '模板生成提示词', '保留背景'],
    ['same', 'https://example.com/b.mp4', '', '保留背景'],
  ]));
  const groups = groupImportSources(sources);
  assert.equal(groups[0].templatePrompt, '模板生成提示词');
  assert.equal(groups[0].assets.length, 2);
  assert.equal(groups[0].assets[1].prompt, '保留背景');
  assert.throws(() => groupImportSources([...sources, { ...sources[0], templatePrompt: '冲突' }]), /不同的模板提示词/);
});

test('infers link media from the path suffix regardless of case or signed query', () => {
  assert.equal(mediaMime('https://cdn.example.com/clip.MP4?filename=cover.jpg#preview'), 'video/mp4');
  assert.equal(mediaMime('https://cdn.example.com/photo.PNG?next=clip.mp4'), 'image/png');
  assert.equal(mediaMime('https://cdn.example.com/clip%2Emp4?signature=abc'), 'video/mp4');
  assert.equal(mediaMime('https://cdn.example.com/stream?filename=clip.mp4'), '');
});

test('Excel display assets group into independent template-level slots', async () => {
  const { groupImportSources } = await import('../src/remix-excel.ts');
  const groups = groupImportSources(await readRemixExcel(excel([
    ['模板标识', '原素材', '主体图片', '指定封面', '封面主体图片', '指定预览', '预览主体图片'],
    ['same', 'https://example.com/input.png', '', 'https://example.com/cover.gif', 'https://example.com/cover-person.png', 'https://example.com/preview.mp4', 'https://example.com/video-person.png'],
    ['same', 'https://example.com/input2.mp4', '', '', '', '', ''],
  ])));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].assets.length, 2);
  assert.equal(groups[0].assets[0].subjectUrl, undefined);
  assert.equal(groups[0].cover.url, 'https://example.com/cover.gif');
  assert.equal(groups[0].cover.subjectUrl, 'https://example.com/cover-person.png');
  assert.equal(groups[0].preview.subjectUrl, 'https://example.com/video-person.png');
  assert.throws(() => groupImportSources([{ ...groups[0].cover, templateKey: 'same' }, { ...groups[0].cover, templateKey: 'same' }]), /只能指定一个封面/);
  await assert.rejects(readRemixExcel(excel([['原素材', '指定预览'], ['https://example.com/in.jpg', 'https://example.com/static.png']])), /预览必须是视频或动态图/);
});
