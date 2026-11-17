<script setup lang="ts">
import { ref } from 'vue';
import RemixMediaWorkspace from './RemixMediaWorkspace.vue';
defineProps<{ adminKey: string }>();
const activeTab = ref<'IMAGE' | 'VIDEO'>('IMAGE');
</script>

<template>
  <nav class="remix-tabs" aria-label="主体替换类型">
    <button v-for="tab in ([{ type: 'IMAGE', name: '图片模板' }, { type: 'VIDEO', name: '视频模板' }] as const)" :key="tab.type" :aria-pressed="activeTab === tab.type" @click="activeTab = tab.type">{{ tab.name }}</button>
  </nav>
  <RemixMediaWorkspace v-show="activeTab === 'IMAGE'" template-type="IMAGE_GENERATION" :admin-key="adminKey" />
  <RemixMediaWorkspace v-show="activeTab === 'VIDEO'" template-type="SHORT_VIDEO" :admin-key="adminKey" />
</template>

<style scoped>
.remix-tabs { display:flex; gap:12px; padding:20px 32px 0; }
.remix-tabs button[aria-pressed="true"] { background:#254d3b; color:white; }
</style>
