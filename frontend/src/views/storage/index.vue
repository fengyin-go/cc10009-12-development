<template>
  <section class="page" data-module="storage">
    <header class="page-head">
      <div>
        <h2>数据落盘管理</h2>
        <p class="page-desc">
          按分区策略生成文件，依据覆写模式原子提交，按保留天数归档；分发侧只能读取已完成提交的批次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="downloadManifest">导出批次清单</button>
        <button class="btn ghost" type="button" @click="resetAll">重置落盘现场</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tab-row">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <p v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</p>

    <!-- 落盘配置 -->
    <div v-if="activeTab === 'config'" class="section-card">
      <h3>落盘配置（决定分区策略、覆写模式与保留天数）</h3>
      <p class="section-tip">分区策略变更只影响新批次；历史文件按写入时的分区路径回读，不会被重算。</p>
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

    <!-- 分区文件与批次 -->
    <div v-if="activeTab === 'batch'" class="section-card">
      <h3>发起落盘写入（事务：先临时文件，提交才转正）</h3>
      <form class="inline-form" @submit.prevent="submitWrite">
        <label>存储配置
          <select v-model="writeForm.configId">
            <option v-for="row in rows" :key="String(row.id)" :value="String(row['配置编号'])">
              {{ row['配置编号'] }}
            </option>
          </select>
        </label>
        <label>输出数据集
          <input v-model="writeForm.dataset" placeholder="如 订单数据集" required />
        </label>
        <label>业务日期
          <input v-model="writeForm.bizDate" type="date" />
        </label>
        <label>文件数
          <input v-model.number="writeForm.fileCount" type="number" min="1" />
        </label>
        <label>记录数
          <input v-model.number="writeForm.recordCount" type="number" min="1" />
        </label>
        <label>覆写模式
          <select v-model="writeForm.overwriteMode">
            <option>冲突拒绝</option>
            <option>整批覆盖</option>
            <option>追加写入</option>
          </select>
        </label>
        <label>故障注入：第几文件出错
          <input v-model.number="writeForm.failAtFile" type="number" min="0" placeholder="0=正常" />
        </label>
        <button class="btn primary" type="submit">生成临时文件</button>
      </form>
    </div>

    <div v-if="activeTab === 'batch'" class="section-card">
      <h3>分区文件清单与完成状态</h3>
      <p class="section-tip">
        同一分区同时只允许一个批次提交；写入中批次持有分区锁，失败写入回滚临时文件并保留可重试位置。
      </p>
      <div v-if="!batches.length" class="empty-state">暂无落盘批次</div>
      <article v-for="batch in batches" :key="batch.id" class="section-card" style="margin-bottom: 10px">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap">
          <div>
            <strong>{{ batch.id }}</strong>
            <StatusBadge :status="batch.status" />
            <span class="muted-text">{{ batch.configId }} · {{ batch.dataset }} · 覆写：{{ batch.overwriteMode }}</span>
            <span v-if="isLocked(batch)" class="badge write">持有分区锁</span>
          </div>
          <div class="row-actions">
            <button
              v-if="batch.status === '写入中'"
              class="btn small success"
              type="button"
              @click="submitCommit(batch.id)"
            >
              原子提交
            </button>
            <button
              v-if="batch.status === '写入中'"
              class="btn small danger"
              type="button"
              @click="rollback(batch.id)"
            >
              回滚临时文件
            </button>
            <button
              v-if="batch.status === '提交失败' || batch.status === '已回滚'"
              class="btn small"
              type="button"
              @click="retry(batch.id)"
            >
              从序号 {{ batch.retryFromSeq }} 重试
            </button>
            <button class="btn small" type="button" @click="downloadIndex(batch)">下载分区索引</button>
          </div>
        </div>
        <BatchFiles :batch="batch" />
      </article>
    </div>

    <!-- 保留期归档 -->
    <div v-if="activeTab === 'archive'" class="section-card">
      <h3>保留期归档（按批次完成时间判断，与页面打开时间无关）</h3>
      <p class="section-tip">
        归档只切换生命周期状态，历史文件保留原文件格式与原路径；超过配置「保留天数」的已提交批次会被归档。
      </p>
      <button class="btn primary" type="button" @click="runArchive">立即扫描归档</button>
      <table class="data-table" style="margin-top:10px">
        <thead>
          <tr><th>批次</th><th>分区</th><th>状态</th><th>完成时间</th><th>保留天数</th><th>已留存</th><th>归档时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in archiveRows" :key="row.batch.id">
            <td>{{ row.batch.id }}</td>
            <td class="mono">{{ row.batch.partition }}</td>
            <td><StatusBadge :status="row.batch.status" /></td>
            <td>{{ formatClock(row.batch.committedAt) }}</td>
            <td>{{ row.retentionDays }} 天</td>
            <td :class="{ 'error-text': row.expired }">{{ row.ageDays.toFixed(1) }} 天</td>
            <td>{{ formatClock(row.batch.archivedAt) }}</td>
          </tr>
          <tr v-if="!archiveRows.length"><td colspan="7" class="empty-state">暂无可评估的已提交批次</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 批次清单 / 分区索引 -->
    <div v-if="activeTab === 'manifest'" class="section-card">
      <h3>导入批次清单 &amp; 上传分区索引（用于核对同一批文件）</h3>
      <div class="inline-form">
        <label>批次清单 JSON
          <input ref="manifestInput" type="file" accept="application/json,.json" @change="onManifestFile" />
        </label>
        <label>分区索引 JSON
          <input ref="indexInput" type="file" accept="application/json,.json" @change="onIndexFile" />
        </label>
      </div>
      <p class="section-tip" style="margin-top:10px">导入仅做登记核对，不会改变任何批次的提交状态。</p>

      <h3 style="font-size:14px">已导入批次清单</h3>
      <table class="data-table">
        <thead><tr><th>清单编号</th><th>来源文件</th><th>批次数</th><th>文件条目</th><th>导入时间</th></tr></thead>
        <tbody>
          <tr v-for="item in manifests" :key="item.id">
            <td>{{ item.id }}</td><td>{{ item.sourceName }}</td><td>{{ item.batchCount }}</td>
            <td>{{ item.entries.length }}</td><td>{{ formatClock(item.importedAt) }}</td>
          </tr>
          <tr v-if="!manifests.length"><td colspan="5" class="empty-state">尚未导入批次清单</td></tr>
        </tbody>
      </table>

      <h3 style="font-size:14px; margin-top:14px">已上传分区索引</h3>
      <table class="data-table">
        <thead><tr><th>索引编号</th><th>文件</th><th>分区</th><th>文件数</th><th>上传时间</th></tr></thead>
        <tbody>
          <tr v-for="item in indexes" :key="item.id">
            <td>{{ item.id }}</td><td>{{ item.fileName }}</td><td class="mono">{{ item.partition }}</td>
            <td>{{ item.fileCount }}</td><td>{{ formatClock(item.uploadedAt) }}</td>
          </tr>
          <tr v-if="!indexes.length"><td colspan="5" class="empty-state">尚未上传分区索引</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { runAction as applyAction, listEntries } from '@/api/local-service'
import {
  archiveExpired,
  buildPartitionIndex,
  commitWrite,
  downloadTextFile,
  exportBatchManifest,
  formatClock,
  importBatchManifest,
  listBatches,
  listImportedManifests,
  listLocks,
  listUploadedIndexes,
  readRetentionDays,
  resetLandingState,
  retryWrite,
  rollbackWrite,
  startWrite,
  uploadPartitionIndex,
  type LandingBatch,
  type OverwriteMode,
} from '@/data/landing'
import type { EntryRow } from '@/data/types'

import BatchFiles from './BatchFiles.vue'
import StatusBadge from './StatusBadge.vue'

const columns = ['配置编号', '存储类型', '输出路径', '文件格式', '分区策略', '压缩算法', '保留天数', '覆写模式']
const actions = ['提交校验', '启用配置', '停用配置']
const tabs = [
  { key: 'config', label: '落盘配置' },
  { key: 'batch', label: '分区文件与批次' },
  { key: 'archive', label: '保留期归档' },
  { key: 'manifest', label: '清单与索引' },
] as const

const activeTab = ref<(typeof tabs)[number]['key']>('batch')
const rows = ref<EntryRow[]>([])
const batches = ref<LandingBatch[]>([])
const locks = ref<{ partition: string; batchId: string }[]>([])
const manifests = ref(listImportedManifests())
const indexes = ref(listUploadedIndexes())
const notice = ref<{ text: string; kind: 'ok' | 'err' | 'warn' } | null>(null)
const manifestInput = ref<HTMLInputElement | null>(null)
const indexInput = ref<HTMLInputElement | null>(null)

const writeForm = ref({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizDate: '2026-11-13',
  fileCount: 2,
  recordCount: 1000,
  overwriteMode: '冲突拒绝' as OverwriteMode,
  failAtFile: 0,
})

const stats = computed(() => {
  const writing = batches.value.filter((b) => b.status === '写入中').length
  const committed = batches.value.filter((b) => b.status === '已提交').length
  const failed = batches.value.filter((b) => b.status === '提交失败' || b.status === '已回滚').length
  const archived = batches.value.filter((b) => b.status === '已归档').length
  return [
    { label: '落盘批次总数', value: batches.value.length },
    { label: '写入中（分发不可见）', value: writing },
    { label: '已提交（分发可读）', value: committed },
    { label: '失败/回滚', value: failed },
    { label: '已归档', value: archived },
  ]
})

const archiveRows = computed(() => {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  return batches.value
    .filter((batch) => batch.committedAt !== null)
    .map((batch) => {
      const config = rows.value.find((row) => String(row['配置编号']) === batch.configId)
      const retentionDays = readRetentionDays(config)
      const ageDays = (now - (batch.committedAt as number)) / dayMs
      return { batch, retentionDays, ageDays, expired: ageDays >= retentionDays }
    })
})

function flash(text: string, kind: 'ok' | 'err' | 'warn' = 'ok') {
  notice.value = { text, kind }
}

function reload() {
  rows.value = listEntries('storage').items
  batches.value = listBatches()
  locks.value = listLocks()
  manifests.value = listImportedManifests()
  indexes.value = listUploadedIndexes()
}

function isLocked(batch: LandingBatch): boolean {
  return locks.value.some((lock) => lock.batchId === batch.id)
}

function runConfigAction(action: string, row: EntryRow) {
  const result = applyAction('storage', Number(row.id), action)
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function submitWrite() {
  const bizTime = writeForm.value.bizDate
    ? new Date(`${writeForm.value.bizDate}T10:00:00`).getTime()
    : Date.now()
  const result = startWrite({
    configId: writeForm.value.configId,
    dataset: writeForm.value.dataset,
    bizTime,
    fileCount: writeForm.value.fileCount,
    recordCount: writeForm.value.recordCount,
    overwriteMode: writeForm.value.overwriteMode,
    failAtFile: writeForm.value.failAtFile > 0 ? writeForm.value.failAtFile : undefined,
  })
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function submitCommit(batchId: string) {
  const result = commitWrite(batchId)
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function rollback(batchId: string) {
  const result = rollbackWrite(batchId)
  flash(result.message, result.ok ? 'warn' : 'err')
  reload()
}

function retry(batchId: string) {
  const result = retryWrite(batchId)
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function runArchive() {
  const result = archiveExpired()
  flash(result.message, result.ok ? 'ok' : 'err')
  reload()
}

function downloadManifest() {
  const { filename, content } = exportBatchManifest()
  downloadTextFile(filename, content)
}

function downloadIndex(batch: LandingBatch) {
  const index = buildPartitionIndex(batch.partition)
  if (!index) {
    flash(`分区 ${batch.partition} 还没有正式文件，无法生成索引`, 'warn')
    return
  }
  downloadTextFile(index.fileName, JSON.stringify({ partition: index.partition, entries: index.entries }, null, 2))
}

function readFile(file: File): Promise<string> {
  return file.text()
}

async function onManifestFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const raw = await readFile(file)
  const result = importBatchManifest(file.name, raw)
  flash(result.message, result.ok ? 'ok' : 'err')
  if (manifestInput.value) {
    manifestInput.value.value = ''
  }
  reload()
}

async function onIndexFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const raw = await readFile(file)
  const result = uploadPartitionIndex(file.name, raw)
  flash(result.message, result.ok ? (result.data?.missing.length ? 'warn' : 'ok') : 'err')
  if (indexInput.value) {
    indexInput.value.value = ''
  }
  reload()
}

function resetAll() {
  resetLandingState()
  flash('落盘现场已重置为空状态', 'warn')
  reload()
}

onMounted(reload)
</script>
