<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from 'vue';

type ModelOption = { value: string; label: string; isDefault: boolean; thumbnail?: string | null };
type ModelParam = { key: string; label: string; description?: string | null; type: string; required: boolean; defaultValue?: string | null; min?: number | null; max?: number | null; unit?: string | null; options: ModelOption[] };
type Model = { id: string; code: string; name: string; modality: string; params: ModelParam[] };
type Episode = { id?: string; number: number; title: string; synopsis: string; storyBeat: unknown; durationSeconds: number | null; minDurationSeconds: number; maxDurationSeconds: number; mediaAssets: unknown[]; referenceAssets: unknown[]; agents: unknown[]; promptTemplate: string; negativePrompt: string | null; defaultParams: Record<string, unknown> | null; premium: boolean; active: boolean; modelCode: string; parameters: Record<string, unknown> };
type Template = { id: string; slug: string; title: string; type: string; category: string; genreId: string | null; description: string; storyBackground: unknown; coverUrl: string; tags: string[]; audience: string | null; marketScore: number; sourceMeta: unknown; status: string; premium: boolean; active: boolean; sortOrder: number; publishedAt: string | null; episodes: Episode[] };
const apiBase = import.meta.env.VITE_API_BASE || 'http://localhost:3010/api';
const adminKey = ref(localStorage.getItem('templateAdminKey') || '');
const templates = ref<Template[]>([]);
const activeType = ref<'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION'>('COMIC_DRAMA');
const models = ref<Model[]>([]);
const selectedId = ref('');
const draft = ref<Template | null>(null);
const activeEpisode = ref(0);
const loading = ref(false);
const notice = ref('');
const error = ref('');
const currentEpisode = computed(() => draft.value?.episodes[activeEpisode.value]);
const selectedModel = computed(() => models.value.find((model) => model.code === currentEpisode.value?.modelCode));
const visibleTemplates = computed(() => templates.value.filter((template) => template.type === activeType.value));
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
  if (draft.value.publishedAt) {
    const date = new Date(draft.value.publishedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    draft.value.publishedAt = local.toISOString().slice(0, 16);
  }
  activeEpisode.value = 0;
}
function openTemplate(template: Template) {
  selectedId.value = template.id;
  draft.value = structuredClone(toRaw(template));
  if (draft.value.publishedAt) {
    const date = new Date(draft.value.publishedAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    draft.value.publishedAt = local.toISOString().slice(0, 16);
  }
  activeEpisode.value = 0;
}
function emptyEpisode(number: number): Episode {
  const model = models.value[0];
  return { number, title: `第 ${number} 集`, synopsis: '', storyBeat: null, durationSeconds: null, minDurationSeconds: 10, maxDurationSeconds: 30, mediaAssets: [], referenceAssets: [], agents: [], promptTemplate: '', negativePrompt: '', defaultParams: {}, premium: false, active: true, modelCode: model?.code || '', parameters: Object.fromEntries((model?.params || []).map((param) => [param.key, defaultParamValue(param)])) };
}
function createTemplate() {
  if (!models.value.length) { error.value = '数据库中没有可选模型'; return; }
  const id = `new-${Date.now()}`;
  const model = models.value[0];
  const episode = emptyEpisode(1);
  draft.value = { id, slug: '', title: '', type: activeType.value, category: '', genreId: null, description: '', storyBackground: {}, coverUrl: '', tags: [], audience: null, marketScore: 0, sourceMeta: null, status: 'DRAFT', premium: false, active: true, sortOrder: 0, publishedAt: null, episodes: [episode] };
  selectedId.value = id;
  activeEpisode.value = 0;
  if (model) episode.modelCode = model.code;
}
function selectType(type: 'COMIC_DRAMA' | 'SHORT_VIDEO' | 'IMAGE_GENERATION') {
  activeType.value = type;
  draft.value = null;
  selectedId.value = '';
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
    const { id, episodes, ...fields } = draft.value;
    const payload = { ...fields, publishedAt: fields.publishedAt ? new Date(fields.publishedAt).toISOString() : null, episodes };
    const result = id.startsWith('new-')
      ? await request('/templates', { method: 'POST', body: JSON.stringify(payload) })
      : await request(`/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    await load();
    if (result?.template?.id) selectTemplateById(result.template.id);
    notice.value = '模板已保存';
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败'; }
  finally { loading.value = false; }
}
async function removeTemplate() {
  if (!draft.value || draft.value.id.startsWith('new-')) { draft.value = null; selectedId.value = ''; return; }
  if (!window.confirm(`确定删除「${draft.value.title}」及其全部剧集吗？`)) return;
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
          <div class="search-row"><span>⌕</span><input placeholder="搜索模板" /></div>
          <div v-if="!visibleTemplates.length" class="empty-list">{{ loading ? '正在加载…' : '暂无模板' }}</div>
          <button v-for="item in visibleTemplates" :key="item.id" type="button" class="template-row" :class="{ selected: selectedId === item.id }" @click="openTemplate(item)">
            <img :src="item.coverUrl || 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=300'" alt="" />
            <span class="row-copy"><strong>{{ item.title }}</strong><small>{{ item.category || '未分类' }} · {{ item.episodes.length }} 集</small></span>
            <span class="status-dot" :class="item.status.toLowerCase()" :title="item.status"></span>
          </button>
        </aside>
        <section v-if="draft" class="editor">
          <div class="editor-head"><div><div class="breadcrumbs">模板库 <span>/</span> {{ draft.id.startsWith('new-') ? '新建模板' : draft.slug }}</div><h2>{{ draft.title || '未命名模板' }}</h2></div><div class="editor-actions"><button class="danger-quiet" @click="removeTemplate">删除</button><button class="primary" :disabled="loading" @click="save">{{ loading ? '保存中…' : '保存更改' }}</button></div></div>
          <div class="tabbar"><button class="tab active">模板信息</button><span class="divider"></span><button class="tab active">剧集配置</button><span class="spacer"></span><span class="saved-label">{{ draft.status }}</span></div>
          <div class="editor-content">
            <section class="form-section"><div class="section-title"><div><h3>基本信息</h3><p>模板在客户端展示的名称、分类和封面</p></div></div>
              <div class="form-grid"><label>模板名称<input v-model="draft.title" maxlength="200" placeholder="输入模板名称" /></label><label>唯一标识<input v-model="draft.slug" maxlength="160" placeholder="例如: neon-dream" /></label><label>类型<input :value="draft.type === 'COMIC_DRAMA' ? '漫剧' : draft.type === 'SHORT_VIDEO' ? '视频' : '图片'" readonly /></label><label>分类<input v-model="draft.category" placeholder="例如：科幻 / 爱情" /></label><label class="span-2">封面图 URL<input v-model="draft.coverUrl" placeholder="https://..." /></label><label class="span-2">描述<textarea v-model="draft.description" rows="3" placeholder="模板简介"></textarea></label><label>状态<select v-model="draft.status"><option value="DRAFT">草稿</option><option value="PUBLISHED">已发布</option><option value="ARCHIVED">已归档</option></select></label><label>标签<input :value="draft.tags.join(', ')" placeholder="逗号分隔" @input="draft.tags = ($event.target as HTMLInputElement).value.split(',').map((tag) => tag.trim()).filter(Boolean)" /></label><label>目标受众<input v-model="draft.audience" placeholder="可选" /></label><label>市场评分<input v-model.number="draft.marketScore" type="number" min="0" max="100" step="0.01" /></label></div>
              <div class="switch-row"><label><input v-model="draft.active" type="checkbox" /> 启用模板</label><label><input v-model="draft.premium" type="checkbox" /> 付费模板</label><label>排序权重 <input v-model.number="draft.sortOrder" type="number" class="short-input" /></label></div>
              <details class="advanced-fields"><summary>故事背景与来源数据</summary><div class="form-grid"><label>故事背景 JSON<textarea :value="JSON.stringify(draft.storyBackground, null, 2)" rows="5" @change="parseJsonField($event, (value) => { draft!.storyBackground = value; })"></textarea></label><label>来源元数据 JSON<textarea :value="JSON.stringify(draft.sourceMeta, null, 2)" rows="5" @change="parseJsonField($event, (value) => { draft!.sourceMeta = value; })"></textarea></label><label>题材 ID<input v-model="draft.genreId" placeholder="数据库 Genre ID，可留空" /></label><label>发布时间<input v-model="draft.publishedAt" type="datetime-local" /></label></div></details>
            </section>
            <section class="form-section episode-section"><div class="section-title"><div><h3>剧集与生成参数</h3><p>为每集选择模型并设置模型所需参数</p></div><button class="secondary" @click="addEpisode">＋ 添加剧集</button></div>
              <div class="episode-tabs"><button v-for="(episode, index) in draft.episodes" :key="index" :class="{ active: activeEpisode === index }" @click="activeEpisode = index">EP {{ String(index + 1).padStart(2, '0') }}</button><button class="add-tab" title="移除当前剧集" @click="removeEpisode">−</button></div>
              <template v-if="currentEpisode">
                <div class="form-grid episode-grid"><label>剧集序号<input v-model.number="currentEpisode.number" type="number" min="1" max="1000000" /></label><label>剧集标题<input v-model="currentEpisode.title" placeholder="剧集名称" /></label><label>简介<input v-model="currentEpisode.synopsis" placeholder="本集概要" /></label><label>使用模型<select :value="currentEpisode.modelCode" @change="changeModel(($event.target as HTMLSelectElement).value)"><option disabled value="">选择数据库模型</option><option v-for="model in models" :key="model.id" :value="model.code">{{ model.name }} · {{ model.modality }}</option></select></label><label>时长范围（秒）<span class="input-pair"><input v-model.number="currentEpisode.minDurationSeconds" type="number" min="5" /><input v-model.number="currentEpisode.maxDurationSeconds" type="number" min="5" /></span></label><label class="span-2">正向提示词<textarea v-model="currentEpisode.promptTemplate" rows="4" placeholder="输入模板提示词"></textarea></label><label class="span-2">负向提示词<textarea v-model="currentEpisode.negativePrompt" rows="2" placeholder="不希望生成的内容"></textarea></label></div>
                <div v-if="selectedModel" class="params-block"><div class="params-heading"><div><h4>模型参数</h4><span>{{ selectedModel.name }} · {{ selectedModel.code }}</span></div><span class="param-count">{{ selectedModel.params.length }} 项</span></div><div v-if="!selectedModel.params.length" class="empty-params">此模型没有可配置参数</div><div v-for="param in selectedModel.params" :key="param.key" class="param-row"><div class="param-meta"><strong>{{ param.label }} <em v-if="param.required">必填</em></strong><code>{{ param.key }}</code><small>{{ param.description || (param.required ? '必填参数' : '可选参数') }}</small></div><select v-if="param.type === 'SELECT'" v-model="currentEpisode.parameters[param.key]"><option v-for="option in param.options" :key="option.value" :value="option.value">{{ option.label }}{{ option.isDefault ? '（默认）' : '' }}</option></select><input v-else-if="param.type === 'NUMBER'" v-model.number="currentEpisode.parameters[param.key]" type="number" :min="param.min ?? undefined" :max="param.max ?? undefined" :placeholder="String(param.defaultValue ?? '输入数值')" /><select v-else-if="param.type === 'BOOLEAN'" v-model="currentEpisode.parameters[param.key]"><option :value="true">开启</option><option :value="false">关闭</option></select><input v-else v-model="currentEpisode.parameters[param.key]" :placeholder="String(param.defaultValue ?? '可选')" /></div></div>
                <div class="switch-row episode-switches"><label><input v-model="currentEpisode.active" type="checkbox" /> 启用剧集</label><label><input v-model="currentEpisode.premium" type="checkbox" /> 付费剧集</label><label>时长（秒）<input v-model.number="currentEpisode.durationSeconds" type="number" min="1" class="short-input" /></label></div>
                <details class="advanced-fields"><summary>引用素材与高级数据</summary><div class="form-grid"><label>引用图 / 素材 JSON<textarea :value="JSON.stringify(currentEpisode.referenceAssets, null, 2)" rows="5" placeholder='[{"url":"...","type":"image"}]' @change="parseJsonField($event, (value) => { if (Array.isArray(value)) currentEpisode!.referenceAssets = value; else error = '引用素材必须是数组'; })"></textarea></label><label>成片素材 JSON<textarea :value="JSON.stringify(currentEpisode.mediaAssets, null, 2)" rows="5" @change="parseJsonField($event, (value) => { if (Array.isArray(value)) currentEpisode!.mediaAssets = value; else error = '成片素材必须是数组'; })"></textarea></label><label>Agent 配置 JSON<textarea :value="JSON.stringify(currentEpisode.agents, null, 2)" rows="5" @change="parseJsonField($event, (value) => { if (Array.isArray(value)) currentEpisode!.agents = value; else error = 'Agent 配置必须是数组'; })"></textarea></label><label>故事节拍 JSON<textarea :value="JSON.stringify(currentEpisode.storyBeat, null, 2)" rows="5" @change="parseJsonField($event, (value) => { currentEpisode!.storyBeat = value; })"></textarea></label><label class="span-2">默认参数附加数据 JSON<textarea :value="JSON.stringify(currentEpisode.defaultParams, null, 2)" rows="4" @change="parseJsonField($event, (value) => { if (value && typeof value === 'object' && !Array.isArray(value)) currentEpisode!.defaultParams = value as Record<string, unknown>; else error = '默认参数必须是 JSON 对象'; })"></textarea></label></div></details>
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
