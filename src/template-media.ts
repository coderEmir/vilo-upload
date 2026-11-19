import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';
import { mediaMime } from './remix-excel.ts';

export type TemplateMediaRole = 'COVER' | 'PREVIEW' | 'INPUT';
export type TemplateMedia = { row: number; role: TemplateMediaRole; file: File };
export type StoredMedia = { type: 'IMAGE' | 'VIDEO'; role: string; url: string; mimeType: string; name?: string };
export async function uploadTemplateFile(file: File, apiBase: string, adminKey: string, send: typeof fetch = fetch): Promise<string> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) throw new Error(`素材必须是图片或视频：${file.name}`);
  const response = await send(`${apiBase}/templates/assets`, { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'x-template-admin-key': adminKey } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `素材上传失败 (${response.status})`);
  if (typeof payload?.url !== 'string' || !/^https?:\/\//i.test(payload.url)) throw new Error('素材上传响应缺少有效的 OSS 地址');
  return payload.url;
}
export function isPreviewMime(mime: string): boolean {
  return mime.startsWith('video/') || mime === 'image/gif' || mime === 'image/webp';
}
export function storedMedia(url: string, mimeType: string, role: 'PREVIEW' | 'INPUT', name?: string): StoredMedia {
  if (role === 'PREVIEW' && !isPreviewMime(mimeType)) throw new Error('预览必须是视频、GIF 或 WebP 动图');
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) throw new Error('素材必须是图片或视频');
  return { type: mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE', role: role === 'PREVIEW' ? 'RESULT' : 'SOURCE_TEMPLATE', url, mimeType, ...(name ? { name } : {}) };
}
export function previewMedia(assets: unknown[]): StoredMedia | undefined {
  return assets.find((a): a is StoredMedia => !!a && typeof a === 'object' && (a as StoredMedia).role !== 'SOURCE_TEMPLATE' && typeof (a as StoredMedia).url === 'string' && isPreviewMime((a as StoredMedia).mimeType || ((a as StoredMedia).type === 'VIDEO' ? 'video/mp4' : mediaMime((a as StoredMedia).url))));
}

/** Resolve media by cell and role; never treat an input or preview poster as a cover. */
export function readTemplateEmbeddedMedia(buffer: ArrayBuffer, book: XLSX.WorkBook, mainSheet: string): TemplateMedia[] {
  const signature = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) return []; // Legacy .xls has no OOXML media relationships.
  const archive = unzipSync(new Uint8Array(buffer));
  const parse = (path: string) => {
    const bytes = archive[path];
    if (!bytes) return undefined;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error(`Excel 媒体结构无效：${path}`);
    return doc;
  };
  const nodes = (doc: Document | Element | undefined, name: string) => doc ? Array.from(doc.getElementsByTagNameNS('*', name)) : [];
  const rel = (path: string, id: string) => nodes(parse(path), 'Relationship').find(r => r.getAttribute('Id') === id);
  const resolve = (base: string, target: string) => new URL(target, `https://xlsx.local/${base}`).pathname.slice(1);
  const relPath = (path: string) => path.replace(/([^/]+)$/, '_rels/$1.rels');
  const mainRows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[mainSheet], { header: 1, defval: '', blankrows: true });
  const mainHeaders = (mainRows[0] || []).map(String);
  const slugColumn = mainHeaders.findIndex(h => /唯一标识|^slug$/i.test(h));
  const rowBySlug = new Map(mainRows.slice(1).map((r, i) => [String(r[slugColumn] || '').trim(), i + 2]));
  const result: TemplateMedia[] = [];
  for (const sheet of nodes(parse('xl/workbook.xml'), 'sheet')) {
    const name = sheet.getAttribute('name') || '';
    const rows = name === mainSheet ? mainRows : XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: '', blankrows: true });
    const sourceHeaderRow = rows.findIndex(r => r.includes('模板标识') && r.includes('素材用途') && r.includes('内嵌原文件'));
    if (name !== mainSheet && sourceHeaderRow < 0) continue;
    const headers = name === mainSheet ? mainHeaders : rows[sourceHeaderRow].map(String);
    const target = rel('xl/_rels/workbook.xml.rels', sheet.getAttribute('r:id') || '')?.getAttribute('Target');
    if (!target) continue;
    const path = resolve('xl/workbook.xml', target);
    for (const drawing of nodes(parse(path), 'drawing')) {
      const drawingTarget = rel(relPath(path), drawing.getAttribute('r:id') || '')?.getAttribute('Target');
      if (!drawingTarget) continue;
      const drawingPath = resolve(path, drawingTarget);
      for (const anchor of [...nodes(parse(drawingPath), 'oneCellAnchor'), ...nodes(parse(drawingPath), 'twoCellAnchor')]) {
        const from = nodes(anchor, 'from')[0];
        const row = Number(nodes(from, 'row')[0]?.textContent);
        const col = Number(nodes(from, 'col')[0]?.textContent);
        let excelRow = row + 1;
        let role: TemplateMediaRole | undefined;
        if (name === mainSheet) {
          const header = headers[col] || '';
          if (/封面/.test(header)) role = 'COVER';
          else if (/预览/.test(header)) role = 'PREVIEW';
          else if (/^(生成素材|原素材|参考素材)\d*$/.test(header)) role = 'INPUT';
        } else if (row > sourceHeaderRow && col === headers.indexOf('内嵌原文件')) {
          const sourceRow = rows[row] || [];
          const slug = String(sourceRow[headers.indexOf('模板标识')] || '').trim();
          const mappedRow = rowBySlug.get(slug);
          if (!mappedRow) throw new Error(`素材引用了不存在的模板标识：${slug}`);
          excelRow = mappedRow;
          const usage = String(sourceRow[headers.indexOf('素材用途')] || '');
          if (/预览/.test(usage)) role = 'PREVIEW';
          else if (/^生成/.test(usage)) role = 'INPUT';
          else if (/封面/.test(usage)) role = 'COVER';
        }
        if (!role) continue;
        const media = nodes(anchor, 'media')[0] || nodes(anchor, 'videoFile')[0] || nodes(anchor, 'blip')[0];
        const relationship = rel(relPath(drawingPath), media?.getAttribute('r:embed') || media?.getAttribute('r:link') || '');
        if (relationship?.getAttribute('TargetMode') === 'External') throw new Error('请将媒体文件内嵌到 Excel，不能用外部媒体关系代替文件');
        const mediaTarget = relationship?.getAttribute('Target');
        if (!mediaTarget) throw new Error(`第 ${excelRow} 行媒体文件关系缺失`);
        const mediaPath = resolve(drawingPath, mediaTarget);
        const bytes = archive[mediaPath];
        if (!bytes) throw new Error(`第 ${excelRow} 行内嵌媒体缺失`);
        const mime = mediaMime(mediaPath);
        if (role === 'COVER' && !mime.startsWith('image/')) throw new Error('封面必须是图片');
        if (role === 'PREVIEW' && !isPreviewMime(mime)) throw new Error('预览必须是视频、GIF 或 WebP 动图');
        if (!mime) throw new Error(`不支持的内嵌素材格式：${mediaPath}`);
        result.push({ row: excelRow, role, file: new File([new Uint8Array(bytes)], mediaPath.split('/').pop()!, { type: mime }) });
      }
    }
  }
  for (const role of ['COVER', 'PREVIEW'] as const) {
    const seen = new Set<number>();
    for (const asset of result.filter(a => a.role === role)) {
      if (seen.has(asset.row)) throw new Error(`第 ${asset.row} 行只能指定一个${role === 'COVER' ? '封面' : '预览'}`);
      seen.add(asset.row);
    }
  }
  return result;
}
