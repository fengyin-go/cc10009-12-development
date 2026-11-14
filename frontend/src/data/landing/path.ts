import type { EntryRow } from '@/data/types'

import type { FileFormat, PartitionStrategy } from './types'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 按分区策略推导分区目录。策略只影响目录结构，不影响文件内容与格式。
 * 分区一旦随批次写入，路径就固定下来；后续改策略不会重算历史文件。
 */
export function resolvePartition(strategy: PartitionStrategy, time: number): string {
  const date = new Date(time)
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  switch (strategy) {
    case '按天分区':
      return `dt=${y}-${m}-${d}`
    case '按小时分区':
      return `dt=${y}-${m}-${d}/hour=${h}`
    case '按月分区':
      return `dt=${y}-${m}`
    case '单桶分区':
      return 'bucket=default'
    default:
      return 'bucket=default'
  }
}

/** 归一化输出路径，去掉首尾斜杠，避免拼出双斜杠 */
export function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'data/landing' : trimmed
}

/** 从通用存储配置行读取分区策略，配置异常时回退到按天分区 */
export function readStrategy(config: EntryRow | undefined): PartitionStrategy {
  const raw = String(config?.['分区策略'] ?? '')
  const candidates: PartitionStrategy[] = ['按天分区', '按小时分区', '按月分区', '单桶分区']
  return candidates.find((item) => raw.includes(item)) ?? '按天分区'
}

export function readOverwriteMode(config: EntryRow | undefined, fallback = '冲突拒绝'): string {
  const raw = String(config?.['覆写模式'] ?? '')
  return ['整批覆盖', '追加写入', '冲突拒绝'].find((item) => raw.includes(item)) ?? fallback
}

export function readRetentionDays(config: EntryRow | undefined, fallback = 30): number {
  const raw = String(config?.['保留天数'] ?? '')
  const matched = raw.match(/\d+/)
  return matched ? Number(matched[0]) : fallback
}

export function readFileFormat(config: EntryRow | undefined, fallback: FileFormat = 'jsonl'): FileFormat {
  const raw = String(config?.['文件格式'] ?? '').toLowerCase()
  const candidates: FileFormat[] = ['json', 'csv', 'parquet', 'jsonl']
  return candidates.find((item) => raw.includes(item)) ?? fallback
}

export function readOutputPath(config: EntryRow | undefined): string {
  return normalizeBasePath(String(config?.['输出路径'] ?? 'data/landing'))
}

/** 生成确定性校验和：同路径同大小同序号结果稳定，便于清单复核 */
export function makeChecksum(parts: (string | number)[]): string {
  const source = parts.join('|')
  let hash = 2166136261
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const unsigned = hash >>> 0
  return `ck_${unsigned.toString(16).padStart(8, '0')}`
}

/** 生成分区内的正式文件名与临时文件名 */
export function buildFileNames(
  basePath: string,
  partition: string,
  batchId: string,
  seq: number,
  format: FileFormat,
): { path: string; tempPath: string } {
  const fileName = `part-${String(seq).padStart(4, '0')}-${batchId}.${format}`
  const tempName = `.${fileName}.part`
  return {
    path: `${basePath}/${partition}/${fileName}`,
    tempPath: `${basePath}/${partition}/${tempName}`,
  }
}

export function formatClock(time: number | null): string {
  if (time === null) {
    return '—'
  }
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
