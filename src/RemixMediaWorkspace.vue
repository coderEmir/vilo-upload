<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as XLSX from 'xlsx';
import { readRemixExcel, groupImportSources, mediaMime, type ImportSource, type ImportTemplate } from './remix-excel';
import RemixAssetInputs from './RemixAssetInputs.vue';
import { readApiResponse } from './api-response';

type Param = { label?: string; key: string; type: string; required: boolean; defaultValue: string | null; options: Array<{ value: string; isDefault: boolean }> };
type Model = { id: string; code: string; name: string; modality: 'IMAGE' | 'VIDEO'; params: Param[] };
type Asset = { url: string; mimeType: string; name?: string; sizeBytes?: number };
type Attempt = { id: string; status: string; resultAsset?: Asset & { provider?: string }; providerError?: { code?: string; message?: string }; sequence: number };
type Item = { id: string; sourceKey: string; templateDraft: { slug: string; title: string }; mediaType: 'IMAGE' | 'VIDEO'; sourceAsset: Asset & { subjectAssets?: Asset[]; assetOrder?: number; assetRole?: 'INPUT' | 'COVER' | 'PREVIEW' }; status: string; selected: boolean; uploadedTemplateId?: string; currentAttemptId?: string; currentAttempt?: Attempt };
type Batch = { id: string; name: string; status: string; itemCount: number; counts?: Record<string, number>; items?: Item[]; createdAt: string };

const props = defineProps<{ adminKey: string; templateType: 'IMAGE_GENERATION' | 'SHORT_VIDEO' }>();
const apiBase = (import.meta.env.VITE_REMIX_API_BASE || '/remix-api').replace(/\/$/, '');
const mediaLabel = computed(() => props.templateType === 'IMAGE_GENERATION' ? '图片' : '视频');
const prompt = ref('');
type TemplateForm = ImportTemplate;
const templates = ref<TemplateForm[]>([]);
const models = ref<Model[]>([]);
const maxItems = ref(500);
const batches = ref<Batch[]>([]);
const activeBatch = ref<Batch | null>(null);
const loading = ref(false);
const uploading = ref(false);
const refreshing = ref(false);
const refreshedAt = ref('');
const error = ref('');
const notice = ref('');
let pollTimer: number | undefined;

type CandidateGroup = { key: string; title: string; items: Item[] };
const candidateGroups = computed(() => {
  const groups = new Map<string, CandidateGroup>();
  for (const item of activeBatch.value?.items ?? []) {
    const key = item.templateDraft.slug;
    const group = groups.get(key) ?? { key, title: item.templateDraft.title, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, items: group.items.sort((a, b) => (a.sourceAsset.assetOrder ?? 0) - (b.sourceAsset.assetOrder ?? 0)) }));
});
function candidateSections(group: CandidateGroup) {
  return ([{ role: 'COVER', title: '指定封面' }, { role: 'PREVIEW', title: '指定预览' }, { role: 'INPUT', title: '普通生成素材' }] as const)
    .map(section => ({ ...section, items: group.items.filter(item => (item.sourceAsset.assetRole || 'INPUT') === section.role) }))
    .filter(section => section.items.length);
}
function canUpload(group: CandidateGroup) { return group.items.every((item) => ['READY', 'UPLOAD_FAILED'].includes(item.status)); }
const selectedGroups = computed(() => candidateGroups.value.filter((group) => canUpload(group) && group.items.every((item) => item.selected)));
const selectedItems = computed(() => selectedGroups.value.flatMap((group) => group.items));
const assetCount = computed(() => templates.value.reduce((sum, group) => sum + group.assets.length + (group.cover ? 1 : 0) + (group.preview ? 1 : 0), 0));
const activeCount = computed(() => activeBatch.value?.items?.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status)).length ?? 0);
const mediaModels = computed(() => models.value.filter((model) => model.modality === (props.templateType === 'IMAGE_GENERATION' ? 'IMAGE' : 'VIDEO')));
const availableModels = mediaModels;
const uploadModels = ref<Record<string, string>>({});
const uploadParameters = ref<Record<string, Record<string, unknown>>>({});
function changeUploadModel(key: string) {
  uploadParameters.value[key] = defaultParameters(availableModels.value.find((model) => model.code === uploadModels.value[key]));
}
function setUploadParameter(key: string, param: Param, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = param.type === 'BOOLEAN' ? input.checked : param.type === 'NUMBER' && input.value !== '' ? Number(input.value) : input.value;
  (uploadParameters.value[key] ??= {})[param.key] = value;
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-template-admin-key': props.adminKey, ...init.headers },
  });
  return readApiResponse(response, '请求失败');
}

async function upload(file: File): Promise<Asset> {
  const response = await fetch(`${apiBase}/template-remix/assets`, {
    method: 'POST', body: file, headers: { 'Content-Type': file.type, 'x-template-admin-key': props.adminKey },
  });
  const payload = await readApiResponse(response, `上传 ${file.name} 失败`);
  if (typeof payload.url !== 'string' || typeof payload.mimeType !== 'string') throw new Error('素材上传接口响应缺少有效的 url 或 mimeType');
  return { ...payload, name: file.name };
}

function defaultParameters(model: Model | undefined): Record<string, unknown> {
  if (!model) return {};
  const values: Record<string, unknown> = {};
  for (const param of model.params) {
    const raw = param.defaultValue ?? param.options.find((option) => option.isDefault)?.value;
    if (raw === undefined || raw === null || raw === '') continue;
    values[param.key] = param.type === 'NUMBER' ? Number(raw) : param.type === 'BOOLEAN' ? raw === 'true' : raw;
  }
  return values;
}

async function createAndStart() {
  const batchName = String(Date.now());
  if (!props.adminKey) { error.value = '请先在页脚填写 API 管理密钥'; return; }
  if (!templates.value.length || templates.value.some((group) => !group.title.trim() || !group.assets.length)) { error.value = '请为每个模板填写名称并添加至少一条图片或视频'; return; }
  if (assetCount.value > maxItems.value) { error.value = `单批次最多 ${maxItems.value} 条素材`; return; }
  for (const group of templates.value) {
    for (const [index, source] of [...group.assets, ...(group.cover ? [group.cover] : []), ...(group.preview ? [group.preview] : [])].entries()) {
      if (!source.file && !source.url?.trim()) { error.value = `${group.title} 第 ${index + 1} 行：请上传原素材或填写原素材链接`; return; }
      if (!source.file && source.url) source.mimeType = mediaMime(source.url) || source.mimeType;
      for (const url of [source.file ? undefined : source.url, source.subjectFile ? undefined : source.subjectUrl]) {
        if (url && !/^https?:\/\/[^\s]+$/i.test(url)) { error.value = `${group.title} 第 ${index + 1} 行：请填写单个 HTTP(S) 链接`; return; }
        if (url) { try { new URL(url); } catch { error.value = `${group.title} 第 ${index + 1} 行：链接格式无效`; return; } }
      }
    }
  }
  for (const group of templates.value) {
    if (group.cover && !group.cover.mimeType.startsWith('image/')) { error.value = `${group.title}：封面必须是静态图或动态图`; return; }
    if (group.preview && !group.preview.mimeType.startsWith('video/') && !['image/gif', 'image/webp'].includes(group.preview.mimeType)) { error.value = `${group.title}：预览必须是视频或动态图`; return; }
  }
  uploading.value = true; error.value = ''; notice.value = '';
  try {
    const items = [];
    const cachedUploads = new Map<File, Promise<Asset>>();
    const uploadOnce = (file: File) => {
      let result = cachedUploads.get(file);
      if (!result) { result = upload(file); cachedUploads.set(file, result); }
      return result;
    };
    for (const [groupIndex, group] of templates.value.entries()) {
      const templateDraft = {
        type: props.templateType, slug: `remix-${crypto.randomUUID()}`, title: group.title.trim(), category: '主体替换',
        description: '通过 Vilo 主体批量替换工作台生成', tags: ['主体替换'], audience: null,
        premium: false, active: true, sortOrder: groupIndex,
        promptTemplate: group.templatePrompt?.trim() || '保持模板结构，根据用户输入生成同风格内容', negativePrompt: null,
      };
      const entries = [...group.assets.map(source => ({ source, assetRole: 'INPUT' as const })), ...(group.cover ? [{ source: group.cover, assetRole: 'COVER' as const }] : []), ...(group.preview ? [{ source: group.preview, assetRole: 'PREVIEW' as const }] : [])];
      for (const [assetIndex, { source, assetRole }] of entries.entries()) {
        const asset = source.file ? await uploadOnce(source.file) : { url: source.url, mimeType: source.mimeType, name: source.name };
        const subjectFile = source.keepOriginal ? undefined : source.subjectFile;
        const subjectUrl = source.keepOriginal ? undefined : source.subjectUrl;
        const subject = subjectFile ? await uploadOnce(subjectFile) : subjectUrl ? { url: subjectUrl, mimeType: mediaMime(subjectUrl) || 'image/jpeg' } : null;
        items.push({ sourceKey: `${groupIndex + 1}-${assetIndex + 1}-${assetRole}`, assetRole,
          mediaType: source.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE', sourceAsset: asset,
          subjectAssets: subject ? [subject] : [], promptAddition: source.prompt || '', templateDraft,
        });
      }
    }

    const templateCount = templates.value.length;
    const created = await request('/template-remix/batches/import', { method: 'POST', body: JSON.stringify({ name: batchName, defaultPrompt: prompt.value, templateType: props.templateType, items }) });
    templates.value = [];
    await loadBatches(); await openBatch(created.batch.id);
    const started = await request(`/template-remix/batches/${encodeURIComponent(created.batch.id)}/start`, { method: 'POST', body: JSON.stringify({ promptAddition: prompt.value }) });
    notice.value = `已导入 ${templateCount} 个模板、${items.length} 条素材，其中 ${started.queued} 条进入替换队列`;
    await loadBatches(); await openBatch(created.batch.id);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '批次创建失败'; }
  finally { uploading.value = false; }
}

async function loadConfig() {
  if (!props.adminKey) return;
  const data = await request('/template-remix/config');
  if (!Array.isArray(data.models)) throw new Error('主体替换配置接口响应缺少 models 数组，请检查后端服务版本');
  models.value = data.models;
  if (Number.isInteger(data.maxItemsPerBatch)) maxItems.value = data.maxItemsPerBatch;
}

async function loadBatches() {
  if (!props.adminKey) return;
  const data = await request(`/template-remix/batches?limit=30&templateType=${props.templateType}`); batches.value = data.items;
}

async function openBatch(id: string) {
  const data = await request(`/template-remix/batches/${encodeURIComponent(id)}`); activeBatch.value = data.batch;
}

async function refresh(manual = false) {
  if (refreshing.value) return;
  if (!props.adminKey) { if (manual) error.value = '请先在页脚填写 API 管理密钥'; return; }
  refreshing.value = true;
  if (manual) error.value = '';
  try {
    await Promise.all([loadBatches(), activeBatch.value ? openBatch(activeBatch.value.id) : Promise.resolve()]);
    refreshedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (manual) notice.value = '已更新主体替换进度和模板入库状态';
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '刷新失败'; }
  finally { refreshing.value = false; }
}

async function toggleGroup(group: CandidateGroup) {
  const selected = !group.items.every((item) => item.selected);
  loading.value = true;
  try {
    await request('/template-remix/items/selection', { method: 'PATCH', body: JSON.stringify({ items: group.items.map((item) => ({ itemId: item.id, selected })) }) });
    for (const item of group.items) item.selected = selected;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '选择保存失败'; }
  finally { loading.value = false; }
}

async function regenerate(item: Item) {
  loading.value = true;
  try { await request(`/template-remix/items/${encodeURIComponent(item.id)}/regenerate`, { method: 'POST', body: JSON.stringify({ promptAddition: prompt.value }) }); if (activeBatch.value) await openBatch(activeBatch.value.id); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '重新生成失败'; }
  finally { loading.value = false; }
}

async function uploadSelected() {
  if (selectedGroups.value.some((group) => !availableModels.value.some((model) => model.code === uploadModels.value[group.key]))) { error.value = '请为每个选中的候选模板选择入库模型'; return; }
  if (!selectedItems.value.length || !window.confirm(`确定将 ${selectedGroups.value.length} 个候选模板写入正式模板库吗？`)) return;
  loading.value = true;
  try {
    const data = await request('/template-remix/items/upload', { method: 'POST', body: JSON.stringify({ items: selectedItems.value.map((item) => ({ itemId: item.id, modelCode: uploadModels.value[item.templateDraft.slug], parameters: uploadParameters.value[item.templateDraft.slug] || {}, ...(item.currentAttemptId ? { attemptId: item.currentAttemptId } : {}) })) }) });
    const succeeded = data.results.filter((result: { status: string }) => result.status === 'UPLOADED').length;
    const failures = data.results.filter((result: { status: string }) => result.status !== 'UPLOADED');
    notice.value = `成功入库 ${succeeded}/${data.results.length} 个模板`;
    if (failures.length) error.value = failures.map((result: { error?: { message?: string } }) => result.error?.message || '入库失败').join('；');
    await refresh();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '批量入库失败'; }
  finally { loading.value = false; }
}

const sourceRowKeys = new WeakMap<object, string>();
function sourceRowKey(source: ImportSource) {
  let key = sourceRowKeys.get(source);
  if (!key) { key = crypto.randomUUID(); sourceRowKeys.set(source, key); }
  return key;
}
function addSource(group: TemplateForm) {
  group.assets.push({ name: '手动素材', mimeType: 'image/jpeg' });
}
function addTemplate() {
  const group: TemplateForm = { key: crypto.randomUUID(), title: `新模板 ${templates.value.length + 1}`, assets: [] };
  addSource(group);
  templates.value.push(group);
}
async function importExcel(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  uploading.value = true; error.value = '';
  try {
    const groups = groupImportSources(await readRemixExcel(file));
    const filtered = groups.map((group) => ({ ...group, key: crypto.randomUUID() })).filter((group) => group.assets.length || group.cover || group.preview);
    if (!filtered.length) throw new Error(`Excel 中没有${mediaLabel.value}素材`);
    templates.value.push(...filtered);
    notice.value = `已导入 ${filtered.length} 个${mediaLabel.value}模板，已保留全部图片、视频素材。`;
  }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Excel 读取失败'; }
  finally { uploading.value = false; }
}
function downloadExcel() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['模板标识', '模板名称', '媒体类型', '原素材', '主体图片', '替换要求', '模板提示词', '指定封面', '封面主体图片', '指定预览', '预览主体图片'],
    ['template-1', '多素材示例', '图片', 'https://example.com/1.jpg', 'https://example.com/person1.png', '', '根据用户输入生成同风格内容', 'https://example.com/cover.gif', '', 'https://example.com/preview.mp4', ''],
    ['template-1', '多素材示例', '视频', 'https://example.com/1.mp4', 'https://example.com/person2.png', '', ''],
  ]), '素材');
  XLSX.writeFile(workbook, '主体替换批量导入.xlsx');
}
function hasSubject(item: Item) { return item.sourceAsset.subjectAssets?.length !== 0; }

watch(() => props.adminKey, async () => { try { await Promise.all([loadConfig(), loadBatches()]); } catch { /* 页脚输入过程中不打断用户 */ } });
onMounted(async () => {
  try { await Promise.all([loadConfig(), loadBatches()]); } catch (reason) { if (props.adminKey) error.value = reason instanceof Error ? reason.message : '初始化失败'; }
  pollTimer = window.setInterval(() => { if (activeCount.value > 0 && !loading.value && !uploading.value) void refresh(); }, 5000);
});
onBeforeUnmount(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<template>
  <main class="remix-main">
    <section class="remix-excel-entry" aria-label="Excel 批量导入">
      <strong>Excel 批量导入</strong>
      <button type="button" class="secondary" @click="downloadExcel">下载 Excel 示例</button>
      <label>导入 Excel<input type="file" accept=".xlsx,.xls" :disabled="uploading" @change="importExcel" /></label>
      <small>导入为{{ mediaLabel }}模板；每个模板均支持多张图片、多个视频和提示词，相同“模板标识”会合并；每行只填一条原素材及其对应主体。</small>
    </section>
    <div class="page-heading"><div><p class="eyebrow">内容运营 / 02</p><h1>模板主体批量替换</h1><p class="subheading">{{ mediaLabel }}模板：支持图片、提示词和视频，逐素材替换，整组入库</p></div><button class="secondary" :disabled="loading || uploading || refreshing" @click="refresh(true)">{{ refreshing ? '刷新中…' : '刷新替换 / 入库状态' }}</button></div>
    <div v-if="error" class="banner error" role="alert">{{ error }} <button aria-label="关闭错误" @click="error = ''">关闭</button></div>
    <div v-if="notice" class="banner success" role="status">{{ notice }}</div>
    <section class="remix-setup" aria-labelledby="batch-setup-title">
      <div class="section-title"><div><h3 id="batch-setup-title">新建替换批次</h3><p>每张图片、每个视频独立配置一个主体；无主体时保留原素材。普通素材和提示词仅作生成入参；指定封面和预览可分别配置主体。处理后人工筛选，再选择模型入库。</p></div><button type="button" class="primary" :disabled="uploading" @click="addTemplate">＋ 新增模板</button></div>
      <div class="remix-form-grid">
        <fieldset v-for="(group, index) in templates" :key="group.key" class="span-2 remix-template-form" :disabled="uploading">
          <legend>模板 {{ index + 1 }} · {{ group.assets.length }} 条素材</legend>
          <label>模板提示词<textarea v-model="group.templatePrompt" rows="3" maxlength="20000" placeholder="此模板入库后用于生成的提示词" /></label>
          <label>模板名称<input v-model="group.title" maxlength="200" /></label>
            <div class="remix-display-assets">
              <fieldset><legend>指定封面 · 静态图或动态图</legend>
                <RemixAssetInputs v-if="group.cover" :source="group.cover" role="COVER" />
                <button v-if="!group.cover" type="button" class="secondary" @click="group.cover = { name: '指定封面', mimeType: 'image/jpeg' }">＋ 指定封面</button>
                <button v-else type="button" class="secondary" @click="group.cover = undefined">移除指定封面</button>
              </fieldset>
              <fieldset><legend>指定预览 · 视频或动态图</legend>
                <RemixAssetInputs v-if="group.preview" :source="group.preview" role="PREVIEW" />
                <button v-if="!group.preview" type="button" class="secondary" @click="group.preview = { name: '指定预览', mimeType: 'video/mp4' }">＋ 指定预览</button>
                <button v-else type="button" class="secondary" @click="group.preview = undefined">移除指定预览</button>
              </fieldset>
            </div>
          <h4>普通生成素材 · 仅用于模板生成入参</h4>
          <div v-for="(source, assetIndex) in group.assets" :key="sourceRowKey(source)" class="remix-source-row">
            <strong>素材 {{ assetIndex + 1 }} · 生成入参</strong>
            <RemixAssetInputs :source="source" role="INPUT" />
            <button type="button" class="secondary" @click="group.assets.splice(assetIndex, 1)">移除此行</button>
          </div>
          <button type="button" class="secondary" @click="addSource(group)">＋ 新增素材行</button>
          <button type="button" class="secondary" @click="templates.splice(index, 1)">移除此模板</button>
        </fieldset>
        <p v-if="!templates.length" class="span-2">点击“＋ 新增模板”手动上传，或从顶部导入 Excel。</p>
        <label class="span-2">统一替换要求<textarea v-model="prompt" rows="3" :disabled="uploading" placeholder="例如：保留品牌文字，所有图片和视频中的主体外观一致" /></label>
      </div>
      <div class="setup-actions"><span>{{ templates.length }} 个模板 · {{ assetCount }} 条素材，生成后需人工勾选入库。</span><button class="primary" :disabled="uploading || !templates.length" @click="createAndStart">{{ uploading ? '上传并创建中…' : '导入并处理模板' }}</button></div>
    </section>
    <section class="remix-console">
      <aside class="batch-list" aria-label="替换批次列表">
        <div class="catalog-header"><span>批次</span><span class="count">{{ batches.length }}</span></div>
        <button v-for="batch in batches" :key="batch.id" class="batch-row" :class="{ selected: activeBatch?.id === batch.id }" @click="openBatch(batch.id)"><strong>{{ batch.name }}</strong><small>{{ batch.itemCount }} 条素材 · {{ batch.status }}</small></button>
        <div v-if="!batches.length" class="empty-list">暂无批次</div>
      </aside>
      <div class="candidate-panel">
        <div v-if="activeBatch" class="candidate-head"><div><h2>{{ activeBatch.name }}</h2><p>{{ activeBatch.status }} · {{ candidateGroups.length }} 个模板 · {{ activeBatch.itemCount }} 条素材</p></div><button class="primary" :disabled="!selectedGroups.length || loading" @click="uploadSelected">整组入库（{{ selectedGroups.length }}）</button></div>
        <p v-if="refreshedAt" role="status">状态更新时间：{{ refreshedAt }}</p>
        <div v-if="activeBatch" class="status-strip"><span>排队 {{ activeBatch.counts?.QUEUED || 0 }}</span><span>生成中 {{ activeBatch.counts?.RUNNING || 0 }}</span><span>可预览 {{ activeBatch.counts?.READY || 0 }}</span><span>失败 {{ activeBatch.counts?.FAILED || 0 }}</span><span>已入库素材 {{ activeBatch.counts?.UPLOADED || 0 }}</span></div>
        <section v-for="group in candidateGroups" :key="group.key" class="remix-candidate-group">
          <label class="candidate-check"><input type="checkbox" :checked="group.items.every(item => item.selected)" :disabled="loading || !canUpload(group)" @change="toggleGroup(group)" /><strong>{{ group.title }}</strong><span>{{ group.items.length }} 条素材</span></label>
          <small v-if="!canUpload(group)">{{ group.items.every(item => item.status === 'UPLOADED') ? '模板已入库' : '全部素材完成后可整组勾选入库' }}</small>
          <label v-if="canUpload(group)">正式入库模型（单选）<select v-model="uploadModels[group.key]" @change="changeUploadModel(group.key)"><option value="" disabled>请选择模型</option><option v-for="model in availableModels" :key="model.code" :value="model.code">{{ model.name }}</option></select></label>
          <div v-if="canUpload(group) && uploadModels[group.key]" class="remix-form-grid">
            <label v-for="param in availableModels.find(model => model.code === uploadModels[group.key])?.params || []" :key="param.key">{{ param.label || param.key }}{{ param.required ? '（必填）' : '' }}
              <select v-if="param.type === 'SELECT'" :value="uploadParameters[group.key]?.[param.key]" @change="setUploadParameter(group.key, param, $event)"><option value="">请选择</option><option v-for="option in param.options" :key="option.value" :value="option.value">{{ option.value }}</option></select>
              <input v-else-if="param.type === 'BOOLEAN'" type="checkbox" :checked="uploadParameters[group.key]?.[param.key] === true" @change="setUploadParameter(group.key, param, $event)" />
              <input v-else :type="param.type === 'NUMBER' ? 'number' : 'text'" :value="uploadParameters[group.key]?.[param.key]" @input="setUploadParameter(group.key, param, $event)" />
            </label>
          </div>
          <section v-for="section in candidateSections(group)" :key="section.role" class="candidate-role-section">
            <h4>{{ section.title }}</h4>
            <div class="candidate-grid">
            <article v-for="item in section.items" :key="item.id" class="candidate-card" :class="{ checked: item.selected }">
              <div class="candidate-media"><video v-if="item.mediaType === 'VIDEO'" :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" controls preload="metadata" /><img v-else :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" :alt="item.sourceKey" loading="lazy" /></div>
              <div class="candidate-copy"><span>{{ item.sourceKey }} · {{ item.sourceAsset.assetRole === 'COVER' ? '指定封面' : item.sourceAsset.assetRole === 'PREVIEW' ? '指定预览' : '生成入参' }}</span><small>{{ hasSubject(item) ? '主体替换' : '保留原素材' }}</small><span class="state-pill" :data-state="item.status">{{ item.status }}</span></div>
              <p v-if="item.currentAttempt?.providerError" class="item-error">{{ item.currentAttempt.providerError.code }} · {{ item.currentAttempt.providerError.message }}</p>
              <div class="candidate-actions"><small>{{ item.mediaType }} · 第 {{ item.currentAttempt?.sequence || 0 }} 次</small><button class="secondary" :disabled="loading || !hasSubject(item) || ['UPLOADED', 'QUEUED', 'RUNNING', 'UPLOADING'].includes(item.status)" @click="regenerate(item)">重新生成此素材</button></div>
            </article>
          </div>
          </section>
        </section>
        <div v-if="!candidateGroups.length" class="welcome"><div class="welcome-mark">V</div><h2>候选结果工作台</h2><p>创建批次或从左侧选择已有批次。</p></div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.remix-excel-entry { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:16px; margin-bottom:24px; border:1px solid #d8ded9; border-radius:12px; background:#f7faf7; }
.remix-excel-entry small { flex-basis:100%; }
.remix-template-form { min-width:0; display:grid; gap:12px; padding:18px; border:1px solid #d8ded9; border-radius:12px; }
.remix-template-form label { display:grid; gap:6px; }
.remix-source-row { display:grid; gap:10px; border-top:1px solid #e3e7e4; padding-top:12px; overflow-wrap:anywhere; }
.remix-source-row strong { flex-basis:100%; }
.remix-candidate-group { margin:16px 0; padding:16px; border:1px solid #d8ded9; border-radius:12px; }
.remix-source-columns { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap:16px; align-items:start; }
.remix-source-columns > *, .remix-subject-cell { min-width:0; }
.remix-subject-cell { display:grid; gap:8px; }
.remix-source-columns input { max-width:100%; box-sizing:border-box; }
.remix-source-prompt { width:100%; }
@media (max-width: 900px) { .remix-source-columns { grid-template-columns:minmax(0, 1fr); } }
.remix-display-assets { display:grid; gap:16px; }
.remix-display-assets fieldset { min-width:0; border:1px solid #d8ded9; border-radius:8px; padding:12px; display:grid; gap:12px; }
</style>
