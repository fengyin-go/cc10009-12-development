<template>
  <section class="page" data-module="export">
    <header class="page-head">
      <div>
        <h2>数据分发管理</h2>
        <p class="page-desc">
          分发只能读取落盘已完成提交的批次；写入中、失败或回滚的半分区不会提前出现在分发清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出数据分发清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</p>

    <!-- 通道配置 -->
    <div class="section-card">
      <h3>分发通道配置</h3>
      <div class="scroll-x">
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="String(row.id)">
              <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
              <td>{{ row.status }}</td>
              <td class="row-actions">
                <button
                  v-for="action in actions"
                  :key="action"
                  class="link"
                  type="button"
                  @click="runConfigAction(action, row)"
                >
                  {{ action }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 可读数据集（只来自已提交落盘结果） -->
    <div class="section-card">
      <h3>分发清单可读数据集（仅已提交 / 已归档批次）</h3>
      <p class="section-tip">
        落盘被阻断时数据集不会提前出现；已归档批次仍按原文件格式与路径回读。
      </p>
      <article
        v-for="entry in catalog"
        :key="entry.channelId"
        class="section-card"
        :class="{ 'notice err': entry.blockedCount > 0 && entry.readableFiles.length === 0 }"
        style="margin-bottom:10px"
      >
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px">
          <div>
            <strong>{{ entry.channelId }}</strong>
            <span class="muted-text">数据集「{{ entry.dataset }}」→ {{ entry.targetSystem }}</span>
            <span class="badge" :class="entry.channelEnabled ? 'formal' : 'archived'">
              {{ entry.channelEnabled ? '通道已启用' : '通道未启用' }}
            </span>
          </div>
          <button class="btn small primary" type="button" @click="tryRead(entry.channelId)">尝试读取数据集</button>
        </div>

        <p class="muted-text" style="margin:8px 0 4px">
          可读批次 {{ entry.readableBatches.length }} 个 · 可读文件 {{ entry.readableFiles.length }} 个
          <template v-if="entry.blockedCount">
            · <span class="error-text">落盘阻断 {{ entry.blockedCount }} 个批次（{{ entry.blockedBatchIds.join('、') }}）</span>
          </template>
        </p>
        <ul v-if="entry.readableFiles.length" class="file-list">
          <li v-for="file in entry.readableFiles" :key="file.path">
            <span class="mono">{{ file.path }}</span>
            <span class="muted-text">（{{ file.format }} · {{ file.size }}B · {{ file.checksum }}）</span>
          </li>
        </ul>
        <p v-else class="notice warn" style="margin:6px 0 0">
          暂无可读文件：落盘尚未完成完整提交，分发清单不提供该数据集
        </p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, runAction as applyAction } from '@/api/local-service'
import { buildDistributionCatalog, readDataset, type DistributionEntry } from '@/data/landing'
import type { EntryRow } from '@/data/types'

const columns = ['通道编号', '输出数据集', '目标系统', '分发格式', '传输协议', '频率控制', '加密开关', '完整性校验']
const actions = ['提交校验', '启用通道', '停用通道']

const rows = ref<EntryRow[]>([])
const catalog = ref<DistributionEntry[]>([])
const notice = ref<{ text: string; kind: 'ok' | 'err' | 'warn' } | null>(null)

const stats = computed(() => [
  { label: '分发通道总数', value: rows.value.length },
  { label: '可读数据集', value: catalog.value.filter((item) => item.readableFiles.length > 0).length },
  { label: '被落盘阻断', value: catalog.value.reduce((sum, item) => sum + item.blockedCount, 0) },
  { label: '可读文件总数', value: catalog.value.reduce((sum, item) => sum + item.readableFiles.length, 0) },
])

function reload() {
  rows.value = listEntries('export').items
  catalog.value = buildDistributionCatalog()
}

function flash(text: string, kind: 'ok' | 'err' | 'warn' = 'ok') {
  notice.value = { text, kind }
}

function runConfigAction(action: string, row: EntryRow) {
  const result = applyAction('export', Number(row.id), action)
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function tryRead(channelId: string) {
  const result = readDataset(channelId)
  flash(result.message, result.ok ? 'ok' : 'err')
}

function exportRows() {
  downloadEntries('export')
}

onMounted(reload)
</script>
