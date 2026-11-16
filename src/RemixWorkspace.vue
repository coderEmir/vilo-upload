<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as XLSX from 'xlsx';
import { readRemixExcel, groupImportSources, mediaMime, type ImportSource, type ImportTemplate } from './remix-excel';
import { readApiResponse } from './api-response';

type Param = { key: string; type: string; required: boolean; defaultValue: string | null; options: Array<{ value: string; isDefault: boolean }> };
type Model = { id: string; code: string; name: string; modality: 'IMAGE' | 'VIDEO'; params: Param[] };
type Asset = { url: string; mimeType: string; name?: string; sizeBytes?: number };
type Attempt = { id: string; status: string; resultAsset?: Asset & { provider?: string }; providerError?: { code?: string; message?: string }; sequence: number };
type Item = { id: string; sourceKey: string; templateDraft: { slug: string; title: string }; mediaType: 'IMAGE' | 'VIDEO'; sourceAsset: Asset & { subjectAssets?: Asset[]; assetOrder?: number }; status: string; selected: boolean; uploadedTemplateId?: string; currentAttemptId?: string; currentAttempt?: Attempt };
type Batch = { id: string; name: string; status: string; itemCount: number; counts?: Record<string, number>; items?: Item[]; createdAt: string };

const props = defineProps<{ adminKey: string }>();
const apiBase = (import.meta.env.VITE_REMIX_API_BASE || '/remix-api').replace(/\/$/, '');
const batchName = ref(`主体替换 ${new Date().toLocaleDateString()}`);
const prompt = ref('');
type TemplateForm = ImportTemplate & { linkText?: string; linkType?: 'IMAGE' | 'VIDEO' };
const templates = ref<TemplateForm[]>([]);
const imageModelCode = ref('');
const videoModelCode = ref('');
const models = ref<Model[]>([]);
const maxItems = ref(500);
const batches = ref<Batch[]>([]);
const activeBatch = ref<Batch | null>(null);
const loading = ref(false);
const uploading = ref(false);
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
function canUpload(group: CandidateGroup) { return group.items.every((item) => ['READY', 'UPLOAD_FAILED'].includes(item.status)); }
const selectedGroups = computed(() => candidateGroups.value.filter((group) => canUpload(group) && group.items.every((item) => item.selected)));
const selectedItems = computed(() => selectedGroups.value.flatMap((group) => group.items));
const assetCount = computed(() => templates.value.reduce((sum, group) => sum + group.assets.length, 0));
const activeCount = computed(() => activeBatch.value?.items?.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status)).length ?? 0);
const imageModels = computed(() => models.value.filter((model) => model.modality === 'IMAGE'));
const videoModels = computed(() => models.value.filter((model) => model.modality === 'VIDEO'));

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
  if (!props.adminKey) { error.value = '请先在页脚填写 API 管理密钥'; return; }
  if (!templates.value.length || templates.value.some((group) => !group.title.trim() || !group.assets.length)) { error.value = '请为每个模板填写名称并添加至少一条图片或视频'; return; }
  if (assetCount.value > maxItems.value) { error.value = `单批次最多 ${maxItems.value} 条素材`; return; }
  if (templates.value.some((group) => group.linkText?.trim())) { error.value = '还有尚未添加的素材链接，请先点击“添加链接”'; return; }
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
      const hasVideo = group.assets.some((asset) => asset.mimeType.startsWith('video/'));
      const model = models.value.find((entry) => entry.code === (hasVideo ? videoModelCode.value : imageModelCode.value));
      if (!model) throw new Error(`请选择${hasVideo ? '视频' : '图片'}正式模板模型`);
      const templateDraft = {
        slug: `remix-${crypto.randomUUID()}`, title: group.title.trim(), category: '主体替换',
        description: '通过 Vilo 主体批量替换工作台生成', tags: ['主体替换'], audience: null,
        premium: false, active: true, sortOrder: groupIndex, modelCode: model.code,
        parameters: defaultParameters(model), promptTemplate: prompt.value || '保持模板结构，根据用户输入生成同风格内容', negativePrompt: null,
      };
      for (const [assetIndex, source] of group.assets.entries()) {
        const asset = source.file ? await uploadOnce(source.file) : { url: source.url, mimeType: source.mimeType, name: source.name };
        const subjectFile = source.keepOriginal ? undefined : source.subjectFile || (source.subjectUrl ? undefined : group.subjectFile);
        const subjectUrl = source.keepOriginal ? undefined : source.subjectUrl || (source.subjectFile ? undefined : group.subjectUrl);
        const subject = subjectFile ? await uploadOnce(subjectFile) : subjectUrl ? { url: subjectUrl, mimeType: 'image/jpeg' } : null;
        items.push({
          sourceKey: `${groupIndex + 1}-${assetIndex + 1}-${source.name}`.slice(0, 200),
          mediaType: source.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE', sourceAsset: asset,
          subjectAssets: subject ? [subject] : [], promptAddition: source.prompt || '', templateDraft,
        });
      }
    }
    const templateCount = templates.value.length;
    const created = await request('/template-remix/batches/import', { method: 'POST', body: JSON.stringify({ name: batchName.value, defaultPrompt: prompt.value, items }) });
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
  imageModelCode.value ||= imageModels.value[0]?.code || '';
  videoModelCode.value ||= videoModels.value[0]?.code || '';
}

async function loadBatches() {
  if (!props.adminKey) return;
  const data = await request('/template-remix/batches?limit=30'); batches.value = data.items;
}

async function openBatch(id: string) {
  const data = await request(`/template-remix/batches/${encodeURIComponent(id)}`); activeBatch.value = data.batch;
}

async function refresh() {
  try { await Promise.all([loadBatches(), activeBatch.value ? openBatch(activeBatch.value.id) : Promise.resolve()]); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '刷新失败'; }
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
  if (!selectedItems.value.length || !window.confirm(`确定将 ${selectedGroups.value.length} 个候选模板写入正式模板库吗？`)) return;
  loading.value = true;
  try {
    const data = await request('/template-remix/items/upload', { method: 'POST', body: JSON.stringify({ items: selectedItems.value.map((item) => ({ itemId: item.id, ...(item.currentAttemptId ? { attemptId: item.currentAttemptId } : {}) })) }) });
    const succeeded = data.results.filter((result: { status: string }) => result.status === 'UPLOADED').length;
    const failures = data.results.filter((result: { status: string }) => result.status !== 'UPLOADED');
    notice.value = `成功入库 ${succeeded}/${data.results.length} 个模板`;
    if (failures.length) error.value = failures.map((result: { error?: { message?: string } }) => result.error?.message || '入库失败').join('；');
    await refresh();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '批量入库失败'; }
  finally { loading.value = false; }
}

function addTemplate() {
  templates.value.push({ key: crypto.randomUUID(), title: `新模板 ${templates.value.length + 1}`, assets: [], linkType: 'IMAGE' });
}
function onSources(event: Event, group: TemplateForm) {
  group.assets.push(...Array.from((event.target as HTMLInputElement).files ?? []).map((file) => ({ name: file.name, file, mimeType: file.type || mediaMime(file.name) })));
  (event.target as HTMLInputElement).value = '';
}
function addLinks(group: TemplateForm) {
  try {
    const urls = (group.linkText || '').split(/[\n\r]+/).map((value) => value.trim()).filter(Boolean);
    if (!urls.length) throw new Error('请填写图片或视频链接');
    for (const url of urls) { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('仅支持 HTTP(S) 图片或视频链接'); }
    group.assets.push(...urls.map((url) => ({ name: new URL(url).pathname.split('/').pop() || '链接素材', url, mimeType: mediaMime(url) || (group.linkType === 'VIDEO' ? 'video/mp4' : 'image/jpeg') })));
    group.linkText = ''; error.value = '';
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '链接无效'; }
}
function onSubject(event: Event, target: ImportSource | ImportTemplate) {
  target.subjectFile = (event.target as HTMLInputElement).files?.[0]; target.subjectUrl = undefined;
  if ('mimeType' in target) target.keepOriginal = false;
}
async function importExcel(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  uploading.value = true; error.value = '';
  try { templates.value.push(...groupImportSources(await readRemixExcel(file)).map((group) => ({ ...group, key: crypto.randomUUID() }))); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : 'Excel 读取失败'; }
  finally { uploading.value = false; }
}
function downloadExcel() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['模板标识', '模板名称', '图片1', '图片2', '视频1', '视频2', '主体图片', '替换要求'],
    ['template-1', '多素材示例', 'https://example.com/1.jpg', 'https://example.com/2.png', 'https://example.com/1.mp4', 'https://example.com/2.mp4', '', ''],
    ['template-1', '多素材示例', 'https://example.com/3.jpg', '', '', '', '', ''],
  ]), '素材');
  XLSX.writeFile(workbook, '主体替换批量导入.xlsx');
}
function hasSubject(item: Item) { return item.sourceAsset.subjectAssets?.length !== 0; }

watch(() => props.adminKey, async () => { try { await Promise.all([loadConfig(), loadBatches()]); } catch { /* 页脚输入过程中不打断用户 */ } });
onMounted(async () => {
  try { await Promise.all([loadConfig(), loadBatches()]); } catch (reason) { if (props.adminKey) error.value = reason instanceof Error ? reason.message : '初始化失败'; }
  pollTimer = window.setInterval(() => { if (activeCount.value > 0) void refresh(); }, 5000);
});
onBeforeUnmount(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<template>
  <main class="remix-main">
    <section class="remix-excel-entry" aria-label="Excel 批量导入">
      <strong>Excel 批量导入</strong>
      <button type="button" class="secondary" @click="downloadExcel">下载 Excel 示例</button>
      <label>导入 Excel<input type="file" accept=".xlsx,.xls" :disabled="uploading" @change="importExcel" /></label>
      <small>一个模板可有多张图片和多个视频；相同“模板标识”会合并，同一行可填写图片1、图片2、视频1、视频2等多列。</small>
    </section>
    <div class="page-heading"><div><p class="eyebrow">内容运营 / 02</p><h1>模板主体批量替换</h1><p class="subheading">每个模板包含多张图片和多个视频，逐个替换，整组入库</p></div><button class="secondary" :disabled="loading" @click="refresh">刷新状态</button></div>
    <div v-if="error" class="banner error" role="alert">{{ error }} <button aria-label="关闭错误" @click="error = ''">关闭</button></div>
    <div v-if="notice" class="banner success" role="status">{{ notice }}</div>
    <section class="remix-setup" aria-labelledby="batch-setup-title">
      <div class="section-title"><div><h3 id="batch-setup-title">新建替换批次</h3><p>模板主体默认应用于全部素材，也可逐素材设置；无主体时保留原素材。</p></div><button type="button" class="primary" :disabled="uploading" @click="addTemplate">＋ 新增模板</button></div>
      <div class="remix-form-grid">
        <label>批次名称<input v-model="batchName" maxlength="200" :disabled="uploading" /></label>
        <label>图片模板模型<select v-model="imageModelCode" :disabled="uploading"><option v-for="model in imageModels" :key="model.id" :value="model.code">{{ model.name }}</option></select></label>
        <label>视频模板模型<select v-model="videoModelCode" :disabled="uploading"><option v-for="model in videoModels" :key="model.id" :value="model.code">{{ model.name }}</option></select></label>
        <small class="span-2">仅含图片的模板使用图片模型；含视频的模板使用视频模型作为正式模板的生成配置，图片素材仍由图片替换模型处理。</small>
        <fieldset v-for="(group, index) in templates" :key="group.key" class="span-2 remix-template-form" :disabled="uploading">
          <legend>模板 {{ index + 1 }} · {{ group.assets.length }} 条素材</legend>
          <label>模板名称<input v-model="group.title" maxlength="200" /></label>
          <label>模板主体图片（应用于全部未单独配置的素材）<input type="file" accept="image/*" @change="onSubject($event, group)" /></label>
          <small>{{ group.subjectFile?.name || group.subjectUrl || '未设置模板主体' }}</small>
          <button type="button" class="secondary" @click="group.subjectFile = undefined; group.subjectUrl = undefined">清除模板主体</button>
          <label>上传图片、视频<input type="file" accept="image/*,video/*" multiple @change="onSources($event, group)" /></label>
          <label>原素材链接<textarea v-model="group.linkText" rows="2" placeholder="每行一个图片或视频 HTTP(S) 链接" /></label>
          <label>无扩展名链接的媒体类型<select v-model="group.linkType"><option value="IMAGE">图片</option><option value="VIDEO">视频</option></select></label>
          <button type="button" class="secondary" @click="addLinks(group)">＋ 添加链接</button>
          <div v-for="(source, assetIndex) in group.assets" :key="assetIndex" class="remix-source-row">
            <strong>{{ assetIndex + 1 }}. {{ source.mimeType.startsWith('video/') ? '视频' : '图片' }} · {{ source.name }}</strong>
            <a v-if="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">查看原素材链接</a>
            <label>单独设置主体（可选）<input type="file" accept="image/*" @change="onSubject($event, source)" /></label>
            <small>{{ source.keepOriginal ? '保留原素材' : source.subjectFile?.name || source.subjectUrl || group.subjectFile?.name || group.subjectUrl || '未配置主体，保留原素材' }}</small>
            <button type="button" class="secondary" @click="source.subjectFile = undefined; source.subjectUrl = undefined; source.keepOriginal = false">使用模板主体</button>
            <button type="button" class="secondary" @click="source.subjectFile = undefined; source.subjectUrl = undefined; source.keepOriginal = true">保留原素材</button>
            <button type="button" class="secondary" @click="group.assets.splice(assetIndex, 1)">移除素材</button>
          </div>
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
        <div v-if="activeBatch" class="status-strip"><span>排队 {{ activeBatch.counts?.QUEUED || 0 }}</span><span>生成中 {{ activeBatch.counts?.RUNNING || 0 }}</span><span>可预览 {{ activeBatch.counts?.READY || 0 }}</span><span>失败 {{ activeBatch.counts?.FAILED || 0 }}</span><span>已入库素材 {{ activeBatch.counts?.UPLOADED || 0 }}</span></div>
        <section v-for="group in candidateGroups" :key="group.key" class="remix-candidate-group">
          <label class="candidate-check"><input type="checkbox" :checked="group.items.every(item => item.selected)" :disabled="loading || !canUpload(group)" @change="toggleGroup(group)" /><strong>{{ group.title }}</strong><span>{{ group.items.length }} 条素材</span></label>
          <small v-if="!canUpload(group)">{{ group.items.every(item => item.status === 'UPLOADED') ? '模板已入库' : '全部素材完成后可整组勾选入库' }}</small>
          <div class="candidate-grid">
            <article v-for="item in group.items" :key="item.id" class="candidate-card" :class="{ checked: item.selected }">
              <div class="candidate-media"><video v-if="item.mediaType === 'VIDEO'" :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" controls preload="metadata" /><img v-else :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" :alt="item.sourceKey" loading="lazy" /></div>
              <div class="candidate-copy"><span>{{ item.sourceKey }}</span><small>{{ hasSubject(item) ? '主体替换' : '保留原素材' }}</small><span class="state-pill" :data-state="item.status">{{ item.status }}</span></div>
              <p v-if="item.currentAttempt?.providerError" class="item-error">{{ item.currentAttempt.providerError.code }} · {{ item.currentAttempt.providerError.message }}</p>
              <div class="candidate-actions"><small>{{ item.mediaType }} · 第 {{ item.currentAttempt?.sequence || 0 }} 次</small><button class="secondary" :disabled="loading || !hasSubject(item) || ['UPLOADED', 'QUEUED', 'RUNNING', 'UPLOADING'].includes(item.status)" @click="regenerate(item)">重新生成此素材</button></div>
            </article>
          </div>
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
.remix-source-row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; border-top:1px solid #e3e7e4; padding-top:12px; overflow-wrap:anywhere; }
.remix-source-row strong { flex-basis:100%; }
.remix-candidate-group { margin:16px 0; padding:16px; border:1px solid #d8ded9; border-radius:12px; }
</style>
