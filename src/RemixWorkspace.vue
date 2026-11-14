<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Param = { key: string; type: string; required: boolean; defaultValue: string | null; options: Array<{ value: string; isDefault: boolean }> };
type Model = { id: string; code: string; name: string; modality: 'IMAGE' | 'VIDEO'; params: Param[] };
type Asset = { url: string; mimeType: string; name?: string; sizeBytes?: number };
type Attempt = { id: string; status: string; resultAsset?: Asset & { provider?: string }; providerError?: { code?: string; message?: string }; sequence: number };
type Item = { id: string; sourceKey: string; mediaType: 'IMAGE' | 'VIDEO'; sourceAsset: Asset; status: string; selected: boolean; uploadedTemplateId?: string; currentAttemptId?: string; currentAttempt?: Attempt };
type Batch = { id: string; name: string; status: string; itemCount: number; counts?: Record<string, number>; items?: Item[]; createdAt: string };

const props = defineProps<{ adminKey: string }>();
const apiBase = (import.meta.env.VITE_REMIX_API_BASE || '/remix-api').replace(/\/$/, '');
const batchName = ref(`主体替换 ${new Date().toLocaleDateString()}`);
const prompt = ref('');
const subjectFile = ref<File | null>(null);
const sourceFiles = ref<File[]>([]);
const imageModelCode = ref('');
const videoModelCode = ref('');
const models = ref<Model[]>([]);
const batches = ref<Batch[]>([]);
const activeBatch = ref<Batch | null>(null);
const loading = ref(false);
const uploading = ref(false);
const error = ref('');
const notice = ref('');
let pollTimer: number | undefined;

const selectedItems = computed(() => activeBatch.value?.items?.filter((item) => item.selected && item.status === 'READY') ?? []);
const runnableItems = computed(() => activeBatch.value?.items?.filter((item) => ['IMPORTED', 'FAILED', 'READY'].includes(item.status)) ?? []);
const activeCount = computed(() => activeBatch.value?.items?.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status)).length ?? 0);
const imageModels = computed(() => models.value.filter((model) => model.modality === 'IMAGE'));
const videoModels = computed(() => models.value.filter((model) => model.modality === 'VIDEO'));

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-template-admin-key': props.adminKey, ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
  return payload;
}

async function upload(file: File): Promise<Asset> {
  const response = await fetch(`${apiBase}/template-remix/assets`, {
    method: 'POST', body: file, headers: { 'Content-Type': file.type, 'x-template-admin-key': props.adminKey },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `上传 ${file.name} 失败`);
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

function fileSlug(file: File, index: number): string {
  const name = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'template';
  return `${name}-${Date.now()}-${index + 1}`.slice(0, 160);
}

async function createAndStart() {
  if (!props.adminKey) { error.value = '请先在页脚填写 API 管理密钥'; return; }
  if (!subjectFile.value || !sourceFiles.value.length) { error.value = '请上传主体图片和至少一个三方模板'; return; }
  if (sourceFiles.value.some((file) => file.type.startsWith('image/')) && !imageModelCode.value) { error.value = '请选择图片正式模板模型'; return; }
  if (sourceFiles.value.some((file) => file.type.startsWith('video/')) && !videoModelCode.value) { error.value = '请选择视频正式模板模型'; return; }
  uploading.value = true; error.value = ''; notice.value = '';
  try {
    const subject = await upload(subjectFile.value);
    const sources = await Promise.all(sourceFiles.value.map(upload));
    const items = sources.map((asset, index) => {
      const file = sourceFiles.value[index];
      const mediaType = file.type.startsWith('video/') ? 'VIDEO' : 'IMAGE';
      const model = models.value.find((entry) => entry.code === (mediaType === 'VIDEO' ? videoModelCode.value : imageModelCode.value));
      return {
        sourceKey: `${index + 1}-${file.name}`,
        mediaType,
        sourceAsset: asset,
        templateDraft: {
          slug: fileSlug(file, index), title: file.name.replace(/\.[^.]+$/, ''), category: '主体替换',
          description: '通过 Vilo 主体批量替换工作台生成', tags: ['主体替换'], audience: null,
          premium: false, active: true, sortOrder: 0, modelCode: model?.code,
          parameters: defaultParameters(model), promptTemplate: prompt.value || '保持模板结构，根据用户输入生成同风格内容', negativePrompt: null,
        },
      };
    });
    const created = await request('/template-remix/batches/import', { method: 'POST', body: JSON.stringify({ name: batchName.value, subjectAssets: [subject], defaultPrompt: prompt.value, items }) });
    await request(`/template-remix/batches/${encodeURIComponent(created.batch.id)}/start`, { method: 'POST', body: JSON.stringify({ promptAddition: prompt.value }) });
    notice.value = `已创建 ${items.length} 个并发任务`;
    await loadBatches(); await openBatch(created.batch.id);
    subjectFile.value = null; sourceFiles.value = [];
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '批次创建失败'; }
  finally { uploading.value = false; }
}

async function loadConfig() {
  if (!props.adminKey) return;
  const data = await request('/template-remix/config'); models.value = data.models;
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

async function toggle(item: Item) {
  item.selected = !item.selected;
  try { await request('/template-remix/items/selection', { method: 'PATCH', body: JSON.stringify({ items: [{ itemId: item.id, selected: item.selected }] }) }); }
  catch (reason) { item.selected = !item.selected; error.value = reason instanceof Error ? reason.message : '选择保存失败'; }
}

async function regenerate(item: Item) {
  loading.value = true;
  try { await request(`/template-remix/items/${encodeURIComponent(item.id)}/regenerate`, { method: 'POST', body: JSON.stringify({ promptAddition: prompt.value }) }); await openBatch(item.id ? activeBatch.value!.id : ''); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '重新生成失败'; }
  finally { loading.value = false; }
}

async function uploadSelected() {
  if (!selectedItems.value.length || !window.confirm(`确定将 ${selectedItems.value.length} 个候选模板写入正式模板库吗？`)) return;
  loading.value = true;
  try {
    const data = await request('/template-remix/items/upload', { method: 'POST', body: JSON.stringify({ items: selectedItems.value.map((item) => ({ itemId: item.id, attemptId: item.currentAttemptId })) }) });
    const succeeded = data.results.filter((result: { status: string }) => result.status === 'UPLOADED').length;
    notice.value = `成功入库 ${succeeded}/${data.results.length} 个模板`; await refresh();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '批量入库失败'; }
  finally { loading.value = false; }
}

function onSources(event: Event) { sourceFiles.value = Array.from((event.target as HTMLInputElement).files ?? []); }
function onSubject(event: Event) { subjectFile.value = (event.target as HTMLInputElement).files?.[0] ?? null; }

watch(() => props.adminKey, async () => { try { await Promise.all([loadConfig(), loadBatches()]); } catch { /* 页脚输入过程中不打断用户 */ } });
onMounted(async () => {
  try { await Promise.all([loadConfig(), loadBatches()]); } catch (reason) { if (props.adminKey) error.value = reason instanceof Error ? reason.message : '初始化失败'; }
  pollTimer = window.setInterval(() => { if (activeCount.value > 0) void refresh(); }, 5000);
});
onBeforeUnmount(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<template>
  <main class="remix-main">
    <div class="page-heading"><div><p class="eyebrow">CONTENT OPERATIONS / 02</p><h1>模板主体批量替换</h1><p class="subheading">批量生成候选结果，人工预览后再写入正式模板库</p></div><button class="secondary" :disabled="loading" @click="refresh">刷新状态</button></div>
    <div v-if="error" class="banner error" role="alert">{{ error }} <button aria-label="关闭错误" @click="error = ''">关闭</button></div>
    <div v-if="notice" class="banner success" role="status">{{ notice }}</div>
    <section class="remix-setup" aria-labelledby="batch-setup-title">
      <div class="section-title"><div><h3 id="batch-setup-title">新建替换批次</h3><p>同一批次使用一个主体，同时处理多个图片或视频模板</p></div><span class="count">{{ sourceFiles.length }} 个模板</span></div>
      <div class="remix-form-grid">
        <label>批次名称<input v-model="batchName" maxlength="200" /></label>
        <label>主体参考图片<input type="file" accept="image/*" @change="onSubject" /><small>{{ subjectFile?.name || '支持一张主体图片' }}</small></label>
        <label>图片正式模板模型<select v-model="imageModelCode"><option v-for="model in imageModels" :key="model.id" :value="model.code">{{ model.name }}</option></select></label>
        <label>视频正式模板模型<select v-model="videoModelCode"><option v-for="model in videoModels" :key="model.id" :value="model.code">{{ model.name }}</option></select></label>
        <label class="span-2">三方模板文件<input type="file" accept="image/*,video/mp4,video/quicktime" multiple @change="onSources" /><small>可同时选择多张图片和多个 MP4/MOV 视频</small></label>
        <label class="span-2">替换要求<textarea v-model="prompt" rows="3" placeholder="例如：保持品牌文字完全不变，主体服装使用参考图样式" /></label>
      </div>
      <div class="setup-actions"><span>生成结果只进入候选区，不会自动发布。</span><button class="primary" :disabled="uploading" @click="createAndStart">{{ uploading ? '上传并创建中…' : '开始批量替换' }}</button></div>
    </section>
    <section class="remix-console">
      <aside class="batch-list" aria-label="替换批次列表">
        <div class="catalog-header"><span>批次</span><span class="count">{{ batches.length }}</span></div>
        <button v-for="batch in batches" :key="batch.id" class="batch-row" :class="{ selected: activeBatch?.id === batch.id }" @click="openBatch(batch.id)"><strong>{{ batch.name }}</strong><small>{{ batch.itemCount }} 项 · {{ batch.status }}</small></button>
        <div v-if="!batches.length" class="empty-list">暂无批次</div>
      </aside>
      <div class="candidate-panel">
        <div v-if="activeBatch" class="candidate-head"><div><h2>{{ activeBatch.name }}</h2><p>{{ activeBatch.status }} · {{ activeBatch.itemCount }} 个模板</p></div><button class="primary" :disabled="!selectedItems.length || loading" @click="uploadSelected">上传数据库（{{ selectedItems.length }}）</button></div>
        <div v-if="activeBatch" class="status-strip"><span>排队 {{ activeBatch.counts?.QUEUED || 0 }}</span><span>生成中 {{ activeBatch.counts?.RUNNING || 0 }}</span><span>可预览 {{ activeBatch.counts?.READY || 0 }}</span><span>失败 {{ activeBatch.counts?.FAILED || 0 }}</span><span>已入库 {{ activeBatch.counts?.UPLOADED || 0 }}</span></div>
        <div v-if="activeBatch?.items?.length" class="candidate-grid">
          <article v-for="item in activeBatch.items" :key="item.id" class="candidate-card" :class="{ checked: item.selected }">
            <div class="candidate-media"><video v-if="item.mediaType === 'VIDEO'" :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" controls preload="metadata" /><img v-else :src="item.currentAttempt?.resultAsset?.url || item.sourceAsset.url" :alt="item.sourceKey" loading="lazy" /></div>
            <div class="candidate-copy"><label class="candidate-check"><input type="checkbox" :checked="item.selected" :disabled="item.status !== 'READY'" @change="toggle(item)" /><span>{{ item.sourceKey }}</span></label><span class="state-pill" :data-state="item.status">{{ item.status }}</span></div>
            <p v-if="item.currentAttempt?.providerError" class="item-error">{{ item.currentAttempt.providerError.code }} · {{ item.currentAttempt.providerError.message }}</p>
            <div class="candidate-actions"><small>{{ item.mediaType }} · 第 {{ item.currentAttempt?.sequence || 0 }} 次</small><button class="secondary" :disabled="loading || item.status === 'UPLOADED'" @click="regenerate(item)">重新生成</button></div>
          </article>
        </div>
        <div v-else class="welcome"><div class="welcome-mark">V</div><h2>候选结果工作台</h2><p>创建批次或从左侧选择已有批次。</p></div>
      </div>
    </section>
  </main>
</template>
