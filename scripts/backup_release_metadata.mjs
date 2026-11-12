import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const [reportPath, bundle, previousBundle] = process.argv.slice(2)
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const jobs = [...report.originalMetadata], results = []
const hash = data => createHash('sha256').update(data).digest('hex')
const matches = (data, job) => data.length === job.size && (!job.sha256 || hash(data) === job.sha256)
async function worker() {
  while (jobs.length) {
    const job = jobs.shift()
    if (!['github', 'gitee'].includes(job.channel) || !/^[A-Za-z0-9_.-]+$/.test(job.name)) throw new Error('Unsafe metadata backup path')
    const destination = join(bundle, 'original-assets', job.channel, job.name)
    let data
    for (const path of [destination, previousBundle && join(previousBundle, job.name)].filter(Boolean)) {
      try { const candidate = await readFile(path); if (matches(candidate, job)) { data = candidate; break } } catch {}
    }
    if (!data) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(job.url, { signal: AbortSignal.timeout(180_000) })
          if (!response.ok || !response.url.startsWith('https://')) throw new Error('Backup unavailable')
          const chunks = []; let size = 0
          for await (const chunk of response.body) { size += chunk.length; if (size > job.size) throw new Error('Backup size mismatch'); chunks.push(chunk) }
          data = Buffer.concat(chunks)
          if (!matches(data, job)) throw new Error('Backup SHA-256 mismatch')
          break
        } catch (error) { if (attempt === 2) throw new Error(`Cannot back up ${job.channel}/${job.name}`); await new Promise(r => setTimeout(r, 2000)) }
      }
    }
    await mkdir(join(bundle, 'original-assets', job.channel), { recursive: true })
    await writeFile(destination + '.tmp', data); await rename(destination + '.tmp', destination)
    results.push({ ...job, sha256: hash(data) })
  }
}
await Promise.all([worker(), worker()])
await writeFile(join(bundle, 'metadata-backup-proof.json'), JSON.stringify({ planDigest: report.planDigest, results }, null, 2) + '\n')
console.log(JSON.stringify({ stage: 'metadataBackups', status: 'verified', files: results.length }))
