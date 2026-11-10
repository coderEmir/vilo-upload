<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from 'vue';
import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';

type ModelOption = { value: string; label: string; isDefault: boolean; thumbnail?: string | null };
type ModelParam = { key: string; label: string; description?: string | null; type: string; required: boolean; defaultValue?: string | null; min?: number | null; max?: number | null; unit?: string | null; options: ModelOption[] };
type Model = { id: string; code: string; name: string; modality: string; params: ModelParam[] };
type Episode = { id?: string; number: number; title: string; synopsis: string; storyBeat: unknown; durationSeconds: number | null; minDurationSeconds: number; maxDurationSeconds: number; mediaAssets: unknown[]; referenceAssets: unknown[]; agents: unknown[]; promptTemplate: string; negativePrompt: string | null; defaultParams: Record<string, unknown> | null; premium: boolean; active: boolean; modelCode: string; parameters: Record<string, unknown> };
type Template = { id: string; slug: string; title: string; type: string; category: string; genreId: string | null; description: string; storyBackground: unknown; coverUrl: string; tags: string[]; audience: string | null; marketScore: number; sourceMeta: unknown; status: string; premium: boolean; active: boolean; sortOrder: number; publishedAt: string | null; episodes: Episode[] };
const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3010/api';
const adminKey = ref(localStorage.getItem('templateAdminKey') || '');
const templates = ref<Template[]>([]);
type TemplateType = 'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION';
const activeType = ref<TemplateType>('SHORT_VIDEO');
const isCreating = ref(false);
const models = ref<Model[]>([]);
const selectedId = ref('');
const draft = ref<Template | null>(null);
const activeEpisode = ref(0);
const loading = ref(false);
const notice = ref('');
const error = ref('');
const uploading = ref(false);
const importing = ref(false);
const importInput = ref<HTMLInputElement | null>(null);
const currentEpisode = computed(() => draft.value?.episodes[activeEpisode.value]);
const selectedModel = computed(() => models.value.find((model) => model.code === currentEpisode.value?.modelCode));
const visibleTemplates = computed(() => templates.value.filter((template) => template.type === activeType.value));
const isComicDrama = computed(() => draft.value?.type === 'COMIC_DRAMA' || draft.value?.type === 'MV');
const typeLabel = computed(() => activeType.value === 'COMIC_DRAMA' ? '漫剧' : activeType.value === 'SHORT_VIDEO' ? '视频' : '图片');
const availableModels = computed(() => models.value.filter((model) => activeType.value === 'IMAGE_GENERATION' ? model.modality === 'IMAGE' : model.modality === 'VIDEO'));
const templateControlledParams = computed(() => selectedModel.value?.params.filter(isTemplateControlledParam) || []);
const userControlledParamKeys = new Set(['aspectratio', 'ratio', 'resolution', 'size', 'image', 'imageurl', 'referenceimage', 'referenceimages']);
function canonicalParamKey(key: string): string { return key.replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function isTemplateControlledParam(param: ModelParam): boolean { return !userControlledParamKeys.has(canonicalParamKey(param.key)); }
function hasParamValue(value: unknown): boolean { return value !== undefined && value !== null && value !== ''; }
function modelForType(type: TemplateType): Model | undefined { return models.value.find((model) => type === 'IMAGE_GENERATION' ? model.modality === 'IMAGE' : type === 'SHORT_VIDEO' ? model.modality === 'VIDEO' : true); }
function excelParamKey(key: string): string { return `parameter:${key}`; }
function defaultParamValue(param: ModelParam): unknown {
  const value = param.defaultValue ?? param.options.find((option) => option.isDefault)?.value;
  if (param.type === 'BOOLEAN') return value === 'true';
  if (param.type === 'NUMBER' && value !== undefined && value !== '') return Number(value);
  return value ?? '';
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-template-admin-key': adminKey.value, ...init.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}
async function uploadAsset(file: File, assign: (url: string) => void) {
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { error.value = '仅支持图片或视频文件'; return; }
  uploading.value = true; error.value = '';
  try {
    const response = await fetch(`${apiBase}/templates/assets`, { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'x-template-admin-key': adminKey.value } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `上传失败 (${response.status})`);
    assign(payload.url);
    notice.value = '素材上传完成';
  } catch (e) { error.value = e instanceof Error ? e.message : '素材上传失败'; }
  finally { uploading.value = false; }
}
async function uploadAssetFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(`封面必须是图片文件：${file.name}`);
  const response = await fetch(`${apiBase}/templates/assets`, { method: 'POST', body: file, headers: { 'Content-Type': file.type, 'x-template-admin-key': adminKey.value } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `封面上传失败 (${response.status})`);
  return payload.url as string;
}
function workbookTemplate() {
  const common = [
    ['模板名称（必填）', 'title'], ['唯一标识（必填）', 'slug'], ['分类（必填）', 'category'],
    [activeType.value === 'COMIC_DRAMA' ? '描述（必填）' : '模板描述（必填）', 'description'],
    ['封面图链接（必填，可插入图片）', 'coverUrl'], ['标签（逗号分隔）', 'tags'],
    ['状态（DRAFT/PUBLISHED/ARCHIVED）', 'status'], ['启用（是/否）', 'active'], ['付费（是/否）', 'premium'], ['排序权重', 'sortOrder'],
  ];
  const comic = [['目标受众', 'audience'], ['故事背景 JSON', 'storyBackground'], ['剧集序号（必填）', 'episodeNumber'], ['剧集标题（必填）', 'episodeTitle'], ['剧集简介', 'episodeSynopsis'], ['模型编码（必填）', 'modelCode'], ['正向提示词（必填）', 'promptTemplate'], ['负向提示词', 'negativePrompt']];
  const generation = [['模型编码（必填）', 'modelCode'], ['生成提示词（必填）', 'promptTemplate'], ['负向提示词', 'negativePrompt']];
  const seen = new Set<string>();
  const parameterColumns = availableModels.value.flatMap((model) => model.params.filter((param) => param.required && isTemplateControlledParam(param)))
    .filter((param) => !seen.has(param.key) && seen.add(param.key))
    .map((param) => [`模型参数-${param.label} [${param.key}]（按模型配置必填）`, excelParamKey(param.key)]);
  const columns = activeType.value === 'COMIC_DRAMA' ? [...common, ...comic] : [...common, ...generation, ...parameterColumns];
  const headers = columns.map(([label]) => label);
  const sample: Record<string, unknown> = { title: '', slug: '', category: '', description: '', coverUrl: '', tags: '', status: 'DRAFT', active: '是', premium: '否', sortOrder: 0 };
  const model = modelForType(activeType.value);
  if (activeType.value === 'COMIC_DRAMA') Object.assign(sample, { audience: '', storyBackground: '{}', episodeNumber: 1, episodeTitle: '', episodeSynopsis: '', modelCode: model?.code || '', promptTemplate: '', negativePrompt: '' });
  else {
    Object.assign(sample, { modelCode: model?.code || '', promptTemplate: '', negativePrompt: '' });
    for (const param of model?.params.filter((item) => item.required && isTemplateControlledParam(item)) || []) sample[excelParamKey(param.key)] = defaultParamValue(param);
  }
  return { columns, headers, sample: columns.map(([, key]) => sample[key as string] ?? '') };
}
function downloadExcelTemplate() {
  const template = workbookTemplate();
  const sheet = XLSX.utils.aoa_to_sheet([template.headers, template.sample]);
  sheet['!rows'] = [{ hpt: 32 }, { hpt: 28 }];
  template.headers.forEach((header, index) => {
    const cell = XLSX.utils.encode_cell({ r: 0, c: index });
    sheet[cell].s = { font: { bold: true, color: { rgb: header.includes('（必填）') ? 'C0392B' : '26332B' } }, fill: { fgColor: { rgb: header.includes('（必填）') ? 'FCE9E6' : 'EEF3E7' } }, alignment: { wrapText: true, vertical: 'center' } };
  });
  sheet['!cols'] = template.headers.map(() => ({ wch: 26 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, typeLabel.value);
  const help = XLSX.utils.aoa_to_sheet([
    ['填写说明'],
    [activeType.value === 'COMIC_DRAMA' ? '每行代表一集，slug 相同的行合并为同一漫剧。' : '每行对应一个图片或视频模板。'],
    [activeType.value === 'COMIC_DRAMA' ? '多集漫剧每行填写同一 slug；基本信息可只填写第一行。' : '模型编码决定该行的必填模型参数，导入时严格按后端模型配置校验。'],
    [activeType.value === 'COMIC_DRAMA' ? '漫剧上传入口当前隐藏，但原批量导入能力保留。' : '图片上传、画面比例、分辨率由客户端用户选择，不在模板参数中填写。'],
    ['封面可填写图片 URL，也可在 Excel 中将图片插入对应数据行。若两者同时提供，使用 URL。'],
    ['带“（必填）”的列必须填写。删除此说明工作表不会影响导入；请勿修改或删除首个工作表的标题行。'],
  ]);
  XLSX.utils.book_append_sheet(workbook, help, '填写说明');
  XLSX.writeFile(workbook, `Vilo-${typeLabel.value}-模板导入表.xlsx`);
}
type EmbeddedImage = { row: number; file: File; sheetName: string };
function extractEmbeddedImages(buffer: ArrayBuffer, requestedSheetName: string): EmbeddedImage[] {
  const files = unzipSync(new Uint8Array(buffer));
  const workbookXml = new TextDecoder().decode(files['xl/workbook.xml'] || new Uint8Array());
  const relsXml = new TextDecoder().decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
  const sheetEntry = (workbookXml.match(/<sheet\b[^>]*\/?\s*>/gi) || []).find((tag) => tag.match(/\bname="([^"]+)"/i)?.[1] === requestedSheetName);
  const sheetId = sheetEntry?.match(/\br:id="([^"]+)"/i)?.[1];
  const sheetName = requestedSheetName;
  const relationshipTarget = (xml: string, id: string) => {
    for (const relationship of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
      if (relationship[0].match(/\bId="([^"]+)"/i)?.[1] === id) return relationship[0].match(/\bTarget="([^"]+)"/i)?.[1] || null;
    }
    return null;
  };
  const sheetTarget = sheetId ? relationshipTarget(relsXml, sheetId) : null;
  if (!sheetTarget) return [];
  const normalizePath = (base: string, target: string) => {
    const parts = (target.startsWith('/') ? target.slice(1) : `${base}/${target}`).split('/');
    const normalized: string[] = [];
    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') normalized.pop(); else normalized.push(part); }
    return normalized.join('/');
  };
  const sheetPath = normalizePath('xl', sheetTarget);
  const sheetXml = new TextDecoder().decode(files[sheetPath] || new Uint8Array());
  const drawingRelId = sheetXml.match(/<drawing\b[^>]*r:id="([^"]+)"/i)?.[1];
  const sheetRelPath = sheetPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const sheetRels = new TextDecoder().decode(files[sheetRelPath] || new Uint8Array());
  const drawingTarget = drawingRelId ? relationshipTarget(sheetRels, drawingRelId) : null;
  if (!drawingTarget) return [];
  const drawingPath = normalizePath(sheetPath.slice(0, sheetPath.lastIndexOf('/')), drawingTarget);
  const drawingXml = new TextDecoder().decode(files[drawingPath] || new Uint8Array());
  const drawingRelPath = drawingPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const drawingRels = new TextDecoder().decode(files[drawingRelPath] || new Uint8Array());
  const images: EmbeddedImage[] = [];
  const anchors = drawingXml.match(/<(?:\w+:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:\w+:)?(?:oneCellAnchor|twoCellAnchor)>/gi) || [];
  for (const anchor of anchors) {
    const row = Number(anchor.match(/<(?:\w+:)?from\b[^>]*>[\s\S]*?<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/i)?.[1]);
    const relId = anchor.match(/<(?:\w+:)?blip\b[^>]*(?:r:embed|embed)="([^"]+)"/i)?.[1];
    const target = relId ? relationshipTarget(drawingRels, relId) : null;
    if (!Number.isFinite(row) || !target) continue;
    const path = normalizePath(drawingPath.slice(0, drawingPath.lastIndexOf('/')), target);
    const bytes = files[path];
    if (!bytes) continue;
    const ext = path.split('.').pop()?.toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
    images.push({ row: row + 1, file: new File([bytes], `excel-cover-${row + 1}.${ext}`, { type: mime }), sheetName });
  }
  return images;
}
function nonEmpty(value: unknown): string { return value === undefined || value === null ? '' : String(value).trim(); }
async function importExcel(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  importing.value = true; loading.value = true; error.value = ''; notice.value = '';
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
    const sheetName = workbook.SheetNames.find((name) => !['填写说明', '说明'].includes(name)) || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error('Excel 中没有可读取的工作表');
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: false });
    const headers = (matrix[0] || []).map((header) => nonEmpty(header));
    const dataRows = matrix.slice(1);
    if (!headers.length || !dataRows.length) throw new Error('Excel 中没有标题行或数据行');
    const columnTemplate = workbookTemplate();
    const normalized = (value: string) => value.trim().replace(/\s/g, '').replace(/[（(]必填[）)]/g, '').replace(/[：:]/g, '').toLowerCase();
    const headerToKey = new Map(columnTemplate.headers.map((label, index) => [normalized(label), columnTemplate.columns[index][1] as string]));
    const aliases: Record<string, string> = { 封面图: 'coverUrl', 封面图片: 'coverUrl', 封面图链接: 'coverUrl', 封面链接: 'coverUrl', 提示词: activeType.value === 'COMIC_DRAMA' ? 'description' : 'promptTemplate', 生成提示词: 'promptTemplate', 模板描述: 'description', 模板名称: 'title', 模板标题: 'title', 唯一标识: 'slug', slug: 'slug', 分类: 'category', 标签: 'tags', 剧集序号: 'episodeNumber', 剧集标题: 'episodeTitle', 模型编码: 'modelCode', 正向提示词: 'promptTemplate', 负向提示词: 'negativePrompt' };
    const keys = headers.map((header) => headerToKey.get(normalized(header)) || aliases[normalized(header)] || '');
    const missingHeaders = columnTemplate.headers.filter((label) => label.includes('（必填）') && !keys.includes(columnTemplate.columns[columnTemplate.headers.indexOf(label)][1] as string));
    if (missingHeaders.length) throw new Error(`缺少必填列：${missingHeaders.join('、')}`);
    const mapped = dataRows.map((cells) => Object.fromEntries(keys.flatMap((key, index) => key ? [[key, cells[index] ?? '']] : [])));
    const embedded = extractEmbeddedImages(buffer, sheetName);
    let created = 0;
    const failures: string[] = [];
    const imageRows = embedded.filter((image) => image.sheetName === sheetName);
    const importRows = mapped.map((row, index) => ({ row, excelRow: index + 2 })).filter(({ row, excelRow }) => {
      const hasValues = Object.values(row).some((value) => nonEmpty(value));
      const hasImage = imageRows.some((image) => image.row === excelRow);
      if (activeType.value === 'COMIC_DRAMA' && !hasValues && !hasImage) return false;
      return hasValues || hasImage;
    });
    const groups = new Map<string, { row: Record<string, unknown>; excelRow: number; episodes: Array<{ row: Record<string, unknown>; excelRow: number }> }>();
    for (const item of importRows) {
      if (activeType.value !== 'COMIC_DRAMA') { groups.set(`row-${item.excelRow}`, { ...item, episodes: [] }); continue; }
      const slug = nonEmpty(item.row.slug);
      if (!slug) { failures.push(`第 ${item.excelRow} 行：漫剧每一集行都必须填写同一个模板唯一标识`); continue; }
      let group = groups.get(slug);
      if (!group) { group = { ...item, episodes: [] }; groups.set(slug, group); }
      else {
        const merged = { ...group.row };
        for (const [key, value] of Object.entries(item.row)) if (!nonEmpty(merged[key]) && nonEmpty(value)) merged[key] = value;
        group.row = merged;
      }
      group.episodes.push(item);
    }
    for (const group of groups.values()) {
      const row = group.row;
      const excelRow = group.excelRow;
      try {
        let coverUrl = nonEmpty(row.coverUrl);
        if (coverUrl && !/^https?:\/\//i.test(coverUrl)) throw new Error('封面图列仅接受 http/https 图片链接；也可以留空并插入该行的图片');
        const image = imageRows.find((item) => item.row === excelRow) || group.episodes.map((episode) => imageRows.find((item) => item.row === episode.excelRow)).find(Boolean);
        if (!coverUrl && image) coverUrl = await uploadAssetFile(image.file);
        if (!coverUrl) throw new Error('封面图链接或图片必填');
        const title = nonEmpty(row.title), slug = nonEmpty(row.slug), category = nonEmpty(row.category), description = nonEmpty(row.description);
        if (!title || !slug || !category || !description) throw new Error('模板名称、唯一标识、分类、描述/生成提示词均必填');
        const tags = nonEmpty(row.tags).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        const booleanValue = (value: unknown, fallback: boolean) => value === '' || value === undefined ? fallback : ['是', 'true', '1', 'yes', 'y'].includes(nonEmpty(value).toLowerCase());
        const episodes: Episode[] = [];
        if (activeType.value === 'COMIC_DRAMA') {
          if (new Set(group.episodes.map((episode) => Number(episode.row.episodeNumber))).size !== group.episodes.length) throw new Error('同一模板的剧集序号不能重复');
          for (const episodeRow of group.episodes) {
            const episodeNumber = Number(episodeRow.row.episodeNumber), episodeTitle = nonEmpty(episodeRow.row.episodeTitle);
            const modelCode = nonEmpty(episodeRow.row.modelCode), promptTemplate = nonEmpty(episodeRow.row.promptTemplate);
            const model = models.value.find((item) => item.code === modelCode);
            if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || !episodeTitle || !model || !promptTemplate) throw new Error(`第 ${episodeRow.excelRow} 行：剧集序号、标题、可选模型编码和正向提示词必填`);
            const parameters = Object.fromEntries(model.params.map((param) => [param.key, defaultParamValue(param)]));
            const missingParams = model.params.filter((param) => param.required && !hasParamValue(parameters[param.key]));
            if (missingParams.length) throw new Error(`第 ${episodeRow.excelRow} 行：模型「${model.name}」缺少必填参数默认值（${missingParams.map((param) => param.label).join('、')}），请先在模型配置中设置默认值`);
            episodes.push({ ...emptyEpisode(episodeNumber, model), number: episodeNumber, title: episodeTitle, synopsis: nonEmpty(episodeRow.row.episodeSynopsis), modelCode, promptTemplate, negativePrompt: nonEmpty(episodeRow.row.negativePrompt), parameters });
          }
        } else {
          const modelCode = nonEmpty(row.modelCode), promptTemplate = nonEmpty(row.promptTemplate);
          const model = availableModels.value.find((item) => item.code === modelCode);
          if (!model || !promptTemplate) throw new Error('可选模型编码和生成提示词必填');
          const parameters = Object.fromEntries(model.params.filter(isTemplateControlledParam).map((param) => {
            const imported = row[excelParamKey(param.key)];
            const value = hasParamValue(imported) ? imported : defaultParamValue(param);
            if (param.type === 'NUMBER') return [param.key, Number(value)];
            if (param.type === 'BOOLEAN') return [param.key, ['是', 'true', '1', 'yes', 'y'].includes(nonEmpty(value).toLowerCase())];
            return [param.key, value];
          }));
          const missingParams = model.params.filter((param) => param.required && isTemplateControlledParam(param) && !hasParamValue(parameters[param.key]));
          if (missingParams.length) throw new Error(`模型「${model.name}」缺少必填参数：${missingParams.map((param) => param.label).join('、')}`);
          episodes.push({ ...emptyEpisode(1, model), title, synopsis: description, modelCode, promptTemplate, negativePrompt: nonEmpty(row.negativePrompt), parameters });
        }
        const sortOrder = Number(row.sortOrder) || 0;
        if (!Number.isInteger(sortOrder)) throw new Error('排序权重必须为整数');
        const status = nonEmpty(row.status).toUpperCase() || 'DRAFT';
        if (!['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) throw new Error('状态仅支持 DRAFT、PUBLISHED、ARCHIVED');
        const payload = { slug, title, type: activeType.value, category, genreId: null, description, storyBackground: activeType.value === 'COMIC_DRAMA' && nonEmpty(row.storyBackground) ? JSON.parse(nonEmpty(row.storyBackground)) : {}, coverUrl, tags, audience: activeType.value === 'COMIC_DRAMA' ? nonEmpty(row.audience) || null : null, sourceMeta: null, status, premium: booleanValue(row.premium, false), active: booleanValue(row.active, true), sortOrder, publishedAt: new Date().toISOString(), episodes };
        await request('/templates', { method: 'POST', body: JSON.stringify(payload) });
        created++;
      } catch (e) { failures.push(`第 ${excelRow} 行：${e instanceof Error ? e.message : '导入失败'}`); }
    }
    await load();
    if (failures.length) {
      error.value = `已导入 ${created} 行，${failures.length} 行失败：${failures.join('；')}`;
      if (created) notice.value = `成功创建 ${created} 个${typeLabel.value}模板`;
    } else notice.value = `成功创建 ${created} 个${typeLabel.value}模板`;
  } catch (e) { error.value = e instanceof Error ? e.message : 'Excel 导入失败'; }
  finally { importing.value = false; loading.value = false; }
}
function handleDrop(event: DragEvent, assign: (url: string) => void) {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void uploadAsset(file, assign);
}
function chooseFile(assign: (url: string) => void) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*,video/*';
  input.onchange = () => { const file = input.files?.[0]; if (file) void uploadAsset(file, assign); };
  input.click();
}
async function load() {
  loading.value = true; error.value = '';
  try {
    const data = await request('/templates');
    templates.value = data.templates;
    models.value = data.models;
    if (selectedId.value) selectTemplateById(selectedId.value);
  } catch (e) { error.value = e instanceof Error ? e.message : '加载失败'; }
  finally { loading.value = false; }
}
function selectTemplateById(id: string) {
  const found = templates.value.find((item) => String(item.id) === String(id));
  if (!found) return;
  selectedId.value = found.id;
  draft.value = structuredClone(toRaw(found));
  normalizeEpisodeModels();
  if (draft.value.publishedAt) {
    const date = new Date(draft.value.publishedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    draft.value.publishedAt = local.toISOString().slice(0, 16);
  }
  activeEpisode.value = 0;
}
function openTemplate(template: Template) {
  isCreating.value = false;
  selectedId.value = template.id;
  draft.value = structuredClone(toRaw(template));
  normalizeEpisodeModels();
  if (draft.value.publishedAt) {
    const date = new Date(draft.value.publishedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    draft.value.publishedAt = local.toISOString().slice(0, 16);
  }
  activeEpisode.value = 0;
}
function normalizeEpisodeModels() {
  if (!draft.value || !models.value.length) return;
  if (draft.value.type === 'SHORT_VIDEO' || draft.value.type === 'IMAGE_GENERATION') {
    activeType.value = draft.value.type;
    if (!draft.value.episodes.length) draft.value.episodes = [emptyEpisode(1, modelForType(draft.value.type))];
  }
  for (const episode of draft.value.episodes) {
    let model = models.value.find((item) => item.code === episode.modelCode);
    if (!model) {
      model = models.value.find((item) =>
      draft.value?.type === 'IMAGE_GENERATION' ? item.modality === 'IMAGE' : draft.value?.type === 'SHORT_VIDEO' ? item.modality === 'VIDEO' : true,
      ) || models.value[0];
      episode.modelCode = model.code;
    }
    const existing = episode.parameters || {};
    episode.parameters = Object.fromEntries(model.params
      .filter((param) => isComicDrama.value || isTemplateControlledParam(param))
      .filter((param) => Object.prototype.hasOwnProperty.call(existing, param.key) || param.defaultValue !== null || param.options.some((option) => option.isDefault))
      .map((param) => [param.key, Object.prototype.hasOwnProperty.call(existing, param.key) ? existing[param.key] : defaultParamValue(param)]));
  }
}
function emptyEpisode(number: number, selected?: Model): Episode {
  const model = selected || modelForType(activeType.value);
  const comic = activeType.value === 'COMIC_DRAMA';
  return { number, title: comic ? `第 ${number} 集` : '模板生成', synopsis: '', storyBeat: null, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, mediaAssets: [], referenceAssets: [], agents: [], promptTemplate: '', negativePrompt: '', defaultParams: {}, premium: false, active: true, modelCode: model?.code || '', parameters: Object.fromEntries((model?.params || []).filter((param) => comic || isTemplateControlledParam(param)).map((param) => [param.key, defaultParamValue(param)])) };
}
function createTemplate() {
  if (!models.value.length) { error.value = '数据库中没有可选模型'; return; }
  const id = `new-${Date.now()}`;
  draft.value = { id, slug: '', title: '', type: activeType.value, category: '', genreId: null, description: '', storyBackground: {}, coverUrl: '', tags: [], audience: null, marketScore: 0, sourceMeta: null, status: 'DRAFT', premium: false, active: true, sortOrder: 0, publishedAt: null, episodes: [emptyEpisode(1)] };
  selectedId.value = id;
  isCreating.value = true;
  activeEpisode.value = 0;
}
function selectType(type: TemplateType) {
  activeType.value = type;
  draft.value = null;
  selectedId.value = '';
  isCreating.value = false;
}
function selectCreateType(type: TemplateType) {
  if (!draft.value || !isCreating.value) return;
  draft.value.type = type;
  activeType.value = type;
  draft.value.episodes = [emptyEpisode(1, modelForType(type))];
  activeEpisode.value = 0;
}
function changeModel(code: string) {
  const episode = currentEpisode.value;
  const model = models.value.find((item) => item.code === code);
  if (!episode || !model) return;
  episode.modelCode = code;
  episode.parameters = Object.fromEntries(model.params.filter((param) => isComicDrama.value || isTemplateControlledParam(param)).map((param) => [param.key, defaultParamValue(param)]));
}
function addEpisode() {
  if (!draft.value) return;
  const number = Math.max(0, ...draft.value.episodes.map((episode) => episode.number)) + 1;
  draft.value.episodes.push(emptyEpisode(number));
  activeEpisode.value = draft.value.episodes.length - 1;
}
function removeEpisode() {
  if (!draft.value || draft.value.episodes.length <= 1) return;
  draft.value.episodes.splice(activeEpisode.value, 1);
  activeEpisode.value = Math.max(0, activeEpisode.value - 1);
}
async function save() {
  if (!draft.value) return;
  loading.value = true; error.value = ''; notice.value = '';
  try {
    const sanitized = structuredClone(toRaw(draft.value));
    if (sanitized.type === 'COMIC_DRAMA' || sanitized.type === 'MV') {
      sanitized.episodes = sanitized.episodes.map((item: Episode) => ({ ...item, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, parameters: Object.fromEntries(Object.entries(item.parameters || {}).filter(([key]) => models.value.find((model) => model.code === item.modelCode)?.params.some((param) => param.key === key))) }));
    } else {
      const episode = sanitized.episodes[0];
      const model = models.value.find((item) => item.code === episode?.modelCode);
      if (!episode || !model) throw new Error('请选择与模板类型匹配的模型');
      if (!episode.promptTemplate.trim()) throw new Error('生成提示词必填');
      const missingParams = model.params.filter((param) => param.required && isTemplateControlledParam(param) && !hasParamValue(episode.parameters[param.key]));
      if (missingParams.length) throw new Error(`请填写模型必填参数：${missingParams.map((param) => param.label).join('、')}`);
      sanitized.episodes = sanitized.episodes.map((item: Episode) => ({ ...item, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, parameters: Object.fromEntries(Object.entries(item.parameters || {}).filter(([key]) => model.params.some((param) => param.key === key && isTemplateControlledParam(param)))) }));
    }
    const { id, episodes, ...fields } = sanitized;
    const isNewTemplate = id.startsWith('new-');
    const payload = {
      ...fields,
      publishedAt: isNewTemplate
        ? new Date().toISOString()
        : fields.publishedAt ? new Date(fields.publishedAt).toISOString() : null,
      episodes,
    };
    const result = isNewTemplate
      ? await request('/templates', { method: 'POST', body: JSON.stringify(payload) })
      : await request(`/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await load();
    if (result?.template?.id) selectTemplateById(result.template.id);
    isCreating.value = false;
    notice.value = '模板已保存';
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败'; }
  finally { loading.value = false; }
}
async function removeTemplate() {
  if (!draft.value || draft.value.id.startsWith('new-')) { draft.value = null; selectedId.value = ''; return; }
  if (!window.confirm(`确定删除「${draft.value.title}」吗？`)) return;
  loading.value = true; error.value = '';
  try { await request(`/templates/${encodeURIComponent(draft.value.id)}`, { method: 'DELETE' }); draft.value = null; selectedId.value = ''; await load(); notice.value = '模板已删除'; }
  catch (e) { error.value = e instanceof Error ? e.message : '删除失败'; }
  finally { loading.value = false; }
}
function saveKey() { localStorage.setItem('templateAdminKey', adminKey.value); void load(); }
onMounted(() => { void load(); });
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="#"><span class="brand-mark">V</span><span>VILO <small>STUDIO</small></span></a>
      <div class="top-actions"><span class="connection"><i></i> TEMPLATE CATALOG</span><button class="icon-button" title="重新加载" aria-label="重新加载" @click="load">↻</button></div>
    </header>
    <main>
      <div class="page-heading"><div><p class="eyebrow">CONTENT OPERATIONS / 01</p><h1>模板管理</h1><p class="subheading">管理创作模板、参考素材与生成模型配置</p></div><button class="primary" @click="createTemplate">＋ 新建模板</button></div>
      <div v-if="error" class="banner error">{{ error }} <button @click="error = ''">关闭</button></div>
      <div v-if="notice" class="banner success">{{ notice }}</div>
      <div class="workspace">
        <aside class="catalog">
          <div class="type-tabs" role="tablist"><button :class="{ active: activeType === 'SHORT_VIDEO' }" @click="selectType('SHORT_VIDEO')">视频</button><button :class="{ active: activeType === 'IMAGE_GENERATION' }" @click="selectType('IMAGE_GENERATION')">图片</button></div>
          <div class="catalog-header"><span>{{ activeType === 'SHORT_VIDEO' ? '视频' : '图片' }}模板</span><span class="count">{{ visibleTemplates.length }}</span></div>
          <div class="excel-actions"><button type="button" class="secondary" @click="downloadExcelTemplate">下载 Excel 模板</button><button type="button" class="secondary" :disabled="importing" @click="importInput?.click()">{{ importing ? '正在导入…' : '导入 Excel' }}</button><input ref="importInput" type="file" accept=".xlsx,.xls" hidden @change="importExcel" /></div>
          <div class="search-row"><span>⌕</span><input placeholder="搜索模板" /></div>
          <div v-if="!visibleTemplates.length" class="empty-list">{{ loading ? '正在加载…' : '暂无模板' }}</div>
          <button v-for="item in visibleTemplates" :key="item.id" type="button" class="template-row" :class="{ selected: selectedId === item.id }" @click="openTemplate(item)">
            <img :src="item.coverUrl || 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=300'" alt="" />
            <span class="row-copy"><strong>{{ item.title }}</strong><small>{{ item.category || '未分类' }}<template v-if="item.type === 'COMIC_DRAMA' || item.type === 'MV'"> · {{ item.episodes.length }} 集</template></small></span>
            <span class="status-dot" :class="item.status.toLowerCase()" :title="item.status"></span>
          </button>
        </aside>
        <section v-if="draft" class="editor">
          <div class="editor-head"><div><div class="breadcrumbs">模板库 <span>/</span> {{ draft.id.startsWith('new-') ? '新建模板' : draft.slug }}</div><h2>{{ draft.title || '未命名模板' }}</h2></div><div class="editor-actions"><button class="danger-quiet" @click="removeTemplate">删除</button><button class="primary" :disabled="loading" @click="save">{{ loading ? '保存中…' : '保存更改' }}</button></div></div>
          <div v-if="isCreating" class="create-type-tabs" role="tablist" aria-label="选择新建模板类型"><button :class="{ active: draft.type === 'SHORT_VIDEO' }" @click="selectCreateType('SHORT_VIDEO')">视频模板</button><button :class="{ active: draft.type === 'IMAGE_GENERATION' }" @click="selectCreateType('IMAGE_GENERATION')">图片模板</button></div>
          <div class="tabbar"><button class="tab active">{{ draft.type === 'SHORT_VIDEO' ? '视频模板信息' : '图片模板信息' }}</button><span class="spacer"></span><span class="saved-label">{{ draft.status }}</span></div>
          <div class="editor-content">
            <section class="form-section"><div class="section-title"><div><h3>基本信息</h3><p>模板在客户端展示的名称、分类和封面</p></div></div>
              <div class="form-grid"><label>模板名称<input v-model="draft.title" maxlength="200" placeholder="输入模板名称" /></label><label>唯一标识<input v-model="draft.slug" maxlength="160" placeholder="例如: neon-dream" /></label><label>类型<input :value="draft.type === 'SHORT_VIDEO' ? '视频' : '图片'" readonly /></label><label>分类<input v-model="draft.category" placeholder="例如：科幻 / 爱情" /></label><label class="span-2 asset-field">封面图<div class="asset-drop" @dragover.prevent @drop="handleDrop($event, (url) => draft!.coverUrl = url)" @click="chooseFile((url) => draft!.coverUrl = url)"><img v-if="draft.coverUrl" :src="draft.coverUrl" alt="封面预览" /><span v-else>拖拽图片到这里，或点击上传</span></div><input :value="draft.coverUrl" readonly placeholder="上传完成后显示阿里云链接" /></label><label class="span-2">模板描述<textarea v-model="draft.description" rows="3" placeholder="用于模板目录展示的简介" /></label><label>状态<select v-model="draft.status"><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已归档</option></select></label><label>标签<input :value="draft.tags.join(', ')" placeholder="逗号分隔" @input="draft.tags = ($event.target as HTMLInputElement).value.split(',').map((tag) => tag.trim()).filter(Boolean)" /></label></div>
              <div class="switch-row"><label><input v-model="draft.active" type="checkbox" /> 启用模板</label><label><input v-model="draft.premium" type="checkbox" /> 付费模板</label><label>排序权重 <input v-model.number="draft.sortOrder" type="number" class="short-input" /></label></div>
            </section>
            <section class="form-section episode-section"><div class="section-title"><div><h3>生成配置</h3><p>图片上传、画面比例和分辨率由客户端用户选择；其余必填参数由模板固定</p></div></div>
              <template v-if="currentEpisode">
                <div class="form-grid episode-grid"><label>使用模型<select :value="currentEpisode.modelCode" @change="changeModel(($event.target as HTMLSelectElement).value)"><option disabled value="">选择数据库模型</option><option v-for="model in availableModels" :key="model.id" :value="model.code">{{ model.name }}</option></select></label><span></span><label class="span-2">生成提示词 <em class="required-mark">必填</em><textarea v-model="currentEpisode.promptTemplate" rows="4" placeholder="输入客户端生成时使用的模板提示词"></textarea></label><label class="span-2">负向提示词<textarea v-model="currentEpisode.negativePrompt" rows="2" placeholder="不希望生成的内容"></textarea></label></div>
                <div class="params-block"><div class="params-heading"><div><h4>模板控制的模型参数</h4><span>只展示当前模型除图片、画面比例、分辨率以外的参数</span></div><span class="param-count">{{ templateControlledParams.length }}</span></div><div v-for="param in templateControlledParams" :key="param.key" class="param-row"><div class="param-meta"><strong>{{ param.label }}</strong><em v-if="param.required">必填</em><code>{{ param.key }}</code><small v-if="param.description">{{ param.description }}</small></div><select v-if="param.type === 'SELECT'" v-model="currentEpisode.parameters[param.key]"><option disabled value="">请选择</option><option v-for="option in param.options" :key="option.value" :value="option.value">{{ option.label }}</option></select><select v-else-if="param.type === 'BOOLEAN'" v-model="currentEpisode.parameters[param.key]"><option :value="true">是</option><option :value="false">否</option></select><input v-else-if="param.type === 'NUMBER'" v-model.number="currentEpisode.parameters[param.key]" type="number" :min="param.min ?? undefined" :max="param.max ?? undefined" :placeholder="param.required ? '必填' : '可选'" /><input v-else v-model="currentEpisode.parameters[param.key]" :placeholder="param.required ? '必填' : '可选'" /></div><div v-if="!templateControlledParams.length" class="empty-params">当前模型没有需要由模板配置的参数。</div></div>
              </template>
            </section>
          </div>
        </section>
        <section v-else class="welcome"><div class="welcome-mark">V</div><h2>模板工作台</h2><p>从模板目录选择一项进行编辑，或创建新模板。</p><button class="primary" @click="createTemplate">＋ 新建模板</button></section>
      </div>
    </main>
    <footer><span>VILO STUDIO <i></i> CONTENT SYSTEM</span><label>API 管理密钥 <input v-model="adminKey" type="password" autocomplete="off" placeholder="输入管理密钥" @change="saveKey" /></label><span>API {{ apiBase }}</span></footer>
  </div>
</template>
