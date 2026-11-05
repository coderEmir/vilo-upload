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
const activeType = ref<'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION'>('COMIC_DRAMA');
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
    [activeType.value === 'COMIC_DRAMA' ? '描述（必填）' : '生成提示词（必填）', 'description'],
    ['封面图链接或图片（必填）', 'coverUrl'], ['标签（逗号分隔）', 'tags'],
    ['状态（DRAFT/PUBLISHED/ARCHIVED）', 'status'], ['启用（是/否）', 'active'], ['付费（是/否）', 'premium'], ['排序权重', 'sortOrder'],
  ];
  const comic = [['目标受众', 'audience'], ['市场评分', 'marketScore'], ['故事背景 JSON', 'storyBackground'], ['剧集序号（必填）', 'episodeNumber'], ['剧集标题（必填）', 'episodeTitle'], ['剧集简介', 'episodeSynopsis'], ['模型编码（必填）', 'modelCode'], ['正向提示词（必填）', 'promptTemplate'], ['负向提示词', 'negativePrompt']];
  const columns = activeType.value === 'COMIC_DRAMA' ? [...common, ...comic] : common;
  const headers = columns.map(([label]) => label);
  const sample: Record<string, unknown> = { title: '示例模板', slug: `example-${activeType.value.toLowerCase()}`, category: '示例分类', description: '在此填写模板描述或生成提示词', coverUrl: 'https://example.com/cover.jpg', tags: '示例,标签', status: 'DRAFT', active: '是', premium: '否', sortOrder: 0 };
  if (activeType.value === 'COMIC_DRAMA') Object.assign(sample, { audience: '', marketScore: 0, storyBackground: '{}', episodeNumber: 1, episodeTitle: '第 1 集', episodeSynopsis: '', modelCode: models.value[0]?.code || '从模型列表选择编码', promptTemplate: '在此填写剧集正向提示词', negativePrompt: '' });
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
  XLSX.writeFile(workbook, `Vilo-${typeLabel.value}-模板导入表.xlsx`);
}
type EmbeddedImage = { row: number; file: File };
function extractEmbeddedImages(buffer: ArrayBuffer): EmbeddedImage[] {
  const files = unzipSync(new Uint8Array(buffer));
  const workbookXml = new TextDecoder().decode(files['xl/workbook.xml'] || new Uint8Array());
  const relsXml = new TextDecoder().decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
  const sheetId = workbookXml.match(/<sheet\b[^>]*r:id="([^"]+)"/i)?.[1];
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
  const sheetPath = normalizePath('', sheetTarget.startsWith('/') ? sheetTarget : `xl/${sheetTarget}`);
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
  for (const anchor of drawingXml.matchAll(/<(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)>/gi)) {
    const row = Number(anchor[0].match(/<(?:xdr:)?from>[\s\S]*?<(?:xdr:)?row>(\d+)<\/(?:xdr:)?row>/i)?.[1]);
    const relId = anchor[0].match(/<(?:a:)?blip\b[^>]*(?:r:embed|embed)="([^"]+)"/i)?.[1];
    const target = relId ? relationshipTarget(drawingRels, relId) : null;
    if (!Number.isFinite(row) || !target) continue;
    const path = normalizePath(drawingPath.slice(0, drawingPath.lastIndexOf('/')), target);
    const bytes = files[path];
    if (!bytes) continue;
    const ext = path.split('.').pop()?.toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
    images.push({ row: row + 1, file: new File([bytes], `excel-cover-${row + 1}.${ext}`, { type: mime }) });
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
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('Excel 中没有可读取的工作表');
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
    if (!rows.length) throw new Error('Excel 中没有数据行');
    const columnTemplate = workbookTemplate();
    const headerToKey = new Map(columnTemplate.headers.map((label, index) => [label, columnTemplate.columns[index][1] as string]));
    const mapped = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [headerToKey.get(key.trim()) || key.trim().replace(/（必填）/g, ''), value])));
    const embedded = extractEmbeddedImages(buffer);
    let created = 0;
    const failures: string[] = [];
    for (let index = 0; index < mapped.length; index++) {
      const row = mapped[index];
      const excelRow = index + 2;
      try {
        let coverUrl = nonEmpty(row.coverUrl);
        const image = embedded.find((item) => item.row === excelRow);
        if (!coverUrl && image) coverUrl = await uploadAssetFile(image.file);
        if (!coverUrl) throw new Error('封面图链接或图片必填');
        const title = nonEmpty(row.title), slug = nonEmpty(row.slug), category = nonEmpty(row.category), description = nonEmpty(row.description);
        if (!title || !slug || !category || !description) throw new Error('模板名称、唯一标识、分类、描述/生成提示词均必填');
        const tags = nonEmpty(row.tags).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        const booleanValue = (value: unknown, fallback: boolean) => value === '' || value === undefined ? fallback : ['是', 'true', '1', 'yes', 'y'].includes(nonEmpty(value).toLowerCase());
        const episodes: Episode[] = [];
        if (activeType.value === 'COMIC_DRAMA') {
          const episodeNumber = Number(row.episodeNumber), episodeTitle = nonEmpty(row.episodeTitle);
          const modelCode = nonEmpty(row.modelCode), promptTemplate = nonEmpty(row.promptTemplate);
          if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || !episodeTitle || !modelCode || !promptTemplate || !models.value.some((model) => model.code === modelCode)) throw new Error('剧集序号、剧集标题、可选模型编码和正向提示词均必填');
          episodes.push({ ...emptyEpisode(episodeNumber), number: episodeNumber, title: episodeTitle, synopsis: nonEmpty(row.episodeSynopsis), modelCode, promptTemplate, negativePrompt: nonEmpty(row.negativePrompt), parameters: {} });
        }
        const payload = { slug, title, type: activeType.value, category, genreId: null, description, storyBackground: activeType.value === 'COMIC_DRAMA' && nonEmpty(row.storyBackground) ? JSON.parse(nonEmpty(row.storyBackground)) : {}, coverUrl, tags, audience: nonEmpty(row.audience) || null, marketScore: Number(row.marketScore) || 0, sourceMeta: null, status: ['PUBLISHED', 'ARCHIVED'].includes(nonEmpty(row.status).toUpperCase()) ? nonEmpty(row.status).toUpperCase() : 'DRAFT', premium: booleanValue(row.premium, false), active: booleanValue(row.active, true), sortOrder: Number(row.sortOrder) || 0, publishedAt: new Date().toISOString(), episodes };
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
function assetUrl(asset: unknown): string { return asset && typeof asset === 'object' && 'url' in asset ? String((asset as { url?: unknown }).url || '') : ''; }
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
      .filter((param) => param.key !== 'duration')
      .filter((param) => Object.prototype.hasOwnProperty.call(existing, param.key) || param.defaultValue !== null || param.options.some((option) => option.isDefault))
      .map((param) => [param.key, Object.prototype.hasOwnProperty.call(existing, param.key) ? existing[param.key] : defaultParamValue(param)]));
  }
}
function emptyEpisode(number: number): Episode {
  const model = models.value[0];
  return { number, title: `第 ${number} 集`, synopsis: '', storyBeat: null, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, mediaAssets: [], referenceAssets: [], agents: [], promptTemplate: '', negativePrompt: '', defaultParams: {}, premium: false, active: true, modelCode: model?.code || '', parameters: Object.fromEntries((model?.params || []).map((param) => [param.key, defaultParamValue(param)])) };
}
function createTemplate() {
  if (!models.value.length) { error.value = '数据库中没有可选模型'; return; }
  const id = `new-${Date.now()}`;
  draft.value = { id, slug: '', title: '', type: 'COMIC_DRAMA', category: '', genreId: null, description: '', storyBackground: {}, coverUrl: '', tags: [], audience: null, marketScore: 0, sourceMeta: null, status: 'DRAFT', premium: false, active: true, sortOrder: 0, publishedAt: null, episodes: [emptyEpisode(1)] };
  selectedId.value = id;
  isCreating.value = true;
  activeEpisode.value = 0;
}
function selectType(type: 'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION') {
  activeType.value = type;
  draft.value = null;
  selectedId.value = '';
  isCreating.value = false;
}
function selectCreateType(type: 'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION') {
  if (!draft.value || !isCreating.value) return;
  draft.value.type = type;
  draft.value.episodes = type === 'COMIC_DRAMA' ? [emptyEpisode(1)] : [];
  activeEpisode.value = 0;
}
function changeModel(code: string) {
  const episode = currentEpisode.value;
  const model = models.value.find((item) => item.code === code);
  if (!episode || !model) return;
  episode.modelCode = code;
  episode.parameters = Object.fromEntries(model.params.map((param) => [param.key, defaultParamValue(param)]));
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
    sanitized.episodes = sanitized.episodes.map((episode: Episode) => ({ ...episode, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, parameters: Object.fromEntries(Object.entries(episode.parameters || {}).filter(([key]) => key !== 'duration')) }));
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
function parseJsonField(event: Event, assign: (value: unknown) => void) {
  try { assign(JSON.parse((event.target as HTMLTextAreaElement).value)); error.value = ''; }
  catch { error.value = '请输入有效 JSON'; }
}
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
          <div class="type-tabs" role="tablist"><button :class="{ active: activeType === 'COMIC_DRAMA' }" @click="selectType('COMIC_DRAMA')">漫剧</button><button :class="{ active: activeType === 'SHORT_VIDEO' }" @click="selectType('SHORT_VIDEO')">视频</button><button :class="{ active: activeType === 'IMAGE_GENERATION' }" @click="selectType('IMAGE_GENERATION')">图片</button></div>
          <div class="catalog-header"><span>{{ activeType === 'COMIC_DRAMA' ? '漫剧' : activeType === 'SHORT_VIDEO' ? '视频' : '图片' }}模板</span><span class="count">{{ visibleTemplates.length }}</span></div>
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
          <div v-if="isCreating" class="create-type-tabs" role="tablist" aria-label="选择新建模板类型"><button :class="{ active: draft.type === 'COMIC_DRAMA' }" @click="selectCreateType('COMIC_DRAMA')">漫剧模板</button><button :class="{ active: draft.type === 'SHORT_VIDEO' }" @click="selectCreateType('SHORT_VIDEO')">视频模板</button><button :class="{ active: draft.type === 'IMAGE_GENERATION' }" @click="selectCreateType('IMAGE_GENERATION')">图片模板</button></div>
          <div class="tabbar"><button class="tab active">{{ draft.type === 'COMIC_DRAMA' ? '漫剧模板信息' : draft.type === 'SHORT_VIDEO' ? '视频模板信息' : '图片模板信息' }}</button><template v-if="isComicDrama"><span class="divider"></span><button class="tab active">剧集配置</button></template><span class="spacer"></span><span class="saved-label">{{ draft.status }}</span></div>
          <div class="editor-content">
            <section class="form-section"><div class="section-title"><div><h3>基本信息</h3><p>模板在客户端展示的名称、分类和封面</p></div></div>
              <div class="form-grid"><label>模板名称<input v-model="draft.title" maxlength="200" placeholder="输入模板名称" /></label><label>唯一标识<input v-model="draft.slug" maxlength="160" placeholder="例如: neon-dream" /></label><label>类型><input :value="draft.type === 'COMIC_DRAMA' ? '漫剧' : draft.type === 'SHORT_VIDEO' ? '视频' : '图片'" readonly /></label><label>分类<input v-model="draft.category" placeholder="例如：科幻 / 爱情" /></label><label class="span-2 asset-field">封面图<div class="asset-drop" @dragover.prevent @drop="handleDrop($event, (url) => draft!.coverUrl = url)" @click="chooseFile((url) => draft!.coverUrl = url)"><img v-if="draft.coverUrl" :src="draft.coverUrl" alt="封面预览" /><span v-else>拖拽图片到这里，或点击上传</span></div><input :value="draft.coverUrl" readonly placeholder="上传完成后显示阿里云链接" /></label><label class="span-2">{{ isComicDrama ? '描述' : '生成提示词' }}<textarea v-model="draft.description" rows="4" :placeholder="isComicDrama ? '模板简介' : '描述希望生成的画面、风格与内容'" /></label><label>状态<select v-model="draft.status"><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已归档</option></select></label><label>标签<input :value="draft.tags.join(', ')" placeholder="逗号分隔" @input="draft.tags = ($event.target as HTMLInputElement).value.split(',').map((tag) => tag.trim()).filter(Boolean)" /></label><label v-if="isComicDrama">目标受众<input v-model="draft.audience" placeholder="可选" /></label><label v-if="isComicDrama">市场评分<input v-model.number="draft.marketScore" type="number" min="0" max="100" step="0.01" /></label></div>
              <div class="switch-row"><label><input v-model="draft.active" type="checkbox" /> 启用模板</label><label><input v-model="draft.premium" type="checkbox" /> 付费模板</label><label>排序权重 <input v-model.number="draft.sortOrder" type="number" class="short-input" /></label></div>
              <details v-if="isComicDrama" class="advanced-fields"><summary>故事背景与来源数据</summary><div class="form-grid"><label>故事背景 JSON<textarea :value="JSON.stringify(draft.storyBackground, null, 2)" rows="5" @change="parseJsonField($event, (value) => { draft!.storyBackground = value; })"></textarea></label><label>来源元数据 JSON<textarea :value="JSON.stringify(draft.sourceMeta, null, 2)" rows="5" @change="parseJsonField($event, (value) => { draft!.sourceMeta = value; })"></textarea></label><label>题材 ID<input v-model="draft.genreId" placeholder="数据库 Genre ID，可留空" /></label></div></details>
            </section>
            <section v-if="isComicDrama" class="form-section episode-section"><div class="section-title"><div><h3>剧集与生成参数</h3><p>为每集选择模型并设置模型所需参数</p></div><button class="secondary" @click="addEpisode">＋ 添加剧集</button></div>
              <div class="episode-tabs"><button v-for="(episode, index) in draft.episodes" :key="index" :class="{ active: activeEpisode === index }" @click="activeEpisode = index">EP {{ String(index + 1).padStart(2, '0') }}</button><button class="add-tab" title="移除当前剧集" @click="removeEpisode">−</button></div>
              <template v-if="currentEpisode">
                <div class="form-grid episode-grid"><label>剧集序号<input v-model.number="currentEpisode.number" type="number" min="1" max="1000000" /></label><label>剧集标题<input v-model="currentEpisode.title" placeholder="剧集名称" /></label><label>简介<input v-model="currentEpisode.synopsis" placeholder="本集概要" /></label><label>使用模型<select :value="currentEpisode.modelCode" @change="changeModel(($event.target as HTMLSelectElement).value)"><option disabled value="">选择数据库模型</option><option v-for="model in models" :key="model.id" :value="model.code">{{ model.name }} · {{ model.modality }}</option></select></label><span></span><label class="span-2">正向提示词<textarea v-model="currentEpisode.promptTemplate" rows="4" placeholder="输入模板提示词"></textarea></label><label class="span-2">负向提示词<textarea v-model="currentEpisode.negativePrompt" rows="2" placeholder="不希望生成的内容"></textarea></label></div>
                
                <div class="switch-row episode-switches"><label><input v-model="currentEpisode.active" type="checkbox" /> 启用剧集</label><label><input v-model="currentEpisode.premium" type="checkbox" /> 付费剧集</label></div>
                <details class="advanced-fields"><summary>引用素材与高级数据</summary><div class="form-grid"><label class="span-2 asset-field">引用素材（图片/视频）<div class="asset-drop" @dragover.prevent @drop="handleDrop($event, (url) => currentEpisode!.referenceAssets = [...currentEpisode!.referenceAssets, { url, type: url.match(/\.(mp4|mov|webm)(\?|$)/i) ? 'VIDEO' : 'IMAGE' }])" @click="chooseFile((url) => currentEpisode!.referenceAssets = [...currentEpisode!.referenceAssets, { url, type: 'IMAGE' }])">拖拽素材到这里，或点击上传</div><div v-for="(asset, index) in currentEpisode.referenceAssets" :key="index" class="asset-link"><a :href="assetUrl(asset)" target="_blank">{{ assetUrl(asset) }}</a></div></label><label>Agent 配置 JSON<textarea :value="JSON.stringify(currentEpisode.agents, null, 2)" rows="5" @change="parseJsonField($event, (value) => { if (Array.isArray(value)) currentEpisode!.agents = value; else error = 'Agent 配置必须是数组'; })"></textarea></label><label>故事节拍 JSON<textarea :value="JSON.stringify(currentEpisode.storyBeat, null, 2)" rows="5" @change="parseJsonField($event, (value) => { currentEpisode!.storyBeat = value; })"></textarea></label><label class="span-2">默认参数附加数据 JSON<textarea :value="JSON.stringify(currentEpisode.defaultParams, null, 2)" rows="4" @change="parseJsonField($event, (value) => { if (value && typeof value === 'object' && !Array.isArray(value)) currentEpisode!.defaultParams = value as Record<string, unknown>; else error = '默认参数必须是 JSON 对象'; })"></textarea></label></div></details>
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
