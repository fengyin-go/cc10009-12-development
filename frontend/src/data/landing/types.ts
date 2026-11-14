/**
 * 数据落盘领域模型：配置 -> 分区文件 -> 批次提交 -> 归档 -> 分发清单 的调用链。
 *
 * 设计要点（对应现场规则）：
 * - 文件先以临时文件名（.part）写入，批次提交成功才转正，失败回滚不留半份文件。
 * - 同一分区同时只允许一个批次提交成功，靠分区锁互斥。
 * - 分发清单只读取「已提交」批次，写入中 / 已失败 / 已回滚的批次不会提前出现。
 * - 保留期按批次「完成时间（committedAt）」判断，与页面打开时间无关。
 * - 历史归档保留原文件格式与原路径，只改生命周期状态，不移动、不转格式。
 * - 分区策略变更后，旧文件仍按写入时的分区路径回读，不被新策略重算。
 */

/** 落盘批次状态机 */
export type BatchStatus =
  | '写入中' // 临时文件已生成，尚未提交，分发侧不可见
  | '已提交' // 原子提交完成，文件转正，分发侧可读
  | '提交失败' // 同分区冲突或事务出错，临时文件已回滚，保留可重试位置
  | '已归档' // 超过保留天数，按原格式原路径归档
  | '已回滚' // 事务写入出错，临时状态已清理

/** 分区文件状态：与批次状态联动，但只描述单个文件的可见性 */
export type FileState = '临时' | '正式' | '已归档' | '已回滚'

/** 覆写模式 */
export type OverwriteMode = '整批覆盖' | '追加写入' | '冲突拒绝'

/** 支持的分区策略：策略决定分区目录，不改变文件格式 */
export type PartitionStrategy = '按天分区' | '按小时分区' | '按月分区' | '单桶分区'

export type FileFormat = 'json' | 'csv' | 'parquet' | 'jsonl'

/** 分区文件清单中的单个文件 */
export interface PartitionFile {
  /** 分区内自增序号 */
  seq: number
  /** 写入时使用的文件格式，归档后仍保持该格式 */
  format: FileFormat
  /** 写入时确定的完整相对路径（含分区目录与文件名），策略变更后也不重算 */
  path: string
  /** 临时文件名，提交成功后转正；回滚时删除 */
  tempPath: string
  /** 分区键，例如 dt=2026-11-13 */
  partition: string
  state: FileState
  /** 模拟字节数，用于清单核对 */
  size: number
  /** 校验和，分发侧完整性校验用 */
  checksum: string
}

/** 采集批次：一次落盘写入的最小提交单元 */
export interface LandingBatch {
  id: string
  /** 关联的存储配置编号，例如 STOR-0061 */
  configId: string
  /** 输出数据集名称，分发通道按它关联落盘结果 */
  dataset: string
  partition: string
  strategy: PartitionStrategy
  status: BatchStatus
  files: PartitionFile[]
  /** 模拟记录条数 */
  recordCount: number
  overwriteMode: OverwriteMode
  /** 开始写入时间（毫秒时间戳） */
  startedAt: number
  /** 批次完成时间：提交成功的时刻；保留期只认这个时间 */
  committedAt: number | null
  /** 归档时间 */
  archivedAt: number | null
  /** 失败 / 回滚原因 */
  failReason: string | null
  /** 同分区冲突时记录获胜批次，便于现场核对 */
  lostTo: string | null
  /** 可重试位置：失败时记录已写入的临时文件序号，重试从下一个序号继续 */
  retryFromSeq: number
  /** 提交序号：同分区后提交者序号更大，覆写冲突时以先完成提交的批次为准 */
  commitSeq: number | null
}

/** 分区锁：同一分区同时只允许一个批次处于写入 / 提交临界区 */
export interface PartitionLock {
  partition: string
  batchId: string
  acquiredAt: number
}

/** 落盘结果整体持久化结构 */
export interface LandingState {
  batches: LandingBatch[]
  locks: PartitionLock[]
  /** 自增提交序号 */
  commitSeqCounter: number
  /** 自增批次序号 */
  batchCounter: number
  /** 导入的外部批次清单（仅用于核对，不参与提交判定） */
  importedManifests: ImportedManifest[]
  /** 上传的分区索引文件记录 */
  uploadedIndexes: PartitionIndexRecord[]
}

/** 导入的批次清单条目 */
export interface ImportedManifest {
  id: string
  sourceName: string
  importedAt: number
  batchCount: number
  /** 清单里声明的文件路径，用于和本地分区文件核对 */
  entries: { batchId: string; partition: string; path: string; checksum: string }[]
}

/** 上传的分区索引文件 */
export interface PartitionIndexRecord {
  id: string
  fileName: string
  uploadedAt: number
  partition: string
  fileCount: number
  entries: { path: string; checksum: string; size: number }[]
}

/** 发起一次写入的入参 */
export interface StartWriteInput {
  configId: string
  dataset: string
  /** 业务时间，用于推导分区；默认取当前时间 */
  bizTime?: number
  fileCount?: number
  recordCount?: number
  format?: FileFormat
  overwriteMode?: OverwriteMode
  /** 模拟事务写到第几个文件时出错（1 起），用于验证回滚 */
  failAtFile?: number
}

/** 写入 / 提交动作的统一返回 */
export interface LandingResult<T = LandingBatch> {
  ok: boolean
  message: string
  data?: T
}
