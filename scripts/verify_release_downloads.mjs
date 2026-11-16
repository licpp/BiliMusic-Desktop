// Public verification runs on the publishing workstation, independently of
// server-to-GitHub connectivity. No API credentials are accepted or needed.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { verifyPublicAsset, probePublicAsset, uploadProofMatches } from './download_release_asset.mjs'

const [planPath, reportPath, planDigest] = process.argv.slice(2)
if (!planPath || !reportPath || !/^[a-f0-9]{64}$/.test(planDigest || '')) throw new Error('Usage: node verify_release_downloads.mjs plan.json report.json plan-sha256')
const plan = JSON.parse(await readFile(planPath, 'utf8'))
const work = plan.manifest.platforms.flatMap(platform => platform.channels.map(channel => ({ platform, channel })))
const ids = plan.manifest.platforms.map(p => p.id)
if (![8,10,12].includes(work.length) || new Set(ids).size !== ids.length || !['mac','windows','android','ios'].every(id => ids.includes(id)) || ids.some(id => !['mac','windows','android','ios','ohos','android-large'].includes(id)) || plan.manifest.platforms.some(p => p.channels.length !== 2 || new Set(p.channels.map(c => c.id)).size !== 2 || p.channels.some(c => !['github','gitee'].includes(c.id))) || new Set(work.map(x => x.channel.url)).size !== work.length) throw new Error('Expected both public downloads for four release platforms and optional Harmony / Android large-screen packages')
const proofIndex = process.argv.indexOf('--upload-proof')
const uploadReport = proofIndex >= 0 ? JSON.parse(await readFile(process.argv[proofIndex + 1], 'utf8')) : undefined
if (uploadReport && uploadReport.planDigest !== planDigest) throw Error('Upload proofs belong to another release plan')
const fullAudit = process.argv.includes('--full-download')
const sourceProof = (platform, channel) => uploadReport?.verifiedAssets?.[channel.id + ':' + platform.file]
const results = []
try {
  const partial = JSON.parse(await readFile(reportPath + '.partial', 'utf8'))
  if (partial.planDigest === planDigest) for (const item of partial.results || []) {
    const target = work.find(x => x.channel.url === item.url)
    if (!target || results.some(r => r.url === item.url) || item.size !== target.platform.size || item.sha256 !== target.platform.sha256) continue
    const full = (item.verification || 'full-download') === 'full-download'
    if (full || !fullAudit && item.verification === 'uploaded-hash-and-public-headers' && uploadProofMatches(item.uploadProof, target.platform, target.channel) && JSON.stringify(item.uploadProof) === JSON.stringify(sourceProof(target.platform, target.channel))) results.push(item)
  }
} catch { /* Missing or interrupted checkpoint; completed final proof stays atomic. */ }
let checkpoint = Promise.resolve()
function saveCheckpoint() {
  const value = JSON.stringify({planDigest, results:[...results]})
  checkpoint = checkpoint.then(() => writeFile(reportPath + '.partial.tmp', value)).then(() => rename(reportPath + '.partial.tmp', reportPath + '.partial'))
  return checkpoint
}
async function worker() {
  while (work.length) {
    const { platform, channel } = work.shift()
    if (results.some(r => r.url === channel.url)) continue
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const proof = sourceProof(platform, channel)
        results.push(!fullAudit && uploadProofMatches(proof, platform, channel) ? await probePublicAsset(platform, channel, proof) : await verifyPublicAsset(platform, channel))
        await saveCheckpoint()
        console.log(JSON.stringify({ downloadVerified: platform.file, channel: channel.id }))
        break
      } catch (error) {
        if (attempt === 2) throw new Error(`Public download verification failed: ${platform.id}/${channel.id}: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
}
const workers = await Promise.allSettled(Array.from({length: uploadReport && !fullAudit ? 4 : 2}, worker))
await checkpoint
const failed = workers.find(result => result.status === 'rejected')
if (failed) throw failed.reason
await writeFile(reportPath + '.tmp', JSON.stringify({ planDigest, results, verifiedAt: new Date().toISOString() }, null, 2) + '\n')
await rename(reportPath + '.tmp', reportPath)
