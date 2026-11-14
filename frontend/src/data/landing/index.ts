export * from './types'
export * from './path'
export * from './store'
export * from './engine'
export * from './distribution'
export { buildLandingSeed } from './seed'

/** 触发浏览器下载一段文本内容 */
export function downloadTextFile(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
