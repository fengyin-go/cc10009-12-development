import { listRows } from '@/data/local-store'

import { readLandingState } from './store'
import type { LandingBatch, PartitionFile } from './types'

const EXPORT_MODULE = 'export'

export interface DistributionEntry {
  channelId: string
  dataset: string
  targetSystem: string
  /** 可读取的已提交批次；写入中 / 失败 / 回滚批次一律不出现 */
  readableBatches: LandingBatch[]
  /** 可供读取的正式文件 */
  readableFiles: PartitionFile[]
  /** 被落盘阻断而提前不可见的批次数量（写入中或失败） */
  blockedCount: number
  blockedBatchIds: string[]
  /** 通道是否处于可分发的启用态 */
  channelEnabled: boolean
}

/**
 * 数据分发的唯一数据来源：只读取「已提交」批次的正式文件。
 *
 * 现场规则（STOR-61 半分区问题）：
 * - 写入中（临时 .part）、提交失败、已回滚的批次对分发侧完全不可见；
 * - 只有 commitWrite 成功转正的文件才进入分发清单；
 * - 已归档批次仍可按原路径回读（历史文件原格式原路径保留）。
 */
export function buildDistributionCatalog(): DistributionEntry[] {
  const state = readLandingState()
  const channels = listRows(EXPORT_MODULE)

  return channels.map((channel) => {
    const channelId = String(channel['通道编号'])
    const dataset = String(channel['输出数据集'])
    const channelEnabled = String(channel.status) === '已启用'

    const related = state.batches.filter((batch) => batch.dataset === dataset)
    const readableBatches = related.filter(
      (batch) => batch.status === '已提交' || batch.status === '已归档',
    )
    const blocked = related.filter(
      (batch) => batch.status === '写入中' || batch.status === '提交失败' || batch.status === '已回滚',
    )

    const readableFiles: PartitionFile[] = []
    readableBatches.forEach((batch) => {
      batch.files.forEach((file) => {
        if (file.state === '正式' || file.state === '已归档') {
          readableFiles.push(file)
        }
      })
    })

    return {
      channelId,
      dataset,
      targetSystem: String(channel['目标系统']),
      readableBatches: JSON.parse(JSON.stringify(readableBatches)) as LandingBatch[],
      readableFiles: JSON.parse(JSON.stringify(readableFiles)) as PartitionFile[],
      blockedCount: blocked.length,
      blockedBatchIds: blocked.map((batch) => batch.id),
      channelEnabled,
    }
  })
}

/** 分发通道尝试读取某数据集：落盘未完成提交时直接阻断，返回不可读原因 */
export function readDataset(channelId: string): {
  ok: boolean
  message: string
  files: PartitionFile[]
} {
  const catalog = buildDistributionCatalog()
  const entry = catalog.find((item) => item.channelId === channelId)
  if (!entry) {
    return { ok: false, message: `没有找到分发通道 ${channelId}`, files: [] }
  }
  if (!entry.channelEnabled) {
    return { ok: false, message: `通道 ${channelId} 未启用，暂不分发`, files: [] }
  }
  if (entry.readableFiles.length === 0) {
    return {
      ok: false,
      message:
        entry.blockedCount > 0
          ? `数据集「${entry.dataset}」的落盘批次尚未完成提交（${entry.blockedBatchIds.join('、')} 被阻断），分发清单不提供读取`
          : `数据集「${entry.dataset}」暂无已提交的落盘结果`,
      files: [],
    }
  }
  return {
    ok: true,
    message: `数据集「${entry.dataset}」可读取 ${entry.readableFiles.length} 个已提交文件`,
    files: JSON.parse(JSON.stringify(entry.readableFiles)) as PartitionFile[],
  }
}
