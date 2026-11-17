<script setup lang="ts">
import { computed } from 'vue';
import { mediaMime, type ImportSource } from './remix-excel';
const props = defineProps<{ source: ImportSource; role: 'INPUT' | 'COVER' | 'PREVIEW' }>();
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
function onSubjectUrl(event: Event, source: ImportSource) {
  source.subjectUrl = (event.target as HTMLInputElement).value.trim();
  source.subjectFile = undefined; source.keepOriginal = false;
}
function onSubject(event: Event, target: ImportSource) {
  target.subjectFile = (event.target as HTMLInputElement).files?.[0]; target.subjectUrl = undefined;
  if ('mimeType' in target) target.keepOriginal = false;
}
</script>
<template>
  <div class="asset-columns">
    <label>原素材上传（与链接任选其一）
      <input :key="source.file ? 'file' : 'empty'" type="file" :accept="accept" @change="onSource($event, source)" />
      <small v-if="source.file">{{ source.file.name }}</small>
    </label>
    <label>原素材链接（与文件任选其一）
      <input type="url" :value="source.url || ''" maxlength="2048" placeholder="HTTP(S) 链接" @input="onSourceUrl($event, source)" />
      <small v-if="source.url && mediaMime(source.url)">已识别为{{ mediaMime(source.url).startsWith('video/') ? '视频' : '图片' }}</small>
      <select v-if="!source.file && source.url && !mediaMime(source.url)" v-model="source.mimeType" aria-label="无后缀链接类型">
        <option v-if="role !== 'PREVIEW'" value="image/jpeg">静态图片</option>
        <option value="image/gif">GIF 动图</option><option value="image/webp">WebP 图片 / 动图</option>
        <option v-if="role !== 'COVER'" value="video/mp4">视频</option>
      </select>
    </label>
    <div class="subject-cell">
      <label>主体图片（可选）<input :key="source.subjectFile ? 'subject' : 'no-subject'" type="file" accept="image/*" @change="onSubject($event, source)" /></label>
      <small v-if="source.subjectFile">{{ source.subjectFile.name }}</small>
      <label>主体图片链接<input type="url" :value="source.subjectUrl || ''" maxlength="2048" placeholder="或填写主体图片链接" @input="onSubjectUrl($event, source)" /></label>
      <small>{{ source.subjectFile || source.subjectUrl ? '仅替换此素材的主体' : '未配置主体，保留原素材' }}</small>
      <button v-if="source.subjectFile || source.subjectUrl" type="button" class="secondary" @click="source.subjectFile = undefined; source.subjectUrl = undefined; source.keepOriginal = true">清除主体</button>
    </div>
  </div>
  <label>此素材替换要求<textarea v-model="source.prompt" rows="2" maxlength="5000" /></label>
</template>
<style scoped>
.asset-columns { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; align-items:start; }
.asset-columns > *, .subject-cell { min-width:0; }
label, .subject-cell { display:grid; gap:8px; }
input { max-width:100%; box-sizing:border-box; }
@media (max-width:900px) { .asset-columns { grid-template-columns:minmax(0,1fr); } }
</style>
