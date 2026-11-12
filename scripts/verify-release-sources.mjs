// Check the exact public manifests consumed by already-installed clients.
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

const expected = JSON.parse(await readFile(new URL('../website/releases.json', import.meta.url), 'utf8'))
const sources = [
  ['官网', 'https://bilimusic.cn/api/v1/releases'],
  ['Gitee', 'https://gitee.com/yoaker/BiliMusic-Desktop/raw/main/website/releases.json'],
  ['GitHub', 'https://raw.githubusercontent.com/licpp/BiliMusic-Desktop/main/website/releases.json'],
]
const results = await Promise.allSettled(sources.map(async ([name, url]) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const actual = await response.json()
  if (actual.version !== expected.version) throw new Error(`${name}: 返回 ${actual.version}，应为 ${expected.version}`)
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${name}: 安装包地址、校验值或版本历史与发布清单不一致`)
  console.log(`${name}: ${actual.version}，发布清单一致`)
}))
for (const result of results) {
  if (result.status === 'rejected') {
    console.error(result.reason.message)
    process.exitCode = 1
  }
}
