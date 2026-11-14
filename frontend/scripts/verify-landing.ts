/* 落盘引擎规则核验脚本：用 esbuild 打包后由 node 运行，不依赖测试框架。 */
// Node 环境下补齐浏览器存储外壳，让 local-store / landing store 走 localStorage 分支。
const memory = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
}
;(globalThis as Record<string, unknown>).window = { localStorage: localStorageShim }
;(globalThis as Record<string, unknown>).localStorage = localStorageShim

import {
  archiveExpired,
  buildDistributionCatalog,
  buildLandingSeed,
  buildPartitionIndex,
  commitWrite,
  exportBatchManifest,
  getBatch,
  importBatchManifest,
  listBatches,
  listLocks,
  readDataset,
  resetLandingState,
  retryWrite,
  rollbackWrite,
  startWrite,
  uploadPartitionIndex,
} from '@/data/landing'
import { listRows, saveRows } from '@/data/local-store'

let passed = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) {
    console.error(`✗ ${name} ${detail}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

const NOW = new Date(2026, 10, 14, 10, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

// ---- 场景 0：种子数据（STOR-61 半分区）----
const seed = buildLandingSeed()
check('种子含 3 个批次', seed.batches.length === 3)
check('种子半分区批次 BATCH-00002 持锁', seed.locks[0]?.batchId === 'BATCH-00002')

// ---- 场景 1：分发只能读取完整提交，半分区不可见 ----
const catalog = buildDistributionCatalog()
const orderEntry = catalog.find((e) => e.dataset === '订单数据集')!
check('分发清单不含写入中批次 BATCH-00002', !orderEntry.readableBatches.some((b) => b.id === 'BATCH-00002'))
check('分发清单阻断计数为 1', orderEntry.blockedCount === 1, `got ${orderEntry.blockedCount}`)
check('分发只能读到 2026-11-12 与 2026-10-01 的正式文件', orderEntry.readableFiles.every((f) => f.state === '正式'))
check('分发可读文件全部来自已提交批次', orderEntry.readableFiles.length === 4) // 3 + 1
const blockedRead = readDataset('EXPO-0001')
check('半分区存在时读取仍可成功（已有 11-12 已提交批次）', blockedRead.ok && blockedRead.files.length === 4)

// ---- 场景 2：同分区并发写只允许一个进入（锁互斥）----
const clash = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 13, 10, 0, 0).getTime(),
  fileCount: 2,
})
check('同分区第二个写请求被锁拒绝', !clash.ok && clash.message.includes('占用'))

// ---- 场景 3：提交半分区后分发立即可见，锁释放 ----
const commitHalf = commitWrite('BATCH-00002', NOW)
check('BATCH-00002 提交成功', commitHalf.ok)
check('提交后文件全部转正', getBatch('BATCH-00002')!.files.every((f) => f.state === '正式'))
check('提交后分区锁释放', !listLocks().some((l) => l.batchId === 'BATCH-00002'))
check('完成时间被记录（保留期依据）', getBatch('BATCH-00002')!.committedAt === NOW)
const catalog2 = buildDistributionCatalog().find((e) => e.dataset === '订单数据集')!
check('提交后分发清单出现该批次', catalog2.readableBatches.some((b) => b.id === 'BATCH-00002'))
check('分发可读文件增加到 6 个', catalog2.readableFiles.length === 6)

// ---- 场景 4：冲突拒绝——同分区再写，提交失败且不留半份文件 ----
const w1 = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 13, 11, 0, 0).getTime(),
  fileCount: 3,
  overwriteMode: '冲突拒绝',
})
check('锁释放后新写请求可进入', w1.ok)
const c1 = commitWrite(w1.data!.id, NOW + 1000)
check('冲突拒绝策略下提交失败', !c1.ok && c1.data!.status === '提交失败')
check('失败批次临时文件全部回滚，无半份正式文件', c1.data!.files.every((f) => f.state === '已回滚'))
check('失败后分区锁被释放', !listLocks().some((l) => l.batchId === w1.data!.id))
check('失败批次保留可重试位置', c1.data!.retryFromSeq >= 1 && !!c1.data!.lostTo)
check('失败批次不出现在分发清单', !buildDistributionCatalog().find((e) => e.dataset === '订单数据集')!.readableBatches.some((b) => b.id === w1.data!.id))

// ---- 场景 5：事务写入出错整体回滚 ----
const w2 = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 10, 9, 0, 0).getTime(),
  fileCount: 4,
  failAtFile: 2,
})
check('故障注入后 startWrite 返回失败', !w2.ok)
const failed = getBatch(w2.data!.id)!
check('事务出错批次状态为已回滚', failed.status === '已回滚')
check('只登记了出错前的临时文件且全部回滚', failed.files.length === 2 && failed.files.every((f) => f.state === '已回滚'))
check('回滚后不持锁', !listLocks().some((l) => l.batchId === failed.id))
check('可重试位置指向下一个序号', failed.retryFromSeq === 3)

// ---- 场景 6：重试从断点继续，最终可提交 ----
const r1 = retryWrite(failed.id, NOW + 2000)
check('重试生成新批次', r1.ok && r1.data!.id !== failed.id)
const rc1 = commitWrite(r1.data!.id, NOW + 3000)
// 2026-11-10 分区此前无提交，冲突拒绝下应成功
check('重试批次可成功提交', rc1.ok, rc1.message)

// ---- 场景 7：整批覆盖——以先完成提交的批次为准，旧文件下线 ----
const w3 = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 12, 8, 0, 0).getTime(),
  fileCount: 2,
  overwriteMode: '整批覆盖',
})
const c3 = commitWrite(w3.data!.id, NOW + 4000)
check('整批覆盖提交成功', c3.ok)
const covered = getBatch('BATCH-00001')!
check('被覆盖的旧批次标记失败', covered.status === '提交失败' && covered.lostTo === w3.data!.id)
check('旧批次正式文件下线（回滚）', covered.files.every((f) => f.state === '已回滚'))
const part20261112 = listBatches().filter((b) => b.partition === 'dt=2026-11-12')
check('同分区任意时刻只有一个批次的正式文件', part20261112.filter((b) => b.files.some((f) => f.state === '正式')).length === 1)

// ---- 场景 8：保留期按批次完成时间归档，原格式原路径保留 ----
const beforePaths = new Map(getBatch('BATCH-00003')!.files.map((f) => [f.seq, { path: f.path, format: f.format }]))
const arch = archiveExpired(NOW)
check('归档扫描命中超期批次', arch.data!.archived.some((b) => b.id === 'BATCH-00003'))
const oldAfter = getBatch('BATCH-00003')!
check('超期批次状态为已归档', oldAfter.status === '已归档' && oldAfter.archivedAt === NOW)
check('归档保留原文件路径', oldAfter.files.every((f) => beforePaths.get(f.seq)!.path === f.path))
check('归档保留原文件格式', oldAfter.files.every((f) => beforePaths.get(f.seq)!.format === f.format))
const fresh = getBatch('BATCH-00002')!
check('未超期批次不归档（2 天 < 30 天）', fresh.status === '已提交')
const catalog3 = buildDistributionCatalog().find((e) => e.dataset === '订单数据集')!
check('已归档批次仍可被分发回读', catalog3.readableBatches.some((b) => b.id === 'BATCH-00003'))

// 页面打开时间不影响判断：换一个更晚的“打开时间”，只要距完成时间未到保留天数就不归档。
// BATCH-00002 完成于 NOW，NOW+10d 时年龄 10 天 < 30 天，仍然保持已提交。
const arch2 = archiveExpired(NOW + 10 * DAY)
check('保留期判断只认批次完成时间，与页面打开时间无关', getBatch('BATCH-00002')!.status === '已提交')

// ---- 场景 9：分区策略变更，历史文件路径不变、可回读 ----
const storageRows = listRows('storage')
const stor61 = storageRows.find((r) => String(r['配置编号']) === 'STOR-0061')!
const historicalPath = getBatch('BATCH-00003')!.files[0].path
const updated = storageRows.map((r) => (r === stor61 ? { ...r, 分区策略: '按月分区' } : r))
saveRows('storage', updated)
const w4 = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 14, 9, 0, 0).getTime(),
  fileCount: 1,
})
check('策略变更后新批次按月分区', w4.ok && w4.data!.partition === 'dt=2026-11')
check('历史文件路径保持可回读', getBatch('BATCH-00003')!.files[0].path === historicalPath)
saveRows('storage', storageRows) // 还原

// ---- 场景 10：分区索引与批次清单导入/上传核对 ----
const index = buildPartitionIndex('dt=2026-11-13')!
check('分区索引只收录正式文件', index.fileCount === 2 && index.entries.every((e) => !e.path.includes('.part')))
const up = uploadPartitionIndex(index.fileName, JSON.stringify({ partition: index.partition, entries: index.entries }))
check('完整索引上传核对全部命中', up.ok && up.data!.missing.length === 0)
const upMissing = uploadPartitionIndex(
  'bad.json',
  JSON.stringify({ partition: 'dt=2026-11-13', entries: [{ path: 'oss://ghost/missing.jsonl', checksum: 'x', size: 1 }] }),
)
check('索引缺文件时给出缺失清单', upMissing.ok && upMissing.data!.missing.length === 1)
const manifestJson = exportBatchManifest().content
const imp = importBatchManifest('落盘批次清单.json', manifestJson)
check('批次清单可导入登记', imp.ok && imp.data!.manifest.batchCount === listBatches().length)
const badImport = importBatchManifest('x.json', '{not json')
check('非法清单被拒绝', !badImport.ok)

// ---- 场景 11：手动回滚 ----
const w5 = startWrite({
  configId: 'STOR-0061',
  dataset: '订单数据集',
  bizTime: new Date(2026, 10, 20, 9, 0, 0).getTime(),
  fileCount: 2,
})
const rb = rollbackWrite(w5.data!.id)
check('手动回滚成功且释放锁', rb.ok && !listLocks().some((l) => l.batchId === w5.data!.id))
check('回滚后无正式文件残留', getBatch(w5.data!.id)!.files.every((f) => f.state === '已回滚'))
check('重复回滚被拒绝', !rollbackWrite(w5.data!.id).ok)

// ---- 场景 12：未启用通道不允许分发 ----
const disabledRead = readDataset('EXPO-0003')
check('未启用通道读取被拒', !disabledRead.ok && disabledRead.message.includes('未启用'))

resetLandingState()
console.log(`\n全部通过：${passed} 项断言`)
