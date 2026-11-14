import { buildFileNames, makeChecksum } from './path'
import type { LandingBatch, LandingState, PartitionFile } from './types'

/**
 * 落盘结果的现场演示数据。
 *
 * 复现 STOR-61 故障：2026-11-13 分区的批次只写完一半（临时文件、未提交、持锁），
 * 按规则它对数据分发必须不可见；而 2026-11-12 分区已完成提交，可正常分发。
 * 另保留一个超过 30 天保留期的已提交批次，用于演示按完成时间归档。
 */

const DAY = 24 * 60 * 60 * 1000
// 固定「今天」为 2026-11-14，与现场时间一致，保证演示结果稳定。
const NOW = new Date(2026, 10, 14, 10, 0, 0).getTime()

function makeFiles(
  basePath: string,
  partition: string,
  batchId: string,
  format: 'jsonl' | 'parquet',
  seqList: number[],
  state: PartitionFile['state'],
): PartitionFile[] {
  return seqList.map((seq) => {
    const names = buildFileNames(basePath, partition, batchId, seq, format)
    const size = state === '临时' ? 0 : 12800 + seq * 17
    return {
      seq,
      format,
      path: names.path,
      tempPath: names.tempPath,
      partition,
      state,
      size,
      checksum: makeChecksum([names.tempPath, seq, size]),
    }
  })
}

export function buildLandingSeed(): LandingState {
  const base61 = 'oss://collect-biz/orders'

  // 1) 2026-11-12 已完成提交的正常批次（分发可读）
  const okPartition = 'dt=2026-11-12'
  const okBatchId = 'BATCH-00001'
  const okBatch: LandingBatch = {
    id: okBatchId,
    configId: 'STOR-0061',
    dataset: '订单数据集',
    partition: okPartition,
    strategy: '按天分区',
    status: '已提交',
    files: makeFiles(base61, okPartition, okBatchId, 'jsonl', [1, 2, 3], '正式'),
    recordCount: 3200,
    overwriteMode: '冲突拒绝',
    startedAt: NOW - 2 * DAY + 3600_000,
    committedAt: NOW - 2 * DAY + 3660_000,
    archivedAt: null,
    failReason: null,
    lostTo: null,
    retryFromSeq: 1,
    commitSeq: 1,
  }

  // 2) 2026-11-13 只完成一半的批次（临时文件、未提交、持分区锁，分发必须阻断）
  const halfPartition = 'dt=2026-11-13'
  const halfBatchId = 'BATCH-00002'
  const halfBatch: LandingBatch = {
    id: halfBatchId,
    configId: 'STOR-0061',
    dataset: '订单数据集',
    partition: halfPartition,
    strategy: '按天分区',
    status: '写入中',
    files: makeFiles(base61, halfPartition, halfBatchId, 'jsonl', [1, 2], '临时'),
    recordCount: 1800,
    overwriteMode: '冲突拒绝',
    startedAt: NOW - DAY + 3600_000,
    committedAt: null,
    archivedAt: null,
    failReason: null,
    lostTo: null,
    retryFromSeq: 3,
    commitSeq: null,
  }

  // 3) 超过 30 天保留期的历史批次（按完成时间应被归档，归档保留原格式原路径）
  const oldPartition = 'dt=2026-10-01'
  const oldBatchId = 'BATCH-00003'
  const oldBatch: LandingBatch = {
    id: oldBatchId,
    configId: 'STOR-0061',
    dataset: '订单数据集',
    partition: oldPartition,
    strategy: '按天分区',
    status: '已提交',
    files: makeFiles(base61, oldPartition, oldBatchId, 'jsonl', [1], '正式'),
    recordCount: 900,
    overwriteMode: '冲突拒绝',
    startedAt: NOW - 44 * DAY,
    committedAt: NOW - 44 * DAY + 120_000,
    archivedAt: null,
    failReason: null,
    lostTo: null,
    retryFromSeq: 1,
    commitSeq: 2,
  }

  return {
    batches: [okBatch, halfBatch, oldBatch],
    locks: [{ partition: halfPartition, batchId: halfBatchId, acquiredAt: halfBatch.startedAt }],
    commitSeqCounter: 2,
    batchCounter: 3,
    importedManifests: [],
    uploadedIndexes: [],
  }
}
