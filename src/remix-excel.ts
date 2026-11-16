import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';

export type ImportSource = { keepOriginal?: boolean; templateKey?: string; name: string; file?: File; url?: string; mimeType: string; subjectFile?: File; subjectUrl?: string; title?: string; prompt?: string };
export function mediaMime(name: string): string {
  const ext = name.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();
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
            subjectFile: subject?.file, subjectUrl: subject?.file ? undefined : subjectUrl || undefined, title, prompt: cellText(row, headers.indexOf('替换要求')) });
        }
      }
      if (!found) throw new Error(`${sheetName} 第 ${row + 1} 行：没有图片或视频原素材`);
    }
  }
  if (!results.length) throw new Error('Excel 中没有可导入的素材');
  if (results.length > 500) throw new Error('单次最多导入 500 条素材');
  return results;
}

export type ImportTemplate = { key: string; title: string; assets: ImportSource[]; subjectFile?: File; subjectUrl?: string };
export function groupImportSources(sources: ImportSource[]): ImportTemplate[] {
  const groups = new Map<string, ImportTemplate>();
  for (const [index, source] of sources.entries()) {
    const key = source.templateKey || `source-${index}`;
    let group = groups.get(key);
    if (!group) { group = { key, title: source.title || key, assets: [] }; groups.set(key, group); }
    if (source.title && group.title !== key && group.title !== source.title) throw new Error(`模板标识“${key}”对应了不同的模板名称`);
    if (source.title) group.title = source.title;
    if (!group.subjectFile && !group.subjectUrl && (source.subjectFile || source.subjectUrl)) {
      group.subjectFile = source.subjectFile; group.subjectUrl = source.subjectUrl;
    }
    group.assets.push(source);
  }
  return [...groups.values()];
}
