import { listRows } from '@/data/local-store'

import {
  buildFileNames,
  makeChecksum,
  readFileFormat,
  readOutputPath,
  readOverwriteMode,
  readRetentionDays,
  readStrategy,
  resolvePartition,
} from './path'
import { commitLandingState, readLandingState } from './store'
import type {
  FileFormat,
  ImportedManifest,
  LandingBatch,
  LandingResult,
  LandingState,
  OverwriteMode,
  PartitionFile,
  PartitionIndexRecord,
  StartWriteInput,
} from './types'

const STORAGE_MODULE = 'storage'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findConfig(configId: string) {
  return listRows(STORAGE_MODULE).find((row) => String(row['配置编号']) === configId)
}

function nextBatchId(state: LandingState): string {
  state.batchCounter += 1
  return `BATCH-${String(state.batchCounter).padStart(5, '0')}`
}

/**
 * 构造一个批次的全部文件描述。落盘是纯前端模拟，「写文件」即生成文件清单条目：
 * 先全部落在临时路径（.part），提交成功才切换成正式路径，保证失败不留半份正式文件。
 */
function buildFiles(
  basePath: string,
  partition: string,
  batchId: string,
  format: FileFormat,
  fileCount: number,
  recordCount: number,
  failAtFile?: number,
): { files: PartitionFile[]; failedAt: number | null } {
  const files: PartitionFile[] = []
  let failedAt: number | null = null
  const perFile = Math.max(1, Math.round(recordCount / fileCount))
  for (let seq = 1; seq <= fileCount; seq += 1) {
    const names = buildFileNames(basePath, partition, batchId, seq, format)
    if (typeof failAtFile === 'number' && failAtFile === seq) {
      // 模拟事务写到一半出错：出错文件只登记临时路径，随即由调用方整体回滚。
      failedAt = seq
      files.push({
        seq,
        format,
        path: names.path,
        tempPath: names.tempPath,
        partition,
        state: '临时',
        size: 0,
        checksum: makeChecksum([names.tempPath, seq, 0]),
      })
      break
    }
    const size = perFile * 128 + seq * 17
    files.push({
      seq,
      format,
      path: names.path,
      tempPath: names.tempPath,
      partition,
      state: '临时',
      size,
      checksum: makeChecksum([names.tempPath, seq, size]),
    })
  }
  return { files, failedAt }
}

/** 回滚：把批次标记为已回滚，所有临时文件标记为已回滚（等价于删除 .part），释放分区锁 */
function rollbackBatch(
  state: LandingState,
  batch: LandingBatch,
  reason: string,
  status: '提交失败' | '已回滚' = '已回滚',
): void {
  batch.status = status
  batch.failReason = reason
  batch.files.forEach((file) => {
    if (file.state === '临时') {
      file.state = '已回滚'
    }
  })
  state.locks = state.locks.filter((lock) => lock.batchId !== batch.id)
}

/**
 * 发起一次落盘写入。
 *
 * 事务语义：
 * 1. 依据配置的分区策略算出分区，尝试获取分区锁；同分区已有写入中的批次则拒绝（只允许一个进入临界区）。
 * 2. 生成临时文件清单；若 failAtFile 命中，立即回滚临时状态并记录可重试位置。
 * 3. 未出错则保留「写入中」批次与分区锁，等待 commitWrite 原子提交。
 */
export function startWrite(input: StartWriteInput): LandingResult<LandingBatch> {
  const state = clone(readLandingState())
  const config = findConfig(input.configId)
  if (!config) {
    return { ok: false, message: `没有找到存储配置 ${input.configId}` }
  }

  const strategy = readStrategy(config)
  const format = input.format ?? readFileFormat(config)
  const overwriteMode = (input.overwriteMode ??
    readOverwriteMode(config)) as OverwriteMode
  const basePath = readOutputPath(config)
  const bizTime = input.bizTime ?? Date.now()
  const partition = resolvePartition(strategy, bizTime)
  const fileCount = Math.max(1, input.fileCount ?? 2)
  const recordCount = Math.max(1, input.recordCount ?? 100)

  // 同分区互斥：写入中 / 待提交的批次持锁，其它写请求不能进入同一分区。
  const held = state.locks.find((lock) => lock.partition === partition)
  if (held) {
    return {
      ok: false,
      message: `分区 ${partition} 正被批次 ${held.batchId} 占用，同一分区只允许一个写入进入`,
    }
  }

  const batchId = nextBatchId(state)
  const { files, failedAt } = buildFiles(
    basePath,
    partition,
    batchId,
    format,
    fileCount,
    recordCount,
    input.failAtFile,
  )

  const batch: LandingBatch = {
    id: batchId,
    configId: input.configId,
    dataset: input.dataset,
    partition,
    strategy,
    status: '写入中',
    files,
    recordCount,
    overwriteMode,
    startedAt: bizTime,
    committedAt: null,
    archivedAt: null,
    failReason: null,
    lostTo: null,
    retryFromSeq: (failedAt ?? 0) + 1,
    commitSeq: null,
  }

  if (failedAt !== null) {
    // 事务写入出错：登记失败批次用于现场追溯，临时文件全部回滚，不保留半份文件。
    batch.status = '已回滚'
    batch.failReason = `写入第 ${failedAt} 个分区文件时事务中断，临时文件已回滚，可从序号 ${batch.retryFromSeq} 重试`
    batch.files.forEach((file) => {
      file.state = '已回滚'
    })
    state.batches.push(batch)
    commitLandingState(state)
    return {
      ok: false,
      message: batch.failReason,
      data: clone(batch),
    }
  }

  // 写入成功但尚未提交：持锁，分发侧此时读不到该批次。
  state.locks.push({ partition, batchId, acquiredAt: bizTime })
  state.batches.push(batch)
  commitLandingState(state)
  return { ok: true, message: `批次 ${batchId} 已生成 ${files.length} 个临时文件，等待提交`, data: clone(batch) }
}

/** 同分区已正式提交的批次（用于覆写冲突判定） */
function committedOnPartition(state: LandingState, partition: string): LandingBatch[] {
  return state.batches.filter(
    (batch) => batch.partition === partition && (batch.status === '已提交' || batch.status === '已归档'),
  )
}

/**
 * 原子提交批次。
 *
 * - 冲突拒绝：同分区已有已提交批次时直接失败，回滚临时文件。
 * - 整批覆盖：以先完成提交的批次为准，新批次提交后旧批次转为被覆盖（文件标记回滚，不并列可见）。
 * - 追加写入：同分区允许并存，分发清单按 commitSeq 排序。
 * 提交成功：临时文件转正、记录 committedAt（保留期判断的唯一依据）、释放分区锁。
 */
export function commitWrite(batchId: string, now: number = Date.now()): LandingResult<LandingBatch> {
  const state = clone(readLandingState())
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status !== '写入中') {
    return { ok: false, message: `批次 ${batchId} 当前状态为「${batch.status}」，不能提交` }
  }

  const lock = state.locks.find((item) => item.partition === batch.partition && item.batchId === batchId)
  if (!lock) {
    return { ok: false, message: `批次 ${batchId} 未持有分区锁，拒绝提交` }
  }

  const winners = committedOnPartition(state, batch.partition)

  if (batch.overwriteMode === '冲突拒绝' && winners.length > 0) {
    const reason = `分区 ${batch.partition} 已有完成提交的批次 ${winners[0].id}，按冲突拒绝策略回滚本次写入`
    rollbackBatch(state, batch, reason, '提交失败')
    batch.lostTo = winners[0].id
    commitLandingState(state)
    return { ok: false, message: reason, data: clone(batch) }
  }

  if (batch.overwriteMode === '整批覆盖' && winners.length > 0) {
    // 以已完成提交的批次为准做覆盖：旧批次文件先回滚，再由新批次原子转正，保证同分区任意时刻只有一份正式文件。
    winners.forEach((winner) => {
      winner.files.forEach((file) => {
        if (file.state === '正式') {
          file.state = '已回滚'
        }
      })
      winner.status = '提交失败'
      winner.failReason = `被后完成提交的批次 ${batchId} 整批覆盖，原文件已下线`
      winner.lostTo = batchId
    })
  }

  // 原子转正：所有临时文件一次性切换为正式，不存在中间态。
  batch.files.forEach((file) => {
    file.state = '正式'
  })
  state.commitSeqCounter += 1
  batch.commitSeq = state.commitSeqCounter
  batch.status = '已提交'
  batch.committedAt = now
  batch.failReason = null
  state.locks = state.locks.filter((item) => item.batchId !== batchId)

  commitLandingState(state)
  return { ok: true, message: `批次 ${batchId} 已提交，${batch.files.length} 个文件转正，分发清单可读取`, data: clone(batch) }
}

/**
 * 手动回滚写入中的批次：清理全部临时文件并释放分区锁，不留半份文件。
 * 与事务出错回滚共用 rollbackBatch，保证两条路径行为一致。
 */
export function rollbackWrite(batchId: string): LandingResult<LandingBatch> {
  const state = clone(readLandingState())
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (batch.status !== '写入中') {
    return { ok: false, message: `批次 ${batchId} 当前状态为「${batch.status}」，无需回滚` }
  }
  rollbackBatch(state, batch, '人工回滚：临时文件已清理，分区锁已释放，可重新发起写入', '已回滚')
  commitLandingState(state)
  return { ok: true, message: `批次 ${batchId} 已回滚，未留下任何正式文件`, data: clone(batch) }
}

/**
 * 失败 / 写入中批次的重试：从 retryFromSeq 继续写剩余文件，复用同一分区与配置。
 * 重试生成新批次，但携带原批次号便于追溯。
 */
export function retryWrite(batchId: string): LandingResult<LandingBatch> {
  const state = clone(readLandingState())
  const origin = state.batches.find((item) => item.id === batchId)
  if (!origin) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  if (origin.status !== '提交失败' && origin.status !== '已回滚') {
    return { ok: false, message: `批次 ${batchId} 状态为「${origin.status}」，无需重试` }
  }
  const remaining = origin.files.filter((file) => file.state === '已回滚').length
  // 重试沿用原批次的业务时间，保证在分区策略未变时落回原分区、从断点继续。
  const result = startWrite({
    configId: origin.configId,
    dataset: origin.dataset,
    bizTime: origin.startedAt,
    fileCount: Math.max(1, remaining || origin.files.length),
    recordCount: origin.recordCount,
    overwriteMode: origin.overwriteMode,
  })
  return result
}

/**
 * 按保留天数归档。保留期只看批次完成时间 committedAt，与页面何时打开无关：
 * now - committedAt >= retentionDays * 一天 即归档。
 * 归档保留原文件格式与原路径，仅把生命周期状态切到「已归档」。
 */
export function archiveExpired(now: number = Date.now()): LandingResult<{ archived: LandingBatch[] }> {
  const state = clone(readLandingState())
  const dayMs = 24 * 60 * 60 * 1000
  const archived: LandingBatch[] = []

  state.batches.forEach((batch) => {
    if (batch.status !== '已提交' || batch.committedAt === null) {
      return
    }
    const config = findConfig(batch.configId)
    const retentionDays = readRetentionDays(config)
    const ageDays = (now - batch.committedAt) / dayMs
    if (ageDays >= retentionDays) {
      batch.status = '已归档'
      batch.archivedAt = now
      batch.files.forEach((file) => {
        if (file.state === '正式') {
          file.state = '已归档'
        }
      })
      archived.push(batch)
    }
  })

  commitLandingState(state)
  return {
    ok: true,
    message: archived.length
      ? `已按批次完成时间归档 ${archived.length} 个批次，原文件格式与路径保持不变`
      : '没有超过保留天数的已提交批次',
    data: { archived: clone(archived) },
  }
}

/** 读取全部批次（视图层按状态再过滤） */
export function listBatches(): LandingBatch[] {
  return clone(readLandingState().batches)
}

export function getBatch(batchId: string): LandingBatch | undefined {
  const found = readLandingState().batches.find((item) => item.id === batchId)
  return found ? clone(found) : undefined
}

/** 当前持有的分区锁 */
export function listLocks() {
  return clone(readLandingState().locks)
}

/**
 * 生成分区索引文件：列出某分区下所有正式 / 已归档文件（临时与已回滚文件不进索引）。
 * 索引可下载、可再上传回来核对同一批文件。
 */
export function buildPartitionIndex(partition: string): PartitionIndexRecord | null {
  const state = readLandingState()
  const entries: PartitionIndexRecord['entries'] = []
  state.batches.forEach((batch) => {
    if (batch.partition !== partition) {
      return
    }
    batch.files.forEach((file) => {
      if (file.state === '正式' || file.state === '已归档') {
        entries.push({ path: file.path, checksum: file.checksum, size: file.size })
      }
    })
  })
  if (!entries.length) {
    return null
  }
  return {
    id: `IDX-${partition.replace(/[^a-z0-9]/gi, '_')}`,
    fileName: `partition-index-${partition.replace(/[^a-z0-9]/gi, '-')}.json`,
    uploadedAt: Date.now(),
    partition,
    fileCount: entries.length,
    entries,
  }
}

/** 上传分区索引文件：解析后登记，并与本地正式文件逐条核对 */
export function uploadPartitionIndex(
  fileName: string,
  raw: string,
): LandingResult<{ record: PartitionIndexRecord; matched: number; missing: string[] }> {
  let parsed: { partition?: string; entries?: PartitionIndexRecord['entries'] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: '分区索引文件不是合法 JSON，无法上传' }
  }
  if (!parsed.partition || !Array.isArray(parsed.entries)) {
    return { ok: false, message: '索引文件缺少 partition 或 entries 字段' }
  }

  const state = clone(readLandingState())
  const localPaths = new Set<string>()
  state.batches.forEach((batch) => {
    batch.files.forEach((file) => {
      if (file.state === '正式' || file.state === '已归档') {
        localPaths.add(file.path)
      }
    })
  })
  const missing = parsed.entries.map((entry) => entry.path).filter((path) => !localPaths.has(path))
  const record: PartitionIndexRecord = {
    id: `IDX-UP-${String(state.uploadedIndexes.length + 1).padStart(4, '0')}`,
    fileName,
    uploadedAt: Date.now(),
    partition: parsed.partition,
    fileCount: parsed.entries.length,
    entries: parsed.entries,
  }
  state.uploadedIndexes.push(record)
  commitLandingState(state)
  return {
    ok: true,
    message:
      missing.length === 0
        ? `索引 ${fileName} 上传完成，${record.fileCount} 个文件全部能在本地分区核对到`
        : `索引 ${fileName} 上传完成，${missing.length} 个文件在本地缺失，请核查`,
    data: { record: clone(record), matched: record.fileCount - missing.length, missing },
  }
}

/** 导入批次清单：仅做登记与核对，不会改变任何批次的提交状态 */
export function importBatchManifest(
  sourceName: string,
  raw: string,
): LandingResult<{ manifest: ImportedManifest }> {
  let parsed: { batches?: { id: string; partition: string; files: { path: string; checksum: string }[] }[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, message: '批次清单不是合法 JSON，无法导入' }
  }
  if (!Array.isArray(parsed.batches)) {
    return { ok: false, message: '批次清单缺少 batches 数组' }
  }

  const state = clone(readLandingState())
  const entries: ImportedManifest['entries'] = []
  parsed.batches.forEach((batch) => {
    batch.files.forEach((file) => {
      entries.push({ batchId: batch.id, partition: batch.partition, path: file.path, checksum: file.checksum })
    })
  })
  const manifest: ImportedManifest = {
    id: `MNF-${String(state.importedManifests.length + 1).padStart(4, '0')}`,
    sourceName,
    importedAt: Date.now(),
    batchCount: parsed.batches.length,
    entries,
  }
  state.importedManifests.push(manifest)
  commitLandingState(state)
  return { ok: true, message: `批次清单 ${sourceName} 导入完成，共 ${manifest.batchCount} 个批次`, data: { manifest: clone(manifest) } }
}

export function listImportedManifests(): ImportedManifest[] {
  return clone(readLandingState().importedManifests)
}

export function listUploadedIndexes(): PartitionIndexRecord[] {
  return clone(readLandingState().uploadedIndexes)
}

/** 导出当前全部批次清单（下载用） */
export function exportBatchManifest(): { filename: string; content: string } {
  const state = readLandingState()
  const payload = {
    exportedAt: new Date().toISOString(),
    batches: state.batches.map((batch) => ({
      id: batch.id,
      configId: batch.configId,
      dataset: batch.dataset,
      partition: batch.partition,
      status: batch.status,
      committedAt: batch.committedAt,
      files: batch.files.map((file) => ({
        path: file.path,
        state: file.state,
        checksum: file.checksum,
        size: file.size,
      })),
    })),
  }
  return { filename: '落盘批次清单.json', content: JSON.stringify(payload, null, 2) }
}
