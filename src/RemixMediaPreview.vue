<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ url?: string; file?: File; video?: boolean }>();
const previewUrl = ref('');
const failed = ref(false);

watch(() => [props.url, props.video, props.file] as const, ([url, , file], _, onCleanup) => {
  previewUrl.value = '';
  failed.value = false;
  if (file) {
    const objectUrl = URL.createObjectURL(file);
    previewUrl.value = objectUrl;
    onCleanup(() => URL.revokeObjectURL(objectUrl));
    return;
  }
  if (!url) return;
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return;
  } catch {
    return;
  }
  const timer = window.setTimeout(() => { previewUrl.value = url; }, 300);
  onCleanup(() => window.clearTimeout(timer));
}, { immediate: true });
</script>

<template>
  <div v-if="previewUrl">
    <small v-if="failed" role="status">{{ file ? '无法预览此文件，请检查文件格式。' : '无法加载预览，请检查链接是否可访问。' }}</small>
    <video v-else-if="video" :src="previewUrl" preload="auto" muted playsinline aria-label="视频首帧预览" @error="failed = true" />
    <img v-else :src="previewUrl" alt="图片预览" @error="failed = true" />
  </div>
</template>

<style scoped>
img, video {
  display: block;
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: 8px;
}
</style>
