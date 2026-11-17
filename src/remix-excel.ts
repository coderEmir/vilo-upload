import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';

export type ImportSource = { assetRole?: 'INPUT' | 'COVER' | 'PREVIEW'; keepOriginal?: boolean; templateKey?: string; name: string; file?: File; url?: string; mimeType: string; subjectFile?: File; subjectUrl?: string; title?: string; templatePrompt?: string; prompt?: string };
export function mediaMime(name: string): string {
  let path = name.split(/[?#]/)[0] || '';
  try { path = new URL(name).pathname; } catch { /* 本地文件名直接读取后缀 */ }
  try { path = decodeURIComponent(path); } catch { /* 保留无法解码的文件名 */ }
  const ext = path.split('/').pop()?.split('.').pop()?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' } as Record<string, string>)[ext || ''] || '';
}
function xml(bytes?: Uint8Array): Document | undefined { return bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml') : undefined; }
function nodes(doc: Document | Element | undefined, name: string): Element[] { return doc ? Array.from(doc.getElementsByTagNameNS('*', name)) : []; }
function resolve(base: string, target: string): string { return new URL(target, `https://xlsx.local/${base}`).pathname.slice(1); }

export async function readRemixExcel(file: File): Promise<ImportSource[]> {
  if (file.size > 50 * 1024 * 1024) throw new Error('Excel 文件不能超过 50MB');
  const buffer = await file.arrayBuffer();
  const book = XLSX.read(buffer, { type: 'array' });
  let expandedBytes = 0;
  const archive = file.name.toLowerCase().endsWith('.xlsx') ? unzipSync(new Uint8Array(buffer), { filter: (entry) => {
    expandedBytes += entry.originalSize;
    if (expandedBytes > 300 * 1024 * 1024) throw new Error('Excel 解压后不能超过 300MB');
    return true;
  } }) : {};
  const results: ImportSource[] = [];
  for (const sheetName of book.SheetNames.filter((name) => !['说明', '填写说明'].includes(name))) {
    const sheet = book.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', blankrows: true });
    const headers = (rows[0] || []).map(String);
    const sourceCols = headers.flatMap((v, index) => /^(原素材|素材链接|原素材链接|图片|视频|图片链接|视频链接|sourceUrl)\s*\d*$/i.test(v.trim()) ? [index] : []);
    const subjectCol = headers.findIndex((v) => /^(主体|主体图片|主体链接|主体图片链接|subjectUrl)$/i.test(v.trim()));
    if (!sourceCols.length) throw new Error(`${sheetName} 缺少“原素材”列`);
    const relation = (path: string, id: string) => nodes(xml(archive[path]), 'Relationship').find((el) => el.getAttribute('Id') === id);
    const sheetNode = nodes(xml(archive['xl/workbook.xml']), 'sheet').find((el) => el.getAttribute('name') === sheetName);
    const sheetTarget = relation('xl/_rels/workbook.xml.rels', sheetNode?.getAttribute('r:id') || '')?.getAttribute('Target');
    type Embedded = { file?: File; url?: string };
    const embedded = new Map<string, Embedded[]>();
    const addEmbedded = (row: number, col: number, media: Embedded) => {
      const key = `${row}:${col}`;
      embedded.set(key, [...(embedded.get(key) ?? []), media]);
    };
    if (sheetTarget) {
      const path = resolve('xl/workbook.xml', sheetTarget);
      const relPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
      for (const drawing of nodes(xml(archive[path]), 'drawing')) {
        const target = relation(relPath, drawing.getAttribute('r:id') || '')?.getAttribute('Target');
        if (!target) continue;
        const drawingPath = resolve(path, target);
        const drawingRels = drawingPath.replace(/([^/]+)$/, '_rels/$1.rels');
        for (const anchor of [...nodes(xml(archive[drawingPath]), 'twoCellAnchor'), ...nodes(xml(archive[drawingPath]), 'oneCellAnchor')]) {
          const from = nodes(anchor, 'from')[0];
          if (!from) continue;
          const row = Number(nodes(from, 'row')[0]?.textContent);
          const col = Number(nodes(from, 'col')[0]?.textContent);
          const media = nodes(anchor, 'media')[0] || nodes(anchor, 'videoFile')[0] || nodes(anchor, 'blip')[0];
          const id = media?.getAttribute('r:embed') || media?.getAttribute('r:link');
          const rel = relation(drawingRels, id || '');
          const mediaTarget = rel?.getAttribute('Target');
          if (!mediaTarget) continue;
          if (rel?.getAttribute('TargetMode') === 'External') { addEmbedded(row, col, { url: mediaTarget }); continue; }
          const mediaPath = resolve(drawingPath, mediaTarget);
          const bytes = archive[mediaPath];
          const mimeType = mediaMime(mediaPath);
          if (bytes && mimeType) addEmbedded(row, col, { file: new File([new Uint8Array(bytes)], mediaPath.split('/').pop() || '素材', { type: mimeType }) });
        }
      }
    }
    const cellText = (row: number, col: number) => {
      if (col < 0) return '';
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      const formulaUrl = cell?.f?.match(/^HYPERLINK\(\s*"([^"]+)"/i)?.[1];
      return String(cell?.l?.Target || formulaUrl || rows[row]?.[col] || '').trim();
    };
    const rowCount = Math.max(rows.length, ...Array.from(embedded.keys(), (key) => Number(key.split(':')[0]) + 1));
    for (let row = 1; row < rowCount; row++) {
      const cellsHaveContent = (rows[row] || []).some((value) => String(value).trim());
      const hasEmbedded = sourceCols.some((col) => embedded.has(`${row}:${col}`));
      if (!cellsHaveContent && !hasEmbedded) continue;
      const subjects = embedded.get(`${row}:${subjectCol}`) ?? [];
      if (subjects.length > 1) throw new Error(`${sheetName} 第 ${row + 1} 行：主体图片单元格只允许一张图片`);
      const subject = subjects[0];
      const subjectUrl = subject?.url || cellText(row, subjectCol);
      if (subjectUrl && !/^https?:\/\//i.test(subjectUrl)) throw new Error(`${sheetName} 第 ${row + 1} 行：主体链接无效`);
      if (subject?.file && !subject.file.type.startsWith('image/')) throw new Error(`${sheetName} 第 ${row + 1} 行：主体必须是图片`);
      const title = cellText(row, headers.indexOf('模板名称'));
      const templateKey = cellText(row, headers.findIndex((v) => /^(模板标识|模板唯一标识|templateKey)$/i.test(v.trim()))) || `${sheetName}-${row + 1}`;
      let found = 0;
      for (const sourceCol of sourceCols) {
        const links = cellText(row, sourceCol).split(/[\n\r]+/).map((value) => value.trim()).filter(Boolean);
        const sources: Embedded[] = [...(embedded.get(`${row}:${sourceCol}`) ?? []), ...links.map((url) => ({ url }))];
        for (const source of sources) {
          const sourceUrl = source.url || '';
          if (!source.file && !/^https?:\/\//i.test(sourceUrl)) throw new Error(`${sheetName} 第 ${row + 1} 行：请填写 HTTP(S) 素材链接或插入原素材；本地路径无法直接读取`);
          const hint = `${headers[sourceCol]} ${cellText(row, headers.indexOf('媒体类型'))}`;
          const mimeType = source.file?.type || mediaMime(sourceUrl) || (/视频|video/i.test(hint) ? 'video/mp4' : 'image/jpeg');
          found++;
          results.push({ templateKey, name: `${sheetName}-${row + 1}-${sourceCol + 1}-${found}`, file: source.file, url: source.file ? undefined : sourceUrl, mimeType,
            subjectFile: subject?.file, subjectUrl: subject?.file ? undefined : subjectUrl || undefined, title, templatePrompt: cellText(row, headers.indexOf('模板提示词')), prompt: cellText(row, headers.indexOf('替换要求')) });
        }
      }
      for (const [assetRole, column, subjectColumn] of [['COVER', '指定封面', '封面主体图片'], ['PREVIEW', '指定预览', '预览主体图片']] as const) {
        const col = headers.indexOf(column);
        const subjectIndex = headers.indexOf(subjectColumn);
        const values = [...(embedded.get(`${row}:${col}`) ?? []), ...(cellText(row, col) ? [{ url: cellText(row, col) }] : [])];
        if (values.length > 1) throw new Error(`${sheetName} 第 ${row + 1} 行：${column}只能指定一条素材`);
        const display = values[0];
        const subjectValues = [...(embedded.get(`${row}:${subjectIndex}`) ?? []), ...(cellText(row, subjectIndex) ? [{ url: cellText(row, subjectIndex) }] : [])];
        if (subjectValues.length > 1) throw new Error(`${sheetName} 第 ${row + 1} 行：${subjectColumn}只能指定一张图片`);
        const displaySubject = subjectValues[0];
        if (!display) {
          if (displaySubject) throw new Error(`${sheetName} 第 ${row + 1} 行：配置${subjectColumn}前请先配置${column}`);
          continue;
        }
        if (display.url && !/^https?:\/\//i.test(display.url)) throw new Error(`${column}链接无效`);
        if (displaySubject?.url && !/^https?:\/\//i.test(displaySubject.url)) throw new Error(`${subjectColumn}链接无效`);
        if (displaySubject?.file && !displaySubject.file.type.startsWith('image/')) throw new Error(`${subjectColumn}必须是图片`);
        const mimeType = display.file?.type || mediaMime(display.url || '') || (assetRole === 'COVER' ? 'image/jpeg' : 'video/mp4');
        if (assetRole === 'COVER' && !mimeType.startsWith('image/')) throw new Error('指定封面必须是静态图或动态图');
        if (assetRole === 'PREVIEW' && !mimeType.startsWith('video/') && !['image/gif', 'image/webp'].includes(mimeType)) throw new Error('指定预览必须是视频或动态图');
        results.push({ assetRole, templateKey, title, name: `${sheetName}-${row + 1}-${column}`, mimeType, file: display.file, url: display.url,
          subjectFile: displaySubject?.file, subjectUrl: displaySubject?.url });
      }
      if (found > 1) throw new Error(`${sheetName} 第 ${row + 1} 行：每行只允许一条图片或视频原素材，对应一个主体；同模板请分多行填写`);
      if (!found && !results.some(source => source.name.startsWith(`${sheetName}-${row + 1}-`) && source.assetRole)) throw new Error(`${sheetName} 第 ${row + 1} 行：没有图片或视频原素材`);
    }
  }
  if (!results.length) throw new Error('Excel 中没有可导入的素材');
  if (results.length > 500) throw new Error('单次最多导入 500 条素材');
  return results;
}

export type ImportTemplate = { cover?: ImportSource; preview?: ImportSource; key: string; title: string; templatePrompt?: string; assets: ImportSource[] };
export function groupImportSources(sources: ImportSource[]): ImportTemplate[] {
  const groups = new Map<string, ImportTemplate>();
  for (const [index, source] of sources.entries()) {
    const key = source.templateKey || `source-${index}`;
    let group = groups.get(key);
    if (!group) { group = { key, title: source.title || key, assets: [] }; groups.set(key, group); }
    if (source.title && group.title !== key && group.title !== source.title) throw new Error(`模板标识“${key}”对应了不同的模板名称`);
    if (source.title) group.title = source.title;
    if (source.templatePrompt) {
      if (group.templatePrompt && group.templatePrompt !== source.templatePrompt) throw new Error(`模板标识“${key}”对应了不同的模板提示词`);
      group.templatePrompt = source.templatePrompt;
    }
    if (source.assetRole === 'COVER' || source.assetRole === 'PREVIEW') {
      const field = source.assetRole === 'COVER' ? 'cover' : 'preview';
      if (group[field]) throw new Error(`模板“${key}”只能指定一个${field === 'cover' ? '封面' : '预览'}`);
      group[field] = source;
    } else group.assets.push(source);
  }
  return [...groups.values()];
}
