<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ url?: string; video?: boolean }>();
const previewUrl = ref('');
const failed = ref(false);

watch(() => [props.url, props.video] as const, ([url], _, onCleanup) => {
  previewUrl.value = '';
  failed.value = false;
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
    <small v-if="failed" role="status">无法加载预览，请检查链接是否可访问。</small>
    <video v-else-if="video" :src="previewUrl" preload="auto" muted playsinline aria-label="视频首帧预览" @error="failed = true" />
    <img v-else :src="previewUrl" alt="图片链接预览" @error="failed = true" />
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
