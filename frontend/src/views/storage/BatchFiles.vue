<template>
  <div class="file-panel">
    <p class="muted-text">
      分区 <span class="mono">{{ batch.partition }}</span> · 策略 {{ batch.strategy }} ·
      共 {{ batch.files.length }} 个文件 · 记录 {{ batch.recordCount }} 条
      <template v-if="batch.committedAt"> · 完成时间 {{ formatClock(batch.committedAt) }}</template>
    </p>
    <ul class="file-list">
      <li v-for="file in batch.files" :key="file.seq">
        <StatusBadge :status="file.state" />
        <span class="mono">{{ file.state === '临时' ? file.tempPath : file.path }}</span>
        <span class="muted-text">（{{ file.format }} · {{ file.size }}B · {{ file.checksum }}）</span>
      </li>
    </ul>
    <p v-if="batch.failReason" class="notice err">{{ batch.failReason }}</p>
    <p v-if="batch.lostTo" class="muted-text">覆写冲突负于批次：{{ batch.lostTo }}</p>
  </div>
</template>

<script setup lang="ts">
import { formatClock, type LandingBatch } from '@/data/landing'

import StatusBadge from './StatusBadge.vue'

defineProps<{ batch: LandingBatch }>()
</script>
