<script setup lang="ts">
import { computed } from 'vue';
import RemixMediaPreview from './RemixMediaPreview.vue';
import { mediaMime, subjectsForImport, type ImportSource, type ImportSubject } from './remix-excel';
const props = defineProps<{ source: ImportSource; role: 'INPUT' | 'COVER' | 'PREVIEW'; subjectNames: string[] }>();
const accept = computed(() => props.role === 'COVER' ? 'image/*' : props.role === 'PREVIEW' ? 'video/*,image/gif,image/webp' : 'image/*,video/*');
function onSource(event: Event, source: ImportSource) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  source.file = file; source.url = undefined;
  source.name = file.name; source.mimeType = file.type || mediaMime(file.name);
}
function onSourceUrl(event: Event, source: ImportSource) {
  source.url = (event.target as HTMLInputElement).value.trim();
  if (!source.url) return;
  source.file = undefined;
  source.name = source.url.split(/[?#]/)[0]?.split('/').pop() || '链接素材';
  source.mimeType = mediaMime(source.url) || (props.role === 'PREVIEW' ? 'video/mp4' : 'image/jpeg');
}
const subjects = computed(() => subjectsForImport(props.source));
function addSubject() {
  const subjectName = props.subjectNames[subjects.value.length];
  if (!subjectName) return;
  props.source.subjects = [...subjects.value, {}];
  props.source.keepOriginal = false;
}
function removeSubject(index: number) { props.source.subjects = subjects.value.filter((_, i) => i !== index); }
function onSubject(event: Event, subject: ImportSubject) {
  subject.file = (event.target as HTMLInputElement).files?.[0]; subject.url = undefined;
}
function onSubjectUrl(event: Event, subject: ImportSubject) {
  subject.url = (event.target as HTMLInputElement).value.trim(); subject.file = undefined;
}
</script>
<template>
  <div class="asset-columns">
    <div class="subject-cell">
      <label>原素材上传（与链接任选其一）
        <input :key="source.file ? 'file' : 'empty'" type="file" :accept="accept" @change="onSource($event, source)" />
        <small v-if="source.file">{{ source.file.name }}</small>
      </label>
      <RemixMediaPreview v-if="source.file" :file="source.file" :video="source.mimeType.startsWith('video/')" />
    </div>
    <div class="subject-cell">
      <label>原素材链接（与文件任选其一）
        <input type="url" :value="source.url || ''" maxlength="2048" placeholder="HTTP(S) 链接" @input="onSourceUrl($event, source)" />
        <small v-if="source.url && mediaMime(source.url)">已识别为{{ mediaMime(source.url).startsWith('video/') ? '视频' : '图片' }}</small>
        <select v-if="!source.file && source.url && !mediaMime(source.url)" v-model="source.mimeType" aria-label="无后缀链接类型">
          <option v-if="role !== 'PREVIEW'" value="image/jpeg">静态图片</option>
          <option value="image/gif">GIF 动图</option><option value="image/webp">WebP 图片 / 动图</option>
          <option v-if="role !== 'COVER'" value="video/mp4">视频</option>
        </select>
      </label>
      <RemixMediaPreview v-if="!source.file" :url="source.url" :video="source.mimeType.startsWith('video/')" />
    </div>
    <div class="subject-cell">
      <strong>主体组（可选，最多 4 个）</strong>
      <div v-for="(subject, index) in subjects" :key="index" class="subject-cell">
        <strong>{{ subjectNames[index] }}</strong>
        <label>主体图片<input type="file" accept="image/*" @change="onSubject($event, subject)" /></label>
        <small v-if="subject.file">{{ subject.file.name }}</small>
        <label>主体图片链接<input type="url" :value="subject.url || ''" maxlength="2048" placeholder="或填写图片链接" @input="onSubjectUrl($event, subject)" /></label>
        <RemixMediaPreview :file="subject.file" :url="subject.url" />
        <small>提示词引用：@{{ subjectNames[index] }}</small>
        <button type="button" class="secondary" @click="removeSubject(index)">移除此主体</button>
      </div>
      <button v-if="subjects.length < subjectNames.length" type="button" class="secondary" @click="addSubject">＋ 添加主体</button>
      <small v-if="!subjects.length">未配置主体，保留原素材</small>
    </div>
  </div>
  <label>此素材替换要求<textarea v-model="source.prompt" rows="2" maxlength="5000" placeholder="例如：将左侧人物替换为 @主体1，右侧人物替换为 @主体2" /></label>
</template>
<style scoped>
.asset-columns { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; align-items:start; }
.asset-columns > *, .subject-cell { min-width:0; }
label, .subject-cell { display:grid; gap:8px; }
input { max-width:100%; box-sizing:border-box; }
@media (max-width:900px) { .asset-columns { grid-template-columns:minmax(0,1fr); } }
</style>
