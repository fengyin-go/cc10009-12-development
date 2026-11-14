<template>
  <span class="badge" :class="badgeClass">{{ status }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import type { BatchStatus, FileState } from '@/data/landing'

const props = defineProps<{ status: BatchStatus | FileState }>()

const CLASS_MAP: Record<string, string> = {
  写入中: 'write',
  已提交: 'committed',
  提交失败: 'failed',
  已回滚: 'rollback',
  已归档: 'archived',
  临时: 'temp',
  正式: 'formal',
}

const badgeClass = computed(() => CLASS_MAP[props.status] ?? 'archived')
</script>
