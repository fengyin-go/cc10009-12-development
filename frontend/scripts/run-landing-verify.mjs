/**
 * 落盘引擎规则核验入口：用项目自带 esbuild 打包 TS 核验脚本后立即执行。
 * 运行：npm run verify-landing
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outfile = resolve(root, 'node_modules/.verify-landing.mjs')

await build({
  entryPoints: [resolve(here, 'verify-landing.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': resolve(root, 'src') },
  logLevel: 'info',
})

await import(pathToFileURL(outfile).href)
