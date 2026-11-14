import { buildLandingSeed } from './seed'
import type { LandingState } from './types'

// 落盘结果独立于通用配置表存储：通用模块走 entries，落盘批次 / 分区锁 / 索引走这里。
const LANDING_KEY = 'scraper-config-studio:landing'

export function emptyLandingState(): LandingState {
  return {
    batches: [],
    locks: [],
    commitSeqCounter: 0,
    batchCounter: 0,
    importedManifests: [],
    uploadedIndexes: [],
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: LandingState | null = null

export function readLandingState(): LandingState {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = emptyLandingState()
    return cache
  }
  const raw = window.localStorage.getItem(LANDING_KEY)
  if (!raw) {
    // 首次进入落盘模块时播种现场数据（含 STOR-61 半分区场景），之后以浏览器里的改动为准。
    cache = buildLandingSeed()
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(cache))
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LandingState>
    cache = { ...emptyLandingState(), ...parsed }
  } catch {
    cache = emptyLandingState()
  }
  return cache
}

export function writeLandingState(state: LandingState): void {
  cache = clone(state)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LANDING_KEY, JSON.stringify(cache))
  }
}

/** 直接替换内存态（引擎内部在一份草稿上完成事务后统一落盘） */
export function commitLandingState(state: LandingState): void {
  writeLandingState(state)
}

export function resetLandingState(): LandingState {
  const fresh = emptyLandingState()
  writeLandingState(fresh)
  return fresh
}

export function landingStorageKey(): string {
  return LANDING_KEY
}
