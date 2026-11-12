// Public verification runs on the publishing workstation, independently of
// server-to-GitHub connectivity. No API credentials are accepted or needed.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const [planPath, reportPath, planDigest] = process.argv.slice(2)
if (!planPath || !reportPath || !/^[a-f0-9]{64}$/.test(planDigest || '')) throw new Error('Usage: node verify_release_downloads.mjs plan.json report.json plan-sha256')
const plan = JSON.parse(await readFile(planPath, 'utf8'))
const work = plan.manifest.platforms.flatMap(platform => platform.channels.map(channel => ({ platform, channel })))
const ids = plan.manifest.platforms.map(p => p.id)
if (![8,10].includes(work.length) || new Set(ids).size !== ids.length || !['mac','windows','android','ios'].every(id => ids.includes(id)) || ids.some(id => !['mac','windows','android','ios','ohos'].includes(id)) || plan.manifest.platforms.some(p => p.channels.length !== 2 || new Set(p.channels.map(c => c.id)).size !== 2 || p.channels.some(c => !['github','gitee'].includes(c.id))) || new Set(work.map(x => x.channel.url)).size !== work.length) throw new Error('Expected both public downloads for four release platforms and optional Harmony test package')
const results = []
async function worker() {
  while (work.length) {
    const { platform, channel } = work.shift()
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(channel.url, { signal: AbortSignal.timeout(180_000), headers: { 'user-agent': 'BiliMusic-release-verification' } })
        if (!response.ok || !response.url.startsWith('https://')) throw new Error('Download unavailable')
        const hash = createHash('sha256'); let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > platform.size) throw new Error('Download size exceeded manifest')
          hash.update(chunk)
        }
        const sha256 = hash.digest('hex')
        if (size !== platform.size || sha256 !== platform.sha256) throw new Error('Downloaded size or SHA-256 mismatch')
        results.push({ url: channel.url, size, sha256, platform: platform.id, channel: channel.id })
        console.log(JSON.stringify({ downloadVerified: platform.file, channel: channel.id }))
        break
      } catch (error) {
        if (attempt === 2) throw new Error(`Public download verification failed: ${platform.id}/${channel.id}: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
}
await Promise.all([worker(), worker()])
await writeFile(reportPath + '.tmp', JSON.stringify({ planDigest, results, verifiedAt: new Date().toISOString() }, null, 2) + '\n')
await rename(reportPath + '.tmp', reportPath)
